/**
 * KalturaScriptedVideoSession — the minimal, brain-free sibling of
 * {@link import('./session.js').KalturaAvatarSession}: renders the video/audio
 * downlink for a scripted-video (STV-only) `avatar-session/*` session (see
 * `Management#avatarSessions` in `@kaltura/intelligent-agents/management`).
 *
 * WHEP-only. No socket.io, no ASR/mic uplink, no session-server
 * coupling, no tool calls, no captions. Construct it with just the
 * non-secret `{whepUrl, turn}` pair from `avatarSessions.initClient()` —
 * mint that server-side; this class never needs the session's Bearer token
 * or your admin KS.
 *
 * Speech is driven entirely from YOUR SERVER via `Management#avatarSessions`
 * (`say`/`interrupt`/`keepAlive`/`end`) — this class only shows what the
 * server told the avatar to speak. It deliberately has no `speak()` of its
 * own: that would require the session's Bearer token in the browser, which
 * must stay server-side (see `avatar-sessions.js`'s `create()` doc for why).
 *
 * ZERO runtime deps. `fetch`/`rtcConstructor` are injectable — same
 * convention as `KalturaAvatarSession` — so this is unit-testable with the
 * repo's `test/fakes/rtc.js` doubles without a real browser or network.
 *
 * Fires 'track' ({track, streams}) the moment the WHEP peer's ontrack fires,
 * whether or not videoEl is configured — the headless/custom-render escape
 * hatch. When videoEl IS configured, also fires 'videoMetadata'
 * ({videoWidth, videoHeight}) once per connect, as soon as the decoder
 * resolves the stream's native dimensions (the backend's actual output
 * resolution isn't a published/fixed contract — see docs/ARCHITECTURE.md §
 * Displaying the Avatar Video).
 *
 * Also fires 'stateChange' ({state}), 'connectivityChanged' ({state}: the
 * peer's ICE connection state) and 'warning' ({code, message, ...}, e.g.
 * `playback_blocked`, `media_attach_failed`, `whep_delete_failed`).
 *
 * @example
 * // server:
 * //   const admin = await k.sessions.createAdminToken({ userId: 'admin@example.com' });
 * //   const session = await k.avatarSessions.create({ visualConfig: { id: avatarId } }, admin.ks);
 * //   const { whepUrl, turn } = await k.avatarSessions.initClient(session);
 * //   // send only { whepUrl, turn } to the browser — never `session`/`session.token`
 * //
 * // browser:
 * import { KalturaScriptedVideoSession } from '@kaltura/intelligent-agents/experience';
 * const view = new KalturaScriptedVideoSession({ whepUrl, turn, videoEl });
 * await view.connect();
 * // ...call your own server endpoint, which calls k.avatarSessions.say()...
 * view.disconnect();
 */
import { Emitter } from './emitter.js';
import { KalturaError } from '../core/errors.js';
import { turnServers, iceConfig, whepUrlHasPrivateIp, whepResourceUrl } from './wire.js';
import { AvatarMedia } from './avatar-media.js';

export class KalturaScriptedVideoSession extends Emitter {
  /**
   * @param {object} cfg
   * @param {string} cfg.whepUrl  From `avatarSessions.initClient()`.
   * @param {{url:string, username?:string, credential?:string}} cfg.turn  The `turn` object from `initClient()` (bare TURN host + creds — passed through {@link turnServers}).
   * @param {HTMLVideoElement|null} [cfg.videoEl]  Element that renders the avatar: video plus audio, unless `cfg.audioEl` is set. Omit for headless/custom rendering (listen for 'track' or read {@link KalturaScriptedVideoSession#avatarStream}). The SDK sets `.srcObject` once and calls `play()` once per binding — size/frame it yourself with `object-fit: cover`. See docs/ARCHITECTURE.md § Displaying the Avatar Video.
   * @param {HTMLAudioElement|null} [cfg.audioEl]  Recommended: a dedicated element for the avatar's audio track (split shape). Keep it on a stable DOM node so a UI re-render that replaces the `<video>` does not silence the avatar. Swap at runtime with {@link KalturaScriptedVideoSession#setAudioEl}.
   * @param {typeof RTCPeerConnection} [cfg.rtcConstructor]
   * @param {typeof fetch} [cfg.fetch]
   * @param {typeof MediaStream} [cfg.mediaStreamConstructor]
   * @param {(level: string, msg: string, data?: any) => void} [cfg.logger]  Receives non-fatal media diagnostics (e.g. a rejected `setSinkId`). Default: silent.
   * @param {boolean} [cfg.isFirefox]  Firefox needs `iceTransportPolicy:'all'` (see {@link iceConfig}).
   * @throws {KalturaError} `bad_request` if `whepUrl`/`turn` is missing; `whep_private_ip` if `whepUrl` names a private/loopback address a browser cannot reach (fail-fast, no escape hatch, matches `KalturaAvatarSession`'s own WHEP check).
   */
  constructor(cfg) {
    super();
    if (!cfg || !cfg.whepUrl) {
      throw new KalturaError({ type: 'about:blank', title: 'whepUrl required', code: 'bad_request', detail: 'new KalturaScriptedVideoSession() needs whepUrl (from avatarSessions.initClient()).' });
    }
    if (!cfg.turn?.url) {
      throw new KalturaError({ type: 'about:blank', title: 'turn required', code: 'bad_request', detail: 'new KalturaScriptedVideoSession() needs turn (the {url,username,credential} object from avatarSessions.initClient()).' });
    }
    if (whepUrlHasPrivateIp(cfg.whepUrl)) {
      throw new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/whep_private_ip', title: 'WHEP private IP', code: 'whep_private_ip', detail: 'initClient() returned a whepUrl resolving to a private/loopback address.' });
    }
    this._whepUrl = cfg.whepUrl;
    this._turn = turnServers(cfg.turn.url, cfg.turn);
    this._RTC = cfg.rtcConstructor || globalThis.RTCPeerConnection;
    const f = cfg.fetch || globalThis.fetch;
    this._fetch = typeof f === 'function' ? f.bind(globalThis) : f;
    this._isFirefox = !!cfg.isFirefox;
    this._log = cfg.logger || (() => {});
    // Routes the downlink's video + audio tracks to the app's element(s); the two tracks
    // arrive in separate ontrack events with separate streams (see avatar-media.js).
    this._avatarMedia = new AvatarMedia({ videoEl: cfg.videoEl, audioEl: cfg.audioEl, mediaStreamConstructor: cfg.mediaStreamConstructor, onWarning: (w) => this.emit('warning', w), log: this._log });
    this._pc = null;
    this._inOntrack = false;   // true only while the peer's ontrack handler runs (see _teardown)
    /** @type {(() => void)|null} */ this._cancelPlayable = null;
    this._whepLocation = null;
    /** @type {'idle'|'connecting'|'connected'|'disconnecting'|'disconnected'|'error'} */
    this.state = 'idle';
  }

  /**
   * Negotiate WHEP and resolve once the stream is playable, or after a 6 s
   * cap, whichever comes first. Negotiation failure rejects, sets state
   * `'error'` and tears the peer down. Can only be called from
   * `'idle'` or `'disconnected'`. After `disconnect()` the same instance
   * connects again with a fresh peer connection. From `'error'`, call
   * `disconnect()` first, then `connect()`. A `disconnect()` during `connect()`
   * rejects it with `connect_failed` and leaves the state at `'disconnected'`.
   * @returns {Promise<void>}
   * @throws {KalturaError} `invalid_state` from any other state (`'connecting'`, `'connected'`, `'disconnecting'`, `'error'`); `whep_failed` on a non-2xx WHEP response; `whep_private_ip` when the response Location resolves to a private/loopback address; `connect_failed` for any other error.
   */
  async connect() {
    if (this.state !== 'idle' && this.state !== 'disconnected') {
      throw new KalturaError({ type: 'about:blank', title: 'invalid state', code: 'invalid_state', detail: `connect() called from state '${this.state}'. It only runs from 'idle' or 'disconnected'; call disconnect() first.` });
    }
    this._setState('connecting');
    let pc = null;
    try {
      pc = new this._RTC(iceConfig('stv', this._turn, this._isFirefox));
      this._pc = pc;
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.oniceconnectionstatechange = () => this.emit('connectivityChanged', { state: pc.iceConnectionState });

      const playable = new Promise((resolve) => {
        let done = false;
        let videoMetadataSent = false;
        /** @type {Array<{ el: any, ev: string, fn: () => void }>} */ const listeners = [];
        const listen = (el, ev, fn) => { if (listeners.some((l) => l.el === el && l.ev === ev)) return; listeners.push({ el, ev, fn }); el.addEventListener(ev, fn, { once: true }); };
        const unlisten = () => { for (const l of listeners) l.el.removeEventListener?.(l.ev, l.fn); listeners.length = 0; };
        const hardCap = setTimeout(() => finish(), 6000); // hard cap — mirrors KalturaAvatarSession's STV playable gate
        const finish = () => { if (done) return; done = true; clearTimeout(hardCap); unlisten(); resolve(); };
        this._cancelPlayable = finish;
        const onTrack = (e) => {
          try {
            this._avatarMedia.attach(e.track, e.streams);
          } catch (err) {
            const kind = e.track?.kind ?? null;
            this.emit('warning', { code: 'media_attach_failed', message: `The avatar's ${kind || 'media'} track could not be attached to the media element. Listen for 'track' or read session.avatarStream to render it yourself.`, kind, detail: String(err?.message || err) });
          }
          this.emit('track', { track: e.track, streams: e.streams });
          const v = this._avatarMedia.videoEl;
          if (!v) { finish(); return; }   // headless: nothing to gate on
          // ontrack fires once per track (video + audio) — gate so 'videoMetadata' fires at most once.
          if (!videoMetadataSent && typeof v.addEventListener === 'function') {
            const emitVideoMetadata = () => { if (videoMetadataSent) return; videoMetadataSent = true; this.emit('videoMetadata', { videoWidth: v.videoWidth, videoHeight: v.videoHeight }); };
            if (v.videoWidth || v.videoHeight) emitVideoMetadata();
            else listen(v, 'loadedmetadata', emitVideoMetadata);
          }
          if (v.readyState >= 3) finish();
          else if (typeof v.addEventListener === 'function') listen(v, 'canplay', finish);
          else finish();
        };
        pc.ontrack = (e) => {
          if (pc !== this._pc) return;   // a closed peer must not touch the live media
          this._inOntrack = true;        // a 'track' listener may call disconnect(): see _teardown()
          try { onTrack(e); } finally { this._inOntrack = false; }
        };
      });

      // A disconnect() that lands during an await below drops `this._pc`. That attempt must
      // stop quietly: the state belongs to disconnect() (or to a newer connect()).
      const offer = await pc.createOffer();
      if (pc !== this._pc) throw connectAbortedErr();
      await pc.setLocalDescription(offer);
      if (pc !== this._pc) throw connectAbortedErr();
      const res = await this._fetch(this._whepUrl, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer.sdp });
      if (!res.ok) {
        throw new KalturaError({ type: 'about:blank', title: 'WHEP negotiation failed', status: res.status, code: 'whep_failed', detail: whepStatusHint(res.status) });
      }
      const answerSdp = await res.text();
      const loc = res.headers?.get?.('Location');
      const resolvedLoc = loc ? whepResourceUrl(loc, this._whepUrl) : null;
      // Re-check the resolved Location for a private address (mirrors
      // KalturaAvatarSession's _connectStv). Keep it out of `_whepLocation` until it passes,
      // so disconnect() never sends a DELETE to a rejected URL.
      if (resolvedLoc && whepUrlHasPrivateIp(resolvedLoc)) {
        throw new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/whep_private_ip', title: 'WHEP private IP', code: 'whep_private_ip', detail: 'The WHEP response Location header resolved to a private/loopback address.' });
      }
      if (pc !== this._pc) {
        // The server allocated a viewer for this answer, so release it before aborting.
        if (resolvedLoc) this._releaseWhep(resolvedLoc);
        throw connectAbortedErr();
      }
      this._whepLocation = resolvedLoc;
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      await playable;
      if (pc !== this._pc) throw connectAbortedErr();
      this._setState('connected');
    } catch (err) {
      const failure = err instanceof KalturaError ? err : new KalturaError({ type: 'about:blank', title: 'connect failed', code: 'connect_failed', detail: String((err && err.message) || err) });
      if (pc && pc !== this._pc) throw failure;   // cancelled by disconnect(): leave the state alone
      this._setState('error');
      this._teardown();
      throw failure;
    }
  }

  /**
   * Tear down the peer connection and best-effort release the server-side
   * WHEP resource. Safe to call more than once; never throws.
   */
  disconnect() {
    if (this.state === 'disconnected' || this.state === 'idle') { this.state = 'disconnected'; return; }
    this._setState('disconnecting');
    const loc = this._whepLocation;
    this._whepLocation = null;   // captured for the DELETE below; never sent twice
    if (loc) this._releaseWhep(loc);
    this._teardown();
    this._setState('disconnected');
  }

  _releaseWhep(loc) {
    if (!this._fetch) return;
    // Best-effort: a failed DELETE here doesn't matter to the caller (the peer
    // connection is already being torn down) but IS worth auditing:
    // mirrors KalturaAvatarSession's own WHEP cleanup.
    Promise.resolve().then(() => this._fetch(loc, { method: 'DELETE' })).catch((err) => this.emit('warning', { code: 'whep_delete_failed', message: String((err && err.message) || err) }));
  }

  _teardown() {
    // Chromium hangs the renderer if `RTCPeerConnection.close()` runs inside the peer's own `ontrack`
    // dispatch (sync or microtask), which is what disconnect() from a 'track' listener does — so
    // defer the close to a macrotask in that case. The reference is dropped right away regardless.
    const pc = this._pc; this._pc = null;
    if (pc) { const close = () => { try { pc.close(); } catch { /* already closed */ } }; if (this._inOntrack) setTimeout(close, 0); else close(); }
    this._cancelPlayable?.(); this._cancelPlayable = null;
    this._avatarMedia.teardown();
  }

  /** The element currently rendering the avatar, or `null` (headless). @returns {HTMLVideoElement|null} */
  get videoEl() { return this._avatarMedia.videoEl; }
  /** The dedicated audio element, or `null` when audio plays through `videoEl` (the default). @returns {HTMLAudioElement|null} */
  get audioEl() { return this._avatarMedia.audioEl; }
  /** One MediaStream with every live downlink track, or `null` before the first track / after disconnect. @returns {MediaStream|null} */
  get avatarStream() { return this._avatarMedia.stream; }
  /**
   * Render the avatar on a different element (or `null` to stop rendering). Safe in any state.
   * @param {HTMLVideoElement|null} el
   * @returns {void}
   * @throws {KalturaError} `bad_request` when `el` is not `null` or a media element.
   */
  setVideoEl(el) { this._avatarMedia.setVideoEl(el); }
  /**
   * Play the audio track through a dedicated element (split mode), or `null` to merge it back into `videoEl`. Safe in any state.
   * @param {HTMLAudioElement|null} el
   * @returns {void}
   * @throws {KalturaError} `bad_request` when `el` is not `null` or a media element.
   */
  setAudioEl(el) { this._avatarMedia.setAudioEl(el); }
  /** Mute the avatar's audio output. @returns {void} */
  muteAudioOutput() { this._avatarMedia.setMuted(true); }
  /** Unmute the avatar's audio output. @returns {void} */
  unmuteAudioOutput() { this._avatarMedia.setMuted(false); }
  /**
   * Set playback volume, `0`..`1` (clamped), on the element carrying the audio track.
   * @param {number} volume
   * @returns {void}
   * @throws {KalturaError} `bad_request` when `volume` is not a finite number.
   */
  setAudioOutputVolume(volume) { this._avatarMedia.setVolume(volume); }
  /** @returns {boolean} Whether the avatar's audio output is muted. */
  get audioOutputMuted() { return this._avatarMedia.muted; }
  /** @returns {number} The avatar's playback volume, `0`..`1`. */
  get audioOutputVolume() { return this._avatarMedia.volume; }
  /**
   * Route the avatar's audio to a speaker device (`HTMLMediaElement.setSinkId`).
   * @param {string} deviceId
   * @returns {Promise<boolean>}  `false` (never throws) when unsupported or rejected.
   * @throws {KalturaError} `bad_request` when `deviceId` is not a string.
   */
  setAudioOutput(deviceId) { return this._avatarMedia.setSinkId(deviceId); }
  /**
   * Retry playback after a `playback_blocked` warning. Call from a click or keypress handler.
   * @returns {Promise<boolean>}  `true` when every bound element is playing afterwards.
   */
  startPlayback() { return this._avatarMedia.resumePlayback(); }

  _setState(s) {
    this.state = s;
    this.emit('stateChange', { state: s });
  }
}

/** @param {number} status */
function whepStatusHint(status) {
  if (status === 404) return 'WHEP 404 — no active session (it may have ended or expired; recreate it via avatarSessions.create()).';
  if (status === 409) return 'WHEP 409 — the stream already has a viewer.';
  if (status === 415) return 'WHEP 415 — wrong content-type (must be application/sdp).';
  return `WHEP HTTP ${status}.`;
}

function connectAbortedErr() {
  return new KalturaError({ type: 'about:blank', title: 'connect aborted', code: 'connect_failed', detail: 'disconnect() was called while connect() was still negotiating.' });
}
