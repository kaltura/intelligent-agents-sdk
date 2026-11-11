/**
 * TurnMonitor: `speech_not_started`, `slow_turn`, `tool_heavy_turn`, `turnTimings`,
 * `config_language_differs` and `reply_language_differs_from_config`.
 * The unit tests use a fake clock and fake timers. The session tests replay socket
 * event orders over the fake socket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnMonitor } from '../../src/experience/turn-monitor.js';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor, fakeGetUserMedia } from '../fakes/rtc.js';

function rig(opts = {}) {
  const out = [];
  let t = 1000;
  const timers = [];
  const state = { audioOnly: false, paused: false };
  const m = new TurnMonitor({
    emit: (name, payload) => out.push({ name, ...payload }),
    isAudioOnly: () => state.audioOnly, isPaused: () => state.paused,
    now: () => t, setTimer: (fn, ms) => { const h = { fn, ms, live: true }; timers.push(h); return h; }, clearTimer: (h) => { h.live = false; },
    ...opts,
  });
  return {
    m, out, state, timers,
    advance: (ms) => { t += ms; },
    fire: () => { for (const h of timers.splice(0)) if (h.live) { h.live = false; h.fn(); } },
    warns: (code) => out.filter((e) => e.name === 'warning' && e.code === code),
  };
}
const turn = (r, { speech = 's1', send = true } = {}) => {
  if (send) r.m.sent();
  r.m.turnStart({ turnId: 't1', speechId: speech, isNewTurn: true });
};

test('speech_not_started: the reply completed, no audio began, one warning after the grace', () => {
  const r = rig();
  turn(r);
  r.m.segment('Hello there, how can I help you today');
  r.advance(900);
  r.m.finishedGenerating();
  assert.equal(r.timers[0].ms, 3000);
  r.advance(3000);
  r.fire();
  const [w] = r.warns('speech_not_started');
  assert.equal(r.warns('speech_not_started').length, 1);
  assert.deepEqual([w.turnId, w.replyChars, w.elapsedMs], ['t1', 37, 3900]);
});

test('speech_not_started: silent when audio started before or during the grace', () => {
  const a = rig(); turn(a); a.m.segment('Hello there friend'); a.m.startedTalking(); a.m.finishedGenerating();
  assert.equal(a.timers.length, 0, 'audio before the end of generation: no timer');
  const b = rig(); turn(b); b.m.segment('Hello there friend'); b.m.finishedGenerating(); b.m.speechChunk(); b.fire();
  assert.equal(b.warns('speech_not_started').length, 0, 'a caption chunk cancels it');
  const c = rig(); turn(c); c.m.segment('Hello there friend'); c.m.finishedGenerating(); c.m.startedTalking(); c.fire();
  assert.equal(c.warns('speech_not_started').length, 0, 'talking cancels it');
});

test('speech_not_started: silent on interrupt, pause, reconnect, silent opening, check-in, no reply text, audio-only, several speech ids', () => {
  const cases = {
    interrupt: (r) => { turn(r); r.m.segment('Hello there friend'); r.m.quiet(); r.m.finishedGenerating(); },
    'interrupt during the grace': (r) => { turn(r); r.m.segment('Hello there friend'); r.m.finishedGenerating(); r.m.quiet(); },
    pause: (r) => { turn(r); r.m.segment('Hello there friend'); r.state.paused = true; r.m.finishedGenerating(); },
    'pause during the grace': (r) => { turn(r); r.m.segment('Hello there friend'); r.m.finishedGenerating(); r.state.paused = true; },
    reconnect: (r) => { turn(r); r.m.segment('Hello there friend'); r.m.finishedGenerating(); r.m.reset(); },
    'tool-only turn': (r) => { turn(r); r.m.toolCall(); r.m.finishedGenerating(); },
    'audio-only': (r) => { r.state.audioOnly = true; turn(r); r.m.segment('Hello there friend'); r.m.finishedGenerating(); },
    'two speech ids': (r) => { turn(r); r.m.speechId('s2'); r.m.segment('Hello there friend'); r.m.finishedGenerating(); },
    'grace off': (r) => { r.m._grace = 0; turn(r); r.m.segment('Hello there friend'); r.m.finishedGenerating(); },
  };
  for (const [name, setup] of Object.entries(cases)) {
    const r = rig();
    setup(r);
    r.advance(10000);
    r.fire();
    assert.equal(r.warns('speech_not_started').length, 0, name);
  }
});

test('speech_not_started: a new turn drops the pending warning of the old one', () => {
  const r = rig();
  turn(r); r.m.segment('Hello there friend'); r.m.finishedGenerating();
  r.m.turnStart({ turnId: 't2', speechId: 's2', isNewTurn: true });
  r.fire();
  assert.equal(r.warns('speech_not_started').length, 0);
});

test('slow_turn: names the stage that was slow, and only for a turn the SDK sent', () => {
  const brain = rig();
  turn(brain); brain.advance(11000); brain.m.segment('Hi there my friend'); brain.advance(500); brain.m.startedTalking();
  const [w] = brain.warns('slow_turn');
  assert.deepEqual([w.stage, w.elapsedMs, w.limitMs], ['first_segment', 11500, 10000]);

  const speech = rig();
  turn(speech); speech.advance(800); speech.m.segment('Hi there my friend'); speech.advance(10500); speech.m.startedTalking();
  assert.equal(speech.warns('slow_turn')[0].stage, 'speech_start');

  const fast = rig(); turn(fast); fast.advance(4900); fast.m.startedTalking();
  assert.equal(fast.warns('slow_turn').length, 0);

  const server = rig(); turn(server, { send: false }); server.advance(20000); server.m.startedTalking();
  assert.equal(server.warns('slow_turn').length, 0, 'an opening or check-in has no send time');

  const once = rig(); turn(once); once.advance(12000); once.m.startedTalking(); once.m.startedTalking();
  assert.equal(once.warns('slow_turn').length, 1);

  const off = rig({ slowTurnMs: 0 }); turn(off); off.advance(60000); off.m.startedTalking();
  assert.equal(off.warns('slow_turn').length, 0);
});

test('tool_heavy_turn: one warning when the count reaches the limit, counted per turn', () => {
  const r = rig({ toolHeavyLimit: 3 });
  turn(r);
  for (let i = 0; i < 6; i++) r.m.toolCall();
  assert.equal(r.warns('tool_heavy_turn').length, 1);
  assert.deepEqual([r.warns('tool_heavy_turn')[0].count, r.warns('tool_heavy_turn')[0].limit], [3, 3]);
  r.m.turnStart({ turnId: 't2', speechId: 's2', isNewTurn: true });
  for (let i = 0; i < 2; i++) r.m.toolCall();
  assert.equal(r.warns('tool_heavy_turn').length, 1, 'the count starts over');
  assert.equal(rig({ toolHeavyLimit: 0 }).m.toolCall(), undefined);
});

test('a repeat agent_start_speech for a turn in flight does not restart it', () => {
  const r = rig();
  turn(r); r.m.toolCall();
  r.m.turnStart({ turnId: 't1', speechId: 's2', isNewTurn: false });
  r.m.segment('Hello there friend'); r.m.finishedGenerating();
  assert.equal(r.timers.length, 0, 'two speech ids: quiet');
  assert.equal(r.out.find((e) => e.name === 'turnTimings').toolCalls, 1);
});

test('turnTimings: offsets from the send time, null for what did not happen, once per turn', () => {
  const r = rig();
  turn(r);
  r.advance(700); r.m.segment('Hello there friend');
  r.advance(400); r.m.speechChunk();
  r.advance(300); r.m.startedTalking();
  r.advance(900); r.m.finishedGenerating(); r.m.finishedGenerating();
  const timings = r.out.filter((e) => e.name === 'turnTimings');
  assert.equal(timings.length, 1);
  assert.deepEqual({ ...timings[0], name: undefined }, {
    name: undefined, turnId: 't1', origin: 'sent', firstSegmentMs: 700, firstSpeechChunkMs: 1100, startedTalkingMs: 1400, finishedMs: 2300, toolCalls: 0,
  });
  const silent = rig(); turn(silent, { send: false }); silent.m.finishedGenerating();
  const [t] = silent.out.filter((e) => e.name === 'turnTimings');
  assert.deepEqual([t.origin, t.firstSegmentMs, t.startedTalkingMs], ['turn_start', null, null]);
});

test('timings and warnings carry no reply text', () => {
  const r = rig();
  turn(r); r.m.segment('SECRET-REPLY-TEXT here we go'); r.m.finishedGenerating(); r.advance(3000); r.fire();
  assert.equal(JSON.stringify(r.out).includes('SECRET'), false);
});

test('config_language_differs: once, only when both languages are known and differ', () => {
  const r = rig();
  r.m.configReady({ languageCode: 'en', asr: { language: 'he' } });
  r.m.configReady({ languageCode: 'en', asr: { language: 'he' } });
  assert.equal(r.warns('config_language_differs').length, 1);
  assert.deepEqual([r.warns('config_language_differs')[0].languageCode, r.warns('config_language_differs')[0].asrLanguage], ['en', 'he']);
  for (const cc of [{ languageCode: 'he', asr: { language: 'iw' } }, { languageCode: 'en' }, { asr: { language: 'he' } }, { languageCode: 'zz', asr: { language: 'he' } }, null, undefined]) {
    const q = rig(); q.m.configReady(cc);
    assert.equal(q.warns('config_language_differs').length, 0, JSON.stringify(cc));
  }
});

test('reply_language_differs_from_config: a Hebrew reply on an English session warns once; es vs en, short and interrupted replies do not', () => {
  const r = rig();
  r.m.configReady({ languageCode: 'en', asr: { language: 'en' } });
  for (let i = 0; i < 2; i++) { turn(r); r.m.segment('שלום, אני העוזר שלך היום'); r.m.startedTalking(); r.m.finishedGenerating(); }
  assert.equal(r.warns('reply_language_differs_from_config').length, 1);
  const w = r.warns('reply_language_differs_from_config')[0];
  assert.deepEqual([w.replyScript, w.languageScript], ['Hebrew', 'Latin']);

  const cases = [
    ['es on en', { languageCode: 'en' }, 'Hola, bienvenido a nuestra tienda', false],
    ['short', { languageCode: 'en' }, 'שלום', false],
    ['no language', {}, 'שלום, אני העוזר שלך היום', false],
    ['interrupted', { languageCode: 'en' }, 'שלום, אני העוזר שלך היום', true],
  ];
  for (const [name, cc, text, quiet] of cases) {
    const q = rig(); q.m.configReady(cc); turn(q); q.m.segment(text); if (quiet) q.m.quiet(); q.m.finishedGenerating();
    assert.equal(q.warns('reply_language_differs_from_config').length, 0, name);
  }
});

// ─────────────────────────── session replay ───────────────────────────

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
async function connected(cfg = {}, scriptOpts = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } }),
    getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false, ...cfg,
  });
  scriptHappyPath(socket, scriptOpts);
  const warnings = [];
  const timings = [];
  session.on('warning', (w) => warnings.push(w));
  session.on('turnTimings', (t) => timings.push(t));
  await session.connect();
  return { session, socket, warnings, timings };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codes = (warnings) => warnings.map((w) => w.code).filter((c) => c === 'speech_not_started');
const reply = (socket, text = 'Happy to help with that today') => {
  socket.server('agent_start_speech', { turnId: 'T1', speechId: 'sp1', isNewTurn: true });
  socket.server('agent_raw_text', { speechId: 'sp1', delta: JSON.stringify({ type: 'avatar', content: text }) });
};

test('session: the incident order (reply text, no audio) gives one speech_not_started', async () => {
  const { socket, warnings, timings } = await connected({ speechStartGraceMs: 30 });
  reply(socket);
  socket.server('agent_end_turn', { turnId: 'T1', speechId: 'sp1' });
  socket.server('stvFinishedGenerating', { speechId: 'sp1' });
  await sleep(80);
  assert.equal(codes(warnings).length, 1);
  assert.equal(warnings.find((w) => w.code === 'speech_not_started').turnId, 'T1');
  assert.equal(timings.length, 1);
});

test('session: the healthy order gives no warning', async () => {
  const { socket, warnings } = await connected({ speechStartGraceMs: 30 });
  reply(socket);
  socket.server('stvSpeechChunk', { speechId: 'sp1', text: 'Happy to help', durationMs: 900 });
  socket.server('stvStartedTalking', {});
  socket.server('stvFinishedGenerating', { speechId: 'sp1' });
  socket.server('stvFinishedTalking', { agentContent: 'Happy to help' });
  await sleep(80);
  assert.deepEqual(codes(warnings), []);
});

test('session: interrupt, pause and disconnect stay quiet', async () => {
  const a = await connected({ speechStartGraceMs: 30 });
  reply(a.socket); a.socket.server('agentInterrupted', {}); a.socket.server('stvFinishedGenerating', { speechId: 'sp1' });
  await sleep(80);
  assert.deepEqual(codes(a.warnings), [], 'interrupt');

  const b = await connected({ speechStartGraceMs: 30 });
  reply(b.socket); b.socket.server('stvFinishedGenerating', { speechId: 'sp1' }); b.session.pause();
  await sleep(80);
  assert.deepEqual(codes(b.warnings), [], 'pause');

  const c = await connected({ speechStartGraceMs: 30 });
  reply(c.socket); c.socket.server('stvFinishedGenerating', { speechId: 'sp1' }); await c.session.disconnect();
  await sleep(80);
  assert.deepEqual(codes(c.warnings), [], 'disconnect');
});

test('session: a silent opening and a server check-in stay quiet', async () => {
  const a = await connected({ speechStartGraceMs: 30 });
  a.socket.server('agent_start_speech', { turnId: 'T0', speechId: 'sp0', isNewTurn: true });
  a.socket.server('stvSpeechChunk', { speechId: 'sp0', text: '<blank>', durationMs: 0 });
  a.socket.server('stvFinishedGenerating', { speechId: 'sp0' });
  await sleep(80);
  assert.deepEqual(codes(a.warnings), []);
});

test('session: config_language_differs fires from the client configuration', async () => {
  const { warnings } = await connected({}, { clientConfig: { languageCode: 'en', asr: { language: 'he', provider: 'kaltura' } } });
  assert.equal(warnings.filter((w) => w.code === 'config_language_differs').length, 1);
});

test('session: tool_heavy_turn counts raw tool segments', async () => {
  const { socket, warnings } = await connected({ toolHeavyLimit: 2 });
  socket.server('agent_start_speech', { turnId: 'T1', speechId: 'sp1', isNewTurn: true });
  for (let i = 0; i < 3; i++) socket.server('agent_raw_text', { delta: JSON.stringify({ type: 'tool', content: `fn${i} {"a":${i}}` }) });
  await sleep(10);
  assert.equal(warnings.filter((w) => w.code === 'tool_heavy_turn').length, 1);
});
