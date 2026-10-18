// setTapToTalkMode(enabled) switches a live session between tap-to-talk and open mic. Fake socket, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';
import { newAvatarSession as newSession, CONV_KS } from '../fakes/avatar-session.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A connected session on an open-mic agent, or a tap-to-talk agent with `{ tap: true }`. */
async function live({ tap = false } = {}) {
  const { session, socket } = newSession();
  scriptHappyPath(socket, tap ? { clientConfig: { isTapToTalk: true, interruptionsEnabled: true } } : {});
  await session.connect();
  return { session, socket };
}

const modeFrames = (socket) => socket.emitsOf('setTapToTalkMode');

test('setTapToTalkMode(true) sends enabled:true and flips capabilities and clientConfig', async () => {
  const { session, socket } = await live();
  assert.equal(session.capabilities.tapToTalk, false);
  session.setTapToTalkMode(true);
  assert.deepEqual(modeFrames(socket), [{ enabled: true }]);
  assert.equal(session.capabilities.tapToTalk, true);
  assert.equal(session.clientConfig.isTapToTalk, true);
  session.disconnect();
});

test('startTapToTalk() works after setTapToTalkMode(true) on an open-mic agent', async () => {
  const { session, socket } = await live();
  const started = [];
  session.on('tapToTalkStarted', () => started.push(1));
  session.setTapToTalkMode(true);
  session.startTapToTalk();
  assert.deepEqual(socket.emitsOf('tapToTalkStart'), [{}]);
  assert.equal(started.length, 1);
  session.endTapToTalk();
  session.disconnect();
});

test('setTapToTalkMode(false) makes startTapToTalk() throw capability_disabled', async () => {
  const { session, socket } = await live({ tap: true });
  assert.equal(session.capabilities.tapToTalk, true);
  session.setTapToTalkMode(false);
  assert.deepEqual(modeFrames(socket), [{ enabled: false }]);
  assert.equal(session.capabilities.tapToTalk, false);
  assert.throws(() => session.startTapToTalk(), (e) => e.code === 'capability_disabled' && /setTapToTalkMode\(true\)/.test(e.detail));
  session.disconnect();
});

test('setTapToTalkMode() with a non-boolean throws bad_request and sends nothing', async () => {
  const { session, socket } = await live();
  for (const bad of ['yes', 1, undefined, null]) {
    assert.throws(() => session.setTapToTalkMode(bad), (e) => e.code === 'bad_request', String(bad));
  }
  assert.deepEqual(modeFrames(socket), []);
  assert.equal(session.capabilities.tapToTalk, false);
  session.disconnect();
});

test('setTapToTalkMode(false) while a tap is open throws invalid_state and changes nothing', async () => {
  const { session, socket } = await live({ tap: true });
  session.startTapToTalk();
  assert.throws(() => session.setTapToTalkMode(false), (e) => e.code === 'invalid_state' && /endTapToTalk/.test(e.detail));
  assert.equal(session.capabilities.tapToTalk, true);
  assert.deepEqual(modeFrames(socket), []);
  session.setTapToTalkMode(true);   // allowed: no change in effect
  assert.deepEqual(modeFrames(socket), [{ enabled: true }]);
  session.endTapToTalk();
  session.disconnect();
});

test('setTapToTalkMode() throws invalid_state when not connected', async () => {
  const { session } = newSession();
  assert.throws(() => session.setTapToTalkMode(true), (e) => e.code === 'invalid_state');
  const { session: s2, socket } = await live();
  s2.disconnect();
  assert.throws(() => s2.setTapToTalkMode(true), (e) => e.code === 'invalid_state');
  assert.deepEqual(modeFrames(socket), []);
});

async function coldSession() {
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
  return { session, socket };
}

async function coldReconnect(session, socket) {
  const reconnected = new Promise((r) => session.once('reconnected', r));
  socket.dropAndRecover('transport close', { recovered: false });
  await reconnected;
}

test('the mode is sent again after a cold reconnect, after join', async () => {
  const { session, socket } = await coldSession();
  session.setTapToTalkMode(true);
  const before = socket.emitted.length;
  await coldReconnect(session, socket);
  const after = socket.emitted.slice(before).map((e) => e.event);
  const join = after.indexOf('join'), mode = after.indexOf('setTapToTalkMode'), stv = after.indexOf('stvNewSession');
  assert.ok(join >= 0 && mode > join && stv > mode, after.join());
  assert.deepEqual(socket.emitted.slice(before)[mode].payload, { enabled: true });
  assert.equal(session.capabilities.tapToTalk, true, 'the switched value survives the discarded join reply');
  session.disconnect();
});

test('a session that never called setTapToTalkMode sends nothing on cold reconnect', async () => {
  const { session, socket } = await coldSession();
  await coldReconnect(session, socket);
  assert.equal(socket.didEmit('setTapToTalkMode'), false);
  session.disconnect();
});

test("a new connect() starts from the agent's mode", async () => {
  const { session, socket } = await live();
  session.setTapToTalkMode(true);
  session.disconnect();
  const second = new FakeSocket();
  scriptHappyPath(second);
  session._socketFactory = () => second;
  session.setToken(CONV_KS);
  await session.connect();
  assert.equal(session.capabilities.tapToTalk, false);
  assert.equal(second.didEmit('setTapToTalkMode'), false);
  assert.equal(session._tapToTalkMode, null, 'no stale mode to send after a later cold reconnect');
  assert.equal(socket.emitsOf('setTapToTalkMode').length, 1);
  await delay(5);
  session.disconnect();
});
