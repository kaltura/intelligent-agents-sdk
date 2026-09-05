/**
 * IntellectConfig — the unified, validated facade over the writable `config`
 * surface of an internal intellect. Mounted at `mgmt.intellectConfig`.
 * Genie host, ADMIN token throughout.
 *
 * This facade is the ONE-STOP, merge-safe surface: every editable field gets a
 * typed setter that routes through a single read-merge-write primitive, plus
 * `describe()` (the editable/read-only map for a UI). For the two richest fields
 * there are ALSO dedicated sub-resources with extra operations the facade does
 * not duplicate — prefer those when you need their depth:
 *   - tool_ids → `mgmt.tools` is the SEPARATE, partner-level Tool entity CRUD
 *               (`api`/`csv`/`code` builders, `validate`, `add`/`get`/`list`/
 *               `update`/`remove`). This facade's `setToolIds` only writes the
 *               INTELLECT-side reference list — create/edit the tool bodies
 *               themselves via `mgmt.tools`.
 *   - skill_ids → `mgmt.skills` is the SEPARATE, partner-level Skill entity
 *               CRUD (`add`/`get`/`list`/`remove` — no `update`, see
 *               API-REFERENCE.md § Skills). This facade's `setSkillIds` only writes the INTELLECT-side
 *               reference list (`{id, mode}` pairs, `mode` one of
 *               {@link SKILL_MODES}) — create/edit the skill bodies themselves
 *               via `mgmt.skills`.
 *   - secrets → `mgmt.intellects.secrets` (`set`/`remove`/`listNames`/`has`/`validate`).
 *               The facade's `setSecrets`/`listSecretNames` cover the common cases.
 *
 * The shared primitive is {@link IntellectConfig#patch}: it reads the current
 * intellect, STRIPS server-managed read-only keys, overlays the caller's
 * resolved patch, RE-ASSERTS the `{id, type, status}` triple, and writes the
 * whole thing back via `v1/intellect/update`. patch() and every field setter
 * (`setCapabilities`/`setToolIds`/`setSecrets`/…) route through the SAME
 * exported `stripServerManaged` primitive (in intellect-body.js, re-exported
 * from intellects.js) that `Intellects#_rmwBody` and `Knowledge#setEnabled`
 * (conversations.js) use — the merge logic lives in exactly one place.
 *
 * WHY re-send the whole config? Genie's `v1/intellect/update` is a
 * `model_fields_set` PATCH that PRESERVES omitted TOP-LEVEL fields — but
 * DICT-valued fields (`capabilities`, `secrets`) are FULL-REPLACE sub-dicts: a
 * partial dict drops the siblings it omits. So those dicts are read-merge-written
 * (capabilities via {@link mergeCapabilityWrite}; secrets via the
 * mask-and-keep guard) and the rest is re-sent intact. `tool_ids`/`skill_ids`
 * are plain arrays (not dicts), so `setToolIds`/`setSkillIds` write them
 * directly with no merge step, same as `setKnowledgeIds`.
 *
 * PHANTOM-WRITE DISCIPLINE: `web_search_config`, `run_quota_check`,
 * `agent_avatar_llm`, `avatar_config`, `agent_llm`, `agent_fast_llm`, and rate
 * limits are NOT writable via the public API at all — they appear in
 * `describe().readOnly` with a "server-managed; not writable via the public
 * API" note and have NO setters here.
 */
import { KalturaError } from '../core/errors.js';
import { meta } from '../core/ids.js';
import { requireInt } from './intellect-body.js';
import { validateCapabilities, assertCapability, assertCapabilityState, mergeCapabilityWrite, CAPABILITIES } from './capabilities.js';
import { ARG_TYPES } from './tools.js';
import { MASK, maskExisting } from './secrets.js';

/**
 * The closed set of structured-data-form call stages — WHEN the agent emits the
 * `user_properties_form` (backend enum). `start` asks up front, `middle` after
 * the opening exchange, `end` as the conversation closes.
 * @type {ReadonlyArray<'start'|'middle'|'end'>}
 */
export const CALL_STAGES = Object.freeze(['start', 'middle', 'end']);

/**
 * Fields that exist on the stored `PartnerConfigSchema` and are READ by the
 * runtime but are NOT in EITHER public create/update DTO allow-list — so they
 * are read-only via the public surfaces. The facade exposes them under
 * `describe().readOnly` and provides NO setter (phantom-write discipline).
 * @type {Readonly<Record<string,string>>}
 */
const READ_ONLY_FIELDS = Object.freeze({
  web_search_config: 'web-search parameters — server-managed; not writable via the public API',
  run_quota_check: 'pre-turn quota enforcement — server-managed; not writable via the public API',
  agent_avatar_llm: 'avatar-mode model — server-managed; not writable via the public API',
  agent_llm: 'primary brain model — server-managed; not writable via the public API',
  agent_fast_llm: 'fast/cheap fallback model — server-managed; not writable via the public API',
  rate_limit_per_minute: 'authed rate limit — server-managed; not writable via the public API',
  rate_limit_per_hour: 'authed rate limit — server-managed; not writable via the public API',
  anonymous_rate_limit_per_minute: 'anonymous rate limit — server-managed; not writable via the public API',
  anonymous_rate_limit_per_hour: 'anonymous rate limit — server-managed; not writable via the public API',
  avatar_config: 'live-avatar WebRTC/SRS endpoints — server-managed (overlaid with server defaults at converse time); never your input',
});

/**
 * Top-level fields the public Genie `intellect/*` DTO genuinely WRITES
 * (`CreateIntellect.update_partner_config`): the editable surface this facade's
 * setters target. `knowledge_ids` IS in this allow-list and writes ungated via
 * `create`/`update`/`setKnowledgeIds`. `tool_ids` is likewise a direct, ungated
 * reference-list write (the tool BODIES live on the separate `mgmt.tools`
 * entity, not here).
 * @type {readonly string[]}
 */
const EDITABLE_FIELDS = Object.freeze([
  'prompts', 'base_directive', 'glossary', 'capabilities', 'tool_ids',
  'secrets', 'user_properties_forms', 'mcp_servers', 'allow_client_variables',
  'knowledge_ids', 'skill_ids', 'name', 'description', 'tags', 'status',
]);

/**
 * The closed set of native `Skill` attach modes (`skill_ids[].mode` —
 * any other string 422s "Input should be 'adhoc' or
 * 'preloaded'"). `preloaded` puts the skill's instructions in the system
 * prompt on every turn; `adhoc` makes it available for the brain to pull in
 * only when relevant.
 * @type {ReadonlyArray<'adhoc'|'preloaded'>}
 */
export const SKILL_MODES = Object.freeze(['adhoc', 'preloaded']);

/** @param {string} detail @param {string} [code] */
function bad(detail, code = 'bad_request') {
  return new KalturaError({ type: 'about:blank', title: code.replace(/_/g, ' '), code, detail });
}

export class IntellectConfig {
  /**
   * @param {import('./client.js').Ctx} ctx
   * @param {import('./intellects.js').Intellects} intellects The raw Intellects resource (for delegation of brain config + capability setters).
   */
  constructor(ctx, intellects) {
    this._ = ctx;
    /** @type {import('./intellects.js').Intellects} */
    this._intellects = intellects;
  }

  /**
   * THE shared write primitive. Reads the intellect, strips server-managed
   * read-only keys, applies `patchOrFn` (a partial config object OR a
   * `(current) => partial` function), re-asserts `{id, type, status}`, and
   * writes the whole body via `v1/intellect/update`. WRITE — idempotent.
   *
   * `patchOrFn` may set any {@link EDITABLE_FIELDS} top-level key. Read-only
   * phantom-write fields ({@link READ_ONLY_FIELDS}) in the patch are REJECTED
   * with a typed `bad_request` BEFORE any write (so a caller can't silently
   * no-op against an internal-tooling-only field). `external` intellects are
   * rejected (they have no editable brain config).
   *
   * @param {number} configId
   * @param {Record<string,unknown>|((cur:Record<string,unknown>)=>Record<string,unknown>)} patchOrFn
   * @param {string} ks (admin)
   * @returns {Promise<{result:any, sent:Record<string,unknown>, _meta:object}>}
   */
  async patch(configId, patchOrFn, ks) {
    this._.assertAdmin(ks, 'intellectConfig.patch');
    requireInt(configId, 'intellectConfig.patch configId');
    if (typeof patchOrFn !== 'function' && (!patchOrFn || typeof patchOrFn !== 'object' || Array.isArray(patchOrFn))) {
      throw bad('intellectConfig.patch needs a partial config object or a (current)=>partial function.');
    }
    // Single-sourced read-merge-write: reuse the SAME strip+re-assert primitive the raw
    // Intellects resource uses (Intellects#_rmwBody) so the merge discipline lives in ONE
    // place — reject external, strip id/partner_id/user_id/created_at/updated_at,
    // re-assert {id,type,status}. No duplicated merge logic here.
    const { cur, body: base } = await this._intellects._rmwBody(configId, ks, 'intellectConfig.patch');
    const resolved = typeof patchOrFn === 'function' ? patchOrFn({ ...cur }) : patchOrFn;
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
      throw bad('intellectConfig.patch: the patch function must return a partial config object.');
    }
    // Reject phantom-write fields up-front (never silently no-op).
    for (const k of Object.keys(resolved)) {
      if (Object.prototype.hasOwnProperty.call(READ_ONLY_FIELDS, k)) {
        throw bad(`intellectConfig.patch: "${k}" is read-only via the public DTO — ${READ_ONLY_FIELDS[k]}. There is no setter for it.`);
      }
    }
    // `type` is immutable (not in EDITABLE_FIELDS) — reject a differing value up-front
    // instead of silently overwriting it with `base.type` below, so a caller that mistakenly
    // tries to change it gets a typed error, not a no-op.
    if ('type' in resolved && resolved.type !== base.type) {
      throw bad(`intellectConfig.patch: "type" is immutable (got ${JSON.stringify(resolved.type)}, current is ${JSON.stringify(base.type)}) — an intellect's type cannot be changed via update.`);
    }
    const body = { ...base, ...resolved, id: configId, type: base.type, status: resolved.status ?? base.status };
    const result = (await this._.genie('v1/intellect/update', body, ks)).data;
    return { result, sent: body, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.update', scope: `configId:${configId}`, readModifyWrite: true }) };
  }

  // ─────────────────────────── Capabilities (full-replace dict) ───────────────────────────

  /**
   * Set MANY capabilities at once (read-merge-write the full-replace dict).
   * WRITE — idempotent. Delegates to the validated {@link mergeCapabilityWrite}
   * exactly as `intellects.setCapabilities` does (no duplicated merge logic).
   * @param {number} configId @param {Record<string,'on'|'off'|'disabled'>} dict @param {string} ks (admin)
   */
  async setCapabilities(configId, dict, ks) {
    validateCapabilities(dict, 'intellectConfig.setCapabilities');
    // `cur` is `patch()`'s generic whole-intellect-body param (Record<string,unknown>) —
    // `cur.capabilities` is genuinely unknown to TS here; mergeCapabilityWrite itself
    // validates the value at runtime regardless of this cast.
    return this.patch(configId, (cur) => ({ capabilities: mergeCapabilityWrite(/** @type {Record<string,'on'|'off'|'disabled'>|undefined} */ (cur.capabilities), dict) }), ks);
  }

  /**
   * Set ONE capability by name (read-merge-write). WRITE — idempotent. Mirrors
   * `intellects.setCapability`'s validation; the DISABLED-re-enable convenience
   * guard lives on `intellects.setCapability` — use that when you need to
   * override THAT guard specifically.
   * @param {number} configId @param {string} name @param {'on'|'off'|'disabled'} state @param {string} ks (admin)
   */
  async setCapability(configId, name, state, ks) {
    assertCapability(name, 'intellectConfig.setCapability');
    assertCapabilityState(state, `intellectConfig.setCapability.${name}`);
    // See setCapabilities' comment above — same `cur.capabilities` cast.
    return this.patch(configId, (cur) => ({ capabilities: mergeCapabilityWrite(/** @type {Record<string,'on'|'off'|'disabled'>|undefined} */ (cur.capabilities), { [name]: state }) }), ks);
  }

  // ─────────────────────────── Tool linkage (tool_ids) ───────────────────────────

  /**
   * Set the intellect's `tool_ids` — the list of standalone Tool entities (see
   * `mgmt.tools`) this intellect may call. WRITE — idempotent. `tool_ids` is a
   * direct, ungated reference-list write (like `knowledge_ids`), but
   * UNCAPPED (no maxItems in the DTO). This only edits the reference list — to
   * create/edit a tool BODY, use `mgmt.tools.add`/`update`/`remove` first, then
   * pass its `id` here. Pass `[]` to detach every tool.
   * @param {number} configId @param {string[]} toolIds @param {string} ks (admin)
   * @returns {Promise<{applied:boolean, result?:any, sent?:object, _meta:object}>}
   */
  async setToolIds(configId, toolIds, ks) {
    this._.assertAdmin(ks, 'intellectConfig.setToolIds');
    requireInt(configId, 'intellectConfig.setToolIds configId');
    if (!Array.isArray(toolIds) || toolIds.some((id) => typeof id !== 'string' || !id)) {
      throw bad('intellectConfig.setToolIds needs an array of non-empty string Tool ids.');
    }
    const { result, sent } = await this.patch(configId, { tool_ids: toolIds }, ks);
    return { applied: true, result, sent, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.tool_ids', scope: `configId:${configId}` }) };
  }

  // ─────────────────────────── Skill linkage (skill_ids) ───────────────────────────

  /**
   * Set the intellect's `skill_ids` — the list of standalone Skill entities
   * (see `mgmt.skills`) this intellect may draw on, each with an attach `mode`
   * (see {@link SKILL_MODES}). WRITE — idempotent, UNGATED (direct
   * reference-list write like `tool_ids`/`knowledge_ids` — confirmed via
   * `intellect/add` + `intellect/get` round-trip). This only edits the
   * reference list — create/edit a Skill body via `mgmt.skills.add` first,
   * then pass its `id` here. Pass `[]` to detach every skill.
   * @param {number} configId @param {Array<{id:string, mode:'adhoc'|'preloaded'}>} skillIds @param {string} ks (admin)
   * @returns {Promise<{applied:boolean, result?:any, sent?:object, _meta:object}>}
   */
  async setSkillIds(configId, skillIds, ks) {
    this._.assertAdmin(ks, 'intellectConfig.setSkillIds');
    requireInt(configId, 'intellectConfig.setSkillIds configId');
    if (!Array.isArray(skillIds)) throw bad('intellectConfig.setSkillIds needs an array of {id, mode} entries.');
    for (const entry of skillIds) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) {
        throw bad('intellectConfig.setSkillIds: each entry needs a non-empty string id (the Skill entity\'s uuid).');
      }
      if (!SKILL_MODES.includes(entry.mode)) {
        throw bad(`intellectConfig.setSkillIds: entry.mode must be one of ${SKILL_MODES.join('/')}, got ${JSON.stringify(entry.mode)}.`);
      }
    }
    const { result, sent } = await this.patch(configId, { skill_ids: skillIds }, ks);
    return { applied: true, result, sent, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.skill_ids', scope: `configId:${configId}` }) };
  }

  // ─────────────────────────── Secrets (full-replace dict, mask-and-keep) ───────────────────────────

  /**
   * Set / insert named secrets (read-merge-write the full `config.secrets` dict;
   * prior secrets re-sent as the mask sentinel so the server keeps them). WRITE
   * — idempotent. Rejects a literal `"***"` and empty values. WRITE-ONLY: values
   * are never read back. @param {number} configId @param {Record<string,string>} entries @param {string} ks (admin)
   */
  async setSecrets(configId, entries, ks) {
    this._.assertAdmin(ks, 'intellectConfig.setSecrets');
    requireInt(configId, 'intellectConfig.setSecrets configId');
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length === 0) {
      throw bad('intellectConfig.setSecrets needs a non-empty { name: value } object.');
    }
    for (const [name, v] of Object.entries(entries)) {
      if (typeof name !== 'string' || !name.trim()) throw bad('secret name must be a non-empty string.');
      if (typeof v !== 'string' || v.length === 0) throw bad(`value for "${name}" must be a non-empty string.`);
      if (v === MASK) throw bad(`cannot store the literal "${MASK}" for "${name}" — it is the merge-keep sentinel, not a value.`);
    }
    return this.patch(configId, (cur) => {
      // `cur.secrets` is `unknown` (patch()'s generic whole-body param); the runtime guard
      // just above already proves it's a plain object — secret values are always strings by
      // the stored-secrets contract, which maskExisting itself doesn't re-validate.
      const existing = /** @type {Record<string,string>} */ ((cur.secrets && typeof cur.secrets === 'object' && !Array.isArray(cur.secrets)) ? cur.secrets : {});
      const next = maskExisting(existing); // every prior secret as "***" → server keeps it
      for (const [k, v] of Object.entries(entries)) next[k] = v;
      return { secrets: next };
    }, ks);
  }

  /** List secret NAMES only — values are NEVER returned (write-only contract). READ. @param {number} configId @param {string} ks (admin) @returns {Promise<{names:string[], _meta:object}>} */
  async listSecretNames(configId, ks) {
    this._.assertAdmin(ks, 'intellectConfig.listSecretNames');
    requireInt(configId, 'intellectConfig.listSecretNames configId');
    const cur = (await this._.genie('v1/intellect/get', { id: configId }, ks)).data || {};
    const map = (cur.secrets && typeof cur.secrets === 'object' && !Array.isArray(cur.secrets)) ? cur.secrets : {};
    return { names: Object.keys(map).sort(), _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.secrets', scope: `configId:${configId}` }) };
  }

  // ─────────────────────────── User properties / structured data forms ───────────────────────────

  /**
   * Set `user_properties_forms` — the structured-data forms the agent emits, a
   * LIST of `{call_stage, properties:[{key,type}]}` (one form per stage;
   * the server 422s a bare dict with "Input should be a valid
   * list", and the list shape round-trips on read-back; the server enriches
   * each stored form with default `id`/`title`/`secondary_title` fields on
   * read).
   * WRITE — idempotent. Validates every form (≥1 property, valid stage, valid
   * arg types) before any network call. Accepts a single form object as a
   * convenience — it is wrapped into a one-element list.
   * @param {number} configId
   * @param {object|object[]} forms One form `{callStage, properties:[{key,type}]}` or a list of them.
   * @param {string} ks (admin)
   */
  async setUserPropertiesForms(configId, forms, ks) {
    const wire = buildUserPropertiesForms(forms);
    return this.patch(configId, { user_properties_forms: wire }, ks);
  }

  /** Clear `user_properties_forms`. WRITE — idempotent (sets it to null). @param {number} configId @param {string} ks (admin) */
  async clearUserPropertiesForms(configId, ks) {
    return this.patch(configId, { user_properties_forms: null }, ks);
  }

  // ─────────────────────────── Client variables / metadata / knowledge ───────────────────────────

  /**
   * Toggle `allow_client_variables` (the per-request `request_vars` gate). WRITE
   * — idempotent. Delegates to {@link Intellects#setClientVariablesEnabled} so
   * the merge logic stays in one place. @param {number} configId @param {boolean} enabled @param {string} ks (admin)
   */
  async setAllowClientVariables(configId, enabled, ks) {
    return this._intellects.setClientVariablesEnabled(configId, enabled, ks);
  }

  /**
   * Set top-level row metadata (`name`/`description`/`tags`). WRITE — idempotent.
   * @param {number} configId @param {{name?:string, description?:string, tags?:string[]}} fields @param {string} ks (admin)
   */
  async setMetadata(configId, fields, ks) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw bad('intellectConfig.setMetadata needs a {name?, description?, tags?} object.');
    /** @type {Record<string,unknown>} */
    const patch = {};
    if (fields.name !== undefined) { if (typeof fields.name !== 'string') throw bad('metadata.name must be a string.'); patch.name = fields.name; }
    if (fields.description !== undefined) { if (typeof fields.description !== 'string') throw bad('metadata.description must be a string.'); patch.description = fields.description; }
    if (fields.tags !== undefined) {
      if (!Array.isArray(fields.tags) || fields.tags.some((t) => typeof t !== 'string')) throw bad('metadata.tags must be an array of strings.');
      patch.tags = fields.tags;
    }
    if (Object.keys(patch).length === 0) throw bad('intellectConfig.setMetadata needs at least one of name/description/tags.');
    return this.patch(configId, patch, ks);
  }

  /**
   * Set `knowledge_ids` (≤1, partner-validated). WRITE — idempotent, UNGATED.
   * `knowledge_ids` is in the `v1/intellect/update` DTO allow-list, so it
   * writes through `patch()` directly — no separate linking call, no gate.
   * Mint the record id first with `knowledge.addRecord()`; for a brand-new
   * agent you can also pass `knowledge_ids` straight to {@link Intellects#create}.
   * @param {number} configId @param {number[]} knowledgeIds @param {string} ks (admin)
   * @returns {Promise<{applied:boolean, result?:any, sent?:object, _meta:object}>}
   */
  async setKnowledgeIds(configId, knowledgeIds, ks) {
    this._.assertAdmin(ks, 'intellectConfig.setKnowledgeIds');
    requireInt(configId, 'intellectConfig.setKnowledgeIds configId');
    if (!Array.isArray(knowledgeIds) || knowledgeIds.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 0)) {
      throw bad('intellectConfig.setKnowledgeIds needs an array of non-negative integer knowledge record ids.');
    }
    if (knowledgeIds.length > 1) {
      throw bad('knowledge_ids is capped at ONE record; the server rejects more.');
    }
    const { result, sent } = await this.patch(configId, { knowledge_ids: knowledgeIds }, ks);
    return { applied: true, result, sent, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.knowledge_ids', scope: `configId:${configId}` }) };
  }

  /**
   * Set `mcp_servers` — the intellect's map of MCP servers the brain may call
   * (`{"<name>": {url}}`). WRITE — idempotent, UNGATED (`mcp_servers` is in the
   * `v1/intellect/update` DTO allow-list). The backend
   * NORMALIZES on read: each entry comes back expanded as `{type:'mcp', url,
   * transport:'streamable_http', headers:null, allowed_tools:null,
   * allowed_prompts:null, allowed_resources:null}` — so don't diff your input
   * against a subsequent `get` byte-for-byte. Pass `{}` to clear.
   * @param {number} configId
   * @param {Record<string,{url:string}>} servers Map of server name → `{url}` (http/https).
   * @param {string} ks (admin)
   * @returns {Promise<{applied:boolean, result?:any, sent?:object, _meta:object}>}
   */
  async setMcpServers(configId, servers, ks) {
    this._.assertAdmin(ks, 'intellectConfig.setMcpServers');
    requireInt(configId, 'intellectConfig.setMcpServers configId');
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      throw bad('intellectConfig.setMcpServers needs a map of server name → {url} (pass {} to clear).');
    }
    for (const [name, s] of Object.entries(servers)) {
      if (!s || typeof s !== 'object' || Array.isArray(s) || typeof s.url !== 'string') {
        throw bad(`intellectConfig.setMcpServers["${name}"] must be an object with a string url.`);
      }
      let u;
      try { u = new URL(s.url); } catch { throw bad(`intellectConfig.setMcpServers["${name}"].url is not a valid URL: ${JSON.stringify(s.url)}.`, 'invalid_url'); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw bad(`intellectConfig.setMcpServers["${name}"].url must be http(s), got ${u.protocol}//.`, 'invalid_url');
      }
    }
    const { result, sent } = await this.patch(configId, { mcp_servers: servers }, ks);
    return { applied: true, result, sent, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.mcp_servers', scope: `configId:${configId}` }) };
  }

  // ─────────────────────────── Describe (the full editable surface) ───────────────────────────

  /**
   * One-shot read of the ENTIRE editable surface, partitioned into `editable`
   * (the public-DTO-writable fields, with current values) and `readOnly` (the
   * phantom-write fields + row-managed fields, each with a `note` so a UI can
   * disable the input and explain why). READ — no state change. The capabilities
   * block additionally lists the 15 known names so a UI can render a full grid.
   * @param {number} configId @param {string} ks (admin)
   * @returns {Promise<{type:string, editable:Record<string,unknown>, readOnly:Record<string,{value:unknown, note:string}>, capabilityNames:readonly string[], _meta:object}>}
   */
  async describe(configId, ks) {
    this._.assertAdmin(ks, 'intellectConfig.describe');
    requireInt(configId, 'intellectConfig.describe configId');
    const cur = (await this._.genie('v1/intellect/get', { id: configId }, ks)).data || {};
    const type = cur.type || 'internal';
    /** @type {Record<string,unknown>} */
    const editable = {};
    for (const k of EDITABLE_FIELDS) {
      if (k === 'secrets') {
        // Never echo values — names only (write-only contract).
        const map = (cur.secrets && typeof cur.secrets === 'object' && !Array.isArray(cur.secrets)) ? cur.secrets : {};
        editable.secrets = { names: Object.keys(map).sort() };
      } else if (Object.prototype.hasOwnProperty.call(cur, k)) {
        editable[k] = cur[k];
      }
    }
    /** @type {Record<string,{value:unknown, note:string}>} */
    const readOnly = {};
    for (const [k, note] of Object.entries(READ_ONLY_FIELDS)) {
      readOnly[k] = { value: Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : undefined, note };
    }
    return {
      type,
      editable,
      readOnly,
      capabilityNames: CAPABILITIES,
      _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.get', scope: `configId:${configId}` }),
    };
  }
}

/**
 * Validate + build the `user_properties_forms` wire shape — a LIST of
 * `{call_stage, properties:[{key,type}]}` (the server 422s a bare dict).
 * PURE; throws `bad_request` before any network call. A single
 * form object is accepted and wrapped into a one-element list.
 * @param {object|object[]} forms One `{callStage|call_stage, properties:[{key,type}]}` or a list of them.
 * @returns {{call_stage:string, properties:{key:string,type:string}[]}[]}
 */
export function buildUserPropertiesForms(forms) {
  const list = Array.isArray(forms) ? forms : [forms];
  if (list.length === 0) throw bad('user_properties_forms must be a non-empty list of { callStage, properties:[{key,type}] } (or null via clearUserPropertiesForms).');
  return list.map((form, f) => {
    if (!form || typeof form !== 'object' || Array.isArray(form)) throw bad(`user_properties_forms[${f}] must be an object { callStage, properties:[{key,type}] }.`);
    const stage = form.callStage ?? form.call_stage;
    if (!CALL_STAGES.includes(stage)) throw bad(`user_properties_forms[${f}].callStage must be one of ${CALL_STAGES.join(', ')}, got ${JSON.stringify(stage)}.`);
    const props = form.properties;
    if (!Array.isArray(props) || props.length === 0) throw bad(`user_properties_forms[${f}].properties must be a non-empty array of { key, type }.`);
    /** @type {{key:string,type:string}[]} */
    const properties = props.map((p, i) => {
      if (!p || typeof p !== 'object' || typeof p.key !== 'string' || !p.key.trim()) throw bad(`user_properties_forms[${f}].properties[${i}].key must be a non-empty string.`);
      const t = p.type ?? 'str';
      if (!ARG_TYPES.includes(t)) throw bad(`user_properties_forms[${f}].properties[${i}].type must be one of ${ARG_TYPES.join(', ')}, got ${JSON.stringify(t)}.`);
      return { key: p.key, type: t };
    });
    return { call_stage: stage, properties };
  });
}
