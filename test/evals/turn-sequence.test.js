import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia } from '../fakes/rtc.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

/** The documented end-to-end turn (WIRE-PROTOCOL §8), as the server would emit it. */
const TURN = [
  ['debug_vad_speech_detected', { transcript: 'how do I', isFinal: false, segmentType: 'new' }],
  ['debug_vad_speech_detected', { transcript: 'how do I reset', isFinal: true, segmentType: 'final' }],
  ['debug_conversationStateChange', { state: 'PreparingAudio', preparingAnswerState: 'PreparingAnswer' }],
  ['debug_llm_input', { userInput: 'how do I reset', speechId: 'S-transcript-howdoIreset', isFinal: true }],
  ['agent_start_speech', { speechId: 'S-transcript-howdoIreset', turnId: 't1', isNewTurn: true }],
  ['agent_raw_text', { speechId: 'S-transcript-howdoIreset', turnId: 't1', delta: JSON.stringify({ type: 'think', content: '' }) }],
  ['agent_raw_text', { speechId: 'S-transcript-howdoIreset', turnId: 't1', delta: JSON.stringify({ type: 'avatar', content: 'Go to settings.' }) }],
  ['generatingSpeech', { text: 'Go to settings.', speechId: 'S-transcript-howdoIreset' }],
  ['stvSpeechChunk', { text: 'Go to settings.', durationMs: 900, speechId: 'S-transcript-howdoIreset' }],
  ['stvStartedTalking', {}],
  ['agent_end_turn', { speechId: 'S-transcript-howdoIreset', turnId: 't1' }],
  ['stvFinishedGenerating', { speechId: 'S-transcript-howdoIreset' }],
  ['stvFinishedTalking', { agentContent: 'Go to settings.' }],
  ['debug_conversationStateChange', { state: 'Idle' }],
];

test('a full §8 turn drives the SDK event model coherently', async () => {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({ token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl: new FakeVideoEl(), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection, fetch: async () => ({ ok: true, status: 201, text: async () => 'a', headers: { get: () => 'loc' } }), getUserMedia: fakeGetUserMedia() });
  scriptHappyPath(socket);
  await session.connect();

  /** @type {string[]} */ const order = [];
  session.on('turnStart', () => order.push('turnStart'));
  session.on('brainSegment', (d) => order.push('brain:' + d.type));
  session.on('avatarStartTalking', () => order.push('startTalking'));
  session.on('avatarStopTalking', () => order.push('stopTalking'));
  session.on('turnEnd', () => order.push('turnEnd'));
  let finalTranscript = null, captionCount = 0;
  session.on('transcript', (t) => { if (t.type === 'final') finalTranscript = t.text; });
  session.on('speechChunk', () => captionCount++);

  for (const [ev, payload] of TURN) socket.server(ev, payload);

  // Talking-state transitions fired and in the right relative order.
  assert.ok(order.includes('turnStart'));
  assert.ok(order.indexOf('startTalking') < order.indexOf('stopTalking'), 'start before stop');
  assert.ok(order.indexOf('turnStart') < order.indexOf('startTalking'), 'turn starts before lips move');
  assert.ok(order.includes('brain:think') && order.includes('brain:avatar'));
  // captions surfaced; clean sentence text captured
  assert.equal(captionCount, 1);
  assert.equal(finalTranscript, 'Go to settings.');
  // speaking flag reset at end of turn
  assert.equal(session.speaking, false);
  session.disconnect();
});

test('responsePending: armed when the brain is prompted, settled on its first output', async () => {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({ token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl: new FakeVideoEl(), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection, fetch: async () => ({ ok: true, status: 201, text: async () => 'a', headers: { get: () => 'loc' } }), getUserMedia: fakeGetUserMedia() });
  scriptHappyPath(socket);
  await session.connect();
  const order = [];
  session.on('responsePending', () => order.push('pending'));
  session.on('responseSettled', () => order.push('settled'));

  // 1) a captured user turn arms the signal…
  assert.equal(session.responsePending, false);
  socket.server('agentTurnToTalk', { userTranscription: 'how do I reset' });
  assert.equal(session.responsePending, true, 'armed when the brain is expected to respond');
  // …turn start + a `think` segment are the THINKING phase, NOT output — they must NOT settle
  // (settling there would clear the signal during the very dead air it covers).
  socket.server('agent_start_speech', { speechId: 's1', turnId: 't1', isNewTurn: true });
  socket.server('agent_raw_text', { speechId: 's1', turnId: 't1', delta: JSON.stringify({ type: 'think', content: 'preparing…' }) });
  assert.equal(session.responsePending, true, 'still pending through turnStart + think (the gap)');
  // …the avatar actually talking settles it
  socket.server('stvStartedTalking', {});
  assert.equal(session.responsePending, false, 'settled once real output lands');

  // 2) a silent type:"tool" segment (no speech) also counts as output → settles
  session._armResponsePending();
  socket.server('agent_raw_text', { speechId: 's2', turnId: 't2', delta: JSON.stringify({ type: 'tool', content: 'navigate_to_slide {"slide_num": 3}' }) });
  assert.equal(session.responsePending, false, 'a silent tool segment settles the gap');

  // events fired pending-before-settled
  assert.equal(order[0], 'pending');
  assert.ok(order.includes('settled'));
  session.disconnect();
});

test('barge-in interleaving: only at agentInterrupted does a new speechId take over', async () => {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({ token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl: new FakeVideoEl(), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection, fetch: async () => ({ ok: true, status: 201, text: async () => 'a', headers: { get: () => 'loc' } }), getUserMedia: fakeGetUserMedia() });
  scriptHappyPath(socket);
  await session.connect();
  const captions = [];
  session.on('transcript', (t) => { if (t.type === 'partial') captions.push(t.text); });

  socket.server('agent_start_speech', { speechId: 'A-transcript-a', turnId: '1', isNewTurn: true });
  socket.server('stvSpeechChunk', { text: 'first', durationMs: 300, speechId: 'A-transcript-a' });
  socket.server('agentInterrupted', {});
  socket.server('agent_start_speech', { speechId: 'B-transcript-b', turnId: '2', isNewTurn: true });
  socket.server('stvSpeechChunk', { text: 'stale-A', durationMs: 300, speechId: 'A-transcript-a' }); // must drop
  socket.server('stvSpeechChunk', { text: 'second', durationMs: 300, speechId: 'B-transcript-b' });

  assert.deepEqual(captions, ['first', 'second'], 'stale-A chunk dropped; B flows');
  session.disconnect();
});
