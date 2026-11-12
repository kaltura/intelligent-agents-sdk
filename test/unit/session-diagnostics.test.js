/**
 * `session.diagnostics()` and `formatDiagnostics()`: a short record for a bug report that
 * never holds speech, names, tokens or tool arguments.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticsLog, DIAGNOSTICS_MAX_EVENTS, formatDiagnostics } from '../../src/experience/diagnostics.js';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor, fakeGetUserMedia } from '../fakes/rtc.js';

function log() {
  let t = 0;
  const l = new DiagnosticsLog(() => t);
  return { l, tick: (ms) => { t += ms; } };
}

test('records only listed events and only their listed fields', () => {
  const { l, tick } = log();
  tick(50);
  l.record('stateChange', { state: 'connected', secret: 'x' });
  l.record('transcript', { text: 'hello' });
  l.record('toolCall', { name: 'lookup', args: { q: 'x' } });
  l.record('micStarted', {});
  assert.deepEqual(l.events(), [{ t: 50, event: 'stateChange', data: { state: 'connected' } }]);
});

test('drops free text, objects and non-finite numbers even in a listed field', () => {
  const { l } = log();
  l.record('ended', { reason: 'the customer said their card number is 4111 1111 1111 1111 please' });
  l.record('ended', { reason: { nested: 'x' } });
  l.record('turnTimings', { turnId: 'T1', firstSegmentMs: NaN, finishedMs: 1200, toolCalls: Infinity });
  assert.deepEqual(l.events().map((e) => e.data ?? null), [null, null, { turnId: 'T1', finishedMs: 1200 }]);
});

test('an error keeps code, phase, retryable and status, not the message', () => {
  const { l } = log();
  l.record('error', Object.assign(new Error('token djJ8SECRET failed for alice@example.com'), { code: 'socket_error', phase: 'join', retryable: true, status: 502 }));
  assert.deepEqual(l.events()[0].data, { code: 'socket_error', phase: 'join', retryable: true, status: 502 });
});

test('connectTimings keeps every numeric phase', () => {
  const { l } = log();
  l.record('connectTimings', { join: 120, ice: 800, label: 'a sentence that is not a plain word at all, really' });
  assert.deepEqual(l.events()[0].data, { join: 120, ice: 800 });
});

test('the ring keeps the last events; warning counts are not capped', () => {
  const { l } = log();
  for (let i = 0; i < DIAGNOSTICS_MAX_EVENTS + 50; i++) l.record('warning', { code: 'slow_turn', count: i });
  const events = l.events();
  assert.equal(events.length, DIAGNOSTICS_MAX_EVENTS);
  assert.equal(events[0].data.count, 50);
  assert.deepEqual(l.warningCounts(), { slow_turn: DIAGNOSTICS_MAX_EVENTS + 50 });
});

test('events() and warningCounts() return copies', () => {
  const { l } = log();
  l.record('warning', { code: 'x_code' });
  l.events()[0].data.code = 'changed';
  l.warningCounts().x_code = 99;
  assert.equal(l.events()[0].data.code, 'x_code');
  assert.equal(l.warningCounts().x_code, 1);
});

// ─────────────────────────── session ───────────────────────────

const TOKEN_SECRET = 'v2|123|geniegpcid:1222';
const CONV_KS = 'djJ8' + Buffer.from(TOKEN_SECRET).toString('base64url');
async function connected() {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } }),
    getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false, speechStartGraceMs: 20,
  });
  scriptHappyPath(socket);
  await session.connect();
  return { session, socket };
}

test('diagnostics(): state, timings, config, events and the ICE report after a connect', async () => {
  const { session } = await connected();
  const d = await session.diagnostics();
  assert.equal(d.schemaVersion, 1);
  assert.equal(d.session.state, 'connected');
  assert.ok(Object.keys(d.connectTimings).length > 0);
  assert.ok(d.events.some((e) => e.event === 'stateChange' && e.data.state === 'connected'));
  assert.ok(d.events.some((e) => e.event === 'connectTimings'));
  assert.ok('asr' in d.ice && 'stv' in d.ice);
  assert.deepEqual(d.events.map((e) => e.t), [...d.events.map((e) => e.t)].sort((a, b) => a - b), 'oldest first');
});

test('diagnostics(): holds no speech, tool arguments or token, and counts a turn warning', async () => {
  const { session, socket } = await connected();
  socket.server('agent_start_speech', { turnId: 'T1', speechId: 'sp1', isNewTurn: true });
  socket.server('agent_raw_text', { speechId: 'sp1', delta: JSON.stringify({ type: 'avatar', content: 'PRIVATE-REPLY-TEXT for Dana Levi' }) });
  socket.server('agent_raw_text', { speechId: 'sp1', delta: 'lookup_order {"order":"PRIVATE-ARG-9912"}' });
  socket.server('stvFinishedGenerating', { speechId: 'sp1' });
  await new Promise((r) => setTimeout(r, 60));
  const d = await session.diagnostics();
  assert.equal(d.warnings.speech_not_started, 1);
  const text = JSON.stringify(d) + formatDiagnostics(d);
  for (const secret of ['PRIVATE-REPLY', 'Dana', 'PRIVATE-ARG', 'geniegpcid', CONV_KS, 'srs.example', 'turn.example.com']) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test('formatDiagnostics(): a summary, the warning counts and one line per event', async () => {
  const { session } = await connected();
  const out = formatDiagnostics(await session.diagnostics());
  assert.match(out, /^session: connected, mode video/);
  assert.match(out, /\nwarnings: none\n/);
  assert.match(out, /\nevents:\n {2}\s*\d+ ms {2}stateChange state=preparing/);
});

test('diagnostics() works before connect and never rejects', async () => {
  const s = new KalturaAvatarSession({ token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com', socketFactory: () => new FakeSocket() });
  const d = await s.diagnostics();
  assert.equal(d.session.state, 'idle');
  assert.equal(d.config, null);
  assert.deepEqual(d.events, []);
  assert.equal(typeof formatDiagnostics(d), 'string');
});
