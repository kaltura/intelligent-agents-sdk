// prepare(): socket + join ahead of connect(). No mic, no avatar session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor, fakeGetUserMedia } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {{timeouts?:object, script?:boolean[]}} [o] script[i] false leaves socket i silent */
function setup({ timeouts = {}, script = [true, true] } = {}) {
  FakeRTCPeerConnection.reset();
  /** @type {FakeSocket[]} */ const sockets = [];
  let mics = 0;
  const gum = fakeGetUserMedia();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl(), rtcConstructor: FakeRTCPeerConnection, fetch: fakeWhepFetch([{}]),
    getUserMedia: (c) => { mics += 1; return gum(c); }, mediaStreamConstructor: FakeMediaStreamCtor,
    timeouts,
    socketFactory: () => {
      const s = new FakeSocket();
      if (script[sockets.length] !== false) scriptHappyPath(s);
      sockets.push(s);
      return s;
    },
  });
  /** @type {any[]} */ const warnings = []; /** @type {string[]} */ const ready = [];
  session.on('warning', (w) => warnings.push(w));
  session.on('streamReady', () => ready.push('streamReady'));
  return { session, sockets, warnings, ready, mics: () => mics };
}

test('prepare() joins and stops there: no stvNewSession, no mic, state stays idle', async () => {
  const { session, sockets, mics } = setup();
  await session.prepare();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].emitsOf('join').length, 1);
  assert.equal(sockets[0].didEmit('stvNewSession'), false);
  assert.equal(sockets[0].didEmit('asr-webrtc-init'), false);
  assert.equal(mics(), 0);
  assert.equal(session.state, 'idle');
  session.disconnect();
});

test('connect() after prepare() reuses the socket and sends no second join', async () => {
  const { session, sockets, ready } = setup();
  await session.prepare();
  assert.deepEqual(ready, [], 'streamReady waits for connect()');
  await session.connect();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].emitsOf('join').length, 1);
  assert.deepEqual(ready, ['streamReady']);
  assert.equal(session.state, 'connected');
  const t = session.timings;
  assert.ok(t.joinComplete <= 5, 'the handshake phases cost nothing in connect()');
  assert.ok('connected' in t);
  session.disconnect();
});

test('prepare() is idempotent and connect() during a prepare waits for it', async () => {
  const { session, sockets } = setup();
  const a = session.prepare();
  const b = session.prepare();
  assert.equal(a, b);
  await session.connect();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].emitsOf('join').length, 1);
  session.disconnect();
});

test('prepare() while connecting or connected does nothing', async () => {
  const { session, sockets } = setup();
  await session.connect();
  await session.prepare();
  assert.equal(sockets.length, 1);
  session.disconnect();
});

test('an unused prepared socket is closed with warning prepare_expired, and connect() starts fresh', async () => {
  const { session, sockets, warnings } = setup({ timeouts: { prepareIdle: 60 } });
  await session.prepare();
  await delay(120);
  assert.deepEqual(warnings.map((w) => w.code), ['prepare_expired']);
  assert.equal(sockets[0].connected, false);
  await session.connect();
  assert.equal(sockets.length, 2);
  assert.equal(session.state, 'connected');
  session.disconnect();
});

test('connect() before the idle limit cancels the expiry timer', async () => {
  const { session, warnings } = setup({ timeouts: { prepareIdle: 80 } });
  await session.prepare();
  await session.connect();
  await delay(160);
  assert.deepEqual(warnings, []);
  assert.equal(session.state, 'connected');
  session.disconnect();
});

test('a failed prepare() rejects, and connect() then starts a fresh handshake', async () => {
  const { session, sockets } = setup({ timeouts: { serverConnect: 40 }, script: [false, true] });
  await assert.rejects(() => session.prepare(), (e) => e.code === 'timeout');
  assert.equal(sockets[0].connected, false);
  await session.connect();
  assert.equal(sockets.length, 2);
  assert.equal(session.state, 'connected');
  session.disconnect();
});

test('a prepared socket that drops is replaced by connect()', async () => {
  const { session, sockets } = setup();
  await session.prepare();
  sockets[0].server('disconnect', 'transport close');
  await session.connect();
  assert.equal(sockets.length, 2);
  assert.equal(session.state, 'connected');
  session.disconnect();
});

test('disconnect() after prepare() closes the socket and stops the expiry timer', async () => {
  const { session, sockets, warnings } = setup({ timeouts: { prepareIdle: 50 } });
  await session.prepare();
  session.disconnect();
  assert.equal(sockets[0].connected, false);
  await delay(120);
  assert.deepEqual(warnings, []);
});

test('disconnect() during a prepare() settles it at once', async () => {
  const { session, sockets } = setup({ script: [false] });
  const p = session.prepare();
  await delay(10);
  session.disconnect();
  await assert.rejects(p);
  assert.equal(sockets[0].connected, false);
});
