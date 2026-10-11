import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('until: timed out'); await delay(5); } };

/** @param {{whep?:any[], timeouts?:any, cfg?:any, script?:any, scriptFor?:(i:number)=>any, wrapFetch?:(f:any)=>any}} [o] */
function build({ whep = [{}], videoEl = new FakeVideoEl({ autoCanPlay: true }), timeouts = {}, cfg = {}, script = { resumingOnRecreate: false }, scriptFor, wrapFetch } = {}) {
  FakeRTCPeerConnection.reset();
  const sockets = [], optsSeen = [];
  const socketFactory = (url, opts) => {
    optsSeen.push(opts);
    const s = new FakeSocket();
    const sc = scriptFor ? scriptFor(sockets.length) : script;
    if (sc !== false) scriptHappyPath(s, sc);
    sockets.push(s);
    return s;
  };
  const base = fakeWhepFetch(whep);
  const fetch = wrapFetch ? wrapFetch(base) : base;
  if (fetch !== base) for (const k of ['posts', 'deletes', 'calls']) Object.defineProperty(fetch, k, { get: () => base[k] });
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl, socketFactory, rtcConstructor: FakeRTCPeerConnection,
    fetch, getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false,
    timeouts: { healthTick: 600000, coldBackoff: 20, ...timeouts }, ...cfg,
  });
  const ev = [], conn = [], warnings = [];
  for (const e of ['mediaRecovering', 'mediaRecovered', 'reconnecting', 'reconnected']) session.on(e, (p) => ev.push(p?.channel ? `${e}:${p.channel}` : e + (p?.reason ? `:${p.reason}` : '')));
  session.on('connectivityChanged', (p) => conn.push(p));
  session.on('warning', (w) => warnings.push(w));
  return { session, sockets, optsSeen, fetch, ev, conn, warnings };
}

// ---- ICE grace ----
test('both channels disconnected: each recovers after the grace, one timer per channel', { timeout: 6000 }, async () => {
  const { session, ev } = build();
  await session.connect();
  session._pcAsr.setIce('disconnected');
  session._pcStv.setIce('disconnected');
  await delay(1200);
  assert.deepEqual(ev, [], 'still inside the 1.5 s grace');
  await until(() => ev.includes('mediaRecovering:asr') && ev.includes('mediaRecovering:stv'), 1500);
  session.disconnect();
});

test('a repeated disconnected restarts the grace', { timeout: 8000 }, async () => {
  const { session, ev } = build();
  await session.connect();
  const pc = session._pcStv;
  pc.setIce('disconnected');
  await delay(1000);
  pc.setIce('disconnected');
  await delay(900);   // 1.9 s after the first event, 0.9 s after the second
  assert.deepEqual(ev, []);
  await until(() => ev.includes('mediaRecovering:stv'), 1500);
  session.disconnect();
});

test('a grace timer from a torn-down session does not touch the next session', { timeout: 8000 }, async () => {
  const { session, ev } = build();
  await session.connect();
  session._pcStv.setIce('disconnected');
  session.disconnect();
  session.setToken(CONV_KS);
  await session.connect();
  ev.length = 0;
  await delay(1800);
  assert.deepEqual(ev, []);
  session.disconnect();
});

// ---- online handler ----
async function withNet(fn) {
  const listeners = {};
  const g = globalThis, origAdd = g.addEventListener, origRem = g.removeEventListener;
  g.addEventListener = (ev, f) => { (listeners[ev] = listeners[ev] || []).push(f); };
  g.removeEventListener = (ev, f) => { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); };
  try { await fn(() => (listeners.online || []).forEach((f) => f())); } finally { g.addEventListener = origAdd; g.removeEventListener = origRem; }
}
test('online: a connected session with a down socket does not call connect()', async () => {
  await withNet(async (fireOnline) => {
    const { session, sockets } = build({ cfg: { networkAware: true } });
    await session.connect();
    sockets[0].connected = false;   // no disconnect event reached the session
    fireOnline();
    assert.equal(sockets[0].connectCalls, undefined);
    sockets[0].connected = true;
    session.disconnect();
  });
});
test('online: a reconnecting session whose socket is up does not call connect()', async () => {
  await withNet(async (fireOnline) => {
    const { session, sockets } = build({ cfg: { networkAware: true } });
    await session.connect();
    sockets[0].connected = false; sockets[0].server('disconnect', 'transport close');
    assert.equal(session.state, 'reconnecting');
    sockets[0].connected = true;
    fireOnline();
    assert.equal(sockets[0].connectCalls, undefined);
    session.disconnect();
  });
});

// ---- cold reconnect retry ----
test('the retry opens a fresh socket and drops the old one', async () => {
  const { session, sockets, ev } = build({ whep: [{}, { status: 503 }, {}] });
  await session.connect();
  sockets[0].dropAndRecover('transport close', { recovered: false });
  await until(() => ev.includes('reconnected'), 3000);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].connected, false);
  assert.equal(sockets[1].emitsOf('join').length, 1);
  session.disconnect();
});

test('coldBackoff separates the two attempts', async () => {
  const stamps = [];
  const { session, sockets, ev } = build({
    whep: [{}, { status: 503 }, {}], timeouts: { coldBackoff: 300 },
    wrapFetch: (f) => async (url, init = {}) => { if (init.method === 'POST') stamps.push(Date.now()); return f(url, init); },
  });
  await session.connect();
  sockets[0].dropAndRecover('transport close', { recovered: false });
  await until(() => ev.includes('reconnected'), 4000);
  assert.equal(stamps.length, 3);
  assert.ok(stamps[2] - stamps[1] >= 290, `gap ${stamps[2] - stamps[1]} ms`);
  session.disconnect();
});

test('the retry that cannot build a socket ends with a typed reconnect_failed', async () => {
  const { session, sockets } = build({ whep: [{}, { status: 503 }] });
  await session.connect();
  let n = 0;
  session._socketFactory = () => { if (++n === 1) throw new Error('factory down'); throw new Error('factory down'); };
  let err;
  session.on('error', (e) => { err = e; });
  sockets[0].dropAndRecover('transport close', { recovered: false });
  await until(() => err, 3000);
  assert.equal(err.code, 'reconnect_failed');
  assert.equal(err.phase, 'reconnect');
  assert.equal(err.retryable, true);
  assert.match(String(err.cause?.message), /factory down/);
});

test('reconnect_failed from the socket layer carries phase and retryable', async () => {
  const { session, sockets } = build();
  await session.connect();
  let err;
  session.on('error', (e) => { err = e; });
  sockets[0].connected = false; sockets[0].server('disconnect', 'transport close');
  assert.equal(session.state, 'reconnecting');
  sockets[0].server('reconnect_failed');
  assert.equal(err?.code, 'reconnect_failed');
  assert.equal(err.phase, 'reconnect');
  assert.equal(err.retryable, true);
});

test('a cold reconnect with a dead socket and no factory retry carries phase reconnect', async () => {
  const { session, sockets } = build({ timeouts: { coldAttempts: 1 } });
  await session.connect();
  let err;
  session.on('error', (e) => { err = e; });
  session._setState('reconnecting');
  sockets[0].connected = false;
  await session._coldReconnect('x');
  assert.equal(err?.code, 'reconnect_failed');
  assert.equal(err.cause?.code, 'reconnect_failed');
  assert.equal(err.cause?.phase, 'reconnect');
  assert.equal(err.cause?.retryable, true);
});

// ---- recover budget ----
test('a re-subscribe POST that hangs hits timeouts.recover and escalates to a cold reconnect', { timeout: 8000 }, async () => {
  const { session, conn, ev } = build({ whep: [{}, { hang: true }, {}], timeouts: { recover: 80, whepTry: 60000 } });
  await session.connect();
  session._pcStv.setIce('failed');
  await until(() => conn.some((c) => c.state === 'recover_failed'), 2000);
  const f = conn.find((c) => c.state === 'recover_failed');
  assert.match(f.detail, /RecoverTimeout/);
  await until(() => ev.includes('reconnected'), 4000);
  session.disconnect();
});

// ---- 404 / 409 re-create ----
test('a 404 that arrives after the connect deadline does not ask for a new STV session', async () => {
  const { session, sockets } = build({ whep: [{ status: 404, delayMs: 150 }, {}], timeouts: { overall: 100 } });
  await assert.rejects(session.connect());
  await delay(100);
  assert.equal(sockets[0].emitsOf('stvNewSession').length, 1);
});

test('a re-create answered with the audio-mode status ends in stv_session_gone', async () => {
  let n = 0;
  const { session, sockets, ev } = build({ whep: [{}, { status: 404 }, {}] });
  await session.connect();
  const s = sockets[0];
  const handler = s._onEmit;
  s.onEmit((ev, p, sock) => {
    if (ev === 'stvNewSession' && ++n >= 1) { setTimeout(() => s.server('stvNewSession', { status: 'audio/phone mode - no STV session' }), 0); return; }
    handler(ev, p, sock);
  });
  const conn = [];
  session.on('connectivityChanged', (c) => conn.push(c));
  session._pcStv.setIce('failed');
  await until(() => conn.some((c) => c.state === 'recover_failed'), 3000);
  await until(() => ev.some((e) => e.startsWith('reconnecting')), 3000);
  assert.ok(ev.includes('reconnecting:stv session gone (404)'), ev.join());
  assert.match(conn.find((c) => c.state === 'recover_failed').detail, /did not return a video stream session/);
  session.disconnect();
});

test('a session that is gone twice is labeled "stv session gone (404)" for the cold reconnect', { timeout: 8000 }, async () => {
  const { session, ev } = build({ whep: [{}, { status: 404 }, { status: 404 }, {}] });
  await session.connect();
  session._pcStv.setIce('failed');
  await until(() => ev.some((e) => e.startsWith('reconnecting')), 3000);
  assert.ok(ev.includes('reconnecting:stv session gone (404)') || ev.some((e) => /stv session gone/.test(e)), ev.join());
  session.disconnect();
});

test('recovery waits for the DELETE before the next POST', async () => {
  const order = [];
  const { session } = build({
    wrapFetch: (f) => async (url, init = {}) => {
      if (init.method === 'DELETE') { order.push('delete:start'); await delay(80); order.push('delete:end'); }
      if (init.method === 'POST') order.push('post');
      return f(url, init);
    },
  });
  await session.connect();
  order.length = 0;
  session._pcStv.setIce('failed');
  await until(() => order.includes('post'), 2000);
  assert.deepEqual(order.slice(0, 3), ['delete:start', 'delete:end', 'post']);
  session.disconnect();
});

// ---- prepare ----
test('a stale prepare idle timer does not drop a later prepare (consumed by connect)', async () => {
  const { session, warnings } = build({ timeouts: { prepareIdle: 300 } });
  const t0 = Date.now();
  await session.prepare();
  await session.connect();
  session.disconnect();
  session._timeouts.prepareIdle = 60000;   // the second prepare keeps its connection for a minute
  session.setToken(CONV_KS);
  await session.prepare();
  assert.ok(Date.now() - t0 < 250, 'the second prepare must start before the first timer is due');
  await delay(420 - (Date.now() - t0));    // past the first (stale) timer
  assert.equal(session._prep !== null, true, 'the second prepare is still held');
  assert.deepEqual(warnings.filter((w) => w.code === 'prepare_expired'), []);
  session.disconnect();
});

test('a stale prepare idle timer does not drop a later prepare (torn down by disconnect)', async () => {
  const { session, warnings } = build({ timeouts: { prepareIdle: 300 } });
  const t0 = Date.now();
  await session.prepare();
  session.disconnect();
  session._timeouts.prepareIdle = 60000;
  session.setToken(CONV_KS);
  await session.prepare();
  assert.ok(Date.now() - t0 < 250, 'the second prepare must start before the first timer is due');
  await delay(420 - (Date.now() - t0));
  assert.equal(session._prep !== null, true);
  assert.deepEqual(warnings.filter((w) => w.code === 'prepare_expired'), []);
  session.disconnect();
});

test('a failed prepare leaves no pending awaits behind', async () => {
  const { session } = build({ scriptFor: () => ({ resumingOnRecreate: false }), timeouts: { joinRoom: 80, joinComplete: 5000 } });
  session._socketFactory = ((orig) => (u, o) => { const s = orig(u, o); s.onEmit(() => {}); return s; })(session._socketFactory);
  await assert.rejects(session.prepare());
  assert.equal(session._pendingAwaits.size, 0);
});

test('disconnect() while connect() waits on a prepare in flight stops connect() for good', async () => {
  const { session, sockets } = build({ scriptFor: () => false });
  const prep = session.prepare();
  prep.catch(() => {});
  const p = session.connect();
  p.catch(() => {});
  await delay(20);
  session.disconnect();
  await assert.rejects(p, (e) => e.code === 'connect_failed' && typeof e.timings === 'object');
  assert.equal(session._timings, null, 'the timing window is closed');
  await delay(30);
  assert.equal(sockets.length, 1, 'no second socket was opened');
  assert.equal(session.state, 'disconnected');
});

test('an expired prepare clears the client config', async () => {
  const { session } = build({ timeouts: { prepareIdle: 60 } });
  await session.prepare();
  assert.ok(session.clientConfig);
  await delay(120);
  assert.equal(session.clientConfig, null);
});

// ---- socket options at every call site ----
test('every socket the session opens carries the configured reconnection delay', async () => {
  const { session, sockets, optsSeen, ev } = build({ cfg: { reconnectionDelay: 123, reconnectionDelayMax: 456 }, whep: [{}, { status: 503 }, {}] });
  await session.prepare();
  await session.connect();
  sockets[0].dropAndRecover('transport close', { recovered: false });
  await until(() => ev.includes('reconnected'), 3000);   // retry opens a fresh socket
  const wc = session.waitForCapacity({ maxWaitMs: 500, pollIntervalMs: 50 });
  await wc.catch(() => {});
  assert.ok(optsSeen.length >= 3, `socket opens: ${optsSeen.length}`);
  for (const o of optsSeen) { assert.equal(o.reconnectionDelay, 123); assert.equal(o.reconnectionDelayMax, 456); }
  session.disconnect();
});

// wp16: the connect deadline stops the WHEP retries
test('whep retries stop once the connect deadline has passed', async () => {
  const { session, fetch } = build({ whep: Array(6).fill({ reset: true }), timeouts: { overall: 120, whepTries: 6, whepBackoff: 100 } });
  await assert.rejects(session.connect());
  await delay(700);
  assert.ok(fetch.posts.length <= 3, `${fetch.posts.length} POSTs; the deadline passed after the second try`);
  assert.ok(fetch.posts.length >= 2);
});

// tm4: a phase that happens twice keeps its first time
test('connectTimings keeps the first time of a phase that repeats (404 re-create)', async () => {
  let n = 0;
  const atPost = [];
  const { session } = build({
    whep: [{ status: 404 }, {}], cfg: { now: () => (n += 10) },
    wrapFetch: (f) => async (url, init = {}) => { if (init.method === 'POST') atPost.push(n); return f(url, init); },
  });
  await session.connect();
  assert.equal(atPost.length, 2);
  assert.ok(session.timings.whepSent <= atPost[0], `whepSent ${session.timings.whepSent} is from the first POST (clock ${atPost[0]})`);
});

// g9: a cold reconnect cancels a recovery that waits for its first frame
test('a cold reconnect cancels the pending first-frame wait of a recovery', async () => {
  const el = new FakeVideoEl({ autoCanPlay: false, rvfc: true });
  const { session } = build({ videoEl: el, timeouts: { firstFrame: 5000 } });
  const connecting = session.connect();
  await until(() => el._frameCbs.size === 1);
  el.fireFrame();
  await connecting;
  session._pcStv.setIce('failed');
  await until(() => typeof session._cancelStvPlayable === 'function');   // the recovery waits for its frame
  const armed = session._cancelStvPlayable;
  let cancels = 0;
  session._cancelStvPlayable = () => { cancels++; armed(); };
  session._coldReconnect('test').catch(() => {});                        // the cancel runs before its first await
  assert.equal(cancels, 1, 'the cold reconnect cancelled the recovery wait');
  const stop = setInterval(() => el.fireFrame(), 20);
  try { await until(() => session.state === 'connected', 4000); } finally { clearInterval(stop); }
  session.disconnect();
});

// ep17: the recovery budget error names its phase
test('a recovery step that outlives timeouts.recover rejects with a whep-phase timeout', async () => {
  const { session } = build({ timeouts: { recover: 30 } });
  await assert.rejects(session._withinRecoverBudget(new Promise(() => {})), (e) => e.code === 'timeout' && e.phase === 'whep' && e.retryable === true && e.detail === 'RecoverTimeout: timed out waiting for the server (step: whep). Trying again can help.');
});
