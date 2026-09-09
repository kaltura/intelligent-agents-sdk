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
 * Reject a stray `adminTags` on an avatar body BEFORE the network call.
 * `avatar/create` actually ACCEPTS and stores `adminTags` (`avatar/list
 * adminTagsIn` finds it), but no read path ever returns it back — a tag you
 * can set but never read or change is a trap, so the SDK throws pre-network
 * rather than let one through silently. `avatar/update` genuinely rejects it
 * (`UpdateAvatarDto` has no tag field) with only a bare 'Bad Request'. Either
 * way, the actionable fix is to tag the parent AGENT instead. Pure: no
 * network.
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

/**
 * Reject an incomplete `face`/`background` composition BEFORE the network
 * call. Live: `face` alone 200s with `AVATAR_MISSING_VISUAL_RESOLUTION`
 * ("face requires a background"), and `background` alone WITHOUT a
 * `templateId` 200s with the same code ("background requires a face") — both
 * HTTP 200 domain failures the SDK can catch for free by checking client-side
 * first. `templateId` supplies its own face, so `templateId + background`
 * (no `face` key) is a valid pairing and must NOT be rejected here. Pure: no
 * network.
 * @param {object} body @param {string} where
 */
function assertComposition(body, where) {
  if (!body || typeof body !== 'object') return;
  const hasFace = body.face !== undefined;
  const hasBackground = body.background !== undefined;
  if (hasFace !== hasBackground && !(hasBackground && body.templateId !== undefined)) {
    throw new KalturaError({
      type: 'about:blank', title: 'incomplete avatar composition', code: 'bad_request',
      detail: `${where}: face and background must be sent together (composing a visual needs both) — got ${hasFace ? 'face only' : 'background only'}.`,
    });
  }
  if (hasBackground) {
    const bg = body.background;
    if (!bg || typeof bg !== 'object' || !bg.type || bg.value === undefined) {
      throw new KalturaError({
        type: 'about:blank', title: 'invalid background', code: 'bad_request',
        detail: `${where}: background must be {type:'color'|'visual', value} — got ${JSON.stringify(bg)}.`,
      });
    }
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
   * NO TAGS (BY SDK POLICY, NOT A SERVER REJECT): `avatar/create` actually
   * ACCEPTS `adminTags` and stores it (`avatar/list adminTagsIn` finds it),
   * but no read path ever returns it — you can set it once and never see or
   * change it again. To group/identify avatars, tag the PARENT AGENT instead —
   * `agents.create({adminTags:[...]})`. This SDK throws pre-network on a
   * stray `adminTags` key rather than let you fall into that write-only trap.
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
   * THREE WAYS TO GET A VISUAL — pick exactly one:
   *  - `visual:{id}` — an existing catalog Visual (preset, or your own upload
   *    via {@link Catalog#createVisual}). Wins if sent alongside `face`/`background`.
   *  - `face:{id} + background:{type:'color', value:'#hex'}` (or
   *    `type:'visual', value:<Background catalog itemId>`) — composes a NEW
   *    Visual from a Face catalog item over a color or a Background catalog
   *    item. `face`/`background` MUST travel together — either alone is a
   *    domain failure (UNLESS `templateId` is also given, which supplies its
   *    own face — see below). The composed result is reflected in
   *    `visual.composition` and a fresh raw `previewImageUrl`/`loadingVideoUrl` —
   *    inspect those to see what was built.
   *  - `templateId` — a curated `{voice, face}` bundle from
   *    {@link listTemplates} (36 live today, voice + face only) PLUS a
   *    `background` or `visual` to resolve the template's face into an actual
   *    Visual (`templateId` alone is a domain failure — nothing to compose
   *    onto). A future template may ship self-sufficient and need neither.
   *
   * `name` (≤255 chars) labels the avatar; over 255 is a 400.
   *
   * DOMAIN FAILURES ARRIVE AS HTTP 200: an incomplete/invalid composition is a
   * `KalturaAPIException` body, not an HTTP error — check `objectType`, not
   * status. Codes: `AVATAR_MISSING_VISUAL_RESOLUTION` (face/background/template
   * incomplete), `AVATAR_FAILED_TO_COMPOSE_VISUAL` (e.g. a bogus face id),
   * `AVATAR_MISSING_VOICE`, `AVATAR_NOT_FOUND`. The SDK pre-network guard below
   * catches the incomplete-pairing case for free, before the wire call.
   *
   * @param {object} body {voice:{id,speed?},visual?:{id,motionControl?:{speaking,nonSpeaking}},face?:{id},background?:{type:'color'|'visual',value:string},name?:string,templateId?:string,openingPhrase?:string}
   * @param {string} ks @param {{idempotencyKey?:string}} [opts]
   * @throws {import('../core/errors.js').KalturaError} `code:'bad_request'` if `adminTags` is passed, or if `face`/`background` are incomplete/malformed.
   */
  async create(body, ks, opts = {}) {
    this._.assertAdmin(ks, 'avatars.create');
    assertNoAvatarTags(body, 'avatars.create');
    assertComposition(body, 'avatars.create');
    return (await this._.agentic('avatar/create', body, ks, { idempotencyKey: opts.idempotencyKey || uuidv4() })).data;
  }

  /**
   * Update an avatar. WRITE — idempotent. This is a PATCH: fields OMITTED from
   * the body are PRESERVED server-side (sending `{id, openingPhrase}`
   * alone keeps the existing `voice`/`visual`/`motionControl`). Send only the
   * fields you want to change.
   *
   * NO TAGS, AND HERE IT'S A REAL SERVER REJECT: unlike {@link create},
   * `UpdateAvatarDto` genuinely has no tag field — `avatar/update` 400s on
   * `adminTags` with only a bare `'Bad Request'` (no helpful `detail`). The
   * SDK throws pre-network with an actionable message instead — tag the
   * parent AGENT (`agents.update({adminTags})`) instead.
   *
   * @example <caption>Change just the opening phrase; voice/visual untouched</caption>
   * await k.avatars.update({ id: avatarId, openingPhrase: 'Welcome back!' }, adminKs);
   *
   * Also accepts `face`+`background` (recomposes the visual — same pairing
   * rule as {@link create}, and `visual.composition` reflects the new
   * result) and `name`. `templateId` is REJECTED on update (400 `property
   * templateId should not exist`) — it's a create-only convenience.
   *
   * @param {object} body {id:string, face?:{id}, background?:{type:'color'|'visual',value:string}, name?:string, ...}
   * @param {string} ks
   * @throws {import('../core/errors.js').KalturaError} `code:'bad_request'` if `adminTags` is passed, or if `face`/`background` are incomplete/malformed.
   */
  async update(body, ks) {
    this._.assertAdmin(ks, 'avatars.update');
    assertNoAvatarTags(body, 'avatars.update');
    assertComposition(body, 'avatars.update');
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
