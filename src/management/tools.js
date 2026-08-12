/**
 * Tools — custom LLM-callable tools. A Tool is a PARTNER-LEVEL entity with its
 * OWN CRUD (`/v1/tool/add|get|list|update|delete`, Genie host, admin token) —
 * it is NOT embedded in an intellect. `Tool = {id, name, config, partner_id,
 * created_at, updated_at}`; `config` is the discriminated `api`/`csv`/`code`
 * shape built below. An intellect references the tools it may call by id via
 * `tool_ids: string[]` (uncapped) on `CreateIntellect`/`UpdateIntellect` — link
 * with {@link import('./intellect-config.js').IntellectConfig#setToolIds} or by
 * passing `tool_ids` straight to `intellects.create`/`update`. Mounted at
 * `mgmt.tools`.
 *
 * This file is two things: (1) a PURE builder/validator namespace (`tools.api`/
 * `csv`/`code`/`validate`/`validateArgs` + `applyResponseMapping`) that runs
 * anywhere with no transport, and (2) a `Tools` resource class bound to the
 * management Ctx for the `/v1/tool/*` CRUD wire path.
 *
 * Wire shape of a tool's `config` (snake_case on the wire; camelCase at the SDK
 * door) — this is the flat builder output below, wrapped as `Tool.config`:
 *   {type, description, name?, display_name?, add_to_history?, args?,
 *    request:{url, method, headers?, params?, body?, authentication?, timeout?},
 *    response_mapping? | response_template? | response_chapters?,
 *    variables_mapping?, csv?, code?}
 * The builder's own `name` becomes the standalone Tool entity's partner-unique
 * `name` (the lookup key for `add`/`update`) — the same value the model calls
 * mid-conversation.
 */
import { uuidv4, meta } from '../core/ids.js';
import { requireConfirm } from './agents.js';
import { paginate } from './paginate.js';
import { KalturaError } from '../core/errors.js';
import { ARG_TYPE_NAMES } from '../core/stream.js';

/**
 * @typedef {object} GenieToolArg
 * @property {string} prompt         LLM-facing description of the argument.
 * @property {'str'|'int'|'float'|'bool'|'list'|'dict'} type
 * @property {boolean} [required]
 * @property {unknown} [default]
 */

/**
 * @typedef {object} GenieToolConfig A validated, wire-ready tool (snake_case).
 * @property {string} name
 * @property {'api'|'csv'|'code'|'client'} type
 * @property {string} description
 * @property {string} [display_name]
 * @property {boolean} [add_to_history]
 * @property {Record<string,GenieToolArg>} [args]
 * @property {object} [request]
 * @property {object} [response_mapping]
 * @property {string} [response_template]
 * @property {object} [response_chapters]
 * @property {object} [variables_mapping]
 * @property {string} [csv]
 * @property {string} [code]
 * @property {boolean} [wait_for_response]
 * @property {number} [timeout]
 */

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Tool `type` discriminator — the closed set the backend understands. `api`
 * calls an HTTP endpoint, `csv` looks up rows in an inline table, `code` runs
 * sandboxed Python, `client` makes NO server-side call at all — see
 * {@link client}. @type {ReadonlyArray<'api'|'csv'|'code'|'client'>}
 */
export const TOOL_TYPES = Object.freeze(['api', 'csv', 'code', 'client']);

/**
 * HTTP methods an `api` tool may use (closed set; defaults to GET).
 * @type {ReadonlyArray<'GET'|'POST'|'PUT'|'PATCH'|'DELETE'>}
 */
export const HTTP_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The stored data types a tool ARGUMENT may declare (closed set). The model
 * fills each arg per its `type`; the backend rejects anything else. Re-exports
 * `core/stream.js`'s {@link ARG_TYPE_NAMES} — core/ is the single source of
 * truth for this vocabulary (core/ must never import from management/, so the
 * canonical list lives there and this module derives from it, not vice versa).
 * @type {ReadonlyArray<'str'|'int'|'float'|'bool'|'list'|'dict'>}
 */
export const ARG_TYPES = ARG_TYPE_NAMES;

/** Throw a typed validation error before any network call. @param {string} code @param {string} detail */
function bad(code, detail) {
  throw new KalturaError({ type: 'about:blank', title: code.replace(/_/g, ' '), code, detail });
}

/**
 * Validate `args` (the LLM-facing JSON-schema source). Each entry is
 * `{prompt, type, required?, default?}` with `type ∈ {str,int,float,bool,list,dict}`.
 * Returns a shallow-rebuilt dict (a plain, MUTABLE object — not frozen) with
 * each entry's keys narrowed to exactly `{prompt, type, required?, default?}`.
 * PURE — throws before returning on any bad input, never mutates the input `args`.
 * @param {Record<string,GenieToolArg>|undefined} args
 * @returns {Record<string,GenieToolArg>|undefined}
 */
export function validateArgs(args) {
  if (args === undefined || args === null) return undefined;
  if (typeof args !== 'object' || Array.isArray(args)) {
    bad('bad_request', 'tool `args` must be an object mapping argName → {prompt, type, required?, default?}.');
  }
  /** @type {Record<string,GenieToolArg>} */
  const out = {};
  for (const [key, spec] of Object.entries(args)) {
    if (!NAME_RE.test(key)) bad('bad_request', `tool arg name "${key}" must match ${NAME_RE} (a valid identifier).`);
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) bad('bad_request', `tool arg "${key}" must be an object {prompt, type, required?, default?}.`);
    if (typeof spec.prompt !== 'string' || !spec.prompt.trim()) bad('bad_request', `tool arg "${key}" needs a non-empty string \`prompt\` (the LLM-facing description).`);
    if (!ARG_TYPES.includes(spec.type)) bad('bad_request', `tool arg "${key}" has type "${String(spec.type)}"; must be one of ${ARG_TYPES.join(', ')}.`);
    if (spec.required !== undefined && typeof spec.required !== 'boolean') bad('bad_request', `tool arg "${key}".required must be a boolean.`);
    /** @type {GenieToolArg} */
    const clean = { prompt: spec.prompt, type: spec.type };
    if (spec.required !== undefined) clean.required = spec.required;
    if (spec.default !== undefined) clean.default = spec.default;
    out[key] = clean;
  }
  return out;
}

/**
 * Structural dot-path sanity check (no eval, never executes). Matches the live
 * backend's `get_from_path` exactly: a bare, dot-separated sequence of field
 * names and/or list indices (e.g. `json.items.0.id`) — NO leading `$` (the
 * backend has no root token) and NO bracket/wildcard syntax (the backend has
 * no indexer for either). Rejects whitespace, parens (function calls), `$`,
 * and empty segments (leading/trailing/doubled dots). PURE.
 * @param {string} path @param {string} where
 */
function assertJsonPath(path, where) {
  if (typeof path !== 'string' || !path.length) bad('bad_jsonpath', `${where} must be a non-empty dot-path string.`);
  if (/[()\s;$]/.test(path)) bad('bad_jsonpath', `${where} contains illegal characters (no whitespace/parens/scripts/"$" allowed): ${JSON.stringify(path)}.`);
  for (const seg of path.split('.')) {
    if (!/^[A-Za-z0-9_]+$/.test(seg)) {
      bad('bad_jsonpath', `${where} has an invalid segment ${JSON.stringify(seg)} in ${JSON.stringify(path)} — use dot-separated field names or list indices, e.g. "json.__client_command" or "items.0.id".`);
    }
  }
}

/** Walk every string leaf of a mapping object and dot-path-check it. @param {object} mapping @param {string} where */
function assertMappingPaths(mapping, where) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) bad('bad_request', `${where} must be an object mapping outputKey → dot-path.`);
  if (!Object.keys(mapping).length) bad('bad_request', `${where} must have at least one outputKey → dot-path entry.`);
  for (const [k, v] of Object.entries(mapping)) {
    if (typeof v !== 'string') bad('bad_jsonpath', `${where}["${k}"] must be a dot-path string, got ${typeof v}.`);
    assertJsonPath(v, `${where}["${k}"]`);
  }
}

/**
 * Validate the shared `{url, method?, headers?, params?, body?, authentication?,
 * timeout?}` request block of an `api` tool. `authentication`, when present,
 * must be `{type:'oauth2', ...}` with a `client_secret` that is a
 * `'secrets.<name>'` REFERENCE — a plaintext client secret is rejected by
 * construction (so the plaintext-leak class is impossible; the real value lives
 * in `config.secrets`, encrypted at rest).
 * Returns the wire-ready request object. PURE.
 * @param {object} request
 * @returns {object}
 */
function buildRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) bad('bad_request', 'api tool needs a `request` object {url, method?, headers?, params?, body?, authentication?, timeout?}.');
  if (typeof request.url !== 'string' || !request.url) bad('bad_request', 'api tool `request.url` is required.');
  assertHttpUrl(request.url, 'request.url');

  const method = request.method === undefined ? 'GET' : String(request.method).toUpperCase();
  if (!HTTP_METHODS.includes(method)) bad('bad_request', `api tool \`request.method\` must be one of ${HTTP_METHODS.join(', ')}, got ${JSON.stringify(request.method)}.`);

  let timeout = 10;
  if (request.timeout !== undefined) {
    if (typeof request.timeout !== 'number' || !Number.isInteger(request.timeout) || request.timeout < 1 || request.timeout > 120) {
      bad('bad_request', `api tool \`request.timeout\` must be an integer 1..120 (seconds), got ${JSON.stringify(request.timeout)}.`);
    }
    timeout = request.timeout;
  }

  /** @type {Record<string,unknown>} */
  const out = { url: request.url, method, timeout };
  if (request.headers !== undefined) {
    if (typeof request.headers !== 'object' || Array.isArray(request.headers)) bad('bad_request', 'api tool `request.headers` must be an object.');
    out.headers = request.headers;
  }
  if (request.params !== undefined) {
    if (typeof request.params !== 'object' || Array.isArray(request.params)) bad('bad_request', 'api tool `request.params` must be an object.');
    out.params = request.params;
  }
  if (request.body !== undefined) out.body = request.body; // JSON object or raw string both legal
  if (request.authentication !== undefined) out.authentication = buildAuth(request.authentication);
  return out;
}

/** @param {string} url @param {string} where */
function assertHttpUrl(url, where) {
  let parsed;
  try { parsed = new URL(url); } catch { bad('invalid_url', `${where} is not a valid URL: ${JSON.stringify(url)}.`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') bad('invalid_url', `${where} must use http(s), got ${parsed.protocol} in ${JSON.stringify(url)}.`);
}

/**
 * Validate an inline OAuth2 auth block. `client_secret` MUST be a
 * `secrets.<name>` reference — a plaintext secret is refused so no plaintext
 * path exists. `token_url`/`auth_url` (when present) are http(s)-validated.
 * @param {object} auth
 */
function buildAuth(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) bad('bad_request', 'api tool `request.authentication` must be an object.');
  if (auth.type !== undefined && auth.type !== 'oauth2') bad('bad_request', `api tool authentication.type must be "oauth2" (the only supported scheme), got ${JSON.stringify(auth.type)}.`);
  const { client_id, client_secret, token_url, auth_url, scopes, flow } = auth;
  if (client_secret === undefined) bad('bad_request', 'oauth2 authentication needs a `client_secret` that is a "secrets.<name>" reference.');
  if (typeof client_secret !== 'string' || !/^secrets\.[A-Za-z_][A-Za-z0-9_]*$/.test(client_secret)) {
    bad('bad_request', 'oauth2 `client_secret` MUST be a "secrets.<name>" reference (set the real value via intellects secrets first; plaintext is rejected by construction so it cannot leak).');
  }
  if (token_url !== undefined) assertHttpUrl(String(token_url), 'authentication.token_url');
  if (auth_url !== undefined) assertHttpUrl(String(auth_url), 'authentication.auth_url');
  const out = { type: 'oauth2', client_id, client_secret, token_url, auth_url, scopes, flow };
  return out;
}

/** Shared base validation (name/description/args/display/history). Mutates into `target`. @param {object} cfg @param {GenieToolConfig} target */
function buildShared(cfg, target) {
  if (!cfg || typeof cfg !== 'object') bad('bad_request', 'tool config must be an object.');
  if (typeof cfg.name !== 'string' || !NAME_RE.test(cfg.name)) bad('bad_request', `tool \`name\` must match ${NAME_RE} (a valid identifier), got ${JSON.stringify(cfg.name)}.`);
  if (typeof cfg.description !== 'string' || !cfg.description.trim()) bad('bad_request', 'tool `description` is required (the LLM-facing description the model uses to decide when to call it).');
  target.name = cfg.name;
  target.description = cfg.description;
  const args = validateArgs(cfg.args);
  if (args) target.args = args;
  if (cfg.displayName !== undefined) {
    if (typeof cfg.displayName !== 'string') bad('bad_request', 'tool `displayName` must be a string.');
    target.display_name = cfg.displayName;
  }
  if (cfg.addToHistory !== undefined) {
    if (typeof cfg.addToHistory !== 'boolean') bad('bad_request', 'tool `addToHistory` must be a boolean.');
    target.add_to_history = cfg.addToHistory;
  }
}

/**
 * Build a validated `api` tool. Exactly ONE of `responseMapping`,
 * `responseTemplate`, `responseChapters` must be supplied (the three are
 * mutually exclusive response shapers).
 * `variablesMapping` (optional) extracts response fields into conversation
 * variables and is dot-path-checked. PURE — returns a wire-ready
 * {@link GenieToolConfig}; throws {@link KalturaError} on bad input.
 * @param {object} cfg {name, description, request, args?, responseMapping?, responseTemplate?, responseChapters?, variablesMapping?, displayName?, addToHistory?}
 * @returns {GenieToolConfig}
 */
export function api(cfg) {
  /** @type {GenieToolConfig} */
  const tool = { name: '', type: 'api', description: '' };
  buildShared(cfg, tool);
  tool.request = buildRequest(cfg.request);

  const modes = ['responseMapping', 'responseTemplate', 'responseChapters'].filter((k) => cfg[k] !== undefined);
  if (modes.length === 0) bad('bad_request', 'api tool needs exactly one response shaper: responseMapping, responseTemplate, or responseChapters.');
  if (modes.length > 1) bad('bad_request', `api tool must have EXACTLY ONE of responseMapping/responseTemplate/responseChapters, got ${modes.join(' + ')}.`);

  if (cfg.responseMapping !== undefined) {
    assertMappingPaths(cfg.responseMapping, 'responseMapping');
    tool.response_mapping = cfg.responseMapping;
  } else if (cfg.responseTemplate !== undefined) {
    if (typeof cfg.responseTemplate !== 'string' || !cfg.responseTemplate.length) bad('bad_request', 'responseTemplate must be a non-empty format string.');
    tool.response_template = cfg.responseTemplate;
  } else {
    const ch = cfg.responseChapters;
    if (!ch || typeof ch !== 'object' || Array.isArray(ch)) bad('bad_request', 'responseChapters must be an object {iterate_on, content, link?}.');
    if (typeof ch.iterate_on !== 'string' || !ch.iterate_on) bad('bad_request', 'responseChapters.iterate_on (dot-path to the list to iterate) is required.');
    assertJsonPath(ch.iterate_on, 'responseChapters.iterate_on');
    if (typeof ch.content !== 'string' || !ch.content) bad('bad_request', 'responseChapters.content (template per item) is required.');
    /** @type {Record<string,unknown>} */
    const out = { iterate_on: ch.iterate_on, content: ch.content };
    if (ch.link !== undefined) { if (typeof ch.link !== 'string') bad('bad_request', 'responseChapters.link must be a string template.'); out.link = ch.link; }
    tool.response_chapters = out;
  }

  if (cfg.variablesMapping !== undefined) {
    assertMappingPaths(cfg.variablesMapping, 'variablesMapping');
    tool.variables_mapping = cfg.variablesMapping;
  }
  return tool;
}

/**
 * Build a validated `csv` tool — an inline CSV lookup table. `args` are
 * OPTIONAL (the server's `csv_preload` derives them from the columns). The CSV
 * must be a non-empty string with a parseable
 * header row (≥1 column). PURE.
 * @param {object} cfg {name, description, csv, args?, displayName?, addToHistory?}
 * @returns {GenieToolConfig}
 */
export function csv(cfg) {
  /** @type {GenieToolConfig} */
  const tool = { name: '', type: 'csv', description: '' };
  buildShared(cfg, tool);
  if (typeof cfg.csv !== 'string' || !cfg.csv.trim()) bad('bad_request', 'csv tool needs a non-empty `csv` string.');
  const firstLine = cfg.csv.split(/\r?\n/, 1)[0] || '';
  const header = firstLine.split(',').map((h) => h.trim()).filter(Boolean);
  if (!header.length) bad('bad_request', 'csv tool `csv` must have a parseable header row (≥1 comma-separated column).');
  tool.csv = cfg.csv;
  return tool;
}

/**
 * Build a validated `code` tool — Python run in a server sandbox that computes
 * a result string the LLM consumes. `code` must be a non-empty string. PURE.
 * @param {object} cfg {name, description, code, args?, displayName?, addToHistory?}
 * @returns {GenieToolConfig}
 */
export function code(cfg) {
  /** @type {GenieToolConfig} */
  const tool = { name: '', type: 'code', description: '' };
  buildShared(cfg, tool);
  if (typeof cfg.code !== 'string' || !cfg.code.trim()) bad('bad_request', 'code tool needs a non-empty `code` string (Python run in the sandbox).');
  tool.code = cfg.code;
  return tool;
}

/**
 * Lint an intellect body for the client-tool DEPLOYMENT GOTCHA that applies to
 * ANY tool-referencing intellect regardless of tool type — returns
 * `{ok, warnings[]}`. PURE, never throws. Called by `intellects.create`/`update`
 * (logs each warning) and exposed so authoring UIs / AI agents can surface the
 * same guidance BEFORE shipping a tool-driven intellect.
 *
 * Warns when the body references tools (`tool_ids`) but:
 *  - `kaltura_genie_experiences` is not explicitly `'off'` (it out-competes
 *    custom tool calls), or
 *  - no `capabilities` are set at all on this CREATE (flipping them later is
 *    defeated by the ~24h partner-config cache; set them at creation).
 * @param {object} [body] An intellect create/update body.
 * @returns {{ok:boolean, warnings:string[]}}
 */
export function clientToolReadiness(body) {
  const warnings = [];
  const hasTools = body && Array.isArray(body.tool_ids) && body.tool_ids.length > 0;
  if (hasTools) {
    const caps = (body && body.capabilities && typeof body.capabilities === 'object') ? body.capabilities : null;
    if (!caps) {
      warnings.push('This intellect references tools (tool_ids) but sets no capabilities. The kaltura_genie_experiences capability (default-on) injects a "you MUST call get_experience_instructions" rule that OUT-COMPETES custom tool calls. Set capabilities:{kaltura_genie_experiences:"off"} at CREATION (the ~24h partner-config cache defeats flipping it later).');
    } else if (caps.kaltura_genie_experiences !== 'off') {
      warnings.push('This intellect references tools (tool_ids) but kaltura_genie_experiences is not "off" — it out-competes custom tool calls, so the model may call get_experience_instructions instead of your command. Set kaltura_genie_experiences:"off" unless you also want GenUI experiences.');
    }
  }
  return { ok: warnings.length === 0, warnings };
}

/**
 * Build a validated native `type:"client"` tool — a native function-calling
 * tool whose POINT is the silent `type:"tool"` segment it emits, NOT a
 * server-side result. When the LLM calls it, the host app captures the call
 * (`session.onToolCall(name)` live, or `collectConverse(...).toolCalls` /
 * {@link import('../core/stream.js').parseToolCall} headless) and runs
 * whatever JS it wants — navigate a deck (`navigate_to_slide`), show a widget,
 * call a page function. It makes NO server-side call at all: no `request`
 * block, no echo endpoint, no response shaper — the model calls it, the
 * backend emits the `type:"tool"` segment (with `tool_metadata.id`, see
 * {@link import('../core/stream.js').parseToolCall}), and that's the entire
 * server-side contract.
 *
 * WHY THIS WORKS (and the GenUI experience path does NOT): a native tool is
 * bound to the LLM, so calling it is normal agent behavior — it does NOT trip
 * the "I can't run code / I'm a knowledge assistant" refusal a custom GenUI
 * block does. The `type:"tool"` segment is also NOT in the TTS gate, so the
 * voice track stays clean. Verified live (navigate_to_slide / call_page_function).
 *
 * TWO DEPLOYMENT GOTCHAS (enforced nowhere server-side — author-time
 * discipline; see {@link clientToolReadiness}):
 *  1. The `kaltura_genie_experiences` capability injects a forceful "you MUST
 *     call get_experience_instructions" rule that OUT-COMPETES custom tools.
 *     Turn it OFF on a tool-driven intellect
 *     (`capabilities:{kaltura_genie_experiences:'off'}`).
 *  2. Partner config is cached ~24h server-side, so a capability flipped on an
 *     EXISTING intellect won't take effect until it expires. Set capabilities
 *     at CREATION (`intellects.create({capabilities:{...}})`) — a fresh
 *     intellect has no cache entry and loads clean immediately.
 *
 * `waitForResponse` controls whether the model's turn BLOCKS on a real
 * client-supplied result. **Omitting it is NOT the same as passing `false`** —
 * this builder sends no field at all when omitted, and the backend's own
 * wire default for an absent `wait_for_response` is `true` (source-verified:
 * `dto.py:550`), so an omitted `waitForResponse` blocks. Pass it explicitly:
 *  - `false` — the backend doesn't wait; the turn continues immediately
 *    (confirmed live: ~2.9s full turn).
 *  - `true` — the backend polls for up to `timeout` seconds for an ACK via
 *    `POST /assistant/tool_response` (see {@link import('../experience/session.js').KalturaAvatarSession#respondToTool}
 *    for the live-socket path) before the model gets a result. Confirmed live:
 *    both the 30s default and an explicit 15s `timeout` are honored.
 *
 * PURE — returns a wire-ready {@link GenieToolConfig}; throws {@link KalturaError}
 * on bad input, before any network call.
 * @param {object} cfg
 * @param {string} cfg.name        Tool name the LLM calls + you dispatch on (a valid identifier).
 * @param {string} cfg.description LLM-facing: WHEN to call it.
 * @param {Record<string,GenieToolArg>} [cfg.args] Argument schema ({argName:{prompt,type,required?,default?}}).
 * @param {boolean} [cfg.waitForResponse] Block the turn on a real client ACK. Omitting this
 *   is NOT the same as `false` — the backend's own default for an absent field is `true`
 *   (blocking); pass `false` explicitly for fire-and-forget.
 * @param {number} [cfg.timeout] Seconds to wait for the ACK when `waitForResponse` is `true`;
 *   integer 1..120 (same bound as an `api` tool's `request.timeout`). Default 30 (backend
 *   default when omitted).
 * @param {string} [cfg.displayName] @param {boolean} [cfg.addToHistory]
 * @returns {GenieToolConfig}
 * @example <caption>a client tool the host ACKs with a real result</caption>
 * const pick = tools.client({
 *   name: 'ask_user_to_pick_a_slide',
 *   description: 'Ask the on-screen viewer to pick a slide, and wait for their answer.',
 *   waitForResponse: true,
 *   timeout: 15,
 * });
 * const { id } = await mgmt.tools.add(pick, adminKs);
 * // live-socket host side: session.onToolCall('ask_user_to_pick_a_slide', async (call) => {
 * //   const slide = await askViewer();
 * //   await session.respondToTool(call.toolMetadata.id, { slide });
 * // });
 */
export function client(cfg) {
  /** @type {GenieToolConfig} */
  const tool = { name: '', type: 'client', description: '' };
  buildShared(cfg, tool);
  if (cfg.waitForResponse !== undefined) {
    if (typeof cfg.waitForResponse !== 'boolean') bad('bad_request', 'client tool `waitForResponse` must be a boolean.');
    tool.wait_for_response = cfg.waitForResponse;
  }
  if (cfg.timeout !== undefined) {
    if (typeof cfg.timeout !== 'number' || !Number.isInteger(cfg.timeout) || cfg.timeout < 1 || cfg.timeout > 120) {
      bad('bad_request', `client tool \`timeout\` must be an integer 1..120 (seconds), got ${JSON.stringify(cfg.timeout)}.`);
    }
    tool.timeout = cfg.timeout;
  }
  return tool;
}

/**
 * Validate an already-assembled {@link GenieToolConfig} (the snake_case wire
 * shape) — re-runs the type-appropriate builder so a hand-built or round-tripped
 * tool is checked by the same rules. PURE; returns the re-validated tool.
 * @param {GenieToolConfig} tool
 * @returns {GenieToolConfig}
 */
export function validate(tool) {
  if (!tool || typeof tool !== 'object') bad('bad_request', 'validate() needs a tool object.');
  switch (tool.type) {
    case 'api':
      return api({
        name: tool.name, description: tool.description, request: tool.request, args: tool.args,
        displayName: tool.display_name, addToHistory: tool.add_to_history,
        responseMapping: tool.response_mapping,
        responseTemplate: tool.response_template,
        responseChapters: tool.response_chapters,
        variablesMapping: tool.variables_mapping,
      });
    case 'csv':
      return csv({ name: tool.name, description: tool.description, csv: tool.csv, args: tool.args, displayName: tool.display_name, addToHistory: tool.add_to_history });
    case 'code':
      return code({ name: tool.name, description: tool.description, code: tool.code, args: tool.args, displayName: tool.display_name, addToHistory: tool.add_to_history });
    case 'client':
      return client({ name: tool.name, description: tool.description, args: tool.args, displayName: tool.display_name, addToHistory: tool.add_to_history, waitForResponse: tool.wait_for_response, timeout: tool.timeout });
    default:
      bad('bad_request', `tool \`type\` must be one of ${TOOL_TYPES.join(', ')}, got ${JSON.stringify(tool.type)}.`);
  }
}

/**
 * Apply a `response_mapping` (`{outputKey: dot-path}`) to a parsed JSON
 * response, returning `{outputKey: extractedValue}`. This mirrors the server's
 * `get_from_path`/`apply_mapping` extraction exactly for client-side
 * preview/testing (the server runs the real call): a bare, dot-separated
 * sequence of field names and/or list indices — no `$` root, no brackets, no
 * wildcards (the backend has none). Missing paths yield `undefined`. PURE —
 * never throws on data.
 * @param {unknown} resp        The parsed JSON response body.
 * @param {Record<string,string>} mapping  outputKey → dot-path.
 * @returns {Record<string,unknown>}
 */
export function applyResponseMapping(resp, mapping) {
  if (!mapping || typeof mapping !== 'object') return {};
  /** @type {Record<string,unknown>} */
  const out = {};
  for (const [key, path] of Object.entries(mapping)) {
    out[key] = typeof path === 'string' ? evalPath(resp, path) : undefined;
  }
  return out;
}

/** Evaluate a bare dot-path expression against `root`, mirroring `get_from_path`. @param {unknown} root @param {string} path */
function evalPath(root, path) {
  if (typeof path !== 'string' || !path.length) return undefined;
  let node = root;
  for (const seg of path.split('.')) {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) return undefined;
      node = node[idx];
    } else if (typeof node === 'object') {
      if (!(seg in node)) return undefined;
      node = /** @type {Record<string,unknown>} */ (node)[seg];
    } else {
      return undefined;
    }
  }
  return node;
}

/** The pure builder/validator namespace exported as `tools` (+ the closed enum sets). */
export const tools = { api, csv, code, client, clientToolReadiness, validate, validateArgs, applyResponseMapping, TOOL_TYPES, HTTP_METHODS, ARG_TYPES };

/** @param {unknown} v @param {string} name */
function requireToolId(v, name) {
  if (typeof v !== 'string' || !v) bad('bad_request', `${name} must be a non-empty string (the Tool entity's id).`);
}

/**
 * List every intellect's configId that currently references `toolId` in its
 * `tool_ids` — the safety check {@link Tools#delete} runs before deleting a
 * PARTNER-LEVEL Tool that may be shared across intellects (see the class
 * doc). Implemented via raw `ctx.genie` calls rather than the `Intellects`
 * class to avoid a circular import (`intellects.js` already imports
 * {@link clientToolReadiness} from this file). `v1/intellect/list` returns a
 * lighter DTO that may omit `tool_ids`, so each candidate is confirmed via
 * `v1/intellect/get`.
 * Exported (not just used by {@link Tools#delete}) so callers upserting a Tool
 * by name — e.g. `provision.js`'s `applyTools` — can run the identical check
 * before mutating a name-matched EXISTING Tool's `config` in place, since that
 * entity may already be load-bearing for a different intellect than the one
 * they have in mind (see the SHARED-BY-NAME HAZARD paragraph on the class doc).
 * @param {import('./client.js').Ctx} ctx @param {string} toolId @param {string} ks
 * @returns {Promise<number[]>}
 */
export async function findIntellectsReferencingTool(ctx, toolId, ks) {
  const refs = [];
  const pageSize = 50;
  for (let pageIndex = 1; ; pageIndex += 1) {
    const page = (await ctx.genie('v1/intellect/list', { filter: {}, pager: { pageIndex, pageSize } }, ks)).data;
    const objects = Array.isArray(page?.objects) ? page.objects : [];
    for (const item of objects) {
      if (item?.id === undefined) continue;
      const full = await ctx.genie('v1/intellect/get', { id: item.id }, ks).then((r) => r.data).catch(() => null);
      if (Array.isArray(full?.tool_ids) && full.tool_ids.includes(toolId)) refs.push(item.id);
    }
    const total = page?.totalCount;
    if (objects.length === 0 || (typeof total === 'number' && pageIndex * pageSize >= total)) break;
  }
  return refs;
}

/**
 * Tools resource — CRUD over the standalone, PARTNER-LEVEL Tool entity via
 * Genie `/v1/tool/*` (NOT intellect-scoped, NOT `intellect/update`). Mounted
 * at `mgmt.tools`. A Tool is `{id, name, config, partner_id, created_at,
 * updated_at}`; `config` is the flat output of `tools.api`/`csv`/`code`/
 * `client`. `name` is unique per partner — `add` may be rejected
 * server-side on a duplicate; `update` is the idempotent re-edit path.
 *
 * Creating a Tool does NOT attach it to anything — link it to an intellect via
 * `tool_ids` (see `intellectConfig.setToolIds`, or pass `tool_ids` directly to
 * `intellects.create`/`update`).
 *
 * `name` is unique per partner OR against a shared GLOBAL pool: lookups match
 * `partner_id IN (yours, 0)`, so a name you pick can collide with a partner-0
 * global Tool in ways that aren't visible from a partner-scoped `list()`
 * alone — the same nuance applies to {@link Skills}.
 *
 * SHARED-BY-NAME HAZARD: because `name` is the lookup key callers upsert
 * against (see `sdk/src/management/provision.js`'s `applyTools`, or an app's
 * own upsert-by-name helper), two independently-run provisioning flows for
 * the SAME name silently converge on the SAME Tool entity — deleting it
 * affects every intellect that references it, not just the one the caller
 * has in mind. `delete()` below checks for exactly this before acting.
 */
export class Tools {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * Create a Tool entity. WRITE — NOT idempotent (a repeat call creates a
   * second entity; a duplicate `name` may be rejected server-side). Validates
   * the tool BEFORE any network call. `tool` may be a raw builder output
   * (already a {@link GenieToolConfig}) — it is re-validated either way.
   * @param {GenieToolConfig} tool @param {string} ks (admin)
   * @returns {Promise<{id:string, name:string, config:GenieToolConfig, partner_id?:number, created_at?:string, updated_at?:string}>}
   */
  async add(tool, ks) {
    this._.assertAdmin(ks, 'tools.add');
    const valid = validate(tool); // throws KalturaError before any network call
    return (await this._.genie('v1/tool/add', { name: valid.name, config: valid }, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Get a Tool by id. READ.
   * @param {string} id @param {string} ks (admin)
   * @returns {Promise<{id:string, name:string, config:GenieToolConfig}>}
   */
  async get(id, ks) {
    this._.assertAdmin(ks, 'tools.get');
    requireToolId(id, 'tools.get id');
    return (await this._.genie('v1/tool/get', { id }, ks)).data;
  }

  /**
   * List Tools for the authenticated partner. READ. Async-iterable + awaitable
   * (first page) — mirrors {@link Intellects#list}.
   * @param {string} ks (admin) @param {{filter?:object, pageSize?:number}} [opts]
   */
  list(ks, opts = {}) {
    this._.assertAdmin(ks, 'tools.list');
    return paginate({
      style: 'index', pageSize: opts.pageSize,
      fetchPage: (pager) => this._.genie('v1/tool/list', { filter: { objectType: 'ToolListFilter', ...(opts.filter || {}) }, pager }, ks).then((r) => r.data),
    });
  }

  /**
   * Update a Tool's name and/or config. WRITE — idempotent. `config`, when
   * present, is re-validated (throws BEFORE any network call).
   * @param {string} id @param {{name?:string, config?:GenieToolConfig}} patch @param {string} ks (admin)
   * @returns {Promise<{id:string, name:string, config:GenieToolConfig}>}
   */
  async update(id, patch, ks) {
    this._.assertAdmin(ks, 'tools.update');
    requireToolId(id, 'tools.update id');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) bad('bad_request', 'tools.update needs a patch object {name?, config?}.');
    if (patch.name === undefined && patch.config === undefined) bad('bad_request', 'tools.update needs at least one of name/config.');
    /** @type {Record<string,unknown>} */
    const body = { id };
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || !patch.name) bad('bad_request', 'tools.update patch.name must be a non-empty string.');
      body.name = patch.name;
    }
    if (patch.config !== undefined) body.config = validate(patch.config); // throws before network
    return (await this._.genie('v1/tool/update', body, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Delete a Tool by id. WRITE — destructive (requires confirmation). Does NOT
   * cascade: any intellect still listing this id in `tool_ids` keeps a
   * dangling reference — drop it first via `intellectConfig.setToolIds`.
   *
   * SAFETY CHECK (default on): before deleting, lists every intellect and
   * refuses with a typed `tool_in_use` error naming each one still carrying
   * this id in `tool_ids` — Tools are partner-level and shared by name (see
   * the class doc), so a stale saved id can easily still be load-bearing for
   * a DIFFERENT intellect than the caller has in mind. Pass
   * `{confirmPermanent:true, force:true}` to skip the check and delete
   * unconditionally (e.g. once you've confirmed via `intellectConfig.setToolIds`
   * that every referencing intellect has already been updated).
   * @param {string} id @param {string} ks (admin) @param {{confirmPermanent:boolean, force?:boolean}} confirm
   * @returns {Promise<{removed:string, _meta:object, skippedInUseCheck?:boolean}>}
   */
  async delete(id, ks, confirm) {
    this._.assertAdmin(ks, 'tools.delete');
    requireToolId(id, 'tools.delete id');
    requireConfirm(confirm, 'tools.delete', id);
    if (!confirm.force) {
      const refs = await findIntellectsReferencingTool(this._, id, ks);
      if (refs.length) {
        bad('tool_in_use', `tool ${id} is still referenced in tool_ids by ${refs.length} intellect(s) (configId: ${refs.join(', ')}) — deleting it would break every one still calling it. Drop it from their tool_ids first via intellectConfig.setToolIds, or pass {confirmPermanent:true, force:true} to delete anyway.`);
      }
    }
    await this._.genie('v1/tool/delete', { id }, ks);
    return {
      removed: id,
      ...(confirm.force ? { skippedInUseCheck: true } : {}),
      _meta: meta({ partnerId: this._.partnerId, source: 'genie/tool.delete', scope: `tool:${id}` }),
    };
  }
}
