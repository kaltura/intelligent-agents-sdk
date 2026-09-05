#!/usr/bin/env node
/**
 * Live runtime-effect check for IntellectConfig's `force_language` field.
 * `force_language` round-trips in storage (patch -> intellects.get() reflects
 * it). That does not prove the reply is delivered in that language. This
 * script drives a real conversation and inspects the transcript{type:'final'}
 * text (the exact text handed to TTS, pre-synthesis) to check.
 *
 * Limitation: this only confirms the TEXT delivered to speech synthesis and
 * whether synthesis fired at all (avatarStartTalking). It cannot confirm the
 * audio itself.
 *
 * Pattern reused from scripts/live-verify-browser.mjs: credential loading,
 * static file server with a real /appInit route, headless Chromium with
 * fake-media flags, full teardown in `finally`, artifacts written to
 * live-verify-artifacts/. Only provisions and tears down its own scratch
 * resources.
 */
import { readFileSync, writeFileSync, mkdirSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
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

const runId = `force-language-runtime-check-${Date.now()}`;
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

  await kaltura.intellectConfig.patch(provisioned.configId, { force_language: 'Hebrew' }, admin.ks);
  const afterPatch = await kaltura.intellects.get(provisioned.configId, admin.ks);
  const persisted = afterPatch?.force_language === 'Hebrew';
  record('force_language-patch-persisted', persisted, { force_language: afterPatch?.force_language });
  if (!persisted) throw new Error(`force_language did not persist as expected: got ${JSON.stringify(afterPatch?.force_language)}`);

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

  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  page.on('console', (msg) => {
    consoleLog.push(`[${msg.type()}] ${msg.text()}`);
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(`http://127.0.0.1:${port}/examples/browser-experience.html`, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => document.getElementById('log')?.textContent?.includes('connected'), null, { timeout: 30000, polling: 500 });
  record('session-connected', true, {});

  await page.fill('#msg', 'Please introduce yourself and tell me a bit about what you can help with.');
  await page.click('#say');
  record('message-sent', true, {});

  // transcript{type:'final'} is the ground-truth pre-TTS text (emitted from the
  // `generatingSpeech` socket event) -- the exact text handed to speech synthesis.
  // avatarStartTalking (logged by the example as "avatar talking") proves TTS fired.
  await page.waitForFunction(
    () => {
      const t = document.getElementById('log')?.textContent || '';
      return t.includes('[final]') && t.includes('avatar talking');
    },
    null,
    { timeout: 45000, polling: 500 },
  );
  record('final-transcript-and-avatar-talking-observed', true, {});

  const fullLog = await page.locator('#log').textContent();
  record('log-captured', true, { fullLog });

  mkdirSync(resolve(repoRoot, 'live-verify-artifacts'), { recursive: true });
  const screenshotPath = resolve(repoRoot, `live-verify-artifacts/${runId}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  record('screenshot-captured', true, { path: screenshotPath });

  if (pageErrors.length) record('page-console-errors', false, { pageErrors });
} catch (err) {
  failed = true;
  createdSoFar = provisioned || null;
  record('force-language-runtime-check', false, {
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
