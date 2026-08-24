import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachChromaKeyAvatar } from '../../src/experience/chroma-key.js';
import { KalturaError } from '../../src/core/errors.js';
import { Emitter } from '../../src/experience/emitter.js';

/**
 * Unit-tests the optional chroma-key compositor plugin in isolation (no browser/WebGL
 * involved — the fake ChromaKeyVideo below stands in for the real, integrator-supplied
 * `chroma-key-video` class), proving: argument validation, synchronous construction
 * against `(videoEl, options)`, the `.mount(container)` contract, the unwrapped return
 * value, the misuse guard (no double-construction), and lifecycle wiring to the session's
 * 'ended'/fatal-'error' events (exactly-once destroy, no leaked listeners).
 */

/** A minimal fake session: an Emitter exposing the same read-only `videoEl` getter as the real KalturaAvatarSession. */
class FakeSession extends Emitter {
  constructor(videoEl) { super(); this._videoEl = videoEl; }
  get videoEl() { return this._videoEl; }
  /** Test helper: how many listeners are still registered for an event (proves cleanup ran). */
  listenerCount(event) { return this._listeners.get(event)?.size ?? 0; }
}

/** A minimal fake `<video>` element — only the surface chroma-key.js and its own tests touch. */
class FakeVideoEl {
  constructor() { this.srcObject = null; this._handlers = new Map(); }
  addEventListener(type, fn) { const s = this._handlers.get(type) || new Set(); s.add(fn); this._handlers.set(type, s); }
  removeEventListener(type, fn) { this._handlers.get(type)?.delete(fn); }
  dispatchEvent(type) { for (const fn of this._handlers.get(type) || []) fn(); }
}

/** A fake `chroma-key-video`-shaped class: records every construction + mount + destroy call. */
class FakeChromaKeyVideo {
  constructor(source, options) {
    FakeChromaKeyVideo.instances.push(this);
    this.source = source;
    this.options = options;
    this.isDestroyed = false;
    this.mounted = null;
    this.destroyCalls = 0;
  }
  mount(container) { this.mounted = container; }
  destroy() { this.destroyCalls += 1; this.isDestroyed = true; }
}
FakeChromaKeyVideo.instances = [];
FakeChromaKeyVideo.reset = () => { FakeChromaKeyVideo.instances = []; };

function withWarnSpy(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try { fn(warnings); } finally { console.warn = original; }
}

// ─────────────────────────── argument validation ───────────────────────────

test('attachChromaKeyAvatar: throws KalturaError (not a generic Error) for missing session', () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  assert.throws(
    () => attachChromaKeyAvatar({ videoEl, ChromaKeyVideo: FakeChromaKeyVideo }),
    (err) => err instanceof KalturaError,
  );
  assert.equal(FakeChromaKeyVideo.instances.length, 0, 'no player constructed on a failed validation');
});

test('attachChromaKeyAvatar: throws KalturaError for missing videoEl', () => {
  FakeChromaKeyVideo.reset();
  const session = new FakeSession(new FakeVideoEl());
  assert.throws(
    () => attachChromaKeyAvatar({ session, ChromaKeyVideo: FakeChromaKeyVideo }),
    (err) => err instanceof KalturaError,
  );
  assert.equal(FakeChromaKeyVideo.instances.length, 0);
});

test('attachChromaKeyAvatar: throws KalturaError when videoEl is not the session\'s own element', () => {
  FakeChromaKeyVideo.reset();
  const session = new FakeSession(new FakeVideoEl());
  const otherVideoEl = new FakeVideoEl();
  assert.throws(
    () => attachChromaKeyAvatar({ session, videoEl: otherVideoEl, ChromaKeyVideo: FakeChromaKeyVideo }),
    (err) => err instanceof KalturaError,
  );
  assert.equal(FakeChromaKeyVideo.instances.length, 0);
});

test('attachChromaKeyAvatar: throws KalturaError when ChromaKeyVideo is not a function', () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  assert.throws(
    () => attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: {} }),
    (err) => err instanceof KalturaError,
  );
  assert.throws(
    () => attachChromaKeyAvatar({ session, videoEl }),
    (err) => err instanceof KalturaError,
  );
});

// ─────────────────────────── construction + mount + return value ───────────────────────────

test('attachChromaKeyAvatar: constructs the injected class with (videoEl, options) exactly', () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  const options = { keyColor: [0, 255, 0] };
  attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo, options });
  assert.equal(FakeChromaKeyVideo.instances.length, 1);
  const instance = FakeChromaKeyVideo.instances[0];
  assert.equal(instance.source, videoEl);
  assert.equal(instance.options, options);
});

test('attachChromaKeyAvatar: calls .mount(container) when container is given', () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  const container = { id: 'composited' };
  attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo, container });
  assert.equal(FakeChromaKeyVideo.instances[0].mounted, container);
});

test('attachChromaKeyAvatar: does not call .mount() when container is omitted', () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
  assert.equal(FakeChromaKeyVideo.instances[0].mounted, null);
});

test('attachChromaKeyAvatar: returns the constructed instance unmodified (no wrapping proxy)', () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  const player = attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
  assert.equal(player, FakeChromaKeyVideo.instances[0], 'returned value is the exact same instance, not a copy/proxy');
  assert.ok(player instanceof FakeChromaKeyVideo);
});

test('attachChromaKeyAvatar: construction/mount errors are caught and re-thrown as KalturaError, never propagate raw', () => {
  FakeChromaKeyVideo.reset();
  class ThrowingChromaKeyVideo {
    constructor() { throw new Error('WebGL context creation failed'); }
  }
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  assert.throws(
    () => attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: ThrowingChromaKeyVideo }),
    (err) => err instanceof KalturaError && /WebGL context creation failed/.test(err.detail || ''),
  );
});

// ─────────────────────────── misuse guard (idempotent, no double-wiring) ───────────────────────────

test('attachChromaKeyAvatar: a second call against the same session warns and does not construct a second player', () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  withWarnSpy((warnings) => {
    const first = attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
    const second = attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
    assert.equal(FakeChromaKeyVideo.instances.length, 1, 'only one player ever constructed');
    assert.equal(second, first, 'the second call returns the existing instance');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /already has a live compositor/);
  });
});

test('attachChromaKeyAvatar: never throws on the misuse-guard path', () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  withWarnSpy(() => {
    attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
    assert.doesNotThrow(() => attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo }));
  });
});

// ─────────────────────────── lifecycle wiring: auto-destroy on 'ended' / fatal 'error' ───────────────────────────

test("attachChromaKeyAvatar: session.emit('ended') calls player.destroy() exactly once", () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  const player = attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
  session.emit('ended', { reason: 'ended' });
  assert.equal(player.destroyCalls, 1);
  assert.equal(player.isDestroyed, true);
  session.emit('ended', { reason: 'ended' });
  assert.equal(player.destroyCalls, 1, 'a second ended event must not call destroy() again');
});

test("attachChromaKeyAvatar: a FATAL session 'error' calls player.destroy() exactly once", () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  const player = attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
  session.emit('error', { code: 'capacity_unavailable' });
  assert.equal(player.destroyCalls, 1);
  session.emit('error', { code: 'capacity_unavailable' });
  assert.equal(player.destroyCalls, 1, 'a second fatal error must not call destroy() again');
});

test("attachChromaKeyAvatar: a NON-fatal session 'error' (e.g. transient socket hiccup) does not destroy the player", () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  const player = attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
  session.emit('error', { code: 'socket_error' });
  session.emit('error', { code: 'stv_task_fail' });
  assert.equal(player.destroyCalls, 0, 'transient/recoverable errors must not tear down the compositor');
});

// ─────────────────────────── lifecycle wiring: auto-destroy on session.disconnect()/stop() (issue #62) ───────────────────────────

test("attachChromaKeyAvatar: session.disconnect()'s 'stateChange' to 'disconnected' calls player.destroy() exactly once", () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  const player = attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
  // Mirrors the real KalturaAvatarSession.disconnect(): _setState('disconnecting') then
  // _setState('disconnected'), each emitting 'stateChange' — never 'ended'.
  session.emit('stateChange', { state: 'disconnecting' });
  assert.equal(player.destroyCalls, 0, "the intermediate 'disconnecting' state must not destroy the player");
  session.emit('stateChange', { state: 'disconnected' });
  assert.equal(player.destroyCalls, 1);
  assert.equal(player.isDestroyed, true);
  session.emit('stateChange', { state: 'disconnected' });
  assert.equal(player.destroyCalls, 1, 'a second disconnected stateChange must not call destroy() again');
});

test('attachChromaKeyAvatar: non-disconnected stateChange values (connecting/connected/reconnecting) do not destroy the player', () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  const player = attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
  for (const state of ['connecting', 'connected', 'reconnecting', 'resuming']) session.emit('stateChange', { state });
  assert.equal(player.destroyCalls, 0);
});

test("attachChromaKeyAvatar: a fatal 'error' followed by session.disconnect()'s 'stateChange' still destroys exactly once (idempotent across both paths)", () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  const player = attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
  session.emit('error', { code: 'bad_request' });
  assert.equal(player.destroyCalls, 1);
  // An integrator (or the SDK's own error-handling glue) calling disconnect() right after a
  // fatal error must not trigger a second, redundant destroy() call.
  session.emit('stateChange', { state: 'disconnecting' });
  session.emit('stateChange', { state: 'disconnected' });
  assert.equal(player.destroyCalls, 1, 'destroy() must not fire twice across the error and stateChange paths');
});

test("attachChromaKeyAvatar: session.disconnect()'s 'stateChange' followed by a later 'ended' (e.g. _endWith's own emit order) still destroys exactly once", () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  const player = attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
  // _endWith() in session.js sets state to 'disconnected' BEFORE emitting 'ended' — the
  // stateChange listener fires first here, and the later 'ended' must be a no-op.
  session.emit('stateChange', { state: 'disconnected' });
  session.emit('ended', { reason: 'reconnect_timeout' });
  assert.equal(player.destroyCalls, 1, 'destroy() must not fire twice across the stateChange and ended paths');
});

test("attachChromaKeyAvatar: 'error' then 'ended' (the session's own emit order) still destroys exactly once", () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  const player = attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
  session.emit('error', { code: 'bad_request' });
  session.emit('ended', { reason: 'bad_request' });
  assert.equal(player.destroyCalls, 1);
});

test('attachChromaKeyAvatar: cleanup removes this plugin\'s own listeners from the session (Rule I-4) and drops the session\'s reference to the player', () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
  assert.ok(session.listenerCount('ended') > 0);
  assert.ok(session.listenerCount('error') > 0);
  assert.ok(session.listenerCount('stateChange') > 0);
  session.emit('ended', {});
  assert.equal(session.listenerCount('ended'), 0, 'the ended listener this plugin registered must be gone after cleanup');
  assert.equal(session.listenerCount('error'), 0, 'the error listener this plugin registered must be gone after cleanup');
  assert.equal(session.listenerCount('stateChange'), 0, 'the stateChange listener this plugin registered must be gone after cleanup');

  // The misuse-guard's internal bookkeeping was cleared too — a fresh attach on the SAME
  // (now-ended) session constructs a brand-new player, with no stale warning.
  withWarnSpy((warnings) => {
    const secondAttach = attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
    assert.equal(FakeChromaKeyVideo.instances.length, 2);
    assert.notEqual(secondAttach, FakeChromaKeyVideo.instances[0]);
    assert.equal(warnings.length, 0);
  });
});

test('attachChromaKeyAvatar: guards double-destroy by checking the player\'s own isDestroyed flag first', () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  const player = attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });
  // Simulate the integrator having already destroyed the player through some other path
  // before the session ends.
  player.destroy();
  assert.equal(player.destroyCalls, 1);
  session.emit('ended', {});
  assert.equal(player.destroyCalls, 1, 'destroy() must not be called again once isDestroyed is already true');
});

// ─────────────────────────── srcObject reassignment (reconnect) needs no re-attach ───────────────────────────

test('attachChromaKeyAvatar: reassigning videoEl.srcObject on the SAME element after attach raises no error and requires no re-attach', () => {
  FakeChromaKeyVideo.reset();
  const videoEl = new FakeVideoEl();
  const session = new FakeSession(videoEl);
  const player = attachChromaKeyAvatar({ session, videoEl, ChromaKeyVideo: FakeChromaKeyVideo });

  assert.doesNotThrow(() => {
    // What a real WHEP reconnect does: session.js's pc.ontrack reassigns srcObject on the
    // SAME <video> element, then the element fires its usual playback events.
    videoEl.srcObject = { fakeStream: 'reconnected' };
    videoEl.dispatchEvent('loadedmetadata');
    videoEl.dispatchEvent('playing');
  });
  assert.equal(FakeChromaKeyVideo.instances.length, 1, 'no second player constructed on a srcObject reassignment');
  assert.equal(player.isDestroyed, false, 'the compositor survives a live stream reconnect untouched');
});
