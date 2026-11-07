import { Management } from '../../src/management/index.js';
import { $, getConfig, fillRows, logLine, ready, describe } from './common.js';

const LABELS = new Set(['neutral', 'happy', 'sad', 'surprise']);
const cfg = await getConfig();
const kaltura = new Management({ partnerId: cfg.partnerId, genieUrl: cfg.genieUrl });

async function ask(emotions) {
  $('badges').replaceChildren();
  $('chunks').replaceChildren();
  let segments = 0; let withLabel = 0; let anyMeta = 0;
  try {
    const capabilities = { avatar: 'on', avatar_emotions: emotions ? 'on' : 'off' };
    for await (const seg of kaltura.conversations.stream({ userMessage: 'Tell me a short sad story, then cheer me up.', capabilities }, cfg.conversationKs)) {
      if (seg.metadata && 'emotion' in seg.metadata) anyMeta++;
      if (seg.type === 'avatar' && seg.segmentStart) {
        segments++;
        const raw = seg.metadata?.emotion;
        const known = typeof raw === 'string' && LABELS.has(raw);
        if (known) withLabel++;
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = known ? raw : raw ? 'unknown label' : 'no label';
        $('badges').append(badge);
        logLine('chunks', `segment ${segments}: ${known ? raw : raw ? 'unknown label' : 'no label'}`);
      }
    }
    fillRows('result', [['emotions', emotions ? 'on' : 'off'], ['avatar segments', segments], ['segments with a known label', withLabel], ['chunks carrying any emotion field', anyMeta]]);
  } catch (err) {
    fillRows('result', [['emotions', emotions ? 'on' : 'off'], ['error', describe(err)]]);
  }
  document.body.dataset.done = String(Number(document.body.dataset.done || 0) + 1);
}
$('on').addEventListener('click', () => ask(true));
$('off').addEventListener('click', () => ask(false));
ready();
