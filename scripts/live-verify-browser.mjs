#!/usr/bin/env node
/**
 * Live-BROWSER smoke test — real Kaltura API, real provisioned avatar, real
 * headless Chromium, real WHEP/WebRTC media. Fills the gap `live-verify.mjs`
 * documents as out of scope (server-side management/conversation path only).
 *
 * Provisions a throwaway agent+avatar+intellect, serves `examples/chroma-key-avatar.html`
 * from a local HTTP server (with `/appInit` backed by the real appInit response),
 * loads it in headless Chromium with fake-but-real-pipeline media flags
 * (`--use-fake-ui/device-for-media-stream` only auto-grants getUserMedia — the
 * actual WHEP downlink and chroma-key compositing are unfaked), waits for the
 * chroma-key compositor to render real, varying, partially-transparent frames
 * (proof the green screen is actually being keyed, not just present-or-blank),
 * captures a screenshot of the composited output for human visual QA, then
 * tears down all three provisioned resources.
 *
 * Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the environment
 * or a .env file in the repo root (same convention as scripts/live-verify.mjs).
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
  // No .env file — credentials must already be in the environment.
}

const partnerId = process.env.AGENTIC_PARTNER_ID;
const adminSecret = process.env.AGENTIC_ADMIN_SECRET;

if (!partnerId || !adminSecret) {
  console.error('AGENTIC_PARTNER_ID and AGENTIC_ADMIN_SECRET are required (env or repo-root .env).');
  process.exit(1);
}

const startedAt = new Date().toISOString();
const runId = `ci-live-verify-browser-${Date.now()}`;
const artifact = { runId, startedAt, partnerId, steps: [] };

function record(step, ok, detail) {
  artifact.steps.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${step}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

/** Minimal static file server for `examples/` + `src/` plus a real `/appInit` route. */
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
// If kaltura.provision() fails partway through, it throws rather than returning a
// partial object — but the error carries exactly which ids were already created
// (see src/management/provision.js), so cleanup below can still reach them.
let createdSoFar = null;

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  provisioned = await kaltura.provision({ brief: 'A friendly CI smoke-test greeter avatar', ks: admin.ks });
  record('provision', true, {
    configId: provisioned.configId, agentId: provisioned.agentId,
    avatarId: provisioned.avatarId, widgetId: provisioned.widgetId,
  });

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
  const pageErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto(`http://127.0.0.1:${port}/examples/chroma-key-avatar.html`, { waitUntil: 'domcontentloaded' });

  // Readiness + correctness in one signal: the compositor must be painting real,
  // varying (lumSpread) frames that are PARTIALLY TRANSPARENT (alphaSpread) — the
  // direct evidence the green screen is actually being keyed out, not left opaque
  // (keying failed) or the whole frame keyed away (nothing left to show).
  const statsHandle = await page.waitForFunction(
    () => {
      const canvas = document.querySelector('#composited canvas');
      if (!canvas || !canvas.width || !canvas.height) return false;
      const off = document.createElement('canvas');
      off.width = canvas.width;
      off.height = canvas.height;
      const octx = off.getContext('2d');
      octx.drawImage(canvas, 0, 0);
      const { data } = octx.getImageData(0, 0, off.width, off.height);
      let minLum = 255, maxLum = 0, minA = 255, maxA = 0;
      for (let i = 0; i < data.length; i += 388) {
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const a = data[i + 3];
        if (lum < minLum) minLum = lum;
        if (lum > maxLum) maxLum = lum;
        if (a < minA) minA = a;
        if (a > maxA) maxA = a;
      }
      const lumSpread = maxLum - minLum, alphaSpread = maxA - minA;
      return (lumSpread > 15 && alphaSpread > 10) ? { lumSpread, alphaSpread, w: off.width, h: off.height } : false;
    },
    null,
    { timeout: 45000, polling: 500 },
  );
  const stats = await statsHandle.jsonValue();
  record('compositor-keying-verified', true, stats);

  // Let the example's own 2.5s auto-crop union settle before the human-reviewable shot.
  await page.waitForTimeout(3000);

  mkdirSync(resolve(repoRoot, 'live-verify-artifacts'), { recursive: true });
  const screenshotPath = resolve(repoRoot, `live-verify-artifacts/${runId}.png`);
  await page.locator('#composited').screenshot({ path: screenshotPath });
  record('screenshot-captured', true, { path: screenshotPath });

  if (pageErrors.length) record('page-console-errors', false, { pageErrors });
} catch (err) {
  failed = true;
  createdSoFar = err?.body?.createdSoFar || null;
  record('live-verify-browser', false, { message: err?.detail || err?.message || String(err), code: err?.code, createdSoFar });
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
}

artifact.finishedAt = new Date().toISOString();
artifact.ok = !failed;

mkdirSync(resolve(repoRoot, 'live-verify-artifacts'), { recursive: true });
const outPath = resolve(repoRoot, `live-verify-artifacts/${runId}.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written: ${outPath}`);

process.exit(failed ? 1 : 0);
