import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';

/**
 * Peer health watchdog: a peer that dies with no ICE event (an outside `close()`, a
 * `connectionstatechange` to failed, or a downlink whose video bytes stop growing) is found
 * and recovered. Short tick values keep the tests fast; the logic is the same as the defaults.
 */

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const stvPeer = () => FakeRTCPeerConnection.instances.filter((p) => p.transceivers.some((t) => t.kind === 'video' && t.direction === 'recvonly')).at(-1);
const asrPeer = () => FakeRTCPeerConnection.instances.find((p) => p.tracks.length > 0 && !p.transceivers.some((t) => t.kind === 'video'));

async function connected(timeouts = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/r/1' } }),
    getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false,
    timeouts: { healthTick: 20, videoStall: 100, ...timeouts },
  });
  scriptHappyPath(socket, { resumingOnRecreate: false });
  await session.connect();
  const ev = [];
  for (const e of ['mediaRecovering', 'mediaRecovered', 'reconnecting']) session.on(e, (p) => ev.push(p?.channel ? `${e}:${p.channel}` : e));
  return { session, socket, ev };
}

test('an outside close() of the STV peer is found by the tick and re-subscribed once', async () => {
  const { session, ev } = await connected();
  const old = stvPeer();
  old.close();
  await delay(300);
  assert.deepEqual(ev, ['mediaRecovering:stv', 'mediaRecovered:stv']);
  assert.notEqual(stvPeer(), old, 'a new STV peer replaced the closed one');
  session.disconnect();
});

test('connectionstatechange failed on the STV peer recovers at once, without waiting for a tick', async () => {
  const { session, ev } = await connected({ healthTick: 60000 });
  stvPeer().setConnectionState('failed');
  await delay(150);
  assert.deepEqual(ev, ['mediaRecovering:stv', 'mediaRecovered:stv']);
  session.disconnect();
});

test('connectionstatechange to a healthy state does nothing', async () => {
  const { session, ev } = await connected();
  stvPeer().setConnectionState('connected');
  stvPeer().setConnectionState('disconnected');
  await delay(150);
  assert.deepEqual(ev, []);
  session.disconnect();
});

test('a closed ASR peer is handed to recovery', async () => {
  const { session, ev } = await connected();
  asrPeer().close();
  await delay(150);
  assert.equal(ev[0], 'mediaRecovering:asr');
  session.disconnect();
});

test('video bytes that stop growing trigger one STV recovery after the stall window', async () => {
  const { session, ev } = await connected({ videoStall: 400 });
  const first = stvPeer();
  let bytes = 1000, fresh = 0;
  // The first peer stops at 4000 bytes. The peer that replaces it gets a healthy stream.
  const flow = setInterval(() => {
    const cur = stvPeer();
    if (cur === first) { if (bytes < 4000) bytes += 500; first.setInboundVideo({ bytesReceived: bytes }); } else { fresh += 500; cur.setInboundVideo({ bytesReceived: fresh }); }
  }, 10);
  await delay(150);
  assert.deepEqual(ev, [], 'growing bytes: healthy');
  await delay(1000);
  clearInterval(flow);
  assert.deepEqual(ev.slice(0, 2), ['mediaRecovering:stv', 'mediaRecovered:stv'], 'bytes stopped at 4000: stalled');
  assert.equal(ev.filter((e) => e === 'mediaRecovering:stv').length, 1, 'recovered once, not repeatedly');
  session.disconnect();
});

test('no recovery while the bytes keep growing', async () => {
  const { session, ev } = await connected();
  const pc = stvPeer();
  let bytes = 1000;
  const flow = setInterval(() => { bytes += 500; pc.setInboundVideo({ bytesReceived: bytes }); }, 10);
  await delay(500);
  clearInterval(flow);
  assert.deepEqual(ev, []);
  session.disconnect();
});

test('a report with no inbound video is not judged', async () => {
  const { session, ev } = await connected();
  stvPeer().setStats([{ id: 'a', type: 'inbound-rtp', kind: 'audio', bytesReceived: 5 }]);
  await delay(400);
  assert.deepEqual(ev, []);
  session.disconnect();
});

test('a paused session is not judged', async () => {
  const { session, ev } = await connected();
  session.pause();
  stvPeer().close();
  await delay(300);
  assert.deepEqual(ev, []);
  session.disconnect();
});

test('disconnect() stops the tick: no getStats after teardown', async () => {
  const { session } = await connected();
  const pc = stvPeer();
  let calls = 0;
  const real = pc.getStats.bind(pc);
  pc.getStats = () => { calls++; return real(); };
  await delay(80);
  session.disconnect();
  const after = calls;
  await delay(120);
  assert.equal(calls, after);
  assert.equal(session._healthTimer, null);
});

test('audio mode has no video downlink to watch', async () => {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection, getUserMedia: fakeGetUserMedia(),
    mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false, timeouts: { healthTick: 20, videoStall: 50 },
  });
  scriptHappyPath(socket, { audioMode: true });
  await session.connect();
  const ev = []; session.on('mediaRecovering', (p) => ev.push(p.channel));
  await delay(300);
  assert.deepEqual(ev, []);
  session.disconnect();
});

test('both peers dying in one tick leave exactly one live STV peer and one live ASR peer', async () => {
  const { session, ev } = await connected({ healthTick: 60000 });
  const reconnected = [];
  session.on('reconnected', () => reconnected.push(1));
  for (const pc of [asrPeer(), stvPeer()]) { pc.close(); pc.setConnectionState('closed'); }
  await delay(500);
  assert.equal(reconnected.length, 1, 'cold reconnect finished');
  const live = FakeRTCPeerConnection.instances.filter((p) => !p.closed);
  assert.equal(live.length, 2, `open peers: ${live.length}`);
  assert.equal(live.filter((p) => p.transceivers.some((t) => t.kind === 'video')).length, 1, 'one STV peer');
  assert.ok(ev.includes('reconnecting'));
  session.disconnect();
});
