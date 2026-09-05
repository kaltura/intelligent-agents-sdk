/**
 * Avatars — a deployable face+voice identity (a visual catalog id + a voice
 * catalog id + motion/opening config). Agentic host, admin token. Source:
 * API-REFERENCE §2.4 / Management Operations.
 */
import { paginate } from './paginate.js';
import { uuidv4 } from '../core/ids.js';
import { requireConfirm } from './agents.js';
import { KalturaError } from '../core/errors.js';

/**
 * Reject a stray `adminTags` on an avatar body BEFORE the network call. The
 * avatar DTO is strict-rejecting: `avatar/create` 400s with
 * `body.detail: ["property adminTags should not exist"]`; `avatar/update` 400s
 * with only a bare 'Bad Request'). Avatars carry no tag field — the actionable
 * fix is to tag the parent AGENT. Pure: no network.
 * @param {object} body @param {string} where
 */
function assertNoAvatarTags(body, where) {
  if (body && typeof body === 'object' && body.adminTags !== undefined) {
    throw new KalturaError({
      type: 'about:blank', title: 'avatars carry no tags', code: 'bad_request',
      detail: `${where}: the avatar DTO rejects "adminTags" (avatars carry no tag field). Tag the parent AGENT instead — agents.create/agents.update({ adminTags: [...] }).`,
    });
  }
}

export class Avatars {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /** List avatars. READ. @param {string} ks @param {{filter?:object,pageSize?:number}} [opts] */
  list(ks, opts = {}) {
    this._.assertAdmin(ks, 'avatars.list');
    return paginate({
      style: 'offset', pageSize: opts.pageSize,
      fetchPage: (pager) => this._.agentic('avatar/list', opts.filter ? { filter: opts.filter, pager } : { pager }, ks).then((r) => r.data),
    });
  }

  /**
   * Get one avatar. READ. ⚠️ A missing/unknown avatar id throws with
   * `code:'api_exception'` (a generic agentic error), NOT a stable
   * `avatar_not_found` — so branch on the not-found case defensively (e.g. wrap
   * in try/catch and treat `api_exception` as "absent") rather than matching a
   * dedicated code.
   * @param {string} id 24-char hex @param {string} ks
   */
  async get(id, ks) {
    this._.assertAdmin(ks, 'avatars.get');
    return (await this._.agentic('avatar/get', { id }, ks)).data;
  }

  /**
   * Create an avatar. WRITE — NOT idempotent. `voice.speed` is stored verbatim;
   * the runtime TTS clamps to a sane band (~0.7–1.2). `motionControl` values are
   * 0–1; keep `nonSpeaking` below `speaking`.
   *
   * STRICT DTO — NO TAGS: `avatar/create` rejects any unknown property with a
   * `bad_request` (`body.detail: ["property adminTags should not
   * exist"]`). An avatar carries NO tag field. To group/identify avatars, tag
   * the PARENT AGENT instead — `agents.create({adminTags:[...]})` (the agent DTO
   * accepts adminTags; the avatar DTO does not). This SDK strips a stray
   * `adminTags` key pre-network and throws an actionable error pointing you at
   * the agent, so you never hit the opaque server reject.
   *
   * @example <caption>Tag the AGENT, not the avatar</caption>
   * const avatar = await k.avatars.create(
   *   { voice: { id: voiceId }, visual: { id: visualId }, openingPhrase: 'Hi!' },
   *   adminKs,
   * );
   * await k.agents.create(
   *   { displayName: 'Lobby greeter', intellect, avatarIds: [avatar.id], adminTags: ['lobby'] },
   *   adminKs,
   * );
   *
   * `openingPhrase` MUST be non-empty. A falsy value (empty string, `null`, or
   * omitted) makes the first turn fail right after `showAgent`; always pass a
   * non-empty phrase. If your intellect drives its own dynamic opening (e.g.
   * based on the viewer's prior interactions) and you want no scripted
   * greeting, pass the SSML silence tag `'<blank>'`: non-empty, so it stays
   * on the safe path, and silent, so the TTS speaks nothing for it.
   *
   * @param {object} body {voice:{id,speed?},visual:{id,motionControl?:{speaking,nonSpeaking}},openingPhrase?}
   * @param {string} ks @param {{idempotencyKey?:string}} [opts]
   * @throws {import('../core/errors.js').KalturaError} `code:'bad_request'` if `adminTags` (or any avatar-unknown key) is passed.
   */
  async create(body, ks, opts = {}) {
    this._.assertAdmin(ks, 'avatars.create');
    assertNoAvatarTags(body, 'avatars.create');
    return (await this._.agentic('avatar/create', body, ks, { idempotencyKey: opts.idempotencyKey || uuidv4() })).data;
  }

  /**
   * Update an avatar. WRITE — idempotent. This is a PATCH: fields OMITTED from
   * the body are PRESERVED server-side (sending `{id, openingPhrase}`
   * alone keeps the existing `voice`/`visual`/`motionControl`). Send only the
   * fields you want to change.
   *
   * STRICT DTO — NO TAGS (same as {@link create}): `avatar/update` rejects
   * `adminTags` with a `bad_request`, but the raw server reply is only a
   * bare `'Bad Request'` (no helpful `detail`). The SDK therefore strips/throws
   * pre-network with an actionable message on BOTH paths so update isn't a silent
   * footgun — tag the parent AGENT (`agents.update({adminTags})`) instead.
   *
   * @example <caption>Change just the opening phrase; voice/visual untouched</caption>
   * await k.avatars.update({ id: avatarId, openingPhrase: 'Welcome back!' }, adminKs);
   *
   * @param {object} body {id,...} (only the fields to change)
   * @param {string} ks
   * @throws {import('../core/errors.js').KalturaError} `code:'bad_request'` if `adminTags` (or any avatar-unknown key) is passed.
   */
  async update(body, ks) {
    this._.assertAdmin(ks, 'avatars.update');
    assertNoAvatarTags(body, 'avatars.update');
    return (await this._.agentic('avatar/update', body, ks)).data;
  }

  /** Delete an avatar. WRITE — DESTRUCTIVE (no cascade). @param {string} id @param {string} ks @param {{confirmPermanent:boolean}} confirm */
  async delete(id, ks, confirm) {
    this._.assertAdmin(ks, 'avatars.delete');
    requireConfirm(confirm, 'avatars.delete', id);
    return (await this._.agentic('avatar/delete', { id }, ks)).data;
  }

  /**
   * List curated preset `{voice, face}` template bundles — the fast
   * path to a ready-made avatar instead of hand-picking a visual + voice via
   * {@link Catalog#list}. Each entry's `face.imageUrl` is batch-resolved
   * server-side. READ. `opts.idsIn` filters to specific template ids.
   * @param {string} ks @param {{idsIn?:string[], pageSize?:number}} [opts]
   */
  listTemplates(ks, opts = {}) {
    this._.assertAdmin(ks, 'avatars.listTemplates');
    const filter = opts.idsIn ? { idsIn: opts.idsIn } : undefined;
    return paginate({
      style: 'offset', pageSize: opts.pageSize,
      fetchPage: (pager) => this._.agentic('avatar-template/list', filter ? { filter, pager } : { pager }, ks).then((r) => r.data),
    });
  }
}
