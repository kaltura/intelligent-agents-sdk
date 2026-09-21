// disconnect() while a connect lane or a cold reconnect is still waiting: every pending wait
// settles at once, never on its own (up to 30 s) timeout, and whatever the server allocated
// for an abandoned request is released. Fake socket, fake RTC, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptHappyPath } from '../fakes/socket.js';
import { newAvatarSession as newSession } from '../fakes/avatar-session.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * A fetch whose WHEP POST stays open until the test resolves it. Records each call's
 * `signal` so the test can see the abort; ignores it otherwise, like a fetch whose
 * response is already on the wire when the abort lands. DELETEs succeed and are recorded.
 */
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

// ───────────────────────── WHEP POST ─────────────────────────

test('disconnect() while the WHEP POST is in flight: connect() rejects at once and the request is aborted', async () => {
  const trap = trapUnhandled();
  try {
    const whep = heldPostFetch();
    const { session, socket } = newSession({ fetch: whep.fetch });
    scriptHappyPath(socket);
    const connecting = session.connect();
    await until(() => whep.calls.length === 1 && socket.didEmit('asr-webrtc-offer'), 'WHEP POST out, ASR lane started');
    await delay(20);   // let the ASR lane finish: the POST is the only thing connect() still waits on

    const started = Date.now();
    session.disconnect();
    await assert.rejects(() => connecting, (e) => e.code === 'connect_failed');
    assert.ok(Date.now() - started < 1000, 'settled on the cancel, not on a WHEP/overall timeout');
    assert.equal(whep.calls[0].signal?.aborted, true, 'the abort signal reached the fetch');
    assert.equal(session._whepLocation, null);
    assert.ok(!socket.didEmit('approvedPermissions'));
    await delay(20);
    assert.deepEqual(whep.deletes(), [], 'nothing was answered, so nothing to release');
    assert.deepEqual(trap.seen, []);
  } finally { trap.off(); }
});

test('disconnect() while the WHEP POST is in flight: a 201 that lands after the cancel is released with a DELETE', async () => {
  const trap = trapUnhandled();
  try {
    const whep = heldPostFetch();
    const { session, socket } = newSession({ fetch: whep.fetch });
    scriptHappyPath(socket);
    const connecting = session.connect();
    await until(() => whep.calls.length === 1, 'WHEP POST out');
    session.disconnect();
    await assert.rejects(() => connecting, (e) => e.code === 'connect_failed');

    // The server answered anyway: it allocated a downlink session for a peer the teardown
    // already closed. Release it, and never let it become the live subscription.
    whep.resolvePost(lateAnswer('/whep/resource/after-disconnect'));
    await delay(20);
    assert.deepEqual(whep.deletes(), ['https://srs.example/whep/resource/after-disconnect'], 'late Location resolved against the request URL and DELETEd');
    assert.equal(session._whepLocation, null);
    assert.deepEqual(trap.seen, []);
  } finally { trap.off(); }
});

test('disconnect() while the WHEP POST is in flight: a late non-2xx answer is dropped without a DELETE', async () => {
  const trap = trapUnhandled();
  try {
    const whep = heldPostFetch();
    const { session, socket } = newSession({ fetch: whep.fetch });
    scriptHappyPath(socket);
    const connecting = session.connect();
    await until(() => whep.calls.length === 1, 'WHEP POST out');
    session.disconnect();
    await assert.rejects(() => connecting, (e) => e.code === 'connect_failed');
    whep.resolvePost({ ok: false, status: 503, text: async () => 'busy', headers: { get: () => null } });
    await delay(20);
    assert.deepEqual(whep.deletes(), []);
    assert.deepEqual(trap.seen, []);
  } finally { trap.off(); }
});

// ───────────────────────── capacity wait ─────────────────────────

test('disconnect() during a cold reconnect\'s capacity wait settles the reconnect at once and stops polling', async () => {
  const trap = trapUnhandled();
  try {
    const { session, socket } = newSession();
    scriptHappyPath(socket);
    await session.connect();
    assert.equal(session.state, 'connected');

    // The rebuilt session's `stvNewSession` is never answered: the server is out of capacity
    // and says nothing. Everything else (join, availability) keeps flowing.
    const script = socket._onEmit;
    let sessionRequests = 0;   // counts only the rebuild's requests: the first connect's already went by
    socket.onEmit((ev, payload, s) => {
      if (ev === 'stvNewSession' && ++sessionRequests === 1) return;
      script(ev, payload, s);
    });
    const errors = [];
    session.on('error', (e) => errors.push(e));
    const reconnect = session._coldReconnect('media stv failed');
    await until(() => sessionRequests === 1, 'the rebuilt session asked for a new STV session');
    await delay(5);
    assert.notEqual(session.state, 'connected', 'still waiting on the session/capacity reply');

    const started = Date.now();
    session.disconnect();
    const outcome = await Promise.race([reconnect.then(() => 'settled'), delay(1000).then(() => 'hung')]);
    assert.equal(outcome, 'settled', 'the capacity wait was cancelled with the rest of the teardown');
    assert.ok(Date.now() - started < 1000, 'not the 30 s overall deadline');
    assert.equal(session.state, 'disconnected', 'a user disconnect ends in disconnected, not error');
    assert.deepEqual(errors, [], 'no reconnect_failed error for a wait the caller cancelled');
    assert.equal(session._capacityTimer, null);
    assert.equal(session._coldReconnecting, false);

    // Nothing keeps polling capacity on a dead session.
    const polls = socket.emitsOf('checkAvailability').length;
    await delay(50);
    assert.equal(socket.emitsOf('checkAvailability').length, polls);
    assert.deepEqual(trap.seen, []);
  } finally { trap.off(); }
});
