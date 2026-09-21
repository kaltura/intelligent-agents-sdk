#!/usr/bin/env node
/**
 * Live runtime-effect check for `Management.setForcedLanguage()`. Provisions a
 * scratch agent with a language-neutral brief, forces Hebrew, sends an English
 * typed message, and checks the reply for Hebrew script -- in the final
 * transcript when the avatar voices it, in the brain text when it doesn't. The
 * server can drop the first turn of a session silently, so the question is sent
 * once more before the check is called a failure. Compare
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
import { Management, SILENT_OPENING } from '../src/management/index.js';
import { writeSilentWav } from './live-verify-silent-mic-shared.mjs';

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

  // SILENT_OPENING, not a generated greeting: the opening turn cannot be
  // interrupted and the question has to wait it out either way, so the shortest
  // possible opening is the fastest path to the reply. It also keeps the reply
  // the only speech in the log, so the Hebrew check cannot pass on a
  // multilingual greeting's own words.
  provisioned = await kaltura.provision({
    brief: 'A friendly multilingual test greeter',
    openingPhrase: SILENT_OPENING,
    ks: admin.ks,
  });
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

  // The example page logs `transcript` events only, so a reply the avatar never
  // speaks is invisible to it. The forced language applies to the reply text
  // whether or not it reaches TTS, so capture the brain segments too, plus the
  // turn-level events that say whether the server even took the turn.
  await page.evaluate(() => {
    window.__brainText = '';
    window.__seen = [];
    window.session.on('brainSegment', (d) => {
      const len = (d?.content || '').length;
      window.__seen.push({ t: 'brainSegment', stype: d?.type, len });
      if ((d?.type === 'text' || d?.type === 'avatar') && len) window.__brainText += d.content;
    });
    window.session.on('responsePending', () => window.__seen.push({ t: 'responsePending' }));
    window.session.on('responseSettled', () => window.__seen.push({ t: 'responseSettled' }));
    window.session.on('avatarStartTalking', () => window.__seen.push({ t: 'avatarStartTalking' }));
    window.session.on('avatarStopTalking', () => window.__seen.push({ t: 'avatarStopTalking' }));
    window.session.on('error', (e) => window.__seen.push({ t: 'error', code: e?.code, detail: e?.detail }));
    window.session.on('warning', (e) => window.__seen.push({ t: 'warning', code: e?.code, detail: e?.detail }));
  });

  // The opening turn still runs and still cannot be interrupted, even though
  // SILENT_OPENING means it carries no words.
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
  // ends. A fixed sleep before typing instead has to guess how long the opening
  // runs, and guesses short.
  const sendQuestion = async (settleTimeout) => {
    await page.evaluate((q) => {
      window.__spoke = null;
      window.session.speak(q).then(
        (sent) => { window.__spoke = sent === true ? 'sent' : 'dropped-session-ended'; },
        (err) => { window.__spoke = `rejected: ${err?.code || err?.message || err}`; },
      );
    }, QUESTION);
    try {
      await page.waitForFunction(() => window.__spoke !== null, null, { timeout: settleTimeout, polling: 500 });
    } catch (err) {
      const t = await page.locator('#log').textContent();
      const e = /** @type {any} */ (err);
      e.detail = `${e.message} — speak() never settled, so the typed text was still held: the opening turn never ended. log: ${JSON.stringify(t)}`;
      throw e;
    }
    const spoke = await page.evaluate(() => window.__spoke);
    if (spoke !== 'sent') throw new Error(`speak() did not reach the server: ${spoke}`);
  };

  // Either channel counts: a voiced reply shows up as a Hebrew `[final]`
  // transcript, an unvoiced one only in the brain text.
  const waitForHebrewReply = (before, brainBefore, timeout) => page.waitForFunction(
    ({ from, brainFrom, hebrew }) => {
      const t = document.getElementById('log')?.textContent || '';
      const re = new RegExp(`[${hebrew}]`);
      return new RegExp(`\\[final\\][^\\n]*[${hebrew}]`).test(t.slice(from))
        || re.test((window.__brainText || '').slice(brainFrom));
    },
    { from: before, brainFrom: brainBefore, hebrew: HEBREW_RANGE },
    { timeout, polling: 500 },
  );

  const logAtSend = await page.locator('#log').textContent();
  const brainAtSend = (await page.evaluate(() => window.__brainText || '')).length;
  // 90 s, not 45: the server HOLDS text typed during the opening turn and only
  // releases it once that turn ends, so this settle is also the wait for the
  // opening to finish. A resend later goes into an idle session and settles fast.
  await sendQuestion(90000);
  record('message-sent', true, {});

  // The held text only goes out once the opening turn is over, so everything
  // from this point on belongs to the reply -- no greeting to filter out.
  try {
    await waitForHebrewReply(logAtSend.length, brainAtSend, 45000);
  } catch {
    // The server can drop one turn without saying so, and speak() resolving
    // 'sent' only proves the text left the client. One resend tells a dropped
    // turn apart from a real failure to answer, and the whole wait stays inside
    // the same 90 s the single wait used to take.
    record('question-resent', true, { reason: 'no Hebrew reply in 45s — resending once' });
    await sendQuestion(45000);
    try {
      await waitForHebrewReply(logAtSend.length, brainAtSend, 45000);
    } catch (err) {
      // A bare timeout does not say which of these happened: no reply at all, a
      // reply in the wrong script, or a reply the avatar never voiced. Attach
      // the log, the brain text and every turn-level event so the artifact
      // carries that evidence instead of just the timeout.
      const t = await page.locator('#log').textContent();
      const brain = await page.evaluate(() => window.__brainText || '');
      const seen = await page.evaluate(() => window.__seen || []);
      const e = /** @type {any} */ (err);
      e.detail = `${e.message} — no Hebrew reply in the transcript or the brain text after two sends. log after send: ${JSON.stringify(t.slice(logAtSend.length))}, brain after send: ${JSON.stringify(brain.slice(brainAtSend))}, events: ${JSON.stringify(seen)}`;
      throw e;
    }
  }
  await page.waitForTimeout(3000);
  record('hebrew-reply-observed', true, {});

  const fullLog = await page.locator('#log').textContent();
  const brainReply = (await page.evaluate(() => window.__brainText || '')).slice(brainAtSend);
  const newReply = fullLog.slice(logAtSend.length) + brainReply;
  record('log-captured', true, { fullLog, newReply, brainReply });

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
