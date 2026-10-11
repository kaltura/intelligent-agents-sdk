import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor, fakeGetUserMedia } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function build(fetch, cfg = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  scriptHappyPath(socket);
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl({ rvfc: true }), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch, getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, ...cfg,
  });
  return { session, socket };
}

test('disconnect() during the re-subscribe DELETE starts no new subscription', async () => {
  const whep = fakeWhepFetch([{}]);
  let deleteStarted = false;
  const slow = async (url, init = {}) => {
    if (init.method === 'DELETE') { deleteStarted = true; await delay(150); }
    return whep(url, init);
  };
  const { session } = build(slow, { timeouts: { firstFrame: 100 } });
  const events = [];
  session.on('mediaReady', () => events.push('mediaReady'));
  session.on('warning', (w) => events.push(w.code));
  const connecting = session.connect().catch((e) => e);
  const end = Date.now() + 3000;
  while (!deleteStarted && Date.now() < end) await delay(5);
  assert.equal(deleteStarted, true, 'the first-frame cap released the first subscription');
  session.disconnect();
  const err = await connecting;
  assert.equal(err.code, 'connect_failed');
  await delay(300);
  assert.equal(session.state, 'disconnected');
  assert.equal(whep.posts.length, 1, 'no WHEP POST after disconnect()');
  assert.equal(FakeRTCPeerConnection.instances.filter((pc) => pc.connectionState !== 'closed').length, 0, 'no live peer');
  assert.deepEqual(events, [], 'no media events after disconnect()');
});

test('a WHEP answer whose body stalls fails connect() as whep_timeout and releases the viewer', async () => {
  const whep = fakeWhepFetch([{ hangBody: true }]);
  const { session } = build(whep, { timeouts: { whepTry: 150, overall: 5000 } });
  const started = Date.now();
  const err = await session.connect().catch((e) => e);
  assert.equal(err.code, 'whep_timeout');
  assert.equal(err.phase, 'whep');
  assert.ok(Date.now() - started < 2000, 'bounded by the try limit, not the overall deadline');
  await delay(20);
  assert.equal(whep.deletes.length, 1, 'the viewer the headers named is released');
  assert.equal(whep.deletes[0].keepalive, true);
});

test('pagehide while the answer body is read sends the DELETE with keepalive', async () => {
  const handlers = new Set();
  const origAdd = globalThis.addEventListener, origRemove = globalThis.removeEventListener;
  globalThis.addEventListener = (t, h) => { if (t === 'pagehide') handlers.add(h); };
  globalThis.removeEventListener = (t, h) => { if (t === 'pagehide') handlers.delete(h); };
  try {
    const whep = fakeWhepFetch([{ hangBody: true }]);
    const { session } = build(whep, { networkAware: false, pageLifecycleAware: true, sessionCompleteOnEnd: false });
    const connecting = session.connect().catch((e) => e);
    await delay(100);
    for (const h of [...handlers]) h({ persisted: false });
    await connecting;
    await delay(20);
    assert.ok(whep.deletes.length >= 1, 'a DELETE was sent');
    assert.ok(whep.deletes.every((c) => c.keepalive), 'every unload DELETE is keepalive');
  } finally { globalThis.addEventListener = origAdd; globalThis.removeEventListener = origRemove; }
});

test('a Location on a private address is rejected and never gets a DELETE', async () => {
  const whep = fakeWhepFetch([{ location: 'http://10.0.0.5/whep/session/s/viewer/1' }]);
  const { session } = build(whep);
  const err = await session.connect().catch((e) => e);
  assert.equal(err.code, 'whep_private_ip');
  await delay(20);
  assert.equal(whep.deletes.length, 0);
});

test('a sender that stays stalled: two re-subscribes, then a cold reconnect', async () => {
  const whep = fakeWhepFetch([{}]);
  const orig = FakeRTCPeerConnection.prototype.getStats;
  FakeRTCPeerConnection.prototype.getStats = async function () {
    const isStv = this.transceivers.some((t) => t.kind === 'video');
    return new Map(isStv ? [['v', { type: 'inbound-rtp', kind: 'video', bytesReceived: 500 }]] : []);
  };
  try {
    const { session } = build(whep, { networkAware: false, videoEl: new FakeVideoEl({ autoCanPlay: true }), timeouts: { healthTick: 20, videoStall: 100 } });
    await session.connect();
    let recovered = 0, rebuilt = 0;
    session.on('mediaRecovered', () => { recovered++; });
    session.on('reconnecting', () => { rebuilt++; });
    const end = Date.now() + 4000;
    while (!rebuilt && Date.now() < end) await delay(20);
    session.disconnect();
    assert.equal(rebuilt >= 1, true, 'escalated to a cold reconnect');
    assert.ok(recovered <= 2, `re-subscribed at most twice first (saw ${recovered})`);
  } finally { FakeRTCPeerConnection.prototype.getStats = orig; }
});

test('a socketFactory that throws leaves the session in error with no pagehide listener and timings on the error', async () => {
  const handlers = new Set();
  const origAdd = globalThis.addEventListener, origRemove = globalThis.removeEventListener;
  globalThis.addEventListener = (t, h) => { if (t === 'pagehide') handlers.add(h); };
  globalThis.removeEventListener = (t, h) => { if (t === 'pagehide') handlers.delete(h); };
  try {
    const { session } = build(fakeWhepFetch([{}]), { pageLifecycleAware: true, socketFactory: () => { throw new Error('boom'); } });
    const err = await session.connect().catch((e) => e);
    assert.equal(err.code, 'connect_failed');
    assert.equal(err.phase, 'connect');
    assert.ok(err.timings && typeof err.timings === 'object', 'timings are attached');
    assert.equal(session.state, 'error');
    assert.equal(handlers.size, 0, 'no pagehide listener left behind');
  } finally { globalThis.addEventListener = origAdd; globalThis.removeEventListener = origRemove; }
});

test('connect() from error says what to do, and a later connect() works after disconnect() and setToken()', async () => {
  const whep = fakeWhepFetch([{ status: 503 }, {}]);
  const { session, socket } = build(whep, { networkAware: false, videoEl: new FakeVideoEl({ autoCanPlay: true }) });
  const first = await session.connect().catch((e) => e);
  assert.equal(first.code, 'whep_failed');
  const again = await session.connect().catch((e) => e);
  assert.equal(again.code, 'invalid_state');
  assert.match(again.detail, /call disconnect\(\) first/);
  session.disconnect();
  const noToken = await session.connect().catch((e) => e);
  assert.equal(noToken.code, 'invalid_state');
  assert.match(noToken.detail, /setToken\(\)/);
  assert.equal(session.state, 'disconnected', 'the refused connect() changed nothing');
  session.setToken(CONV_KS);
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(session.state, 'connected');
  session.disconnect();
});

test('prepare() without a token rejects at once', async () => {
  const { session } = build(fakeWhepFetch([{}]), { videoEl: new FakeVideoEl({ autoCanPlay: true }), networkAware: false });
  await session.connect();
  session.disconnect();
  await assert.rejects(session.prepare(), { code: 'invalid_state' });
});

test('capacity_unavailable at connect is retryable, has a plain detail and phase connect', async () => {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  scriptHappyPath(socket, { noCapacity: true });
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com', videoEl: new FakeVideoEl({ autoCanPlay: true }),
    socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection, fetch: fakeWhepFetch([{}]), getUserMedia: fakeGetUserMedia(),
    mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false,
  });
  const err = await session.connect().catch((e) => e);
  assert.equal(err.code, 'capacity_unavailable');
  assert.equal(err.phase, 'connect');
  assert.equal(err.retryable, true);
  assert.doesNotMatch(err.detail, /throwTo|6001/);
});
