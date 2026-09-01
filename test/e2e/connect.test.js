import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession, KalturaAgentSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia } from '../fakes/rtc.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

function newSession(overrides = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const videoEl = overrides.videoEl ?? new FakeVideoEl({ autoCanPlay: true });
  const whepFetch = overrides.fetch ?? (async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } }));
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.avatar.us.kaltura.ai',
    videoEl, socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: whepFetch, getUserMedia: overrides.getUserMedia ?? fakeGetUserMedia(),
    ...overrides.cfg,
  });
  return { session, socket, videoEl };
}

test('happy path: connects, emits disclosure, approves after video playable', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  const events = [];
  ['streamReady', 'disclosure', 'capacityChanged'].forEach((e) => session.on(e, (p) => events.push([e, p])));
  await session.connect();
  assert.equal(session.state, 'connected');
  // documented connect emits all happened, in order
  assert.ok(socket.didEmit('join'));
  assert.ok(socket.didEmit('stvNewSession'));
  assert.ok(socket.didEmit('asr-webrtc-init'));
  assert.ok(socket.didEmit('asr-webrtc-offer'));
  assert.ok(socket.didEmit('approvedPermissions'), 'must approve to start greeting');
  // disclosure fired (EU AI Act)
  assert.ok(events.some(([e]) => e === 'disclosure'));
  // never defaulted cast_mode to webrtc (the stvNewSession emit carries only room_id)
  assert.ok(!('cast_mode' in socket.emitsOf('stvNewSession')[0]), 'never defaults cast_mode');
  session.disconnect();
});

test('greeting-clip fix: approvedPermissions waits for video canplay', async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: false }); // not playable yet
  const { session, socket } = newSession({ videoEl });
  scriptHappyPath(socket);
  const connectP = session.connect();
  // Give the machine time to reach the STV gate; it must NOT have approved yet.
  await delay(50);
  assert.equal(socket.didEmit('approvedPermissions'), false, 'must not approve before video is playable');
  videoEl.fireCanPlay();                       // now playable
  await connectP;
  assert.ok(socket.didEmit('approvedPermissions'), 'approves once playable (+300ms settle)');
  session.disconnect();
});

test('capacity: emits stvNewSession promptly AND checkAvailability in parallel, connects', async () => {
  // The runtime answers stvNewSession directly; many agents never send
  // availabilityResult. So the SDK emits stvNewSession right away (don't gate the
  // whole connect on a poll that may never reply) while still polling capacity in
  // parallel for capacity-aware servers. Verified live: this is what advances the
  // real handshake (stvNewSession → showAgent → askPermissions).
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(session.state, 'connected');
  assert.ok(socket.didEmit('stvNewSession'), 'stvNewSession emitted to create the avatar session');
  assert.ok(socket.didEmit('checkAvailability'), 'checkAvailability still emitted in parallel');
  assert.ok(socket.connected, 'socket stays connected');
  session.disconnect();
});

test('capacity: throwToNoAgent surfaces a retryable capacity_unavailable error', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket, { noCapacity: true });
  await assert.rejects(() => session.connect(), (e) => e.code === 'capacity_unavailable');
});

test('audio/phone mode: skips WHEP/video, still connects via ASR', async () => {
  const { session, socket } = newSession({ videoEl: null });
  scriptHappyPath(socket, { audioMode: true });
  await session.connect();
  assert.equal(session.mode, 'audio');
  assert.equal(session.state, 'connected');
  assert.equal(FakeRTCPeerConnection.instances.length, 1, 'only the ASR peer (no STV)');
  session.disconnect();
});

test('mic denied → mic_permission_denied', async () => {
  const { session, socket } = newSession({ getUserMedia: fakeGetUserMedia({ deny: true }) });
  scriptHappyPath(socket);
  await assert.rejects(() => session.connect(), (e) => e.code === 'mic_permission_denied');
});

test('post-connect: speak injects onTextEntered (brain), never HTTP converse', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  await session.speak('hello there');
  const te = socket.emitsOf('onTextEntered');
  assert.equal(te[0].isSpeechStart, true, 'the isSpeechStart marker opens/interrupts first');
  const final = te.pop();
  assert.equal(final.text, 'hello there');
  assert.equal(final.isFinal, true);
  session.disconnect();
});

test('post-connect: setDynamicPrompt / notifyHtmlElementClick / submitStructuredDataForm emit documented events', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  session.setDynamicPrompt({ current_slide: 5, title: 'Revenue' });
  session.notifyHtmlElementClick({ htmlText: 'press release' });
  session.submitStructuredDataForm({ message: 'me@firm.com' });
  // setDynamicPrompt is sugar over request_vars: it rides updateGenieContext as
  // the page_context var, ALWAYS alongside the session's own capabilities (the
  // server replaces stored context wholesale — a bare {request_vars} emit would
  // wipe them; regression for the capabilities-preservation invariant).
  assert.equal(socket.didEmit('setDynamicPrompt'), false, 'legacy setDynamicPrompt wire event is never emitted');
  assert.deepEqual(socket.emitsOf('updateGenieContext')[0], {
    capabilities: { avatar: 'on', generate_followup_questions: 'on' },
    request_vars: { page_context: JSON.stringify({ current_slide: 5, title: 'Revenue' }) },
  });
  assert.deepEqual(socket.emitsOf('onHtmlElementClick')[0], { htmlText: 'press release' });
  assert.deepEqual(socket.emitsOf('setFormLeadInfo')[0], { message: 'me@firm.com' });
  // these are CONTEXT, not speech — must not emit onTextEntered
  assert.equal(socket.didEmit('onTextEntered'), false);
  session.disconnect();
});

test('setDynamicPrompt before connect throws invalid_state', () => {
  const { session } = newSession();
  assert.throws(() => session.setDynamicPrompt({ a: 1 }), (e) => e.code === 'invalid_state');
});

test('request_vars merge: updateRequestVars deltas and setDynamicPrompt page_context coexist in one canonical map', async () => {
  const { session, socket } = newSession({ cfg: { requestVars: { user_name: 'Ada' } } });
  scriptHappyPath(socket);
  await session.connect();
  session.setDynamicPrompt({ slide: 2 });
  session.updateRequestVars({ tier: 'gold' });
  // The second emit still carries page_context (merge, not reset) AND the
  // join-time var AND capabilities.
  assert.deepEqual(socket.emitsOf('updateGenieContext').pop(), {
    capabilities: { avatar: 'on', generate_followup_questions: 'on' },
    request_vars: { user_name: 'Ada', page_context: JSON.stringify({ slide: 2 }), tier: 'gold' },
  });
  // Overwriting page_context via setDynamicPrompt keeps the other vars.
  session.setDynamicPrompt({ slide: 3 });
  assert.deepEqual(socket.emitsOf('updateGenieContext').pop().request_vars, { user_name: 'Ada', page_context: JSON.stringify({ slide: 3 }), tier: 'gold' });
  session.disconnect();
});

test('barge-in: interrupted event flips speaking + transcript drops stale chunks', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const transcripts = [];
  session.on('transcript', (t) => transcripts.push(t));
  // utterance A starts and speaks a chunk
  socket.server('agent_start_speech', { speechId: 'A-transcript-hi', turnId: 't1', isNewTurn: true });
  socket.server('stvStartedTalking', {});
  socket.server('stvSpeechChunk', { text: 'Adaptive', durationMs: 200, speechId: 'A-transcript-hi' });
  assert.equal(session.speaking, true);
  // user barges in → new utterance B
  socket.server('agentInterrupted', {});
  assert.equal(session.speaking, false);
  socket.server('agent_start_speech', { speechId: 'B-transcript-stop', turnId: 't2', isNewTurn: true });
  // a LATE chunk from A must be dropped (no transcript for it)
  const before = transcripts.length;
  socket.server('stvSpeechChunk', { text: 'late-from-A', durationMs: 200, speechId: 'A-transcript-hi' });
  assert.equal(transcripts.length, before, 'stale chunk dropped');
  // a chunk from B flows
  socket.server('stvSpeechChunk', { text: 'Sure', durationMs: 200, speechId: 'B-transcript-stop' });
  assert.ok(transcripts.some((t) => t.text === 'Sure'));
  session.disconnect();
});

test('barge-in: speak() while the avatar is already talking uses the isSpeechStart marker, never tapToTalkStart/End', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  socket.server('agent_start_speech', { speechId: 'A-transcript-hi', turnId: 't1', isNewTurn: true });
  socket.server('stvStartedTalking', {});
  assert.equal(session.speaking, true);
  await session.speak('what about Q3');
  assert.equal(socket.didEmit('tapToTalkStart'), false, 'tapToTalkStart mints a duplicate session-server turn');
  assert.equal(socket.didEmit('tapToTalkEnd'), false);
  const te = socket.emitsOf('onTextEntered');
  assert.deepEqual(te[0], { text: '', isFinal: false, isSpeechStart: true });
  assert.deepEqual(te.pop(), { text: 'what about Q3', isFinal: true });
  session.disconnect();
});

test('interrupt() sends only the isSpeechStart marker, no tapToTalkStart/End', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  session.interrupt();
  assert.equal(socket.didEmit('tapToTalkStart'), false);
  assert.equal(socket.didEmit('tapToTalkEnd'), false);
  assert.deepEqual(socket.emitsOf('onTextEntered'), [{ text: '', isFinal: false, isSpeechStart: true }]);
  session.disconnect();
});

// ─────────────────────────── Tap-to-talk ────────────────────────
// startTapToTalk() requires clientConfiguration.isTapToTalk:true — an open-mic agent's
// VAD turn-cutting is never suppressed by tapped mode, so mixing the two races shared
// conversation state server-side. Tests below opt a session into tap-to-talk mode via
// scriptHappyPath's clientConfig override.

function newTapToTalkSession(overrides = {}) {
  const s = newSession(overrides);
  scriptHappyPath(s.socket, { clientConfig: { isTapToTalk: true, interruptionsEnabled: true }, ...overrides.script });
  return s;
}

test('tap-to-talk: startTapToTalk/endTapToTalk emit the documented wire pair and app events', async () => {
  const { session, socket } = newTapToTalkSession();
  await session.connect();
  const events = [];
  session.on('tapToTalkStarted', () => events.push('started'));
  session.on('tapToTalkEnded', () => events.push('ended'));
  assert.equal(session.tapToTalkActive, false);
  session.startTapToTalk();
  assert.equal(session.tapToTalkActive, true);
  assert.deepEqual(socket.emitsOf('tapToTalkStart'), [{}]);
  session.endTapToTalk();
  assert.equal(session.tapToTalkActive, false);
  assert.deepEqual(socket.emitsOf('tapToTalkEnd'), [{}]);
  assert.deepEqual(events, ['started', 'ended']);
  // never bracketed with the typed-text isSpeechStart marker (stays isolated)
  assert.equal(socket.didEmit('onTextEntered'), false);
  session.disconnect();
});

test('tap-to-talk: startTapToTalk throws capability_disabled on an open-mic agent (isTapToTalk:false) — mixing races CM state', async () => {
  const { session, socket } = newSession();   // default happy-path fixture never sets isTapToTalk
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(session.capabilities.tapToTalk, false);
  assert.throws(() => session.startTapToTalk(), (e) => e.code === 'capability_disabled');
  session.disconnect();
});

test('tap-to-talk: a captured turn flows through the existing agentTurnToTalk/transcript pipeline', async () => {
  const { session, socket } = newTapToTalkSession();
  await session.connect();
  const transcripts = [];
  session.on('transcript', (t) => transcripts.push(t));
  session.startTapToTalk();
  session.endTapToTalk();
  // CM mints the turn ~300ms after tapToTalkEnd, same event as an open-mic turn.
  socket.server('agentTurnToTalk', { userTranscription: 'what about Q3 margins' });
  assert.ok(transcripts.some((t) => t.type === 'user' && t.text === 'what about Q3 margins'));
  assert.equal(session._lastTurnText, 'what about Q3 margins');
  session.disconnect();
});

test('tap-to-talk: startTapToTalk twice throws invalid_state; endTapToTalk without a start throws invalid_state', async () => {
  const { session } = newTapToTalkSession();
  await session.connect();
  assert.throws(() => session.endTapToTalk(), (e) => e.code === 'invalid_state');
  session.startTapToTalk();
  assert.throws(() => session.startTapToTalk(), (e) => e.code === 'invalid_state');
  session.endTapToTalk();
  session.disconnect();
});

test('tap-to-talk: speak()/interrupt() refuse to run while a tap is open (stay isolated from typed-text barge-in)', async () => {
  const { session } = newTapToTalkSession();
  await session.connect();
  session.startTapToTalk();
  await assert.rejects(() => session.speak('hello'), (e) => e.code === 'invalid_state');
  assert.throws(() => session.interrupt(), (e) => e.code === 'invalid_state');
  session.endTapToTalk();
  session.disconnect();
});

test('tap-to-talk: requires a connected session', () => {
  const { session } = newSession();
  assert.throws(() => session.startTapToTalk(), (e) => e.code === 'invalid_state');
  assert.throws(() => session.endTapToTalk(), (e) => e.code === 'invalid_state');
});

test('tap-to-talk: blocked by the disclosure gate like speak(), until acknowledgeDisclosure()', async () => {
  const { session } = newTapToTalkSession({ cfg: { requireDisclosureAck: true } });
  await session.connect();
  assert.throws(() => session.startTapToTalk(), (e) => e.code === 'disclosure_required');
  session.acknowledgeDisclosure();
  session.startTapToTalk();
  assert.equal(session.tapToTalkActive, true);
  session.endTapToTalk();
  session.disconnect();
});

test('capabilities.tapToTalk reflects clientConfiguration.isTapToTalk', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(session.capabilities.tapToTalk, false, 'the happy-path fixture never sets isTapToTalk');
  session.disconnect();

  const { session: s2 } = newTapToTalkSession();
  await s2.connect();
  assert.equal(s2.capabilities.tapToTalk, true);
  s2.disconnect();
});

test('disconnect tears down peers + socket + DELETEs WHEP resource', async () => {
  let deleted = null;
  const whepFetch = async (url, init) => {
    if (init?.method === 'DELETE') { deleted = url; return { ok: true, status: 200, text: async () => '', headers: { get: () => null } }; }
    return { ok: true, status: 201, text: async () => 'answer', headers: { get: () => 'https://srs/whep/resource/9' } };
  };
  const { session, socket } = newSession({ fetch: whepFetch });
  scriptHappyPath(socket);
  await session.connect();
  session.disconnect();
  assert.equal(session.state, 'disconnected');
  assert.equal(socket.connected, false);
  await delay(10);   // the WHEP DELETE is fire-and-forget (a microtask) so it never blocks teardown
  assert.equal(deleted, 'https://srs/whep/resource/9', 'DELETEs the resolved (absolute) WHEP Location');
  assert.ok(FakeRTCPeerConnection.instances.every((pc) => pc.closed));
});

test('WHEP DELETE resolves a RELATIVE Location against the WHEP URL (no page-origin 404 leak)', async () => {
  let deleted = null;
  const whepFetch = async (url, init) => {
    if (init?.method === 'DELETE') { deleted = url; return { ok: true, status: 200, text: async () => '', headers: { get: () => null } }; }
    // Server returns a RELATIVE Location (the real SRS behavior that caused the leak).
    return { ok: true, status: 201, text: async () => 'answer', headers: { get: () => '/rtc/v1/whip/?action=delete&token=abc' } };
  };
  const { session, socket } = newSession({ fetch: whepFetch });
  scriptHappyPath(socket);
  await session.connect();
  session.disconnect();
  await delay(10);
  // Must resolve against srsBaseUrl (https://srs.example), NOT the page origin.
  assert.equal(deleted, 'https://srs.example/rtc/v1/whip/?action=delete&token=abc');
});

test('resilience: a RECOVERABLE drop → reconnecting → reconnected (no re-join)', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const events = [];
  session.on('reconnecting', (p) => events.push(['reconnecting', p.reason]));
  session.on('reconnected', (p) => events.push(['reconnected', p.recovered]));
  session.on('ended', () => events.push(['ended']));
  const joinsBefore = socket.emitsOf('join').length;
  // server drops the transport (recoverable), then socket.io recovers the SAME session
  // (connection-state recovery: socket.recovered === true).
  socket.server('disconnect', 'transport close');
  assert.equal(session.state, 'reconnecting');
  socket.recovered = true;
  socket.server('connect');
  assert.equal(session.state, 'connected');
  // recovery must NOT re-emit join (server replays buffered packets / skips re-init)
  assert.equal(socket.emitsOf('join').length, joinsBefore, 'must not re-join on recovery');
  assert.deepEqual(events, [['reconnecting', 'transport close'], ['reconnected', true]]);
  session.disconnect();
});

test('resilience: a NON-recoverable drop → ended (no reconnect)', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  let ended = null, reconnecting = false;
  session.on('ended', (p) => { ended = p; });
  session.on('reconnecting', () => { reconnecting = true; });
  socket.server('disconnect', 'io server disconnect');
  assert.equal(session.state, 'disconnected');
  assert.equal(ended.reason, 'io server disconnect');
  assert.equal(reconnecting, false);
});

test('resilience: pause expiry → timeExpired{pause_expiry}, NOT ended; resume rebuilds STV', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  let expiry = null, ended = false;
  session.on('timeExpired', (p) => { expiry = p; });
  session.on('ended', () => { ended = true; });
  session.pause();
  socket.server('pauseSessionExpired', {});
  assert.deepEqual(expiry, { type: 'pause_expiry' });
  assert.equal(ended, false, 'pause expiry is NOT an end');
  // resume after expiry must rebuild: re-emit stvNewSession + reconnect ASR
  const stvBefore = socket.emitsOf('stvNewSession').length;
  await session.resume();
  assert.ok(socket.emitsOf('stvNewSession').length > stvBefore, 'resume rebuilds the STV session');
  assert.equal(session.state, 'connected');
  session.disconnect();
});

test('getStickyId is stable and reused across the session (same-pod resume)', async () => {
  const { session, socket } = newSession();
  const sticky = session.getStickyId();
  assert.match(sticky, /^[a-z0-9]{16}$/);
  scriptHappyPath(socket);
  await session.connect();
  // a second connect attempt would reuse the same stickyId (we assert the getter is stable)
  assert.equal(session.getStickyId(), sticky);
  session.disconnect();
});

// ─────────────────────────── Disclosure gate (EU AI Act Art. 50) ────────────

test('disclosure: speak() blocks until acknowledgeDisclosure() when requireDisclosureAck:true', async () => {
  const { session, socket } = newSession({ cfg: { requireDisclosureAck: true } });
  scriptHappyPath(socket);
  await session.connect();
  // disclosure fires but we have NOT called acknowledgeDisclosure() yet
  const err = await session.speak('hello').catch((e) => e);
  assert.equal(err.code, 'disclosure_required', 'speak() must be blocked by disclosure gate');
  // now acknowledge — subsequent speaks should pass
  session.acknowledgeDisclosure();
  await session.speak('hello again');
  assert.ok(socket.didEmit('onTextEntered'));
  session.disconnect();
});

test('disclosure: speak() proceeds without acknowledge when requireDisclosureAck:false', async () => {
  const { session, socket } = newSession({ cfg: { requireDisclosureAck: false } });
  scriptHappyPath(socket);
  await session.connect();
  await session.speak('hi');
  assert.ok(socket.didEmit('onTextEntered'));
  session.disconnect();
});

test('disclosure: acknowledgeDisclosure() clears _disclosurePending flag', async () => {
  const { session, socket } = newSession({ cfg: { requireDisclosureAck: true } });
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(session._disclosurePending, true, 'flag must be set after connect');
  session.acknowledgeDisclosure();
  assert.equal(session._disclosurePending, false, 'flag must be cleared after acknowledge');
  session.disconnect();
});

// ─────────────────────────── WHEP private IP (Location, additive check) ─────

test('WHEP private IP: throws whep_private_ip when the resolved Location resolves to a private IP', async () => {
  const whepFetch = async () => ({ ok: true, status: 201, text: async () => 'v=0', headers: { get: () => 'https://10.0.0.5/whep/resource/1' } });
  const { session, socket } = newSession({ fetch: whepFetch });
  scriptHappyPath(socket);
  await assert.rejects(() => session.connect(), (e) => e.code === 'whep_private_ip');
  session.disconnect();
});

// ─────────────────────────── waitForCapacity ────────────────────────────────

test('waitForCapacity: resolves immediately when socket answers available:true', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  // poll checkAvailability → availabilityResult available:true (scriptHappyPath auto-responds)
  await session.waitForCapacity({ maxWaitMs: 2000, pollIntervalMs: 10 });
  assert.ok(true, 'resolved without timeout');
  session.disconnect();
});

test('waitForCapacity: rejects with capacity_timeout after maxWaitMs when never available', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket, { capacityBusyTimes: 9999 }); // always busy
  await session.connect();
  await assert.rejects(
    () => session.waitForCapacity({ maxWaitMs: 50, pollIntervalMs: 10 }),
    (e) => e.code === 'capacity_timeout',
  );
  session.disconnect();
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('capacity backoff: onAvail applies ±15% jitter at the consumption site (exact schedule stays untouched — see wire.test.js)', async () => {
  // Jittering the wait at the point it's consumed (not the exported
  // CAPACITY_BACKOFF array) means concurrently-waiting clients don't all re-poll in lockstep,
  // while wire.test.js's exact-array assertion on CAPACITY_BACKOFF itself still holds.
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.avatar.us.kaltura.ai',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: async () => ({ ok: true, status: 201, text: async () => 'v=0', headers: { get: () => 'https://srs/whep/resource/1' } }),
    getUserMedia: fakeGetUserMedia(),
  });

  const origSetTimeout = globalThis.setTimeout;
  const waits = [];
  // The capacity backoff is the only setTimeout this method schedules above 1s; fire it
  // immediately via the real timer so the busy-reply loop below can drive it deterministically.
  globalThis.setTimeout = (fn, ms) => (ms > 1000 ? (waits.push(ms), origSetTimeout(fn, 0)) : origSetTimeout(fn, ms));

  const overall = { expired: () => false };
  try {
    const p = session._createSessionWithCapacity(socket, overall);
    await delay(0);
    for (let i = 0; i < 3; i++) {
      socket.server('availabilityResult', { available: false, details: {} });
      await delay(0);
    }
    socket.server('availabilityResult', { available: true, details: {} });
    await delay(0);
    socket.server('stvNewSession', { session_id: 'sess-x', status: 'session started', webrtc_url: 'https://srs.example/whep' });
    await p;
  } finally { globalThis.setTimeout = origSetTimeout; }

  assert.equal(waits.length, 3, 'three busy replies → three scheduled backoff waits');
  [30, 45, 60].forEach((baseSec, i) => {
    const base = baseSec * 1000;
    assert.ok(waits[i] >= base * 0.85 - 1 && waits[i] <= base * 1.15 + 1, `wait[${i}]=${waits[i]}ms must land within ±15% of ${base}ms`);
  });
  assert.ok(waits.some((w, i) => w !== [30, 45, 60][i] * 1000), 'jitter must actually perturb at least one wait off the exact base');
});

// ─────────────────────────── session_completed signal ───────────────────────
// The wire mechanism itself (POST shape, presence, hidden-grace, bfcache) is
// unit-tested in isolation in test/unit/session-complete.test.js. These prove
// it end to end against the real KalturaAvatarSession / KalturaAgentSession —
// the same fetch doubles as WHEP's and genie's, since both share `cfg.fetch`.

/** A fetch double that answers WHEP/DELETE as usual and separately records every `/thread/session_completed` POST. */
function genieAwareFetch() {
  const genieCalls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/thread/session_completed')) {
      genieCalls.push({ url: u, init });
      return { ok: true, status: 200, text: async () => '', headers: { get: () => null } };
    }
    if (init.method === 'DELETE') return { ok: true, status: 200, text: async () => '', headers: { get: () => null } };
    return { ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } };
  };
  fn.genieCalls = genieCalls;
  return fn;
}

/** Fire the socket event that carries the real threadId, same shape as WIRE-PROTOCOL §4e. */
const fireThreadId = (socket, threadId) => socket.server('agent_raw_text', { delta: JSON.stringify({ type: 'text', content: 'hi', threadId }) });

test('session_completed: disconnect() POSTs {id:threadId} once genie has a real threadId', async () => {
  const fetch = genieAwareFetch();
  const { session, socket } = newSession({ fetch });
  scriptHappyPath(socket);
  await session.connect();
  fireThreadId(socket, 'thread-e2e-1');
  session.disconnect();
  await delay(10);
  assert.equal(fetch.genieCalls.length, 1);
  const call = fetch.genieCalls[0];
  assert.equal(call.url, 'https://genie.nvp1.ovp.kaltura.com/thread/session_completed');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.keepalive, true);
  assert.equal(call.init.headers.Authorization, `KS ${CONV_KS}`);
  assert.deepEqual(JSON.parse(call.init.body), { id: 'thread-e2e-1' });
});

test('session_completed: completeThread() then disconnect() — idempotent, exactly one POST', async () => {
  const fetch = genieAwareFetch();
  const { session, socket } = newSession({ fetch });
  scriptHappyPath(socket);
  await session.connect();
  fireThreadId(socket, 'thread-e2e-2');
  const r = await session.completeThread();
  assert.deepEqual(r, { ok: true, reason: 'manual' });
  session.disconnect();
  await delay(10);
  assert.equal(fetch.genieCalls.length, 1, 'disconnect() must not re-send once already sent');
});

test('session_completed: no threadId yet — disconnect() sends nothing', async () => {
  const fetch = genieAwareFetch();
  const { session, socket } = newSession({ fetch });
  scriptHappyPath(socket);
  await session.connect();
  session.disconnect();
  await delay(10);
  assert.equal(fetch.genieCalls.length, 0);
});

test('session_completed: server conversationEnded defaults to final:false — no POST (the backend already knows)', async () => {
  const fetch = genieAwareFetch();
  const { session, socket } = newSession({ fetch });
  scriptHappyPath(socket);
  await session.connect();
  fireThreadId(socket, 'thread-e2e-3');
  let ended = null;
  session.on('ended', (p) => { ended = p; });
  socket.server('conversationEnded', {});
  await delay(10);
  assert.equal(fetch.genieCalls.length, 0, 're-signalling a server-initiated end would waste a redundant lifecycle-rule evaluation');
  assert.equal(session.state, 'disconnected');
  assert.ok(ended);
});

test('session_completed: sessionCompleteOnEnd:false — disconnect() never POSTs', async () => {
  const fetch = genieAwareFetch();
  const { session, socket } = newSession({ fetch, cfg: { sessionCompleteOnEnd: false } });
  scriptHappyPath(socket);
  await session.connect();
  fireThreadId(socket, 'thread-e2e-4');
  session.disconnect();
  await delay(10);
  assert.equal(fetch.genieCalls.length, 0);
});

test('KalturaAgentSession: switchMode() never fires session_completed; the facade disconnect() after a switch fires exactly once', async () => {
  FakeRTCPeerConnection.reset();
  const fetch = genieAwareFetch();
  const socket = new FakeSocket();
  const videoEl = new FakeVideoEl({ autoCanPlay: true });
  const agent = new KalturaAgentSession({
    token: CONV_KS,
    avatar: { srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.avatar.us.kaltura.ai', videoEl, socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection, fetch, getUserMedia: fakeGetUserMedia() },
    chat: { fetch },
  });
  scriptHappyPath(socket);
  await agent.connect();
  fireThreadId(socket, 'thread-e2e-switch');
  await agent.switchMode('chat');
  assert.equal(agent.mode, 'chat');
  assert.equal(agent.threadId, 'thread-e2e-switch', 'thread continuity survives the switch');
  assert.equal(fetch.genieCalls.length, 0, 'switchMode() tears down the old transport internally — never a real end');
  agent.disconnect();
  await delay(10);
  assert.equal(fetch.genieCalls.length, 1, 'the facade disconnect() is the real end, fired exactly once');
  assert.deepEqual(JSON.parse(fetch.genieCalls[0].init.body), { id: 'thread-e2e-switch' });
});
