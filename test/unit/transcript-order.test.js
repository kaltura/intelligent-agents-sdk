/**
 * Spoken-turn transcript order. On a spoken turn the server sends the reply's first
 * sentence (`generatingSpeech`) BEFORE the user's words (`agentTurnToTalk.userTranscription`),
 * so `transcript` events arrive reply-first. The SDK stamps the user line with the
 * `speechId` of the reply it prompted, and `TranscriptLog` uses that to restore speaking
 * order. These tests pin the wire order, the stamp and the restored order, so a change to
 * any of the three fails here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession, TranscriptLog } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor, fakeGetUserMedia } from '../fakes/rtc.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const KICKOFF = 'Greet the user and briefly say how you can help.';

async function connected(cfg = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({
    token: CONV_KS,
    srsBaseUrl: 'https://srs.example',
    turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl({ autoCanPlay: true }),
    socketFactory: () => socket,
    rtcConstructor: FakeRTCPeerConnection,
    fetch: async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } }),
    getUserMedia: fakeGetUserMedia(),
    mediaStreamConstructor: FakeMediaStreamCtor,
    networkAware: false,
    ...cfg,
  });
  scriptHappyPath(socket);
  await session.connect();
  const events = [];
  const log = new TranscriptLog();
  session.on('transcript', (tr) => { events.push(tr); log.add(tr); });
  return { session, socket, events, log };
}

/** What the server sends for one spoken turn, in the order it sends it. */
const spoken = (socket, id, user, sentences) => {
  socket.server('userStartedTalking', {});
  socket.server('agent_start_speech', { speechId: id, turnId: `t-${id}`, isNewTurn: true });
  socket.server('generatingSpeech', { text: sentences[0], speechId: id });
  socket.server('agentTurnToTalk', { userTranscription: user });
  sentences.slice(1).forEach((s) => socket.server('generatingSpeech', { text: s, speechId: id }));
  socket.server('stvStartedTalking', {});
  socket.server('stvFinishedTalking', { agentContent: sentences.join(' ') });
};

const lines = (log) => log.entries.map((e) => `${e.role}:${e.text}`);

test('wire order: the reply sentence arrives before the user line, and both carry the same speechId', async () => {
  const { socket, events, session } = await connected();
  spoken(socket, 'a1-transcript-hi', 'How do I reset?', ['Go to settings.']);
  const lineEvents = events.filter((t) => t.type === 'final' || t.type === 'user');
  assert.deepEqual(lineEvents.map((t) => t.type), ['final', 'user'], 'the server sends the reply first');
  assert.equal(lineEvents[0].speechId, 'a1-transcript-hi');
  assert.equal(lineEvents[1].speechId, 'a1-transcript-hi', 'the user line names the reply it prompted');
  session.disconnect();
});

test('TranscriptLog restores speaking order for a spoken turn', async () => {
  const { socket, log, session } = await connected();
  spoken(socket, 'a1', 'How do I reset?', ['Go to settings.']);
  assert.deepEqual(lines(log), ['user:How do I reset?', 'agent:Go to settings.']);
  session.disconnect();
});

test('a multi-sentence reply keeps one user line in front of all of its sentences', async () => {
  const { socket, log, session } = await connected();
  spoken(socket, 'a1', 'Explain agents.', ['First.', 'Second.', 'Third.']);
  assert.deepEqual(lines(log), ['user:Explain agents.', 'agent:First.', 'agent:Second.', 'agent:Third.']);
  session.disconnect();
});

test('back-to-back spoken turns stay in speaking order', async () => {
  const { socket, log, session } = await connected();
  spoken(socket, 'a1', 'Question one?', ['Answer one.']);
  spoken(socket, 'b2', 'Question two?', ['Answer two.', 'More two.']);
  spoken(socket, 'c3', 'Bye.', ['Goodbye!']);
  assert.deepEqual(lines(log), [
    'user:Question one?', 'agent:Answer one.',
    'user:Question two?', 'agent:Answer two.', 'agent:More two.',
    'user:Bye.', 'agent:Goodbye!',
  ]);
  session.disconnect();
});

test('the stamp is the newest reply speechId: an ASR re-send moves the user line to the new reply', async () => {
  const { socket, events, session } = await connected();
  socket.server('agent_start_speech', { speechId: 'a1-first-cut', turnId: 't1', isNewTurn: true });
  socket.server('agentInterrupted', {});
  socket.server('agent_start_speech', { speechId: 'b2-corrected', turnId: 't1', isNewTurn: false });
  socket.server('generatingSpeech', { text: 'Reply.', speechId: 'b2-corrected' });
  socket.server('agentTurnToTalk', { userTranscription: 'corrected question' });
  assert.equal(events.find((t) => t.type === 'user').speechId, 'b2-corrected');
  session.disconnect();
});

test('the stamp is set from agent_start_speech even before any reply sentence exists', async () => {
  const { socket, events, session } = await connected();
  socket.server('agent_start_speech', { speechId: 'a1', turnId: 't1', isNewTurn: true });
  socket.server('agentTurnToTalk', { userTranscription: 'hello' });
  assert.equal(events.find((t) => t.type === 'user').speechId, 'a1');
  session.disconnect();
});

test('a reply is claimed once: a second user line with no new reply is not stamped', async () => {
  const { socket, events, log, session } = await connected();
  spoken(socket, 'a1', 'First?', ['One.']);
  socket.server('agentTurnToTalk', { userTranscription: 'stray text' });
  const users = events.filter((t) => t.type === 'user');
  assert.equal(users[0].speechId, 'a1');
  assert.equal(users[1].speechId, null, 'no unclaimed reply, so it is never pinned to an old one');
  assert.deepEqual(lines(log), ['user:First?', 'agent:One.', 'user:stray text'], 'an unstamped line goes at the end');
  session.disconnect();
});

test('a turn with no user text (greeting, check-in, goodbye) emits no user line and claims nothing', async () => {
  const { socket, events, log, session } = await connected();
  socket.server('agent_start_speech', { speechId: 'w0-wakeup', turnId: 't0', isNewTurn: true });
  socket.server('generatingSpeech', { text: 'Are you still there?', speechId: 'w0-wakeup' });
  socket.server('agentTurnToTalk', {});
  assert.equal(events.filter((t) => t.type === 'user').length, 0);
  spoken(socket, 'a1', 'Yes, I am.', ['Great.']);
  assert.deepEqual(lines(log), ['agent:Are you still there?', 'user:Yes, I am.', 'agent:Great.']);
  session.disconnect();
});

test('a user line that arrives with no reply seen yet is unstamped and appended', async () => {
  const { socket, events, log, session } = await connected();
  socket.server('agentTurnToTalk', { userTranscription: 'hello' });
  assert.equal(events.find((t) => t.type === 'user').speechId, null);
  assert.deepEqual(lines(log), ['user:hello']);
  session.disconnect();
});

test('a dropped kickoff echo still uses up its reply, so later text is not pinned to it', async () => {
  const { socket, events, session } = await connected({ kickoff: { text: KICKOFF, echo: false } });
  socket.server('stvFinishedTalking', {});   // the silent opening ends and releases the kickoff
  socket.server('agent_start_speech', { speechId: 'k1', turnId: 't1', isNewTurn: true });
  socket.server('generatingSpeech', { text: 'Welcome!', speechId: 'k1' });
  socket.server('agentTurnToTalk', { userTranscription: KICKOFF });
  assert.equal(events.filter((t) => t.type === 'user').length, 0, 'the echo is dropped');
  socket.server('agentTurnToTalk', { userTranscription: 'hello there' });
  assert.equal(events.find((t) => t.type === 'user').speechId, null);
  session.disconnect();
});

test('conversationResumed clears the pending reply, so a resumed session never pairs with the old one', async () => {
  const { socket, events, session } = await connected();
  socket.server('agent_start_speech', { speechId: 'a1', turnId: 't1', isNewTurn: true });
  socket.server('conversationResumed', {});
  socket.server('agentTurnToTalk', { userTranscription: 'after resume' });
  assert.equal(events.find((t) => t.type === 'user').speechId, null);
  session.disconnect();
});

test('typed turns (user line first, no speechId) keep arrival order', () => {
  const log = new TranscriptLog();
  log.add({ type: 'user', text: 'typed', speechId: null });
  log.add({ type: 'final', text: 'Reply one.', speechId: null });
  log.add({ type: 'final', text: 'Reply two.', speechId: null });
  assert.deepEqual(lines(log), ['user:typed', 'agent:Reply one.', 'agent:Reply two.']);
});

test('every legal server interleaving ends in speaking order (seeded, 300 conversations)', async () => {
  // Server contract: a turn's user line comes after the first reply sentence and before the
  // next turn starts. Sentences may land before or after it. Anything inside that window must
  // restore to [user, ...sentences] for every turn.
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const { socket, log, session } = await connected();
  for (let run = 0; run < 300; run++) {
    log.clear();
    const expected = [];
    const turns = 1 + rnd(5);
    for (let t = 0; t < turns; t++) {
      const id = `s${run}-${t}`;
      const n = 1 + rnd(4);
      const sentences = Array.from({ length: n }, (_, i) => `r${t}.${i}`);
      const userAt = 1 + rnd(n);   // the user line lands after this many sentences
      expected.push(`user:u${t}`, ...sentences.map((s) => `agent:${s}`));
      socket.server('agent_start_speech', { speechId: id, turnId: `t${t}`, isNewTurn: true });
      sentences.forEach((s, i) => {
        socket.server('generatingSpeech', { text: s, speechId: id });
        if (i + 1 === userAt) socket.server('agentTurnToTalk', { userTranscription: `u${t}` });
      });
      socket.server('stvFinishedTalking', {});
    }
    assert.deepEqual(lines(log), expected, `run ${run}`);
  }
  session.disconnect();
});

// ── TranscriptLog unit behavior ───────────────────────────────────────────────

test('TranscriptLog.add reports where each line landed', () => {
  const log = new TranscriptLog();
  assert.deepEqual(log.add({ type: 'final', text: 'Reply.', speechId: 's1' }), { index: 0, entry: { role: 'agent', text: 'Reply.', speechId: 's1' } });
  assert.deepEqual(log.add({ type: 'user', text: 'Q?', speechId: 's1' }), { index: 0, entry: { role: 'user', text: 'Q?', speechId: 's1' } });
  assert.equal(log.add({ type: 'final', text: 'More.', speechId: 's1' }).index, 2, 'agent lines always append');
});

test('TranscriptLog ignores partial captions, empty text and bad input', () => {
  const log = new TranscriptLog();
  assert.equal(log.add({ type: 'partial', text: 'caption', speechId: 's1' }), null);
  assert.equal(log.add({ type: 'final', text: '', speechId: 's1' }), null);
  assert.equal(log.add({ type: 'user', speechId: 's1' }), null);
  assert.equal(log.add({ type: 'other', text: 'x' }), null);
  assert.equal(log.add(null), null);
  assert.equal(log.add(undefined), null);
  assert.deepEqual(log.entries, []);
});

test('TranscriptLog: a user line for an unseen reply appends, and two user lines for one reply keep their order', () => {
  const log = new TranscriptLog();
  log.add({ type: 'user', text: 'early', speechId: 'unseen' });
  log.add({ type: 'final', text: 'Reply.', speechId: 's1' });
  log.add({ type: 'user', text: 'first', speechId: 's1' });
  log.add({ type: 'user', text: 'second', speechId: 's1' });
  assert.deepEqual(lines(log), ['user:early', 'user:first', 'user:second', 'agent:Reply.']);
});

test('TranscriptLog: a late user line goes before its own reply, never before an earlier turn', () => {
  const log = new TranscriptLog();
  log.add({ type: 'final', text: 'A.', speechId: 's1' });
  log.add({ type: 'final', text: 'B.', speechId: 's2' });
  log.add({ type: 'user', text: 'Q2', speechId: 's2' });
  assert.deepEqual(lines(log), ['agent:A.', 'user:Q2', 'agent:B.']);
});

test('TranscriptLog.entries is a copy and clear() empties the log', () => {
  const log = new TranscriptLog();
  log.add({ type: 'final', text: 'A.', speechId: 's1' });
  log.entries.length = 0;
  assert.equal(log.entries.length, 1, 'editing the copy does not change the log');
  log.clear();
  assert.deepEqual(log.entries, []);
});
