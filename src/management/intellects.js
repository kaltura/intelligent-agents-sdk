/**
 * Intellects — the AI "brain" config (prompts, base_directive, glossary,
 * capabilities, `tool_ids` linkage, knowledge linkage). OWNED BY GENIE (source
 * of truth). Genie host, admin token. Source: tools/genie.mjs intellect-* +
 * API-REFERENCE §2.1/§2.2.
 *
 * Tools themselves are a SEPARATE, partner-level entity (`mgmt.tools`,
 * `/v1/tool/*` — see `tools.js`) — an intellect only carries the `tool_ids` it
 * references, not the tool bodies.
 */
import { paginate } from './paginate.js';
import { uuidv4, meta } from '../core/ids.js';
import { requireConfirm } from './agents.js';
import { KalturaError } from '../core/errors.js';
import {
  CAPABILITY_STATE,
  validateCapabilities, assertCapability, assertCapabilityState,
  mergeCapabilityWrite, resolveCapabilities,
} from './capabilities.js';
import { lintPrompts, lintGlossary, assembleSystemPrompt } from './prompt-lint.js';
import { clientToolReadiness } from './tools.js';
import { IntellectSecrets } from './secrets.js';
import { stripServerManaged, requireInt } from './intellect-body.js';
import { classifyPartnerConfigError, probePartnerConfigRoute } from './partner-config-probe.js';

/**
 * Brain-config fields that route through `partner-config/update` (NOT the
 * intellect DTO). Split into a VERIFIED tier (confirmed settable via this
 * route) and an UNVERIFIED tier (read-only to both public DTOs — routing them
 * through partner-config is plausible but not confirmed to round-trip).
 * camelCase in → snake on the wire.
 */
const BRAIN_VERIFIED = Object.freeze({
  agentLlm: 'agent_llm',
  agentFastLlm: 'agent_fast_llm',
});
const SEARCH_DEPTHS = Object.freeze(['basic', 'advanced', 'ultra-fast']);
const INCLUDE_ANSWER = Object.freeze([false, 'basic', 'advanced']);

/**
 * Build the snake_case `config` patch for a partner-config brain-config write.
 * PURE — validates and maps; throws {@link KalturaError} (`code:'bad_request'`)
 * naming the offending key BEFORE any network call. Model-id strings are NOT
 * validated against an enum (the API accepts `us.`/`eu.` prefixes + free-form
 * stored values — known-good defaults are documented, not enforced).
 *
 * Tiers:
 *   VERIFIED (confirmed settable): agentLlm, agentFastLlm, rateLimits, anonymousRateLimits.
 *   UNVERIFIED (best-effort, may be dropped server-side): agentAvatarLlm,
 *     runQuotaCheck, webSearch (→ web_search_config; its mere presence flips
 *     use_web_search ON server-side — this builder does NOT double-write the
 *     capability). `applied` lists EXACTLY the snake keys sent — "sent", NOT
 *     "confirmed persisted" (confirm with getBrainConfig).
 *
 * Footgun (JSDoc'd at the caller): anonymous perMinute:0 / perHour:0 BLOCKS ALL
 * anonymous traffic.
 *
 * @param {object} cfg {agentLlm?, agentFastLlm?, agentAvatarLlm?, rateLimits?:{perMinute?,perHour?}, anonymousRateLimits?:{perMinute?,perHour?}, runQuotaCheck?, webSearch?:{includeDomains?,includeAnswer?,searchDepth?,maxResults?}}
 * @returns {{config:Record<string,unknown>, applied:string[]}}
 */
export function buildBrainConfigPatch(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw badReq('setBrainConfig needs a config object (agentLlm?, agentFastLlm?, rateLimits?, anonymousRateLimits?, agentAvatarLlm?, runQuotaCheck?, webSearch?).');
  }
  /** @type {Record<string,unknown>} */
  const config = {};
  /** @type {string[]} */
  const applied = [];

  for (const [camel, snake] of Object.entries(BRAIN_VERIFIED)) {
    if (cfg[camel] !== undefined) {
      if (typeof cfg[camel] !== 'string' || !cfg[camel].trim()) throw badReq(`${camel} must be a non-empty model-id string.`);
      config[snake] = cfg[camel];
      applied.push(snake);
    }
  }
  // UNVERIFIED: agentAvatarLlm
  if (cfg.agentAvatarLlm !== undefined) {
    if (typeof cfg.agentAvatarLlm !== 'string' || !cfg.agentAvatarLlm.trim()) throw badReq('agentAvatarLlm must be a non-empty model-id string.');
    config.agent_avatar_llm = cfg.agentAvatarLlm;
    applied.push('agent_avatar_llm');
  }
  // rate limits (VERIFIED authed + anon)
  applyRateLimits(cfg.rateLimits, 'rateLimits', 'rate_limit_per_minute', 'rate_limit_per_hour', config, applied);
  applyRateLimits(cfg.anonymousRateLimits, 'anonymousRateLimits', 'anonymous_rate_limit_per_minute', 'anonymous_rate_limit_per_hour', config, applied);
  // UNVERIFIED: runQuotaCheck
  if (cfg.runQuotaCheck !== undefined) {
    if (typeof cfg.runQuotaCheck !== 'boolean') throw badReq('runQuotaCheck must be a boolean.');
    config.run_quota_check = cfg.runQuotaCheck;
    applied.push('run_quota_check');
  }
  // UNVERIFIED: webSearch → web_search_config
  if (cfg.webSearch !== undefined) {
    config.web_search_config = buildWebSearch(cfg.webSearch);
    applied.push('web_search_config');
  }

  if (applied.length === 0) throw badReq('setBrainConfig: empty config — supply at least one of agentLlm/agentFastLlm/rateLimits/anonymousRateLimits/agentAvatarLlm/runQuotaCheck/webSearch.');
  return { config, applied };
}

// THE shared read-merge-write body primitive lives in the leaf module
// intellect-body.js (not here) so conversations.js can import it without
// pulling in this file's own import graph (which reaches prompt-lint.js's
// RESERVED_VARS, itself imported from conversations.js — a cycle). Re-exported
// here (and used below by `_rmwBody`) so existing callers, including
// `IntellectConfig.patch`, keep their existing import path.
export { stripServerManaged };

/** @param {unknown} block @param {string} where @param {string} minKey @param {string} hrKey @param {Record<string,unknown>} config @param {string[]} applied */
function applyRateLimits(block, where, minKey, hrKey, config, applied) {
  if (block === undefined) return;
  if (!block || typeof block !== 'object' || Array.isArray(block)) throw badReq(`${where} must be an object { perMinute?, perHour? }.`);
  const o = /** @type {Record<string,unknown>} */ (block);
  if (o.perMinute !== undefined) { config[minKey] = nonNegInt(o.perMinute, `${where}.perMinute`); applied.push(minKey); }
  if (o.perHour !== undefined) { config[hrKey] = nonNegInt(o.perHour, `${where}.perHour`); applied.push(hrKey); }
  if (o.perMinute === undefined && o.perHour === undefined) throw badReq(`${where} needs at least one of perMinute/perHour.`);
}

/** @param {unknown} ws */
function buildWebSearch(ws) {
  if (!ws || typeof ws !== 'object' || Array.isArray(ws)) throw badReq('webSearch must be an object { includeDomains?, includeAnswer?, searchDepth?, maxResults? }.');
  const o = /** @type {Record<string,unknown>} */ (ws);
  /** @type {Record<string,unknown>} */
  const out = {};
  if (o.includeDomains !== undefined) {
    if (!Array.isArray(o.includeDomains) || o.includeDomains.some((d) => typeof d !== 'string')) throw badReq('webSearch.includeDomains must be an array of domain strings.');
    out.include_domains = o.includeDomains;
  }
  if (o.includeAnswer !== undefined) {
    if (!INCLUDE_ANSWER.includes(/** @type {any} */ (o.includeAnswer))) throw badReq(`webSearch.includeAnswer must be one of ${INCLUDE_ANSWER.map((v) => JSON.stringify(v)).join(', ')}.`);
    out.include_answer = o.includeAnswer;
  }
  out.search_depth = o.searchDepth === undefined ? 'ultra-fast' : o.searchDepth;
  if (!SEARCH_DEPTHS.includes(/** @type {any} */ (out.search_depth))) throw badReq(`webSearch.searchDepth must be one of ${SEARCH_DEPTHS.join(', ')} (default ultra-fast).`);
  out.max_results = o.maxResults === undefined ? 5 : o.maxResults;
  if (typeof out.max_results !== 'number' || !Number.isInteger(out.max_results) || out.max_results <= 0) throw badReq('webSearch.maxResults must be a positive integer (default 5).');
  return out;
}

/** @param {unknown} v @param {string} where @returns {number} */
function nonNegInt(v, where) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw badReq(`${where} must be a non-negative integer.`);
  return v;
}

/** @param {string} detail */
function badReq(detail) {
  return new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail });
}

export class Intellects {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) {
    this._ = ctx;
    /** Named secrets (`config.secrets`, write-only). @type {IntellectSecrets} */
    this.secrets = new IntellectSecrets(ctx);
  }

  /**
   * List intellects. READ. ⚠️ EVENTUALLY CONSISTENT — the list index lags writes,
   * so it may briefly still include a just-DELETED id (or omit a just-created
   * one). Do not treat list membership as authoritative immediately after a
   * mutation; confirm a specific id with {@link get} before acting on it.
   * @param {string} ks @param {{filter?:object,pageSize?:number}} [opts]
   */
  list(ks, opts = {}) {
    this._.assertAdmin(ks, 'intellects.list');
    return paginate({
      style: 'index', pageSize: opts.pageSize,
      fetchPage: (pager) => this._.genie('v1/intellect/list', { filter: opts.filter || {}, pager }, ks).then((r) => r.data),
    });
  }

  /** Get the full intellect config (capabilities, prompts, knowledge_ids, tool_ids, masked secrets). READ. @param {number} id @param {string} ks */
  async get(id, ks) {
    this._.assertAdmin(ks, 'intellects.get');
    requireInt(id, 'intellects.get id');
    return (await this._.genie('v1/intellect/get', { id }, ks)).data;
  }

  /**
   * Create an intellect (RAW escape hatch — prefer {@link create}, which applies
   * safe defaults). WRITE — NOT idempotent. Use `{type:'internal',status:2}` for
   * a fresh brain, then {@link update} to configure prompts. The returned `id`
   * is the configId used directly in `agents.create({intellect:{id}})` — no
   * separate genieId lookup is needed. Auto-sends an Idempotency-Key.
   *
   * ⚠️ FOOTGUN — `body.status`: OMITTING `status` defaults to `1` (PENDING)
   * server-side — a NON-SERVING brain that converse/agent-binding won't use. Pass
   * `status:2` (ACTIVE) explicitly, or call {@link create} (which defaults it to
   * 2 for you). This raw path does NOT inject a default.
   * @param {object} body {type,status,prompts?,base_directive?,glossary?,capabilities?,knowledge_ids?,tool_ids?,user_properties_forms?,secrets?}
   * @param {string} ks
   */
  async add(body, ks) {
    this._.assertAdmin(ks, 'intellects.add');
    return (await this._.genie('v1/intellect/add', body, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Update an intellect. WRITE — idempotent. The body MUST include
   * `{id, type}` — `type` is a required discriminator (omitting it → HTTP 422
   * `missing_discriminator`). See API-REFERENCE §2.2 for the full prompt shape.
   * @param {object} body {id,type,...}
   * @param {string} ks
   */
  async update(body, ks) {
    this._.assertAdmin(ks, 'intellects.update');
    if (!body || body.type === undefined) {
      throw new KalturaError({ type: 'about:blank', title: 'type required', code: 'missing_discriminator', detail: 'intellects.update body must include {id, type} — type is a required discriminator (else HTTP 422).' });
    }
    return (await this._.genie('v1/intellect/update', body, ks)).data;
  }

  /**
   * Read the current intellect and build the full re-send body (drop
   * server-managed read-only keys; re-assert {id,type,status}). Shared by every
   * read-merge-write setter below. `external` intellects have no editable brain
   * config → typed `bad_request`. @param {number} configId @param {string} ks @param {string} where
   * @returns {Promise<{cur:any, body:Record<string,unknown>}>}
   */
  async _rmwBody(configId, ks, where) {
    const cur = (await this._.genie('v1/intellect/get', { id: configId }, ks)).data || {};
    if (cur.type === 'external') {
      throw new KalturaError({ type: 'about:blank', title: 'unsupported', code: 'bad_request', detail: `${where}: intellect ${configId} is type "external" — external intellects have no editable brain config.` });
    }
    return { cur, body: stripServerManaged(cur, configId) };
  }

  // ─────────────────────────── create defaults ───────────────────────────

  /**
   * Create an intellect with the SDK defaults applied + the resolved `type`
   * echoed. WRITE — NOT idempotent (auto-sends an Idempotency-Key). Defaults
   * `type:'internal'` and `status:2` (ACTIVE — opt out with `status:1` for
   * PENDING). REJECTS `url`/`protocol`: the `type:external` (BYO-LLM) config is a
   * backend scaffold with no converse-time delegation (stored but not wired into
   * the converse runtime), so the SDK does not offer a path to create one. The echoed `type` is SDK-resolved, not
   * server-confirmed. @param {object} body @param {string} ks (admin)
   * @returns {Promise<{configId:number|undefined, type:string, status:number, raw:any, _meta:object}>}
   */
  async create(body, ks) {
    this._.assertAdmin(ks, 'intellects.create');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badReq('intellects.create needs a body object.');
    if (body.url !== undefined || body.protocol !== undefined) {
      throw badReq('intellects.create does not support `url`/`protocol`: the external (BYO-LLM) intellect type is not yet supported on the public API.');
    }
    const type = body.type ?? 'internal';
    const status = body.status ?? 2;
    // Client-tool readiness lint: tools without kaltura_genie_experiences:'off' are out-competed by GenUI.
    // Capabilities set post-create are defeated by the ~24h cache.
    // Surface as warnings on the receipt so authoring UIs / AI agents see them.
    const readiness = clientToolReadiness({ ...body, type, status });
    const raw = await this.add({ ...body, type, status }, ks);
    return {
      configId: typeof raw?.id === 'number' ? raw.id : undefined,
      type, status, raw,
      ...(readiness.warnings.length ? { warnings: readiness.warnings } : {}),
      _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.add', scope: 'disableentitlement', typeResolved: 'sdk-resolved (not server-confirmed)' }),
    };
  }

  // ─────────────────────────── capabilities ───────────────────────────

  /**
   * Read the stored `capabilities` dict. READ. @param {number} configId @param {string} ks (admin)
   * @returns {Promise<{capabilities:Record<string,'on'|'off'|'disabled'>, _meta:object}>}
   */
  async getCapabilities(configId, ks) {
    this._.assertAdmin(ks, 'intellects.getCapabilities');
    requireInt(configId, 'intellects.getCapabilities configId');
    const cur = (await this._.genie('v1/intellect/get', { id: configId }, ks)).data || {};
    const caps = (cur.capabilities && typeof cur.capabilities === 'object' && !Array.isArray(cur.capabilities)) ? cur.capabilities : {};
    return { capabilities: caps, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.get', scope: `configId:${configId}` }) };
  }

  /**
   * Set ONE capability by name (read-merge-write the full-replace dict). WRITE —
   * idempotent. Re-enabling a STORED `'disabled'` to `'on'` is refused by an
   * SDK-side CONVENIENCE guard (not an API constraint — the server only vetoes
   * per-REQUEST overrides) unless `{force:true}`. @param {number} configId @param {string} name @param {'on'|'off'|'disabled'} state @param {string} ks (admin) @param {{force?:boolean}} [opts]
   */
  async setCapability(configId, name, state, ks, opts = {}) {
    this._.assertAdmin(ks, 'intellects.setCapability');
    requireInt(configId, 'intellects.setCapability configId');
    assertCapability(name, 'intellects.setCapability');
    assertCapabilityState(state, `intellects.setCapability.${name}`);
    const { cur, body } = await this._rmwBody(configId, ks, 'intellects.setCapability');
    const current = (cur.capabilities && typeof cur.capabilities === 'object') ? cur.capabilities : {};
    if (!opts.force && current[name] === CAPABILITY_STATE.DISABLED && state === CAPABILITY_STATE.ON) {
      throw new KalturaError({ type: 'about:blank', title: 'capability vetoed', code: 'capability_vetoed', detail: `intellects.setCapability: "${name}" is stored 'disabled'. Re-enabling it is refused by an SDK convenience guard — pass {force:true} to override (the API itself would allow it; only per-REQUEST overrides are server-vetoed).` });
    }
    body.capabilities = mergeCapabilityWrite(current, { [name]: state });
    const result = (await this._.genie('v1/intellect/update', body, ks)).data;
    return { capabilities: body.capabilities, result, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.update', scope: `configId:${configId}`, readModifyWrite: true }) };
  }

  /**
   * Set MANY capabilities (read-merge-write the full-replace dict). WRITE —
   * idempotent. Same DISABLED-re-enable convenience guard as
   * {@link setCapability} (per offending key) unless `{force:true}`.
   *
   * ⚠️ ALL-OR-NOTHING: the guard runs PRE-NETWORK over the WHOLE `dict` — if ANY
   * key tries to re-enable a stored `'disabled'` capability, the ENTIRE write
   * aborts with `code:'capability_vetoed'` and NOTHING is applied (no partial
   * write). Either drop/fix the offending key(s) and retry the whole dict, or
   * pass `{force:true}` to override and apply the dict as-is.
   * @param {number} configId @param {Record<string,'on'|'off'|'disabled'>} dict @param {string} ks (admin) @param {{force?:boolean}} [opts]
   */
  async setCapabilities(configId, dict, ks, opts = {}) {
    this._.assertAdmin(ks, 'intellects.setCapabilities');
    requireInt(configId, 'intellects.setCapabilities configId');
    validateCapabilities(dict, 'intellects.setCapabilities');
    const { cur, body } = await this._rmwBody(configId, ks, 'intellects.setCapabilities');
    const current = (cur.capabilities && typeof cur.capabilities === 'object') ? cur.capabilities : {};
    if (!opts.force) {
      for (const [name, state] of Object.entries(dict)) {
        if (current[name] === CAPABILITY_STATE.DISABLED && state === CAPABILITY_STATE.ON) {
          throw new KalturaError({ type: 'about:blank', title: 'capability vetoed', code: 'capability_vetoed', detail: `intellects.setCapabilities: "${name}" is stored 'disabled'. Re-enabling is refused by an SDK convenience guard — pass {force:true} to override.` });
        }
      }
    }
    body.capabilities = mergeCapabilityWrite(current, dict);
    const result = (await this._.genie('v1/intellect/update', body, ks)).data;
    return { capabilities: body.capabilities, result, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.update', scope: `configId:${configId}`, readModifyWrite: true }) };
  }

  /**
   * Resolve the auditable 15-name capability policy with the exact server
   * precedence (DISABLED veto > request > partner_config > env > default). READ.
   * Reads the stored dict as the `partner_config` layer; `env` defaults to the
   * documented snapshot ({@link CAPABILITY_DEFAULTS}). `use_web_search` is
   * marked `inferred` (the resolver cannot see `web_search_config`).
   *
   * ⚠️ SHAPE: the 15 names are NESTED under `.capabilities`, NOT top-level —
   * `Object.keys(result).length === 2` (`capabilities` + `_meta`). Read a single
   * capability via `result.capabilities.<name>.state`.
   *
   * @example <caption>Read the resolved avatar state + provenance</caption>
   * const r = await k.intellects.resolveCapabilities(configId, adminKs, {
   *   request: { use_web_search: 'off' },  // per-request override layer
   * });
   * r.capabilities.avatar.state;        // 'on' | 'off' | 'disabled'
   * r.capabilities.avatar.resolvedFrom; // 'request'|'partner_config'|'env'|'default'|'disabled_veto'|'web_search_config'
   * r.capabilities.use_web_search.inferred; // true — best-effort (resolver can't read web_search_config)
   *
   * @param {number} configId @param {string} ks (admin) @param {{request?:Record<string,'on'|'off'|'disabled'>}} [opts]
   * @returns {Promise<{capabilities:Record<string,{state:'on'|'off'|'disabled', resolvedFrom:'request'|'partner_config'|'env'|'default'|'disabled_veto'|'web_search_config', vetoed:boolean, inferred?:boolean, layers:object}>, _meta:object}>}
   */
  async resolveCapabilities(configId, ks, opts = {}) {
    const { capabilities } = await this.getCapabilities(configId, ks);
    const resolved = resolveCapabilities({ partnerConfig: capabilities, request: opts.request, partnerId: this._.partnerId });
    return resolved;
  }

  // ─────────────────────────── client variables gate ───────────────────────────

  /**
   * Toggle `allow_client_variables` — the gate on per-request `request_vars`
   * (when off, a converse call sending `request_vars` gets HTTP 403). WRITE —
   * idempotent. NOTE: Genie `v1/intellect/update` is a `model_fields_set` PATCH
   * that PRESERVES omitted top-level fields, but this defensively re-sends the
   * WHOLE config (matching `Knowledge.setEnabled`) so a partial body can never
   * reset status / wipe siblings. @param {number} configId @param {boolean} enabled @param {string} ks (admin)
   */
  async setClientVariablesEnabled(configId, enabled, ks) {
    this._.assertAdmin(ks, 'intellects.setClientVariablesEnabled');
    requireInt(configId, 'intellects.setClientVariablesEnabled configId');
    if (typeof enabled !== 'boolean') throw badReq('intellects.setClientVariablesEnabled needs a boolean.');
    const { body } = await this._rmwBody(configId, ks, 'intellects.setClientVariablesEnabled');
    body.allow_client_variables = enabled;
    return (await this._.genie('v1/intellect/update', body, ks)).data;
  }

  // ─────────────────────────── prompt authoring ───────────────────────────

  /**
   * Replace the `prompts[]` list (full-replace) and optionally `base_directive`/
   * `glossary`/`status`. WRITE — idempotent (read-merge-write the whole config so
   * unrelated fields are preserved). Lints by default (`lint !== false`): an
   * ERROR finding aborts the write with `code:'prompt_lint_failed'`; WARNINGS
   * (e.g. an unknown `{{var}}`) do NOT block unless you pass `{lint:'strict'}`.
   * Writes ONLY the DTO-allowed prompt fields. @param {number} configId @param {Array<object>} prompts @param {string} ks (admin)
   * @param {{baseDirective?:string, glossary?:string, status?:number, knownVars?:string[], lint?:boolean|'strict'}} [opts]
   */
  async setPrompts(configId, prompts, ks, opts = {}) {
    this._.assertAdmin(ks, 'intellects.setPrompts');
    requireInt(configId, 'intellects.setPrompts configId');
    if (!Array.isArray(prompts)) throw badReq('intellects.setPrompts needs an array of prompt blocks (full-replace list).');
    const doLint = opts.lint !== false;
    let lint;
    if (doLint) {
      lint = lintPrompts(prompts, { knownVars: opts.knownVars });
      if (opts.glossary !== undefined) {
        const g = lintGlossary(opts.glossary, { knownVars: opts.knownVars });
        for (const f of g.findings) lint.findings.push(f);
        if (!g.ok) lint.ok = false;
      }
      const errors = lint.findings.filter((f) => f.severity === 'error');
      const warns = lint.findings.filter((f) => f.severity === 'warning');
      if (errors.length || (opts.lint === 'strict' && warns.length)) {
        throw new KalturaError({ type: 'about:blank', title: 'prompt lint failed', code: 'prompt_lint_failed', detail: `intellects.setPrompts: ${errors.length} error(s)${opts.lint === 'strict' ? ` + ${warns.length} warning(s) (strict)` : ''} — fix before publishing.`, body: { findings: lint.findings } });
      }
    }
    const { body } = await this._rmwBody(configId, ks, 'intellects.setPrompts');
    body.prompts = prompts;
    if (opts.baseDirective !== undefined) body.base_directive = opts.baseDirective;
    if (opts.glossary !== undefined) body.glossary = opts.glossary;
    if (opts.status !== undefined) body.status = opts.status;
    const result = (await this._.genie('v1/intellect/update', body, ks)).data;
    return { result, lint, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.update', scope: `configId:${configId}`, readModifyWrite: true }) };
  }

  /**
   * CLIENT-SIDE preview of the author layer of the system prompt (prompts[] +
   * base_directive + glossary), interpolated with `requestVars`. READ — fetches
   * the current intellect (unless full drafts are supplied) and assembles a
   * `client-side-replica` via the prompt-lint module. HONEST: this reproduces
   * ONLY the author layer — server-injected capability-conditional Jinja blocks
   * and the built-in default directive are NOT reproduced (see prompt-lint
   * `assembleSystemPrompt`). `sys__*` values are a SIMULATION of what the server
   * sets per turn.
   *
   * The rendered prompt is the `text` field; `_meta.renderer` is always
   * `'client-side-replica'` and `_meta.rendererBasis` names the server function
   * this mirrors (the author layer only — NOT byte-exact with the live prompt).
   *
   * HARDENING: a reference to a known reserved variable
   * (`sys__thread_id`/`sys__message_id`/`sys__user_id`/`sys__user_message`/
   * `sys__ks`/`sys__is_new_thread`, a `sys__user_obj.*` attribute, or a
   * `secrets.*` name) with no value in `requestVars` is
   * flagged in `warnings[]` instead of silently rendering as empty/literal.
   * `warnings` is present ONLY when non-empty — a fully-resolved preview's
   * return shape is unchanged from before this hardening.
   * @param {number} configId @param {string} ks (admin)
   * @param {{requestVars?:Record<string,unknown>, draftPrompts?:Array<object>, draftBaseDirective?:string, draftGlossary?:string}} [opts]
   * @returns {Promise<{text:string, skippedKeys:string[], usedDefaultDirective:boolean, unresolvedVariables:string[], warnings?:Array<{severity:string,code:string,message:string}>, _meta:{renderer:string, rendererBasis:string}&object}>}
   */
  async previewPrompt(configId, ks, opts = {}) {
    this._.assertAdmin(ks, 'intellects.previewPrompt');
    requireInt(configId, 'intellects.previewPrompt configId');
    let prompts = opts.draftPrompts;
    let baseDirective = opts.draftBaseDirective;
    let glossary = opts.draftGlossary;
    if (prompts === undefined || baseDirective === undefined || glossary === undefined) {
      const cur = (await this._.genie('v1/intellect/get', { id: configId }, ks)).data || {};
      if (prompts === undefined) prompts = Array.isArray(cur.prompts) ? cur.prompts : [];
      if (baseDirective === undefined) baseDirective = typeof cur.base_directive === 'string' ? cur.base_directive : '';
      if (glossary === undefined) glossary = typeof cur.glossary === 'string' ? cur.glossary : '';
    }
    return assembleSystemPrompt({ prompts, baseDirective, glossary, requestVars: opts.requestVars });
  }

  /**
   * Capture a CLIENT-SIDE snapshot of the editable prompt layer of an intellect
   * (prompts + base_directive + glossary + capabilities + status). READ.
   *
   * HONEST: the SERVER has NO versioning — this is a `storage:'client-side'`
   * value you persist yourself (return value). Secrets are already `'***'`-masked
   * by the read façade so a snapshot is safe to store; {@link restore} skips
   * secrets + server-managed fields. @param {number} configId @param {string} ks (admin) @param {{label?:string}} [opts]
   */
  async snapshot(configId, ks, opts = {}) {
    this._.assertAdmin(ks, 'intellects.snapshot');
    requireInt(configId, 'intellects.snapshot configId');
    const cur = (await this._.genie('v1/intellect/get', { id: configId }, ks)).data || {};
    return {
      configId,
      label: typeof opts.label === 'string' ? opts.label : undefined,
      type: cur.type || 'internal',
      fields: {
        prompts: Array.isArray(cur.prompts) ? cur.prompts : [],
        base_directive: typeof cur.base_directive === 'string' ? cur.base_directive : '',
        glossary: typeof cur.glossary === 'string' ? cur.glossary : '',
        capabilities: (cur.capabilities && typeof cur.capabilities === 'object') ? cur.capabilities : {},
        status: cur.status ?? 2,
      },
      _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.get', scope: `configId:${configId}`, storage: 'client-side', note: 'Server has no versioning — persist this snapshot yourself; secrets are masked and excluded from restore.' }),
    };
  }

  /**
   * Restore a {@link snapshot} (WRITE — idempotent, read-merge-write). Writes
   * back ONLY the safe author-layer fields (prompts/base_directive/glossary/
   * capabilities/status) — SKIPS secrets + server-managed fields. Lints by
   * default like {@link setPrompts}. @param {object} snapshot @param {string} ks (admin) @param {{fields?:string[], lint?:boolean|'strict'}} [opts]
   */
  async restore(snapshot, ks, opts = {}) {
    this._.assertAdmin(ks, 'intellects.restore');
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.configId !== 'number' || !snapshot.fields) {
      throw badReq('intellects.restore needs a snapshot from intellects.snapshot().');
    }
    const allowed = ['prompts', 'base_directive', 'glossary', 'capabilities', 'status'];
    const want = Array.isArray(opts.fields) ? opts.fields.filter((f) => allowed.includes(f)) : allowed;
    const skipped = allowed.filter((f) => !want.includes(f));
    if (want.includes('prompts')) {
      return this.setPrompts(snapshot.configId, snapshot.fields.prompts, ks, {
        baseDirective: want.includes('base_directive') ? snapshot.fields.base_directive : undefined,
        glossary: want.includes('glossary') ? snapshot.fields.glossary : undefined,
        status: want.includes('status') ? snapshot.fields.status : undefined,
        lint: opts.lint,
      }).then((r) => ({ ...r, written: want, skipped, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.update', scope: `configId:${snapshot.configId}`, restoredFrom: 'client-side snapshot', skipped }) }));
    }
    const { body } = await this._rmwBody(snapshot.configId, ks, 'intellects.restore');
    for (const f of want) body[f] = snapshot.fields[f];
    const result = (await this._.genie('v1/intellect/update', body, ks)).data;
    return { result, written: want, skipped, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.update', scope: `configId:${snapshot.configId}`, restoredFrom: 'client-side snapshot', skipped }) };
  }

  /**
   * Diff two {@link snapshot}s (PURE — no network). Reports per-field
   * added/removed/modified for prompts (by `key`), and changed scalar/dict
   * fields. @param {object} a @param {object} b
   */
  diffSnapshots(a, b) {
    const fa = (a && a.fields) || {};
    const fb = (b && b.fields) || {};
    const byKey = (list) => { const m = new Map(); for (const p of (Array.isArray(list) ? list : [])) if (p && typeof p.key === 'string') m.set(p.key, p); return m; };
    const ma = byKey(fa.prompts);
    const mb = byKey(fb.prompts);
    const added = [...mb.keys()].filter((k) => !ma.has(k));
    const removed = [...ma.keys()].filter((k) => !mb.has(k));
    const modified = [...mb.keys()].filter((k) => ma.has(k) && JSON.stringify(ma.get(k)) !== JSON.stringify(mb.get(k)));
    const orderA = [...ma.keys()];
    const orderB = [...mb.keys()];
    const reordered = orderA.length === orderB.length && orderA.join(',') !== orderB.join(',') && [...new Set([...orderA, ...orderB])].every((k) => ma.has(k) === mb.has(k));
    const scalarChanged = ['base_directive', 'glossary', 'status'].filter((f) => JSON.stringify(fa[f]) !== JSON.stringify(fb[f]));
    const capabilitiesChanged = JSON.stringify(fa.capabilities || {}) !== JSON.stringify(fb.capabilities || {});
    return {
      prompts: { added, removed, modified, reordered },
      scalarChanged,
      capabilitiesChanged,
      _meta: meta({ partnerId: this._.partnerId, source: 'sdk/intellect.diffSnapshots', scope: 'client-side', storage: 'client-side' }),
    };
  }

  // ─────────────────────────── brain config (partner-config routed, probe-gated) ───────────────────────────

  /**
   * Set the brain config (models + rate limits + the UNVERIFIED Class-B subset)
   * via Genie `partner-config/update` (NOT the intellect DTO — these fields are
   * NOT in the intellect allow-list). WRITE, idempotent (a merging PATCH).
   *
   * GATED + HONEST (mirrors `Knowledge.linkCategory` / `linkAvailable`): on the
   * current deployment `partner-config/update` 403s for a partner admin KS
   * (see API-REFERENCE.md § Configure the Brain). This method PROBES {@link brainConfigAvailable}
   * first and, when the door is closed, returns `{applied:false, reason}` WITHOUT
   * throwing or writing — it NEVER fakes success. `applied` (on success) lists
   * the snake keys SENT, not confirmed persisted — confirm with
   * {@link getBrainConfig}, and the Class-B subset (agentAvatarLlm/runQuotaCheck/
   * webSearch) is UNVERIFIED until a live round-trip proves persistence.
   * @param {number} configId @param {object} cfg @param {string} ks (admin)
   * @returns {Promise<{applied:boolean, sentKeys?:string[], reason?:string, code?:string, result?:any, _meta:object}>}
   */
  async setBrainConfig(configId, cfg, ks) {
    this._.assertAdmin(ks, 'intellects.setBrainConfig');
    requireInt(configId, 'intellects.setBrainConfig configId');
    const { config, applied } = buildBrainConfigPatch(cfg); // throws bad_request BEFORE any network call
    const probe = await this.brainConfigAvailable(ks);
    if (!probe.available) {
      return { applied: false, code: probe.code, reason: probe.reason, _meta: meta({ partnerId: this._.partnerId, source: 'genie/partner-config.update', scope: `configId:${configId}`, deploymentGated: true }) };
    }
    try {
      const result = (await this._.genie('partner-config/update', { id: configId, config }, ks)).data;
      return {
        applied: true,
        sentKeys: applied,
        result,
        _meta: meta({ partnerId: this._.partnerId, source: 'genie/partner-config.update', scope: `configId:${configId}`, note: 'sentKeys lists what was SENT, not confirmed persisted; Class-B (agent_avatar_llm/run_quota_check/web_search_config) is UNVERIFIED — confirm with getBrainConfig.' }),
      };
    } catch (e) {
      // The probe (a READ on partner-config/get) can succeed while the WRITE is still
      // privilege-gated (GET-200/UPDATE-403). Surface that honestly — same {applied:false}
      // receipt as Knowledge.linkCategory — rather than throwing a raw 403 (see API-REFERENCE.md § Configure the Brain).
      if (e instanceof KalturaError && (e.status === 403 || e.status === 404)) {
        const { code, reason } = classifyPartnerConfigError(e);
        return {
          applied: false,
          code,
          reason,
          _meta: meta({ partnerId: this._.partnerId, source: 'genie/partner-config.update', scope: `configId:${configId}`, deploymentGated: true }),
        };
      }
      throw e;
    }
  }

  /**
   * Read the brain config from `partner-config/get` (NOT `intellects.get` — the
   * intellect read DTO does not expose these fields, so reading via the intellect
   * surface would falsely report persisted values as unset). READ. Degrades
   * gracefully when `web_search_config` is absent (does not silently predict
   * off). Surfaces `unsetUseDefault[]` (the keys not present → server falls back
   * to genie_settings defaults). @param {number} configId @param {string} ks (admin)
   * @returns {Promise<{brainConfig:object, unsetUseDefault:string[], _meta:object}>}
   */
  async getBrainConfig(configId, ks) {
    this._.assertAdmin(ks, 'intellects.getBrainConfig');
    requireInt(configId, 'intellects.getBrainConfig configId');
    const pc = (await this._.genie('partner-config/get', { id: configId }, ks)).data || {};
    const cfg = (pc.config && typeof pc.config === 'object') ? pc.config : pc;
    const KEYS = ['agent_llm', 'agent_fast_llm', 'agent_avatar_llm', 'rate_limit_per_minute', 'rate_limit_per_hour', 'anonymous_rate_limit_per_minute', 'anonymous_rate_limit_per_hour', 'run_quota_check', 'web_search_config'];
    /** @type {Record<string,unknown>} */
    const brainConfig = {};
    const unsetUseDefault = [];
    for (const k of KEYS) {
      if (cfg[k] !== undefined && cfg[k] !== null) brainConfig[k] = cfg[k];
      else unsetUseDefault.push(k);
    }
    return { brainConfig, unsetUseDefault, _meta: meta({ partnerId: this._.partnerId, source: 'genie/partner-config.get', scope: `configId:${configId}`, note: 'Read from partner-config/get (intellect read DTO does not expose these). Absent keys fall back to genie_settings defaults at runtime.' }) };
  }

  /**
   * Probe whether the partner-config plane is REACHABLE on this deployment, via a
   * READ (`partner-config/get`). READ — no state change. Mirrors
   * `Knowledge.linkAvailable` (shares its classifier — see `partner-config-probe.js`):
   * a 403 surfaces the deployment gate, a 404 means not-deployed (see
   * API-REFERENCE.md § Configure the Brain). NOTE: a READ-200 confirms the route
   * is reachable, NOT that the WRITE (`partner-config/update`) is privileged —
   * some deployments allow the GET but 403 the UPDATE. {@link setBrainConfig}
   * therefore ALSO catches a write 403/404 and returns the same `{applied:false}`
   * receipt, so this probe being optimistic never produces a fake success. NEVER
   * fakes success. @param {string} ks (admin)
   * @returns {Promise<{available:boolean, reason:string, code?:string}>}
   */
  async brainConfigAvailable(ks) {
    this._.assertAdmin(ks, 'intellects.brainConfigAvailable');
    return probePartnerConfigRoute(this._, ks, 'partner-config route reachable; brain-config round-trip is best-effort, confirm with getBrainConfig');
  }

  /** Delete an intellect. WRITE — DESTRUCTIVE (no cascade). Returns null on success. @param {number} id @param {string} ks @param {{confirmPermanent:boolean}} confirm */
  async delete(id, ks, confirm) {
    this._.assertAdmin(ks, 'intellects.delete');
    requireInt(id, 'intellects.delete id');
    requireConfirm(confirm, 'intellects.delete', String(id));
    return (await this._.genie('v1/intellect/delete', { id }, ks)).data;
  }

}
