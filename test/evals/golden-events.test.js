import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia } from '../fakes/rtc.js';

const golden = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/golden-session.json', import.meta.url)), 'utf8'));
const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

/**
 * EVAL: the SDK must HANDLE every inbound socket event observed in the real
 * captured session — none silently dropped. We connect a session, then replay
 * every golden inbound event onto the socket and assert the SDK has a listener
 * for it (i.e. it is part of the contract, not ignored).
 */
test('SDK handles every inbound event in the golden capture (superset)', async () => {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl: new FakeVideoEl(),
    socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: async () => ({ ok: true, status: 201, text: async () => 'a', headers: { get: () => 'loc' } }),
    getUserMedia: fakeGetUserMedia(),
  });
  scriptHappyPath(socket);
  await session.connect();

  // Events the connect machine consumes via one-shot `once()` (already fired and
  // detached by now) — these ARE handled; exclude them from the "still-listening" check.
  const handshakeOnce = new Set(['onServerConnected', 'clientConfiguration', 'joinComplete', 'showAgent', 'askPermissions', 'asr-webrtc-ready', 'asr-webrtc-answer', 'stvNewSession', 'availabilityResult']);

  const unhandled = golden.inboundEvents.filter((ev) => {
    if (handshakeOnce.has(ev)) return false;
    // debug_* diagnostics + asr-ice-candidate are informational; the SDK may not surface them but must not crash.
    return !(socket._h.get(ev)?.size > 0);
  });

  // Tolerated as informational (not part of the typed surface, but must not break the session):
  const tolerated = new Set(['debug_conversationStateChange', 'debug_llm_input', 'debug_vad_speech_detected', 'debug_stvTaskGenerated', 'asr-ice-candidate', 'hideTapToTalkButton']);
  const trulyUnhandled = unhandled.filter((e) => !tolerated.has(e));
  assert.deepEqual(trulyUnhandled, [], `SDK must listen for these captured events: ${trulyUnhandled}`);

  // And replaying every golden inbound event must never throw.
  for (const ev of golden.inboundEvents) {
    assert.doesNotThrow(() => socket.server(ev, sampleFor(ev)), `replaying ${ev} threw`);
  }
  session.disconnect();
});

/**
 * EVAL: the SDK must PRODUCE the outbound emits the real client produced (the
 * documented client→server contract). Drive a full connect + one speak turn and
 * assert each required emit appears.
 */
test('SDK produces the outbound emits seen in the golden capture', async () => {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl: new FakeVideoEl(),
    socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: async () => ({ ok: true, status: 201, text: async () => 'a', headers: { get: () => 'loc' } }),
    getUserMedia: fakeGetUserMedia(),
  });
  scriptHappyPath(socket);
  await session.connect();
  session.mute(); session.unmute(); session.pause(); session.resume();
  await session.speak('hi');     // emits onTextEntered (async: passes the optional guardrail)
  const produced = new Set(socket.emitted.map((e) => e.event));

  // The core documented client→server emits the SDK is responsible for:
  const required = ['join', 'checkAvailability', 'stvNewSession', 'asr-webrtc-init', 'asr-webrtc-offer', 'asr-webrtc-ice-candidate', 'approvedPermissions', 'onTextEntered', 'muteUser', 'unmuteUser', 'pauseConversation', 'resumeConversation'];
  for (const ev of required) assert.ok(produced.has(ev), `SDK must emit ${ev} (in golden outbound: ${golden.outboundEvents.includes(ev)})`);
  session.disconnect();
});

/** EVAL: payload field NAMES preserved from the wire (e.g. speechId, not speech_id). */
test('preserves raw wire field names on emitted events', async () => {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({ token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl: new FakeVideoEl(), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection, fetch: async () => ({ ok: true, status: 201, text: async () => 'a', headers: { get: () => 'loc' } }), getUserMedia: fakeGetUserMedia() });
  scriptHappyPath(socket);
  await session.connect();
  const turns = [];
  session.on('turnStart', (p) => turns.push(p));
  session.on('speechChunk', (p) => turns.push(p));
  socket.server('agent_start_speech', { speechId: 'X-transcript-q', turnId: 't', isNewTurn: true });
  socket.server('stvSpeechChunk', { text: 'hello', durationMs: 100, speechId: 'X-transcript-q' });
  assert.ok('speechId' in turns[0] && 'turnId' in turns[0] && 'isNewTurn' in turns[0]);
  assert.ok('durationMs' in turns[1] && 'speechId' in turns[1]);
  session.disconnect();
});

/** Minimal representative payload for each golden inbound event (for the no-throw replay). */
function sampleFor(ev) {
  const s = golden.shapes['in ' + ev];
  if (!s || Object.keys(s).length === 0) return {};
  // agent_raw_text.delta must be a JSON string (the SDK JSON.parses it).
  if (ev === 'agent_raw_text') return { speechId: 'a-transcript-x', turnId: 't', delta: JSON.stringify({ type: 'text', content: 'hi' }) };
  return buildSample(s);
}
function buildSample(shape) {
  const o = {};
  for (const [k, type] of Object.entries(shape)) {
    o[k] = type === 'str' ? 'x' : type === 'int' ? 1 : type === 'bool' ? false : type === 'NoneType' ? null : Array.isArray(type) ? [] : (typeof type === 'object' ? buildSample(type) : null);
  }
  return o;
}
