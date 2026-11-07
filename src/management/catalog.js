/**
 * Catalog — the preset library of visuals (faces) and voices, plus custom
 * uploads. Agentic host, admin token. Reference: docs/api/design.md.
 *
 * IMPORTANT asymmetry: an uploaded VOICE is cloned
 * and is immediately usable as a live voice. An uploaded VISUAL image becomes the
 * catalog item's visual content and is usable in avatar/create and avatar-session/create
 * for live animated sessions.
 */
import { paginate } from './paginate.js';
import { uuidv4, meta } from '../core/ids.js';
import { requireConfirm } from './agents.js';
import { KalturaError } from '../core/errors.js';

/**
 * @typedef {object} CatalogListFilter
 * @property {'Visual'|'Voice'|'Face'|'Background'} [typeEqual]
 * @property {string} [itemIdEqual]  One catalog itemId.
 * @property {string[]} [idsIn]      Catalog itemIds.
 * @property {string} [languageEqual] A voice language code, for example 'en'.
 * @property {string[]} [adminTagsIn]
 */

/**
 * @typedef {object} VisualAttrs
 * @property {string} name
 * @property {'Masculine'|'Feminine'} genderPresentation
 * @property {'Color'|'Image'} [background]
 * @property {'MediumTan'|'Light'|'LightMedium'} [skinTone]
 * @property {'YoungAdult'|'OlderAdult'} [ageGroup]
 * @property {'Black'|'Brown'|'Blonde'|'Red'|'Gray'} [hairColor]
 * @property {string[]} [hairStyle]
 * @property {string[]} [clothing]
 * @property {boolean} [glasses]
 * @property {string} [consentRef]  Opaque consent reference, echoed on the `_consent` receipt.
 * @property {string} [agentScope]  An agent id. Tags the item with that agent so `list({ agentScope })` can include it. A non-empty string. Omit for an unscoped item. Not access control.
 */

export class Catalog {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * List catalog items. READ. Async-iterable + awaitable (first page).
   * `filter` keys and `orderBy` values: docs/api/design.md#browse-the-catalog.
   * `orderBy: '-createdAt'` sorts newest first. `'+createdAt'` is accepted but
   * does not change the order. `agentScope` is an agent id: without it the list
   * holds only unscoped items. With an agent id it holds the unscoped items plus
   * that agent's own. An unknown agent id is not an error.
   * `opts.type` is a shortcut for `filter.typeEqual`. Passing both with different
   * values throws `bad_request` before any network call.
   * @example <caption>Newest voices first</caption>
   * const voices = await k.catalog.list(adminKs, { type: 'Voice', orderBy: '-createdAt' }).all();
   * @param {string} ks
   * @param {{type?:'Visual'|'Voice'|'Face'|'Background', filter?:CatalogListFilter, orderBy?:'+createdAt'|'-createdAt', agentScope?:string, pageSize?:number}} [opts]
   */
  list(ks, opts = {}) {
    this._.assertAdmin(ks, 'catalog.list');
    const filter = catalogFilter(opts);
    const base = {
      ...(filter ? { filter } : {}),
      ...(opts.orderBy ? { orderBy: opts.orderBy } : {}),
      ...(opts.agentScope ? { agentScope: opts.agentScope } : {}),
    };
    return paginate({
      style: 'offset', pageSize: opts.pageSize ?? 100,
      fetchPage: (pager) => this._.agentic('catalog-item/list', { ...base, pager }, ks).then((r) => r.data),
    });
  }

  /** Get one catalog item. READ. @param {string} itemId @param {string} ks */
  async get(itemId, ks) {
    this._.assertAdmin(ks, 'catalog.get');
    return (await this._.agentic('catalog-item/get', { itemId }, ks)).data;
  }

  /**
   * Clone a CUSTOM VOICE from an uploaded sample. WRITE, NOT idempotent.
   * Requirements: MP3 44.1 kHz, at least about 6 s of clear speech, ≤10 MB, NON-EMPTY
   * description (a clip under about 6 s fails with a server error). The returned
   * `itemId` is the clone — pair it with any avatar's `voice.id`. The item is
   * tagged `adminTags:["custom"]`.
   *
   * @example <caption>End-to-end: clone a voice → fetch it by id → use it on an avatar</caption>
   * const clone = await k.catalog.createVoice(
   *   mp3File,
   *   { name: 'Narrator', description: 'Calm documentary narrator', consentRef: 'consent://signed/2026-001' },
   *   adminKs,
   * );
   * const [item] = await k.catalog.list(adminKs, { filter: { itemIdEqual: clone.itemId } });
   * const avatar = await k.avatars.create(
   *   { voice: { id: clone.itemId }, visual: { id: presetVisualId } },
   *   adminKs,
   * );
   *
   * @param {Blob|File} file
   * @param {{name:string,description:string,language?:string,consentRef?:string,agentScope?:string}} attrs  `agentScope`: an agent id that tags the item for `list({ agentScope })`. A non-empty string, or omit it. Anything else throws `validation_error` before any request. It is not access control. `language`: a language code, for example `'en'` or `'he'`; defaults to `'en'`. A code outside the accepted list returns `bad_request` (400), and the error lists the accepted codes. `consentRef`: an opaque URI/attestation id for the source individual's voice-clone consent (NO FAKES Act / CA AB 1836 / FTC impersonation). Echoed on the result `_consent` receipt + audit; the SDK can't verify it but carries it auditably.
   * @param {string} ks
   */
  async createVoice(file, attrs, ks) {
    this._.assertAdmin(ks, 'catalog.createVoice');
    if (!attrs?.description) {
      throw new KalturaError({ type: 'about:blank', title: 'description required', code: 'bad_request', detail: 'Voice clone requires a non-empty description (the clone backend rejects empty).' });
    }
    const agentScope = assertAgentScope(attrs.agentScope, 'catalog.createVoice');
    const attributes = { voice: { name: attrs.name, description: attrs.description, language: attrs.language || 'en' } };
    return this._upload(file, attributes, ks, 'audio/mpeg', attrs.consentRef, 'voice', undefined, agentScope);
  }

  /**
   * Upload a CUSTOM VISUAL image. WRITE — NOT idempotent. The uploaded image
   * becomes the catalog item's visual content, usable in {@link Avatars.create}
   * and in live animated sessions via `avatar-session/create`. The API itself
   * accepts any subset of the attribute fields below, including none — the SDK
   * requires `name` and `genderPresentation` client-side (a catalog item without
   * either is confusing to browse and manage) and defaults the rest to a
   * consistent baseline look.
   * NAME COLLISION: `attrs.background` here is a photo ATTRIBUTE string (e.g.
   * `'Image'`) describing the uploaded photo's backdrop — unrelated to
   * {@link Avatars#create}'s `body.background`, the `{type:'color'|'visual',
   * value}` composition selector used to compose a Visual from a Face.
   * @param {Blob|File} file
   * @param {VisualAttrs} attrs  `consentRef`: an opaque URI/attestation id for likeness consent — echoed on the result `_consent` receipt + audit (same contract as {@link createVoice}). The SDK records it; it does not verify it.
   * @param {string} ks
   */
  async createVisual(file, attrs, ks) {
    this._.assertAdmin(ks, 'catalog.createVisual');
    if (!attrs?.name) {
      throw new KalturaError({ type: 'about:blank', title: 'name required', code: 'bad_request', detail: 'catalog.createVisual requires attrs.name (a catalog item without a name is confusing to browse and manage).' });
    }
    if (attrs?.genderPresentation !== 'Masculine' && attrs?.genderPresentation !== 'Feminine') {
      throw new KalturaError({ type: 'about:blank', title: 'genderPresentation required', code: 'bad_request', detail: `catalog.createVisual requires attrs.genderPresentation to be 'Masculine' or 'Feminine', got ${JSON.stringify(attrs?.genderPresentation)}.` });
    }
    const agentScope = assertAgentScope(attrs.agentScope, 'catalog.createVisual');
    const attributes = { visual: visualAttrs(attrs) };
    return this._upload(file, attributes, ks, undefined, attrs.consentRef, 'visual', undefined, agentScope);
  }

  /**
   * Upload a CUSTOM face image as an explicit `Face`-typed catalog item, for
   * the two-step `face` + `background` avatar composition ({@link
   * Avatars#create}). WRITE — NOT idempotent. Distinct from
   * {@link createVisual}: `createVisual` uploads a photo directly as a
   * ready-to-use Visual — already a full custom digital twin. `createFace` /
   * {@link createBackground} instead produce the two composable HALVES the
   * `face`/`background` avatar fields expect. This is the only way to add a
   * custom Face. Same attribute shape as `createVisual` (the `visual`
   * attribute shape). Free-text fields (`name`, `hairStyle`, `clothing`) are sent
   * to the server as given. The SDK does not trim, escape or check them.
   *
   * NAME COLLISION: `attrs.background` here is a photo ATTRIBUTE string (e.g.
   * `'Image'`) describing this upload's own backdrop — unrelated to
   * {@link Avatars#create}'s `body.background`, the composition selector you
   * pass separately (alongside this method's `itemId`) to compose the Face
   * over a Background.
   * @param {Blob|File} file
   * @param {VisualAttrs} attrs
   * @param {string} ks
   */
  async createFace(file, attrs, ks) {
    this._.assertAdmin(ks, 'catalog.createFace');
    const agentScope = assertAgentScope(attrs.agentScope, 'catalog.createFace');
    const attributes = { visual: visualAttrs(attrs) };
    return this._upload(file, attributes, ks, undefined, attrs.consentRef, 'face', 'Face', agentScope);
  }

  /**
   * Upload a CUSTOM background image as an explicit `Background`-typed
   * catalog item, for the two-step `face` + `background` avatar composition
   * ({@link Avatars#create}). WRITE, NOT idempotent. Same attribute shape
   * as {@link createVisual}/{@link createFace} (the `visual` attribute shape).
   *
   * NAME COLLISION: `attrs.background` here is a photo ATTRIBUTE string (e.g.
   * `'Image'`) describing this upload's own backdrop — unrelated to
   * {@link Avatars#create}'s `body.background`, the composition selector this
   * item's `itemId` is passed as `value` for.
   * @param {Blob|File} file
   * @param {VisualAttrs} attrs
   * @param {string} ks
   */
  async createBackground(file, attrs, ks) {
    this._.assertAdmin(ks, 'catalog.createBackground');
    const agentScope = assertAgentScope(attrs.agentScope, 'catalog.createBackground');
    const attributes = { visual: visualAttrs(attrs) };
    return this._upload(file, attributes, ks, undefined, attrs.consentRef, 'background', 'Background', agentScope);
  }

  /**
   * Import an existing ElevenLabs voice by its provider voiceId as a new Voice
   * catalog item — no audio upload, no re-clone. WRITE — NOT idempotent (each
   * call creates a new catalog item). An unknown voiceId creates NOTHING: the
   * server replies HTTP 200 with an error body
   * (`VOICE_DOES_NOT_EXIST_ON_ELEVEN_LABS`), which the transport raises as a
   * typed error with `code:'voice_not_found_elevenlabs'`. A voice with no audio
   * samples raises `voice_has_no_samples`: upload an audio file with
   * {@link createVoice} instead.
   * @param {string} voiceId The provider-side ElevenLabs voice id.
   * @param {string} ks (admin)
   * @returns {Promise<object>} The created Voice catalog item.
   */
  async importVoiceFromElevenLabs(voiceId, ks) {
    this._.assertAdmin(ks, 'catalog.importVoiceFromElevenLabs');
    requireVoiceId(voiceId, 'catalog.importVoiceFromElevenLabs');
    return (await this._.agentic('catalog-item/createVoiceFromElevenLabs', { voiceId }, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Import an existing Cartesia voice by its provider voiceId as a new Voice
   * catalog item. WRITE — NOT idempotent. Same contract as
   * {@link importVoiceFromElevenLabs}: an unknown voiceId creates NOTHING and
   * raises a typed error with `code:'voice_not_found_cartesia'`
   * (`VOICE_DOES_NOT_EXIST_ON_CARTESIA`, HTTP-200 exception envelope). A voice
   * with no audio samples raises `voice_has_no_samples`.
   * @param {string} voiceId The provider-side Cartesia voice id.
   * @param {string} ks (admin)
   * @returns {Promise<object>} The created Voice catalog item.
   */
  async importVoiceFromCartesia(voiceId, ks) {
    this._.assertAdmin(ks, 'catalog.importVoiceFromCartesia');
    requireVoiceId(voiceId, 'catalog.importVoiceFromCartesia');
    return (await this._.agentic('catalog-item/createVoiceFromCartesia', { voiceId }, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Update a CUSTOM catalog item (presets are read-only → 404). WRITE —
   * idempotent. JSON body unless a `file` is given (then multipart). A full
   * `attributes` object is re-validated (e.g. a Voice needs a non-empty
   * description). `agentScope` is an agent id that tags the item for
   * `list({ agentScope })`: omit it to leave the scope as it is, pass `''` to
   * clear it. Any other value that is not a non-blank string throws
   * `validation_error` before any request. It is not access control.
   * @param {{itemId:string, attributes?:object, adminTags?:string[], file?:Blob|File, agentScope?:string}} opts
   * @param {string} ks
   */
  async update(opts, ks) {
    this._.assertAdmin(ks, 'catalog.update');
    const agentScope = assertAgentScope(opts.agentScope, 'catalog.update', true);
    if (opts.file) {
      const fd = newFormData();
      fd.append('itemId', opts.itemId);
      fd.append('file', opts.file);
      if (opts.attributes) fd.append('attributes', JSON.stringify(opts.attributes));
      // Multipart adminTags needs one repeated field per tag, NOT a comma-joined
      // string or JSON.stringify (see _upload's adminTags note).
      if (opts.adminTags) appendAdminTags(fd, opts.adminTags);
      if (agentScope !== undefined) fd.append('agentScope', agentScope);
      return (await this._.agenticMultipart('catalog-item/update', fd, ks)).data;
    }
    const body = { itemId: opts.itemId };
    // The JSON-body endpoint expects `attributes` JSON-encoded as a STRING
    // (same requirement as the multipart path) — a raw nested object 400s
    // with "attributes must be a valid JSON string".
    if (opts.attributes) body.attributes = JSON.stringify(opts.attributes);
    if (opts.adminTags) body.adminTags = opts.adminTags;
    if (agentScope !== undefined) body.agentScope = agentScope;
    return (await this._.agentic('catalog-item/update', body, ks)).data;
  }

  /** Delete a custom catalog item. WRITE — DESTRUCTIVE. @param {string} itemId @param {string} ks @param {{confirmPermanent:boolean}} confirm */
  async delete(itemId, ks, confirm) {
    this._.assertAdmin(ks, 'catalog.delete');
    requireConfirm(confirm, 'catalog.delete', itemId);
    return (await this._.agentic('catalog-item/delete', { itemId }, ks)).data;
  }

  /**
   * Multipart upload primitive for createVoice, createVisual, createFace and
   * createBackground. Tags go out as one
   * `adminTags` field per tag.
   * @param {Blob|File} file @param {object} attributes @param {import('./client.js').KsLike} ks @param {string} [mime]
   * @param {string} [consentRef] @param {string} [kind] @param {string} [type] Explicit catalog item type (`'Face'`/`'Background'`) — required for those two, since an image MIME alone defaults to `Visual`. Omitted for voice/visual: the API infers the type from the uploaded file's own content (image → Visual, audio → Voice), not from `attributes`.
   * @param {string} [agentScope] Already validated by the caller. Sent as its own field when set.
   */
  async _upload(file, attributes, ks, mime, consentRef, kind, type, agentScope) {
    const fd = newFormData();
    fd.append('file', file, fileName(file, mime));
    fd.append('attributes', JSON.stringify(attributes));
    if (type) fd.append('type', type);
    if (agentScope !== undefined) fd.append('agentScope', agentScope);
    appendAdminTags(fd, ['custom']);
    const data = (await this._.agenticMultipart('catalog-item/create', fd, ks, { idempotencyKey: uuidv4() })).data;
    // Carry the (operator-supplied) cloning-consent reference as an auditable receipt
    // (NO FAKES Act / FTC impersonation). The SDK doesn't verify it — it records it.
    if (consentRef && data && typeof data === 'object') {
      data._consent = { consentRef: String(consentRef), recordedAt: meta({ partnerId: this._.partnerId, source: 'catalog/clone-consent', scope: kind }).generatedAt };
      this._.audit?.('clone.consent', 'success', { action: kind, target: data.itemId, reason: 'consentRef recorded' });
    }
    return data;
  }
}

/**
 * Shared 9-field `visual` attributes object for createVisual/createFace/createBackground.
 * @param {VisualAttrs} attrs
 */
function visualAttrs(attrs) {
  return {
    name: attrs.name, background: attrs.background || 'Image', genderPresentation: attrs.genderPresentation,
    skinTone: attrs.skinTone || 'Light', ageGroup: attrs.ageGroup || 'YoungAdult', hairColor: attrs.hairColor || 'Brown',
    hairStyle: attrs.hairStyle || ['Short'], clothing: attrs.clothing || ['Casual'], glasses: attrs.glasses ?? false,
  };
}

/**
 * Build the `filter` for `catalog.list`: the caller's `filter` copied, with `type` merged in as `typeEqual`.
 * @param {{type?:string, filter?:object}} opts @returns {object|undefined}
 */
function catalogFilter(opts) {
  const f = opts.filter;
  if (f !== null && f !== undefined && (typeof f !== 'object' || Array.isArray(f))) {
    const got = Array.isArray(f) ? 'an array' : `a ${typeof f}`;
    throw new KalturaError({ type: 'about:blank', title: 'filter must be an object', code: 'bad_request', detail: `catalog.list: opts.filter must be an object, for example { typeEqual: 'Voice' }. Got ${got}.` });
  }
  if (opts.type && f?.typeEqual && f.typeEqual !== opts.type) {
    throw new KalturaError({ type: 'about:blank', title: 'conflicting type', code: 'bad_request', detail: `catalog.list: opts.type is '${opts.type}' but opts.filter.typeEqual is '${f.typeEqual}'. Pass only one of them.` });
  }
  const merged = { ...f, ...(opts.type ? { typeEqual: opts.type } : {}) };
  return Object.keys(merged).length ? merged : undefined;
}

/**
 * Check an `agentScope` value before the network. `undefined` passes through (field omitted).
 * A non-blank string passes. `''` passes only where `allowEmpty` is set (update: clears the scope).
 * @param {unknown} v @param {string} where @param {boolean} [allowEmpty] @returns {string|undefined}
 */
function assertAgentScope(v, where, allowEmpty = false) {
  if (v === undefined) return undefined;
  if (typeof v === 'string' && (v.trim() !== '' || (allowEmpty && v === ''))) return v;
  const want = allowEmpty ? "a non-blank string (an agent id), or '' to clear the scope" : 'a non-blank string (an agent id)';
  throw new KalturaError({
    type: 'https://docs.kaltura.com/agentic/errors/validation_error', title: 'invalid agentScope', code: 'validation_error',
    detail: `${where}: agentScope must be ${want}. Omit it to leave it unset.`,
  });
}

/** @param {unknown} v @param {string} where */
function requireVoiceId(v, where) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} voiceId must be a non-empty string (the provider-side voice id).` });
  }
  if (!/^[A-Za-z0-9_-]+$/.test(v)) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} voiceId must contain only letters, digits, "_" or "-". Copy the id from the voice provider's dashboard.` });
  }
}

/**
 * Construct a global `FormData` instance, or throw a typed error if the
 * runtime doesn't provide one (Node <18 without a polyfill, or a non-browser,
 * non-Node host). Shared by every management resource that multipart-uploads
 * bytes (catalog visual/voice uploads, knowledge document uploads) so the
 * "no FormData" failure mode has one canonical shape.
 * @param {string} [detail] Caller-specific detail text for the thrown error.
 * @returns {FormData}
 */
export function newFormData(detail = 'Uploads need global FormData (Node ≥18 / browser).') {
  if (typeof FormData === 'undefined') {
    throw new KalturaError({ type: 'about:blank', title: 'FormData unavailable', code: 'no_formdata', detail });
  }
  return new FormData();
}

/**
 * Append `adminTags` to a multipart FormData the way the API expects for
 * MULTIPLE values: one `adminTags` field per tag (a repeated multipart field
 * name), never a single comma-joined string. The API parses a bare scalar
 * field into a one-element array, but does NOT split a comma-joined value —
 * `fd.append('adminTags', 'a,b')` stores ONE literal tag `"a,b"`, not two.
 * `JSON.stringify(tags)` is wrong too: it double-encodes (stored as
 * `["[\"custom\"]"]`, which is not the tag you sent). JSON BODY requests
 * carry a real array and must NOT use this.
 * @param {FormData} fd @param {string[]} tags
 */
function appendAdminTags(fd, tags) {
  const list = Array.isArray(tags) ? tags : [tags];
  for (const t of list) fd.append('adminTags', String(t));
}
/** @param {Blob|File} file @param {string} [mime] */
function fileName(file, mime) {
  const name = /** @type {any} */ (file).name;
  if (name) return name;
  return mime === 'audio/mpeg' ? 'voice.mp3' : 'upload.bin';
}
