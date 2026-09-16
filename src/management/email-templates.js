/**
 * EmailTemplates — CRUD over the Kaltura Messaging API's email templates
 * (`email-template/*`). A template's `id` is what a {@link Lifecycle} rule's
 * `sendInsightEmail` action pins as `templateId` — the durable alternative to
 * `presetType`, which depends on the backend auto-creating (and finding) a
 * preset template on first use.
 *
 * Separate host from Agentic/Genie, with its own auth: `Authorization:
 * Bearer <KS>` (an ADMIN KS) rather than the `Authorization: KS <ks>` scheme
 * every other resource in this SDK uses. Same `{offset,limit}` pager +
 * `{objects,totalCount}` response shape as {@link Lifecycle#list}.
 */
import { KalturaError } from '../core/errors.js';
import { meta, uuidv4 } from '../core/ids.js';
import { paginate } from './paginate.js';
import { requireConfirm } from './agents.js';

/** @param {unknown} v @param {string} where */
function requireTemplateId(v, where) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} id must be a non-empty string (the email template's id).` });
  }
}

/** @param {unknown} v @param {string} where @param {string} field */
function requireNonEmptyString(v, where, field) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} ${field} must be a non-empty string.` });
  }
}

/** @param {unknown} v @param {string} where */
function requireMsgParamsMap(v, where) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} msgParamsMap must be an object mapping token names to { type }.` });
  }
}

const UPDATE_FIELDS = ['name', 'subject', 'body', 'description', 'from', 'fromName', 'cc', 'bcc', 'msgParamsMap', 'unsubscribeGroups', 'status', 'adminTags', 'customHeaders'];

export class EmailTemplates {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * Create an email template. WRITE — NOT idempotent (a repeat call creates a
   * second template, same as {@link Lifecycle#create}). `appGuid`, `name`,
   * `subject`, `body`, `toAttributePath`, and `msgParamsMap` are required by
   * the Messaging API; `body`/`subject`/`fromName` may reference the tokens
   * declared in `msgParamsMap` (e.g. `{recipient.firstName}`).
   * @param {{appGuid:string, name:string, subject:string, body:string, toAttributePath:string, msgParamsMap:Record<string,{type:string}>, description?:string, from?:string, fromName?:string, cc?:string, bcc?:string, unsubscribeGroups?:string[], status?:'enabled'|'disabled', adminTags?:string, customHeaders?:Record<string,string>}} template
   * @param {string} ks (admin)
   * @returns {Promise<object>} the full created template, including its generated `id`.
   */
  async create(template, ks) {
    this._.assertAdmin(ks, 'emailTemplates.create');
    if (!template || typeof template !== 'object' || Array.isArray(template)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'emailTemplates.create needs a {appGuid, name, subject, body, toAttributePath, msgParamsMap, ...} object.' });
    }
    requireNonEmptyString(template.appGuid, 'emailTemplates.create', 'appGuid');
    requireNonEmptyString(template.name, 'emailTemplates.create', 'name');
    requireNonEmptyString(template.subject, 'emailTemplates.create', 'subject');
    requireNonEmptyString(template.body, 'emailTemplates.create', 'body');
    requireNonEmptyString(template.toAttributePath, 'emailTemplates.create', 'toAttributePath');
    requireMsgParamsMap(template.msgParamsMap, 'emailTemplates.create');
    return (await this._.messaging('email-template/add', template, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Get an email template by id. READ.
   * @param {string} id @param {string} ks (admin)
   * @returns {Promise<object>}
   */
  async get(id, ks) {
    this._.assertAdmin(ks, 'emailTemplates.get');
    requireTemplateId(id, 'emailTemplates.get');
    return (await this._.messaging('email-template/get', { id }, ks)).data;
  }

  /**
   * List email templates for the authenticated partner. READ. Async-iterable
   * + awaitable (first page) — mirrors {@link Lifecycle#list}'s `{offset,limit}`
   * pager and `{objects,totalCount}` response shape.
   * @param {string} ks (admin)
   * @param {{filter?:{idIn?:string[], appGuidIn?:string[], name?:string, nameEq?:string, subject?:string, status?:'enabled'|'disabled'|'deleted', adminTags?:string, adminTagsAll?:string, excludeAdminTags?:string, createdAtGreaterThanOrEqual?:string, createdAtLessThanOrEqual?:string, updatedAtGreaterThanOrEqual?:string, updatedAtLessThanOrEqual?:string}, pageSize?:number}} [opts]
   */
  list(ks, opts = {}) {
    this._.assertAdmin(ks, 'emailTemplates.list');
    return paginate({
      style: 'offset', pageSize: opts.pageSize,
      fetchPage: (pager) => this._.messaging('email-template/list', { filter: opts.filter || {}, pager }, ks).then((r) => r.data),
    });
  }

  /**
   * Update an email template's name/subject/body/description/from/fromName/
   * cc/bcc/msgParamsMap/unsubscribeGroups/status/adminTags/customHeaders.
   * WRITE — idempotent. Fields not included remain unchanged; the server
   * increments `version` on every call.
   * @param {string} id
   * @param {{name?:string, subject?:string, body?:string, description?:string, from?:string, fromName?:string, cc?:string, bcc?:string, msgParamsMap?:Record<string,{type:string}>, unsubscribeGroups?:string[], status?:'enabled'|'disabled'|'deleted', adminTags?:string, customHeaders?:Record<string,string>}} patch
   * @param {string} ks (admin)
   * @returns {Promise<object>} the full updated template.
   */
  async update(id, patch, ks) {
    this._.assertAdmin(ks, 'emailTemplates.update');
    requireTemplateId(id, 'emailTemplates.update');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'emailTemplates.update needs a patch object.' });
    }
    if (!UPDATE_FIELDS.some((f) => patch[f] !== undefined)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `emailTemplates.update needs at least one of ${UPDATE_FIELDS.join('/')}.` });
    }
    /** @type {Record<string,unknown>} */
    const wire = { id };
    for (const f of UPDATE_FIELDS) if (patch[f] !== undefined) wire[f] = patch[f];
    return (await this._.messaging('email-template/update', wire, ks)).data;
  }

  /**
   * Delete an email template by id. WRITE — destructive (requires
   * confirmation). Sets the template's `status` to `deleted` server-side; a
   * lifecycle rule still pinning this id as its `templateId` silently stops
   * sending once deleted — repoint or disable that rule first.
   * @param {string} id @param {string} ks (admin) @param {{confirmPermanent:boolean}} confirm
   * @returns {Promise<{removed:string, _meta:object}>}
   */
  async delete(id, ks, confirm) {
    this._.assertAdmin(ks, 'emailTemplates.delete');
    requireTemplateId(id, 'emailTemplates.delete');
    requireConfirm(confirm, 'emailTemplates.delete', id);
    await this._.messaging('email-template/delete', { id }, ks);
    return { removed: id, _meta: meta({ partnerId: this._.partnerId, source: 'messaging/emailTemplates.delete', scope: `emailTemplate:${id}` }) };
  }
}
