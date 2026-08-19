/**
 * KalturaScriptedVideoSession — the minimal, brain-free sibling of
 * {@link import('./session.js').KalturaAvatarSession}: renders the video/audio
 * downlink for a scripted-video (STV-only) `avatar-session/*` session (see
 * `Management#avatarSessions` in `@kaltura/intelligent-agents/management`).
 *
 * WHEP-only. No socket.io, no ASR/mic uplink, no conversation-manager
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
 * @example
 * // server:
 * //   const admin = await k.sessions.createAdminToken();
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
import { turnServers, iceConfig, whepUrlHasPrivateIp } from './wire.js';

export class KalturaScriptedVideoSession extends Emitter {
  /**
   * @param {object} cfg
   * @param {string} cfg.whepUrl  From `avatarSessions.initClient()`.
   * @param {{url:string, username?:string, credential?:string}} cfg.turn  The `turn` object from `initClient()` (bare TURN host + creds — passed through {@link turnServers}).
   * @param {any} [cfg.videoEl]  An `HTMLVideoElement`. Omit for audio-only/headless use — `ontrack` still fires and you can read `e.streams[0]` off `stateChanged`/your own `pc`. The SDK only sets `.srcObject` — size/frame it yourself with `object-fit: cover` (see docs/ARCHITECTURE.md § Displaying the Avatar Video).
   * @param {typeof RTCPeerConnection} [cfg.rtcConstructor]
   * @param {typeof fetch} [cfg.fetch]
   * @param {boolean} [cfg.isFirefox]  Firefox needs `iceTransportPolicy:'all'` (see {@link iceConfig}).
   * @throws {KalturaError} `bad_request` if `whepUrl`/`turn` is missing; `whep_private_ip` if `whepUrl` resolves to a private/loopback address (SSRF guard — no escape hatch, matches `KalturaAvatarSession`'s own WHEP check).
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
    this._videoEl = cfg.videoEl || null;
    this._RTC = cfg.rtcConstructor || globalThis.RTCPeerConnection;
    const f = cfg.fetch || globalThis.fetch;
    this._fetch = typeof f === 'function' ? f.bind(globalThis) : f;
    this._isFirefox = !!cfg.isFirefox;
    this._pc = null;
    this._whepLocation = null;
    /** @type {'idle'|'connecting'|'connected'|'disconnecting'|'disconnected'|'error'} */
    this.state = 'idle';
  }

  /**
   * Negotiate WHEP and resolve once the stream is playable (or on connect
   * failure/timeout — whichever comes first). Can only be called from
   * `'idle'`/`'disconnected'`; construct a new instance to reconnect.
   * @returns {Promise<void>}
   * @throws {KalturaError} `invalid_state` if already connecting/connected; `whep_failed`/`whep_private_ip` on negotiation failure.
   */
  async connect() {
    if (this.state !== 'idle' && this.state !== 'disconnected') {
      throw new KalturaError({ type: 'about:blank', title: 'invalid state', code: 'invalid_state', detail: `connect() called from state '${this.state}' — construct a new KalturaScriptedVideoSession to reconnect.` });
    }
    this._setState('connecting');
    try {
      const pc = new this._RTC(iceConfig('stv', this._turn, this._isFirefox));
      this._pc = pc;
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.oniceconnectionstatechange = () => this.emit('connectivityChanged', { state: pc.iceConnectionState });

      const playable = new Promise((resolve) => {
        let done = false;
        let videoMetadataSent = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        pc.ontrack = (e) => {
          this.emit('track', { track: e.track, streams: e.streams });
          const v = this._videoEl;
          if (!v) return finish();
          v.srcObject = e.streams && e.streams[0];
          // ontrack fires once per track (video + audio) — gate so 'videoMetadata' fires
          // at most once per connect, not once per track.
          if (!videoMetadataSent && typeof v.addEventListener === 'function') {
            const emitVideoMetadata = () => { if (videoMetadataSent) return; videoMetadataSent = true; this.emit('videoMetadata', { videoWidth: v.videoWidth, videoHeight: v.videoHeight }); };
            if (v.videoWidth || v.videoHeight) emitVideoMetadata();
            else v.addEventListener('loadedmetadata', emitVideoMetadata, { once: true });
          }
          if (typeof v.play === 'function') { try { const pr = v.play(); if (pr?.catch) pr.catch(() => {}); } catch { /* autoplay policies vary; ontrack/canplay already fired */ } }
          if (v.readyState >= 3) finish();
          else if (typeof v.addEventListener === 'function') v.addEventListener('canplay', finish, { once: true });
          else finish();
        };
        setTimeout(finish, 6000); // hard cap — mirrors KalturaAvatarSession's STV playable gate
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await this._fetch(this._whepUrl, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer.sdp });
      if (!res.ok) {
        throw new KalturaError({ type: 'about:blank', title: 'WHEP negotiation failed', status: res.status, code: 'whep_failed', detail: whepStatusHint(res.status) });
      }
      const answerSdp = await res.text();
      const loc = res.headers?.get?.('Location');
      this._whepLocation = loc ? resolveUrl(loc, this._whepUrl) : null;
      // The server can rewrite the egress host in the response's Location header even
      // when whepUrl itself checked clean — re-check after resolving it (mirrors
      // KalturaAvatarSession's _connectStv, WIRE-PROTOCOL's SSRF guidance).
      if (this._whepLocation && whepUrlHasPrivateIp(this._whepLocation)) {
        throw new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/whep_private_ip', title: 'WHEP private IP', code: 'whep_private_ip', detail: 'The WHEP response Location header resolved to a private/loopback address.' });
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      await playable;
      this._setState('connected');
    } catch (err) {
      this._setState('error');
      this._teardown();
      throw err instanceof KalturaError ? err : new KalturaError({ type: 'about:blank', title: 'connect failed', code: 'connect_failed', detail: String((err && err.message) || err) });
    }
  }

  /**
   * Tear down the peer connection and best-effort release the server-side
   * WHEP resource. Safe to call more than once; never throws.
   */
  disconnect() {
    if (this.state === 'disconnected' || this.state === 'idle') { this.state = 'disconnected'; return; }
    this._setState('disconnecting');
    if (this._whepLocation && this._fetch) {
      const loc = this._whepLocation;
      // Best-effort: a failed DELETE here doesn't matter to the caller (the peer
      // connection is already being torn down below) but IS worth auditing —
      // mirrors KalturaAvatarSession's own WHEP cleanup.
      Promise.resolve().then(() => this._fetch(loc, { method: 'DELETE' })).catch((err) => this.emit('warning', { code: 'whep_delete_failed', message: String((err && err.message) || err) }));
    }
    this._teardown();
    this._setState('disconnected');
  }

  _teardown() {
    if (this._pc) { try { this._pc.close(); } catch { /* already closed */ } this._pc = null; }
    if (this._videoEl) this._videoEl.srcObject = null;
  }

  _setState(s) {
    this.state = s;
    this.emit('stateChanged', { state: s });
  }
}

/** @param {number} status */
function whepStatusHint(status) {
  if (status === 404) return 'WHEP 404 — no active session (it may have ended or expired; recreate it via avatarSessions.create()).';
  if (status === 409) return 'WHEP 409 — the stream already has a viewer.';
  if (status === 415) return 'WHEP 415 — wrong content-type (must be application/sdp).';
  return `WHEP HTTP ${status}.`;
}

/** @param {string} maybeRelative @param {string} base */
function resolveUrl(maybeRelative, base) {
  try { return new URL(maybeRelative, base).href; } catch { return maybeRelative; }
}
