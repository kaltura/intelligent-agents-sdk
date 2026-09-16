/**
 * InsightSettings — reusable, partner-owned definitions of a single insight
 * the agentic backend can extract from a conversation: `{key, title, prompt,
 * valueType, status}`. Standalone CRUD on the agentic host's
 * `insight-settings/*` routes (`{offset,limit}` pager, same as
 * {@link Lifecycle}) — NOT embedded in a lifecycle rule. A rule references
 * one or more settings by id via `action.insightSettingsIds` (see
 * {@link Lifecycle#create}); the id is validated at rule create/update time
 * and only `active`-status settings are resolved when the rule actually
 * fires. Mounted at `mgmt.insightSettings`.
 *
 * `valueType` is one of {@link INSIGHT_VALUE_TYPES} (`string`, `number`,
 * `boolean`, `arrayString`, `arrayNumber`, `arrayBoolean`). `status` is one
 * of {@link INSIGHT_SETTING_STATUSES} (`active`, `disabled`) — `disabled`
 * settings are skipped when a rule resolves its insights at dispatch time,
 * but can still be referenced (and later re-enabled) without recreating the
 * rule.
 */
import { paginate } from './paginate.js';
import { uuidv4, meta } from '../core/ids.js';
import { requireConfirm } from './agents.js';
import { KalturaError } from '../core/errors.js';

/** @type {ReadonlyArray<'string'|'number'|'boolean'|'arrayString'|'arrayNumber'|'arrayBoolean'>} */
export const INSIGHT_VALUE_TYPES = Object.freeze(['string', 'number', 'boolean', 'arrayString', 'arrayNumber', 'arrayBoolean']);

/** @type {ReadonlyArray<'active'|'disabled'>} */
export const INSIGHT_SETTING_STATUSES = Object.freeze(['active', 'disabled']);

/** @param {unknown} v @param {string} where */
function requireSettingId(v, where) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} id must be a non-empty string (the insight setting's id).` });
  }
}

/** @param {unknown} v @param {string} where @param {string} field */
function requireNonEmptyString(v, where, field) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} ${field} must be a non-empty string.` });
  }
}

/** @param {unknown} v @param {string} where */
function requireValueType(v, where) {
  if (!INSIGHT_VALUE_TYPES.includes(/** @type {any} */ (v))) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} valueType must be one of ${INSIGHT_VALUE_TYPES.join(', ')}, got ${JSON.stringify(v)}.` });
  }
}

export class InsightSettings {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * Create an insight setting. WRITE — NOT idempotent (a repeat call creates
   * a second entity, same as {@link Lifecycle#create}).
   * @param {{key:string, title:string, prompt:string, valueType:string}} body
   * @param {string} ks (admin)
   */
  async create(body, ks) {
    this._.assertAdmin(ks, 'insightSettings.create');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'insightSettings.create needs a {key, title, prompt, valueType} object.' });
    }
    requireNonEmptyString(body.key, 'insightSettings.create', 'key');
    requireNonEmptyString(body.title, 'insightSettings.create', 'title');
    requireNonEmptyString(body.prompt, 'insightSettings.create', 'prompt');
    requireValueType(body.valueType, 'insightSettings.create');
    const wire = { key: body.key, title: body.title, prompt: body.prompt, valueType: body.valueType };
    return (await this._.agentic('insight-settings/create', wire, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Get an insight setting by id. READ.
   * @param {string} id @param {string} ks (admin)
   */
  async get(id, ks) {
    this._.assertAdmin(ks, 'insightSettings.get');
    requireSettingId(id, 'insightSettings.get');
    return (await this._.agentic('insight-settings/get', { id }, ks)).data;
  }

  /**
   * List insight settings for the authenticated partner. READ. Async-iterable
   * + awaitable (first page) — mirrors {@link Lifecycle#list}'s `{offset,limit}`
   * pager.
   * @param {string} ks (admin)
   * @param {{filter?:{statusEqual?:string, idsIn?:string[]}, orderBy?:'+createdAt'|'-createdAt', pageSize?:number}} [opts]
   */
  list(ks, opts = {}) {
    this._.assertAdmin(ks, 'insightSettings.list');
    return paginate({
      style: 'offset', pageSize: opts.pageSize,
      fetchPage: (pager) => this._.agentic('insight-settings/list', { filter: opts.filter || {}, ...(opts.orderBy ? { orderBy: opts.orderBy } : {}), pager }, ks).then((r) => r.data),
    });
  }

  /**
   * Update an insight setting's key/title/prompt/valueType/status. WRITE —
   * idempotent.
   * @param {string} id
   * @param {{key?:string, title?:string, prompt?:string, valueType?:string, status?:string}} patch
   * @param {string} ks (admin)
   */
  async update(id, patch, ks) {
    this._.assertAdmin(ks, 'insightSettings.update');
    requireSettingId(id, 'insightSettings.update');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'insightSettings.update needs a patch object.' });
    }
    const fields = ['key', 'title', 'prompt', 'valueType', 'status'];
    if (!fields.some((f) => patch[f] !== undefined)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `insightSettings.update needs at least one of ${fields.join('/')}.` });
    }
    if (patch.valueType !== undefined) requireValueType(patch.valueType, 'insightSettings.update');
    if (patch.status !== undefined && !INSIGHT_SETTING_STATUSES.includes(/** @type {any} */ (patch.status))) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `insightSettings.update status must be one of ${INSIGHT_SETTING_STATUSES.join(', ')}, got ${JSON.stringify(patch.status)}.` });
    }
    /** @type {Record<string,unknown>} */
    const wire = { id };
    for (const f of fields) if (patch[f] !== undefined) wire[f] = patch[f];
    return (await this._.agentic('insight-settings/update', wire, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Delete an insight setting by id. WRITE — destructive (requires
   * confirmation). Does NOT cascade: a lifecycle rule still listing this id
   * in `action.insightSettingsIds` keeps a dangling reference — the rule's
   * next dispatch simply skips it (only `active` ids resolve), but consider
   * dropping it from the rule via `lifecycle.update` first if the rule is
   * still meant to fire.
   * @param {string} id @param {string} ks (admin) @param {{confirmPermanent:boolean}} confirm
   * @returns {Promise<{removed:string, success:boolean, _meta:object}>}
   */
  async delete(id, ks, confirm) {
    this._.assertAdmin(ks, 'insightSettings.delete');
    requireSettingId(id, 'insightSettings.delete');
    requireConfirm(confirm, 'insightSettings.delete', id);
    const { success } = await this._.agentic('insight-settings/delete', { id }, ks).then((r) => r.data);
    return { removed: id, success, _meta: meta({ partnerId: this._.partnerId, source: 'agentic/insight-settings.delete', scope: `insightSettings:${id}` }) };
  }
}
