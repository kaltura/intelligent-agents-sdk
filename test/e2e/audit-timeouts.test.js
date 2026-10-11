import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { KalturaError } from '../../src/core/errors.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function mk({ timeouts = {}, steps = [{}], fakeOpts = {}, fetch } = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const f = fetch || fakeWhepFetch(steps);
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: f, getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false, timeouts,
  });
  scriptHappyPath(socket, fakeOpts);
  return { session, socket, fetch: f };
}
/** The fake server swallows one event, so the SDK's wait for it times out. */
const drop = (socket, ev) => { const real = socket.server.bind(socket); socket.server = (e, p) => { if (e !== ev) real(e, p); }; };
/** The fake server delivers one event late. */
const lag = (socket, ev, ms) => { const real = socket.server.bind(socket); socket.server = (e, p) => { if (e === ev) setTimeout(() => real(e, p), ms); else real(e, p); }; };

const STALLS = [
  ['onServerConnected', 'serverConnect', 'serverConnect'],
  ['clientConfiguration', 'joinRoom', 'join'],
  ['joinComplete', 'joinComplete', 'joinComplete'],
  ['showAgent', 'agent', 'agent'],
  ['askPermissions', 'agent', 'agent'],
  ['asr-webrtc-ready', 'asr', 'asr'],
  ['asr-webrtc-answer', 'asr', 'asr'],
];
for (const [event, key, phase] of STALLS) {
  test(`a missing "${event}" times out after timeouts.${key}, with phase "${phase}" and retryable true`, { timeout: 3000 }, async () => {
    const { session, socket } = mk({ timeouts: { [key]: 60 } });
    drop(socket, event);
    const t0 = Date.now();
    const err = await session.connect().then(() => null, (e) => e);
    assert.ok(err instanceof KalturaError, String(err));
    assert.equal(err.code, 'timeout');
    assert.equal(err.phase, phase);
    assert.equal(err.retryable, true);
    assert.ok(Date.now() - t0 < 1500, 'the cfg value, not the 5-30 s default, set the wait');
    assert.equal(session.state, 'error');
  });
}

test('timeouts.overall ends a handshake whose events arrive late: phase "connect"', { timeout: 3000 }, async () => {
  const { session, socket } = mk({ timeouts: { overall: 150 } });
  lag(socket, 'showAgent', 400);
  const err = await session.connect().then(() => null, (e) => e);
  assert.equal(err?.code, 'timeout');
  assert.equal(err.phase, 'connect');
  assert.equal(err.retryable, true);
});

test('timeouts.overall stops the wait for a stvNewSession reply: phase "connect"', { timeout: 3000 }, async () => {
  const { session } = mk({ timeouts: { overall: 200 }, fakeOpts: { delayStvReplyMs: 5000 } });
  const err = await session.connect().then(() => null, (e) => e);
  assert.equal(err?.code, 'timeout');
  assert.equal(err.phase, 'connect');
});

test('timeouts.overall ends a WHEP answer that comes back after the deadline: phase "whep", and the stream is released', { timeout: 3000 }, async () => {
  const { session, fetch } = mk({ timeouts: { overall: 250 }, steps: [{ delayMs: 450 }] });
  const err = await session.connect().then(() => null, (e) => e);
  assert.equal(err?.code, 'timeout');
  assert.equal(err.phase, 'whep');
  await delay(30);
  assert.equal(fetch.deletes.length, 1, 'the late answer is released');
});

test('timeouts.whepTry / whepTries / whepBackoff drive the WHEP retry loop', { timeout: 3000 }, async () => {
  const { session, fetch } = mk({ timeouts: { whepTry: 40, whepTries: 2, whepBackoff: 10 }, steps: [{ hang: true }] });
  const t0 = Date.now();
  const err = await session.connect().then(() => null, (e) => e);
  assert.equal(err?.code, 'whep_timeout');
  assert.equal(err.phase, 'whep');
  assert.equal(err.retryable, true);
  assert.equal(fetch.posts.length, 2);
  assert.ok(Date.now() - t0 < 1000);
});

test('KalturaError.toJSON keeps phase and retryable', () => {
  const e = new KalturaError({ type: 'about:blank', title: 't', code: 'timeout', phase: 'whep', retryable: true });
  const j = JSON.parse(JSON.stringify(e));
  assert.equal(j.phase, 'whep');
  assert.equal(j.retryable, true);
  const bare = JSON.parse(JSON.stringify(new KalturaError({ type: 'about:blank', title: 't', code: 'x' })));
  assert.equal('phase' in bare, false);
  assert.equal('retryable' in bare, false);
});

// ---- release: DELETE deadline, rejection, sync throw
test('a DELETE that never answers is aborted after timeouts.whepRelease', async () => {
  const base = fakeWhepFetch([{}]);
  const seen = [];
  const fetch = (url, init = {}) => {
    if (init.method !== 'DELETE') return base(url, init);
    return new Promise((_, rej) => { init.signal?.addEventListener('abort', () => { seen.push('aborted'); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }); });
  };
  const { session } = mk({ timeouts: { whepRelease: 40 }, fetch });
  await session.connect();
  session.disconnect();
  await delay(20);
  assert.deepEqual(seen, [], 'not yet');
  await delay(100);
  assert.deepEqual(seen, ['aborted']);
});

test('a DELETE that rejects does not leave an unhandled rejection', async () => {
  const base = fakeWhepFetch([{}]);
  const fetch = (url, init = {}) => (init.method === 'DELETE' ? Promise.reject(new TypeError('network down')) : base(url, init));
  const { session } = mk({ fetch });
  await session.connect();
  const unhandled = [];
  const on = (e) => unhandled.push(e);
  process.on('unhandledRejection', on);
  try { session.disconnect(); await delay(50); } finally { process.off('unhandledRejection', on); }
  assert.deepEqual(unhandled, []);
});

test('a fetch that throws synchronously on DELETE does not break disconnect()', async () => {
  const base = fakeWhepFetch([{}]);
  const fetch = (url, init = {}) => { if (init.method === 'DELETE') throw new Error('sync boom'); return base(url, init); };
  const { session } = mk({ fetch });
  await session.connect();
  assert.doesNotThrow(() => session.disconnect());
  await delay(20);
  assert.equal(session.state, 'disconnected');
});
