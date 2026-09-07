/**
 * KalturaScriptedVideoSession — the WHEP-only viewer for STV-only sessions.
 * No socket.io, no brain: connect() just negotiates WHEP and resolves once
 * the stream is playable; disconnect() best-effort DELETEs the resolved
 * WHEP resource. Speech itself is driven server-side via
 * `Management#avatarSessions` (covered in avatar-sessions.test.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaScriptedVideoSession } from '../../src/experience/scripted-video-session.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor } from '../fakes/rtc.js';
import { fakeFetch } from '../fakes/fetch.js';

const TURN = { url: 'turn.example.com', username: 'kaltura', credential: 'avatar' };

function view(overrides = {}) {
  FakeRTCPeerConnection.reset();
  return new KalturaScriptedVideoSession({
    whepUrl: 'https://media.example.com/whep/abc123',
    turn: TURN,
    videoEl: new FakeVideoEl(),
    rtcConstructor: FakeRTCPeerConnection,
    mediaStreamConstructor: FakeMediaStreamCtor,
    ...overrides,
  });
}

test('constructor rejects a missing whepUrl before touching the network', () => {
  assert.throws(() => new KalturaScriptedVideoSession({ turn: TURN }), (e) => e.code === 'bad_request');
});

test('constructor rejects a missing turn before touching the network', () => {
  assert.throws(() => new KalturaScriptedVideoSession({ whepUrl: 'https://media.example.com/whep/abc123' }), (e) => e.code === 'bad_request');
});

test('constructor rejects a whepUrl resolving to a private IP', () => {
  assert.throws(
    () => new KalturaScriptedVideoSession({ whepUrl: 'https://192.168.1.5/whep/abc123', turn: TURN }),
    (e) => e.code === 'whep_private_ip',
  );
});

test('constructor allows a public cleartext http whepUrl (no scheme check beyond the private-IP guard, matching KalturaAvatarSession)', () => {
  const v = new KalturaScriptedVideoSession({ whepUrl: 'http://media.example.com/whep/abc123', turn: TURN });
  assert.equal(v.state, 'idle');
});

test('connect() negotiates WHEP, routes both tracks to videoEl (one srcObject, one play()), and resolves to connected', async () => {
  const f = fakeFetch([{ match: '/whep/abc123', respond: () => ({ status: 201, body: 'v=0\r\nfake-answer\r\n' }) }]);
  const videoEl = new FakeVideoEl();
  const v = view({ videoEl, fetch: f });
  const states = [];
  v.on('stateChanged', (e) => states.push(e.state));

  await v.connect();

  assert.equal(v.state, 'connected');
  assert.deepEqual(states, ['connecting', 'connected']);
  assert.deepEqual(videoEl.srcObject.getTracks().map((t) => t.kind).sort(), ['audio', 'video'], 'videoEl plays both tracks in the default (simple) mode');
  assert.equal(videoEl.srcObjectAssignments, 1);
  assert.equal(videoEl.playCount, 1);
  assert.equal(v.audioEl, null, 'no SDK-created audio element');
  assert.ok(v.avatarStream, 'avatarStream is exposed');
  assert.deepEqual(v.avatarStream.getTracks().map((t) => t.kind).sort(), ['audio', 'video']);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers['content-type'], 'application/sdp');
});

test('connect() with cfg.audioEl splits: video on videoEl, audio on audioEl, one srcObject + one play() each', async () => {
  const f = fakeFetch([{ match: '/whep/abc123', respond: () => ({ status: 201, body: 'v=0\r\nfake-answer\r\n' }) }]);
  const videoEl = new FakeVideoEl();
  const audioEl = new FakeVideoEl();
  const v = view({ videoEl, audioEl, fetch: f });
  await v.connect();
  assert.deepEqual(videoEl.srcObject.getTracks().map((t) => t.kind), ['video']);
  assert.deepEqual(audioEl.srcObject.getTracks().map((t) => t.kind), ['audio']);
  assert.equal(videoEl.playCount, 1); assert.equal(audioEl.playCount, 1);
  assert.equal(v.audioEl, audioEl);
  v.disconnect();
  assert.equal(videoEl.srcObject, null); assert.equal(audioEl.srcObject, null);
  assert.equal(v.audioEl, audioEl, 'the binding survives disconnect');
});

test('connect() works headless (no videoEl) — resolves once ontrack fires', async () => {
  const f = fakeFetch([{ match: '/whep/abc123', respond: () => ({ status: 201, body: 'v=0\r\nfake-answer\r\n' }) }]);
  const v = view({ videoEl: undefined, fetch: f });
  let tracked = false;
  v.on('track', () => { tracked = true; });

  await v.connect();

  assert.equal(v.state, 'connected');
  assert.ok(tracked);
});

test('connect() surfaces a WHEP 404 as a whep_failed error with an actionable hint, and tears down the pc', async () => {
  const f = fakeFetch([{ match: '/whep/abc123', respond: () => ({ status: 404, body: { message: 'no active session' } }) }]);
  const v = view({ fetch: f });

  await assert.rejects(() => v.connect(), (e) => e.code === 'whep_failed' && /no active STV session|no active session/i.test(e.detail));
  assert.equal(v.state, 'error');
  assert.equal(FakeRTCPeerConnection.instances[0].closed, true);
});

test('connect() rejects if the WHEP response Location header resolves to a private IP', async () => {
  const f = fakeFetch([{ match: '/whep/abc123', respond: () => ({ status: 201, body: 'v=0\r\nfake-answer\r\n', headers: { Location: 'https://10.0.0.9/whep/abc123/res1' } }) }]);
  const v = view({ fetch: f });

  await assert.rejects(() => v.connect(), (e) => e.code === 'whep_private_ip');
  assert.equal(v.state, 'error');
});

test('connect() cannot be called twice from a non-idle state', async () => {
  const f = fakeFetch([{ match: '/whep/abc123', respond: () => ({ status: 201, body: 'v=0\r\nfake-answer\r\n' }) }]);
  const v = view({ fetch: f });
  await v.connect();
  await assert.rejects(() => v.connect(), (e) => e.code === 'invalid_state');
});

test('disconnect() DELETEs the resolved WHEP Location, tears down the pc, stops both tracks and clears srcObject', async () => {
  const f = fakeFetch([
    { match: '/whep/abc123/res1', respond: () => ({ status: 200 }) },
    { match: '/whep/abc123', respond: () => ({ status: 201, body: 'v=0\r\nfake-answer\r\n', headers: { Location: '/whep/abc123/res1' } }) },
  ]);
  const videoEl = new FakeVideoEl();
  const v = view({ videoEl, fetch: f });
  await v.connect();
  const tracks = videoEl.srcObject.getTracks();
  assert.equal(tracks.length, 2);

  v.disconnect();
  await Promise.resolve(); // let the best-effort DELETE's microtask enqueue

  assert.equal(v.state, 'disconnected');
  assert.equal(videoEl.srcObject, null);
  assert.ok(tracks.every((t) => t.readyState === 'ended'), 'both downlink tracks are stopped');
  assert.equal(v.avatarStream, null);
  assert.equal(v.videoEl, videoEl, 'the element binding survives disconnect');
  assert.equal(FakeRTCPeerConnection.instances[0].closed, true);

  // Safe to call again — no throw, no duplicate network call.
  v.disconnect();
  assert.equal(v.state, 'disconnected');
});

test('disconnect() before connect() is a safe no-op', () => {
  const v = view();
  v.disconnect();
  assert.equal(v.state, 'disconnected');
});

// videoWidth/videoHeight exposure
test("emits 'videoMetadata' once decoded dimensions are known (videoEl configured)", async () => {
  const f = fakeFetch([{ match: '/whep/abc123', respond: () => ({ status: 201, body: 'v=0\r\nfake-answer\r\n' }) }]);
  const videoEl = new FakeVideoEl({ autoCanPlay: false });
  const v = view({ videoEl, fetch: f });
  const events = [];
  v.on('videoMetadata', (p) => events.push(p));

  const connectP = v.connect();
  await delay(20);
  videoEl.fireLoadedMetadata(960, 540);
  videoEl.fireCanPlay();
  await connectP;

  assert.deepEqual(events, [{ videoWidth: 960, videoHeight: 540 }]);
  assert.equal(events.length, 1, 'exactly once per connect, despite ontrack firing for both video and audio tracks');
});

test('regression: the 6s hard-cap timer is cleared on connect and on disconnect (no stray resolve, no open handle)', async () => {
  const f = fakeFetch([{ match: '/whep/abc123', respond: () => ({ status: 201, body: 'v=0\r\nfake-answer\r\n' }) }]);
  const videoEl = new FakeVideoEl({ autoCanPlay: false });
  const v = view({ videoEl, fetch: f });
  const origSetTimeout = globalThis.setTimeout, origClearTimeout = globalThis.clearTimeout;
  const armed = new Set(), cleared = new Set();
  globalThis.setTimeout = (fn, ms) => { const id = origSetTimeout(fn, ms); if (ms === 6000) armed.add(id); return id; };
  globalThis.clearTimeout = (id) => { if (armed.has(id)) cleared.add(id); return origClearTimeout(id); };
  try {
    const p = v.connect();
    await delay(20);
    assert.equal(armed.size, 1, 'hard cap armed once');
    v.disconnect();   // mid-connect: canplay never fired
    await p.catch(() => {});
    assert.equal(cleared.size, 1, 'disconnect() clears the pending hard cap');
  } finally { globalThis.setTimeout = origSetTimeout; globalThis.clearTimeout = origClearTimeout; }
});

test('a stale peer (closed by disconnect) firing ontrack does not touch the element', async () => {
  const f = fakeFetch([{ match: '/whep/abc123', respond: () => ({ status: 201, body: 'v=0\r\nfake-answer\r\n' }) }]);
  const videoEl = new FakeVideoEl();
  const v = view({ videoEl, fetch: f });
  await v.connect();
  const pc = FakeRTCPeerConnection.instances[0];
  v.disconnect();
  const writes = videoEl.srcObjectAssignments;
  pc.fireTrack('video');
  assert.equal(videoEl.srcObjectAssignments, writes, 'no srcObject write from a closed peer');
  assert.equal(v.avatarStream, null);
});

test('cfg.logger receives media diagnostics (setSinkId rejected)', async () => {
  const f = fakeFetch([{ match: '/whep/abc123', respond: () => ({ status: 201, body: 'v=0\r\nfake-answer\r\n' }) }]);
  const videoEl = new FakeVideoEl();
  const logs = [];
  const v = view({ videoEl, fetch: f, logger: (level, msg, data) => logs.push({ level, msg, data }) });
  await v.connect();
  videoEl._sinkIdFailTimes = 1;
  assert.equal(await v.setAudioOutput('spk-x'), false);
  assert.ok(logs.some((l) => l.level === 'warn' && /setSinkId/.test(l.msg)));
  v.disconnect();
});

test("regression: 'videoMetadata' never fires when videoEl is omitted (headless)", async () => {
  const f = fakeFetch([{ match: '/whep/abc123', respond: () => ({ status: 201, body: 'v=0\r\nfake-answer\r\n' }) }]);
  const v = view({ videoEl: undefined, fetch: f });
  const events = [];
  v.on('videoMetadata', (p) => events.push(p));

  await v.connect();

  assert.equal(events.length, 0);
  assert.equal(v.state, 'connected', 'still connects normally without a videoEl');
});

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

test("disconnect() inside a 'track' listener defers the peer's close() to the next macrotask (Chromium hang guard); outside it, close() is synchronous", async () => {
  const f = fakeFetch([{ match: '/whep/abc123', respond: () => ({ status: 201, body: 'v=0\r\nfake-answer\r\n' }) }]);
  const videoEl = new FakeVideoEl();
  const v = view({ videoEl, fetch: f });
  const seen = [];
  v.on('track', ({ track }) => {
    if (track.kind !== 'video') return;
    const pc = FakeRTCPeerConnection.instances[0];
    v.disconnect();
    seen.push({ state: v.state, closedSync: pc.closed, srcObject: videoEl.srcObject, pcRef: v._pc, pc });
  });
  await v.connect().catch(() => {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state, 'disconnected');
  assert.equal(seen[0].srcObject, null);
  assert.equal(seen[0].pcRef, null);
  assert.equal(seen[0].closedSync, false, 'close() is not called inside the ontrack dispatch');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seen[0].pc.closed, true, 'close() lands on the next macrotask');
  assert.equal(v._inOntrack, false);

  const v2 = view({ fetch: f });
  await v2.connect();
  const pc2 = FakeRTCPeerConnection.instances[0];
  v2.disconnect();
  assert.equal(pc2.closed, true, 'outside ontrack the close is synchronous');
});
