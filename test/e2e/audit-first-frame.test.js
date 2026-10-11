import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor, fakeGetUserMedia } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('until(): condition not met'); await delay(5); } }
const stvPeer = () => FakeRTCPeerConnection.instances.find((p) => p.transceivers?.some((t) => t.kind === 'video'));

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
    timeouts: { firstFrame }, ...cfg,
  });
  const ready = []; const warnings = []; const meta = [];
  session.on('mediaReady', (p) => ready.push(p));
  session.on('warning', (w) => warnings.push(w));
  session.on('videoMetadata', (p) => meta.push(p));
  return { session, socket, el, whep, ready, warnings, meta };
}

// cap1: the existing slow-POST test also passes when the cap starts at the POST.
test('slow POST: connect() resolves at the frame itself, not 300 ms later through the cap settle', async () => {
  const { session, el, ready } = setup({ firstFrame: 200, steps: [{ delayMs: 350 }] });
  const p = session.connect();
  await until(() => el._frameCbs.size > 0, 3000);
  let resolvedAt = 0;
  p.then(() => { resolvedAt = Date.now(); });
  const firedAt = Date.now();
  el.fireFrame(640, 480);
  await p;
  assert.ok(resolvedAt - firedAt < 100, `resolved ${resolvedAt - firedAt} ms after the frame`);
  assert.ok('firstFrame' in session.timings, 'the frame, not the cap settle, made it ready');
  assert.equal(ready[0].videoWidth, 640);
  session.disconnect();
});

// ff9: a known size before the first frame must not make mediaReady early
test('a video size known before the first frame does not make connect() ready early', async () => {
  const { session, el, ready, meta } = setup();
  el.videoWidth = 640; el.videoHeight = 360;   // decoder pre-sized, nothing painted yet
  let resolved = false;
  const p = session.connect().then(() => { resolved = true; });
  await until(() => el._frameCbs.size > 0);
  await delay(60);
  assert.equal(resolved, false);
  assert.deepEqual(ready, []);
  assert.equal(meta.length, 1, 'videoMetadata still fires');
  el.fireFrame(640, 360);
  await p;
  assert.equal(ready.length, 1);
  session.disconnect();
});

// ff8: the cap path with a known size ends through settle(); the pending frame callback must be cancelled
test('the cap settle path cancels the pending frame callback', async () => {
  const { session, el, ready } = setup({ firstFrame: 80 });
  el.videoWidth = 640; el.videoHeight = 360;
  await session.connect();
  assert.equal(ready.length, 1);
  assert.equal(el._frameCbs.size, 0, 'no frame callback left registered');
  session.disconnect();
});

// tm4 / tm7 / tm11: deterministic clock
test('timings use cfg.now: first mark wins and phases are strictly ordered', async () => {
  let n = 0;
  const { session, el } = setup({ cfg: { now: () => (n += 10) } });
  const p = session.connect();
  await until(() => el._frameCbs.size > 0);
  stvPeer().setIce('connected');
  stvPeer().setIce('completed');   // a later 'connected-like' state must not move the mark
  el.fireFrame();
  await p;
  const t = session.timings;
  assert.ok(t.iceConnectedStv > 0, 'iceConnectedStv is recorded');
  for (const v of Object.values(t)) assert.equal(v % 10, 0, 'values come from the injected clock');
  const order = ['serverConnected', 'joinComplete', 'stvNewSessionReply', 'whepSent', 'whepAnswer', 'firstTrack', 'firstFrame', 'mediaReady', 'connected'];
  for (let i = 1; i < order.length; i++) assert.ok(t[order[i]] > t[order[i - 1]], `${order[i - 1]} < ${order[i]}`);
  session.disconnect();
});
