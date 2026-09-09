/**
 * InsightSettings — reusable custom-insight definitions (`key`, `title`,
 * `prompt`, `valueType`) referenced by id from a lifecycle rule's
 * `triggerInsightSettingsKai` action (see {@link Lifecycle}). Agentic host,
 * admin token, `{status, data}` unwrap — same shape as {@link Avatars}.
 * Mounted at `mgmt.insightSettings`.
 *
 * Shipped in agentic-api `#364` (2026-09-08). Live on NVQ2 only as of this
 * writing; disabled on PROD (`insight-settings/list` → 404 `Cannot POST`)
 * until PROD takes that release — see the gate note on {@link Lifecycle}.
 */
import { paginate } from './paginate.js';
import { uuidv4 } from '../core/ids.js';
import { requireConfirm } from './agents.js';
import { KalturaError } from '../core/errors.js';

const VALUE_TYPES = ['string', 'number', 'boolean', 'arrayString', 'arrayNumber', 'arrayBoolean'];
const STATUSES = ['active', 'disabled'];

/** @param {unknown} v @param {string} where */
function requireId(v, where) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} id must be a non-empty string (the insight-settings entity's Mongo ObjectId).` });
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
  if (!VALUE_TYPES.includes(v)) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} valueType must be one of ${VALUE_TYPES.join(', ')}.` });
  }
}

export class InsightSettings {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * Create an insight-settings definition. WRITE — NOT idempotent (a repeat
   * call creates a second entity, same as {@link Skills#add}). All four
   * fields are required — the live 400 lists whichever is missing.
   * @param {{key:string, title:string, prompt:string, valueType:'string'|'number'|'boolean'|'arrayString'|'arrayNumber'|'arrayBoolean'}} body
   * @param {string} ks (admin) @param {{idempotencyKey?:string}} [opts]
   */
  async create(body, ks, opts = {}) {
    this._.assertAdmin(ks, 'insightSettings.create');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'insightSettings.create needs a {key, title, prompt, valueType} object.' });
    }
    requireNonEmptyString(body.key, 'insightSettings.create', 'key');
    requireNonEmptyString(body.title, 'insightSettings.create', 'title');
    requireNonEmptyString(body.prompt, 'insightSettings.create', 'prompt');
    requireValueType(body.valueType, 'insightSettings.create');
    return (await this._.agentic(
      'insight-settings/create',
      { key: body.key, title: body.title, prompt: body.prompt, valueType: body.valueType },
      ks, { idempotencyKey: opts.idempotencyKey || uuidv4() },
    )).data;
  }

  /** Get one insight-settings entity by id. READ. @param {string} id @param {string} ks (admin) */
  async get(id, ks) {
    this._.assertAdmin(ks, 'insightSettings.get');
    requireId(id, 'insightSettings.get');
    return (await this._.agentic('insight-settings/get', { id }, ks)).data;
  }

  /**
   * List insight-settings for the authenticated partner. READ. Async-iterable
   * + awaitable (first page) — mirrors {@link Lifecycle#list}'s `{offset,limit}`
   * pager (agentic-hosted, NOT the Genie `{pageIndex,pageSize}` convention).
   * @param {string} ks (admin)
   * @param {{filter?:{statusEqual?:'active'|'disabled', idsIn?:string[]}, orderBy?:'+createdAt'|'-createdAt', pageSize?:number}} [opts]
   */
  list(ks, opts = {}) {
    this._.assertAdmin(ks, 'insightSettings.list');
    return paginate({
      style: 'offset', pageSize: opts.pageSize,
      fetchPage: (pager) => this._.agentic('insight-settings/list', { filter: opts.filter || {}, ...(opts.orderBy ? { orderBy: opts.orderBy } : {}), pager }, ks).then((r) => r.data),
    });
  }

  /**
   * Update an insight-settings definition's key/title/prompt/valueType/status.
   * WRITE — idempotent.
   * @param {string} id (Mongo ObjectId)
   * @param {{key?:string, title?:string, prompt?:string, valueType?:string, status?:'active'|'disabled'}} patch
   * @param {string} ks (admin)
   */
  async update(id, patch, ks) {
    this._.assertAdmin(ks, 'insightSettings.update');
    requireId(id, 'insightSettings.update');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'insightSettings.update needs a patch object.' });
    }
    const fields = ['key', 'title', 'prompt', 'valueType', 'status'];
    if (!fields.some((f) => patch[f] !== undefined)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `insightSettings.update needs at least one of ${fields.join('/')}.` });
    }
    if (patch.valueType !== undefined) requireValueType(patch.valueType, 'insightSettings.update');
    if (patch.status !== undefined && !STATUSES.includes(patch.status)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `insightSettings.update status must be one of ${STATUSES.join(', ')}.` });
    }
    /** @type {Record<string,unknown>} */
    const wire = { id };
    for (const f of fields) if (patch[f] !== undefined) wire[f] = patch[f];
    return (await this._.agentic('insight-settings/update', wire, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Delete an insight-settings definition by id. WRITE — destructive (requires
   * confirmation). No in-use scan runs first: a lifecycle rule that still
   * references a deleted id fails loudly at match/trigger time (HTTP 200
   * `KalturaAPIException` `INVALID_INSIGHT_SETTINGS`), it doesn't silently
   * keep a dangling reference.
   * @param {string} id (Mongo ObjectId) @param {string} ks (admin) @param {{confirmPermanent:boolean}} confirm
   */
  async delete(id, ks, confirm) {
    this._.assertAdmin(ks, 'insightSettings.delete');
    requireId(id, 'insightSettings.delete');
    requireConfirm(confirm, 'insightSettings.delete', id);
    return (await this._.agentic('insight-settings/delete', { id }, ks)).data;
  }
}
