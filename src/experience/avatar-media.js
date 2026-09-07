/**
 * AvatarMedia — routes the STV downlink's two tracks (video + audio) to the app's media
 * elements. Internal: `KalturaAvatarSession` / `KalturaScriptedVideoSession` own one each
 * and expose it through their public media API (`setVideoEl`, `setAudioEl`, `avatarStream`,
 * `muteAudioOutput`, `setAudioOutputVolume`, `setAudioOutput`, `startPlayback`).
 *
 * Why it exists: WHEP delivers the two tracks in two `pc.ontrack` events whose
 * `e.streams[0]` are NOT guaranteed to be the same MediaStream, so assigning
 * `videoEl.srcObject = e.streams[0]` per event silently drops whichever track landed first.
 *
 * Three SDK-built streams, all fed from the same tracks:
 *  - `C` (canonical, `stream`): every live downlink track. What `session.avatarStream` returns.
 *  - `V`: what `videoEl` plays — video, plus audio when there is no `audioEl`.
 *  - `A`: what `audioEl` plays — audio only (split mode).
 * Each element gets `srcObject` set once and `play()` called once per binding. A recovery
 * (STV re-subscribe) swaps the tracks inside the streams; an element still holding its SDK
 * stream is never touched, one whose `srcObject` the app replaced is bound again.
 *
 * Only writes `srcObject`, `play()`, and, through the SDK's own methods, `muted`, `volume`,
 * `setSinkId()`. No DOM lookups, no timers, no `console`; a bare `{ play() }` object is
 * enough to bind. Never throws from `attach()` for a missing browser feature —
 * only for a bad argument, which the session surfaces as a `media_attach_failed` warning.
 */
import { KalturaError } from '../core/errors.js';

/**
 * @typedef {object} AvatarMediaWarning
 * @property {'playback_blocked'} code
 * @property {string} message  Actionable text, always a string.
 * @property {'video'|'audio'} kind  Which element's `play()` was refused.
 */

/** @param {string} method @param {string} detail */
const badRequest = (method, detail) => new KalturaError({ type: 'about:blank', title: 'invalid argument', code: 'bad_request', detail: `${method}: ${detail}` });

export class AvatarMedia {
  /**
   * @param {object} cfg
   * @param {any} [cfg.videoEl]  Element that renders the avatar (video + audio unless `audioEl` is set).
   * @param {any} [cfg.audioEl]  Optional dedicated element for the audio track (split mode).
   * @param {typeof MediaStream} [cfg.mediaStreamConstructor]  Default `globalThis.MediaStream`.
   * @param {(w: AvatarMediaWarning) => void} [cfg.onWarning]
   * @param {(level: string, msg: string, data?: any) => void} [cfg.log]
   */
  constructor({ videoEl = null, audioEl = null, mediaStreamConstructor, onWarning, log } = {}) {
    this._MediaStream = mediaStreamConstructor || globalThis.MediaStream || null;
    this._onWarning = onWarning || (() => {});
    this._log = log || (() => {});
    this._videoEl = this._checkEl('new AvatarMedia({ videoEl })', videoEl);
    this._audioEl = this._checkEl('new AvatarMedia({ audioEl })', audioEl);
    /** @type {any} */ this._c = null;
    /** @type {any} */ this._v = null;
    /** @type {any} */ this._a = null;
    /** @type {boolean|null} */ this._muted = null;   // null = the SDK never touched it
    /** @type {number|null} */ this._volume = null;
    /** @type {string|null} */ this._sinkId = null;
  }

  /** Canonical stream with every live downlink track, or `null` before the first track / after teardown. @returns {MediaStream|null} */
  get stream() { return this._c; }
  /** @returns {any} */ get videoEl() { return this._videoEl; }
  /** @returns {any} */ get audioEl() { return this._audioEl; }
  /** @returns {boolean} */ get muted() { return this._muted ?? !!this._sink()?.muted; }
  /** @returns {number} */ get volume() { return this._volume ?? (this._sink()?.volume ?? 1); }

  /**
   * Route one downlink track. Same track twice is a no-op; a second track of the same kind
   * replaces (and stops) the previous one inside the existing streams, so a live element
   * keeps its `srcObject`. Binds any configured element on the first call, and re-binds one
   * whose `srcObject` the app has since replaced.
   * @param {any} track  MediaStreamTrack (`kind` 'video' | 'audio').
   * @param {any[]} [streams]  `e.streams` from `ontrack`; only used when no MediaStream constructor exists.
   * @throws {KalturaError} `bad_request` for a track without a valid `kind`.
   */
  attach(track, streams) {
    if (!track || (track.kind !== 'video' && track.kind !== 'audio')) throw badRequest('attach(track)', "track.kind must be 'video' or 'audio'.");
    if (this._c?.getTracks().includes(track)) return;
    if (!this._c) this._c = this._newStream() ?? this._fallbackStream(streams);
    for (const old of this._c.getTracks()) {
      if (old === track || old.kind !== track.kind) continue;   // `old === track` only in fallback mode, where C is the receiver stream
      this._c.removeTrack(old); this._v?.removeTrack(old); this._a?.removeTrack(old);
      old.stop?.();
    }
    if (!this._c.getTracks().includes(track)) this._c.addTrack(track);
    // Bind on the first track, or again when the app replaced `srcObject` itself (main re-assigned
    // it on every track, so a self-nulled element got the picture back on recovery; keep that).
    if (this._videoEl && (!this._v || this._videoEl.srcObject !== this._v)) this._bind('video');
    if (this._audioEl && (!this._a || this._audioEl.srcObject !== this._a)) this._bind('audio');
    this._sync();
  }

  /**
   * Swap or drop the video element at any time. The old element's `srcObject` is set to
   * `null`; the new one gets a fresh stream, `srcObject`, and one `play()` when tracks exist.
   * @param {any} el  Media element or `null`.
   * @throws {KalturaError} `bad_request` for anything else.
   */
  setVideoEl(el) {
    el = this._checkEl('setVideoEl(el)', el);
    if (el === this._videoEl) return;
    if (this._v) { this._videoEl.srcObject = null; this._v = null; }
    this._videoEl = el;
    if (this._c && el) this._bind('video'); else { this._sync(); this._applyAudioSettings(); }
  }

  /**
   * Split the audio track onto its own element, or pass `null` to merge it back into the
   * video element. Stored mute / volume / sink id follow the audio to the new element.
   * @param {any} el  Media element or `null`.
   * @throws {KalturaError} `bad_request` for anything else.
   */
  setAudioEl(el) {
    el = this._checkEl('setAudioEl(el)', el);
    if (el === this._audioEl) return;
    if (this._a) { this._audioEl.srcObject = null; this._a = null; }
    this._audioEl = el;
    if (this._c && el) this._bind('audio'); else { this._sync(); this._applyAudioSettings(); }
  }

  /** Mute or unmute the element that carries the audio track. Works before connect and survives rebinds. @param {boolean} on */
  setMuted(on) { this._muted = !!on; this._applyAudioSettings(); }

  /**
   * Set playback volume on the element that carries the audio track (clamped to 0..1).
   * @param {number} v
   * @throws {KalturaError} `bad_request` when `v` is not a finite number.
   */
  setVolume(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw badRequest('setVolume(v)', 'v must be a finite number between 0 and 1.');
    this._volume = Math.min(1, Math.max(0, v));
    this._applyAudioSettings();
  }

  /**
   * Route audio to an output device. The id is stored once the element accepts it (or when no
   * element can apply it yet) and re-applied when the audio element changes; a rejected id
   * leaves the previous one in place.
   * @param {string} deviceId  From `enumerateDevices()`, or `''` for the system default (the spec
   *   value; Firefox rejects Chromium's `'default'` pseudo-id with NotFoundError).
   * @returns {Promise<boolean>}  `false` (never throws) when the element has no `setSinkId` or it rejects.
   * @throws {KalturaError} `bad_request` when `deviceId` is not a string.
   */
  async setSinkId(deviceId) {
    if (typeof deviceId !== 'string') throw badRequest('setSinkId(deviceId)', 'deviceId must be a string (from enumerateDevices()).');
    const el = this._sink();
    if (!el || typeof el.setSinkId !== 'function') { this._sinkId = deviceId; this._log('warn', 'avatar-media: setSinkId unavailable on the audio output element'); return false; }
    try { if (el.sinkId !== deviceId) await el.setSinkId(deviceId); } catch (err) {
      if (el !== this._sink()) return this.setSinkId(deviceId);   // the audio element changed while the device call was pending (Chromium aborts it): apply to the new one
      this._log('warn', 'avatar-media: setSinkId rejected', { message: String(err?.message || err) }); return false;
    }
    this._sinkId = deviceId;
    if (el !== this._sink()) this._applyAudioSettings();   // the audio element changed while the device call was pending: follow it
    return true;
  }

  /**
   * Retry `play()` on every bound element that is not already playing — call from a user
   * gesture after a `playback_blocked` warning.
   * @returns {Promise<boolean>}  `true` when every bound element is playing afterwards; `false` when nothing is bound yet or a `play()` was refused again.
   */
  async resumePlayback() {
    const els = [this._v && this._videoEl, this._a && this._audioEl].filter(Boolean);
    let ok = els.length > 0;
    for (const el of els) {
      if (el.paused === false) continue;
      try { await el.play(); } catch (err) { ok = false; this._log('debug', 'avatar-media: play() rejected again', { name: err?.name }); }
    }
    return ok;
  }

  /** Stop every downlink track and clear `srcObject` on the bound elements. Keeps element bindings and stored audio settings. Idempotent. */
  teardown() {
    if (!this._c) return;
    for (const t of this._c.getTracks()) t.stop?.();
    if (this._v && this._videoEl) this._videoEl.srcObject = null;
    if (this._a && this._audioEl) this._audioEl.srcObject = null;
    this._c = this._v = this._a = null;
  }

  // ───────────────────────────── internals ─────────────────────────────

  /** @param {string} method @param {any} el */
  _checkEl(method, el) {
    if (el == null) return null;
    // Duck-typed on `play()` only: jsdom media elements have `play()` but no `srcObject`.
    if (typeof el === 'object' && typeof el.play === 'function') return el;
    throw badRequest(method, `expected null or a media element (an object with a play() method), got ${typeof el}.`);
  }
  /** The element that carries the audio track right now (bound or not). */
  _sink() { return this._audioEl ?? this._videoEl; }
  _newStream() { return this._MediaStream ? new this._MediaStream() : null; }
  /** No MediaStream constructor (non-browser test hosts): reuse the receiver's stream as C and V. */
  _fallbackStream(streams) {
    const s = streams?.[0];
    if (!s) throw badRequest('attach(track, streams)', 'no MediaStream constructor and no receiver stream to fall back to.');
    this._log('debug', 'avatar-media: no MediaStream constructor, using the receiver stream directly (test-only fallback)');
    return s;
  }
  /**
   * Bind `videoEl` (kind 'video') or `audioEl` (kind 'audio'): the kind's stream (fresh on the
   * first bind, reused when re-binding an element the app unhooked), tracks, stored audio
   * settings, srcObject once, play() once. Settings go first so a muted app never trips autoplay.
   * A late `play()` rejection only counts while this binding is still the live one.
   * @param {'video'|'audio'} kind
   */
  _bind(kind) {
    const el = kind === 'video' ? this._videoEl : this._audioEl;
    const s = (kind === 'video' ? this._v : this._a) ?? this._newStream() ?? this._c;
    if (kind === 'video') this._v = s; else this._a = s;
    this._sync();
    this._applyAudioSettings();
    el.srcObject = s;
    let p;
    try { p = el.play(); } catch (err) { this._onPlayError(err, kind); return; }
    if (p && typeof p.catch === 'function') p.catch((err) => { if ((kind === 'video' ? this._v : this._a) === s) this._onPlayError(err, kind); });
  }
  /** @param {any} err @param {'video'|'audio'} kind */
  _onPlayError(err, kind) {
    if (err?.name === 'NotAllowedError') {
      this._onWarning({ code: 'playback_blocked', message: `The browser blocked autoplay of the avatar's ${kind}: call session.startPlayback() from a click or keypress handler.`, kind });
    } else this._log('debug', `avatar-media: play() on the ${kind} element rejected`, { name: err?.name, message: String(err?.message || err) });
  }
  /** Make V hold [video, audio-unless-split] and A hold [audio], adding/removing only what changed. */
  _sync() {
    if (!this._c) return;
    const video = this._c.getVideoTracks()[0] || null;
    const audio = this._c.getAudioTracks()[0] || null;
    this._reconcile(this._v, [video, this._audioEl ? null : audio]);
    this._reconcile(this._a, [audio]);
  }
  /** @param {any} s @param {any[]} wanted */
  _reconcile(s, wanted) {
    if (!s || s === this._c) return;   // fallback mode shares C: nothing to reconcile
    const want = wanted.filter(Boolean);
    for (const t of s.getTracks()) if (!want.includes(t)) s.removeTrack(t);
    for (const t of want) if (!s.getTracks().includes(t)) s.addTrack(t);
  }
  /** Push stored mute / volume / sink id to the current audio output element; writes only when the value differs. */
  _applyAudioSettings() {
    const el = this._sink();
    if (!el) return;
    if (this._muted != null && 'muted' in el && el.muted !== this._muted) el.muted = this._muted;
    if (this._volume != null && 'volume' in el && el.volume !== this._volume) el.volume = this._volume;
    if (this._sinkId != null && typeof el.setSinkId === 'function' && el.sinkId !== this._sinkId) {
      const id = this._sinkId;   // deferred so a rebind stays synchronous; skipped if the element was swapped out meanwhile
      Promise.resolve().then(() => (el === this._sink() ? el.setSinkId(id) : undefined)).catch((err) => this._log('warn', 'avatar-media: setSinkId rejected on rebind', { message: String(err?.message || err) }));
    }
  }
}
