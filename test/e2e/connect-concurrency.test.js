// connect(): the STV WHEP lane runs in parallel with the agent-wait → ASR lane.
// These tests pin the observable contract: WHEP starts as soon as the session
// exists (before the ASR handshake), the first failing lane rejects connect()
// at once, the losing lane never becomes an unhandled rejection, and every
// lane honours the 30s overall connect deadline (not just its own per-step cap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection } from '../fakes/rtc.js';
import { newAvatarSession as newSession, okWhep } from '../fakes/avatar-session.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** ASR peer whose remote-description step fails on a marked answer (the ASR lane loses). */
class AsrRejectingPc extends FakeRTCPeerConnection {
  async setRemoteDescription(d) {
    if (d?.sdp === 'bad-asr-answer') throw Object.assign(new Error('bad asr answer'), { name: 'InvalidAccessError' });
    return super.setRemoteDescription(d);
  }
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

// ───────────────────────── the losing lane leaves nothing behind ─────────────────────────

/** A fetch whose WHEP POST stays open until the test resolves it; DELETEs are recorded and succeed. */
function heldPostFetch() {
  const calls = [];
  let resolvePost = null;
  const fetch = (url, init) => {
    calls.push({ url, method: init?.method });
    if (init?.method === 'DELETE') return Promise.resolve({ ok: true, status: 200 });
    return new Promise((r) => { resolvePost = r; });
  };
  return { fetch, calls, deletes: () => calls.filter((c) => c.method === 'DELETE').map((c) => c.url), resolvePost: (res) => resolvePost(res) };
}

test('ASR fails while the WHEP POST is in flight → the late answer is released with a DELETE, never stored', async () => {
  const trap = trapUnhandled();
  try {
    const whep = heldPostFetch();
    const { session, socket } = newSession({ fetch: whep.fetch, rtcConstructor: AsrRejectingPc });
    scriptHappyPath(socket, { asrAnswer: async () => ({ type: 'answer', sdp: 'bad-asr-answer' }) });
    await assert.rejects(() => session.connect(), (e) => e.code === 'connect_failed');
    assert.equal(session.state, 'error');
    assert.equal(whep.calls.length, 1, 'the WHEP POST was still open when ASR failed');

    // The server answers the abandoned POST: it has allocated a downlink session for a peer
    // the teardown already closed. The SDK must release it and must not resurrect state.
    whep.resolvePost({ ok: true, status: 201, text: async () => 'v=0\r\nlate\r\n', headers: { get: (h) => (h === 'Location' ? '/whep/resource/late' : null) } });
    await delay(20);
    assert.deepEqual(whep.deletes(), ['https://srs.example/whep/resource/late'], 'late Location is resolved against the request URL and DELETEd');
    assert.equal(session._whepLocation, null, 'the abandoned answer never becomes the live WHEP resource');
    assert.equal(session.state, 'error');
    assert.deepEqual(trap.seen, []);
  } finally { trap.off(); }
});

test('ASR fails while the WHEP POST is in flight → a late non-2xx answer is dropped without a DELETE', async () => {
  const trap = trapUnhandled();
  try {
    const whep = heldPostFetch();
    const { session, socket } = newSession({ fetch: whep.fetch, rtcConstructor: AsrRejectingPc });
    scriptHappyPath(socket, { asrAnswer: async () => ({ type: 'answer', sdp: 'bad-asr-answer' }) });
    await assert.rejects(() => session.connect(), (e) => e.code === 'connect_failed');
    whep.resolvePost({ ok: false, status: 503, text: async () => 'busy', headers: { get: () => null } });
    await delay(20);
    assert.deepEqual(whep.deletes(), [], 'nothing was allocated, nothing to release');
    assert.equal(session._whepLocation, null);
    assert.equal(session.state, 'error');
    assert.deepEqual(trap.seen, []);
  } finally { trap.off(); }
});

test('ASR fails after the WHEP lane already subscribed → connect()\'s own failure path releases the subscription', async () => {
  const trap = trapUnhandled();
  try {
    // The mirror of the two tests above: here the STV lane WON the race and stored its
    // Location, so the release has to come from the failed connect()'s teardown.
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, method: init?.method || 'POST' });
      if (init?.method === 'DELETE') return { ok: true, status: 200 };
      return { ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: (h) => (h === 'Location' ? '/whep/resource/asr-lost' : null) } };
    };
    const { session, socket } = newSession({ fetch, rtcConstructor: AsrRejectingPc });
    scriptHappyPath(socket, { asrAnswer: async () => ({ type: 'answer', sdp: 'bad-asr-answer' }) });
    await assert.rejects(() => session.connect(), (e) => e.code === 'connect_failed');
    await delay(20);
    assert.deepEqual(
      calls.filter((c) => c.method === 'DELETE').map((c) => c.url),
      ['https://srs.example/whep/resource/asr-lost'],
      'a failed connect() must not leave the downlink subscription allocated',
    );
    assert.equal(session._whepLocation, null);
    assert.deepEqual(trap.seen, []);
  } finally { trap.off(); }
});

// ───────────────────────── teardown cancels a pending negotiation ─────────────────────────

test('disconnect() from a track listener settles connect() even when the peer leaves its negotiation promise pending', async () => {
  const trap = trapUnhandled();
  try {
    // A slow WHEP answer, so the ASR lane is already done and the STV lane is the only thing
    // Promise.all still waits on when the track arrives.
    const slowWhep = async (...args) => { await delay(50); return okWhep(...args); };
    const { session, socket } = newSession({ fetch: slowWhep });
    // `close()` does not settle the operations already queued on a peer connection: Firefox
    // leaves the `setRemoteDescription()` that fired `ontrack` pending forever. Nothing in that
    // lane is a socket wait, so without a cancel hook connect() would hang with no timeout.
    FakeRTCPeerConnection.hangUnsettledOnClose = true;
    scriptHappyPath(socket);
    session.on('track', () => session.disconnect());
    const outcome = await Promise.race([
      session.connect().then(() => 'resolved', (e) => e?.code || e?.message),
      delay(1000).then(() => 'hung'),
    ]);
    assert.equal(outcome, 'connect_failed');
    await delay(20);
    assert.deepEqual(trap.seen, [], 'the abandoned lane must not surface as an unhandled rejection');
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

test('WHEP answer landing after the 30s overall deadline → ConnectTimeout, and the answered subscription is released', async () => {
  let restore = () => {};
  try {
    // The POST already came back 201, so the server allocated a downlink session for this
    // answer. Aborting on the deadline still has to DELETE it: nothing else can, because the
    // abort happens before the Location is ever stored as the session's live subscription.
    const calls = [];
    const lateWhep = async (url, init) => {
      calls.push({ url, method: init?.method || 'POST' });
      if (init?.method === 'DELETE') return { ok: true, status: 200 };
      restore = shiftClock(31_000);
      return { ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: (h) => (h === 'Location' ? '/whep/resource/deadline' : null) } };
    };
    const { session, socket } = newSession({ fetch: lateWhep });
    scriptHappyPath(socket);
    await assert.rejects(() => session.connect(), (e) => e.code === 'timeout' && e.detail.startsWith('ConnectTimeout'));
    assert.equal(session.state, 'error');
    assert.ok(!socket.didEmit('approvedPermissions'));
    await delay(20);   // the release is fire-and-forget, so it lands a microtask later
    assert.deepEqual(
      calls.filter((c) => c.method === 'DELETE').map((c) => c.url),
      ['https://srs.example/whep/resource/deadline'],
      'exactly one DELETE, at the resolved absolute Location',
    );
    assert.equal(session._whepLocation, null, 'the aborted answer never becomes the live subscription');
  } finally { restore(); }
});
