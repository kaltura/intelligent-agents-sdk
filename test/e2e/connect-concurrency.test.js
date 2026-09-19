// connect(): the STV WHEP lane runs in parallel with the agent-wait → ASR lane.
// These tests pin the observable contract: WHEP starts as soon as the session
// exists (before the ASR handshake), the first failing lane rejects connect()
// at once, the losing lane never becomes an unhandled rejection, and every
// lane honours the 30s overall connect deadline (not just its own per-step cap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const okWhep = async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } });

function newSession(overrides = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const videoEl = 'videoEl' in overrides ? overrides.videoEl : new FakeVideoEl({ autoCanPlay: true });
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.avatar.us.kaltura.ai',
    videoEl, socketFactory: () => socket, rtcConstructor: overrides.rtcConstructor ?? FakeRTCPeerConnection,
    fetch: overrides.fetch ?? okWhep, getUserMedia: fakeGetUserMedia(),
    mediaStreamConstructor: FakeMediaStreamCtor,
    ...overrides.cfg,
  });
  return { session, socket, videoEl };
}

/** Collect unhandled rejections for the duration of a test (node would otherwise crash the run). */
function trapUnhandled() {
  const seen = [];
  const h = (r) => seen.push(r);
  process.on('unhandledRejection', h);
  return { seen, off: () => process.off('unhandledRejection', h) };
}

/** Make `Date.now()` report `ms` later than real time until `restore()`. */
function shiftClock(ms) {
  const real = Date.now;
  Date.now = () => real() + ms;
  return () => { Date.now = real; };
}

// ───────────────────────── ordering ─────────────────────────

test('WHEP POST goes out before the ASR handshake starts, and connect still approves after both', async () => {
  let asrInitAlreadySent = null;
  const fetch = async (...args) => { asrInitAlreadySent = socket.didEmit('asr-webrtc-init'); return okWhep(...args); };
  const { session, socket } = newSession({ fetch });
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(asrInitAlreadySent, false, 'WHEP subscribe did not wait behind agent-wait + ASR');
  assert.ok(socket.didEmit('asr-webrtc-offer'));
  assert.equal(socket.emitted.at(-1).event, 'approvedPermissions', 'approve is still the last connect emit');
  assert.equal(FakeRTCPeerConnection.instances.length, 2, 'ASR + STV peers');
  session.disconnect();
});

test('audio mode: no STV lane at all, single ASR peer', async () => {
  let fetchCalls = 0;
  const { session, socket } = newSession({ videoEl: null, fetch: async () => { fetchCalls++; return okWhep(); } });
  scriptHappyPath(socket, { audioMode: true });
  await session.connect();
  assert.equal(session.mode, 'audio');
  assert.equal(fetchCalls, 0, 'no WHEP request in audio mode');
  assert.equal(FakeRTCPeerConnection.instances.length, 1);
  session.disconnect();
});

// ───────────────────────── fail fast, loser handled ─────────────────────────

test('ASR failure while WHEP is still pending → one rejection, no unhandled rejection', async () => {
  const trap = trapUnhandled();
  try {
    class AsrRejectingPc extends FakeRTCPeerConnection {
      async setRemoteDescription(d) {
        if (d?.sdp === 'bad-asr-answer') throw Object.assign(new Error('bad asr answer'), { name: 'InvalidAccessError' });
        return super.setRemoteDescription(d);
      }
    }
    const heldWhep = () => new Promise(() => { /* never resolves: WHEP is the losing lane */ });
    const { session, socket } = newSession({ fetch: heldWhep, rtcConstructor: AsrRejectingPc });
    scriptHappyPath(socket, { asrAnswer: async () => ({ type: 'answer', sdp: 'bad-asr-answer' }) });
    const started = Date.now();
    await assert.rejects(() => session.connect(), (e) => e.code === 'connect_failed');
    assert.ok(Date.now() - started < 2000, 'did not wait for the held WHEP lane');
    assert.equal(session.state, 'error');
    assert.ok(!socket.didEmit('approvedPermissions'), 'never approves on a failed connect');
    await delay(20);
    assert.deepEqual(trap.seen, [], 'losing lane must not surface as an unhandled rejection');
  } finally { trap.off(); }
});

test('WHEP failure while the ASR answer never arrives → rejects whep_failed at once, no unhandled rejection', async () => {
  const trap = trapUnhandled();
  try {
    const failingWhep = async () => ({ ok: false, status: 404, text: async () => 'no such stream', headers: { get: () => null } });
    const { session, socket } = newSession({ fetch: failingWhep });
    scriptHappyPath(socket, { asrAnswer: () => new Promise(() => { /* ASR lane hangs */ }) });
    const started = Date.now();
    await assert.rejects(() => session.connect(), (e) => e.code === 'whep_failed');
    assert.ok(Date.now() - started < 2000, 'did not wait out the 30s ASR step timeout');
    assert.equal(session.state, 'error');
    assert.ok(!socket.didEmit('approvedPermissions'));
    await delay(20);
    assert.deepEqual(trap.seen, []);
  } finally { trap.off(); }
});

// ───────────────────────── overall deadline bounds every lane ─────────────────────────

test('ASR answer landing after the 30s overall deadline → ConnectTimeout, not a 30s ASR wait', async () => {
  let restore = () => {};
  try {
    const { session, socket } = newSession();
    scriptHappyPath(socket, { asrAnswer: async () => { restore = shiftClock(31_000); return { type: 'answer', sdp: 'late' }; } });
    await assert.rejects(() => session.connect(), (e) => e.code === 'timeout' && e.detail.startsWith('ConnectTimeout'));
    assert.equal(session.state, 'error');
  } finally { restore(); }
});

test('WHEP answer landing after the 30s overall deadline → ConnectTimeout', async () => {
  let restore = () => {};
  try {
    const lateWhep = async () => { restore = shiftClock(31_000); return okWhep(); };
    const { session, socket } = newSession({ fetch: lateWhep });
    scriptHappyPath(socket);
    await assert.rejects(() => session.connect(), (e) => e.code === 'timeout' && e.detail.startsWith('ConnectTimeout'));
    assert.equal(session.state, 'error');
    assert.ok(!socket.didEmit('approvedPermissions'));
  } finally { restore(); }
});
