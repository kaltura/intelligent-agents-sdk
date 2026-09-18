// KalturaAvatarSession's STV pc.ontrack emits 'track', the
// same shape KalturaScriptedVideoSession already emits, with or without a
// videoEl, and without disturbing the existing srcObject/play() attach path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor, fakeGetUserMedia } from '../fakes/rtc.js';

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
    mediaStreamConstructor: FakeMediaStreamCtor,
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

test('regression: both downlink tracks land on videoEl (one srcObject write, one play()), neither clobbers the other', async () => {
  const { session, socket, videoEl } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  assert.ok(videoEl.srcObject, 'srcObject assigned from the STV stream');
  assert.deepEqual(videoEl.srcObject.getTracks().map((t) => t.kind).sort(), ['audio', 'video'], 'videoEl carries both tracks');
  assert.equal(videoEl.srcObjectAssignments, 1, 'srcObject is set once per connect, not once per track');
  assert.equal(videoEl.playCount, 1, 'play() is called once per connect, not once per track');
  assert.equal(session.audioEl, null, 'no SDK-created audio element in the default mode');
  assert.deepEqual(session.avatarStream.getTracks().map((t) => t.kind).sort(), ['audio', 'video']);
  session.disconnect();
});

test('regression: both tracks land on videoEl even when audio arrives first (the exact clobbering bug reported)', async () => {
  const { session, socket, videoEl } = newSession();
  scriptHappyPath(socket);
  // FakeRTCPeerConnection.setRemoteDescription always fires video then audio — swap
  // fireTrack's kind for this one test to reproduce the reversed-order arrival that
  // triggers the clobbering bug in the old (unfixed) code.
  const origFireTrack = FakeRTCPeerConnection.prototype.fireTrack;
  FakeRTCPeerConnection.prototype.fireTrack = function (kind = 'video') {
    origFireTrack.call(this, kind === 'video' ? 'audio' : 'video');
  };
  try {
    await session.connect();
  } finally {
    FakeRTCPeerConnection.prototype.fireTrack = origFireTrack;
  }
  assert.deepEqual(videoEl.srcObject.getTracks().map((t) => t.kind).sort(), ['audio', 'video'], 'videoEl must hold both tracks regardless of arrival order');
  assert.equal(videoEl.srcObjectAssignments, 1);
  session.disconnect();
});

test('cfg.audioEl splits the audio track onto its own element; both bindings survive disconnect()', async () => {
  const audioEl = new FakeVideoEl({ autoCanPlay: true });
  const { session, socket, videoEl } = newSession({ cfg: { audioEl } });
  scriptHappyPath(socket);
  await session.connect();
  assert.deepEqual(videoEl.srcObject.getTracks().map((t) => t.kind), ['video']);
  assert.deepEqual(audioEl.srcObject.getTracks().map((t) => t.kind), ['audio']);
  assert.equal(session.audioEl, audioEl);
  assert.equal(videoEl.playCount, 1); assert.equal(audioEl.playCount, 1);
  session.disconnect();
  assert.equal(videoEl.srcObject, null); assert.equal(audioEl.srcObject, null);
  assert.equal(session.audioEl, audioEl); assert.equal(session.videoEl, videoEl);
});

test('disconnect() stops both downlink tracks, clears srcObject, and leaves the element binding in place', async () => {
  const { session, socket, videoEl } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const tracks = videoEl.srcObject.getTracks();
  session.disconnect();
  assert.ok(tracks.every((t) => t.readyState === 'ended'), 'both tracks are stopped on teardown');
  assert.equal(videoEl.srcObject, null);
  assert.equal(session.avatarStream, null);
  assert.equal(session.videoEl, videoEl);
});

test('a stale STV peer (closed by disconnect) firing ontrack does not touch the element or emit track', async () => {
  const { session, socket, videoEl } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const pc = FakeRTCPeerConnection.instances.find((p) => p.transceivers.some((t) => t.kind === 'video' && t.direction === 'recvonly'));
  session.disconnect();
  const writes = videoEl.srcObjectAssignments;
  let tracks = 0;
  session.on('track', () => tracks++);
  pc.fireTrack('video');
  assert.equal(videoEl.srcObjectAssignments, writes);
  assert.equal(tracks, 0);
  assert.equal(session.avatarStream, null);
});

test("an attach() failure surfaces as a 'media_attach_failed' warning and 'track' still fires", async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  const warnings = [], tracks = [];
  session.on('warning', (w) => warnings.push(w));
  session.on('track', (t) => tracks.push(t));
  const pcs = FakeRTCPeerConnection.instances;
  const origFireTrack = FakeRTCPeerConnection.prototype.fireTrack;
  FakeRTCPeerConnection.prototype.fireTrack = function (kind) { origFireTrack.call(this, kind, { track: { kind: 'data', id: 'bogus' } }); };
  try { await session.connect(); } finally { FakeRTCPeerConnection.prototype.fireTrack = origFireTrack; }
  assert.ok(pcs.length > 0);
  assert.equal(warnings.filter((w) => w.code === 'media_attach_failed').length, 2, 'one warning per bad track');
  assert.equal(warnings[0].kind, 'data');
  assert.equal(typeof warnings[0].message, 'string');
  assert.ok(/bad_request|track\.kind/.test(warnings[0].detail));
  assert.equal(tracks.length, 2, "'track' still fires so the app can render by hand");
  assert.equal(session.state, 'connected');
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

test("regression: a failed WHEP handshake never fires 'mediaReady' later from the hard-cap timer", { timeout: 15000 }, async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: false });
  const failingFetch = async () => ({ ok: false, status: 503, text: async () => '', headers: { get: () => null } });
  const { session, socket } = newSession({ videoEl, fetch: failingFetch });
  scriptHappyPath(socket);
  const mediaReady = [];
  session.on('mediaReady', (p) => mediaReady.push(p));
  await assert.rejects(() => session.connect());
  assert.equal(session.state, 'error');
  await delay(6500); // past the 6s hard-cap the leaked timer used to fire on
  assert.equal(mediaReady.length, 0, "cancelPlayable() must clear the hard-cap timer so it can't fire mediaReady on a session that already failed");
});

test("regression: disconnect() mid-connect (WHEP succeeded, no canplay yet) cancels the pending hard-cap timer, not just the peer connection", { timeout: 15000 }, async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: false });
  const { session, socket } = newSession({ videoEl });
  scriptHappyPath(socket);
  const mediaReady = [];
  session.on('mediaReady', (p) => mediaReady.push(p));
  const connectP = session.connect();
  await delay(20); // past the WHEP handshake and pc.ontrack; canplay/hard-cap still pending
  session.disconnect();
  await connectP.catch(() => {}); // pre-existing, out-of-scope gap: connect() doesn't abort on a concurrent disconnect()
  await delay(6500); // past the 6s hard-cap the leaked timer used to fire on
  assert.equal(mediaReady.length, 0, '_teardownTransports() must cancel _connectStv()\'s pending hard-cap timer so it can\'t fire mediaReady on an already-disconnected session');
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

// ─── speak() timing: held only while the server runs a turn typed text cannot interrupt
// (opening line after connect()/resume(), server check-in/goodbye); sent now otherwise ───

/** Typed texts that reached the wire (the empty isSpeechStart marker rows are filtered out). */
const sentTexts = (socket) => socket.emitsOf('onTextEntered').filter((p) => p.text !== '').map((p) => p.text);
const markerCount = (socket) => socket.emitsOf('onTextEntered').filter((p) => p.text === '').length;
/** speak() awaits its guardrail before it decides to hold or send; one macrotask lets that settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

async function connectAndFinishOpening(socket, session) {
  scriptHappyPath(socket);
  await session.connect();
  socket.server('stvStartedTalking', {});
  socket.server('stvFinishedTalking', { agentContent: '' });
}

test('speak() right after connect() is held until the opening line finishes, then sent (resolves true)', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  // connect() resolved, but the opening turn's stvStartedTalking hasn't arrived yet: `speaking`
  // is still false, yet text sent now would be dropped by the server. speak() must hold it.
  assert.equal(session.speaking, false);
  let result;
  const p = session.speak('[SESSION START] begin now').then((sent) => { result = sent; });
  await settle();
  assert.equal(socket.didEmit('onTextEntered'), false, 'must not send while the opening line is committed');
  socket.server('stvStartedTalking', {});
  socket.server('stvFinishedTalking', { agentContent: '' });
  await p;
  assert.equal(result, true);
  assert.deepEqual(sentTexts(socket), ['[SESSION START] begin now']);
  session.disconnect();
});

test('speak() sends immediately once the opening line has finished', async () => {
  const { session, socket } = newSession();
  await connectAndFinishOpening(socket, session);
  assert.equal(await session.speak('are you still there?'), true);
  assert.deepEqual(sentTexts(socket), ['are you still there?']);
  session.disconnect();
});

test('several speak() calls during the hold go out as ONE turn, one text per line, in call order', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const all = Promise.all([session.speak('a'), session.speak('b'), session.speak('c')]);
  await settle();
  assert.equal(socket.didEmit('onTextEntered'), false);
  socket.server('stvStartedTalking', {});
  socket.server('stvFinishedTalking', { agentContent: '' });
  assert.deepEqual(await all, [true, true, true]);
  assert.deepEqual(sentTexts(socket), ['a\nb\nc'], 'one coalesced turn, not three');
  assert.equal(markerCount(socket), 1, 'one isSpeechStart marker for the one turn');
  session.disconnect();
});

test('held text goes out before avatarStopTalking fires, and a speak() from inside that listener is sent, not held', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const p = session.speak('held');
  await settle();
  let seenAtStop;
  session.on('avatarStopTalking', () => { seenAtStop = sentTexts(socket).slice(); session.speak('from listener'); });
  socket.server('stvStartedTalking', {});
  socket.server('stvFinishedTalking', { agentContent: '' });
  await p;
  await settle();   // let the listener's own speak() finish its guardrail await
  assert.deepEqual(seenAtStop, ['held']);
  assert.deepEqual(sentTexts(socket), ['held', 'from listener']);
  session.disconnect();
});

test('agentInterrupted also ends the hold', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const p = session.speak('[NAV] moved to slide 3');
  await settle();
  socket.server('agentInterrupted', {});
  assert.equal(await p, true);
  assert.deepEqual(sentTexts(socket), ['[NAV] moved to slide 3']);
  session.disconnect();
});

test('speak() while the agent talks a normal reply is sent now (barge-in), never held', async () => {
  const { session, socket } = newSession();
  await connectAndFinishOpening(socket, session);
  socket.server('agentTurnToTalk', { userTranscription: 'tell me more' });
  socket.server('stvStartedTalking', {});
  assert.equal(session.speaking, true);
  assert.equal(await session.speak('[NAV] moved to slide 2'), true);
  assert.deepEqual(sentTexts(socket), ['[NAV] moved to slide 2']);
  assert.equal(markerCount(socket), 1, 'the marker is what stops the avatar mid-sentence');
  session.disconnect();
});

test("speak() during the server's own check-in turn is held until that turn ends", async () => {
  const { session, socket } = newSession();
  await connectAndFinishOpening(socket, session);
  socket.server('generatingSpeech', { text: 'Are you still there?', speechId: 'abcd-wake-up' });
  socket.server('stvStartedTalking', {});
  const p = session.speak('yes, still here');
  await settle();
  assert.deepEqual(sentTexts(socket), [], 'held: the check-in turn drops typed text');
  socket.server('stvFinishedTalking', { agentContent: 'Are you still there?' });
  assert.equal(await p, true);
  assert.deepEqual(sentTexts(socket), ['yes, still here']);
  session.disconnect();
});

test('disconnect() while text is held resolves it false and never sends it', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const p = session.speak('never sent');
  await new Promise((r) => setTimeout(r, 0));   // the text is now held (past the guardrail await)
  session.disconnect();
  assert.equal(await p, false);
  assert.deepEqual(sentTexts(socket), []);
  assert.equal(session.speaking, false);
});

test('disconnect() in the same tick as speak() resolves false instead of throwing on a dead socket', async () => {
  const { session, socket } = newSession();
  await connectAndFinishOpening(socket, session);
  const p = session.speak('never sent');
  session.disconnect();
  assert.equal(await p, false);
  assert.deepEqual(sentTexts(socket), []);
});

test('guardrails still run at call time for a held speak()', async () => {
  const { session, socket } = newSession({ cfg: { onBeforeSend: (t) => (t.includes('secret') ? false : t.toUpperCase()) } });
  scriptHappyPath(socket);
  await session.connect();
  await assert.rejects(session.speak('my secret'), (e) => e.code === 'guardrail_blocked');
  const p = session.speak('hello');
  socket.server('stvStartedTalking', {});
  socket.server('stvFinishedTalking', { agentContent: '' });
  assert.equal(await p, true);
  assert.deepEqual(sentTexts(socket), ['HELLO']);
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
  // The real server can fire BOTH end events for one turn.
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
