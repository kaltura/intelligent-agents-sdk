/**
 * chroma-key — attach a bring-your-own transparent-background video compositor (any
 * `chroma-key-video`-shaped class) directly onto a `KalturaAvatarSession`'s own avatar
 * `<video>` element, and keep its lifecycle in lockstep with the session's.
 *
 * Why a factory, not a class: every other optional SDK plugin in this family
 * (`./experience/presenter`, `./experience/noise-suppressor`) is a plain function that
 * wires itself onto an already-existing session — there is no state here worth owning in
 * a class of its own. The real state (canvas, WebGL context, chroma parameters) already
 * lives inside the injected `ChromaKeyVideo` instance, which this function returns
 * UNWRAPPED. A factory keeps that boundary obvious: this file is glue, not a second
 * player implementation.
 *
 * BYO-injection rationale: this plugin never imports a `chroma-key-video` package — there
 * is no such runtime dependency anywhere in this SDK (zero-dependency rule,
 * SDK_CONSTITUTION.md). The caller constructs it via `cfg.ChromaKeyVideo`, exactly like
 * `noise-suppressor.js`'s `audioWorkletNodeConstructor` injection — an app that never
 * calls `attachChromaKeyAvatar()` never needs a chroma-key package on the page at all.
 *
 * Lifecycle: constructs `new ChromaKeyVideo(videoEl, options)` synchronously against the
 * SESSION'S OWN video element (verified via `session.videoEl`, never a second,
 * possibly-stale caller-supplied reference), optionally `.mount(container)`s it, then
 * listens for the session's `'ended'` event and any FATAL `'error'` event to call
 * `player.destroy()` exactly once. It deliberately does NOT destroy on a
 * transient/recoverable `'error'` (e.g. a socket hiccup the session itself reconnects
 * from) — doing so would strand the compositor with no way to re-attach, since the
 * misuse guard below refuses to construct a second player on a still-registered session.
 *
 * Idempotent: a second `attachChromaKeyAvatar()` call against a session that already has
 * a live compositor logs `console.warn` and returns the EXISTING instance instead of
 * constructing a second one — never throws for this, and never leaves two live players
 * (and two WebGL contexts) fighting over the same `<video>`.
 *
 * No shadow event system: this function never re-emits the player's own events (e.g. a
 * `chroma-key-video`-specific `'contextlost'`) onto `session` or anywhere else —
 * integrators listen on the returned player instance directly.
 *
 * `safeUrl()` (Rule S-3) is not this plugin's concern — it never accepts or fetches a URL,
 * only the session's own live `<video>` element. If YOUR app keys a URL-sourced clip
 * (rather than the session's avatar stream) with `chroma-key-video` directly, bypassing
 * this plugin entirely, running that URL through `safeUrl()` first is still your
 * obligation, same as any other SDK-adjacent fetch.
 *
 * @example
 * import { KalturaAvatarSession } from '@kaltura/intelligent-agents/experience';
 * import { attachChromaKeyAvatar } from '@kaltura/intelligent-agents/experience/chroma-key';
 * import ChromaKeyVideo from 'https://esm.sh/chroma-key-video';   // YOUR dependency, not the SDK's
 *
 * const video = document.createElement('video');
 * video.autoplay = true; video.playsInline = true;
 * const session = new KalturaAvatarSession({ token, …appInit, videoEl: video, socketFactory });
 *
 * const player = attachChromaKeyAvatar({
 *   session, videoEl: video, ChromaKeyVideo,
 *   options: { keyColor: [0, 255, 0] },
 *   container: document.getElementById('composited'),
 * });
 * // `player` is the raw chroma-key-video instance — listen on it directly, e.g.:
 * player.on?.('ready', () => console.log('compositor live'));
 *
 * await session.connect();
 * // No explicit teardown needed: player.destroy() fires automatically on session 'ended'
 * // or a fatal session 'error' — session.disconnect() alone is enough.
 */
import { KalturaError } from '../core/errors.js';

// Mirrors session.js's FATAL_CODE table (the codes it maps to at its "// Fatal error
// events." emit site) — session.js doesn't export that table, so the 5 literal codes are
// duplicated here deliberately. Only these end the session's underlying connection
// unrecoverably; every other 'error' code (e.g. socket_error, stv_task_fail) is a
// transient/recoverable condition the session itself may reconnect from, so destroying the
// compositor on those would strand it with no way to re-attach (see the misuse guard below).
const FATAL_ERROR_CODES = new Set([
  'capacity_unavailable', 'tier_exceeded', 'bad_request', 'peer_removed', 'unsupported_client',
]);

// Dev-time-only bookkeeping (not app state): the ONE currently-live player per session,
// keyed by the session object itself so it self-clears via GC — same externally-owned-key
// pattern as presenter.js's sessionsWithLivePresenter / noise-suppressor.js's
// registeredContexts. A WeakMap rather than a WeakSet: it lets a misuse hit below return
// the SAME existing player instead of just warning and constructing a second one anyway,
// matching this plugin's "at most one live compositor per session" contract. Cleared as
// soon as that player is destroyed (session 'ended' / fatal 'error'), so a fresh attach
// after cleanup is always possible.
const playerBySession = new WeakMap();

/** @param {string} title @param {string} detail @returns {KalturaError} */
function invalidArg(title, detail) {
  return new KalturaError({ type: 'about:blank', title, code: 'bad_request', detail });
}

/**
 * @param {object} cfg
 * @param {import('./session.js').KalturaAvatarSession} cfg.session
 * @param {HTMLVideoElement} cfg.videoEl
 * @param {new (source: any, options?: object) => any} cfg.ChromaKeyVideo
 * @param {object} [cfg.options]
 * @param {Element} [cfg.container]
 * @returns {any}
 */
export function attachChromaKeyAvatar(cfg) {
  const session = cfg?.session;
  if (!session) {
    throw invalidArg('missing session', 'attachChromaKeyAvatar() needs { session } — a KalturaAvatarSession.');
  }
  if (!cfg.videoEl) {
    throw invalidArg('missing videoEl', 'attachChromaKeyAvatar() needs { videoEl } — the session\'s own avatar <video> element.');
  }
  if (cfg.videoEl !== session.videoEl) {
    throw invalidArg(
      'videoEl mismatch',
      "attachChromaKeyAvatar()'s { videoEl } must be the SAME element the session itself renders into — pass session.videoEl, not a second, possibly-stale reference.",
    );
  }
  if (typeof cfg.ChromaKeyVideo !== 'function') {
    throw invalidArg(
      'missing ChromaKeyVideo',
      'attachChromaKeyAvatar() needs { ChromaKeyVideo } — a class constructed as new ChromaKeyVideo(videoEl, options). The SDK never bundles or imports one; bring your own.',
    );
  }

  if (playerBySession.has(session)) {
    if (typeof console !== 'undefined') {
      console.warn(
        '[chroma-key] attachChromaKeyAvatar() called again for a session that already has a live compositor — ' +
        'returning the existing instance instead of constructing a second one (two players would fight over the ' +
        'same <video> and leak a WebGL context). Wait for the session to end, or for the existing player to be ' +
        'destroyed, before attaching again.',
      );
    }
    return playerBySession.get(session);
  }

  const unsubs = [];
  let player;
  try {
    player = new cfg.ChromaKeyVideo(cfg.videoEl, cfg.options);
    if (cfg.container) player.mount(cfg.container);

    let destroyed = false;
    const doDestroy = () => {
      if (destroyed) return;
      destroyed = true;
      // Check the player's OWN isDestroyed flag first — it may already have been destroyed
      // through some other path (e.g. the integrator called player.destroy() directly) —
      // calling destroy() again on an already-destroyed compositor is exactly the
      // double-destroy this guard exists to avoid.
      try { if (!player.isDestroyed) player.destroy(); } catch { /* BYO player — never let its own destroy() throw back into the session */ }
      for (const off of unsubs.splice(0)) { try { off(); } catch { /* */ } }
      playerBySession.delete(session);
    };
    // The session's single unambiguous terminal signal — always destroy here.
    unsubs.push(session.on('ended', () => doDestroy()));
    // Only a FATAL error code ends the session unrecoverably (see FATAL_ERROR_CODES above);
    // every other 'error' is a transient condition the session may itself recover from.
    unsubs.push(session.on('error', (err) => { if (err && FATAL_ERROR_CODES.has(err.code)) doDestroy(); }));
  } catch (err) {
    for (const off of unsubs.splice(0)) { try { off(); } catch { /* */ } }
    if (err instanceof KalturaError) throw err;
    throw new KalturaError({
      type: 'about:blank',
      title: 'chroma-key construction failed',
      code: 'bad_request',
      detail: `attachChromaKeyAvatar() failed to construct/mount the injected ChromaKeyVideo: ${err?.message ?? err}`,
    });
  }

  playerBySession.set(session, player);
  return player;
}
