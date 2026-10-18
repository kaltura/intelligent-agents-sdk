// A refused session (`unsupportedClient`) fails every pending setup wait at once, never on the wait's
// own timer. The error event keeps firing as before. A live session keeps ending through the server's
// disconnect. Fake socket, fake RTC, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';
import { newAvatarSession as newSession, asrPeer } from '../fakes/avatar-session.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const SHORT = { serverConnect: 2000, joinRoom: 2000, joinComplete: 2000, asr: 2000 };

/** Collect unhandled rejections for the duration of a test (node would otherwise crash the run). */
function trapUnhandled() {
  const seen = [];
  const h = (r) => seen.push(r);
  process.on('unhandledRejection', h);
  return { seen, off: () => process.off('unhandledRejection', h) };
}

/** Poll `pred` every tick until it holds (bounded, so a regression fails instead of hanging). */
async function until(pred, what) {
  for (let i = 0; i < 500; i++) { if (pred()) return; await delay(1); }
  assert.fail(`timed out waiting for: ${what}`);
}

/** Run a test body with an unhandled-rejection trap that must stay empty. */
const trapped = (fn) => async () => {
  const trap = trapUnhandled();
  try { await fn(); await delay(20); assert.deepEqual(trap.seen, []); } finally { trap.off(); }
};

/** Deliver `unsupportedClient { code: 'X' }` in place of the server's next `event` frames. */
function refuseInstead(socket, ...events) {
  const real = socket.server.bind(socket);
  socket.server = (ev, payload) => (events.includes(ev) ? real('unsupportedClient', { code: 'X' }) : real(ev, payload));
}

/** Time a rejection: resolves `{ err, ms }`. @param {() => Promise<any>} fn */
async function timedReject(fn) {
  const t0 = Date.now();
  try { await fn(); } catch (err) { return { err, ms: Date.now() - t0 }; }
  return assert.fail('expected a rejection');
}

const assertRefused = (err, ms, what) => {
  assert.ok(ms < 1000, `${what}: settled on the frame, not on a step timer (${ms} ms)`);
  assert.equal(err.code, 'unsupported_client', what);
  assert.equal(err.phase, 'connect');
  assert.equal(err.retryable, false);
  assert.ok(!String(err.detail).includes('X'), 'the server payload is not copied into the detail');
};

function heldPostFetch() {
  const calls = [];
  let resolvePost = null;
  const fetch = (url, init) => {
    calls.push({ url, method: init?.method, signal: init?.signal });
    if (init?.method === 'DELETE') return Promise.resolve({ ok: true, status: 200 });
    return new Promise((r) => { resolvePost = r; });
  };
  return { fetch, calls, deletes: () => calls.filter((c) => c.method === 'DELETE').map((c) => c.url), resolvePost: (res) => resolvePost(res) };
}
const lateAnswer = (location) => ({ ok: true, status: 201, text: async () => 'v=0\r\nlate\r\n', headers: { get: (h) => (h === 'Location' ? location : null) } });

// ───────────────────────── connect() ─────────────────────────

test('unsupportedClient before onServerConnected rejects connect() at once', trapped(async () => {
  const { session, socket } = newSession({ cfg: { timeouts: SHORT } });
  scriptHappyPath(socket);
  refuseInstead(socket, 'onServerConnected');
  const { err, ms } = await timedReject(() => session.connect());
  assertRefused(err, ms, 'serverConnect wait');
  assert.ok(err.timings, 'timings attached like any other connect() rejection');
  assert.equal(session.state, 'error');
  assert.equal(session._pendingAwaits.size, 0);
}));

test('unsupportedClient during the join wait rejects at once', trapped(async () => {
  const { session, socket } = newSession({ cfg: { timeouts: SHORT } });
  scriptHappyPath(socket);
  refuseInstead(socket, 'clientConfiguration', 'joinComplete');
  const { err, ms } = await timedReject(() => session.connect());
  assertRefused(err, ms, 'join wait');
  assert.equal(session._pendingAwaits.size, 0);
}));

test('unsupportedClient while waiting for a free avatar rejects at once and leaves no timer', trapped(async () => {
  const intervals = [], cleared = new Set();
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  globalThis.setInterval = (...a) => { const h = realSet(...a); intervals.push(h); return h; };
  globalThis.clearInterval = (h) => { cleared.add(h); return realClear(h); };
  try {
    const { session, socket } = newSession({ cfg: { timeouts: SHORT } });
    scriptHappyPath(socket);
    refuseInstead(socket, 'stvNewSession');
    const { err, ms } = await timedReject(() => session.connect());
    assertRefused(err, ms, 'capacity wait');
    assert.equal(session._pendingAwaits.size, 0);
    assert.equal(session._capacityTimer, null);
    assert.ok(intervals.length > 0, 'the capacity guard ran');
    assert.ok(intervals.every((h) => cleared.has(h)), 'every interval it started was cleared');
  } finally { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; }
}));

test('unsupportedClient during the ASR wait rejects at once and closes both peers', trapped(async () => {
  const { session, socket } = newSession({ cfg: { timeouts: SHORT } });
  scriptHappyPath(socket);
  refuseInstead(socket, 'asr-webrtc-ready');
  const { err, ms } = await timedReject(() => session.connect());
  assertRefused(err, ms, 'ASR wait');
  assert.ok(FakeRTCPeerConnection.instances.length > 0);
  assert.ok(FakeRTCPeerConnection.instances.every((pc) => pc.closed), 'every peer is closed');
}));

test('unsupportedClient while the WHEP request is in flight rejects at once and releases a late answer once', trapped(async () => {
  const whep = heldPostFetch();
  const { session, socket } = newSession({ fetch: whep.fetch, cfg: { timeouts: SHORT } });
  scriptHappyPath(socket);
  const connecting = session.connect();
  const settled = timedReject(() => connecting);
  await until(() => whep.calls.length === 1 && socket.didEmit('asr-webrtc-offer'), 'WHEP POST out, ASR lane started');
  await delay(20);
  socket.server('unsupportedClient', { code: 'X' });
  const { err, ms } = await settled;
  assert.ok(ms < 1000);
  assert.equal(err.code, 'unsupported_client');
  assert.equal(whep.calls[0].signal?.aborted, true, 'the abort signal reached the fetch');
  assert.equal(session._whepLocation, null);
  whep.resolvePost(lateAnswer('/whep/resource/after-refusal'));
  await delay(20);
  assert.deepEqual(whep.deletes(), ['https://srs.example/whep/resource/after-refusal'], 'one DELETE for the late answer');
  assert.equal(session._whepLocation, null);
}));

test('the error event fires once and before the rejection', trapped(async () => {
  const { session, socket } = newSession({ cfg: { timeouts: SHORT } });
  scriptHappyPath(socket);
  refuseInstead(socket, 'onServerConnected');
  const order = [];
  session.on('error', (e) => order.push(`error:${e.code}`));
  await session.connect().catch((e) => order.push(`reject:${e.code}`));
  assert.deepEqual(order, ['error:unsupported_client', 'reject:unsupported_client']);
}));

test('disconnect() mid-handshake still rejects with connect_failed', trapped(async () => {
  const { session, socket } = newSession({ cfg: { timeouts: SHORT } });
  scriptHappyPath(socket);
  const real = socket.server.bind(socket);
  socket.server = (ev, payload) => { if (ev !== 'clientConfiguration' && ev !== 'joinComplete') real(ev, payload); };   // the join is never answered
  const connecting = session.connect();
  await until(() => socket.didEmit('join'), 'join sent');
  session.disconnect();
  const { err, ms } = await timedReject(() => connecting);
  assert.equal(err.code, 'connect_failed');
  assert.ok(ms < 1000);
  assert.equal(session._pendingAwaits.size, 0);
}));

// ───────────────────────── prepare() ─────────────────────────

test('unsupportedClient during prepare() rejects prepare() at once, and a later connect() starts fresh', trapped(async () => {
  FakeRTCPeerConnection.reset();
  const sockets = [];
  const session = new KalturaAvatarSession({
    token: newSession().session._token, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), rtcConstructor: FakeRTCPeerConnection,
    fetch: fakeWhepFetch([{}]), getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor,
    timeouts: SHORT,
    socketFactory: () => {
      const s = new FakeSocket();
      scriptHappyPath(s);
      if (sockets.length === 0) refuseInstead(s, 'clientConfiguration', 'joinComplete');
      sockets.push(s);
      return s;
    },
  });
  const { err, ms } = await timedReject(() => session.prepare());
  assertRefused(err, ms, 'prepare()');
  assert.equal(session._prep, null);
  await session.connect();
  assert.equal(sockets.length, 2, 'connect() opened a new socket');
  assert.equal(session.state, 'connected');
  session.disconnect();
}));

// ───────────────────────── config error frame (C1-05) ─────────────────────────

test('a config error followed by unsupportedClient rejects connect() at once', trapped(async () => {
  const { session, socket } = newSession({ cfg: { timeouts: SHORT } });
  scriptHappyPath(socket);
  const real = socket.server.bind(socket);
  socket.server = (ev, payload) => {
    if (ev === 'onServerConnected') { real('configNotice', { reason: 'R', message: 'M' }); real('unsupportedClient', { code: 'X' }); return; }
    real(ev, payload);
  };
  const { err, ms } = await timedReject(() => session.connect());
  assertRefused(err, ms, 'config error then refusal');
  assert.ok(!/\b[RM]\b/.test(`${err.detail} ${JSON.stringify(err.toJSON())}`), 'the reason and message are not surfaced');
}));

test('a config error alone changes nothing', trapped(async () => {
  const { session, socket } = newSession({ cfg: { timeouts: { ...SHORT, serverConnect: 300 } } });
  scriptHappyPath(socket);
  const real = socket.server.bind(socket);
  socket.server = (ev, payload) => {
    if (ev === 'onServerConnected') { real('configNotice', { reason: 'R', message: 'M' }); return; }
    real(ev, payload);
  };
  const errors = [];
  session.on('error', (e) => errors.push(e.code));
  const { err, ms } = await timedReject(() => session.connect());
  assert.equal(err.code, 'timeout', 'connect() ends on its own timer');
  assert.ok(ms >= 250);
  assert.deepEqual(errors, []);
}));

// ───────────────────────── resume() rebuild ─────────────────────────

test('unsupportedClient during the resume() rebuild rejects resume() at once', trapped(async () => {
  const { session, socket } = newSession({ cfg: { timeouts: SHORT } });
  scriptHappyPath(socket);
  await session.connect();
  const base = socket._onEmit;
  socket.onEmit((ev, p, s) => {
    if (ev === 'stvNewSession') setTimeout(() => socket.server('unsupportedClient', { code: 'X' }), 0);
    else base(ev, p, s);
  });
  const ended = [];
  session.on('ended', (p) => ended.push(p.reason));
  session.pause();
  socket.server('pauseSessionExpired', {});
  const { err, ms } = await timedReject(() => session.resume());
  assert.ok(ms < 1000, `resume() settled on the frame (${ms} ms)`);
  assert.equal(err.code, 'unsupported_client');
  assert.deepEqual(ended, ['resume_failed']);
}));

// ───────────────────────── cold reconnect ─────────────────────────

async function coldSession() {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({
    token: newSession().session._token, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: fakeWhepFetch([{}]), getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false,
    timeouts: { ...SHORT, coldBackoff: 20 },
  });
  scriptHappyPath(socket, { resumingOnRecreate: false });
  await session.connect();
  const ev = [];
  for (const e of ['reconnecting', 'reconnected', 'ended', 'error']) session.on(e, (p) => ev.push(e === 'ended' ? `ended:${p.reason}` : e === 'error' ? `error:${p.code}` : e));
  return { session, socket, ev };
}

test('unsupportedClient during a cold reconnect fails the attempt at once (reconnect_failed)', trapped(async () => {
  const { session, socket, ev } = await coldSession();
  refuseInstead(socket, 'clientConfiguration', 'joinComplete');
  const t0 = Date.now();
  socket.dropAndRecover('transport close', { recovered: false });
  await until(() => ev.includes('ended:reconnect_failed'), 'the reconnect gave up');
  assert.ok(Date.now() - t0 < 1000, 'both attempts failed on the frame');
  assert.deepEqual(ev.filter((e) => e !== 'error:unsupported_client'), ['reconnecting', 'error:reconnect_failed', 'ended:reconnect_failed']);
  assert.equal(session.state, 'disconnected');
}));

test('unsupportedClient during a cold reconnect, then a server disconnect: the session ends', trapped(async () => {
  const { session, socket, ev } = await coldSession();
  const real = socket.server.bind(socket);
  socket.server = (e, p) => {
    if (e === 'clientConfiguration' || e === 'joinComplete') { real('unsupportedClient', { code: 'X' }); real('disconnect', 'io server disconnect'); return; }
    real(e, p);
  };
  const t0 = Date.now();
  socket.dropAndRecover('transport close', { recovered: false });
  await until(() => ev.some((e) => e.startsWith('ended:')), 'the session ended');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(ev.find((e) => e.startsWith('ended:')), 'ended:io server disconnect');
  assert.equal(session.state, 'disconnected');
}));

// ───────────────────────── live session ─────────────────────────

test('unsupportedClient while connected only emits error', trapped(async () => {
  const { session, socket } = newSession({ cfg: { timeouts: SHORT } });
  scriptHappyPath(socket);
  await session.connect();
  const errors = [];
  session.on('error', (e) => errors.push(e.code));
  socket.server('unsupportedClient', { code: 'X' });
  assert.deepEqual(errors, ['unsupported_client']);
  assert.equal(session.state, 'connected');
  session.disconnect();
}));

test('unsupportedClient during a media recovery keeps today\'s end', trapped(async () => {
  const { session, socket } = newSession({ cfg: { timeouts: SHORT } });
  scriptHappyPath(socket);
  await session.connect();
  const base = socket._onEmit;
  socket.onEmit((ev, p, s) => {
    if (ev === 'asr-webrtc-offer' && p?.is_reconnect) {
      // Two frames on two ticks, like the wire: the refusal first, the socket close after it.
      setTimeout(() => { socket.server('unsupportedClient', { code: 'X' }); setTimeout(() => socket.server('disconnect', 'io server disconnect'), 5); }, 0);
    } else base(ev, p, s);
  });
  const seen = [];
  session.on('ended', (p) => seen.push(`ended:${p.reason}`));
  session.on('reconnecting', () => seen.push('reconnecting'));
  session.on('connectivityChanged', (p) => { if (p.state === 'recover_failed') seen.push('recover_failed'); });
  asrPeer().setIce('failed');
  await until(() => seen.length > 0, 'the session ended');
  await delay(50);
  assert.deepEqual(seen, ['ended:io server disconnect']);
  assert.equal(session.state, 'disconnected');
}));
