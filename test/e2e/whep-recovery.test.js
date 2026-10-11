import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

/**
 * WHEP POST failure handling on a live session: what `connect()` and a media recovery do with
 * a transport reset, a 404 (STV session gone), a 409 (a viewer is still attached, often because
 * an earlier try was accepted but its reply was lost) and any other HTTP status.
 */

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const stvPeer = () => FakeRTCPeerConnection.instances.filter((p) => p.transceivers.some((t) => t.kind === 'video' && t.direction === 'recvonly')).at(-1);

function setup(steps, cfg = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const fetch = fakeWhepFetch(steps);
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch, getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false,
    timeouts: { whepBackoff: 5 }, ...cfg,
  });
  scriptHappyPath(socket, { resumingOnRecreate: false, webrtcUrls: ['https://srs.example/rtc/v1/whep/?app=a&stream=one', 'https://srs.example/rtc/v1/whep/?app=a&stream=two'] });
  return { session, socket, fetch };
}

for (const status of [404, 409]) {
  test(`connect: WHEP ${status} re-creates the STV session once on the live socket and subscribes again`, async () => {
    const { session, socket, fetch } = setup([{ status }, {}]);
    await session.connect();
    assert.equal(session.state, 'connected');
    assert.equal(socket.emitsOf('stvNewSession').length, 2, 'one re-create');
    assert.equal(socket.emitsOf('join').length, 1, 'no new join');
    assert.equal(fetch.posts.length, 2);
    assert.match(fetch.posts[0].url, /stream=one/);
    assert.match(fetch.posts[1].url, /stream=two/, 'second POST uses the new session');
    session.disconnect();
  });
}

test('connect: a POST the server accepted but whose reply was lost (reset, then 409) recovers through a re-create', async () => {
  const { session, socket, fetch } = setup([{ reset: true }, { status: 409 }, {}]);
  await session.connect();
  assert.equal(fetch.posts.length, 3);
  assert.equal(socket.emitsOf('stvNewSession').length, 2);
  session.disconnect();
});

test('connect: a second 404 after the re-create rejects stv_session_gone (retryable)', async () => {
  const { session, socket, fetch } = setup([{ status: 404 }]);
  await assert.rejects(session.connect(), (e) => e.code === 'stv_session_gone' && e.status === 404 && e.retryable === true);
  assert.equal(socket.emitsOf('stvNewSession').length, 2, 'exactly one re-create');
  assert.equal(fetch.posts.length, 2);
});

test('connect: a second 409 after the re-create rejects stv_session_gone with phase whep', async () => {
  const { session, fetch } = setup([{ status: 409 }]);
  await assert.rejects(session.connect(), (e) => e.code === 'stv_session_gone' && e.status === 409 && e.phase === 'whep' && e.retryable === true);
  assert.equal(fetch.posts.length, 2);
});

test('connect: any other HTTP status is not retried and is not a re-create', async () => {
  const { session, socket, fetch } = setup([{ status: 503 }, {}]);
  await assert.rejects(session.connect(), (e) => e.code === 'whep_failed' && e.status === 503 && e.phase === 'whep');
  assert.equal(fetch.posts.length, 1);
  assert.equal(socket.emitsOf('stvNewSession').length, 1);
});

test('connect: every try resets → whep_failed with phase whep', async () => {
  const { session, fetch } = setup([{ reset: true }]);
  await assert.rejects(session.connect(), (e) => e.code === 'whep_failed' && e.phase === 'whep' && e.retryable === true);
  assert.equal(fetch.posts.length, 3);
});

test('recovery: ICE failed + WHEP 404 re-creates the session and recovers without a cold reconnect', async () => {
  const { session, socket, fetch } = setup([{}, { status: 404 }, {}]);
  await session.connect();
  const ev = [];
  for (const e of ['mediaRecovering', 'mediaRecovered', 'reconnecting']) session.on(e, () => ev.push(e));
  const joins = socket.emitsOf('join').length;
  stvPeer().setIce('failed');
  await delay(300);
  assert.deepEqual(ev, ['mediaRecovering', 'mediaRecovered']);
  assert.equal(socket.emitsOf('join').length, joins, 'no cold reconnect');
  assert.equal(socket.emitsOf('stvNewSession').length, 2);
  assert.equal(fetch.deletes.length >= 1, true, 'the old subscription was released');
  session.disconnect();
});

test('recovery: the old subscription DELETE finishes before the new POST', async () => {
  const { session, fetch } = setup([{}, {}]);
  await session.connect();
  stvPeer().setIce('failed');
  await delay(300);
  const methods = fetch.calls.map((c) => c.method);
  assert.deepEqual(methods.slice(0, 3), ['POST', 'DELETE', 'POST']);
  session.disconnect();
});
