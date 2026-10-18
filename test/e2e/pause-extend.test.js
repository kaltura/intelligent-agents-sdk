// extendPause() and the pauseExpiryWarning session event. Fake socket, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';
import { newAvatarSession as newSession } from '../fakes/avatar-session.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function live() {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  return { session, socket };
}

test('extendPause() sends extendPause once and returns true while paused', async () => {
  const { session, socket } = await live();
  session.pause();
  assert.equal(session.extendPause(), true);
  assert.deepEqual(socket.emitsOf('extendPause'), [{}]);
  session.disconnect();
});

test('extendPause() returns false and sends nothing when not paused', async () => {
  const { session, socket } = await live();
  assert.equal(session.extendPause(), false);
  session.pause();
  await session.resume();
  assert.equal(session.extendPause(), false);
  assert.equal(socket.didEmit('extendPause'), false);
  session.disconnect();
});

test('extendPause() returns false after the pause window ended', async () => {
  for (const frame of ['pauseSessionExpired', 'sessionReadyForResume']) {
    const { session, socket } = await live();
    session.pause();
    socket.server(frame, {});
    assert.equal(session.extendPause(), false, frame);
    assert.equal(socket.didEmit('extendPause'), false, frame);
    session.disconnect();
  }
});

test('extendPause() returns false while a rebuilt session waits for resume()', async () => {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({
    token: newSession().session._token, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: fakeWhepFetch([{}]), getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false,
    timeouts: { coldBackoff: 20 },
  });
  scriptHappyPath(socket, { resumingOnRecreate: false });
  await session.connect();
  session.pause();
  const reconnected = new Promise((r) => session.once('reconnected', r));
  socket.dropAndRecover('transport close', { recovered: false });
  await reconnected;
  assert.ok(session._pausedPendingApprove, 'the rebuilt session holds its approve');
  assert.equal(session.extendPause(), false);
  assert.equal(socket.didEmit('extendPause'), false);
  session.disconnect();
});

test('extendPause() throws invalid_state when not connected', async () => {
  const { session } = newSession();
  assert.throws(() => session.extendPause(), (e) => e.code === 'invalid_state');
  const { session: s2, socket } = await live();
  s2.pause();
  s2.disconnect();
  assert.throws(() => s2.extendPause(), (e) => e.code === 'invalid_state');
  assert.equal(socket.didEmit('extendPause'), false);
});

test('pauseExpiryWarning is re-emitted with secondsRemaining', async () => {
  const { session, socket } = await live();
  const seen = [];
  session.on('pauseExpiryWarning', (p) => seen.push(p));
  socket.server('pauseExpiryWarning', { secondsRemaining: 7 });
  socket.server('pauseExpiryWarning', {});
  assert.deepEqual(seen, [{ secondsRemaining: 7 }, { secondsRemaining: undefined }]);
  session.disconnect();
});

test('extendPause() starts no timers', async () => {
  const { session } = await live();
  session.pause();
  const realT = globalThis.setTimeout, realI = globalThis.setInterval;
  let started = 0;
  globalThis.setTimeout = (...a) => { started++; return realT(...a); };
  globalThis.setInterval = (...a) => { started++; return realI(...a); };
  try { session.extendPause(); } finally { globalThis.setTimeout = realT; globalThis.setInterval = realI; }
  assert.equal(started, 0);
  await delay(5);
  session.disconnect();
});
