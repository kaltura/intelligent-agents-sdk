import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('until: timed out'); await delay(5); } };
const stvPeers = () => FakeRTCPeerConnection.instances.filter((p) => p.transceivers.some((t) => t.kind === 'video' && t.direction === 'recvonly'));
const stvPeer = () => stvPeers().at(-1);

async function connected({ timeouts = {}, cfg = {}, whep = [{}] } = {}) {
  FakeRTCPeerConnection.reset();
  const sockets = [];
  const socketFactory = () => { const s = new FakeSocket(); scriptHappyPath(s, { resumingOnRecreate: false }); sockets.push(s); return s; };
  const fetch = fakeWhepFetch(whep);
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory, rtcConstructor: FakeRTCPeerConnection,
    fetch, getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false,
    timeouts: { healthTick: 20, videoStall: 100, coldBackoff: 20, ...timeouts }, ...cfg,
  });
  await session.connect();
  const ev = [];
  for (const e of ['mediaRecovering', 'mediaRecovered', 'reconnecting', 'reconnected']) session.on(e, (p) => ev.push(p?.channel ? `${e}:${p.channel}` : e));
  const conn = [];
  session.on('connectivityChanged', (p) => conn.push(p));
  return { session, sockets: () => sockets, fetch, ev, conn };
}

/** One manual health tick, then wait until its stats read has been judged. */
const tickOf = (session) => async () => { session._healthTick(); await delay(2); await until(() => !session._videoFlow.busy, 2000); };

// hw1
test('disconnect() clears the health interval', async () => {
  const { session } = await connected();
  const timer = session._healthTimer;
  assert.ok(timer);
  const real = globalThis.clearInterval, cleared = [];
  globalThis.clearInterval = (t) => { cleared.push(t); return real(t); };
  try { session.disconnect(); } finally { globalThis.clearInterval = real; }
  assert.ok(cleared.includes(timer), 'clearInterval was called with the health timer');
});

// hw8 / hw10: each state alone marks a peer dead
for (const [name, set] of [['connectionState closed', (pc) => { pc.connectionState = 'closed'; }], ['signalingState closed', (pc) => { pc.signalingState = 'closed'; }]]) {
  test(`the tick recovers a peer with only ${name}`, async () => {
    const { session, ev } = await connected();
    const old = stvPeer();
    set(old);
    await until(() => ev.includes('mediaRecovered:stv'));
    assert.deepEqual(ev, ['mediaRecovering:stv', 'mediaRecovered:stv']);
    session.disconnect();
  });
}

// hw13: a slow getStats is not called again every tick
test('a slow getStats is not re-entered by the next ticks', async () => {
  const { session } = await connected();
  const pc = stvPeer();
  let calls = 0;
  pc.getStats = () => { calls++; return new Promise((r) => setTimeout(() => r(new Map()), 200)); };
  await delay(150);
  assert.equal(calls, 1, `getStats called ${calls} times in 150 ms with ticks every 20 ms`);
  session.disconnect();
});

// hw14: a getStats answer for a replaced peer must not start a second recovery
test('a late stats answer for a replaced peer does not start another recovery', async () => {
  let c = 0;
  const { session, ev } = await connected({ timeouts: { healthTick: 600000 }, cfg: { now: () => c } });
  const pc1 = stvPeer();
  pc1.setInboundVideo({ bytesReceived: 100 });
  session._healthTick(); await delay(10);   // flow {pc1, bytes 100, since 0}
  const real = pc1.getStats.bind(pc1);
  let release;
  pc1.getStats = () => new Promise((r) => { release = () => r(real()); });
  c = 1000;
  session._healthTick(); await delay(5);     // a stall verdict is now pending on pc1
  pc1.setIce('failed');                      // meanwhile the peer is replaced
  await until(() => ev.includes('mediaRecovered:stv'));
  release();
  await delay(30);
  assert.equal(ev.filter((e) => e === 'mediaRecovering:stv').length, 1, ev.join());
  session.disconnect();
});

// hw15: a new peer starts a new stall window
test('a replacement peer gets its own stall window', async () => {
  let c = 0;
  const { session, ev } = await connected({ timeouts: { healthTick: 600000 }, cfg: { now: () => c } });
  const tick = tickOf(session);
  const pc1 = stvPeer();
  pc1.setInboundVideo({ bytesReceived: 4000 });
  await tick();
  pc1.close();
  session._healthTick();
  await until(() => ev.includes('mediaRecovered:stv'));
  c = 150;
  const pc2 = stvPeer();
  assert.notEqual(pc2, pc1);
  pc2.setInboundVideo({ bytesReceived: 500 });
  await tick();
  c = 200;
  await tick();
  assert.equal(ev.filter((e) => e === 'mediaRecovering:stv').length, 1, `50 ms into the new peer's window: ${ev.join()}`);
  session.disconnect();
});

// hw22: a late state event on a replaced peer is ignored
test('a late connectionstatechange on a replaced peer does not recover the live one', async () => {
  const { session, ev } = await connected({ timeouts: { healthTick: 600000 } });
  const old = stvPeer();
  old.setConnectionState('failed');
  await until(() => ev.includes('mediaRecovered:stv'));
  old.setConnectionState('failed');
  await delay(60);
  assert.equal(ev.filter((e) => e === 'mediaRecovering:stv').length, 1, ev.join());
  session.disconnect();
});

// hw25: resume() lets the tick run again
test('after pause, expiry and resume() the tick recovers a closed peer again', async () => {
  const { session, sockets, ev } = await connected();
  session.pause();
  sockets()[0].server('pauseSessionExpired', {});
  await session.resume();
  ev.length = 0;
  stvPeer().close();
  await until(() => ev.includes('mediaRecovered:stv'), 2000);
  session.disconnect();
});

// ms3: the escalation is announced
test('two re-subscribes that bring no video escalate with recover_failed and a cold reconnect', async () => {
  const { session, ev, conn } = await connected({ timeouts: { videoStall: 80 } });
  const first = stvPeer();
  first.setInboundVideo({ bytesReceived: 1000 });   // later peers never report video
  await until(() => ev.includes('reconnecting'), 5000);
  assert.equal(ev.filter((e) => e === 'mediaRecovering:stv').length, 2, ev.join());
  const failed = conn.find((p) => p.state === 'recover_failed');
  assert.equal(failed?.channel, 'stv');
  assert.equal(failed?.detail, 'video stalled after re-subscribe');
  session.disconnect();
});

// ms5: a flow that comes back resets the count
test('video that flows after each re-subscribe never escalates to a cold reconnect', async () => {
  const c = { v: 0 };
  const { session, ev } = await connected({ timeouts: { healthTick: 600000, videoStall: 80 }, cfg: { now: () => c.v } });
  const tick = tickOf(session);
  stvPeer().setInboundVideo({ bytesReceived: 1000 });
  await tick();
  for (let round = 1; round <= 4; round++) {
    c.v += 100; await tick();                                   // stalled: re-subscribe
    await until(() => ev.filter((e) => e === 'mediaRecovered:stv').length === round);
    stvPeer().setInboundVideo({ bytesReceived: 500 }); await tick();
    stvPeer().setInboundVideo({ bytesReceived: 1000 }); await tick();   // video flows: the count resets
  }
  assert.equal(ev.includes('reconnecting'), false, ev.join());
  session.disconnect();
});

async function twoStalls(c) {
  const h = await connected({ timeouts: { healthTick: 600000, videoStall: 80 }, cfg: { now: () => c.v } });
  const { session, ev } = h;
  const tick = tickOf(session);
  stvPeer().setInboundVideo({ bytesReceived: 1000 });
  await tick();                                   // c=0: flow starts
  c.v = 100; await tick();                        // stalled: re-subscribe 1
  await until(() => ev.filter((e) => e === 'mediaRecovered:stv').length === 1);
  await tick();                                   // new peer reports nothing, window starts at c=100
  c.v = 200; await tick();                        // stalled: re-subscribe 2
  await until(() => ev.filter((e) => e === 'mediaRecovered:stv').length === 2);
  assert.equal(session._stallRecoveries, 2);
  return { ...h, tick };
}

// ms6: teardown clears the count
test('disconnect() clears the stall count', async () => {
  const c = { v: 0 };
  const { session } = await twoStalls(c);
  session.disconnect();
  assert.equal(session._stallRecoveries, 0);
});

// ms7: an escalation clears the count
test('after an escalation the next peer gets a fresh count', async () => {
  const c = { v: 0 };
  const { session, ev, tick } = await twoStalls(c);
  await tick();                                   // peer 3: window starts at c=200
  c.v = 300; await tick();                        // stalled again: escalates
  await until(() => ev.includes('reconnected'), 3000);
  ev.length = 0;
  for (c.v = 400; c.v <= 600; c.v += 100) await tick();   // the rebuilt peer reports nothing: nothing to judge
  assert.deepEqual(ev, []);
  session.disconnect();
});

// hw17: no stats are read while a recovery owns the channel
test('the tick does not read video stats while the STV channel is recovering', async () => {
  const { session } = await connected({ timeouts: { healthTick: 600000 } });
  let calls = 0;
  const pc = stvPeer();
  pc.getStats = () => { calls++; return Promise.resolve(new Map()); };
  session._mediaRecovering.stv = true;
  session._healthTick(); await delay(10);
  assert.equal(calls, 0);
  session._mediaRecovering.stv = false;
  session.disconnect();
});

// hw16: audio mode has no video to judge
test('the tick does not read video stats in audio mode', async () => {
  const { session } = await connected({ timeouts: { healthTick: 600000 } });
  let calls = 0;
  stvPeer().getStats = () => { calls++; return Promise.resolve(new Map()); };
  session.mode = 'audio';
  session._healthTick(); await delay(10);
  assert.equal(calls, 0);
  session.mode = 'video';
  session.disconnect();
});

// hw23: a paused session ignores a peer state event
test('a peer that fails while the session is paused is not recovered', async () => {
  const { session, ev } = await connected({ timeouts: { healthTick: 600000 } });
  session.pause();
  stvPeer().setConnectionState('failed');
  await delay(60);
  assert.deepEqual(ev, []);
  session.disconnect();
});

// A real browser fires both state events for one failure
test('ICE failed and connectionState failed together start one recovery', async () => {
  const { session, ev } = await connected({ timeouts: { healthTick: 600000 } });
  const pc = stvPeer();
  pc.setIce('failed');
  pc.setConnectionState('failed');
  await until(() => ev.includes('mediaRecovered:stv'));
  await delay(40);
  assert.equal(ev.filter((e) => e === 'mediaRecovering:stv').length, 1, ev.join());
  session.disconnect();
});
