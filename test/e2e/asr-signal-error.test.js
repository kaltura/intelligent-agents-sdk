// A server `asr-webrtc-error` fails the pending ASR step at once, with the same error an ASR timeout gives.
// Fake socket, fake RTC, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRTCPeerConnection } from '../fakes/rtc.js';
import { scriptHappyPath } from '../fakes/socket.js';
import { newAvatarSession as newSession, asrPeer } from '../fakes/avatar-session.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const ASR = { timeouts: { asr: 3000 } };

/** Poll `pred` every tick until it holds (bounded, so a regression fails instead of hanging). */
async function until(pred, what) {
  for (let i = 0; i < 500; i++) { if (pred()) return; await delay(1); }
  assert.fail(`timed out waiting for: ${what}`);
}

/** Collect unhandled rejections for the duration of a test. */
function trapUnhandled() {
  const seen = [];
  const h = (r) => seen.push(r);
  process.on('unhandledRejection', h);
  return { seen, off: () => process.off('unhandledRejection', h) };
}

/** Answer `trigger` with `asr-webrtc-error { error: 'E' }` instead of the happy-path reply. */
function errorInstead(socket, trigger) {
  const base = socket._onEmit;
  socket.onEmit((ev, p, s) => {
    if (ev === trigger) setTimeout(() => socket.server('asr-webrtc-error', { error: 'E' }), 0);
    else base(ev, p, s);
  });
}

async function timedReject(fn) {
  const t0 = Date.now();
  try { await fn(); } catch (err) { return { err, ms: Date.now() - t0 }; }
  return assert.fail('expected a rejection');
}

const assertAsrSignalError = (err, ms) => {
  assert.ok(ms < 1000, `settled on the frame, not on the ASR timer (${ms} ms)`);
  assert.equal(err.code, 'timeout');
  assert.equal(err.phase, 'asr');
  assert.equal(err.retryable, true);
  assert.match(err.detail, /signaling error/);
  assert.deepEqual(err.body, { error: 'E' });
};

test('asr-webrtc-error before asr-webrtc-ready fails connect() at once', async () => {
  const { session, socket } = newSession({ cfg: ASR });
  scriptHappyPath(socket);
  errorInstead(socket, 'asr-webrtc-init');
  const { err, ms } = await timedReject(() => session.connect());
  assertAsrSignalError(err, ms);
});

test('asr-webrtc-error after the offer fails connect() at once', async () => {
  const { session, socket } = newSession({ cfg: ASR });
  scriptHappyPath(socket);
  errorInstead(socket, 'asr-webrtc-offer');
  const { err, ms } = await timedReject(() => session.connect());
  assertAsrSignalError(err, ms);
});

test('the avatar lane is torn down and no wait is left', async () => {
  const { session, socket } = newSession({ cfg: ASR });
  scriptHappyPath(socket);
  errorInstead(socket, 'asr-webrtc-offer');
  await timedReject(() => session.connect());
  assert.ok(FakeRTCPeerConnection.instances.length > 0);
  assert.ok(FakeRTCPeerConnection.instances.every((pc) => pc.closed), 'every peer is closed');
  assert.equal(session._pendingAwaits.size, 0);
  assert.equal(session.state, 'error');
});

test('disconnect() during the ASR wait still rejects with connect_failed', async () => {
  const trap = trapUnhandled();
  try {
    const { session, socket } = newSession({ cfg: ASR });
    scriptHappyPath(socket);
    const base = socket._onEmit;
    socket.onEmit((ev, p, s) => { if (ev !== 'asr-webrtc-init') base(ev, p, s); });   // the ASR lane never answers
    const connecting = session.connect();
    await until(() => socket.didEmit('asr-webrtc-init'), 'ASR init sent');
    session.disconnect();
    const { err, ms } = await timedReject(() => connecting);
    assert.equal(err.code, 'connect_failed');
    assert.ok(ms < 1000);
    socket.server('asr-webrtc-error', { error: 'E' });
    await delay(20);
    assert.deepEqual(trap.seen, []);
  } finally { trap.off(); }
});

test('an asr-webrtc-error after the answer is ignored', async () => {
  const { session, socket } = newSession({ cfg: ASR });
  scriptHappyPath(socket);
  await session.connect();
  const errors = [];
  session.on('error', (e) => errors.push(e.code));
  socket.server('asr-webrtc-error', { error: 'E' });
  await delay(20);
  assert.equal(session.state, 'connected');
  assert.deepEqual(errors, []);
  session.disconnect();
});

test('asr-webrtc-error during ICE-restart recovery escalates at once', async () => {
  const { session, socket } = newSession({ cfg: ASR });
  scriptHappyPath(socket);
  await session.connect();
  const base = socket._onEmit;
  socket.onEmit((ev, p, s) => {
    if (ev === 'asr-webrtc-offer' && p?.is_reconnect) setTimeout(() => socket.server('asr-webrtc-error', { error: 'E' }), 0);
    else base(ev, p, s);
  });
  const seen = [];
  session.on('connectivityChanged', (p) => { if (p.state === 'recover_failed') seen.push('recover_failed'); });
  session.on('reconnecting', () => seen.push('reconnecting'));
  const t0 = Date.now();
  asrPeer().setIce('failed');
  await until(() => seen.includes('reconnecting'), 'the cold reconnect started');
  assert.ok(Date.now() - t0 < 1000, 'escalated on the frame, not on the ASR timer');
  assert.deepEqual(seen.slice(0, 2), ['recover_failed', 'reconnecting']);
  session.disconnect();
});
