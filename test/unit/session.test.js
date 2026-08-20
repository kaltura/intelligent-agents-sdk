// Proves issue #19: KalturaAvatarSession's STV pc.ontrack emits 'track', the
// same shape KalturaScriptedVideoSession already emits, with or without a
// videoEl, and without disturbing the existing srcObject/play() attach path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia } from '../fakes/rtc.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

function newSession(overrides = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const videoEl = 'videoEl' in overrides ? overrides.videoEl : new FakeVideoEl({ autoCanPlay: true });
  const whepFetch = overrides.fetch ?? (async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } }));
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.avatar.us.kaltura.ai',
    videoEl, socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: whepFetch, getUserMedia: overrides.getUserMedia ?? fakeGetUserMedia(),
  });
  return { session, socket, videoEl };
}

test("emits 'track' with {track, streams} when the STV peer's ontrack fires (videoEl configured)", async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  const tracks = [];
  session.on('track', (p) => tracks.push(p));
  await session.connect();
  assert.ok(tracks.length >= 1, "expected at least one 'track' event");
  assert.equal(tracks[0].track.kind, 'video');
  assert.ok(Array.isArray(tracks[0].streams));
  session.disconnect();
});

test("emits 'track' even when videoEl is omitted (headless/custom-render path)", async () => {
  const { session, socket } = newSession({ videoEl: null });
  scriptHappyPath(socket);
  const tracks = [];
  session.on('track', (p) => tracks.push(p));
  await session.connect();
  assert.ok(tracks.length >= 1, "'track' must fire without a videoEl — that's the whole point of the headless path");
  session.disconnect();
});

test('regression: videoEl.srcObject/.play() attach behavior is unchanged (no double-emit side effects)', async () => {
  const { session, socket, videoEl } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  assert.ok(videoEl.srcObject, 'srcObject still assigned from the STV stream');
  // Baseline is 2, not 1: the STV transceiver's ontrack fires once for the video
  // track and once for the audio track (pre-existing, unrelated to this issue) —
  // the point here is that adding the new emit('track', ...) call doesn't change it.
  assert.equal(videoEl.playCount, 2, 'play() call count unchanged by the new emit');
  session.disconnect();
});

// issue #20: videoWidth/videoHeight exposure
test("emits 'videoMetadata' once decoded dimensions are known (videoEl configured)", async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: false });
  const { session, socket } = newSession({ videoEl });
  scriptHappyPath(socket);
  const events = [];
  session.on('videoMetadata', (p) => events.push(p));
  const connectP = session.connect();
  await delay(20);
  videoEl.fireLoadedMetadata(960, 540);
  videoEl.fireCanPlay();
  await connectP;
  assert.deepEqual(events, [{ videoWidth: 960, videoHeight: 540 }]);
  assert.equal(events.length, 1, 'exactly once per connect, despite ontrack firing for both video and audio tracks');
  session.disconnect();
});

test("regression: 'videoMetadata' never fires when videoEl is omitted (headless)", async () => {
  const { session, socket } = newSession({ videoEl: null });
  scriptHappyPath(socket);
  const events = [];
  session.on('videoMetadata', (p) => events.push(p));
  await session.connect();
  assert.equal(events.length, 0);
  assert.equal(session.state, 'connected', 'still connects normally without a videoEl');
  session.disconnect();
});

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Proves issue #24: the dead-air masking contract ('thinking…' affordance).
test("'responsePending' fires with {} the moment a turn starts awaiting brain output", async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const events = [];
  session.on('responsePending', (p) => events.push(p));
  socket.server('agentTurnToTalk', { userTranscription: 'hello?' });
  assert.deepEqual(events, [{}]);
  assert.equal(session.responsePending, true);
  session.disconnect();
});

test("'responseSettled' fires with {} once the avatar's first perceivable output arrives", async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const events = [];
  session.on('responseSettled', (p) => events.push(p));
  socket.server('agentTurnToTalk', { userTranscription: 'hello?' });
  assert.equal(session.responsePending, true, 'armed while awaiting output');
  socket.server('stvStartedTalking', {});
  assert.deepEqual(events, [{}]);
  assert.equal(session.responsePending, false);
  session.disconnect();
});

test("'responseSettled' also fires on interruption, so the affordance never gets stuck showing", async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const events = [];
  session.on('responseSettled', (p) => events.push(p));
  socket.server('agentTurnToTalk', { userTranscription: 'hello?' });
  socket.server('agentInterrupted', {});
  assert.deepEqual(events, [{}]);
  assert.equal(session.responsePending, false);
  session.disconnect();
});
