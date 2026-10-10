import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('until: timed out'); await delay(5); } };
const live = () => FakeRTCPeerConnection.instances.filter((p) => !p.closed);
const liveStv = () => live().filter((p) => p.transceivers.some((t) => t.kind === 'video'));

/** The first DELETE takes `deleteMs`; later ones are instant. */
function build({ whep = [{}], deleteMs = 0, videoEl = new FakeVideoEl({ autoCanPlay: true }), timeouts = {}, trace } = {}) {
  FakeRTCPeerConnection.reset();
  const sockets = [];
  const socketFactory = () => { const s = new FakeSocket(); scriptHappyPath(s, { resumingOnRecreate: false }); sockets.push(s); return s; };
  const base = fakeWhepFetch(whep);
  let slow = deleteMs > 0;
  const fetch = async (url, init = {}) => {
    trace?.push(init.method || 'GET');
    if (init.method === 'DELETE' && slow) { slow = false; await delay(deleteMs); }
    return base(url, init);
  };
  for (const k of ['posts', 'deletes', 'calls']) Object.defineProperty(fetch, k, { get: () => base[k] });
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl, socketFactory, rtcConstructor: FakeRTCPeerConnection, fetch,
    getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false,
    timeouts: { healthTick: 600000, coldBackoff: 20, ...timeouts },
  });
  const ev = [], conn = [];
  for (const e of ['mediaRecovering', 'mediaRecovered', 'reconnecting', 'reconnected']) session.on(e, (p) => ev.push(p?.channel ? `${e}:${p.channel}` : e));
  session.on('connectivityChanged', (p) => conn.push(p));
  return { session, sockets, fetch, base, ev, conn };
}

// g2
test('a recovery whose DELETE outlasts a cold reconnect does not subscribe again', async () => {
  const { session, fetch, ev } = build({ deleteMs: 400 });
  await session.connect();
  session._pcStv.setIce('failed');                 // recovery starts and waits on the slow DELETE
  await delay(30);
  const done = new Promise((r) => session.once('reconnected', r));
  session._coldReconnect('test');                  // finishes while the DELETE is still out
  await done;
  await delay(500);                                // the DELETE ends; the old recovery must stand down
  assert.equal(fetch.posts.length, 2, 'initial POST and the cold rebuild only');
  assert.equal(liveStv().length, 1);
  assert.equal(ev.includes('mediaRecovered:stv'), false);
  session.disconnect();
});

// g3
test('a recovery whose DELETE outlasts disconnect() sends no new POST', async () => {
  const { session, fetch } = build({ deleteMs: 200 });
  await session.connect();
  session._pcStv.setIce('failed');
  await delay(30);
  session.disconnect();
  await delay(350);
  assert.equal(fetch.posts.length, 1);
  assert.equal(live().length, 0);
});

// g7
test('a recovery that fails after disconnect() raises no recover_failed and no cold reconnect', async () => {
  const { session, conn, ev } = build({ whep: [{}, { status: 503, delayMs: 150 }] });
  await session.connect();
  session._pcStv.setIce('failed');
  await delay(40);
  session.disconnect();
  await delay(300);
  assert.deepEqual(conn.filter((c) => c.state === 'recover_failed'), []);
  assert.equal(ev.includes('reconnecting'), false);
});

// g10
test('disconnect() during the cold reconnect DELETE opens no new socket', async () => {
  const { session, sockets, fetch } = build({ deleteMs: 300 });
  await session.connect();
  sockets[0].dropAndRecover('transport close', { recovered: false });
  await delay(60);
  session.disconnect();
  await delay(450);
  assert.equal(sockets.length, 1);
  assert.equal(fetch.posts.length, 1);
  assert.equal(session.state, 'disconnected');
});

// cr7 / cr6
test('disconnect() during the retry backoff ends the loop (no third attempt, no stray socket)', async () => {
  const { session, sockets, fetch } = build({ whep: [{}, { status: 503 }, {}], timeouts: { coldBackoff: 200 } });
  await session.connect();
  const retrying = new Promise((r) => session.on('connectivityChanged', (p) => { if (p.state === 'reconnect_retry') r(); }));
  sockets[0].dropAndRecover('transport close', { recovered: false });
  await retrying;
  session.disconnect();
  await delay(350);
  assert.equal(sockets.length, 1, 'the retry did not open a socket');
  assert.equal(fetch.posts.length, 2);
});

// rg1
test('a cold rebuild that lands during the first-frame re-subscribe DELETE stops the old re-subscribe', async () => {
  const trace = [];
  const { session, fetch } = build({ deleteMs: 300, videoEl: new FakeVideoEl({ autoCanPlay: false, rvfc: true }), timeouts: { firstFrame: 80 }, trace });
  const p = session.connect();
  p.catch(() => {});
  await until(() => trace.includes('DELETE'), 3000);   // the cap fired and the re-subscribe is releasing the first viewer
  session._sessionGen++;                               // a rebuild took over meanwhile
  await delay(450);
  assert.equal(fetch.posts.length, 1, 'no second POST from the stale re-subscribe');
  await assert.rejects(p);
  session.disconnect();
});

// sv9 / sv10: the recreate path closes the old peer and releases its viewer first
test('a 404 re-create closes the old peer and DELETEs its viewer before the new POST', async () => {
  const trace = [];
  const { session, fetch } = build({ whep: [{}, { status: 404 }, {}], trace });
  await session.connect();
  trace.length = 0;
  const old = session._pcStv;
  session._pcStv.setIce('failed');
  await until(() => fetch.posts.length >= 3, 3000);
  assert.equal(old.closed, true);
  assert.ok(trace.indexOf('DELETE') >= 0, trace.join());
  assert.ok(trace.indexOf('DELETE') < trace.lastIndexOf('POST'), trace.join());
  assert.equal(liveStv().length, 1);
  session.disconnect();
});

// cr6: disconnect() ends the retry backoff at once
test('disconnect() during the retry backoff ends the retry loop without waiting for the backoff', async () => {
  const { session, sockets } = build({ whep: [{}, { status: 503 }, {}], timeouts: { coldBackoff: 3000 } });
  await session.connect();
  const retrying = new Promise((r) => session.on('connectivityChanged', (p) => { if (p.state === 'reconnect_retry') r(); }));
  sockets[0].dropAndRecover('transport close', { recovered: false });
  await retrying;
  assert.equal(session._coldReconnecting, true);
  session.disconnect();
  await delay(60);
  assert.equal(session._coldReconnecting, false, 'the loop is still sleeping through its 3 s backoff');
});

// g1: an ICE restart that a cold rebuild overtakes does not report recovery
test('an ASR ICE restart overtaken by a cold reconnect does not emit mediaRecovered', async () => {
  const { session, ev } = build();
  await session.connect();
  const pc = session._pcAsr;
  const real = pc.setRemoteDescription.bind(pc);
  let entered = false;
  pc.setRemoteDescription = async (d) => { entered = true; await delay(300); return real(d); };
  pc.setIce('failed');
  await until(() => entered, 3000);                  // the restart is applying its answer
  const done = new Promise((r) => session.once('reconnected', r));
  session._coldReconnect('test').catch(() => {});
  await done;
  await delay(400);
  assert.equal(ev.includes('mediaRecovered:asr'), false, ev.join());
  session.disconnect();
});

// g10 (fresh-socket form): disconnect() during the DELETE of a cold reconnect that would open a new socket
test('disconnect() during the cold reconnect DELETE opens no fresh socket', async () => {
  const { session, sockets, fetch } = build({ deleteMs: 300 });
  await session.connect();
  session._coldReconnect('test').catch(() => {});   // from "connected": reuses nothing, would open a new socket
  await delay(60);
  session.disconnect();
  await delay(450);
  assert.equal(sockets.length, 1);
  assert.equal(fetch.posts.length, 1);
});
