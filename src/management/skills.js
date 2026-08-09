/**
 * Skills — CRUD over the standalone, PARTNER-LEVEL Skill entity via Genie
 * `/v1/skill/*` (NOT intellect-scoped). Mounted at `mgmt.skills`. A Skill is
 * `{id (uuid), name, description, instructions, partner_id, created_at,
 * updated_at}` — a named, reusable behavior description the brain can draw on
 * (verified live: add returns the full entity; delete → get 404s "Skill not
 * found"; another partner's id 403s). There is no `skill/update` endpoint on
 * the current deployment — recreate to change one.
 */
import { paginate } from './paginate.js';
import { uuidv4, meta } from '../core/ids.js';
import { requireConfirm } from './agents.js';
import { KalturaError } from '../core/errors.js';

/** @param {unknown} v @param {string} where */
function requireSkillId(v, where) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} id must be a non-empty string (the Skill entity's uuid).` });
  }
}

export class Skills {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * Create a Skill. WRITE — NOT idempotent (a repeat call creates a second
   * entity). `name` and `description` are required and validated BEFORE any
   * network call; `instructions` is optional (stored `null` when omitted).
   * @param {{name:string, description:string, instructions?:string}} body
   * @param {string} ks (admin)
   * @returns {Promise<{id:string, name:string, description:string, instructions:string|null, partner_id:number, created_at:string, updated_at:string}>}
   */
  async add(body, ks) {
    this._.assertAdmin(ks, 'skills.add');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'skills.add needs a {name, description, instructions?} object.' });
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'skills.add name must be a non-empty string.' });
    }
    if (typeof body.description !== 'string' || !body.description.trim()) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'skills.add description must be a non-empty string.' });
    }
    /** @type {Record<string,unknown>} */
    const wire = { name: body.name, description: body.description };
    if (body.instructions !== undefined) {
      if (typeof body.instructions !== 'string') {
        throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'skills.add instructions, when given, must be a string.' });
      }
      wire.instructions = body.instructions;
    }
    return (await this._.genie('v1/skill/add', wire, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Get a Skill by id. READ. A deleted or unknown id → typed `not_found`;
   * another partner's id → typed `forbidden` (both verified live).
   * @param {string} id @param {string} ks (admin)
   */
  async get(id, ks) {
    this._.assertAdmin(ks, 'skills.get');
    requireSkillId(id, 'skills.get');
    return (await this._.genie('v1/skill/get', { id }, ks)).data;
  }

  /**
   * List Skills for the authenticated partner. READ. Async-iterable +
   * awaitable (first page) — mirrors {@link Tools#list}.
   * @param {string} ks (admin) @param {{filter?:object, pageSize?:number}} [opts]
   */
  list(ks, opts = {}) {
    this._.assertAdmin(ks, 'skills.list');
    return paginate({
      style: 'index', pageSize: opts.pageSize,
      fetchPage: (pager) => this._.genie('v1/skill/list', { filter: { objectType: 'SkillListFilter', ...(opts.filter || {}) }, pager }, ks).then((r) => r.data),
    });
  }

  /**
   * Delete a Skill by id. WRITE — destructive (requires confirmation). The
   * wire reply is `{id}`; a follow-up `get` 404s (verified live).
   * @param {string} id @param {string} ks (admin) @param {{confirmPermanent:boolean}} confirm
   * @returns {Promise<{removed:string, _meta:object}>}
   */
  async delete(id, ks, confirm) {
    this._.assertAdmin(ks, 'skills.delete');
    requireSkillId(id, 'skills.delete');
    requireConfirm(confirm, 'skills.delete', id);
    await this._.genie('v1/skill/delete', { id }, ks);
    return { removed: id, _meta: meta({ partnerId: this._.partnerId, source: 'genie/skill.delete', scope: `skill:${id}` }) };
  }
}
