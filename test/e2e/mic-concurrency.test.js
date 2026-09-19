/**
 * micStartMode:'immediate' (default) — connect() starts getUserMedia but never waits on it.
 * The permission prompt runs alongside the socket handshake; the track attaches the moment
 * it lands (addTrack if before the ASR peer exists, replaceTrack after). A denied/missing/
 * busy mic emits one `warning` and the session connects mic-less. startMic() joins an
 * in-flight acquire instead of prompting twice, and is the retry path after a warning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStream, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

function newSession(overrides = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const videoEl = overrides.videoEl ?? new FakeVideoEl({ autoCanPlay: true });
  const whepFetch = async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } });
  const getUserMedia = overrides.getUserMedia ?? fakeGetUserMedia();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.avatar.us.kaltura.ai',
    videoEl, socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: whepFetch, getUserMedia,
    mediaStreamConstructor: FakeMediaStreamCtor,
    ...overrides.cfg,
  });
  return { session, socket, videoEl, getUserMedia };
}

/** A getUserMedia whose prompt stays open until the test calls `release()` (or `deny(name)`). */
function heldGetUserMedia() {
  let settle;
  const gate = new Promise((res, rej) => { settle = { res, rej }; });
  const fn = async (constraints) => {
    fn.calls.push(constraints);
    await gate;
    fn.stream = new FakeMediaStream([{ kind: 'audio' }]);
    return fn.stream;
  };
  fn.calls = [];
  fn.stream = null;
  fn.release = () => settle.res();
  fn.deny = (name = 'NotAllowedError') => { const e = new Error(name); e.name = name; settle.rej(e); };
  return fn;
}

// The STV (WHEP) peer is created first, in parallel with the agent wait, so pick the ASR
// peer by shape (the one with no video transceiver) rather than by creation order.
const asrPeer = () => FakeRTCPeerConnection.instances.find((pc) => !pc.transceivers.some((t) => t.kind === 'video'));
const tick = () => new Promise((r) => setTimeout(r, 0));

test('connect() resolves while the permission prompt is still open; the track attaches later via replaceTrack', async () => {
  const gum = heldGetUserMedia();
  const { session, socket } = newSession({ getUserMedia: gum });
  scriptHappyPath(socket);
  const events = [];
  session.on('micStarted', () => events.push('micStarted'));
  session.on('warning', (w) => events.push(`warning:${w.code}`));

  await session.connect();
  assert.equal(session.state, 'connected');
  assert.equal(gum.calls.length, 1, 'prompt opened during connect()');
  assert.equal(session.micStarted, false, 'prompt still open: no mic yet');
  assert.equal(asrPeer().tracks.length, 0, 'ASR negotiated without a track');
  const slot = asrPeer().transceivers.find((t) => t.kind === 'audio' && t.direction === 'sendonly');
  assert.ok(slot, 'trackless sendonly slot negotiated (same wire handshake as deferred mode)');
  assert.ok(socket.didEmit('approvedPermissions'), 'connect() did not wait for the mic');

  gum.release();
  await tick();
  assert.equal(session.micStarted, true);
  assert.deepEqual(events, ['micStarted']);
  assert.equal(slot.sender.track, gum.stream.getAudioTracks()[0], 'attached via replaceTrack on the negotiated sender');
  session.disconnect();
});

test('mic granted before the ASR peer exists → addTrack path, micStarted fired', async () => {
  const { session, socket, getUserMedia } = newSession();
  scriptHappyPath(socket);
  const events = [];
  session.on('micStarted', () => events.push('micStarted'));
  await session.connect();
  assert.equal(getUserMedia.calls.length, 1);
  assert.equal(session.micStarted, true);
  assert.deepEqual(events, ['micStarted']);
  assert.equal(asrPeer().tracks.length, 1, 'track added directly to the ASR peer');
  session.disconnect();
});

for (const [errName, code] of [
  ['NotAllowedError', 'mic_permission_denied'],
  ['NotFoundError', 'mic_not_found'],
  ['NotReadableError', 'mic_in_use'],
  ['OverconstrainedError', 'mic_not_found'],
]) {
  test(`mic ${errName} → connected + one warning ${code}, speak() works, startMic() retries`, async () => {
    let fail = true;
    const grant = fakeGetUserMedia();
    const gum = async (c) => { if (fail) { const e = new Error(errName); e.name = errName; throw e; } return grant(c); };
    const { session, socket } = newSession({ getUserMedia: gum });
    scriptHappyPath(socket, { openingLine: true });   // opening turn finishes → speak() hold releases
    const warnings = [];
    session.on('warning', (w) => warnings.push(w));
    await session.connect();
    await tick();
    assert.equal(session.state, 'connected', 'a failed mic never fails connect()');
    assert.equal(session.micStarted, false);
    assert.equal(warnings.length, 1, 'exactly one mic warning');
    assert.equal(warnings[0].code, code);
    assert.equal(typeof warnings[0].message, 'string');
    await session.speak('typed turn with no mic');
    assert.ok(socket.didEmit('onTextEntered'), 'text chat works mic-less');
    fail = false;
    await session.startMic();   // retry after the user fixes the device/permission
    assert.equal(session.micStarted, true);
    assert.equal(grant.calls.length, 1);
    session.disconnect();
  });
}

test('mic granted after disconnect(): tracks stopped, no micStarted, no warning', async () => {
  const gum = heldGetUserMedia();
  const { session, socket } = newSession({ getUserMedia: gum });
  scriptHappyPath(socket);
  const events = [];
  session.on('micStarted', () => events.push('micStarted'));
  session.on('warning', (w) => events.push(`warning:${w.code}`));
  await session.connect();
  session.disconnect();
  gum.release();
  await tick();
  assert.deepEqual(events, []);
  assert.equal(session.micStarted, false);
  assert.equal(gum.stream.getAudioTracks()[0].readyState, 'ended', 'late stream is stopped, not leaked');
  assert.equal(session._micPromise, null);
});

test('mic denied after disconnect(): no warning on a dead session', async () => {
  const gum = heldGetUserMedia();
  const { session, socket } = newSession({ getUserMedia: gum });
  scriptHappyPath(socket);
  const warnings = [];
  session.on('warning', (w) => warnings.push(w));
  await session.connect();
  session.disconnect();
  gum.deny();
  await tick();
  assert.deepEqual(warnings, []);
});

test('startMic() during the in-flight acquire joins it: one getUserMedia call, one micStarted', async () => {
  const gum = heldGetUserMedia();
  const { session, socket } = newSession({ getUserMedia: gum });
  scriptHappyPath(socket);
  const events = [];
  session.on('micStarted', () => events.push('micStarted'));
  await session.connect();
  const p = session.startMic();
  await tick();
  assert.equal(gum.calls.length, 1, 'no second prompt');
  gum.release();
  await p;
  assert.equal(gum.calls.length, 1);
  assert.equal(session.micStarted, true);
  assert.deepEqual(events, ['micStarted']);
  session.disconnect();
});

test('startMic() joins an acquire that then fails: it re-prompts once and surfaces the typed error', async () => {
  const gum = heldGetUserMedia();
  let second = null;
  const wrapped = async (c) => {
    if (gum.calls.length === 0) return gum(c);
    second = c;
    const e = new Error('NotAllowedError'); e.name = 'NotAllowedError'; throw e;
  };
  const { session, socket } = newSession({ getUserMedia: wrapped });
  scriptHappyPath(socket);
  const warnings = [];
  session.on('warning', (w) => warnings.push(w.code));
  await session.connect();
  const p = session.startMic();
  gum.deny();
  await assert.rejects(p, (e) => e.code === 'mic_permission_denied');
  assert.ok(second, 'explicit startMic() retried after the background acquire failed');
  assert.deepEqual(warnings, ['mic_permission_denied'], 'background failure still emitted its one warning');
  assert.equal(session.state, 'connected');
  session.disconnect();
});

test('replaceTrack failure → mic_attach_failed warning, stream stopped, startMic() can retry', async () => {
  const gum = heldGetUserMedia();
  const { session, socket } = newSession({ getUserMedia: gum });
  scriptHappyPath(socket);
  const warnings = [];
  session.on('warning', (w) => warnings.push(w.code));
  await session.connect();
  const slot = asrPeer().transceivers.find((t) => t.kind === 'audio' && t.direction === 'sendonly');
  const realReplace = slot.sender.replaceTrack;
  slot.sender.replaceTrack = () => Promise.reject(new Error('InvalidStateError'));
  gum.release();
  await tick();
  assert.deepEqual(warnings, ['mic_attach_failed']);
  assert.equal(session.micStarted, false);
  assert.equal(gum.stream.getAudioTracks()[0].readyState, 'ended', 'acquired stream is released');
  slot.sender.replaceTrack = realReplace;
  await session.startMic();
  assert.equal(session.micStarted, true);
  session.disconnect();
});

test('mute() before the mic lands is honored when the track attaches', async () => {
  const gum = heldGetUserMedia();
  const { session, socket } = newSession({ getUserMedia: gum });
  scriptHappyPath(socket);
  await session.connect();
  session.mute();
  gum.release();
  await tick();
  assert.equal(session._micStream.getAudioTracks()[0].enabled, false, 'pre-mic mute() applies to the late track');
  session.unmute();
  assert.equal(session._micStream.getAudioTracks()[0].enabled, true);
  session.disconnect();
});

test('maxAsrBitrateKbps is applied when the late track attaches', async () => {
  const gum = heldGetUserMedia();
  const { session, socket } = newSession({ getUserMedia: gum, cfg: { maxAsrBitrateKbps: 32 } });
  scriptHappyPath(socket);
  await session.connect();
  gum.release();
  await tick();
  const sender = asrPeer().getSenders().find((s) => s.track?.kind === 'audio');
  assert.equal(sender.getParameters().encodings[0].maxBitrate, 32000);
  session.disconnect();
});

test('switchMic() keeps the mute state on the new track and stops the old one', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const oldTrack = session._micStream.getAudioTracks()[0];
  session.mute();
  await session.switchMic('mic-2');
  const newTrack = session._micStream.getAudioTracks()[0];
  assert.notEqual(newTrack, oldTrack);
  assert.equal(oldTrack.readyState, 'ended', 'old track stopped');
  assert.equal(newTrack.enabled, false, 'mute survives the switch');
  assert.equal(session.micStarted, true);
  session.disconnect();
});

test('connect() after a disconnect() with a still-pending acquire: the new session takes its own mic, the stale one is stopped', async () => {
  const gum = heldGetUserMedia();
  const { session, socket } = newSession({ getUserMedia: gum });
  scriptHappyPath(socket);
  await session.connect();
  session.disconnect();
  // Second connect on the same object: fresh prompt (the first one is still open).
  const socket2 = new FakeSocket();
  session._socketFactory = () => socket2;
  scriptHappyPath(socket2);
  const first = gum.stream;   // null: the first prompt has not resolved yet
  assert.equal(first, null);
  await session.connect();
  assert.equal(gum.calls.length, 2, 'the new connect() opens its own prompt');
  gum.release();   // resolves BOTH pending calls (shared gate)
  await tick();
  assert.equal(session.state, 'connected');
  assert.equal(session.micStarted, true);
  // Exactly one stream is live on the session; every other stream handed out was stopped.
  const live = session._micStream;
  assert.ok(live);
  assert.equal(live.getAudioTracks()[0].readyState, 'live');
  session.disconnect();
});
