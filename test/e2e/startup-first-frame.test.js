// Startup: connect() resolves at the first painted frame, the no-frame cap starts at the WHEP
// answer, one re-subscribe, then a degraded mediaReady. Phase timings of the connect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor, fakeGetUserMedia } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('until(): condition not met');
    await delay(5);
  }
}

function setup({ steps = [{}], firstFrame = 5000, videoEl, cfg = {} } = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  scriptHappyPath(socket);
  const el = videoEl === undefined ? new FakeVideoEl({ rvfc: true }) : videoEl;
  const whep = fakeWhepFetch(steps);
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: el, socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: whep, getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor,
    timeouts: { firstFrame },
    ...cfg,
  });
  /** @type {any[]} */ const ready = []; /** @type {any[]} */ const warnings = []; /** @type {any[]} */ const meta = [];
  session.on('mediaReady', (p) => ready.push(p));
  session.on('warning', (w) => warnings.push(w));
  session.on('videoMetadata', (p) => meta.push(p));
  return { session, socket, el, whep, ready, warnings, meta };
}

test('connect() waits for the first painted frame, then resolves with its size', async () => {
  const { session, el, ready, meta } = setup();
  let resolved = false;
  const p = session.connect().then(() => { resolved = true; });
  await until(() => el._frameCbs.size > 0);
  await delay(50);
  assert.equal(resolved, false, 'a track and canplay are not enough');
  assert.deepEqual(ready, []);
  el.fireFrame(1280, 720);
  await p;
  assert.deepEqual(ready, [{ mode: 'video', videoWidth: 1280, videoHeight: 720 }]);
  assert.deepEqual(meta, [{ videoWidth: 1280, videoHeight: 720 }], 'videoMetadata fires once');
  session.disconnect();
});

test('a zero-size frame callback does not count; the next real one does', async () => {
  const { session, el, ready } = setup();
  const p = session.connect();
  await until(() => el._frameCbs.size > 0);
  el.fireFrame(0, 0);
  await delay(20);
  assert.equal(ready.length, 0);
  el.fireFrame(640, 360);
  await p;
  assert.equal(ready.length, 1);
  assert.equal(ready[0].videoWidth, 640);
  session.disconnect();
});

test('without requestVideoFrameCallback the canplay gate still resolves connect()', async () => {
  const { session, ready } = setup({ videoEl: new FakeVideoEl() });
  await session.connect();
  assert.equal(ready.length, 1);
  assert.equal(ready[0].degraded, undefined);
  session.disconnect();
});

test('a hidden tab uses the canplay gate, because its frame callback never fires', async () => {
  globalThis.document = { hidden: true };
  try {
    const { session, ready } = setup();
    await session.connect();
    assert.equal(ready.length, 1);
    assert.equal(ready[0].degraded, undefined);
    session.disconnect();
  } finally { delete globalThis.document; }
});

test('no videoEl: mediaReady is still emitted once with zero size', async () => {
  const { session, ready } = setup({ videoEl: null });
  await session.connect();
  assert.deepEqual(ready, [{ mode: 'video', videoWidth: 0, videoHeight: 0 }]);
  session.disconnect();
});

test('no frame at the cap: one re-subscribe that releases the first one, then a degraded mediaReady', async () => {
  const { session, whep, ready, warnings } = setup({ firstFrame: 120 });
  await session.connect();
  assert.equal(whep.posts.length, 2, 'exactly one re-subscribe');
  assert.equal(whep.deletes.length, 1, 'the first subscription is released');
  assert.equal(ready.length, 1, 'mediaReady fires once');
  assert.deepEqual(ready[0], { mode: 'video', videoWidth: 0, videoHeight: 0, degraded: true });
  assert.deepEqual(warnings.map((w) => w.code), ['media_no_video']);
  assert.equal(session.state, 'connected');
  session.disconnect();
});

test('a frame after the re-subscribe is a normal mediaReady, with no warning', async () => {
  const { session, el, whep, ready, warnings } = setup({ firstFrame: 120 });
  const p = session.connect();
  await until(() => whep.posts.length === 2);
  await until(() => el._frameCbs.size > 0);
  el.fireFrame(640, 480);
  await p;
  assert.deepEqual(ready, [{ mode: 'video', videoWidth: 640, videoHeight: 480 }]);
  assert.equal(warnings.length, 0);
  session.disconnect();
});

test('a failed re-subscribe still resolves connect(), degraded, with the reason in the warning', async () => {
  const { session, whep, ready, warnings } = setup({ firstFrame: 100, steps: [{ status: 201 }, { status: 503 }] });
  await session.connect();
  assert.equal(whep.posts.length, 2);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].degraded, true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'media_no_video');
  assert.match(warnings[0].detail, /WHEP/);
  session.disconnect();
});

test('the cap starts when the answer is applied, so a slow WHEP POST does not use it up', async () => {
  const { session, el, whep, ready, warnings } = setup({ firstFrame: 200, steps: [{ delayMs: 350 }] });
  const p = session.connect();
  await until(() => el._frameCbs.size > 0, 3000);   // the track arrives with the answer, after the 350 ms POST
  el.fireFrame(640, 480);
  await p;
  assert.equal(whep.posts.length, 1, 'no re-subscribe');
  assert.equal(warnings.length, 0);
  assert.equal(ready[0].degraded, undefined);
  session.disconnect();
});

test('disconnect() while waiting for the frame cancels the gate: no re-subscribe, no mediaReady', async () => {
  const { session, el, whep, ready } = setup({ firstFrame: 100 });
  const p = session.connect().catch(() => {});
  await until(() => el._frameCbs.size > 0);
  session.disconnect();
  await p;
  await delay(250);
  assert.equal(whep.posts.length, 1);
  assert.equal(ready.length, 0);
  assert.equal(el._frameCbs.size, 0, 'the frame callback is cancelled');
});

test('session.timings and connectTimings: phases in order, emitted once, ending at connected', async () => {
  const { session, el } = setup();
  assert.deepEqual(session.timings, {});
  /** @type {any[]} */ const events = [];
  session.on('connectTimings', (t) => events.push(t));
  const p = session.connect();
  await until(() => el._frameCbs.size > 0);
  el.fireFrame();
  await p;
  assert.equal(events.length, 1);
  const t = session.timings;
  assert.deepEqual(events[0], t);
  const order = ['serverConnected', 'joinComplete', 'stvNewSessionReply', 'whepSent', 'whepAnswer', 'firstTrack', 'firstFrame', 'mediaReady'];
  for (const k of [...order, 'micRequested', 'socketOpen', 'asrReady', 'approved', 'connected']) assert.ok(k in t, `${k} is recorded`);
  for (let i = 1; i < order.length; i++) assert.ok(t[order[i]] >= t[order[i - 1]], `${order[i - 1]} <= ${order[i]}`);
  assert.ok(t.connected >= Math.max(t.mediaReady, t.asrReady, t.approved - 0));
  assert.ok(t.approved <= t.connected);
  assert.ok(Object.values(t).every((n) => Number.isInteger(n) && n >= 0));
  // The copy is detached.
  t.connected = -1;
  assert.notEqual(session.timings.connected, -1);
  session.disconnect();
});

test('a failed connect attaches the phases reached to error.timings and emits no connectTimings', async () => {
  const { session } = setup({ steps: [{ status: 503 }] });
  let emitted = 0;
  session.on('connectTimings', () => { emitted += 1; });
  await assert.rejects(() => session.connect(), (e) => {
    assert.equal(e.code, 'whep_failed');
    assert.ok('joinComplete' in e.timings && 'whepSent' in e.timings);
    assert.ok(!('connected' in e.timings));
    return true;
  });
  assert.equal(emitted, 0);
});

const stvPeer = () => FakeRTCPeerConnection.instances.find((p) => p.transceivers?.some((t) => t.kind === 'video'));

test('an audio-only stream does not wait for a frame: no cap, no warning', async () => {
  FakeRTCPeerConnection.prototype._autoTrackDisabled = true;
  try {
    const { session, ready, warnings } = setup();
    const t0 = Date.now();
    const p = session.connect();
    await until(() => stvPeer()?.remoteDescription);
    stvPeer().fireTrack('audio');
    await p;
    assert.ok(Date.now() - t0 < 2000, 'resolved well before the 5 s cap');
    assert.equal(ready.length, 1);
    assert.equal(ready[0].degraded, undefined);
    assert.deepEqual(warnings, []);
    session.disconnect();
  } finally { delete FakeRTCPeerConnection.prototype._autoTrackDisabled; }
});

test('a recovery re-subscribe uses the canplay gate, so a paused element cannot stall it', async () => {
  const { session, el, ready, warnings } = setup();
  const p = session.connect();
  await until(() => el._frameCbs.size > 0);
  el.fireFrame(1280, 720);
  await p;
  const t0 = Date.now();
  await session._recoverMedia('stv', stvPeer());
  assert.ok(Date.now() - t0 < 2000, 'no frame callback was needed');
  assert.equal(ready.length, 2, 'one mediaReady per subscribe');
  assert.equal(ready[1].degraded, undefined);
  assert.deepEqual(warnings, []);
  session.disconnect();
});
