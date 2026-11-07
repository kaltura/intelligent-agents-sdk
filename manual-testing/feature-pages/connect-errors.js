import { KalturaAvatarSession } from '../../src/experience/index.js';
import { $, getConfig, fillRows, ready, describe } from './common.js';

const cfg = await getConfig();
const base = () => ({
  conversationManagerUrl: cfg.conversationManagerUrl,
  srsBaseUrl: cfg.srsBaseUrl,
  turnServerUrl: cfg.turnServerUrl,
  micStartMode: 'deferred',
  socketFactory: (url, opts) => globalThis.io(url, opts),
});

$('refuse').addEventListener('click', async () => {
  const session = new KalturaAvatarSession({ ...base(), token: 'not-a-real-token' });
  try {
    await session.connect();
    fillRows('error', [['outcome', 'connected (unexpected)']]);
  } catch (err) {
    fillRows('error', [['outcome', 'refused'], ['code', err?.code], ['serverCode', err?.serverCode], ['phase', err?.phase], ['retryable', err?.retryable]]);
  }
  try { await session.disconnect(); } catch { /* already closed */ }
  document.body.dataset.refused = 'true';
});

$('notice').addEventListener('click', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...a) => { warnings.push(a.map(String).join(' ')); };
  const session = new KalturaAvatarSession({ ...base(), token: cfg.avatarToken });
  try {
    await session.connect();
    session.submitStructuredDataForm({ email: 'demo@example.com' });
    session.submitStructuredDataForm({ email: 'demo@example.com' });
    fillRows('warn', [['connected', 'yes'], ['notices after two calls', warnings.length], ['notice text', warnings[0]]]);
  } catch (err) {
    fillRows('warn', [['connected', 'no'], ['error', describe(err)], ['notices', warnings.length]]);
  } finally {
    console.warn = original;
    try { await session.disconnect(); } catch { /* already closed */ }
  }
  document.body.dataset.noticeDone = 'true';
});
ready();
