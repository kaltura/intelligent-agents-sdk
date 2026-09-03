// KalturaAvatarSession's STV pc.ontrack emits 'track', the
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
    ...(overrides.cfg || {}),
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

// videoWidth/videoHeight exposure
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

// 'mediaReady' — a single deterministic "real media is coming" signal, so a
// consumer doesn't have to gate a loading UI on the misleadingly-named
// 'streamReady' (Step 1 handshake, no video yet) or hand-roll an audio-mode
// fallback timeout.
test("emits 'mediaReady' with {mode:'video', videoWidth, videoHeight} at the same point 'videoMetadata' fires", async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: false });
  const { session, socket } = newSession({ videoEl });
  scriptHappyPath(socket);
  const mediaReady = [];
  const videoMetadata = [];
  session.on('mediaReady', (p) => mediaReady.push(p));
  session.on('videoMetadata', (p) => videoMetadata.push(p));
  const connectP = session.connect();
  await delay(20);
  videoEl.fireLoadedMetadata(960, 540);
  videoEl.fireCanPlay();
  await connectP;
  assert.deepEqual(mediaReady, [{ mode: 'video', videoWidth: 960, videoHeight: 540 }]);
  assert.equal(mediaReady.length, 1, 'exactly once per connect, like videoMetadata');
  assert.deepEqual(videoMetadata, [{ videoWidth: 960, videoHeight: 540 }], "'videoMetadata' payload/timing unchanged");
  session.disconnect();
});

test("emits 'mediaReady' with {mode:'video', videoWidth:0, videoHeight:0} when the decoder never resolves dimensions (videoEl configured, no loadedmetadata)", async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: false });
  const { session, socket } = newSession({ videoEl });
  scriptHappyPath(socket);
  const mediaReady = [];
  const videoMetadata = [];
  session.on('mediaReady', (p) => mediaReady.push(p));
  session.on('videoMetadata', (p) => videoMetadata.push(p));
  const connectP = session.connect();
  await delay(20);
  videoEl.fireCanPlay(); // canplay only — loadedmetadata never fires
  await connectP;
  assert.deepEqual(mediaReady, [{ mode: 'video', videoWidth: 0, videoHeight: 0 }], 'mediaReady still fires, unlike videoMetadata, so a spinner is never stuck on a slow/absent decoder');
  assert.equal(videoMetadata.length, 0, "'videoMetadata' correctly never fires without loadedmetadata");
  session.disconnect();
});

test("emits 'mediaReady' with {mode:'video', videoWidth:0, videoHeight:0} even when videoEl is omitted (headless video mode)", async () => {
  const { session, socket } = newSession({ videoEl: null });
  scriptHappyPath(socket);
  const mediaReady = [];
  session.on('mediaReady', (p) => mediaReady.push(p));
  await session.connect();
  assert.deepEqual(mediaReady, [{ mode: 'video', videoWidth: 0, videoHeight: 0 }], 'mediaReady is mode-agnostic and must not depend on videoEl the way videoMetadata does');
  assert.equal(session.mode, 'video');
  session.disconnect();
});

test("emits 'mediaReady' with {mode:'audio'} immediately on audio-only fallback — no 'videoMetadata' wait needed", async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket, { audioMode: true });
  const mediaReady = [];
  const videoMetadata = [];
  session.on('mediaReady', (p) => mediaReady.push(p));
  session.on('videoMetadata', (p) => videoMetadata.push(p));
  await session.connect();
  assert.deepEqual(mediaReady, [{ mode: 'audio' }]);
  assert.equal(videoMetadata.length, 0, "'videoMetadata' never fires in audio-only mode — that's the gap mediaReady closes");
  assert.equal(session.mode, 'audio');
  assert.equal(session.state, 'connected');
  session.disconnect();
});

test("regression: 'streamReady' still fires at Step 1, before 'mediaReady' resolves either branch", async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: false });
  const { session, socket } = newSession({ videoEl });
  scriptHappyPath(socket);
  const order = [];
  session.on('streamReady', (p) => order.push({ event: 'streamReady', payload: p }));
  session.on('mediaReady', (p) => order.push({ event: 'mediaReady', payload: p }));
  const connectP = session.connect();
  await delay(20);
  videoEl.fireLoadedMetadata(960, 540);
  videoEl.fireCanPlay();
  await connectP;
  assert.equal(order.length, 2);
  assert.equal(order[0].event, 'streamReady');
  assert.ok(order[0].payload.finalUrl, "'streamReady' payload unchanged");
  assert.equal(order[1].event, 'mediaReady');
  session.disconnect();
});

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// The dead-air masking contract ('thinking…' affordance).
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

// ─── §4a.3: silent-empty-turn diagnostic (allow_client_variables gate OFF produces
// an empty turn with NO error; this warning is the only surface) ───

async function connectWithVars(vars) {
  const { session, socket } = newSession(vars ? { cfg: { requestVars: vars } } : {});
  scriptHappyPath(socket);
  await session.connect();
  const warnings = [];
  session.on('warning', (w) => warnings.push(w));
  return { session, socket, warnings };
}

test("empty turn while request variables are in play → one 'warning' with code empty_turn_with_request_vars, var KEYS only", async () => {
  const { session, socket, warnings } = await connectWithVars({ page_context: '{"page":"pricing"}', tier: 'gold' });
  socket.server('agent_start_speech', { isNewTurn: true, speechId: 's1', turnId: 't1' });
  socket.server('agent_end_turn', { speechId: 's1', turnId: 't1' });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'empty_turn_with_request_vars');
  assert.deepEqual([...warnings[0].requestVarKeys].sort(), ['page_context', 'tier']);
  const dump = JSON.stringify(warnings);
  assert.ok(!dump.includes('pricing') && !dump.includes('gold'), 'variable VALUES never leak into the warning');
  session.disconnect();
});

test('the warning fires at most once per session (dedup across duplicate end events and later empty turns)', async () => {
  const { session, socket, warnings } = await connectWithVars({ tier: 'gold' });
  socket.server('agent_start_speech', { isNewTurn: true, speechId: 's1' });
  // Real CM can fire BOTH end events for one turn.
  socket.server('agent_end_turn', { speechId: 's1' });
  socket.server('stvFinishedGenerating', { speechId: 's1' });
  // A second fully empty turn.
  socket.server('agent_start_speech', { isNewTurn: true, speechId: 's2' });
  socket.server('agent_end_turn', { speechId: 's2' });
  assert.equal(warnings.length, 1);
  session.disconnect();
});

test('a turn with perceivable output never warns (spoken segment path)', async () => {
  const { session, socket, warnings } = await connectWithVars({ tier: 'gold' });
  socket.server('agent_start_speech', { isNewTurn: true, speechId: 's1' });
  socket.server('agent_raw_text', { speechId: 's1', delta: JSON.stringify({ type: 'text', content: 'Here you go.' }) });
  await delay(0);   // agent_raw_text handler is async
  socket.server('agent_end_turn', { speechId: 's1' });
  assert.deepEqual(warnings, []);
  session.disconnect();
});

test('a turn where the avatar started talking never warns (stvStartedTalking path)', async () => {
  const { session, socket, warnings } = await connectWithVars({ tier: 'gold' });
  socket.server('agent_start_speech', { isNewTurn: true, speechId: 's1' });
  socket.server('stvStartedTalking', {});
  socket.server('stvFinishedGenerating', { speechId: 's1' });
  assert.deepEqual(warnings, []);
  session.disconnect();
});

test('an interrupted turn never warns (barge-in is a benign empty turn)', async () => {
  const { session, socket, warnings } = await connectWithVars({ tier: 'gold' });
  socket.server('agent_start_speech', { isNewTurn: true, speechId: 's1' });
  socket.server('agentInterrupted', {});
  socket.server('agent_end_turn', { speechId: 's1' });
  assert.deepEqual(warnings, []);
  session.disconnect();
});

test('an empty turn with NO request variables never warns (nothing was sent, nothing to diagnose)', async () => {
  const { session, socket, warnings } = await connectWithVars(null);
  socket.server('agent_start_speech', { isNewTurn: true, speechId: 's1' });
  socket.server('agent_end_turn', { speechId: 's1' });
  assert.deepEqual(warnings, []);
  session.disconnect();
});

// The threadId getter — the handle another transport (KalturaChatSession /
// KalturaAgentSession) needs to continue this conversation.
test('threadId getter: reflects cfg seed immediately, captures the wire value on first delta', async () => {
  const seeded = newSession({ cfg: { threadId: 'seed-9' } });
  assert.equal(seeded.session.threadId, 'seed-9', 'seed visible before connect');

  const { session, socket } = newSession();
  assert.equal(session.threadId, undefined);
  scriptHappyPath(socket);
  await session.connect();
  socket.server('agent_raw_text', { delta: JSON.stringify({ type: 'text', content: 'hi', threadId: 't-wire-1' }) });
  assert.equal(session.threadId, 't-wire-1');
  socket.server('agent_raw_text', { delta: JSON.stringify({ type: 'text', content: 'more', threadId: 't-other' }) });
  assert.equal(session.threadId, 't-wire-1', 'first capture wins');
  session.disconnect();
});
