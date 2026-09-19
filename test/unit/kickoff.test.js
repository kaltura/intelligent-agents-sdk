/**
 * KalturaAvatarSession `kickoff` + the silent-opening filter + `responsePending` on
 * the server's think-ack. Fake socket, fake RTC, no network.
 *
 * The kickoff rides the same hold path as `speak()`: it is queued the moment
 * `connect()` resolves and released by the opening turn's `stvFinishedTalking`
 * (or `agentInterrupted`). Nothing here depends on a timer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession, SILENT_OPENING } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor, fakeGetUserMedia } from '../fakes/rtc.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const KICKOFF = 'Greet the user and briefly say how you can help.';
const OPENING_ID = 'abcd-approved-permissions';

function newSession(overrides = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const whepFetch = async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } });
  const session = new KalturaAvatarSession({
    token: CONV_KS,
    srsBaseUrl: 'https://srs.example',
    turnServerUrl: 'turn.avatar.us.kaltura.ai',
    videoEl: new FakeVideoEl({ autoCanPlay: true }),
    socketFactory: () => socket,
    rtcConstructor: FakeRTCPeerConnection,
    fetch: whepFetch,
    getUserMedia: fakeGetUserMedia(),
    mediaStreamConstructor: FakeMediaStreamCtor,
    networkAware: false,
    ...(overrides.cfg || {}),
  });
  return { session, socket };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const sentTexts = (socket) => socket.emitsOf('onTextEntered').filter((p) => p.text !== '').map((p) => p.text);
const finishOpening = (socket, text = SILENT_OPENING) => {
  socket.server('stvStartedTalking', {});
  socket.server('stvFinishedTalking', { agentContent: text });
};
function collect(session, ev) {
  const out = [];
  session.on(ev, (p) => out.push(p));
  return out;
}

// ─────────────────────────── config validation ───────────────────────────

test('kickoff: string and object forms normalize; getter reports {text, echo, sent}', () => {
  const a = newSession({ cfg: { kickoff: KICKOFF } }).session;
  assert.deepEqual(a.kickoff, { text: KICKOFF, echo: false, sent: false });
  const b = newSession({ cfg: { kickoff: { text: KICKOFF, echo: true } } }).session;
  assert.deepEqual(b.kickoff, { text: KICKOFF, echo: true, sent: false });
  const c = newSession({ cfg: { kickoff: { text: KICKOFF } } }).session;
  assert.equal(c.kickoff.echo, false);
});

test('kickoff: omitted / null / empty / whitespace → null (nothing to send)', () => {
  assert.equal(newSession().session.kickoff, null);
  assert.equal(newSession({ cfg: { kickoff: null } }).session.kickoff, null);
  assert.equal(newSession({ cfg: { kickoff: '' } }).session.kickoff, null);
  assert.equal(newSession({ cfg: { kickoff: '   \n' } }).session.kickoff, null);
  assert.equal(newSession({ cfg: { kickoff: { text: '  ' } } }).session.kickoff, null);
});

test('kickoff: wrong shapes throw bad_request at construction', () => {
  for (const bad of [5, true, ['hi'], { text: 1 }, { text: 'x', echo: 'yes' }, {}]) {
    assert.throws(() => newSession({ cfg: { kickoff: bad } }), (e) => e.code === 'bad_request', `kickoff=${JSON.stringify(bad)}`);
  }
});

// ─────────────────────────── send timing ───────────────────────────

test('kickoff is held through the opening turn and sent on stvFinishedTalking, exactly once', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: KICKOFF } });
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  assert.deepEqual(sentTexts(socket), [], 'nothing on the wire while the opening turn runs');
  assert.deepEqual(session.kickoff, { text: KICKOFF, echo: false, sent: true });
  finishOpening(socket);
  assert.deepEqual(sentTexts(socket), [KICKOFF]);
  // A later opening-shaped event pair never re-sends it.
  finishOpening(socket);
  await settle();
  assert.deepEqual(sentTexts(socket), [KICKOFF]);
});

test('kickoff is released by agentInterrupted too', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: KICKOFF } });
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  socket.server('stvStartedTalking', {});
  socket.server('agentInterrupted', {});
  assert.deepEqual(sentTexts(socket), [KICKOFF]);
});

test('kickoff with no opening in flight (state connected, not uninterruptible) goes out on its own', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: KICKOFF } });
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  assert.deepEqual(sentTexts(socket), []);
  // The very first `onTextEntered` marker + payload pair is emitted by _sendTurn; check the marker too.
  finishOpening(socket);
  const all = socket.emitsOf('onTextEntered');
  assert.equal(all.length, 2, 'one empty marker + one payload');
  assert.equal(all[0].text, '');
  assert.equal(all[1].text, KICKOFF);
});

test('speak() typed during the opening coalesces with the kickoff into one turn', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: KICKOFF } });
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  const typed = session.speak('hi');
  await settle();
  assert.deepEqual(sentTexts(socket), []);
  finishOpening(socket);
  assert.deepEqual(sentTexts(socket), [`${KICKOFF}\nhi`]);
  assert.equal(await typed, true);
  // The joined echo strips the kickoff line and shows only what the user typed.
  const users = collect(session, 'transcript');
  socket.server('agentTurnToTalk', { userTranscription: `${KICKOFF}\nhi` });
  assert.deepEqual(users.filter((t) => t.type === 'user').map((t) => t.text), ['hi']);
});

test('disconnect() during the opening drops the held kickoff: nothing sent, no kickoff_failed', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: KICKOFF } });
  const warnings = collect(session, 'warning');
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  session.disconnect();
  await settle();
  assert.deepEqual(sentTexts(socket), []);
  assert.equal(warnings.filter((w) => w.code === 'kickoff_failed').length, 0);
  assert.equal(session.kickoff.sent, true);
});

// ─────────────────────────── echo ───────────────────────────

test('kickoff echo is suppressed by default: the server echo of the kickoff text emits no user transcript, once', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: KICKOFF } });
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  finishOpening(socket);
  const transcripts = collect(session, 'transcript');
  socket.server('agentTurnToTalk', { userTranscription: KICKOFF });
  assert.deepEqual(transcripts.filter((t) => t.type === 'user'), []);
  // Only the first echo is swallowed; a user who later types the same text still sees it.
  socket.server('agentTurnToTalk', { userTranscription: KICKOFF });
  assert.deepEqual(transcripts.filter((t) => t.type === 'user').map((t) => t.text), [KICKOFF]);
});

test('kickoff echo:true shows the kickoff as a user transcript', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: { text: KICKOFF, echo: true } } });
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  finishOpening(socket);
  const transcripts = collect(session, 'transcript');
  socket.server('agentTurnToTalk', { userTranscription: KICKOFF });
  assert.deepEqual(transcripts.filter((t) => t.type === 'user').map((t) => t.text), [KICKOFF]);
});

test('an unrelated user transcript is never affected by echo suppression', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: KICKOFF } });
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  finishOpening(socket);
  const transcripts = collect(session, 'transcript');
  socket.server('agentTurnToTalk', { userTranscription: 'what time is it?' });
  assert.deepEqual(transcripts.filter((t) => t.type === 'user').map((t) => t.text), ['what time is it?']);
});

// ─────────────────────────── never re-sent ───────────────────────────

test('kickoff is not re-sent after pause() → pauseSessionExpired → resume()', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: KICKOFF } });
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  finishOpening(socket);
  assert.deepEqual(sentTexts(socket), [KICKOFF]);
  session.pause();
  socket.server('pauseSessionExpired', {});
  await session.resume();
  assert.equal(session.state, 'connected');
  await settle();
  finishOpening(socket);   // the replayed opening turn
  await settle();
  assert.deepEqual(sentTexts(socket), [KICKOFF]);
  assert.equal(session.kickoff.sent, true);
});

test('kickoff is not re-sent after a cold reconnect', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: KICKOFF } });
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  finishOpening(socket);
  assert.deepEqual(sentTexts(socket), [KICKOFF]);
  await session._coldReconnect('media stv failed');
  assert.equal(session.state, 'connected');
  await settle();
  finishOpening(socket);
  await settle();
  assert.deepEqual(sentTexts(socket), [KICKOFF]);
});

test('a held kickoff survives a cold reconnect that lands before the opening finished', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: KICKOFF } });
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  assert.deepEqual(sentTexts(socket), []);
  await session._coldReconnect('media stv failed');
  await settle();
  assert.deepEqual(sentTexts(socket), [], 'still held: the new opening turn has not finished');
  finishOpening(socket);
  assert.deepEqual(sentTexts(socket), [KICKOFF]);
});

// ─────────────────────────── disclosure gate ───────────────────────────

test('requireDisclosureAck: kickoff waits for acknowledgeDisclosure(), then for the opening it releases', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: KICKOFF, requireDisclosureAck: true } });
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  assert.equal(socket.didEmit('approvedPermissions'), false, 'the opening turn is not started before the ack');
  assert.deepEqual(sentTexts(socket), []);
  assert.equal(session.kickoff.sent, false);
  session.acknowledgeDisclosure();   // approves → opening turn starts → kickoff queued behind it
  await settle();
  assert.equal(socket.didEmit('approvedPermissions'), true);
  assert.deepEqual(sentTexts(socket), []);
  assert.equal(session.kickoff.sent, true);
  finishOpening(socket);
  assert.deepEqual(sentTexts(socket), [KICKOFF]);
  // Idempotent: a second ack never re-sends.
  session.acknowledgeDisclosure();
  await settle();
  finishOpening(socket);
  assert.deepEqual(sentTexts(socket), [KICKOFF]);
});

// ─────────────────────────── failure ───────────────────────────

test('kickoff blocked by onBeforeSend → warning kickoff_failed, nothing sent, echo suppression disarmed', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: KICKOFF, onBeforeSend: () => false } });
  const warnings = collect(session, 'warning');
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  finishOpening(socket);
  await settle();
  assert.deepEqual(sentTexts(socket), []);
  const w = warnings.filter((x) => x.code === 'kickoff_failed');
  assert.equal(w.length, 1);
  assert.equal(typeof w[0].detail, 'string');
  assert.equal(session.kickoff.sent, true, 'sent means handed off; the SDK never retries');
  // With no kickoff on the wire there is nothing to strip.
  const transcripts = collect(session, 'transcript');
  socket.server('agentTurnToTalk', { userTranscription: KICKOFF });
  assert.deepEqual(transcripts.filter((t) => t.type === 'user').map((t) => t.text), [KICKOFF]);
});

test('onBeforeSend rewrite still sends the rewritten kickoff (echo then no longer matches)', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: KICKOFF, onBeforeSend: (t) => `${t} [ctx]` } });
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  finishOpening(socket);
  assert.deepEqual(sentTexts(socket), [`${KICKOFF} [ctx]`]);
  const transcripts = collect(session, 'transcript');
  socket.server('agentTurnToTalk', { userTranscription: `${KICKOFF} [ctx]` });
  assert.deepEqual(transcripts.filter((t) => t.type === 'user').map((t) => t.text), [`${KICKOFF} [ctx]`]);
});

// ─────────────────────────── silent-opening filter ───────────────────────────

test(`silent opening: '${SILENT_OPENING}' on the opening speechId emits no transcript/speechChunk; start/stop still fire`, async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const transcripts = collect(session, 'transcript');
  const chunks = collect(session, 'speechChunk');
  const starts = collect(session, 'avatarStartTalking');
  const stops = collect(session, 'avatarStopTalking');
  socket.server('generatingSpeech', { speechId: OPENING_ID, text: SILENT_OPENING });
  socket.server('stvStartedTalking', {});
  socket.server('stvSpeechChunk', { speechId: OPENING_ID, text: SILENT_OPENING, durationMs: 10 });
  socket.server('stvFinishedTalking', { agentContent: SILENT_OPENING });
  assert.deepEqual(transcripts, []);
  assert.deepEqual(chunks, []);
  assert.equal(starts.length, 1);
  assert.equal(stops.length, 1);
  // stvFinishedTalking carries no speechId, so the stop payload is blanked by text alone.
  assert.deepEqual(stops[0], { text: '' });
});

test('silent opening: a spoken opening phrase on the opening speechId still surfaces', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const transcripts = collect(session, 'transcript');
  const chunks = collect(session, 'speechChunk');
  const stops = collect(session, 'avatarStopTalking');
  socket.server('generatingSpeech', { speechId: OPENING_ID, text: 'Hello!' });
  socket.server('stvSpeechChunk', { speechId: OPENING_ID, text: 'Hello!', durationMs: 400 });
  socket.server('stvFinishedTalking', { agentContent: 'Hello!' });
  // generatingSpeech emits the final line; the chunk tracker emits its own transcript too.
  assert.ok(transcripts.length >= 1);
  assert.ok(transcripts.every((t) => t.text === 'Hello!'));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, 'Hello!');
  assert.deepEqual(stops, [{ text: 'Hello!' }]);
});

test(`silent opening: '${SILENT_OPENING}' on a normal reply speechId is not filtered`, async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  finishOpening(socket);
  const transcripts = collect(session, 'transcript');
  socket.server('generatingSpeech', { speechId: 'reply-1', text: SILENT_OPENING });
  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].text, SILENT_OPENING);
});

// ─────────────────────────── responsePending on think-ack ───────────────────────────

test('responsePending arms on the first think delta and settles on the first non-think delta, idempotently', async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  finishOpening(socket);   // stvStartedTalking settles anything armed by connect
  assert.equal(session.responsePending, false);
  const pending = collect(session, 'responsePending');
  const settled = collect(session, 'responseSettled');
  socket.server('agent_raw_text', { delta: JSON.stringify({ type: 'think', content: '' }), speechId: 's1' });
  socket.server('agent_raw_text', { delta: JSON.stringify({ type: 'think', content: 'still thinking' }), speechId: 's1' });
  assert.equal(pending.length, 1);
  assert.equal(settled.length, 0);
  assert.equal(session.responsePending, true);
  socket.server('agent_raw_text', { delta: JSON.stringify({ type: 'text', content: 'Hi' }), speechId: 's1' });
  socket.server('agent_raw_text', { delta: JSON.stringify({ type: 'text', content: ' there' }), speechId: 's1' });
  assert.equal(pending.length, 1);
  assert.equal(settled.length, 1);
  assert.equal(session.responsePending, false);
});

test('responsePending: a kickoff arms it on send and the think ack does not double-fire', async () => {
  const { session, socket } = newSession({ cfg: { kickoff: KICKOFF } });
  scriptHappyPath(socket);
  await session.connect();
  await settle();
  const pending = collect(session, 'responsePending');
  const settled = collect(session, 'responseSettled');
  finishOpening(socket);   // releases the kickoff → _sendTurn arms
  assert.equal(pending.length, 1);
  socket.server('agent_raw_text', { delta: JSON.stringify({ type: 'think', content: '' }), speechId: 's1' });
  assert.equal(pending.length, 1);
  socket.server('stvStartedTalking', {});
  assert.equal(settled.length, 1);
});
