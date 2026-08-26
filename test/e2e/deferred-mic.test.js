/**
 * micStartMode:'deferred' — connect with NO mic (trackless sendonly ASR slot), then
 * startMic() attaches the track later via replaceTrack (no renegotiation). The CM
 * handshake must stay byte-identical to the immediate path; mic errors move from
 * connect() to startMic(); tap-to-talk/switchMic are guarded until the mic is live.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia } from '../fakes/rtc.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

function newSession(overrides = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const videoEl = overrides.videoEl ?? new FakeVideoEl({ autoCanPlay: true });
  const whepFetch = overrides.fetch ?? (async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } }));
  const getUserMedia = overrides.getUserMedia ?? fakeGetUserMedia();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.avatar.us.kaltura.ai',
    videoEl, socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: whepFetch, getUserMedia, micStartMode: 'deferred',
    ...overrides.cfg,
  });
  return { session, socket, videoEl, getUserMedia };
}

const asrPeer = () => FakeRTCPeerConnection.instances[0];

test('deferred connect: no getUserMedia, handshake identical, sendonly audio slot negotiated', async () => {
  const { session, socket, getUserMedia } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(session.state, 'connected');
  assert.equal(getUserMedia.calls.length, 0, 'connect() must never touch the mic in deferred mode');
  assert.equal(session.micStarted, false);
  // The CM handshake is byte-identical to the immediate path.
  assert.ok(socket.didEmit('asr-webrtc-init'));
  assert.ok(socket.didEmit('asr-webrtc-offer'));
  assert.ok(socket.didEmit('approvedPermissions'));
  // The ASR peer negotiated a trackless sendonly audio slot instead of a track.
  assert.equal(asrPeer().tracks.length, 0, 'no track added');
  const t = asrPeer().transceivers.find((x) => x.kind === 'audio' && x.direction === 'sendonly');
  assert.ok(t, 'sendonly audio transceiver present');
  assert.equal(t.sender.track, null, 'trackless until startMic()');
  session.disconnect();
});

test('startMic(): acquires the mic, attaches via replaceTrack, emits micStarted, idempotent', async () => {
  const { session, socket, getUserMedia } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const events = [];
  session.on('micStarted', () => events.push('micStarted'));
  await session.startMic();
  assert.equal(getUserMedia.calls.length, 1);
  assert.equal(session.micStarted, true);
  assert.deepEqual(events, ['micStarted']);
  const sender = asrPeer().getSenders().find((s) => s.track?.kind === 'audio');
  assert.ok(sender, 'the sendonly slot now carries the mic track');
  assert.equal(sender.track, session._micStream.getAudioTracks()[0], 'attached via replaceTrack on the negotiated sender');
  // Idempotent: a second call is a no-op, no second permission prompt.
  await session.startMic();
  assert.equal(getUserMedia.calls.length, 1);
  assert.deepEqual(events, ['micStarted'], 'no duplicate event');
  session.disconnect();
});

test('pre-mic guards: startTapToTalk and switchMic throw mic_not_started until startMic()', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket, { clientConfig: { isTapToTalk: true, interruptionsEnabled: true } });
  await session.connect();
  assert.throws(() => session.startTapToTalk(), (e) => e.code === 'mic_not_started');
  await assert.rejects(() => session.switchMic('mic-2'), (e) => e.code === 'mic_not_started');
  await session.startMic();
  session.startTapToTalk();   // now allowed
  assert.ok(socket.didEmit('tapToTalkStart'));
  session.endTapToTalk();
  await session.switchMic('mic-2');   // now allowed
  session.disconnect();
});

test('startMic() denial → mic_permission_denied (R6), session stays connected, retry works', async () => {
  let deny = true;
  const gum = fakeGetUserMedia();
  const flaky = async (constraints) => {
    if (deny) { const err = new Error('Permission denied'); err.name = 'NotAllowedError'; throw err; }
    return gum(constraints);
  };
  const { session, socket } = newSession({ getUserMedia: flaky });
  scriptHappyPath(socket);
  await session.connect();
  await assert.rejects(() => session.startMic(), (e) => e.code === 'mic_permission_denied');
  assert.equal(session.state, 'connected', 'a denied prompt must not kill the live session');
  assert.equal(session.micStarted, false);
  deny = false;
  await session.startMic();   // user granted on retry
  assert.equal(session.micStarted, true);
  session.disconnect();
});

test('mute() issued before the mic exists is honored when the track arrives', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  session.mute();   // pre-mic: socket-level mute only, no track to disable yet
  assert.ok(socket.didEmit('muteUser'));
  await session.startMic();
  assert.equal(session._micStream.getAudioTracks()[0].enabled, false, 'pre-mic mute() applies to the new track');
  session.unmute();
  assert.equal(session._micStream.getAudioTracks()[0].enabled, true);
  session.disconnect();
});

test('maxAsrBitrateKbps is re-applied at startMic (connect-time apply had no track to find)', async () => {
  const { session, socket } = newSession({ cfg: { maxAsrBitrateKbps: 32 } });
  scriptHappyPath(socket);
  await session.connect();
  await session.startMic();
  const sender = asrPeer().getSenders().find((s) => s.track?.kind === 'audio');
  assert.equal(sender.getParameters().encodings[0].maxBitrate, 32000);
  session.disconnect();
});

test('immediate mode (default): micStarted true after connect, startMic() is a no-op', async () => {
  const { session, socket, getUserMedia } = newSession({ cfg: { micStartMode: 'immediate' } });
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(session.micStarted, true);
  assert.equal(getUserMedia.calls.length, 1);
  await session.startMic();
  assert.equal(getUserMedia.calls.length, 1, 'no second acquisition');
  session.disconnect();
});

test('startMic() before connect throws invalid_state; bad micStartMode throws bad_request at construction', async () => {
  const { session } = newSession();
  await assert.rejects(() => session.startMic(), (e) => e.code === 'invalid_state');
  assert.throws(() => newSession({ cfg: { micStartMode: 'lazy' } }), (e) => e.code === 'bad_request');
});
