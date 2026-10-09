import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

/**
 * Overlaps between a media recovery, a cold reconnect, a disconnect and a resume. Code that
 * resumes after an await has to notice that a newer generation of the session owns the media.
 */

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('until: timed out'); await delay(2); } };

/** @param {{whep?:any[], videoEl?:any, stvDelayAfterFirst?:number, timeouts?:any}} [o] */
function build({ whep = [{}], videoEl = new FakeVideoEl({ autoCanPlay: true }), stvDelayAfterFirst = 0, timeouts = {} } = {}) {
  FakeRTCPeerConnection.reset();
  const sockets = [];
  const socketFactory = () => {
    const s = new FakeSocket();
    scriptHappyPath(s, { resumingOnRecreate: false, delayStvReplyMs: sockets.length ? stvDelayAfterFirst : 0 });
    sockets.push(s);
    return s;
  };
  const fetch = fakeWhepFetch(whep);
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl, socketFactory, rtcConstructor: FakeRTCPeerConnection, fetch,
    getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false, timeouts,
  });
  return { session, sockets, fetch };
}

test('a recovery overtaken by a cold reconnect does not report mediaRecovered, and the flags are clear afterwards', async () => {
  const { session, fetch } = build({ stvDelayAfterFirst: 300 });
  await session.connect();
  const ev = [];
  for (const e of ['mediaRecovering', 'mediaRecovered']) session.on(e, () => ev.push(e));
  session._pcStv.setIce('failed');
  await until(() => fetch.posts.length >= 2);
  const reconnected = new Promise((r) => session.once('reconnected', r));
  session._coldReconnect('asr escalation');
  await reconnected;
  assert.deepEqual(ev, ['mediaRecovering'], 'no mediaRecovered from the old generation');
  assert.deepEqual(session._mediaRecovering, { asr: false, stv: false });
  session.disconnect();
});

test('a failed ASR recovery that lands after a cold reconnect does not start a second rebuild', async () => {
  const { session, sockets } = build({ timeouts: { asr: 400 } });
  await session.connect();
  const first = sockets[0];
  const answer = first._onEmit;
  first.onEmit((ev, p, s) => { if (ev === 'asr-webrtc-offer' && p?.is_reconnect) return; answer(ev, p, s); });   // the ICE-restart offer is never answered
  const reconnects = [];
  session.on('reconnecting', (p) => reconnects.push(p.reason));
  session._pcAsr.setIce('failed');
  await delay(20);
  session._coldReconnect('stv escalation');
  await delay(900);   // past the ASR answer wait
  assert.deepEqual(reconnects, ['stv escalation'], 'one rebuild only');
  assert.equal(session.state, 'connected');
  assert.equal(sockets.length, 2);
  session.disconnect();
});

test('disconnect() while connect() waits for the first frame rejects connect() and never reaches connected', async () => {
  const { session } = build({ videoEl: new FakeVideoEl({ autoCanPlay: false }) });
  const states = [];
  session.on('stateChange', (p) => states.push(p.state));
  const p = session.connect().then(() => 'resolved', (e) => e.code);
  await delay(80);
  session.disconnect();
  assert.equal(await p, 'connect_failed');
  await delay(300);
  assert.equal(states.includes('connected'), false);
  assert.equal(states.includes('error'), false, 'a requested disconnect is not an error');
  assert.equal(session.state, 'disconnected');
  assert.equal(session._healthTimer, null, 'no watchdog left running');
});

test('a cold reconnect cancelled mid first-frame wait ends disconnected, not connected', async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: true });
  const { session } = build({ videoEl });
  await session.connect();
  videoEl.readyState = 0; videoEl._auto = false;   // the rebuilt peer never gets a frame
  session._coldReconnect('x');
  await delay(100);
  session.disconnect();
  await delay(500);
  assert.equal(session.state, 'disconnected');
  assert.equal(session._healthTimer, null);
});

test('the health tick leaves the peers alone while resume() rebuilds them', async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: true });
  const { session, sockets } = build({ whep: [{}, { delayMs: 400 }, {}], videoEl, timeouts: { healthTick: 20, videoStall: 100 } });
  await session.connect();
  const sock = sockets[0];
  const real = sock._onEmit; let stv = 0;
  sock.onEmit((ev, p, so) => { if (ev === 'stvNewSession' && ++stv >= 1) { setTimeout(() => real(ev, p, so), 200); return; } real(ev, p, so); });
  const pc = session._pcStv; let bytes = 1000;
  const grow = setInterval(() => pc.setInboundVideo({ bytesReceived: (bytes += 1000) }), 10);
  await delay(60);
  const ev = [];
  session.on('mediaRecovering', (p) => ev.push(p.channel));
  session.pause(); clearInterval(grow);
  await delay(250);
  sock.server('pauseSessionExpired', {});
  await session.resume();
  assert.deepEqual(ev, [], 'no recovery during pause or the rebuild');
  session.disconnect();
});

test('the stall window starts fresh after a pause', async () => {
  const { session } = build({ timeouts: { healthTick: 20, videoStall: 400 } });
  await session.connect();
  const pc = session._pcStv; let bytes = 1000;
  const grow = setInterval(() => pc.setInboundVideo({ bytesReceived: (bytes += 1000) }), 10);
  await delay(80);
  clearInterval(grow);
  await delay(50);    // the tick has seen the last growth; the stall clock is running
  const ev = [];
  session.on('mediaRecovering', () => ev.push(1));
  session.pause();
  await delay(600);   // longer than videoStall, with no bytes
  session.resume();
  await delay(120);    // the first ticks after resume must not count the pause as a stall
  assert.deepEqual(ev, []);
  session.disconnect();
});

test('every teardown DELETE of the WHEP resource uses keepalive', async () => {
  const { session, fetch } = build();
  await session.connect();
  session.disconnect();
  await delay(20);
  assert.ok(fetch.deletes.length >= 1);
  assert.ok(fetch.deletes.every((d) => d.keepalive === true));
});

test('a cold reconnect that lands while a 404 repair waits for the new STV session is not undone by it', async () => {
  const { session, sockets } = build({ whep: [{}, { status: 404 }, {}] });
  await session.connect();
  const sock = sockets[0];
  const real = sock._onEmit; let stv = 0;
  sock.onEmit((ev, p, so) => { if (ev === 'stvNewSession' && ++stv >= 1) { setTimeout(() => real(ev, p, so), 300); return; } real(ev, p, so); });
  const retries = [];
  session.on('connectivityChanged', (p) => { if (p.state === 'reconnect_retry') retries.push(p); });
  session._pcStv.setIce('failed');
  await until(() => stv >= 1);   // the repair is parked on the delayed stvNewSession reply
  const reconnected = new Promise((r) => session.once('reconnected', r));
  session._coldReconnect('test');
  await reconnected;
  await delay(400);   // the stale reply lands now
  assert.deepEqual(retries, [], 'the cold reconnect did not burn an attempt');
  assert.equal(session.state, 'connected');
  const live = FakeRTCPeerConnection.instances.filter((p) => !p.closed && p.transceivers.some((t) => t.kind === 'video'));
  assert.equal(live.length, 1, 'one live STV peer');
  session.disconnect();
});
