// ICE during connect(): a peer that never connects fails fast with a typed, sanitized error;
// a peer that fails while the session is still joining is recovered once it is connected.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { KalturaError } from '../../src/core/errors.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor, fakeGetUserMedia } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const isStv = (pc) => pc.transceivers.some((t) => t.kind === 'video' && t.direction === 'recvonly');

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('until(): condition not met');
    await delay(5);
  }
}

function setup({ firstFrame = 150, timeouts = {} } = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  scriptHappyPath(socket);
  const el = new FakeVideoEl({ rvfc: true });
  const whep = fakeWhepFetch([{}]);
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: el, socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: whep, getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor,
    timeouts: { firstFrame, ...timeouts },
  });
  FakeRTCPeerConnection.iceUpOnAnswer = false;   // this file starts from a peer that never connects
  return { session, socket, el, whep };
}

/** Run `fn` once for every STV peer, as soon as it has its answer. */
function forEachStvPeer(fn) {
  const seen = new Set();
  const id = setInterval(() => {
    for (const pc of FakeRTCPeerConnection.instances) {
      if (!seen.has(pc) && isStv(pc) && pc.remoteDescription) { seen.add(pc); fn(pc); }
    }
  }, 2);
  return () => clearInterval(id);
}

afterEach(() => { FakeRTCPeerConnection.reset(); });

test('a peer that never connects fails connect() with ice_failed after one re-subscribe', async () => {
  const { session, whep } = setup();
  const stop = forEachStvPeer((pc) => pc.fireCandidateError({ errorCode: 701, errorText: 'lookup failed for 203.0.113.9' }));
  const err = await session.connect().then(() => null, (e) => e);
  stop();
  assert.ok(err instanceof KalturaError);
  assert.equal(err.code, 'ice_failed');
  assert.equal(err.phase, 'ice');
  assert.equal(err.retryable, true);
  assert.equal(err.ice.channel, 'stv');
  assert.equal(err.ice.cause, 'turn_unreachable');
  assert.match(err.detail, /turn_unreachable/);
  assert.doesNotMatch(JSON.stringify(err.toJSON()), /203\.0\.113\.9/);
  assert.equal(whep.posts.length, 2, 'one subscribe and one re-subscribe');
  assert.equal(FakeRTCPeerConnection.instances.filter(isStv).every((pc) => pc.closed), true, 'no peer is left open');
  assert.equal(session.state, 'error');
});

test('ICE failed during connect() fails fast, well before the first-frame cap', async () => {
  const { session } = setup({ firstFrame: 5000 });
  const stop = forEachStvPeer((pc) => pc.setIce('failed'));
  const t0 = Date.now();
  const err = await session.connect().then(() => null, (e) => e);
  stop();
  assert.equal(err?.code, 'ice_failed');
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
});

test('a peer with ICE up but no frame keeps the degraded path, not ice_failed', async () => {
  const { session } = setup({ firstFrame: 80 });
  FakeRTCPeerConnection.iceUpOnAnswer = true;
  const warnings = [];
  session.on('warning', (w) => warnings.push(w.code));
  await session.connect();
  assert.ok(warnings.includes('media_no_video'));
  session.disconnect();
});

test('an ASR peer that fails while connecting is recovered once the session is connected', async () => {
  const { session, el } = setup({ firstFrame: 5000 });
  FakeRTCPeerConnection.iceUpOnAnswer = true;
  const recovering = [];
  session.on('mediaRecovering', (e) => recovering.push(e));
  const p = session.connect();
  await until(() => el._frameCbs.size > 0);
  await until(() => FakeRTCPeerConnection.instances.some((pc) => !isStv(pc)));
  const asr = FakeRTCPeerConnection.instances.find((pc) => !isStv(pc));
  asr.fireCandidateError({ errorCode: 701 });
  asr.setIce('failed');
  assert.deepEqual(recovering, [], 'nothing is recovered while the session is still joining');
  el.fireFrame(1280, 720);
  await p;
  await until(() => recovering.length > 0);
  assert.equal(recovering[0].channel, 'asr');
  assert.equal(recovering[0].state, 'failed');
  assert.equal(recovering[0].cause, 'turn_unreachable');
  assert.equal(asr.iceRestarted, 1);
  session.disconnect();
});

test('the stuck-ICE watchdog looks again while the session is still joining', async () => {
  const { session, el } = setup({ firstFrame: 5000, timeouts: { iceStuck: 20 } });
  const p = session.connect();
  await until(() => el._frameCbs.size > 0);
  await until(() => FakeRTCPeerConnection.instances.some((pc) => !isStv(pc)));
  const asr = FakeRTCPeerConnection.instances.find((pc) => !isStv(pc));
  asr.setIce('checking');
  await delay(80);
  assert.ok(session._iceNewTimers.asr, 'the timer fired once and was armed again');
  const recovering = [];
  session.on('mediaRecovering', (e) => recovering.push(e.channel));
  el.fireFrame(1280, 720);
  await p;
  await until(() => recovering.includes('asr'), 500);
  assert.equal(asr.iceRestarted, 1, 'the peer that stayed stuck is recovered after connect()');
  session.disconnect();
  assert.equal(session._iceNewTimers.asr, null, 'disconnect clears it');
});

test('without a video element, connect() waits for ICE and fails with ice_failed when it never connects', async () => {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  scriptHappyPath(socket);
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection, fetch: fakeWhepFetch([{}]),
    getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, timeouts: { firstFrame: 150 },
  });
  FakeRTCPeerConnection.iceUpOnAnswer = false;
  const err = await session.connect().then(() => null, (e) => e);
  assert.equal(err?.code, 'ice_failed');
});

test('without frame callbacks, connect() resolves only after ICE is connected', async () => {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  scriptHappyPath(socket);
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl(), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection, fetch: fakeWhepFetch([{}]),
    getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, timeouts: { firstFrame: 5000 },
  });
  FakeRTCPeerConnection.iceUpOnAnswer = false;
  let resolved = false;
  const p = session.connect().then(() => { resolved = true; });
  await until(() => FakeRTCPeerConnection.instances.some((pc) => isStv(pc) && pc.remoteDescription));
  await delay(150);
  assert.equal(resolved, false, 'a track and canplay are not enough while ICE is still checking');
  FakeRTCPeerConnection.instances.find(isStv).setIce('connected');
  await p;
  session.disconnect();
});

test('getIceReport() after disconnect says the peer is closed', async () => {
  const { session } = setup();
  const stop = forEachStvPeer((pc) => pc.setIce('failed'));
  await session.connect().catch(() => {});
  stop();
  session.disconnect();
  assert.equal((await session.getIceReport()).stv?.cause, 'closed');
});

test('getIceReport() is empty before connect and describes both peers after', async () => {
  const { session, el } = setup({ firstFrame: 5000 });
  FakeRTCPeerConnection.iceUpOnAnswer = true;
  assert.deepEqual(await session.getIceReport(), { asr: null, stv: null });
  const p = session.connect();
  await until(() => el._frameCbs.size > 0);
  for (const pc of FakeRTCPeerConnection.instances) pc.fireCandidate('relay');
  el.fireFrame(1280, 720);
  await p;
  const stvPc = FakeRTCPeerConnection.instances.find(isStv);
  stvPc.setStats([
    { id: 't', type: 'transport', selectedCandidatePairId: 'p' },
    { id: 'p', type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r' },
    { id: 'l', type: 'local-candidate', candidateType: 'relay', protocol: 'udp' },
    { id: 'r', type: 'remote-candidate', candidateType: 'host' },
  ]);
  const r = await session.getIceReport();
  assert.equal(r.stv.channel, 'stv');
  assert.equal(r.stv.cause, 'connected');
  assert.ok(r.stv.candidates.relay >= 1);
  assert.deepEqual(r.stv.selectedPair, { localType: 'relay', remoteType: 'host', protocol: 'udp' });
  assert.equal(r.asr.channel, 'asr');
  assert.equal(r.asr.selectedPair, null);
  session.disconnect();
});
