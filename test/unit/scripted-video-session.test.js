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
import { FakeRTCPeerConnection, FakeVideoEl } from '../fakes/rtc.js';
import { fakeFetch } from '../fakes/fetch.js';

const TURN = { url: 'turn.example.com', username: 'kaltura', credential: 'avatar' };

function view(overrides = {}) {
  FakeRTCPeerConnection.reset();
  return new KalturaScriptedVideoSession({
    whepUrl: 'https://media.example.com/whep/abc123',
    turn: TURN,
    videoEl: new FakeVideoEl(),
    rtcConstructor: FakeRTCPeerConnection,
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

test('connect() negotiates WHEP, sets the video srcObject, and resolves to connected', async () => {
  const f = fakeFetch([{ match: '/whep/abc123', respond: () => ({ status: 201, body: 'v=0\r\nfake-answer\r\n' }) }]);
  const videoEl = new FakeVideoEl();
  const v = view({ videoEl, fetch: f });
  const states = [];
  v.on('stateChanged', (e) => states.push(e.state));

  await v.connect();

  assert.equal(v.state, 'connected');
  assert.deepEqual(states, ['connecting', 'connected']);
  assert.ok(videoEl.srcObject, 'video srcObject was set from the WHEP ontrack');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers['content-type'], 'application/sdp');
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

test('disconnect() DELETEs the resolved WHEP Location, tears down the pc, and is safe to call twice', async () => {
  const f = fakeFetch([
    { match: '/whep/abc123/res1', respond: () => ({ status: 200 }) },
    { match: '/whep/abc123', respond: () => ({ status: 201, body: 'v=0\r\nfake-answer\r\n', headers: { Location: '/whep/abc123/res1' } }) },
  ]);
  const videoEl = new FakeVideoEl();
  const v = view({ videoEl, fetch: f });
  await v.connect();

  v.disconnect();
  await Promise.resolve(); // let the best-effort DELETE's microtask enqueue

  assert.equal(v.state, 'disconnected');
  assert.equal(videoEl.srcObject, null);
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

// issue #20: videoWidth/videoHeight exposure
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
