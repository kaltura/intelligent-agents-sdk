/**
 * Skills — CRUD over the standalone, PARTNER-LEVEL Skill entity via the brain's
 * `/v1/skill/*` (NOT intellect-scoped). Mounted at `mgmt.skills`. A Skill is
 * `{id (uuid), name, description, instructions, partner_id, created_at,
 * updated_at}` — a named, reusable behavior description the agent can draw on
 * (add returns the full entity; delete → get 404s "Skill not
 * found"; another partner's id also 404s). `update()` below is the idempotent
 * re-edit path (renames re-check the same
 * partner-unique-name constraint as `add`, 409 on conflict).
 *
 * Names are unique per partner. A duplicate returns HTTP 409
 * (`code:'conflict'`). The same applies to {@link Tools} (see its class doc).
 *
 * SHARED-BY-NAME HAZARD: because `name` is the lookup key callers upsert
 * against (see `src/management/provision.js`'s `applyTools` for the
 * identical pattern applied to Tools, or an app's own upsert-by-name helper),
 * two independently-run provisioning flows for
 * the SAME name silently converge on the SAME Skill entity — deleting (or
 * unexpectedly editing) it affects every intellect that references it, not
 * just the one the caller has in mind. `delete()` below checks for exactly
 * this before acting.
 */
import { paginate } from './paginate.js';
import { uuidv4, meta } from '../core/ids.js';
import { requireConfirm } from './agents.js';
import { KalturaError } from '../core/errors.js';
import { assertCondition } from './condition.js';

/** @param {string} v @param {string} where */
function requireSkillNameChars(v, where) {
  if (!/^[a-zA-Z0-9_-]+$/.test(v)) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} must use only letters, digits, "_" or "-". Replace spaces with "_".` });
  }
}

/** @param {unknown} v @param {string} where */
function requireSkillId(v, where) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} id must be a non-empty string (the Skill entity's uuid).` });
  }
}

/**
 * List every intellect's configId that currently references `skillId` in its
 * `skill_ids` (each entry is `{id, mode}` — mode is irrelevant to the check).
 * The safety check `Skills#delete` runs before deleting a PARTNER-LEVEL
 * Skill that may be shared across intellects (see the class doc). Mirrors
 * `tools.js`'s `findIntellectsReferencingTool` exactly, adapted to the
 * `SkillRef[]` shape.
 * @param {import('./client.js').Ctx} ctx @param {string} skillId @param {string} ks
 * @returns {Promise<number[]>}
 */
async function findIntellectsReferencingSkill(ctx, skillId, ks) {
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
      if (Array.isArray(full?.skill_ids) && full.skill_ids.some((ref) => ref?.id === skillId)) refs.push(item.id);
    }
    const total = page?.totalCount;
    if (objects.length === 0 || (typeof total === 'number' && pageIndex * pageSize >= total)) break;
  }
  return refs;
}

export class Skills {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * Create a Skill. WRITE — NOT idempotent (a repeat call creates a second
   * entity). `name` and `description` are required and validated BEFORE any
   * network call; `instructions` is optional (stored `null` when omitted).
   * `condition` is an optional bare expression such as `sys__avatar_enabled`.
   * The skill applies only while it is true. It is checked before any network
   * call, and a template form like `{{ x }}` throws `bad_request`. `null` or
   * `undefined` is not sent.
   * `name` may use only letters, digits, `_` and `-` (no spaces).
   *
   * Also callable as {@link Skills#create} — same method, either name works.
   * @param {{name:string, description:string, instructions?:string, condition?:string|null}} body
   * @param {string} ks (admin)
   * @returns {Promise<{id:string, name:string, description:string, instructions:string|null, partner_id:number, created_at:string, updated_at:string}>}
   */
  async add(body, ks) {
    this._.assertAdmin(ks, 'skills.add');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'skills.add needs a {name, description, instructions?, condition?} object.' });
    }
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'skills.add name must be a non-empty string.' });
    }
    requireSkillNameChars(body.name, 'skills.add name');
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
    if (body.condition !== undefined && body.condition !== null) {
      assertCondition(body.condition, 'skills.add condition');
      wire.condition = body.condition;
    }
    return (await this._.genie('v1/skill/add', wire, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Alias for {@link Skills#add}. Same validation, same call, same result.
   * @param {{name:string, description:string, instructions?:string, condition?:string|null}} body
   * @param {string} ks (admin)
   * @returns {Promise<{id:string, name:string, description:string, instructions:string|null, partner_id:number, created_at:string, updated_at:string}>}
   */
  create(body, ks) {
    return this.add(body, ks);
  }

  /**
   * Get a Skill by id. READ. A deleted, unknown or another partner's id → typed `not_found`. A shared skill (`partner_id: 0`,
   * listed by {@link Skills#list}) also returns `not_found`, although
   * `setSkillIds` can attach it.
   * @param {string} id @param {string} ks (admin)
   */
  async get(id, ks) {
    this._.assertAdmin(ks, 'skills.get');
    requireSkillId(id, 'skills.get');
    return (await this._.genie('v1/skill/get', { id }, ks)).data;
  }

  /**
   * List Skills for the authenticated partner. READ. Async-iterable +
   * awaitable (first page) — mirrors {@link Tools#list}. The list also holds
   * shared skills that every partner can attach, marked `partner_id: 0`; filter
   * on `partner_id` to see only your own. You cannot edit or delete a shared skill.
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
   * Update a Skill's name/description/instructions/condition. WRITE — idempotent.
   * `/v1/skill/update` re-checks the partner-unique-name constraint on a
   * rename (409 on conflict, same as `add`). `condition` is checked before any
   * network call like in {@link Skills#add}. Pass `condition: ''` to clear it.
   * `null` is skipped.
   * @param {string} id @param {{name?:string, description?:string, instructions?:string, condition?:string|null}} patch
   * @param {string} ks (admin)
   * @returns {Promise<{id:string, name:string, description:string, instructions:string|null, partner_id:number, created_at:string, updated_at:string}>}
   */
  async update(id, patch, ks) {
    this._.assertAdmin(ks, 'skills.update');
    requireSkillId(id, 'skills.update');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'skills.update needs a patch object {name?, description?, instructions?, condition?}.' });
    }
    /** @type {Record<string,unknown>} */
    const body = { id };
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || !patch.name.trim()) throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'skills.update patch.name must be a non-empty string.' });
      body.name = patch.name;
    }
    if (patch.description !== undefined) {
      if (typeof patch.description !== 'string' || !patch.description.trim()) throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'skills.update patch.description must be a non-empty string.' });
      body.description = patch.description;
    }
    if (patch.instructions !== undefined) {
      if (typeof patch.instructions !== 'string') throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'skills.update patch.instructions, when given, must be a string.' });
      body.instructions = patch.instructions;
    }
    if (patch.condition !== undefined && patch.condition !== null) {
      if (patch.condition !== '') assertCondition(patch.condition, 'skills.update condition');
      body.condition = patch.condition;
    }
    if (Object.keys(body).length === 1) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'skills.update needs at least one of name/description/instructions/condition.' });
    }
    return (await this._.genie('v1/skill/update', body, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Delete a Skill by id. WRITE, destructive (requires confirmation). Resolves
   * `{removed, _meta}`; a follow-up `get` 404s.
   *
   * SAFETY CHECK (default on): before deleting, lists every intellect and
   * refuses with a typed `skill_in_use` error naming each one still carrying
   * this id in `skill_ids` — Skills are partner-level and shared by name (see
   * the class doc), so a stale saved id can easily still be load-bearing for
   * a DIFFERENT intellect than the caller has in mind. Pass
   * `{confirmPermanent:true, force:true}` to skip the check and delete
   * unconditionally.
   * @param {string} id @param {string} ks (admin) @param {{confirmPermanent:boolean, force?:boolean}} confirm
   * @returns {Promise<{removed:string, _meta:object, skippedInUseCheck?:boolean}>}
   */
  async delete(id, ks, confirm) {
    this._.assertAdmin(ks, 'skills.delete');
    requireSkillId(id, 'skills.delete');
    requireConfirm(confirm, 'skills.delete', id);
    if (!confirm.force) {
      const refs = await findIntellectsReferencingSkill(this._, id, ks);
      if (refs.length) {
        throw new KalturaError({
          type: 'about:blank', title: 'skill in use', code: 'skill_in_use',
          detail: `skill ${id} is still referenced in skill_ids by ${refs.length} intellect(s) (configId: ${refs.join(', ')}) — deleting it would break every one still calling it. Drop it from their skill_ids first via intellectConfig.setSkillIds, or pass {confirmPermanent:true, force:true} to delete anyway.`,
        });
      }
    }
    await this._.genie('v1/skill/delete', { id }, ks);
    return {
      removed: id,
      ...(confirm.force ? { skippedInUseCheck: true } : {}),
      _meta: meta({ partnerId: this._.partnerId, source: 'genie/skill.delete', scope: `skill:${id}` }),
    };
  }
}
