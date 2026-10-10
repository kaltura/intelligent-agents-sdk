import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

/** A cold reconnect gets a second try before the session ends. The `online` event retries a down socket at once. */

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function connected(steps, { timeouts = {}, cfg = {} } = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const fetch = fakeWhepFetch(steps);
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch, getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false,
    timeouts: { coldBackoff: 20, ...timeouts }, ...cfg,
  });
  scriptHappyPath(socket, { resumingOnRecreate: false });
  await session.connect();
  const ev = [];
  for (const e of ['reconnecting', 'reconnected', 'ended', 'error']) session.on(e, (p) => ev.push(e === 'ended' ? `ended:${p.reason}` : e === 'error' ? `error:${p.code}` : e));
  return { session, socket, fetch, ev };
}

test('the first attempt fails, the second succeeds: reconnected, session stays up', async () => {
  const { session, socket, fetch, ev } = await connected([{}, { status: 503 }, {}]);
  socket.dropAndRecover('transport close', { recovered: false });
  await delay(400);
  assert.deepEqual(ev, ['reconnecting', 'reconnected']);
  assert.equal(session.state, 'connected');
  assert.equal(fetch.posts.length, 3, 'initial POST, failed attempt, retry');
  session.disconnect();
});

test('both attempts fail: ended with reconnect_failed after exactly two tries', async () => {
  const { session, socket, fetch, ev } = await connected([{}, { status: 503 }]);
  let err;
  session.on('error', (e) => { err = e; });
  socket.dropAndRecover('transport close', { recovered: false });
  await delay(400);
  assert.deepEqual(ev, ['reconnecting', 'error:reconnect_failed', 'ended:reconnect_failed']);
  assert.equal(fetch.posts.length, 3);
  assert.equal(session.state, 'disconnected');
  assert.equal(err.phase, 'reconnect');
  assert.equal(err.retryable, true);
  assert.equal(err.cause?.code, 'whep_failed', 'the last failure is kept as cause');
  assert.equal(Object.keys(err).includes('cause'), false, 'cause stays out of enumerable fields');
});

test('coldAttempts: 1 turns the retry off', async () => {
  const { socket, fetch, ev } = await connected([{}, { status: 503 }], { timeouts: { coldAttempts: 1 } });
  socket.dropAndRecover('transport close', { recovered: false });
  await delay(300);
  assert.equal(fetch.posts.length, 2);
  assert.equal(ev.at(-1), 'ended:reconnect_failed');
});

test('disconnect() during the backoff cancels the retry', async () => {
  const { session, socket, fetch } = await connected([{}, { status: 503 }, {}], { timeouts: { coldBackoff: 300 } });
  const retrying = new Promise((r) => session.on('connectivityChanged', (p) => { if (p.state === 'reconnect_retry') r(); }));
  socket.dropAndRecover('transport close', { recovered: false });
  await retrying;
  session.disconnect();
  await delay(450);
  assert.equal(fetch.posts.length, 2, 'no second attempt');
  assert.equal(session.state, 'disconnected');
});

test('a second cold reconnect cannot start during the backoff or the retry', async () => {
  const { session, socket, fetch, ev } = await connected([{}, { status: 503 }, {}], { timeouts: { coldBackoff: 200 } });
  const retrying = new Promise((r) => session.on('connectivityChanged', (p) => { if (p.state === 'reconnect_retry') r(); }));
  socket.dropAndRecover('transport close', { recovered: false });
  await retrying;
  await session._coldReconnect('duplicate during backoff');
  await delay(400);
  assert.equal(fetch.posts.length, 3, 'initial POST, failed attempt, one retry: no extra rebuild');
  assert.deepEqual(ev, ['reconnecting', 'reconnected']);
  session.disconnect();
});

test('online: a down socket is told to reconnect at once', async () => {
  const listeners = {};
  const g = globalThis, origAdd = g.addEventListener, origRem = g.removeEventListener;
  g.addEventListener = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
  g.removeEventListener = (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); };
  try {
    const { session, socket } = await connected([{}], { cfg: { networkAware: true } });
    socket.connected = false; socket.server('disconnect', 'transport close');
    assert.equal(session.state, 'reconnecting');
    (listeners.online || []).forEach((fn) => fn());
    assert.equal(socket.connectCalls, 1);
    session.disconnect();
  } finally { g.addEventListener = origAdd; g.removeEventListener = origRem; }
});

test('online: a live socket is left alone', async () => {
  const listeners = {};
  const g = globalThis, origAdd = g.addEventListener, origRem = g.removeEventListener;
  g.addEventListener = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
  g.removeEventListener = (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); };
  try {
    const { session, socket } = await connected([{}], { cfg: { networkAware: true } });
    (listeners.online || []).forEach((fn) => fn());
    assert.equal(socket.connectCalls, undefined);
    session.disconnect();
  } finally { g.addEventListener = origAdd; g.removeEventListener = origRem; }
});
