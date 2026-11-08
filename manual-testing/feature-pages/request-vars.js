import { Management } from '../../src/management/index.js';
import { $, getConfig, fillRows, logLine, countingFetch, ready } from './common.js';

const cfg = await getConfig();
const { fetch: counted, calls } = countingFetch((line) => logLine('calls', line));
const kaltura = new Management({ partnerId: cfg.partnerId, genieUrl: cfg.genieUrl, fetch: counted });

async function attempt(requestVars) {
  const before = calls.length;
  try {
    const turn = await kaltura.converseOnce(cfg.configId, `Reply with only the favourite colour, as one word. (${Date.now()})`, { request_vars: requestVars }, cfg.conversationKs);
    fillRows('result', [['outcome', 'accepted'], ['reply', turn.text], ['network calls', calls.length - before]]);
  } catch (err) {
    fillRows('result', [['outcome', 'refused'], ['code', err?.code], ['detail', err?.detail || err?.message], ['network calls', calls.length - before]]);
  }
  document.body.dataset.done = String(Number(document.body.dataset.done || 0) + 1);
}

$('bad').addEventListener('click', () => attempt({ sys__demo: 'x' }));
$('good').addEventListener('click', () => attempt({ [cfg.customVar]: 'teal' }));
ready();
