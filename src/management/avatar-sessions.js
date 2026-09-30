/**
 * Scripted-video (STV-only) sessions — `avatar-session/*` on the agentic host.
 *
 * A second, INDEPENDENT session backend, sitting next to (not on top of) the
 * conversational runtime that {@link Application}/`KalturaAvatarSession`
 * drive. No LLM, no ASR, no socket.io — REST + WHEP only. You get an avatar
 * that speaks exactly the audio you hand it, in the order you hand it, and
 * nothing else: no brain, no memory, no tools, no turn-taking logic. Use
 * this when YOU are the script (IVR-style flows, pre-recorded/TTS'd
 * announcements, kiosk greetings) rather than the model.
 *
 * Lifecycle: {@link AvatarSessions#create} → {@link AvatarSessions#initClient}
 * (browser video) → repeated {@link AvatarSessions#say} /
 * {@link AvatarSessions#interrupt} / {@link AvatarSessions#keepAlive} →
 * {@link AvatarSessions#end}. Every method after `create` takes the
 * `{sessionId, token}` object `create` returns, not a KS.
 *
 * Speech is audio only: generate the audio with your own TTS and pass it to
 * {@link AvatarSessions#say}. The SDK has no text-to-speech method and no
 * emotion or queue-status methods.
 */
import { KalturaError } from '../core/errors.js';
import { uuidv4 } from '../core/ids.js';

export class AvatarSessions {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) {
    this._ = ctx;
  }

  /**
   * Start a scripted-video session for one avatar. Returns a session
   * receipt — pass it, not a KS, to every other method on this class.
   *
   * ADMIN TOKEN ONLY. A conversation KS is rejected with
   * `code:'wrong_token_scope'`, client-side, before any network call, when
   * the KS's kind is knowable (a `Token` object from `sessions.*`, or a
   * plaintext/test KS); a raw encrypted KS string defers to the server, which
   * enforces the same rule. Mint an admin token server-side with
   * `sessions.createAdminToken({ userId })`, never in a browser.
   *
   * The receipt's `.token` is a session-scoped BEARER JWT (NOT a KS). Its
   * expiry is read from the JWT's own `exp` claim (see
   * `.isExpired()`/`.secondsRemaining()` below). It authenticates every
   * other call on THIS session and grants full control of it, so keep it
   * server-side next to your admin secret. The browser only ever needs the
   * non-secret `{whepUrl, turn}` pair from {@link initClient}.
   *
   * WRITE — NOT idempotent; always opens a new session (a new WHEP egress
   * resource on the server). The `visualConfig.id` is the same avatar
   * visual-catalog id you'd pass to `avatars.create`'s `visual.id` — the
   * identity is shared with the conversational backend, but one live
   * session is locked to one backend: you cannot interleave `say-audio`
   * calls into an already-running `KalturaAvatarSession`, or vice versa.
   * Ending one and starting the other sequentially is fine.
   *
   * @param {object} body
   * @param {{id:string}} body.visualConfig  `{ id: <avatar visual-catalog id> }`.
   * @param {string|{ks:string}} ks  ADMIN token.
   * @param {{idempotencyKey?:string}} [opts]
   * @returns {Promise<{sessionId:string, token:string, isExpired:()=>boolean, secondsRemaining:()=>number}>}
   * @throws {KalturaError} `bad_request` if `visualConfig.id` is missing; `wrong_token_scope` if `ks` isn't an admin token.
   * @example
   * const admin = await k.sessions.createAdminToken({ userId: 'admin@example.com' });
   * const session = await k.avatarSessions.create({ visualConfig: { id: avatarId } }, admin.ks);
   * console.log(session.secondsRemaining(), 's left on this session token');
   */
  async create(body, ks, opts = {}) {
    this._.assertAdmin(ks, 'avatarSessions.create');
    if (!body?.visualConfig?.id) {
      throw new KalturaError({
        type: 'about:blank', title: 'visualConfig.id required', code: 'bad_request',
        detail: 'avatarSessions.create needs { visualConfig: { id: <avatar visual-catalog id> } }.',
      });
    }
    const { data } = await this._.agentic('avatar-session/create', { visualConfig: { id: body.visualConfig.id } }, ks, { idempotencyKey: opts.idempotencyKey });
    if (!data?.sessionId || !data?.token) {
      throw new KalturaError({
        type: 'about:blank', title: 'session create failed', code: 'server_error',
        detail: 'avatar-session/create did not return {sessionId, token}.', body: data,
      });
    }
    return sessionReceipt(data.sessionId, data.token);
  }

  /**
   * Negotiate the session's video/audio egress. Returns the WHEP URL and
   * TURN credentials to hand to a browser viewer — e.g.
   * `KalturaScriptedVideoSession` from `@kaltura/intelligent-agents/experience`.
   * Neither value is a secret in the way `session.token` is; this is the
   * one payload from this whole class that's safe to send to a browser.
   *
   * WRITE, not idempotent to retry blindly. Call it once per session, right
   * after {@link create}.
   *
   * @param {{sessionId:string, token:string}} session  From {@link create}.
   * @returns {Promise<{whepUrl:string, turn:{url:string, username?:string, credential?:string}}>}
   * @throws {KalturaError} `bad_request` if `session` isn't a `{sessionId, token}` receipt.
   * @example
   * const { whepUrl, turn } = await k.avatarSessions.initClient(session);
   * // send only { whepUrl, turn } to the browser — never `session`/`session.token`
   */
  async initClient(session) {
    const { sessionId, token } = sessionRef(session, 'avatarSessions.initClient');
    const { data } = await this._.avatarSessionCall(`avatar-session/${sessionId}/init-client`, {}, token);
    return data;
  }

  /**
   * Speak pre-synthesized AUDIO on the avatar — the only speech-injection
   * mechanism the SDK supports. Generate the audio
   * with any TTS provider (the SDK has none) and pass
   * the encoded bytes here.
   *
   * `opts.duration` (seconds) is CALLER-SUPPLIED and REQUIRED: the server
   * does not probe the audio itself, so measure your own file (e.g.
   * `ffprobe`, or read it straight from your TTS provider's response
   * metadata) and pass it in. An inaccurate value doesn't error — it just
   * desyncs the avatar's mouth from the audio's actual length.
   *
   * ASYNC/QUEUED: the call resolves in roughly 100ms once
   * the server accepts the turn — it does NOT block until playback
   * finishes. Calling `say()` again before the previous turn finishes
   * queues it; call {@link interrupt} to cut off whatever's currently
   * playing (idempotent — safe with nothing playing).
   *
   * WRITE — not idempotent; each call enqueues a new speaking turn.
   *
   * @param {{sessionId:string, token:string}} session  From {@link create}.
   * @param {Blob|ArrayBuffer|Uint8Array} audio  Encoded audio bytes (mp3, or whatever your TTS provider returns — only mp3 has been confirmed).
   * @param {{duration?:number, turnId?:string, mimeType?:string}} [opts]  `duration` in seconds, > 0 — REQUIRED (checked at runtime; the JSDoc type is optional only so an omitted `opts` degrades to the same `bad_request` below instead of a raw TypeError). `turnId` defaults to a fresh uuid. `mimeType` defaults to `'audio/mpeg'`.
   * @returns {Promise<{turnId:string, success:boolean}>}
   * @throws {KalturaError} `bad_request` if `session` is missing or `opts.duration`/`audio` is missing.
   * @example
   * const mp3 = await ttsProvider.synthesize('Hello there.');   // Uint8Array/Buffer
   * const duration = await measureDurationSeconds(mp3);         // your own probe, e.g. ffprobe
   * await k.avatarSessions.say(session, mp3, { duration });
   */
  async say(session, audio, opts = {}) {
    const { sessionId, token } = sessionRef(session, 'avatarSessions.say');
    if (typeof opts.duration !== 'number' || !(opts.duration > 0)) {
      throw new KalturaError({
        type: 'about:blank', title: 'duration required', code: 'bad_request',
        detail: 'avatarSessions.say needs opts.duration (seconds, > 0) — the server has no duration probe of its own; measure your own audio (e.g. ffprobe) and pass it explicitly.',
      });
    }
    if (!audio) {
      throw new KalturaError({
        type: 'about:blank', title: 'audio required', code: 'bad_request',
        detail: 'avatarSessions.say needs audio bytes (Blob|ArrayBuffer|Uint8Array).',
      });
    }
    const turnId = opts.turnId || uuidv4();
    // The `audio instanceof Blob` check above already rules out Blob here at runtime, but a
    // compound `&&` condition doesn't narrow the ternary's else-branch type (TS can't prove
    // audio isn't Blob just because the OTHER half of the && was false) — cast to the
    // Blob constructor's own accepted type rather than re-deriving the narrowed union.
    const blob = (typeof Blob !== 'undefined' && audio instanceof Blob) ? audio : new Blob([/** @type {BlobPart} */ (audio)], { type: opts.mimeType || 'audio/mpeg' });
    const fd = new FormData();
    fd.append('turnId', turnId);
    fd.append('duration', String(opts.duration));
    fd.append('audio', blob, 'audio');
    const { data } = await this._.avatarSessionMultipart(`avatar-session/${sessionId}/say-audio`, fd, token);
    return { turnId, success: !!(data && data.success) };
  }

  /**
   * Stop whatever's currently playing — barge-in. Idempotent: safe
   * to call with nothing playing (no error, just a no-op on the server).
   * Does not affect queued-but-not-yet-started turns beyond the current one.
   *
   * WRITE — mutates playback state, but safely repeatable.
   *
   * @param {{sessionId:string, token:string}} session  From {@link create}.
   * @returns {Promise<object>}
   * @throws {KalturaError} `bad_request` if `session` isn't a `{sessionId, token}` receipt.
   */
  async interrupt(session) {
    const { sessionId, token } = sessionRef(session, 'avatarSessions.interrupt');
    const { data } = await this._.avatarSessionCall(`avatar-session/${sessionId}/interrupt`, {}, token);
    return data;
  }

  /**
   * Signal activity so the server doesn't reclaim an idle session. Call it
   * about every 10 s while the session is idle. This method makes ONE call;
   * it does not start a timer. Drive it from your own `setInterval` while a
   * session is open and you expect gaps between `say()` calls.
   *
   * WRITE — safely repeatable (no state beyond "still alive" to corrupt).
   *
   * @param {{sessionId:string, token:string}} session  From {@link create}.
   * @returns {Promise<object>}
   * @throws {KalturaError} `bad_request` if `session` isn't a `{sessionId, token}` receipt.
   * @example
   * const timer = setInterval(() => k.avatarSessions.keepAlive(session).catch(() => {}), 10_000);
   * // ...
   * clearInterval(timer);
   * await k.avatarSessions.end(session);
   */
  async keepAlive(session) {
    const { sessionId, token } = sessionRef(session, 'avatarSessions.keepAlive');
    const { data } = await this._.avatarSessionCall(`avatar-session/${sessionId}/keep-alive`, {}, token);
    return data;
  }

  /**
   * End the session and release its server-side resources (the WHEP egress
   * among them). Calling it on an already-ended session 404s — treat that
   * as "already gone," not a real failure, if you call this defensively
   * (e.g. from a cleanup/disconnect handler).
   *
   * WRITE — DESTRUCTIVE, but safe to call more than once.
   *
   * @param {{sessionId:string, token:string}} session  From {@link create}.
   * @returns {Promise<object>}
   * @throws {KalturaError} `bad_request` if `session` isn't a `{sessionId, token}` receipt.
   */
  async end(session) {
    const { sessionId, token } = sessionRef(session, 'avatarSessions.end');
    const { data } = await this._.avatarSessionCall(`avatar-session/${sessionId}/end`, {}, token);
    return data;
  }
}

/** @param {any} session @param {string} where @returns {{sessionId:string, token:string}} */
function sessionRef(session, where) {
  const sessionId = session && typeof session === 'object' ? session.sessionId : undefined;
  const token = session && typeof session === 'object' ? session.token : undefined;
  if (!sessionId || !token) {
    throw new KalturaError({
      type: 'about:blank', title: 'session required', code: 'bad_request',
      detail: `${where} needs the {sessionId, token} object returned by avatarSessions.create() — got ${session === null ? 'null' : typeof session}.`,
    });
  }
  return { sessionId, token };
}

/** Build the `create()` return value, with `exp`-derived expiry helpers attached non-enumerably (mirrors the {@link import('../core/session.js').Token} receipt pattern). @param {string} sessionId @param {string} token @returns {{sessionId:string, token:string, isExpired:()=>boolean, secondsRemaining:()=>number}} */
function sessionReceipt(sessionId, token) {
  const exp = decodeJwtExp(token);
  const session = { sessionId, token };
  Object.defineProperty(session, 'isExpired', {
    value: () => (typeof exp === 'number' ? Math.floor(Date.now() / 1000) >= exp : false),
    enumerable: false,
  });
  Object.defineProperty(session, 'secondsRemaining', {
    value: () => (typeof exp === 'number' ? Math.max(0, exp - Math.floor(Date.now() / 1000)) : Infinity),
    enumerable: false,
  });
  // isExpired/secondsRemaining are attached above via defineProperty (kept non-enumerable
  // on purpose), so the static type can't see them on the object literal itself.
  return /** @type {{sessionId:string, token:string, isExpired:()=>boolean, secondsRemaining:()=>number}} */ (session);
}

/** Decode a JWT's `exp` claim without verifying the signature — we don't hold the signing key; the server is the enforcement point. Pure, never throws. @param {string} token */
function decodeJwtExp(token) {
  try {
    const payloadB64 = String(token).split('.')[1];
    if (!payloadB64) return undefined;
    const b64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}
