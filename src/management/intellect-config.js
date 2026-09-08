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
 *               CRUD (`add`/`get`/`list`/`update`/`remove`, see
 *               API-REFERENCE.md § Skills). This facade's `setSkillIds` only writes the INTELLECT-side
 *               reference list (`{id, mode, condition?}` entries, `mode` one of
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
 * The writable surface is exactly {@link EDITABLE_FIELDS}. `patch()` rejects any
 * other key with a typed `bad_request` before the network call, and `type` is
 * immutable.
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
 * Every top-level intellect field a partner admin KS can write through
 * `v1/intellect/update`. This is the whole writable surface: `patch()` rejects
 * any other key before the network call. `knowledge_ids`, `tool_ids`,
 * `skill_ids` and `thread_start_tools` are plain reference lists (the tool,
 * skill and knowledge BODIES live on their own resources).
 * @type {readonly string[]}
 */
export const EDITABLE_FIELDS = Object.freeze([
  'prompts', 'base_directive', 'glossary', 'capabilities', 'tool_ids',
  'secrets', 'user_properties_forms', 'mcp_servers', 'allow_client_variables',
  'knowledge_ids', 'skill_ids', 'thread_start_tools', 'avatar_summary_config',
  'force_language', 'opening_phrase', 'model_configuration',
  'name', 'description', 'tags', 'status',
]);
const EDITABLE_SET = new Set(EDITABLE_FIELDS);

/**
 * The closed set of native `Skill` attach modes (`skill_ids[].mode`).
 * `preloaded` puts the skill's instructions in the system prompt on every turn.
 * `adhoc` exposes the skill as a tool the brain loads on demand and does not
 * remember. `adhoc-save` is `adhoc` plus auto-load on later turns once used.
 * @type {ReadonlyArray<'adhoc'|'adhoc-save'|'preloaded'>}
 */
export const SKILL_MODES = Object.freeze(['adhoc', 'adhoc-save', 'preloaded']);

/**
 * The closed set of `model_configuration.model_id` values. `us.`/`eu.` prefixes
 * pick the Claude region; Gemini ids are global.
 * @type {readonly string[]}
 */
export const MODEL_IDS = Object.freeze([
  'us.anthropic.claude-sonnet-4-20250514-v1:0',
  'eu.anthropic.claude-sonnet-4-20250514-v1:0',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
]);

/**
 * The closed set of `model_configuration.thinking_level` values. Gemini only;
 * Claude models ignore it. Unset means thinking off (except when
 * `avatar_show_content` is on, where the backend defaults it to `low`).
 * @type {ReadonlyArray<'low'|'high'>}
 */
export const THINKING_LEVELS = Object.freeze(['low', 'high']);

/**
 * The closed set of `avatar_summary_config.content_type` values: how the client
 * should render the end-of-session summary. `text` is Markdown.
 * @type {ReadonlyArray<'text'|'html'|'html_with_js'>}
 */
export const SUMMARY_CONTENT_TYPES = Object.freeze(['text', 'html', 'html_with_js']);

const MODEL_CONFIGURATION_KEYS = Object.freeze(['model_id', 'max_output_tokens', 'thinking_level', 'temperature']);
const AVATAR_SUMMARY_CONFIG_KEYS = Object.freeze(['prompt', 'analysis', 'template', 'content_type']);
// The identifier and the optional tail cannot overlap (the tail must start with a
// non-identifier char), so the match is linear in the template length.
const TEMPLATE_VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)(?:[^A-Za-z0-9_}][^}]*)?\}\}/g;

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
   * `patchOrFn` may set any {@link EDITABLE_FIELDS} top-level key. Any other
   * key in the patch is REJECTED with a typed `bad_request` BEFORE any write.
   * `external` intellects are rejected (they have no editable brain config).
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
    // Allowlist: only EDITABLE_FIELDS (plus the immutable `type`, checked below) may be sent.
    for (const k of Object.keys(resolved)) {
      if (k !== 'type' && !EDITABLE_SET.has(k)) {
        throw bad(`intellectConfig.patch: "${k}" is not an editable intellect field. Editable: ${EDITABLE_FIELDS.join(', ')}.`);
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
   * then pass its `id` here. Pass `[]` to detach every skill. An optional
   * `condition` is a Jinja2 expression over thread variables (for example
   * `sys__avatar_enabled`); the skill is active only when it is truthy.
   * @param {number} configId @param {Array<{id:string, mode:'adhoc'|'adhoc-save'|'preloaded', condition?:string}>} skillIds @param {string} ks (admin)
   * @returns {Promise<{applied:boolean, result?:any, sent?:object, _meta:object}>}
   */
  async setSkillIds(configId, skillIds, ks) {
    this._.assertAdmin(ks, 'intellectConfig.setSkillIds');
    requireInt(configId, 'intellectConfig.setSkillIds configId');
    if (!Array.isArray(skillIds)) throw bad('intellectConfig.setSkillIds needs an array of {id, mode, condition?} entries.');
    for (const entry of skillIds) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) {
        throw bad('intellectConfig.setSkillIds: each entry needs a non-empty string id (the Skill entity\'s uuid).');
      }
      if (!SKILL_MODES.includes(entry.mode)) {
        throw bad(`intellectConfig.setSkillIds: entry.mode must be one of ${SKILL_MODES.join('/')}, got ${JSON.stringify(entry.mode)}.`);
      }
      if (entry.condition !== undefined && (typeof entry.condition !== 'string' || !entry.condition.trim())) {
        throw bad(`intellectConfig.setSkillIds: entry.condition must be a non-empty Jinja2 expression string when present, got ${JSON.stringify(entry.condition)}.`);
      }
      for (const k of Object.keys(entry)) {
        if (k !== 'id' && k !== 'mode' && k !== 'condition') {
          throw bad(`intellectConfig.setSkillIds: unknown entry key "${k}". Allowed: id, mode, condition.`);
        }
      }
    }
    const { result, sent } = await this.patch(configId, { skill_ids: skillIds }, ks);
    return { applied: true, result, sent, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.skill_ids', scope: `configId:${configId}` }) };
  }

  // ─────────────────────────── Start-up tools (thread_start_tools) ───────────────────────────

  /**
   * Set `thread_start_tools`: tool ids the backend runs in order when a new
   * thread starts, before the first user turn (chat and avatar paths alike).
   * Only `api` and `code` tools run (other types are skipped server-side); an
   * `api` tool with `wait_for_response` is awaited, everything else is
   * fire-and-forget, and a failing tool does not fail the conversation. The call
   * is server-side only: it does not appear as a `tool` segment in the stream.
   * The backend stores unknown ids without complaint, so check them against
   * `mgmt.tools.list` yourself. WRITE, idempotent. Pass `[]` to clear.
   * @param {number} configId @param {string[]} toolIds @param {string} ks (admin)
   * @returns {Promise<{applied:boolean, result?:any, sent?:object, _meta:object}>}
   */
  async setThreadStartTools(configId, toolIds, ks) {
    this._.assertAdmin(ks, 'intellectConfig.setThreadStartTools');
    requireInt(configId, 'intellectConfig.setThreadStartTools configId');
    if (!Array.isArray(toolIds) || toolIds.some((id) => typeof id !== 'string' || !id)) {
      throw bad('intellectConfig.setThreadStartTools needs an array of non-empty string Tool ids.');
    }
    if (new Set(toolIds).size !== toolIds.length) {
      throw bad('intellectConfig.setThreadStartTools: tool ids must be unique.');
    }
    const { result, sent } = await this.patch(configId, { thread_start_tools: toolIds }, ks);
    return { applied: true, result, sent, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.thread_start_tools', scope: `configId:${configId}` }) };
  }

  // ─────────────────────────── Model configuration ───────────────────────────

  /**
   * Set `model_configuration` (the chat model and its sampling limits). Every
   * key is optional; `null` restores the backend defaults. Validated
   * client-side: `model_id` must be in {@link MODEL_IDS}, `thinking_level` in
   * {@link THINKING_LEVELS} (Gemini only; Claude ignores it), `max_output_tokens`
   * a positive integer, `temperature` a number in [0, 1] (Claude sampling
   * temperature; Gemini applies it as top_p). Unknown keys are rejected.
   * With the `avatar_show_content` capability on, the backend fills unset
   * `thinking_level` with `low` and `max_output_tokens` with 4096.
   * WRITE, idempotent.
   * @param {number} configId
   * @param {{model_id?:string, max_output_tokens?:number, thinking_level?:'low'|'high', temperature?:number}|null} config
   * @param {string} ks (admin)
   * @returns {Promise<{applied:boolean, result?:any, sent?:object, _meta:object}>}
   */
  async setModelConfiguration(configId, config, ks) {
    this._.assertAdmin(ks, 'intellectConfig.setModelConfiguration');
    requireInt(configId, 'intellectConfig.setModelConfiguration configId');
    if (config !== null) {
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw bad('intellectConfig.setModelConfiguration needs a { model_id?, max_output_tokens?, thinking_level?, temperature? } object or null.');
      }
      for (const k of Object.keys(config)) {
        if (!MODEL_CONFIGURATION_KEYS.includes(k)) {
          throw bad(`intellectConfig.setModelConfiguration: unknown key "${k}". Allowed: ${MODEL_CONFIGURATION_KEYS.join(', ')}.`);
        }
      }
      if (config.model_id !== undefined && !MODEL_IDS.includes(config.model_id)) {
        throw bad(`intellectConfig.setModelConfiguration: model_id must be one of ${MODEL_IDS.join(', ')}, got ${JSON.stringify(config.model_id)}.`);
      }
      if (config.max_output_tokens !== undefined && (!Number.isInteger(config.max_output_tokens) || config.max_output_tokens <= 0)) {
        throw bad(`intellectConfig.setModelConfiguration: max_output_tokens must be a positive integer, got ${JSON.stringify(config.max_output_tokens)}.`);
      }
      if (config.thinking_level !== undefined && !THINKING_LEVELS.includes(config.thinking_level)) {
        throw bad(`intellectConfig.setModelConfiguration: thinking_level must be one of ${THINKING_LEVELS.join('/')}, got ${JSON.stringify(config.thinking_level)}.`);
      }
      if (config.temperature !== undefined && (typeof config.temperature !== 'number' || Number.isNaN(config.temperature) || config.temperature < 0 || config.temperature > 1)) {
        throw bad(`intellectConfig.setModelConfiguration: temperature must be a number between 0 and 1, got ${JSON.stringify(config.temperature)}.`);
      }
    }
    const { result, sent } = await this.patch(configId, { model_configuration: config }, ks);
    return { applied: true, result, sent, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.model_configuration', scope: `configId:${configId}` }) };
  }

  // ─────────────────────────── Opening phrase ───────────────────────────

  /**
   * Set `opening_phrase`: a Jinja2 template over `request_vars` (for example
   * `Hello {{ user_name }}, how can I help you today?`) that the backend renders
   * and speaks when an avatar WebSocket session starts. It overrides the opening
   * phrase the client sends at init; the rendered value comes back in the init
   * response and is stored on the thread as an `opening` message. `null` clears
   * it (the client-sent phrase applies again). WRITE, idempotent.
   * @param {number} configId @param {string|null} phrase @param {string} ks (admin)
   * @returns {Promise<{applied:boolean, result?:any, sent?:object, _meta:object}>}
   */
  async setOpeningPhrase(configId, phrase, ks) {
    this._.assertAdmin(ks, 'intellectConfig.setOpeningPhrase');
    requireInt(configId, 'intellectConfig.setOpeningPhrase configId');
    if (phrase !== null && (typeof phrase !== 'string' || !phrase.trim())) {
      throw bad('intellectConfig.setOpeningPhrase needs a non-empty string (Jinja2 over request_vars) or null to clear it. Pass null, not "".');
    }
    const { result, sent } = await this.patch(configId, { opening_phrase: phrase }, ks);
    return { applied: true, result, sent, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.opening_phrase', scope: `configId:${configId}` }) };
  }

  // ─────────────────────────── Avatar session summary ───────────────────────────

  /**
   * Set `avatar_summary_config`: how the backend builds the end-of-session
   * summary for avatar sessions. Every key is optional; `null` restores the
   * defaults (`analysis: { summary }`, `template: '{{ summary }}'`,
   * `content_type: 'text'`). `prompt` adds rules for the summary model;
   * `analysis` maps output keys to descriptions; `template` is Jinja2 over the
   * `analysis` keys; `content_type` is one of {@link SUMMARY_CONTENT_TYPES}.
   * Every `{{ key }}` in `template` must be an `analysis` key (or `summary` when
   * `analysis` is unset). The summary reaches the client as a `summary` message
   * and is skipped when the thread has no human messages. WRITE, idempotent.
   * @param {number} configId
   * @param {{prompt?:string, analysis?:Record<string,string>, template?:string, content_type?:'text'|'html'|'html_with_js'}|null} config
   * @param {string} ks (admin)
   * @returns {Promise<{applied:boolean, result?:any, sent?:object, _meta:object}>}
   */
  async setAvatarSummaryConfig(configId, config, ks) {
    this._.assertAdmin(ks, 'intellectConfig.setAvatarSummaryConfig');
    requireInt(configId, 'intellectConfig.setAvatarSummaryConfig configId');
    if (config !== null) {
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw bad('intellectConfig.setAvatarSummaryConfig needs a { prompt?, analysis?, template?, content_type? } object or null.');
      }
      for (const k of Object.keys(config)) {
        if (!AVATAR_SUMMARY_CONFIG_KEYS.includes(k)) {
          throw bad(`intellectConfig.setAvatarSummaryConfig: unknown key "${k}". Allowed: ${AVATAR_SUMMARY_CONFIG_KEYS.join(', ')}.`);
        }
      }
      if (config.prompt !== undefined && (typeof config.prompt !== 'string' || !config.prompt.trim())) {
        throw bad('intellectConfig.setAvatarSummaryConfig: prompt must be a non-empty string when present.');
      }
      if (config.content_type !== undefined && !SUMMARY_CONTENT_TYPES.includes(config.content_type)) {
        throw bad(`intellectConfig.setAvatarSummaryConfig: content_type must be one of ${SUMMARY_CONTENT_TYPES.join('/')}, got ${JSON.stringify(config.content_type)}.`);
      }
      let analysisKeys = ['summary'];
      if (config.analysis !== undefined) {
        const a = config.analysis;
        if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).length === 0) {
          throw bad('intellectConfig.setAvatarSummaryConfig: analysis must be a non-empty { key: description } object.');
        }
        for (const [k, v] of Object.entries(a)) {
          if (!k.trim() || typeof v !== 'string' || !v.trim()) {
            throw bad(`intellectConfig.setAvatarSummaryConfig: analysis["${k}"] must be a non-empty string description.`);
          }
        }
        analysisKeys = Object.keys(a);
      }
      if (config.template !== undefined) {
        if (typeof config.template !== 'string' || !config.template.trim()) {
          throw bad('intellectConfig.setAvatarSummaryConfig: template must be a non-empty Jinja2 string when present.');
        }
        for (const m of config.template.matchAll(TEMPLATE_VAR_RE)) {
          if (!analysisKeys.includes(m[1])) {
            throw bad(`intellectConfig.setAvatarSummaryConfig: template references "${m[1]}" which is not an analysis key (${analysisKeys.join(', ')}).`);
          }
        }
      }
    }
    const { result, sent } = await this.patch(configId, { avatar_summary_config: config }, ks);
    return { applied: true, result, sent, _meta: meta({ partnerId: this._.partnerId, source: 'genie/intellect.avatar_summary_config', scope: `configId:${configId}` }) };
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
   * One-shot read of the whole editable surface: every key in
   * {@link EDITABLE_FIELDS} with its current value (`null` when the server did
   * not echo it), plus `capabilityNames` (every known capability) so a UI can
   * render a full grid. Secrets are names-only. READ, no state change.
   * @param {number} configId @param {string} ks (admin)
   * @returns {Promise<{type:string, editable:Record<string,unknown>, capabilityNames:readonly string[], _meta:object}>}
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
      } else {
        editable[k] = Object.prototype.hasOwnProperty.call(cur, k) ? cur[k] : null;
      }
    }
    return {
      type,
      editable,
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
