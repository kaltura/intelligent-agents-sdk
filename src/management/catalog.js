/**
 * Catalog — the preset library of visuals (faces) and voices, plus custom
 * uploads. Agentic host, admin token. Source: API-REFERENCE §1.1–§1.3b.
 *
 * IMPORTANT asymmetry: an uploaded VOICE clones for real (ElevenLabs)
 * and is immediately usable as a live voice. An uploaded VISUAL image becomes the
 * catalog item's visual content and is usable in avatar/create and avatar-session/create
 * for live animated sessions.
 */
import { paginate } from './paginate.js';
import { uuidv4, meta } from '../core/ids.js';
import { requireConfirm } from './agents.js';
import { KalturaError } from '../core/errors.js';

export class Catalog {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /** List catalog items. READ. @param {string} ks @param {{type?:'Visual'|'Voice',pageSize?:number}} [opts] */
  list(ks, opts = {}) {
    this._.assertAdmin(ks, 'catalog.list');
    const filter = opts.type ? { typeEqual: opts.type } : undefined;
    return paginate({
      style: 'offset', pageSize: opts.pageSize ?? 100,
      fetchPage: (pager) => this._.agentic('catalog-item/list', filter ? { filter, pager } : { pager }, ks).then((r) => r.data),
    });
  }

  /** Get one catalog item. READ. @param {string} itemId @param {string} ks */
  async get(itemId, ks) {
    this._.assertAdmin(ks, 'catalog.get');
    return (await this._.agentic('catalog-item/get', { itemId }, ks)).data;
  }

  /**
   * Clone a CUSTOM VOICE (real ElevenLabs clone). WRITE — NOT idempotent.
   * Requirements: MP3 44.1 kHz, ≥~6 s of clear speech, ≤10 MB, NON-EMPTY
   * description (a too-short clip 500s from the clone backend). The returned
   * `itemId` is the clone — pair it with any avatar's `voice.id`. The item is
   * tagged `adminTags:['custom']` in the single-parse shape, so it is reliably
   * findable by `catalog.list` filtered on that tag (see {@link appendAdminTags}).
   *
   * @example <caption>End-to-end: clone a voice → confirm it's tagged+findable → use it on an avatar</caption>
   * const clone = await k.catalog.createVoice(
   *   mp3File,
   *   { name: 'Narrator', description: 'Calm documentary narrator', consentRef: 'consent://signed/2026-001' },
   *   adminKs,
   * );
   * // round-trip: the 'custom' tag must find the just-cloned item
   * const customVoices = await k.catalog.list(adminKs, { type: 'Voice' }).all();
   * const found = customVoices.find((v) => v.itemId === clone.itemId);  // truthy — tag parsed once
   * const avatar = await k.avatars.create(
   *   { voice: { id: clone.itemId }, visual: { id: presetVisualId } },
   *   adminKs,
   * );
   *
   * @param {Blob|File} file
   * @param {{name:string,description:string,language?:string,consentRef?:string}} attrs  `language`: ISO 639-1 code (e.g. `'en'`, `'he'`), defaults to `'en'`. `consentRef`: an opaque URI/attestation id for the source individual's voice-clone consent (NO FAKES Act / CA AB 1836 / FTC impersonation). Echoed on the result `_consent` receipt + audit; the SDK can't verify it but carries it auditably.
   * @param {string} ks
   */
  async createVoice(file, attrs, ks) {
    this._.assertAdmin(ks, 'catalog.createVoice');
    if (!attrs?.description) {
      throw new KalturaError({ type: 'about:blank', title: 'description required', code: 'bad_request', detail: 'Voice clone requires a non-empty description (the clone backend rejects empty).' });
    }
    const attributes = { voice: { name: attrs.name, description: attrs.description, language: attrs.language || 'en' } };
    return this._upload(file, attributes, ks, 'audio/mpeg', attrs.consentRef, 'voice');
  }

  /**
   * Upload a CUSTOM VISUAL image. WRITE — NOT idempotent. The uploaded image
   * becomes the catalog item's visual content, usable in {@link Avatars.create}
   * and in live animated sessions via `avatar-session/create`. All visual
   * attribute fields are required or the API 400s.
   * @param {Blob|File} file
   * @param {{name:string,genderPresentation:'Masculine'|'Feminine',background?:string,skinTone?:string,ageGroup?:string,hairColor?:string,hairStyle?:string[],clothing?:string[],glasses?:boolean,consentRef?:string}} attrs  `consentRef`: an opaque URI/attestation id for likeness consent — echoed on the result `_consent` receipt + audit (same contract as {@link createVoice}). The SDK records it; it does not verify it.
   * @param {string} ks
   */
  async createVisual(file, attrs, ks) {
    this._.assertAdmin(ks, 'catalog.createVisual');
    const attributes = { visual: {
      name: attrs.name, background: attrs.background || 'Image', genderPresentation: attrs.genderPresentation,
      skinTone: attrs.skinTone || 'Light', ageGroup: attrs.ageGroup || 'YoungAdult', hairColor: attrs.hairColor || 'Brown',
      hairStyle: attrs.hairStyle || ['Short'], clothing: attrs.clothing || ['Casual'], glasses: attrs.glasses ?? false,
    } };
    return this._upload(file, attributes, ks, undefined, attrs.consentRef, 'visual');
  }

  /**
   * Import an existing ElevenLabs voice by its provider voiceId as a new Voice
   * catalog item — no audio upload, no re-clone. WRITE — NOT idempotent (each
   * call creates a new catalog item). An unknown voiceId creates NOTHING: the
   * server replies HTTP 200 with a `KalturaAPIException` envelope
   * (`VOICE_DOES_NOT_EXIST_ON_ELEVEN_LABS`), which the transport raises as a
   * typed error with `code:'voice_not_found_elevenlabs'`.
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
   * (`VOICE_DOES_NOT_EXIST_ON_CARTESIA`, HTTP-200 exception envelope).
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
   * description).
   * @param {object} opts {itemId, attributes?, adminTags?, file?}
   * @param {string} ks
   */
  async update(opts, ks) {
    this._.assertAdmin(ks, 'catalog.update');
    if (opts.file) {
      const fd = newFormData();
      fd.append('itemId', opts.itemId);
      fd.append('file', opts.file);
      if (opts.attributes) fd.append('attributes', JSON.stringify(opts.attributes));
      // Multipart adminTags is parsed as a comma-separated bare string — send the
      // single-parse shape, NOT JSON.stringify (see _upload's adminTags note).
      if (opts.adminTags) appendAdminTags(fd, opts.adminTags);
      return (await this._.agenticMultipart('catalog-item/update', fd, ks)).data;
    }
    const body = { itemId: opts.itemId };
    if (opts.attributes) body.attributes = opts.attributes;
    if (opts.adminTags) body.adminTags = opts.adminTags;
    return (await this._.agentic('catalog-item/update', body, ks)).data;
  }

  /** Delete a custom catalog item. WRITE — DESTRUCTIVE. @param {string} itemId @param {string} ks @param {{confirmPermanent:boolean}} confirm */
  async delete(itemId, ks, confirm) {
    this._.assertAdmin(ks, 'catalog.delete');
    requireConfirm(confirm, 'catalog.delete', itemId);
    return (await this._.agentic('catalog-item/delete', { itemId }, ks)).data;
  }

  /**
   * Multipart upload primitive for createVoice/createVisual.
   *
   * adminTags ENCODING: the multipart
   * `adminTags` field is parsed by the API as a COMMA-SEPARATED bare string into
   * an array — so the value must be the bare `custom` (parsed once → stored
   * `["custom"]`), NOT `JSON.stringify(['custom'])`. Sending the JSON string
   * `["custom"]` makes the API re-wrap it, storing `["[\"custom\"]"]`, so the
   * item is then NOT findable by `catalog.list` filtered on `adminTagsIn:
   * ['custom']`. Use {@link appendAdminTags} for the correct single-parse shape.
   * (Also documented in API-REFERENCE §1.1, keep both in sync.)
   * @param {Blob|File} file @param {object} attributes @param {import('./client.js').KsLike} ks @param {string} [mime]
   * @param {string} [consentRef] @param {string} [kind]
   */
  async _upload(file, attributes, ks, mime, consentRef, kind) {
    const fd = newFormData();
    fd.append('file', file, fileName(file, mime));
    fd.append('attributes', JSON.stringify(attributes));
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

/** @param {unknown} v @param {string} where */
function requireVoiceId(v, where) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} voiceId must be a non-empty string (the provider-side voice id).` });
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
 * Append `adminTags` to a multipart FormData in the single-parse shape the API
 * expects: a COMMA-SEPARATED bare string (e.g. `custom` or `a,b`). The multipart
 * endpoint parses this field into an array itself — passing `JSON.stringify(tags)`
 * double-encodes it (stored as `["[\"custom\"]"]`, then unfindable by
 * `adminTagsIn`). JSON BODY requests carry a real array and must NOT use this.
 * @param {FormData} fd @param {string[]} tags
 */
function appendAdminTags(fd, tags) {
  const list = Array.isArray(tags) ? tags : [tags];
  fd.append('adminTags', list.map((t) => String(t)).join(','));
}
/** @param {Blob|File} file @param {string} [mime] */
function fileName(file, mime) {
  const name = /** @type {any} */ (file).name;
  if (name) return name;
  return mime === 'audio/mpeg' ? 'voice.mp3' : 'upload.bin';
}
