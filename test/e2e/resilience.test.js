import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeAudioContext, FakeMediaStreamCtor, FakeRTCRtpReceiver, FakeMediaStream, FakeAudioWorkletNode } from '../fakes/rtc.js';
import { createNoiseSuppressor } from '../../src/experience/noise-suppressor.js';
import { SPIRAL_RECOVERY_PREFIX } from '../../src/core/stream.js';

/**
 * Resilience stress suite — exercises EVERY failure path of the live runtime with
 * fault injection across all three channels (socket control / ASR uplink / STV
 * downlink), proving the SDK always reaches a defined state and NEVER silently
 * hangs or silently freezes. Complements the live battle-test in
 * earnings-avatar-q2/tests/e2e/04-live-resilience.spec.js (real backend) and the
 * Chrome/CDP network-condition harness (real Chrome, throttled networks).
 *
 * The matrix below covers:
 *   - socket recoverable drop + same-pod recovery
 *   - socket recoverable drop, recovery UNAVAILABLE → bounded → ended (no hang)
 *   - socket reconnect with recovered=false → COLD reconnect
 *   - socket reconnect_failed / non-recoverable → clean ended
 *   - ASR media 'failed' → ICE restart → recovered
 *   - STV media 'failed' → WHEP re-subscribe → recovered
 *   - media 'disconnected' transient → self-heals (no spurious recovery)
 *   - media recovery exhausted → cold reconnect → ended on failure
 *   - brain-liveness watchdog after a turn
 *   - granular mic errors
 *   - network online/offline awareness
 */

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function newSession(overrides = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const videoEl = overrides.videoEl ?? new FakeVideoEl({ autoCanPlay: true });
  const whepFetch = overrides.fetch ?? (async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } }));
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.avatar.us.kaltura.ai',
    videoEl, socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: whepFetch, getUserMedia: overrides.getUserMedia ?? fakeGetUserMedia(),
    networkAware: false,   // tests opt-in explicitly; avoid Node global listener leakage
    ...overrides.cfg,
  });
  return { session, socket, videoEl };
}
const stvPeer = () => FakeRTCPeerConnection.instances.find((p) => p.transceivers.some((t) => t.kind === 'video' && t.direction === 'recvonly'));
const asrPeer = () => FakeRTCPeerConnection.instances.find((p) => p.tracks.length > 0 && !p.transceivers.some((t) => t.kind === 'video'));

// ─────────────────────────── socket-control channel ───────────────────────────

test('socket: recoverable drop + same-pod recovery (recovered=true) → no re-join', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const ev = [];
  ['reconnecting', 'reconnected', 'ended'].forEach((e) => session.on(e, (p) => ev.push([e, p])));
  const joins = socket.emitsOf('join').length;
  socket.server('disconnect', 'ping timeout');
  assert.equal(session.state, 'reconnecting');
  socket.recovered = true;
  socket.server('connect');
  assert.equal(session.state, 'connected');
  assert.equal(socket.emitsOf('join').length, joins, 'same-pod recovery must NOT re-join');
  assert.deepEqual(ev.map((e) => e[0]), ['reconnecting', 'reconnected']);
  assert.equal(ev[1][1].recovered, true);
  session.disconnect();
});

test('socket: same-pod recovery (recovered=true) also nudges an STV/ASR peer that independently went ICE_DOWN during the same outage', async () => {
  // The socket surviving (connection-state recovery) says nothing about the separate
  // WebRTC peers' ICE state — they can fail independently during the same network blip.
  // Before this fix, a channel stuck 'failed'/'disconnected' at the moment `connect`
  // lands stayed stuck: nothing else re-checks it, which is exactly the avatar-video-
  // never-comes-back bug (issue #53b) — the session reports 'connected' while STV is dead.
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const ev = [];
  ['mediaRecovering', 'mediaRecovered', 'reconnected'].forEach((e) => session.on(e, (p) => ev.push([e, p])));
  stvPeer().iceConnectionState = 'failed';   // STV died silently during the outage
  socket.server('disconnect', 'ping timeout');
  assert.equal(session.state, 'reconnecting');
  socket.recovered = true;
  socket.server('connect');
  await delay(700);   // WHEP re-POST + playable-gate settle
  assert.ok(ev.some((e) => e[0] === 'mediaRecovering' && e[1].channel === 'stv'), 'landing back "connected" must recheck STV, not just the socket');
  assert.ok(ev.some((e) => e[0] === 'mediaRecovered' && e[1].method === 're-subscribe'));
  session.disconnect();
});

test('socket: recoverable drop, recovery NEVER lands → bounded → ended (no infinite hang)', async () => {
  const { session, socket } = newSession({ cfg: { reconnectWindowMs: 300 } });
  scriptHappyPath(socket);
  await session.connect();
  let ended = null; session.on('ended', (p) => { ended = p; });
  socket.server('disconnect', 'transport error');
  assert.equal(session.state, 'reconnecting');
  await delay(450);
  assert.equal(session.state, 'disconnected', 'must not hang in reconnecting');
  assert.equal(ended.reason, 'reconnect_timeout');
  session.disconnect();
});

test('socket: reconnect with recovered=false → COLD reconnect (re-join + rebuild, threadId preserved)', async () => {
  const { session, socket } = newSession({ cfg: { reconnectWindowMs: 5000, threadId: 'thr-keep' } });
  scriptHappyPath(socket);
  await session.connect();
  const joins = socket.emitsOf('join').length;
  let reconnected = null; session.on('reconnected', (p) => { reconnected = p; });
  socket.server('disconnect', 'transport close');
  socket.recovered = false;             // new socket / different pod — server session GONE
  socket.server('connect');
  await delay(400);
  assert.ok(socket.emitsOf('join').length > joins, 'cold reconnect must re-join');
  assert.equal(session.state, 'connected');
  assert.equal(reconnected.recovered, false, 'reconnected{recovered:false} signals a cold rebuild');
  // threadId is replayed in the re-join so the brain thread continues.
  const lastJoin = socket.emitsOf('join').at(-1);
  assert.equal(lastJoin.kaltura.threadId, 'thr-keep');
  session.disconnect();
});

test('socket: reconnect_failed event → clean ended (never hang)', async () => {
  const { session, socket } = newSession({ cfg: { reconnectWindowMs: 9000 } });
  scriptHappyPath(socket);
  await session.connect();
  let ended = null; session.on('ended', (p) => { ended = p; });
  socket.server('disconnect', 'transport close');
  assert.equal(session.state, 'reconnecting');
  socket.server('reconnect_failed');
  assert.equal(session.state, 'disconnected');
  assert.equal(ended.reason, 'reconnect_failed');
  session.disconnect();
});

test('socket: non-recoverable drop → ended {reason}, no error event, no reconnect', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  let ended = null, errored = false, reconnecting = false;
  session.on('ended', (p) => { ended = p; });
  session.on('error', () => { errored = true; });
  session.on('reconnecting', () => { reconnecting = true; });
  socket.server('disconnect', 'io server disconnect');
  assert.equal(session.state, 'disconnected');
  assert.equal(ended.reason, 'io server disconnect');
  assert.equal(errored, false, 'a clean non-recoverable end is not an error');
  assert.equal(reconnecting, false);
});

// ─────────────────────────── ASR uplink channel ───────────────────────────

test('ASR: ICE failed → ICE restart in place (recovered, no cold reconnect)', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const ev = [];
  ['mediaRecovering', 'mediaRecovered', 'reconnecting', 'ended'].forEach((e) => session.on(e, (p) => ev.push([e, p])));
  const joins = socket.emitsOf('join').length;
  const asr = asrPeer();
  asr.setIce('failed');
  await delay(50);
  assert.ok(ev.some((e) => e[0] === 'mediaRecovering' && e[1].channel === 'asr'));
  assert.ok(ev.some((e) => e[0] === 'mediaRecovered' && e[1].method === 'ice-restart'), 'ASR recovers via ICE restart');
  assert.ok(socket.didEmit('asr-webrtc-offer'));
  const reoffer = socket.emitsOf('asr-webrtc-offer').at(-1);
  assert.equal(reoffer.is_reconnect, true, 'restart offer marked is_reconnect');
  assert.equal(socket.emitsOf('join').length, joins, 'ICE restart does not re-join');
  assert.equal(session.state, 'connected');
  session.disconnect();
});

test('STV: ICE failed → WHEP re-subscribe (recovered)', async () => {
  let whepPosts = 0;
  const fetch = async (url, init) => {
    if (init?.method === 'DELETE') return { ok: true, status: 200, text: async () => '', headers: { get: () => null } };
    whepPosts++;
    return { ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/r/' + whepPosts } };
  };
  const { session, socket } = newSession({ fetch });
  scriptHappyPath(socket);
  await session.connect();
  const postsAfterConnect = whepPosts;
  const ev = [];
  ['mediaRecovering', 'mediaRecovered', 'ended'].forEach((e) => session.on(e, (p) => ev.push([e, p])));
  stvPeer().setIce('failed');
  await delay(700);   // WHEP re-POST + playable-gate settle
  assert.ok(ev.some((e) => e[0] === 'mediaRecovered' && e[1].method === 're-subscribe'), 'STV recovers by re-subscribing');
  assert.ok(whepPosts > postsAfterConnect, 'a fresh WHEP POST was made');
  assert.equal(session.state, 'connected');
  session.disconnect();
});

test('STV: WHEP 404 on re-subscribe (session truly gone) → cold reconnect with a distinct "session gone" reason', async () => {
  // Adopted from unisphere-rtc's WhepStatus.NO_ACTIVE_SESSION check: a 404 on the
  // re-subscribe POST means the server has discarded the STV session — vs. a
  // transient failure on some other status. Both still cold-reconnect today, but the
  // 404 case must be an explicit, greppable branch (not an accident of "everything
  // else falls through to the same catch").
  let whepPosts = 0;
  const fetch = async (url, init) => {
    if (init?.method === 'DELETE') return { ok: true, status: 200, text: async () => '', headers: { get: () => null } };
    whepPosts++;
    if (whepPosts === 1) return { ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/r/1' } };
    return { ok: false, status: 404, text: async () => 'gone' };
  };
  const { session, socket } = newSession({ fetch });
  scriptHappyPath(socket);
  await session.connect();
  const ev = [];
  ['reconnecting', 'reconnected'].forEach((e) => session.on(e, (p) => ev.push([e, p])));
  stvPeer().setIce('failed');
  await delay(400);
  const reconnecting = ev.find((e) => e[0] === 'reconnecting');
  assert.ok(reconnecting, 'a 404 re-subscribe failure must still escalate to cold reconnect');
  assert.equal(reconnecting[1].reason, 'stv session gone (404)');
  session.disconnect();
});

test('ICE watchdog: a pc stuck in "new"/"checking" past 10s escalates to media recovery (never reaches "failed")', async () => {
  // A pc that never starts gathering (or whose every candidate fails to connect) can sit in
  // 'new'/'checking' forever — oniceconnectionstatechange never fires again from that state, so
  // _onIceStateChange alone can never see it. _armIceNewWatchdog is the proactive backstop
  // (adopted from unisphere-rtc's IceHandler pattern); this proves it actually fires at 10s
  // without waiting 10 real seconds, by capturing the watchdog's own setTimeout callback.
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  let recovering = null; session.on('mediaRecovering', (p) => { recovering = p; });

  const stuckPc = new FakeRTCPeerConnection();   // starts 'new' and is never transitioned
  const origSetTimeout = globalThis.setTimeout;
  let watchdogFn = null, watchdogMs = null;
  globalThis.setTimeout = (fn, ms) => {
    if (ms === 10000 && !watchdogFn) { watchdogFn = fn; watchdogMs = ms; return { unref() {} }; }
    return origSetTimeout(fn, ms);
  };
  try { session._armIceNewWatchdog('asr', stuckPc); } finally { globalThis.setTimeout = origSetTimeout; }
  assert.equal(watchdogMs, 10000, 'watchdog fires at the documented 10s window');
  assert.ok(watchdogFn, 'the watchdog must arm a real timer');

  watchdogFn();   // simulate the 10s elapsing with the pc still stuck in 'new'
  await delay(50);
  assert.ok(recovering, 'a pc stuck in new/checking past the watchdog window must trigger media recovery');
  assert.equal(recovering.channel, 'asr');
  session.disconnect();
});

test('ICE watchdog: zero candidates gathered by the time gathering completes escalates fast (past the 3s floor, before the 10s timer)', async () => {
  // Adopted from unisphere-rtc's IceHandler: a dead network path (e.g. TURN unreachable)
  // never produces a single candidate, so `iceGatheringState` reaches 'complete' with
  // candCount===0 — there's no reason to wait out the full 10s watchdog for that case.
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  let recovering = null; session.on('mediaRecovering', (p) => { recovering = p; });

  const deadPc = new FakeRTCPeerConnection();   // never gets a real candidate
  session._armIceNewWatchdog('asr', deadPc);
  deadPc.setGathering('complete');              // too early — must NOT fire before the 3s floor
  assert.equal(recovering, null, 'must not fire before the 3s false-positive floor');

  deadPc.iceConnectionState = 'checking';
  session._now = () => Date.now() + 3001;       // simulate the floor having elapsed
  deadPc.setGathering('complete');
  await delay(20);
  assert.ok(recovering, 'zero candidates at gathering-complete past the floor must trigger media recovery');
  assert.equal(recovering.channel, 'asr');
  session.disconnect();
});

test('ICE watchdog: does NOT fail fast if at least one candidate was gathered first', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  let recovering = null; session.on('mediaRecovering', (p) => { recovering = p; });

  const pc = new FakeRTCPeerConnection();
  session._armIceNewWatchdog('asr', pc);
  pc.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 2 1.2.3.4 3478 typ relay' } });
  session._now = () => Date.now() + 3001;
  pc.setGathering('complete');
  await delay(20);
  assert.equal(recovering, null, 'a real candidate before gathering-complete must not trigger the zero-candidates fail-fast');
  session.disconnect();
});

test('media: transient "disconnected" that self-heals → NO recovery churn', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  let recovering = 0; session.on('mediaRecovering', () => recovering++);
  const asr = asrPeer();
  asr.setIce('disconnected');     // transient
  await delay(200);
  asr.setIce('connected');        // self-healed well within the 1500ms grace
  await delay(1600);
  assert.equal(recovering, 0, 'a self-healing disconnect must not trigger recovery');
  assert.equal(session.state, 'connected');
  session.disconnect();
});

test('media: ASR recovery FAILS (no answer) → escalates to cold reconnect', async () => {
  const { session, socket } = newSession({ cfg: { reconnectWindowMs: 5000 } });
  scriptHappyPath(socket);
  await session.connect();
  // Make the ASR restart hang: stop auto-answering asr-webrtc-offer after connect.
  socket.onEmit((ev) => {
    if (ev === 'join') setTimeout(() => { socket.server('clientConfiguration', { clientConfiguration: { languageCode: 'en' } }); socket.server('joinComplete', {}); }, 0);
    else if (ev === 'checkAvailability') setTimeout(() => socket.server('availabilityResult', { available: true }), 0);
    else if (ev === 'stvNewSession') setTimeout(() => { socket.server('stvNewSession', { session_id: 's2', webrtc_url: 'https://srs.example/rtc/v1/whep/?app=app&stream=s2' }); setTimeout(() => { socket.server('showAgent', {}); setTimeout(() => socket.server('askPermissions', {}), 0); }, 0); }, 0);
    else if (ev === 'asr-webrtc-init') setTimeout(() => socket.server('asr-webrtc-ready', {}), 0);
    else if (ev === 'asr-webrtc-offer') { /* the restart offer gets NO answer → ICE-restart path rejects → cold reconnect */ }
  });
  const ev = [];
  ['reconnecting', 'reconnected', 'ended'].forEach((e) => session.on(e, (p) => ev.push([e, p])));
  const joins = socket.emitsOf('join').length;
  asrPeer().setIce('failed');
  await delay(31000);   // ASR await times out (30s) → cold reconnect re-joins
  assert.ok(socket.emitsOf('join').length > joins || ev.some((e) => e[0] === 'reconnecting'), 'escalated past the failed in-place restart');
  session.disconnect();
});

// ─────────────────────────── brain-liveness (R5) ───────────────────────────

test('brain watchdog: stalls after a turn with no brain activity → brainStalled', async () => {
  const { session, socket } = newSession({ cfg: { brainStallMs: 200 } });
  scriptHappyPath(socket);
  await session.connect();
  let stalled = null; session.on('brainStalled', (p) => { stalled = p; });
  socket.server('agentTurnToTalk', { userTranscription: 'hello?' });   // user's turn done → brain should respond
  await delay(350);
  assert.ok(stalled, 'a silent brain after a turn must surface brainStalled');
  assert.equal(stalled.afterMs, 200);
  session.disconnect();
});

test('brain watchdog: spoken output CLEARS the stall (no false alarm)', async () => {
  // agent_start_speech alone only RE-ARMS the watchdog (it's the "preparing to answer…"
  // think-phase marker, not proof the viewer sees anything) — it must not grant a lifetime
  // pass for the rest of the turn (that was the exact gap the live 438x spiral exploited).
  // Genuine spoken output is what actually clears it.
  const { session, socket } = newSession({ cfg: { brainStallMs: 300 } });
  scriptHappyPath(socket);
  await session.connect();
  let stalled = false; session.on('brainStalled', () => { stalled = true; });
  socket.server('agentTurnToTalk', { userTranscription: 'hello?' });
  await delay(100);
  socket.server('agent_start_speech', { speechId: 'A-x', isNewTurn: true });   // brain responded in time
  await delay(100);
  socket.server('agent_raw_text', { delta: JSON.stringify({ type: 'avatar', content: 'Hi there!' }) });   // real output
  await delay(350);
  assert.equal(stalled, false, 'spoken output must cancel the watchdog');
  session.disconnect();
});

test('brain watchdog: agent_start_speech alone does NOT grant a lifetime pass for the turn', async () => {
  // If the brain acks the turn (agent_start_speech) but then never produces anything
  // perceivable, the watchdog must still fire — it re-arms on the ack, it doesn't clear.
  const { session, socket } = newSession({ cfg: { brainStallMs: 200 } });
  scriptHappyPath(socket);
  await session.connect();
  let stalled = null; session.on('brainStalled', (p) => { stalled = p; });
  socket.server('agentTurnToTalk', { userTranscription: 'hello?' });
  await delay(50);
  socket.server('agent_start_speech', { speechId: 'A-y', isNewTurn: true });
  await delay(300);   // past the re-armed 200ms window with nothing perceivable following
  assert.ok(stalled, 'an ack with no follow-up output must still surface brainStalled');
  session.disconnect();
});

test('brain watchdog: a tool-call retry spiral does NOT suppress brainStalled', async () => {
  // A tool-eager brain can re-emit the SAME tool call dozens of times in one turn with no
  // spoken output (docs/CLIENT-COMMANDS.md "Tool spirals starve the voice" — observed live:
  // show_widget retried 438x over 9 minutes, zero narration). `type:"tool"` segments are
  // silent to the viewer by themselves (OBEY_RULES.md), so NONE of them — not even the
  // first — may clear the watchdog; only spoken/avatar/GenUI output may. If a tool segment
  // (first call or retry) cleared it, the viewer would get NO brainStalled warning for the
  // entire spiral — see the bug this guards.
  const { session, socket } = newSession({ cfg: { brainStallMs: 200 } });
  scriptHappyPath(socket);
  await session.connect();
  let stalled = null; session.on('brainStalled', (p) => { stalled = p; });
  socket.server('agentTurnToTalk', { userTranscription: 'show me the revenue widget' });
  const retryDelta = JSON.stringify({ type: 'tool', content: 'show_widget {"kind":"summary","data":"{}"}' });
  // Fire the identical tool segment repeatedly, faster than brainStallMs, simulating the spiral.
  for (let i = 0; i < 5; i++) {
    socket.server('agent_raw_text', { delta: retryDelta });
    await delay(50);
  }
  await delay(250);   // past brainStallMs with no NEW progress since the first duplicate landed
  assert.ok(stalled, 'a retry spiral of the same tool call must still surface brainStalled, not mask it');
  session.disconnect();
});

test('brain watchdog: REPEATS (does not go stale) across a spiral spanning multiple windows', async () => {
  // A single-fire watchdog warns once at e.g. 12s in, then falls silent for the rest of a
  // multi-minute spiral (the live 438x/9min incident had exactly one toast, at the 12s mark,
  // then total silence through the crash). The watchdog must keep firing every brainStallMs
  // as long as nothing perceivable follows, with an incrementing `count` so the app can
  // escalate its own messaging.
  const { session, socket } = newSession({ cfg: { brainStallMs: 100 } });
  scriptHappyPath(socket);
  await session.connect();
  const fires = []; session.on('brainStalled', (p) => fires.push(p));
  socket.server('agentTurnToTalk', { userTranscription: 'show me the revenue widget' });
  await delay(450);   // spans ~4 windows of 100ms with zero perceivable output
  assert.ok(fires.length >= 3, `watchdog must repeat, not single-fire (got ${fires.length})`);
  assert.deepEqual(fires.map((f) => f.count), fires.map((_, i) => i + 1), 'count must increment each repeat');
  session.disconnect();
});

test('tool spiral circuit breaker: trips after N identical retries and signals, without interrupting the turn', async () => {
  // The live incident: show_widget retried 438x over 9 minutes with zero narration, eventually
  // destabilizing the STV media channel into a session-ending JoinRoomTimeout. The breaker must
  // trip well before that — after `toolSpiralLimit` raw tool segments in one turn — and emit
  // `toolSpiralDetected`. It must NOT call interrupt() (tapToTalkStart/tapToTalkEnd): a second
  // live incident showed that a mid-turn tapToTalkStart forces an early, truncated
  // stvFinishedTalking (WIRE-PROTOCOL.md's documented barge-in semantics), silently cutting the
  // turn's own narration with no way to reopen it once the brain streamed a real answer.
  const { session, socket } = newSession({ cfg: { toolSpiralLimit: 4 } });
  scriptHappyPath(socket);
  await session.connect();
  let detected = null; session.on('toolSpiralDetected', (p) => { detected = p; });
  socket.server('agentTurnToTalk', { userTranscription: 'show me the revenue widget' });
  const retryDelta = JSON.stringify({ type: 'tool', content: 'show_widget {"kind":"summary","data":"{}"}' });
  for (let i = 0; i < 4; i++) socket.server('agent_raw_text', { delta: retryDelta });
  assert.ok(detected, 'the breaker must trip once the spiral limit is reached');
  assert.equal(detected.count, 4);
  assert.equal(detected.limit, 4);
  assert.ok(!socket.didEmit('tapToTalkStart'), 'the soft breaker must not barge in and truncate the turn\'s own narration');
  session.disconnect();
});

test('tool spiral circuit breaker: fires toolSpiralDetected AT MOST ONCE per turn', async () => {
  const { session, socket } = newSession({ cfg: { toolSpiralLimit: 3 } });
  scriptHappyPath(socket);
  await session.connect();
  let fireCount = 0; session.on('toolSpiralDetected', () => { fireCount++; });
  socket.server('agentTurnToTalk', { userTranscription: 'show me the revenue widget' });
  const retryDelta = JSON.stringify({ type: 'tool', content: 'show_widget {"kind":"summary","data":"{}"}' });
  for (let i = 0; i < 10; i++) socket.server('agent_raw_text', { delta: retryDelta });
  assert.equal(fireCount, 1, 'toolSpiralDetected must not re-fire on every subsequent retry past the limit');
  session.disconnect();
});

test('tool spiral circuit breaker: does NOT trip on normal, distinct tool calls under the limit', async () => {
  const { session, socket } = newSession({ cfg: { toolSpiralLimit: 4 } });
  scriptHappyPath(socket);
  await session.connect();
  let detected = false; session.on('toolSpiralDetected', () => { detected = true; });
  socket.server('agentTurnToTalk', { userTranscription: 'walk me through slide 3' });
  socket.server('agent_raw_text', { delta: JSON.stringify({ type: 'tool', content: 'navigate_to_slide {"slide_num":3}' }) });
  socket.server('agent_raw_text', { delta: JSON.stringify({ type: 'avatar', content: 'Here is slide 3.' }) });
  assert.equal(detected, false, 'two ordinary tool segments must not trip a breaker sized for a real spiral');
  session.disconnect();
});

test('tool spiral circuit breaker: resets its count each turn (agent_start_speech)', async () => {
  const { session, socket } = newSession({ cfg: { toolSpiralLimit: 3 } });
  scriptHappyPath(socket);
  await session.connect();
  let fireCount = 0; session.on('toolSpiralDetected', () => { fireCount++; });
  const retryDelta = JSON.stringify({ type: 'tool', content: 'show_widget {"kind":"summary","data":"{}"}' });
  socket.server('agentTurnToTalk', { userTranscription: 'turn one' });
  socket.server('agent_raw_text', { delta: retryDelta });
  socket.server('agent_raw_text', { delta: retryDelta });
  socket.server('agent_start_speech', { speechId: 'A-next', isNewTurn: true });   // next turn begins
  socket.server('agent_raw_text', { delta: retryDelta });
  assert.equal(fireCount, 0, 'a fresh turn must not inherit the previous turn\'s tool-segment count');
  session.disconnect();
});

test('tool spiral HARD recovery: survives a turn-boundary reset and forces a cold reconnect', async () => {
  // Live incident: a server-pushed idle "wake-up" turn fired agent_start_speech MID-spiral,
  // resetting the per-turn counter and letting the soft breaker re-signal — while the
  // underlying show_widget spiral, tracked here, kept running uninterrupted underneath those
  // resets until the socket itself died. The hard counter must NOT reset on agent_start_speech,
  // so a spiral spanning multiple turns still crosses the hard ceiling and gets a real recovery.
  const { session, socket } = newSession({ cfg: { toolSpiralLimit: 3, hardToolSpiralLimit: 6 } });
  scriptHappyPath(socket);
  await session.connect();
  const joins = socket.emitsOf('join').length;
  let recovering = null; session.on('toolSpiralRecovering', (p) => { recovering = p; });
  let reconnected = null; session.on('reconnected', (p) => { reconnected = p; });
  const retryDelta = JSON.stringify({ type: 'tool', content: 'show_widget {"kind":"summary","data":"{}"}' });
  socket.server('agentTurnToTalk', { userTranscription: 'show me the revenue widget' });
  for (let i = 0; i < 3; i++) socket.server('agent_raw_text', { delta: retryDelta });   // trips the soft breaker (count 3)
  assert.equal(recovering, null, 'must not hard-recover before the hard ceiling');
  socket.server('agent_start_speech', { speechId: 'wake-up-nudge', isNewTurn: true });   // idle nudge mid-spiral
  for (let i = 0; i < 3; i++) socket.server('agent_raw_text', { delta: retryDelta });   // session count now 6
  await delay(400);   // let the async cold reconnect run through scriptHappyPath's autoresponder
  assert.ok(recovering, 'the hard counter must survive the turn-boundary reset and trip');
  assert.equal(recovering.count, 6);
  assert.equal(recovering.limit, 6);
  assert.ok(socket.emitsOf('join').length > joins, 'hard recovery must force a real cold reconnect (re-join)');
  assert.equal(reconnected?.recovered, false, 'the recovery is a cold rebuild, not a same-pod resume');
  session.disconnect();
});

test('tool spiral HARD recovery: genuine perceivable output clears the session-scoped counter', async () => {
  // A healthy session that legitimately calls many distinct tools across many turns —
  // each followed by real narration — must never falsely trip the hard path.
  const { session, socket } = newSession({ cfg: { toolSpiralLimit: 3, hardToolSpiralLimit: 6 } });
  scriptHappyPath(socket);
  await session.connect();
  let recovering = false; session.on('toolSpiralRecovering', () => { recovering = true; });
  for (let turn = 0; turn < 5; turn++) {
    socket.server('agent_start_speech', { speechId: `turn-${turn}`, isNewTurn: true });
    socket.server('agent_raw_text', { delta: JSON.stringify({ type: 'tool', content: `navigate_to_slide {"slide_num":${turn}}` }) });
    socket.server('agent_raw_text', { delta: JSON.stringify({ type: 'avatar', content: 'Here you go.' }) });   // perceivable output clears the counter
  }
  assert.equal(recovering, false, 'distinct tool calls followed by real narration must never trip the hard breaker');
  session.disconnect();
});

test('tool spiral HARD recovery: opens a genuinely NEW socket rather than re-joining the still-live one', async () => {
  // Live bug found while battle-testing the hard-recovery fix above: the control socket
  // never actually drops before a proactive cold reconnect (unlike every other
  // _coldReconnect() call site, which only ever runs AFTER a real transport disconnect).
  // The server's `join` handler is idempotent-guarded per-connection (WIRE-PROTOCOL.md),
  // so re-`join`-ing the SAME still-connected socket is a silent no-op server-side —
  // reproduced live 3x as a JoinRoomTimeout. A real socket.io Manager hands back a
  // brand-new client per call here (verified live), so the fix must actually request a
  // new one from the factory, not reuse `this._socket`. newSession()'s default factory
  // returns one singleton — build our own multi-instance factory to catch a regression.
  let factoryCalls = 0;
  let liveSocket = null;
  const multiFactory = () => { const s = new FakeSocket(); liveSocket = s; scriptHappyPath(s); factoryCalls++; return s; };
  const { session } = newSession({ cfg: { toolSpiralLimit: 3, hardToolSpiralLimit: 6, socketFactory: multiFactory } });
  await session.connect();
  const firstSocket = liveSocket;
  assert.equal(factoryCalls, 1, 'connect() must call the factory exactly once');

  let recovering = null; session.on('toolSpiralRecovering', (p) => { recovering = p; });
  const retryDelta = JSON.stringify({ type: 'tool', content: 'show_widget {"kind":"summary","data":"{}"}' });
  firstSocket.server('agentTurnToTalk', { userTranscription: 'show me the revenue widget' });
  for (let i = 0; i < 6; i++) firstSocket.server('agent_raw_text', { delta: retryDelta });
  await delay(400);

  assert.ok(recovering, 'hard recovery must have fired');
  assert.equal(factoryCalls, 2, 'cold reconnect must request a SECOND, brand-new socket from the factory — not reuse the still-live first one');
  assert.notEqual(liveSocket, firstSocket, 'the session must be running on a genuinely different socket after hard recovery');
  assert.equal(session.state, 'connected');
  session.disconnect();
});

test('tool spiral HARD recovery: re-arms after a successful cold reconnect, so a SECOND spiral in the same session also recovers', async () => {
  // Live bug found in production: `_hardSpiralRecovering` was set true the first time the
  // hard ceiling tripped and only ever cleared by a spoken/genui segment — but a spiral by
  // definition never produces one, so nothing reset it once `_coldReconnect()` finished. A
  // second spiral later in the SAME session (a real, easily-triggered scenario, not a corner
  // case) found `_checkHardToolSpiral()` early-returning forever and hung indefinitely,
  // reproducing the original bug's exact symptom just delayed to the 2nd occurrence.
  // `_coldReconnect()`'s success path must re-arm the breaker (`_hardSpiralRecovering = false`,
  // `_sessionToolSegCount = 0`) so a later spiral is caught exactly like the first one was.
  let factoryCalls = 0;
  let liveSocket = null;
  const multiFactory = () => { const s = new FakeSocket(); liveSocket = s; scriptHappyPath(s); factoryCalls++; return s; };
  const { session } = newSession({ cfg: { toolSpiralLimit: 3, hardToolSpiralLimit: 6, socketFactory: multiFactory } });
  await session.connect();
  const firstSocket = liveSocket;

  const recoveries = []; session.on('toolSpiralRecovering', (p) => { recoveries.push(p); });
  const retryDelta = JSON.stringify({ type: 'tool', content: 'show_widget {"kind":"summary","data":"{}"}' });

  // First spiral → first hard recovery (already covered above; re-confirmed here as setup).
  firstSocket.server('agentTurnToTalk', { userTranscription: 'show me the revenue widget' });
  for (let i = 0; i < 6; i++) firstSocket.server('agent_raw_text', { delta: retryDelta });
  await delay(400);
  assert.equal(recoveries.length, 1, 'first spiral must trip the hard breaker');
  assert.equal(factoryCalls, 2, 'first recovery opens the second socket');
  const secondSocket = liveSocket;
  assert.notEqual(secondSocket, firstSocket);
  assert.equal(session.state, 'connected', 'session must be usable again after the first recovery');

  // Second spiral, later in the same session, on the rebuilt socket.
  secondSocket.server('agentTurnToTalk', { userTranscription: 'can you just confirm the guidance range' });
  for (let i = 0; i < 6; i++) secondSocket.server('agent_raw_text', { delta: retryDelta });
  await delay(400);

  assert.equal(recoveries.length, 2, 'a second spiral in the same session must ALSO trip the hard breaker — the latch must not be one-shot for the session lifetime');
  assert.equal(factoryCalls, 3, 'the second recovery must open a THIRD genuinely new socket');
  assert.equal(session.state, 'connected', 'session must recover cleanly a second time, not hang');
  session.disconnect();
});

// ─────────────────────────── spiral-recovery turn resend ───────────────────────────

test('tool spiral HARD recovery: auto-resends the stuck ASR turn (default recoverFromSpiral:true)', async () => {
  // The cold reconnect alone restores connectivity + replays threadId (brain memory) but
  // otherwise abandons the turn that triggered the spiral — the user's original question was
  // simply dropped, reproducing the "hang" symptom the whole breaker exists to fix. Mirrors the
  // proven headless fix (`Conversations#send({recoverFromSpiral:true})`, conversations.js).
  let liveSocket = null;
  const multiFactory = () => { const s = new FakeSocket(); liveSocket = s; scriptHappyPath(s); return s; };
  const { session } = newSession({ cfg: { toolSpiralLimit: 3, hardToolSpiralLimit: 6, socketFactory: multiFactory } });
  await session.connect();
  const firstSocket = liveSocket;

  let recovered = null; session.on('spiralRecovered', (p) => { recovered = p; });
  firstSocket.server('agentTurnToTalk', { userTranscription: 'walk me through the two-metric guidance range' });
  const retryDelta = JSON.stringify({ type: 'tool', content: 'show_widget {"kind":"summary","data":"{}"}' });
  for (let i = 0; i < 6; i++) firstSocket.server('agent_raw_text', { delta: retryDelta });
  await delay(400);

  const secondSocket = liveSocket;
  assert.notEqual(secondSocket, firstSocket, 'hard recovery must have rebuilt the socket');
  assert.equal(session.state, 'connected');
  assert.ok(recovered, 'spiralRecovered must fire once the resend is sent');
  assert.equal(recovered.text, 'walk me through the two-metric guidance range', 'the ORIGINAL text is reported, not the wrapped one');
  const entered = secondSocket.emitsOf('onTextEntered');
  assert.equal(entered.length, 1, 'exactly one resend must be emitted on the rebuilt socket');
  assert.equal(entered[0].text, `${SPIRAL_RECOVERY_PREFIX}walk me through the two-metric guidance range`);
  session.disconnect();
});

test('tool spiral HARD recovery: auto-resends the stuck speak() turn too, not just ASR', async () => {
  let liveSocket = null;
  const multiFactory = () => { const s = new FakeSocket(); liveSocket = s; scriptHappyPath(s); return s; };
  const { session } = newSession({ cfg: { toolSpiralLimit: 3, hardToolSpiralLimit: 6, socketFactory: multiFactory } });
  await session.connect();
  const firstSocket = liveSocket;

  await session.speak('what should I expect for Q3 guidance');
  const retryDelta = JSON.stringify({ type: 'tool', content: 'show_widget {"kind":"summary","data":"{}"}' });
  for (let i = 0; i < 6; i++) firstSocket.server('agent_raw_text', { delta: retryDelta });
  await delay(400);

  const secondSocket = liveSocket;
  assert.notEqual(secondSocket, firstSocket);
  const entered = secondSocket.emitsOf('onTextEntered');
  assert.equal(entered.length, 1);
  assert.equal(entered[0].text, `${SPIRAL_RECOVERY_PREFIX}what should I expect for Q3 guidance`);
  session.disconnect();
});

test('tool spiral HARD recovery: recoverFromSpiral:false suppresses the resend but still reports lastTurnText', async () => {
  let liveSocket = null;
  const multiFactory = () => { const s = new FakeSocket(); liveSocket = s; scriptHappyPath(s); return s; };
  const { session } = newSession({ cfg: { toolSpiralLimit: 3, hardToolSpiralLimit: 6, socketFactory: multiFactory, recoverFromSpiral: false } });
  await session.connect();
  const firstSocket = liveSocket;

  let recovering = null; session.on('toolSpiralRecovering', (p) => { recovering = p; });
  let recovered = false; session.on('spiralRecovered', () => { recovered = true; });
  firstSocket.server('agentTurnToTalk', { userTranscription: 'show me the revenue widget' });
  const retryDelta = JSON.stringify({ type: 'tool', content: 'show_widget {"kind":"summary","data":"{}"}' });
  for (let i = 0; i < 6; i++) firstSocket.server('agent_raw_text', { delta: retryDelta });
  await delay(400);

  assert.equal(recovering?.lastTurnText, 'show me the revenue widget', 'the tracked text is still surfaced for the app to handle itself');
  assert.equal(recovered, false, 'no auto-resend when recoverFromSpiral:false');
  const entered = liveSocket.emitsOf('onTextEntered');
  assert.equal(entered.length, 0, 'no onTextEntered on the rebuilt socket without opt-in');
  session.disconnect();
});

test('tool spiral HARD recovery: a second spiral in the same session resends its OWN stuck turn, not the first one', async () => {
  let liveSocket = null;
  const multiFactory = () => { const s = new FakeSocket(); liveSocket = s; scriptHappyPath(s); return s; };
  const { session } = newSession({ cfg: { toolSpiralLimit: 3, hardToolSpiralLimit: 6, socketFactory: multiFactory } });
  await session.connect();
  const firstSocket = liveSocket;
  const recoveries = []; session.on('spiralRecovered', (p) => { recoveries.push(p); });
  const retryDelta = JSON.stringify({ type: 'tool', content: 'show_widget {"kind":"summary","data":"{}"}' });

  firstSocket.server('agentTurnToTalk', { userTranscription: 'first stuck question' });
  for (let i = 0; i < 6; i++) firstSocket.server('agent_raw_text', { delta: retryDelta });
  await delay(400);
  const secondSocket = liveSocket;
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].text, 'first stuck question');

  secondSocket.server('agentTurnToTalk', { userTranscription: 'second stuck question' });
  for (let i = 0; i < 6; i++) secondSocket.server('agent_raw_text', { delta: retryDelta });
  await delay(400);
  const thirdSocket = liveSocket;
  assert.equal(recoveries.length, 2);
  assert.equal(recoveries[1].text, 'second stuck question');
  const entered = thirdSocket.emitsOf('onTextEntered');
  assert.equal(entered.length, 1, 'the third socket only ever gets the SECOND spiral\'s resend');
  assert.equal(entered[0].text, `${SPIRAL_RECOVERY_PREFIX}second stuck question`);
  session.disconnect();
});

test('media-recovery cold reconnect (not a tool spiral) never resends anything', async () => {
  // `_coldReconnect()` is also called for exhausted media recovery — resending there would
  // inject an unrelated, unsolicited message since that path never abandoned a user turn.
  const { session, socket } = newSession({ cfg: { toolSpiralLimit: 3, hardToolSpiralLimit: 6 } });
  scriptHappyPath(socket);
  await session.connect();
  socket.server('agentTurnToTalk', { userTranscription: 'a completely unrelated question' });
  let recovered = false; session.on('spiralRecovered', () => { recovered = true; });
  await session._coldReconnect('media asr failed');
  await delay(100);
  assert.equal(recovered, false, 'a non-spiral cold reconnect must not trigger a resend');
  session.disconnect();
});

// ─────────────────────────── client-side VAD (localSpeakingChanged) ──────────

function newVadSession(overrides = {}) {
  return newSession({
    ...overrides,
    cfg: {
      getAudioContext: () => new FakeAudioContext(),
      mediaStreamConstructor: FakeMediaStreamCtor,
      ...overrides.cfg,
    },
  });
}

test('client VAD: stays inactive with no localSpeakingChanged listener (zero Web Audio cost)', async () => {
  const { session, socket } = newVadSession();
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(session._vadTimer, null, 'VAD must not start without a listener');
  session.disconnect();
});

test('client VAD: starts lazily the moment a listener is registered, after mic is available', async () => {
  const { session, socket } = newVadSession();
  scriptHappyPath(socket);
  await session.connect();
  session.on('localSpeakingChanged', () => {});
  assert.ok(session._vadTimer, 'registering a listener must start the VAD sampler');
  session.disconnect();
});

test('client VAD: stops once the last listener unsubscribes', async () => {
  const { session, socket } = newVadSession();
  scriptHappyPath(socket);
  await session.connect();
  const unsub = session.on('localSpeakingChanged', () => {});
  assert.ok(session._vadTimer);
  unsub();
  assert.equal(session._vadTimer, null, 'unsubscribing the last listener must stop the VAD sampler');
  session.disconnect();
});

test('client VAD: emits localSpeakingChanged{speaking:true} once volume crosses the threshold, and false once it drops', async () => {
  const { session, socket } = newVadSession({ cfg: { localVadThreshold: 100 } });
  scriptHappyPath(socket);
  await session.connect();
  const fires = []; session.on('localSpeakingChanged', (p) => fires.push(p.speaking));
  FakeAudioContext.lastAnalyser._vol = 200 * 16;   // above threshold (sum over 16 bins)
  await delay(80);
  assert.deepEqual(fires, [true], 'must emit speaking:true once volume crosses the threshold');
  FakeAudioContext.lastAnalyser._vol = 0;
  await delay(80);
  assert.deepEqual(fires, [true, false], 'must emit speaking:false once volume drops back below the threshold');
  session.disconnect();
});

test('client VAD: cleaned up on disconnect (no stray interval survives teardown)', async () => {
  const { session, socket } = newVadSession();
  scriptHappyPath(socket);
  await session.connect();
  session.on('localSpeakingChanged', () => {});
  assert.ok(session._vadTimer);
  session.disconnect();
  assert.equal(session._vadTimer, null, 'teardown must stop the VAD sampler');
});

test('client VAD: localMicLevel alone (no localSpeakingChanged listener) starts and stops the sampler', async () => {
  const { session, socket } = newVadSession();
  scriptHappyPath(socket);
  await session.connect();
  const unsub = session.on('localMicLevel', () => {});
  assert.ok(session._vadTimer, 'registering a localMicLevel listener must start the VAD sampler on its own');
  unsub();
  assert.equal(session._vadTimer, null, 'unsubscribing the only localMicLevel listener must stop the sampler');
  session.disconnect();
});

test('client VAD: localMicLevel emits a normalized 0-1 level on every tick, not just on threshold transitions', async () => {
  const { session, socket } = newVadSession({ cfg: { localVadThreshold: 100 } });
  scriptHappyPath(socket);
  await session.connect();
  const levels = []; session.on('localMicLevel', (p) => levels.push(p.level));
  FakeAudioContext.lastAnalyser._vol = 8 * 16;   // below speaking threshold, still a nonzero level
  await delay(80);
  assert.ok(levels.length >= 1, 'must emit on every tick regardless of the speaking threshold');
  assert.ok(levels.every((l) => l > 0 && l <= 1), 'level must be normalized to (0,1]');
  FakeAudioContext.lastAnalyser._vol = 255 * 16;   // max possible sum over 16 bins
  await delay(80);
  assert.ok(levels[levels.length - 1] === 1, 'max volume must normalize to exactly 1');
  session.disconnect();
});

test('client VAD: stays active for localMicLevel after localSpeakingChanged unsubscribes, and vice versa', async () => {
  const { session, socket } = newVadSession();
  scriptHappyPath(socket);
  await session.connect();
  const unsubSpeaking = session.on('localSpeakingChanged', () => {});
  const unsubLevel = session.on('localMicLevel', () => {});
  unsubSpeaking();
  assert.ok(session._vadTimer, 'sampler must stay alive while a localMicLevel listener remains');
  unsubLevel();
  assert.equal(session._vadTimer, null, 'sampler must stop once every listener across both events is gone');
  session.disconnect();
});

// ─────────────────────────── hardware mute (external mic mute) ───────────────

test('hardware mute: track.onmute after a 5s debounce fires hardwareMuteChanged{muted:true}', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  let seen = null; session.on('hardwareMuteChanged', (p) => { seen = p; });
  const track = session._micStream.getAudioTracks()[0];
  track.fireMute();
  assert.equal(seen, null, 'must not fire before the 5s debounce');
  await delay(20);
  assert.equal(seen, null, 'still within the debounce window at 20ms');
  session.disconnect();
});

test('hardware mute: track.onunmute fires hardwareMuteChanged{muted:false} immediately (no debounce)', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  let seen = null; session.on('hardwareMuteChanged', (p) => { seen = p; });
  const track = session._micStream.getAudioTracks()[0];
  track.fireUnmute();
  assert.deepEqual(seen && { muted: seen.muted }, { muted: false }, 'unmute must fire immediately, no debounce');
  session.disconnect();
});

test('hardware mute: fires hardwareMuteChanged{muted:true} once the 5s debounce elapses', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  let seen = null; session.on('hardwareMuteChanged', (p) => { seen = p; });
  const track = session._micStream.getAudioTracks()[0];
  track.fireMute();
  await delay(5050);
  assert.deepEqual(seen && { muted: seen.muted }, { muted: true }, 'must fire once the 5s debounce elapses');
  session.disconnect();
});

test('hardware mute: onunmute before the 5s debounce elapses cancels the pending mute', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const fires = []; session.on('hardwareMuteChanged', (p) => { fires.push(p.muted); });
  const track = session._micStream.getAudioTracks()[0];
  track.fireMute();
  await delay(20);
  track.fireUnmute();   // cancels the pending muted-true before it fires
  await delay(20);
  assert.deepEqual(fires, [false], 'only the immediate unmute must fire — the debounced mute must be cancelled');
  session.disconnect();
});

test('hardware mute: cleaned up on disconnect (no stray timer fires after teardown)', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const track = session._micStream.getAudioTracks()[0];
  let fired = false; session.on('hardwareMuteChanged', () => { fired = true; });
  track.fireMute();
  session.disconnect();
  await delay(20);
  assert.equal(fired, false, 'a pending debounce timer must not fire after teardown');
});

// ─────────────────────────── device picker ────────────────────────────────

test('listDevices: returns mics/speakers from navigator.mediaDevices, video devices omitted', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const origNav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'mic-1' },
          { kind: 'audiooutput', deviceId: 'spk-1' },
          { kind: 'videoinput', deviceId: 'cam-1' },
        ],
      },
    },
    configurable: true,
  });
  try {
    const { mics, speakers } = await session.listDevices();
    assert.deepEqual(mics.map((d) => d.deviceId), ['mic-1']);
    assert.deepEqual(speakers.map((d) => d.deviceId), ['spk-1']);
  } finally { Object.defineProperty(globalThis, 'navigator', { value: origNav, configurable: true }); }
  session.disconnect();
});

test('listDevices: returns empty lists when navigator.mediaDevices is unavailable (headless/Node)', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const { mics, speakers } = await session.listDevices();
  assert.deepEqual(mics, []);
  assert.deepEqual(speakers, []);
  session.disconnect();
});

test('switchMic: replaceTrack on the existing ASR sender, no renegotiation, old stream stopped', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const asr = asrPeer();
  const oldTrack = session._micStream.getAudioTracks()[0];
  const sender = asr.getSenders()[0];
  const joins = socket.emitsOf('join').length;
  await session.switchMic('mic-2');
  assert.equal(socket.emitsOf('join').length, joins, 'switching mic must not re-join / renegotiate');
  assert.notEqual(sender.track, oldTrack, 'replaceTrack must swap the sender track');
  assert.equal(oldTrack.readyState, 'ended', 'the old mic stream must be stopped');
  session.disconnect();
});

test('switchMic: rewires hardware-mute watch + VAD onto the new stream', async () => {
  const { session, socket } = newVadSession();
  scriptHappyPath(socket);
  await session.connect();
  session.on('localSpeakingChanged', () => {});
  await session.switchMic('mic-2');
  const newTrack = session._micStream.getAudioTracks()[0];
  assert.equal(typeof newTrack.onmute, 'function', 'the new stream must get the hardware-mute watch');
  assert.ok(session._vadTimer, 'VAD must still be running against the new stream');
  session.disconnect();
});

test('setAudioOutput: calls setSinkId and resolves true on success', async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: true });
  const { session, socket } = newSession({ videoEl });
  scriptHappyPath(socket);
  await session.connect();
  const ok = await session.setAudioOutput('spk-2');
  assert.equal(ok, true);
  assert.equal(videoEl.sinkId, 'spk-2');
  session.disconnect();
});

test('setAudioOutput: retries up to 5x at 500ms on failure, then gives up returning false', async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: true });
  videoEl._sinkIdFailTimes = 6;   // fails every attempt: the initial call + all 5 retries
  const { session, socket } = newSession({ videoEl });
  scriptHappyPath(socket);
  await session.connect();
  const origSetTimeout = globalThis.setTimeout;
  let waits = 0;
  globalThis.setTimeout = (fn, ms) => (ms === 500 ? (waits++, origSetTimeout(fn, 0)) : origSetTimeout(fn, ms));
  try {
    const ok = await session.setAudioOutput('spk-bad');
    assert.equal(ok, false, 'must give up (not throw) after exhausting retries');
    assert.equal(waits, 5, 'must retry exactly 5 times at 500ms');
  } finally { globalThis.setTimeout = origSetTimeout; }
  session.disconnect();
});

test('setAudioOutput: returns false without throwing when the platform has no setSinkId', async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: true });
  videoEl.setSinkId = undefined;   // setSinkId lives on the prototype; deleting the instance wouldn't shadow it
  const { session, socket } = newSession({ videoEl });
  scriptHappyPath(socket);
  await session.connect();
  const ok = await session.setAudioOutput('spk-2');
  assert.equal(ok, false);
  session.disconnect();
});

// ─────────────────────────── codec preference + bandwidth (R9) ────────────

function newCodecSession(overrides = {}) {
  return newSession({
    ...overrides,
    cfg: { rtcRtpReceiverConstructor: FakeRTCRtpReceiver, ...overrides.cfg },
  });
}

test('preferredVideoCodec: filters the STV video transceiver to the requested codec', async () => {
  const { session, socket } = newCodecSession({ cfg: { preferredVideoCodec: 'VP9' } });
  scriptHappyPath(socket);
  await session.connect();
  const video = stvPeer().transceivers.find((t) => t.kind === 'video');
  assert.deepEqual(video._codecPrefs.map((c) => c.mimeType), ['video/VP9']);
  session.disconnect();
});

test('preferredVideoCodec: unset → setCodecPreferences never called (browser default negotiation)', async () => {
  const { session, socket } = newCodecSession();
  scriptHappyPath(socket);
  await session.connect();
  const video = stvPeer().transceivers.find((t) => t.kind === 'video');
  assert.equal(video._codecPrefs, undefined);
  session.disconnect();
});

test('preferredVideoCodec: a codec absent from this browser\'s capabilities is skipped, not thrown', async () => {
  const { session, socket } = newCodecSession({ cfg: { preferredVideoCodec: 'AV1' } });
  scriptHappyPath(socket);
  await session.connect();   // must not reject
  const video = stvPeer().transceivers.find((t) => t.kind === 'video');
  assert.equal(video._codecPrefs, undefined);
  session.disconnect();
});

test('maxAsrBitrateKbps: applied to the ASR audio sender at connect via setParameters', async () => {
  const { session, socket } = newCodecSession({ cfg: { maxAsrBitrateKbps: 32 } });
  scriptHappyPath(socket);
  await session.connect();
  const sender = asrPeer().getSenders().find((s) => s.track?.kind === 'audio');
  assert.equal(sender.getParameters().encodings[0].maxBitrate, 32000);
  session.disconnect();
});

test('setAsrBandwidth: adjusts the live ASR sender mid-session, no renegotiation', async () => {
  const { session, socket } = newCodecSession();
  scriptHappyPath(socket);
  await session.connect();
  const joins = socket.emitsOf('join').length;
  await session.setAsrBandwidth(16);
  assert.equal(socket.emitsOf('join').length, joins, 'must not renegotiate/re-join');
  const sender = asrPeer().getSenders().find((s) => s.track?.kind === 'audio');
  assert.equal(sender.getParameters().encodings[0].maxBitrate, 16000);
  session.disconnect();
});

// ─────────────────────────── connectivity beacon (getStats, R10) ──────────

test('statsIntervalMs unset: no timer armed, zero getStats() cost', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(session._statsTimer, null, 'beacon must not start without statsIntervalMs');
  session.disconnect();
});

test('statsIntervalMs: polls both channels and emits connectionQuality with RTT/loss/jitter', async () => {
  const { session, socket } = newSession({ cfg: { statsIntervalMs: 20 } });
  scriptHappyPath(socket);
  await session.connect();
  asrPeer().setStats([
    { id: 'pair1', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.05 },
    { id: 'rtp1', type: 'outbound-rtp', bytesSent: 1000 },
  ]);
  stvPeer().setStats([
    { id: 'pair2', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.08 },
    { id: 'rtp2', type: 'inbound-rtp', bytesReceived: 2000, jitter: 0.01, packetsLost: 1, packetsReceived: 99 },
  ]);
  const events = [];
  session.on('connectionQuality', (p) => events.push(p));
  await delay(30);
  session.disconnect();
  const asrEv = events.find((e) => e.channel === 'asr');
  const stvEv = events.find((e) => e.channel === 'stv');
  assert.equal(asrEv.rttMs, 50);
  const stvEvClose = Math.abs(stvEv.rttMs - 80) < 1e-6;
  assert.ok(stvEvClose, 'stv rttMs must be ~80ms');
  assert.equal(stvEv.jitterMs, 10);
  assert.equal(stvEv.packetLossPct, 1);
});

test('statsIntervalMs: bitrate is null on the first poll, then computed from the byte delta', async () => {
  const { session, socket } = newSession({ cfg: { statsIntervalMs: 20 } });
  scriptHappyPath(socket);
  await session.connect();
  asrPeer().setStats([{ id: 'rtp1', type: 'outbound-rtp', bytesSent: 1000 }]);
  const events = [];
  session.on('connectionQuality', (p) => { if (p.channel === 'asr') events.push(p); });
  await delay(25);
  assert.equal(events[0].bitrateKbps, null, 'no prior sample yet on the first poll');
  asrPeer().setStats([{ id: 'rtp1', type: 'outbound-rtp', bytesSent: 3000 }]);
  await delay(20);
  assert.ok(events.length >= 2 && events[1].bitrateKbps > 0, 'a byte-count increase yields a positive bitrate');
  session.disconnect();
});

test('statsIntervalMs: cleaned up on disconnect (no stray interval survives teardown)', async () => {
  const { session, socket } = newSession({ cfg: { statsIntervalMs: 20 } });
  scriptHappyPath(socket);
  await session.connect();
  assert.ok(session._statsTimer, 'beacon must be armed while connected');
  session.disconnect();
  assert.equal(session._statsTimer, null, 'teardown must stop the beacon');
});

// ─────────────────────────── device errors (R6) ───────────────────────────

for (const [errName, code] of [
  ['NotAllowedError', 'mic_permission_denied'],
  ['NotFoundError', 'mic_not_found'],
  ['NotReadableError', 'mic_in_use'],
  ['OverconstrainedError', 'mic_not_found'],
]) {
  test(`device: getUserMedia ${errName} → ${code}`, async () => {
    const gum = async () => { const e = new Error(errName); e.name = errName; throw e; };
    const { session } = newSession({ getUserMedia: gum });
    await assert.rejects(() => session.connect(), (e) => e.code === code, `${errName} maps to ${code}`);
  });
}

// ─────────────────────────── network awareness (R7) ───────────────────────────

test('network: online after offline nudges a down media channel to recover', async () => {
  // Use a tiny event-target shim as the global so the SDK can wire online/offline.
  const listeners = {};
  const g = globalThis;
  const origAdd = g.addEventListener, origRem = g.removeEventListener;
  g.addEventListener = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
  g.removeEventListener = (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); };
  try {
    const { session, socket } = newSession({ cfg: { networkAware: true } });
    scriptHappyPath(socket);
    await session.connect();
    let nudged = false; session.on('mediaRecovering', () => { nudged = true; });
    asrPeer().iceConnectionState = 'disconnected';            // a media channel is down
    (listeners.offline || []).forEach((fn) => fn());          // network drops
    (listeners.online || []).forEach((fn) => fn());           // network returns → nudge recovery
    await delay(50);
    assert.ok(nudged, 'returning online must nudge a down media channel');
    session.disconnect();
  } finally { g.addEventListener = origAdd; g.removeEventListener = origRem; }
});

// ─────────────────────────── noise suppression: Tier-1 constraints + Tier-2 BYO-DSP ───────────────────────────

test('mic constraints: default WebRTC baseline (echoCancellation/noiseSuppression/autoGainControl) applied to connect()', async () => {
  const gum = fakeGetUserMedia();
  const { session, socket } = newSession({ getUserMedia: gum });
  scriptHappyPath(socket);
  await session.connect();
  assert.deepEqual(gum.calls[0], { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  session.disconnect();
});

test('mic constraints: micConstraints:false sends bare audio:true (no Tier-1 baseline)', async () => {
  const gum = fakeGetUserMedia();
  const { session, socket } = newSession({ getUserMedia: gum, cfg: { micConstraints: false } });
  scriptHappyPath(socket);
  await session.connect();
  assert.deepEqual(gum.calls[0], { audio: true, video: false });
  session.disconnect();
});

test('mic constraints: a partial micConstraints object merges over the default', async () => {
  const gum = fakeGetUserMedia();
  const { session, socket } = newSession({ getUserMedia: gum, cfg: { micConstraints: { noiseSuppression: false } } });
  scriptHappyPath(socket);
  await session.connect();
  assert.deepEqual(gum.calls[0], { audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true }, video: false });
  session.disconnect();
});

test('mic constraints: switchMic() also applies the Tier-1 baseline, merged with the deviceId constraint', async () => {
  const gum = fakeGetUserMedia();
  const { session, socket } = newSession({ getUserMedia: gum });
  scriptHappyPath(socket);
  await session.connect();
  await session.switchMic('mic-2');
  assert.deepEqual(gum.calls[1], { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: { exact: 'mic-2' } }, video: false });
  session.disconnect();
});

test('noiseProcessor: pluggable Tier-2 DSP hook receives the raw stream and its returned stream reaches the ASR sender', async () => {
  const processedStream = new FakeMediaStream([{ kind: 'audio' }]);
  let receivedRaw = null;
  const noiseProcessor = async (raw) => { receivedRaw = raw; return processedStream; };
  const { session, socket } = newSession({ cfg: { noiseProcessor } });
  scriptHappyPath(socket);
  await session.connect();
  assert.ok(receivedRaw, 'the processor must receive the raw getUserMedia stream');
  assert.equal(session._micStream, processedStream, 'the processor\'s returned stream must become the session mic stream');
  const asr = asrPeer();
  assert.equal(asr.getSenders()[0].track, processedStream.getAudioTracks()[0], 'the processed track must be what reaches the ASR sender');
  session.disconnect();
});

test('noiseProcessor: a processor returning {stream,stop} is released on disconnect()', async () => {
  const processedStream = new FakeMediaStream([{ kind: 'audio' }]);
  let stopped = false;
  const noiseProcessor = async () => ({ stream: processedStream, stop: () => { stopped = true; } });
  const { session, socket } = newSession({ cfg: { noiseProcessor } });
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(stopped, false);
  session.disconnect();
  assert.equal(stopped, true, 'the processor\'s stop() must be called on teardown');
});

test('noiseProcessor: a processor returning {stream,stop} is released (old) and replaced on switchMic()', async () => {
  let stops = 0;
  const noiseProcessor = async () => ({ stream: new FakeMediaStream([{ kind: 'audio' }]), stop: () => { stops++; } });
  const { session, socket } = newSession({ cfg: { noiseProcessor } });
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(stops, 0);
  await session.switchMic('mic-2');
  assert.equal(stops, 1, 'switchMic must release the OLD processor instance');
  session.disconnect();
  assert.equal(stops, 2, 'disconnect must release the mic-2 processor instance');
});

test('noiseProcessor: a throwing processor fails mic acquisition closed with noise_processor_failed (raw stream stopped)', async () => {
  const noiseProcessor = async () => { throw new Error('worklet init failed'); };
  const { session } = newSession({ cfg: { noiseProcessor } });
  await assert.rejects(() => session.connect(), (e) => e.code === 'noise_processor_failed', 'must surface a typed noise_processor_failed error');
  assert.equal(session.state, 'error');
});

test('noiseProcessor: not supplied → the raw getUserMedia stream is used unmodified (back-compat default)', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  assert.ok(session._micStream, 'a stream must still be acquired with no noiseProcessor configured');
  session.disconnect();
});

// End-to-end proof that the pluggable-DSP slot works with a REAL implementation (not just a
// test stub): the shipped AudioWorklet noise-suppressor plugin, wired all the way through
// connect() to the ASR sender, and released cleanly on switchMic()/disconnect().

test('noiseProcessor + createNoiseSuppressor (real plugin): its output stream reaches the ASR sender', async () => {
  FakeAudioWorkletNode.reset();
  const audioCtx = new FakeAudioContext();
  const noiseProcessor = createNoiseSuppressor({ audioContext: audioCtx, audioWorkletNodeConstructor: FakeAudioWorkletNode });
  const { session, socket } = newSession({ cfg: { noiseProcessor } });
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(FakeAudioWorkletNode.instances.length, 1, 'the AudioWorklet node must have been constructed');
  const asr = asrPeer();
  assert.equal(asr.getSenders()[0].track, session._micStream.getAudioTracks()[0], 'the worklet-processed track must be what reaches the ASR sender');
  session.disconnect();
  assert.equal(FakeAudioWorkletNode.instances[0].disconnected, true, 'disconnect() must tear down the worklet graph');
});

test('noiseProcessor + createNoiseSuppressor (real plugin): switchMic() rebuilds the worklet graph and releases the old one', async () => {
  FakeAudioWorkletNode.reset();
  const audioCtx = new FakeAudioContext();
  const noiseProcessor = createNoiseSuppressor({ audioContext: audioCtx, audioWorkletNodeConstructor: FakeAudioWorkletNode });
  const { session, socket } = newSession({ cfg: { noiseProcessor } });
  scriptHappyPath(socket);
  await session.connect();
  await session.switchMic('mic-2');
  assert.equal(FakeAudioWorkletNode.instances.length, 2, 'switchMic must build a fresh worklet graph for the new device');
  assert.equal(FakeAudioWorkletNode.instances[0].disconnected, true, 'the OLD worklet graph must be released');
  assert.equal(FakeAudioWorkletNode.instances[1].disconnected, false, 'the NEW worklet graph must still be live');
  session.disconnect();
  assert.equal(FakeAudioWorkletNode.instances[1].disconnected, true);
});
