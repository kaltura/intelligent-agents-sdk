import { Management } from '../../src/management/index.js';
import { $, getConfig, fillRows, logLine, ready, describe } from './common.js';

const cfg = await getConfig();
const kaltura = new Management({ partnerId: cfg.partnerId, genieUrl: cfg.genieUrl });
const ks = cfg.conversationKs;
const s = { threadId: null, messageId: null, saved: null, side: null, forkThread: null, forkSaved: null, sourceAfterFork: null };

const count = async (threadId) => (await kaltura.messages.list(ks, { threadId })).length;
function show() {
  fillRows('state', [
    ['thread', s.threadId ? 'created' : null],
    ['saved messages in thread', s.saved],
    ['side answer', s.side],
    ['saved messages after side question', s.sideSaved],
    ['fork thread', s.forkThread ? (s.forkThread === s.threadId ? 'SAME thread' : 'new thread') : null],
    ['saved messages in fork', s.forkSaved],
    ['saved messages in source after fork', s.sourceAfterFork],
  ]);
}
async function run(label, fn) {
  try { await fn(); logLine('log', `${label}: done`, 'ok'); } catch (err) { logLine('log', `${label}: ${describe(err)}`, 'bad'); }
  show();
  document.body.dataset.step = label;
}

$('start').addEventListener('click', () => run('start', async () => {
  const turn = await kaltura.converseOnce(cfg.configId, 'Remember this word: pelican. Reply with one short sentence.', {}, ks);
  s.threadId = turn.threadId; s.messageId = turn.messageId;
  s.saved = await count(s.threadId);
}));
$('side').addEventListener('click', () => run('side', async () => {
  const turn = await kaltura.converseOnce(cfg.configId, 'What word did I ask you to remember? One word only.', { threadId: s.threadId, add_message_in_db: false }, ks);
  s.side = turn.text;
  s.sideSaved = await count(s.threadId);
}));
$('fork').addEventListener('click', () => run('fork', async () => {
  const turn = await kaltura.converseOnce(cfg.configId, 'Say hello in one short sentence.', { shared_message_id: s.messageId }, ks);
  s.forkThread = turn.threadId;
  s.forkSaved = await count(turn.threadId);
  s.sourceAfterFork = await count(s.threadId);
}));
show();
ready();
