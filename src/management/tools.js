/**
 * Tools — custom LLM-callable tools. A Tool is a PARTNER-LEVEL entity with its
 * OWN CRUD (`/v1/tool/add|get|list|update|delete`, Genie host, admin token) —
 * it is NOT embedded in an intellect. `Tool = {id, name, config, partner_id,
 * created_at, updated_at}`; `config` is the discriminated `api`/`csv`/`code`/
 * `client`/`var` shape built below. An intellect references the tools it may call by id via
 * `tool_ids: string[]` (uncapped) on `CreateIntellect`/`UpdateIntellect` — link
 * with {@link import('./intellect-config.js').IntellectConfig#setToolIds} or by
 * passing `tool_ids` straight to `intellects.create`/`update`. Mounted at
 * `mgmt.tools`.
 *
 * This file is two things: (1) a PURE builder/validator namespace (`tools.api`/
 * `csv`/`code`/`client`/`var`/`validate`/`validateArgs` + `applyResponseMapping`) that runs
 * anywhere with no transport, and (2) a `Tools` resource class bound to the
 * management Ctx for the `/v1/tool/*` CRUD wire path.
 *
 * Wire shape of a tool's `config` (snake_case on the wire; camelCase at the SDK
 * door) — this is the flat builder output below, wrapped as `Tool.config`:
 *   {type, description, name?, display_name?, add_to_history?, args?, condition?,
 *    request:{url, method, headers?, params?, body?, authentication?, timeout?},
 *    response_mapping? | response_template? | response_chapters?,
 *    variables_mapping?, wait_for_response?, timeout?, csv?, code?}
 * The builder's own `name` becomes the standalone Tool entity's partner-unique
 * `name` (the lookup key for `add`/`update`) — the same value the model calls
 * mid-conversation.
 */
import { uuidv4, meta } from '../core/ids.js';
import { requireConfirm } from './agents.js';
import { paginate } from './paginate.js';
import { KalturaError } from '../core/errors.js';
import { ARG_TYPE_NAMES } from '../core/stream.js';
import { assertCondition } from './condition.js';

/**
 * @typedef {object} GenieToolArg
 * @property {string} prompt         LLM-facing description of the argument.
 * @property {'str'|'int'|'float'|'bool'|'list'|'dict'} type
 * @property {boolean} [required] Omitted means required: `tools.get` returns `required: true`. Pass `false` for an optional arg.
 * @property {unknown} [default]
 */

/**
 * @typedef {object} GenieToolConfig A validated, wire-ready tool (snake_case).
 * @property {string} name
 * @property {'api'|'csv'|'code'|'client'|'var'} type
 * @property {string} description
 * @property {string} [display_name]
 * @property {boolean} [add_to_history]
 * @property {Record<string,GenieToolArg>} [args]
 * @property {string} [condition] Bare expression over thread variables. The tool is offered to the model only while it is truthy.
 * @property {object} [request]
 * @property {object} [response_mapping]
 * @property {string} [response_template]
 * @property {{iterate_on:string, content:string, link:string}} [response_chapters]
 * @property {object} [variables_mapping]
 * @property {string} [csv]
 * @property {string} [code]
 * @property {boolean} [wait_for_response] `api` and `client` tools.
 * @property {number} [timeout] `client` tools. An `api` tool's timeout is `request.timeout`.
 */

const NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Tool `type` discriminator — the closed set the backend understands. `api`
 * calls an HTTP endpoint, `csv` looks up rows in an inline table, `code` runs
 * sandboxed Python, `client` makes NO server-side call at all — see
 * {@link client}, and `var` sets conversation variables from its args — see
 * {@link varTool}.
 *
 * Only accounts Kaltura support has enabled can create `code` and `csv` tools.
 * On other accounts `add`, and `update` with a `config` of that type, reply HTTP
 * 403. Contact Kaltura support to enable them. `api`, `client` and `var` tools
 * have no such limit.
 * @type {ReadonlyArray<'api'|'csv'|'code'|'client'|'var'>}
 */
export const TOOL_TYPES = Object.freeze(['api', 'csv', 'code', 'client', 'var']);

/**
 * HTTP methods an `api` tool may use (closed set; defaults to GET).
 * @type {ReadonlyArray<'GET'|'POST'|'PUT'|'PATCH'|'DELETE'>}
 */
export const HTTP_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The data types a tool ARGUMENT may declare. The SDK accepts only these six:
 * {@link validateArgs} rejects any other `type` with `bad_request`. The model
 * fills each arg per its `type`. Re-exports
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
    if (!NAME_RE.test(key)) bad('bad_request', `tool arg name "${key}" must match ${NAME_RE} (letters, digits, underscore, or hyphen).`);
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
 * Structural dot-path check (no eval). A path is a dot-separated list of field
 * names and list indices, such as `json.items.0.id` or `headers.X-Request-Id`.
 * A segment holds letters, digits, `_` and `-`. No leading `$`, no brackets or
 * wildcards, no whitespace, parens or empty segments. PURE.
 * @param {string} path @param {string} where
 */
function assertJsonPath(path, where) {
  if (typeof path !== 'string' || !path.length) bad('bad_jsonpath', `${where} must be a non-empty dot-path string.`);
  if (/[()\s;$]/.test(path)) bad('bad_jsonpath', `${where} contains illegal characters (no whitespace/parens/scripts/"$" allowed): ${JSON.stringify(path)}.`);
  for (const seg of path.split('.')) {
    if (!/^[A-Za-z0-9_-]+$/.test(seg)) {
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
 * must be `{type:'oauth2', ...}` with a `client_secret` that is a secret
 * reference, `{{secrets.<name>}}`. The bare `secrets.<name>` is accepted and
 * saved as `{{secrets.<name>}}`. A plaintext client secret is rejected, so it
 * never lands in a tool config. Header values must be strings.
 * `url` and a string `body` may hold `{argName}` placeholders, which the server
 * fills from the model's args. Any other brace text in them makes the call
 * fail, so it is rejected here. In an object `body`, an undeclared `{name}` in
 * any string value is rejected the same way. `params` is accepted but the
 * server does not send it: put query values in the `url`. Returns the
 * wire-ready request object. PURE.
 * @param {object} request
 * @param {string[]} [argNames] Names of the tool's declared args.
 * @returns {object}
 */
function buildRequest(request, argNames = []) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) bad('bad_request', 'api tool needs a `request` object {url, method?, headers?, params?, body?, authentication?, timeout?}.');
  if (typeof request.url !== 'string' || !request.url) bad('bad_request', 'api tool `request.url` is required.');
  assertHttpUrl(request.url, 'request.url');
  assertBraceTokens(request.url, argNames, 'request.url');

  const method = request.method === undefined ? 'GET' : String(request.method).toUpperCase();
  // `method` is an arbitrary uppercased string until this very check proves it's one of
  // HTTP_METHODS's literals — widen the array's type for the membership test itself rather
  // than falsely asserting `method` already matches the narrower union.
  if (!(/** @type {readonly string[]} */ (HTTP_METHODS)).includes(method)) bad('bad_request', `api tool \`request.method\` must be one of ${HTTP_METHODS.join(', ')}, got ${JSON.stringify(request.method)}.`);

  let timeout = 10;
  if (request.timeout !== undefined) {
    if (typeof request.timeout !== 'number' || !Number.isInteger(request.timeout) || request.timeout < 1 || request.timeout > 120) {
      bad('bad_request', `api tool \`request.timeout\` must be an integer 1..120 (seconds), got ${JSON.stringify(request.timeout)}.`);
    }
    timeout = request.timeout;
  }

  /** @type {Record<string,unknown>} */
  const out = { url: request.url, method, timeout };
  if (request.headers != null) {
    if (typeof request.headers !== 'object' || Array.isArray(request.headers)) bad('bad_request', 'api tool `request.headers` must be an object.');
    for (const [k, v] of Object.entries(request.headers)) {
      if (typeof v !== 'string') bad('bad_request', `api tool \`request.headers[${JSON.stringify(k)}]\` must be a string, got ${v === null ? 'null' : typeof v}. Pass it as a string, for example "1" instead of 1.`);
    }
    out.headers = request.headers;
  }
  if (request.params !== undefined) {
    if (typeof request.params !== 'object' || Array.isArray(request.params)) bad('bad_request', 'api tool `request.params` must be an object.');
    out.params = request.params;
  }
  if (request.body !== undefined) {
    if (typeof request.body === 'string') assertBraceTokens(request.body, argNames, 'request.body');
    else assertBodyPlaceholders(request.body, argNames);
    out.body = request.body; // JSON object or raw string both legal
  }
  if (request.authentication != null) out.authentication = buildAuth(request.authentication);
  return out;
}

/**
 * Remove `{{ ... }}` and `{% ... %}` spans. One linear pass; an unclosed opener
 * and everything after it is kept, so the caller still sees its braces.
 * @param {string} text
 * @returns {string}
 */
function stripTemplateSpans(text) {
  let out = '';
  let pos = 0;
  for (;;) {
    const a = text.indexOf('{{', pos);
    const b = text.indexOf('{%', pos);
    const start = a === -1 ? b : b === -1 ? a : Math.min(a, b);
    if (start === -1) break;
    const end = text.indexOf(text[start + 1] === '{' ? '}}' : '%}', start + 2);
    if (end === -1) break;
    out += text.slice(pos, start);
    pos = end + 2;
  }
  return out + text.slice(pos);
}

/**
 * Every string value inside a JSON-like value, with its path, for example
 * `request.body.a.b[0]`. PURE.
 * @param {unknown} value @param {string} path
 * @returns {Generator<[string, string]>}
 */
function* stringLeaves(value, path) {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* stringLeaves(v, `${path}[${i}]`);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* stringLeaves(v, `${path}.${k}`);
}

/** The `{name}` placeholders in `text`, outside `{{ }}` and `{% %}` spans. PURE. @param {string} text @returns {string[]} */
function placeholderNames(text) {
  return [...stripTemplateSpans(text).matchAll(/\{([A-Za-z0-9_-]+)\}/g)].map((m) => m[1]);
}

/**
 * Reject a `{name}` that the tool does not declare, in any string value of an
 * object `request.body`, at any depth. Other brace text is left alone here:
 * only an undeclared name is known to fail the call. PURE.
 * @param {unknown} body @param {string[]} argNames
 */
function assertBodyPlaceholders(body, argNames) {
  for (const [path, text] of stringLeaves(body, 'request.body')) {
    for (const name of placeholderNames(text)) {
      if (!argNames.includes(name)) {
        bad('bad_placeholder', `${path} has {${name}}, but the tool declares no arg named "${name}". The server fills {argName} from the tool's args; declare the arg or remove the braces.`);
      }
    }
  }
}

/**
 * The names of an `api` tool's declared args that no `{argName}` in its
 * `request.url` or `request.body` uses. The server sends an arg only through
 * such a placeholder, so these args are asked from the model and then dropped.
 * Returns `[]` for any other tool type. PURE, never throws.
 * @param {unknown} config A tool config, as `tools.get(id).config` returns it.
 * @returns {string[]}
 */
export function unusedApiArgs(config) {
  const cfg = /** @type {any} */ (config);
  if (!cfg || typeof cfg !== 'object' || cfg.type !== 'api' || !cfg.args || typeof cfg.args !== 'object') return [];
  const used = new Set();
  for (const part of [cfg.request?.url, cfg.request?.body]) {
    for (const [, text] of stringLeaves(part, '')) for (const name of placeholderNames(text)) used.add(name);
  }
  return Object.keys(cfg.args).filter((name) => !used.has(name));
}

/**
 * The server fills `{argName}` placeholders in an `api` tool's `request.url`
 * and in its `request.body` (when the body is an object, each string value).
 * Brace text that is not a declared `{argName}` fails the call at run time
 * with a generic tool error, so a string `url` or `body` is checked here.
 * `{{ }}` and `{% %}` template spans are left alone. PURE.
 * @param {string} text @param {string[]} argNames @param {string} where
 */
function assertBraceTokens(text, argNames, where) {
  const rest = stripTemplateSpans(text).replace(/\{([A-Za-z0-9_-]+)\}/g, (_m, name) => {
    if (!argNames.includes(name)) {
      bad('bad_placeholder', `${where} has {${name}}, but the tool declares no arg named "${name}". The server fills {argName} from the tool's args; declare the arg or remove the braces.`);
    }
    return '';
  });
  if (/[{}]/.test(rest)) {
    bad('bad_placeholder', `${where} has brace text that is not an {argName} placeholder. The server treats every brace in a string url or body as a placeholder, so the call fails. Percent-encode braces in the url, and pass a JSON body as an object instead of a string.`);
  }
}

/** @param {string} url @param {string} where */
function assertHttpUrl(url, where) {
  let parsed;
  try { parsed = new URL(url); } catch { bad('invalid_url', `${where} is not a valid URL: ${JSON.stringify(url)}.`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') bad('invalid_url', `${where} must use http(s), got ${parsed.protocol} in ${JSON.stringify(url)}.`);
}

const AUTH_KEYS = ['type', 'client_id', 'client_secret', 'token_url', 'auth_url'];
const SECRET_REF_RE = /^(?:secrets\.([A-Za-z_][A-Za-z0-9_]*)|\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\})$/;
const VARIABLES_REF_RE = /^\{\{\s*variables\.secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

/**
 * Validate an inline OAuth2 auth block. The block supports the OAuth2
 * authorization-code flow only (viewer consent). `client_id`, `client_secret`,
 * `token_url` and `auth_url` are all required. `client_secret` must be a
 * secret reference. Write `{{secrets.<name>}}`. The bare `secrets.<name>` is
 * accepted as input and always saved as `{{secrets.<name>}}`.
 * `{{variables.secrets.<name>}}` and plaintext are refused. `token_url` and
 * `auth_url` are http(s)-validated. `scopes` and
 * `flow` are not options and are rejected, as is any other unknown key (an
 * explicit `undefined` value still counts as present). Client-credentials
 * providers do not fit this block.
 * @param {{type?:'oauth2', client_id:string, client_secret:string, token_url:string, auth_url:string}} auth
 */
function buildAuth(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) bad('bad_request', 'api tool `request.authentication` must be an object.');
  if (auth.type !== undefined && auth.type !== 'oauth2') bad('bad_request', `api tool authentication.type must be "oauth2" (the only supported scheme), got ${JSON.stringify(auth.type)}.`);
  for (const key of ['scopes', 'flow']) {
    if (key in auth) bad('bad_request', `api tool authentication does not support \`${key}\`. The block is the OAuth2 authorization-code flow only: client_id, client_secret, token_url, auth_url.`);
  }
  for (const key of Object.keys(auth)) {
    if (!AUTH_KEYS.includes(key)) bad('bad_request', `api tool authentication has an unknown key \`${key}\`. Allowed keys: ${AUTH_KEYS.join(', ')}.`);
  }
  const { client_id, client_secret, token_url, auth_url } = auth;
  if (typeof client_id !== 'string' || !client_id) bad('bad_request', 'oauth2 authentication needs a non-empty `client_id`.');
  if (client_secret === undefined) bad('bad_request', 'oauth2 authentication needs a `client_secret`. Write "{{secrets.<name>}}" and store the value with mgmt.intellects.secrets.set(configId, { <name>: value }, adminKs).');
  const secretRef = typeof client_secret === 'string' ? SECRET_REF_RE.exec(client_secret) : null;
  if (!secretRef) {
    const prefixed = typeof client_secret === 'string' ? VARIABLES_REF_RE.exec(client_secret) : null;
    if (prefixed) bad('bad_request', `oauth2 \`client_secret\` "${client_secret}" never resolves. Write "{{secrets.${prefixed[1]}}}".`);
    bad('bad_request', 'oauth2 `client_secret` must be a secret reference "{{secrets.<name>}}" (letters, digits, underscore). Store the value with mgmt.intellects.secrets.set(configId, { <name>: value }, adminKs). A plaintext value is rejected so it never lands in a tool config.');
  }
  if (token_url === undefined) bad('bad_request', 'oauth2 authentication needs a `token_url`.');
  if (auth_url === undefined) bad('bad_request', 'oauth2 authentication needs an `auth_url`.');
  assertHttpUrl(String(token_url), 'authentication.token_url');
  assertHttpUrl(String(auth_url), 'authentication.auth_url');
  return { type: 'oauth2', client_id, client_secret: `{{secrets.${secretRef[1] ?? secretRef[2]}}}`, token_url, auth_url };
}

/** Shared base validation (name/description/args/display/history). Mutates into `target`. @param {object} cfg @param {GenieToolConfig} target */
function buildShared(cfg, target) {
  if (!cfg || typeof cfg !== 'object') bad('bad_request', 'tool config must be an object.');
  if (typeof cfg.name !== 'string' || !NAME_RE.test(cfg.name)) bad('bad_request', `tool \`name\` must match ${NAME_RE} (letters, digits, underscore, or hyphen), got ${JSON.stringify(cfg.name)}.`);
  if (typeof cfg.description !== 'string' || !cfg.description.trim()) bad('bad_request', 'tool `description` is required (the LLM-facing description the model uses to decide when to call it).');
  target.name = cfg.name;
  target.description = cfg.description;
  const args = validateArgs(cfg.args);
  if (args) target.args = args;
  if (cfg.condition != null) target.condition = assertCondition(cfg.condition, 'tool `condition`');
  if (cfg.displayName != null) {
    if (typeof cfg.displayName !== 'string') bad('bad_request', 'tool `displayName` must be a string.');
    target.display_name = cfg.displayName;
  }
  if (cfg.addToHistory !== undefined) {
    if (typeof cfg.addToHistory !== 'boolean') bad('bad_request', 'tool `addToHistory` must be a boolean.');
    target.add_to_history = cfg.addToHistory;
  }
}

const SHAPERS = Object.freeze(['responseMapping', 'responseTemplate', 'responseChapters']);

/**
 * Check and copy the response fields of an `api` or `client` tool into `tool`:
 * the response shaper, then `variablesMapping`. An `api` tool needs exactly one
 * shaper. A `client` tool takes at most one. A `null` field counts as absent.
 * @param {Record<string, any>} cfg @param {GenieToolConfig} tool @param {'api'|'client'} kind
 */
function buildResponseFields(cfg, tool, kind) {
  const modes = SHAPERS.filter((k) => cfg[k] != null);
  if (kind === 'api') {
    if (modes.length === 0) bad('bad_request', 'api tool needs exactly one response shaper: responseMapping, responseTemplate, or responseChapters.');
    if (modes.length > 1) bad('bad_request', `api tool must have EXACTLY ONE of responseMapping/responseTemplate/responseChapters, got ${modes.join(' + ')}.`);
  } else if (modes.length > 1) {
    bad('bad_request', `client tool takes at most one of responseMapping/responseTemplate/responseChapters, got ${modes.join(' + ')}.`);
  }
  if (cfg.responseMapping != null) {
    assertMappingPaths(cfg.responseMapping, 'responseMapping');
    tool.response_mapping = cfg.responseMapping;
  } else if (cfg.responseTemplate != null) {
    if (typeof cfg.responseTemplate !== 'string' || !cfg.responseTemplate.length) bad('bad_request', 'responseTemplate must be a non-empty format string.');
    tool.response_template = cfg.responseTemplate;
  } else if (cfg.responseChapters != null) {
    const ch = cfg.responseChapters;
    if (typeof ch !== 'object' || Array.isArray(ch)) bad('bad_request', 'responseChapters must be an object {iterate_on, content, link}, each a dot-path.');
    for (const key of ['iterate_on', 'content', 'link']) {
      if (typeof ch[key] !== 'string' || !ch[key]) bad('bad_request', `responseChapters.${key} is required: a dot-path such as "items" or "title".`);
      assertJsonPath(ch[key], `responseChapters.${key}`);
    }
    tool.response_chapters = { iterate_on: ch.iterate_on, content: ch.content, link: ch.link };
  }
  if (cfg.variablesMapping != null) {
    assertMappingPaths(cfg.variablesMapping, 'variablesMapping');
    tool.variables_mapping = cfg.variablesMapping;
  }
}

/**
 * Build a validated `api` tool. Exactly ONE of `responseMapping`,
 * `responseTemplate`, `responseChapters` must be supplied (the three are
 * mutually exclusive response shapers).
 * `variablesMapping` (optional) extracts response fields into conversation
 * variables and is dot-path-checked. `responseChapters` is
 * `{iterate_on, content, link}`: `iterate_on` is the dot-path to a list, and
 * `content` and `link` are dot-paths read from each item.
 * `waitForResponse` (optional boolean) is sent as `wait_for_response` and kept by
 * `tools.update`. PURE. Returns a wire-ready
 * {@link GenieToolConfig}; throws {@link KalturaError} on bad input.
 *
 * `{argName}` in `request.url`, and in `request.body` (each string value of an
 * object body, at any depth), is replaced with the value the model passed for
 * that arg. Headers and `request.params` are NOT filled this way, and
 * `params` is not sent at all. An arg that no placeholder uses is never sent.
 * Brace text in a string `url` or `body` that is not a declared `{argName}`
 * fails the call, so it is rejected here with `bad_placeholder`:
 * percent-encode braces in the url and pass a JSON body as an object, not a
 * string. In an object body only an undeclared `{name}` is rejected.
 * @param {object} cfg {name, description, request, args?, responseMapping?, responseTemplate?, responseChapters?, variablesMapping?, waitForResponse?, condition?, displayName?, addToHistory?}
 * @example <caption>the model's `city` fills the url</caption>
 * tools.api({
 *   name: 'city_weather',
 *   description: 'Get the weather for a city.',
 *   args: { city: { prompt: 'City name', type: 'str', required: true } },
 *   request: { url: 'https://api.example.com/weather?city={city}', method: 'GET' },
 *   responseMapping: { temperature: 'main.temp' },
 * });
 * @returns {GenieToolConfig}
 */
export function api(cfg) {
  /** @type {GenieToolConfig} */
  const tool = { name: '', type: 'api', description: '' };
  buildShared(cfg, tool);
  tool.request = buildRequest(cfg.request, Object.keys(tool.args ?? {}));

  if (cfg.waitForResponse != null) {
    if (typeof cfg.waitForResponse !== 'boolean') bad('bad_request', 'api tool `waitForResponse` must be a boolean.');
    tool.wait_for_response = cfg.waitForResponse;
  }
  buildResponseFields(cfg, tool, 'api');
  return tool;
}

/**
 * Build a validated `csv` tool — an inline CSV lookup table. `args` are
 * OPTIONAL. The server derives them from the columns. The CSV
 * must be a non-empty string with a parseable
 * header row (≥1 column). PURE.
 *
 * Only accounts Kaltura support has enabled can create this type: on other
 * accounts `tools.add`, and `tools.update` with this `config`, reply HTTP 403.
 * Contact Kaltura support to enable it. This builder still validates and returns a wire-ready config either way; the 403
 * comes back from the network call, not from here.
 * @param {object} cfg {name, description, csv, args?, condition?, displayName?, addToHistory?}
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
 *
 * Only accounts Kaltura support has enabled can create this type: on other
 * accounts `tools.add`, and `tools.update` with this `config`, reply HTTP 403.
 * Contact Kaltura support to enable it. This builder still validates and returns a wire-ready config either way; the 403
 * comes back from the network call, not from here.
 * @param {object} cfg {name, description, code, args?, condition?, displayName?, addToHistory?}
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
 *  - `kaltura_genie_experiences` is not explicitly `'off'` (it can make the
 *    model prefer its built-in experience tool), or
 *  - no `capabilities` are set at all on this CREATE (flipping them later is
 *    not reliable; set them at creation).
 * @param {object} [body] An intellect create/update body.
 * @returns {{ok:boolean, warnings:string[]}}
 */
export function clientToolReadiness(body) {
  const warnings = [];
  const hasTools = body && Array.isArray(body.tool_ids) && body.tool_ids.length > 0;
  if (hasTools) {
    const caps = (body && body.capabilities && typeof body.capabilities === 'object') ? body.capabilities : null;
    if (!caps) {
      warnings.push('This intellect references tools (tool_ids) but sets no capabilities. The kaltura_genie_experiences capability is on by default and can make the model prefer its built-in experience tool over your custom tools. Set capabilities:{kaltura_genie_experiences:"off"} at CREATION (flipping it later is not reliable).');
    } else if (caps.kaltura_genie_experiences !== 'off') {
      warnings.push('This intellect references tools (tool_ids) but kaltura_genie_experiences is not "off". It can make the model prefer its built-in experience tool over your custom tools. Set kaltura_genie_experiences:"off" unless you also want GenUI experiences.');
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
 * block and no echo endpoint. The model calls it, the
 * backend emits the `type:"tool"` segment (with `tool_metadata.id`, see
 * {@link import('../core/stream.js').parseToolCall}), and that's the entire
 * server-side contract.
 *
 * It takes the same optional response fields as an `api` tool: at most one of
 * `responseMapping`, `responseTemplate`, `responseChapters`, plus
 * `variablesMapping`, with the same rules. `tools.get` returns them and
 * `tools.update` keeps them.
 *
 * A client tool is a normal agent tool call. Its `type:"tool"` segment is not
 * spoken (see docs/CLIENT-COMMANDS.md).
 *
 * TWO DEPLOYMENT GOTCHAS (author-time discipline; see {@link clientToolReadiness}):
 *  1. The `kaltura_genie_experiences` capability is on by default and can
 *     make the model prefer its built-in experience tool over your custom
 *     tools. Turn it OFF on a tool-driven intellect
 *     (`capabilities:{kaltura_genie_experiences:'off'}`).
 *  2. Capabilities are read when the intellect is created, so a capability
 *     flipped on an EXISTING intellect is not reliable. Set capabilities
 *     at CREATION (`intellects.create({capabilities:{...}})`).
 *
 * `waitForResponse` controls whether the model's turn BLOCKS on a real
 * client-supplied result. **Omitting it is NOT the same as passing `false`** —
 * this builder sends no field at all when omitted, and the backend's own
 * wire default for an absent `wait_for_response` is `true`, so an omitted
 * `waitForResponse` blocks. Pass it explicitly:
 *  - `false` — the backend doesn't wait; the turn continues immediately.
 *  - `true`: the turn waits up to `timeout` seconds for your client to
 *    answer with {@link import('../experience/session.js').KalturaAvatarSession#respondToTool}
 *    before the model gets a result. Both the 30s default and an explicit
 *    `timeout` are honored.
 *
 * PURE — returns a wire-ready {@link GenieToolConfig}; throws {@link KalturaError}
 * on bad input, before any network call.
 * @param {object} cfg
 * @param {string} cfg.name        Tool name the LLM calls + you dispatch on. Letters, digits, underscore, or hyphen.
 * @param {string} cfg.description LLM-facing: WHEN to call it.
 * @param {Record<string,GenieToolArg>} [cfg.args] Argument schema ({argName:{prompt,type,required?,default?}}).
 * @param {boolean} [cfg.waitForResponse] Block the turn on a real client ACK. Omitting this
 *   is NOT the same as `false` — the backend's own default for an absent field is `true`
 *   (blocking); pass `false` explicitly for fire-and-forget.
 * @param {number} [cfg.timeout] Seconds to wait for the ACK when `waitForResponse` is `true`;
 *   integer 1..120 (same bound as an `api` tool's `request.timeout`). Default 30 (backend
 *   default when omitted).
 * @param {Record<string,string>} [cfg.responseMapping] Same rules as {@link api}.
 * @param {string} [cfg.responseTemplate] Same rules as {@link api}.
 * @param {{iterate_on:string, content:string, link:string}} [cfg.responseChapters] Same rules as {@link api}.
 * @param {Record<string,string>} [cfg.variablesMapping] Same rules as {@link api}.
 * @param {string} [cfg.condition] Bare expression over thread variables (for example `sys__avatar_enabled`). The model is offered the tool only while it is truthy.
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
  if (cfg.waitForResponse != null) {
    if (typeof cfg.waitForResponse !== 'boolean') bad('bad_request', 'client tool `waitForResponse` must be a boolean.');
    tool.wait_for_response = cfg.waitForResponse;
  }
  if (cfg.timeout != null) {
    if (typeof cfg.timeout !== 'number' || !Number.isInteger(cfg.timeout) || cfg.timeout < 1 || cfg.timeout > 120) {
      bad('bad_request', `client tool \`timeout\` must be an integer 1..120 (seconds), got ${JSON.stringify(cfg.timeout)}.`);
    }
    tool.timeout = cfg.timeout;
  }
  buildResponseFields(cfg, tool, 'client');
  return tool;
}

/**
 * Build a validated `var` tool. When the model calls it, each arg's value is
 * stored as a conversation variable with the arg's own name. Later turns of
 * the same thread can read it in a prompt or skill `condition`, or as
 * `{{ name }}` in prompt text. The variable does not carry over to a new thread.
 * It makes no network call and needs no admin approval, unlike `csv` and `code`.
 *
 * Every arg name is the variable name, so it must be an identifier
 * (letters, digits, underscore; not starting with a digit) and must not start
 * with `sys__` or `secrets`: those names belong to the platform. At
 * least one arg is required. PURE.
 * @param {object} cfg {name, description, args, condition?, displayName?, addToHistory?}
 * @returns {GenieToolConfig}
 * @example <caption>switch a persona for the rest of the thread</caption>
 * const setMode = tools.var({
 *   name: 'set_mode',
 *   description: 'Switch the reply mode when the user asks for it.',
 *   args: { reply_mode: { prompt: 'The mode name, lowercase', type: 'str', required: true } },
 * });
 * // A prompt block with condition: "reply_mode == 'formal'" now applies from the next turn on.
 */
export function varTool(cfg) {
  /** @type {GenieToolConfig} */
  const tool = { name: '', type: 'var', description: '' };
  buildShared(cfg, tool);
  const names = Object.keys(tool.args ?? {});
  if (!names.length) bad('bad_request', 'var tool needs at least one arg: each arg names the variable it sets.');
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.startsWith('sys__') || name.startsWith('secrets')) {
      bad('bad_request', `var tool arg "${name}" is the name of the variable it sets, so it must be an identifier (letters, digits, underscore, not starting with a digit) that does not start with "sys__" or "secrets".`);
    }
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
        displayName: tool.display_name, addToHistory: tool.add_to_history, condition: tool.condition,
        responseMapping: tool.response_mapping,
        responseTemplate: tool.response_template,
        responseChapters: tool.response_chapters,
        variablesMapping: tool.variables_mapping,
        waitForResponse: tool.wait_for_response,
      });
    case 'csv':
      return csv({ name: tool.name, description: tool.description, csv: tool.csv, args: tool.args, condition: tool.condition, displayName: tool.display_name, addToHistory: tool.add_to_history });
    case 'code':
      return code({ name: tool.name, description: tool.description, code: tool.code, args: tool.args, condition: tool.condition, displayName: tool.display_name, addToHistory: tool.add_to_history });
    case 'client':
      return client({ name: tool.name, description: tool.description, args: tool.args, condition: tool.condition, displayName: tool.display_name, addToHistory: tool.add_to_history, waitForResponse: tool.wait_for_response, timeout: tool.timeout, responseMapping: tool.response_mapping, responseTemplate: tool.response_template, responseChapters: tool.response_chapters, variablesMapping: tool.variables_mapping });
    case 'var':
      return varTool({ name: tool.name, description: tool.description, args: tool.args, condition: tool.condition, displayName: tool.display_name, addToHistory: tool.add_to_history });
    default:
      bad('bad_request', `tool \`type\` must be one of ${TOOL_TYPES.join(', ')}, got ${JSON.stringify(tool.type)}.`);
  }
}

/**
 * Apply a `response_mapping` (`{outputKey: dot-path}`) to a parsed JSON
 * response, returning `{outputKey: extractedValue}`. Use it for a local preview
 * or a test. Paths use the same syntax `tools.api` accepts. Missing paths yield
 * `undefined`. PURE, never throws on data.
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

/** Evaluate a dot-path against `root`. @param {unknown} root @param {string} path */
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
export const tools = { api, csv, code, client, var: varTool, clientToolReadiness, validate, validateArgs, applyResponseMapping, TOOL_TYPES, HTTP_METHODS, ARG_TYPES };

/**
 * The tool id in one `tool_ids` / `thread_start_tools` entry. The server reads
 * these lists back as `[{id, condition}]` objects, and accepts plain strings on
 * write, so every reader of a list goes through this. PURE.
 * @param {unknown} entry A string id or an `{id, condition?}` object.
 * @returns {string|undefined} Undefined when the entry holds no usable id.
 */
export function toolRefId(entry) {
  const id = typeof entry === 'string' ? entry : /** @type {any} */ (entry)?.id;
  return typeof id === 'string' && id ? id : undefined;
}

/** @param {unknown} v @param {string} name */
function requireToolId(v, name) {
  if (typeof v !== 'string' || !v) bad('bad_request', `${name} must be a non-empty string (the Tool entity's id).`);
}

/**
 * List every intellect's configId that currently references `toolId` in its
 * `tool_ids` — the safety check `Tools#delete` runs before deleting a
 * PARTNER-LEVEL Tool that may be shared across intellects (see the class
 * doc). Implemented via raw `ctx.genie` calls rather than the `Intellects`
 * class to avoid a circular import (`intellects.js` already imports
 * {@link clientToolReadiness} from this file). `v1/intellect/list` returns a
 * lighter DTO that may omit `tool_ids`, so each candidate is confirmed via
 * `v1/intellect/get`. An intellect that is gone by then (`not_found`) is
 * skipped; any other error from that call is rethrown.
 * Exported (not just used by `Tools#delete`) so callers upserting a Tool
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
      // Skip only an intellect deleted between list and get; any other failure must surface,
      // or a guarded delete would wrongly report "no references".
      const full = await ctx.genie('v1/intellect/get', { id: item.id }, ks).then((r) => r.data).catch((e) => {
        if (e?.code === 'not_found' || e?.code === 'intellect_not_found') return null;
        throw e;
      });
      if (Array.isArray(full?.tool_ids) && full.tool_ids.some((e) => toolRefId(e) === toolId)) refs.push(item.id);
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
 * `client`/`var`. `name` is unique per partner; `update` is the idempotent re-edit path.
 *
 * Creating a Tool does NOT attach it to anything — link it to an intellect via
 * `tool_ids` (see `intellectConfig.setToolIds`, or pass `tool_ids` directly to
 * `intellects.create`/`update`).
 *
 * A duplicate `name` (on `add`, or a rename in `update`) returns HTTP 409
 * (`code:'conflict'`). The same applies to {@link Skills}.
 *
 * SHARED-BY-NAME HAZARD: because `name` is the lookup key callers upsert
 * against (see `src/management/provision.js`'s `applyTools`, or an app's
 * own upsert-by-name helper), two independently-run provisioning flows for
 * the SAME name silently converge on the SAME Tool entity — deleting it
 * affects every intellect that references it, not just the one the caller
 * has in mind. `delete()` below checks for exactly this before acting.
 *
 * Only accounts Kaltura support has enabled can create `code`/`csv` tools, see
 * {@link TOOL_TYPES}. On other accounts `add`, and `update` with a `config` of
 * that type, reply HTTP 403 (`code:'forbidden'`). A name-only `update` of an existing tool,
 * `get`, `list` and `delete` are not affected.
 */
export class Tools {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * Create a Tool entity. WRITE — NOT idempotent (a repeat call creates a
   * second entity; a duplicate `name` returns HTTP 409). Validates
   * the tool BEFORE any network call. `tool` may be a raw builder output
   * (already a {@link GenieToolConfig}) — it is re-validated either way.
   *
   * Also callable as {@link Tools#create} — same method, either name works.
   * @param {GenieToolConfig} tool @param {string} ks (admin)
   * @returns {Promise<{id:string, name:string, config:GenieToolConfig, partner_id?:number, created_at?:string, updated_at?:string}>}
   */
  async add(tool, ks) {
    this._.assertAdmin(ks, 'tools.add');
    const valid = validate(tool); // throws KalturaError before any network call
    return (await this._.genie('v1/tool/add', { name: valid.name, config: valid }, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Alias for {@link Tools#add}. Same validation, same call, same result.
   * @param {GenieToolConfig} tool @param {string} ks (admin)
   * @returns {Promise<{id:string, name:string, config:GenieToolConfig, partner_id?:number, created_at?:string, updated_at?:string}>}
   */
  create(tool, ks) {
    return this.add(tool, ks);
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
   * (first page) — mirrors {@link Intellects#list}. `filter.nameLike` matches
   * the whole name, case-insensitive. Add `%` for a partial match.
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
   * present, is re-validated. `name`, when present, must match the same rule as
   * `add` (letters, digits, underscore, hyphen). Both are checked before any
   * network call.
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
      if (typeof patch.name !== 'string' || !NAME_RE.test(patch.name)) bad('bad_request', `tools.update patch.name must match ${NAME_RE} (letters, digits, underscore, or hyphen), got ${JSON.stringify(patch.name)}.`);
      body.name = patch.name;
    }
    if (patch.config !== undefined) body.config = validate(patch.config); // throws before network
    return (await this._.genie('v1/tool/update', body, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * List the configId of every intellect whose `tool_ids` contains `toolId`. READ.
   * This is the check `delete` runs by default. Call it to preview what a delete
   * would break, or to guard your own upsert-by-name logic. Rejects if an
   * intellect lookup fails (other than `not_found`), so an empty result always
   * means "checked, none found".
   * @param {string} toolId @param {string} ks (admin)
   * @returns {Promise<number[]>} configIds (empty when nothing references the Tool).
   */
  async findReferencingIntellects(toolId, ks) {
    this._.assertAdmin(ks, 'tools.findReferencingIntellects');
    requireToolId(toolId, 'tools.findReferencingIntellects toolId');
    return findIntellectsReferencingTool(this._, toolId, ks);
  }

  /**
   * Delete a Tool by id. WRITE — destructive (requires confirmation). Does NOT
   * cascade: any intellect still listing this id in `tool_ids` keeps a
   * dangling reference — drop it first via `intellectConfig.setToolIds`.
   *
   * SAFETY CHECK (default on): before deleting, lists every intellect and
   * refuses with a typed `tool_in_use` error naming each one still carrying
   * this id in `tool_ids`. If an intellect lookup fails (other than `not_found`),
   * the call rejects with that error and nothing is deleted. Tools are
   * partner-level and shared by name (see the class doc), so a stale saved id
   * can easily still be load-bearing for a DIFFERENT intellect than the caller
   * has in mind. Pass
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
