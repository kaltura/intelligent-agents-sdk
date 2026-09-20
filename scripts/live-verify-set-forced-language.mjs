#!/usr/bin/env node
/**
 * Live runtime-effect check for `Management.setForcedLanguage()`. Provisions a
 * scratch agent with a language-neutral brief, forces Hebrew, sends an English
 * typed message, and checks the final transcript for Hebrew script. Compare
 * scripts/live-verify-force-language.mjs, which checks the bare
 * `force_language` field on its own.
 *
 * Pattern reused from scripts/live-verify-force-language.mjs: credential
 * loading, static file server with a real /appInit route, headless Chromium
 * with fake-media flags, full teardown in `finally`, post-delete
 * re-verification, artifacts written to live-verify-artifacts/. Only
 * provisions and tears down its own scratch agent.
 */
import { readFileSync, writeFileSync, mkdirSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, normalize, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { Management } from '../src/management/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

try {
  const env = readFileSync(resolve(repoRoot, '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // No .env file -- credentials must already be in the environment.
}

const partnerId = process.env.AGENTIC_PARTNER_ID;
const adminSecret = process.env.AGENTIC_ADMIN_SECRET;

if (!partnerId || !adminSecret) {
  console.error('AGENTIC_PARTNER_ID and AGENTIC_ADMIN_SECRET are required (env or repo-root .env).');
  process.exit(1);
}

const runId = `set-forced-language-runtime-check-${Date.now()}`;
const artifact = { runId, startedAt: new Date().toISOString(), partnerId, steps: [] };

function record(step, ok, detail) {
  artifact.steps.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${step}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

function startServer(appInitData) {
  const server = createServer((req, res) => {
    if (req.url === '/appInit') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(appInitData));
      return;
    }
    const urlPath = normalize(decodeURIComponent(req.url.split('?')[0]));
    const filePath = resolve(repoRoot, `.${urlPath}`);
    if (!filePath.startsWith(repoRoot) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  });
  return new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise(server)));
}

const HEBREW_RANGE = '֐-׿';
const HEBREW_RE = new RegExp(`[${HEBREW_RANGE}]`);
const QUESTION = 'What is your best product?';

/**
 * Chromium's fake capture device plays a 440 Hz tone, which speech recognition
 * transcribes as a stream of hallucinated user turns that barge in on the reply
 * this script waits for. Feeding it a silent PCM file instead keeps the whole
 * mic path real (getUserMedia, the ASR peer, VAD) with nothing for the
 * recognizer to invent words out of.
 *
 * @param {string} path Destination for the generated file.
 * @returns {string} The same path, for use in a Chromium launch flag.
 */
function writeSilentWav(path) {
  const rate = 48000;
  const dataLen = rate * 2; // 1 second, 16-bit mono. Chromium loops it.
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);   // PCM header size
  buf.writeUInt16LE(1, 20);    // format: PCM
  buf.writeUInt16LE(1, 22);    // channels
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);    // block align
  buf.writeUInt16LE(16, 34);   // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataLen, 40);
  writeFileSync(path, buf);
  return path;
}

const kaltura = new Management({ partnerId, adminSecret });
let admin;
let provisioned;
let server;
let browser;
let failed = false;
let createdSoFar = null;
const pageErrors = [];
const consoleLog = [];

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  provisioned = await kaltura.provision({ brief: 'A friendly multilingual test greeter', ks: admin.ks });
  record('provision', true, {
    configId: provisioned.configId, agentId: provisioned.agentId,
    avatarId: provisioned.avatarId, widgetId: provisioned.widgetId,
  });

  const setResult = await kaltura.setForcedLanguage(
    { configId: provisioned.configId, agentId: provisioned.agentId, language: 'he' },
    admin.ks,
  );
  record('setForcedLanguage-call', true, { languageName: setResult.languageName });

  const afterSet = await kaltura.intellects.get(provisioned.configId, admin.ks);
  const directiveUntouched = typeof afterSet?.base_directive === 'string' && !afterSet.base_directive.includes('<!-- sdk:forced-language -->');
  const forceLanguagePersisted = afterSet?.force_language === 'Hebrew';
  record('intellect-config-persisted', directiveUntouched && forceLanguagePersisted, {
    force_language: afterSet?.force_language, base_directive: afterSet?.base_directive,
  });
  if (!directiveUntouched || !forceLanguagePersisted) throw new Error('setForcedLanguage did not persist as expected on the intellect config.');

  const afterAgent = await kaltura.agents.get(provisioned.agentId, admin.ks);
  const asrPersisted = afterAgent?.asr?.language === 'he';
  record('agent-asr-persisted', asrPersisted, { asr: afterAgent?.asr });
  if (!asrPersisted) throw new Error(`asr.language did not persist as expected: got ${JSON.stringify(afterAgent?.asr)}`);

  let widgetId = provisioned.widgetId;
  if (!widgetId) {
    const wr = await kaltura.application.resolveWidgetId(provisioned.agentId, admin.ks);
    widgetId = wr?.widgetId;
  }
  if (!widgetId) throw new Error('no widgetId resolved after provision');

  const widget = await kaltura.sessions.createWidgetToken({ widgetId });
  record('widget-token-mint', true, { widgetId });

  const init = await kaltura.application.appInit(widget.ks);
  record('app-init', true, {
    conversationManagerUrl: init.conversationManagerUrl, srsBaseUrl: init.srsBaseUrl, turnServerUrl: init.turnServerUrl,
  });

  server = await startServer(init);
  const port = server.address().port;
  record('local-server-start', true, { port });

  const silentWav = writeSilentWav(join(tmpdir(), `${runId}-silence.wav`));
  browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${silentWav}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  record('silent-capture-file', true, { path: silentWav });
  const page = await browser.newPage();
  page.on('console', (msg) => {
    consoleLog.push(`[${msg.type()}] ${msg.text()}`);
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(`http://127.0.0.1:${port}/examples/browser-experience.html`, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => document.getElementById('log')?.textContent?.includes('connected'), null, { timeout: 30000, polling: 500 });
  record('session-connected', true, {});

  // The avatar speaks a scripted openingPhrase on connect, before any typed
  // input, and that turn cannot be interrupted.
  await page.waitForFunction(() => document.getElementById('log')?.textContent?.includes('avatar talking'), null, { timeout: 15000, polling: 500 }).catch(() => {});
  record('opening-phrase-started', true, {});

  // English typed input, on purpose -- the point is that the reply is forced
  // to Hebrew regardless of the input language. Asking a fresh question (not
  // "introduce yourself") avoids any overlap with a self-introduction reply
  // that might echo the opening phrase's own wording.
  //
  // Driven through `window.session.speak()` rather than the page's own button,
  // because the promise it returns is the one exact signal for "the text
  // reached the server": text typed during the opening is HELD until that turn
  // ends. A fixed sleep before typing instead has to guess how long a
  // generated multilingual greeting runs, and guesses short.
  await page.evaluate((q) => {
    window.__spoke = null;
    window.session.speak(q).then(
      (sent) => { window.__spoke = sent === true ? 'sent' : 'dropped-session-ended'; },
      (err) => { window.__spoke = `rejected: ${err?.code || err?.message || err}`; },
    );
  }, QUESTION);
  try {
    await page.waitForFunction(() => window.__spoke !== null, null, { timeout: 90000, polling: 500 });
  } catch (err) {
    const t = await page.locator('#log').textContent();
    const e = /** @type {any} */ (err);
    e.detail = `${e.message} — speak() never settled, so the typed text was still held: the opening turn never ended. log: ${JSON.stringify(t)}`;
    throw e;
  }
  const spoke = await page.evaluate(() => window.__spoke);
  if (spoke !== 'sent') throw new Error(`speak() did not reach the server: ${spoke}`);
  record('message-sent', true, {});

  // The held text only goes out once the opening turn is over, so every log
  // line from this point on belongs to the reply -- no greeting to filter out.
  const logAtSend = await page.locator('#log').textContent();
  try {
    await page.waitForFunction(
      ({ before, hebrew }) => {
        const t = document.getElementById('log')?.textContent || '';
        return new RegExp(`\\[final\\][^\\n]*[${hebrew}]`).test(t.slice(before));
      },
      { before: logAtSend.length, hebrew: HEBREW_RANGE },
      { timeout: 90000, polling: 500 },
    );
  } catch (err) {
    // A bare timeout does not say whether nothing came back at all or a reply
    // came back in the wrong script. Attach the log so the artifact carries
    // that evidence.
    const t = await page.locator('#log').textContent();
    const e = /** @type {any} */ (err);
    e.detail = `${e.message} — no Hebrew final transcript after the question. log after send: ${JSON.stringify(t.slice(logAtSend.length))}`;
    throw e;
  }
  await page.waitForTimeout(3000);
  record('hebrew-final-transcript-observed', true, {});

  const fullLog = await page.locator('#log').textContent();
  const newReply = fullLog.slice(logAtSend.length);
  record('log-captured', true, { fullLog, newReply });

  const repliedInHebrew = HEBREW_RE.test(newReply);
  record('reply-is-hebrew-script', repliedInHebrew, { newReply });

  mkdirSync(resolve(repoRoot, 'live-verify-artifacts'), { recursive: true });
  const screenshotPath = resolve(repoRoot, `live-verify-artifacts/${runId}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  record('screenshot-captured', true, { path: screenshotPath });

  if (!repliedInHebrew) throw new Error(`Expected the reply to contain Hebrew script; got: ${JSON.stringify(newReply)}`);
  if (pageErrors.length) record('page-console-errors', false, { pageErrors });
} catch (err) {
  failed = true;
  createdSoFar = provisioned || null;
  record('set-forced-language-runtime-check', false, {
    message: err?.detail || err?.message || String(err), code: err?.code,
    pageErrors, consoleTail: consoleLog.slice(-40),
  });
} finally {
  if (browser) { try { await browser.close(); } catch { /* best-effort teardown */ } }
  if (server) { try { await new Promise((r) => server.close(r)); } catch { /* best-effort teardown */ } }

  const ids = provisioned || createdSoFar || {};
  if (ids.agentId) {
    try {
      await kaltura.agents.delete(ids.agentId, admin.ks, { confirmPermanent: true });
      record('agent-delete', true, { agentId: ids.agentId });
    } catch (err) {
      failed = true;
      record('agent-delete', false, { agentId: ids.agentId, message: err?.detail || err?.message || String(err) });
    }
  }
  if (ids.avatarId) {
    try {
      await kaltura.avatars.delete(ids.avatarId, admin.ks, { confirmPermanent: true });
      record('avatar-delete', true, { avatarId: ids.avatarId });
    } catch (err) {
      failed = true;
      record('avatar-delete', false, { avatarId: ids.avatarId, message: err?.detail || err?.message || String(err) });
    }
  }
  if (ids.configId) {
    try {
      await kaltura.intellects.delete(ids.configId, admin.ks, { confirmPermanent: true });
      record('intellect-delete', true, { configId: ids.configId });
    } catch (err) {
      failed = true;
      record('intellect-delete', false, { configId: ids.configId, message: err?.detail || err?.message || String(err) });
    }
  }

  // Independent re-verification: a real not-found, not just a 200 from delete.
  if (ids.agentId) {
    try {
      await kaltura.agents.get(ids.agentId, admin.ks);
      record('agent-reverify-gone', false, { agentId: ids.agentId, note: 'still fetchable after delete' });
      failed = true;
    } catch (err) {
      record('agent-reverify-gone', true, { agentId: ids.agentId, code: err?.code || String(err) });
    }
  }
  if (ids.avatarId) {
    try {
      await kaltura.avatars.get(ids.avatarId, admin.ks);
      record('avatar-reverify-gone', false, { avatarId: ids.avatarId, note: 'still fetchable after delete' });
      failed = true;
    } catch (err) {
      record('avatar-reverify-gone', true, { avatarId: ids.avatarId, code: err?.code || String(err) });
    }
  }
  if (ids.configId) {
    try {
      await kaltura.intellects.get(ids.configId, admin.ks);
      record('intellect-reverify-gone', false, { configId: ids.configId, note: 'still fetchable after delete' });
      failed = true;
    } catch (err) {
      record('intellect-reverify-gone', true, { configId: ids.configId, code: err?.code || String(err) });
    }
  }
}

artifact.finishedAt = new Date().toISOString();
artifact.ok = !failed;

mkdirSync(resolve(repoRoot, 'live-verify-artifacts'), { recursive: true });
const outPath = resolve(repoRoot, `live-verify-artifacts/${runId}.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written: ${outPath}`);

process.exit(failed ? 1 : 0);
