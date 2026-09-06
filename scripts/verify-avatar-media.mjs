#!/usr/bin/env node
/**
 * Real-browser verification of the avatar media path (`src/experience/avatar-media.js`
 * through `KalturaAvatarSession` / `KalturaScriptedVideoSession`).
 *
 * The node suite proves the state machine over fakes. This proves what fakes cannot:
 * that a real `RTCPeerConnection` delivering two tracks with distinct msids ends up as
 * one merged stream on one element (or split across two), that the element actually
 * paints frames and advances audio, that RTP flows, that autoplay recovery works from
 * a real click, and that the same holds on Chromium, Firefox and WebKit.
 *
 * Fully offline: both WebRTC legs are loopback peers inside the page
 * (`test/browser/avatar-media.html`), the signalling socket is `test/fakes/socket.js`,
 * and WHEP is an injected `fetch`. No credentials, no network. Audio is near-silent
 * (gain 0.005) and the browsers are launched muted, so a local run makes no sound.
 *
 *   VERIFY_BROWSER=chromium|firefox|webkit node scripts/verify-avatar-media.mjs
 *   VERIFY_AVATAR_MEDIA_ONLY=shapes-simple,swaps   # optional: run a subset of cells
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium, firefox, webkit } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const PORT = Number(process.env.VERIFY_AVATAR_MEDIA_PORT) || 4789;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const PAGE = '/test/browser/avatar-media.html';
const CELL_TIMEOUT_MS = 30000;
const BUDGET_MS = 90000;

const ENGINES = { chromium, firefox, webkit };
const engineName = process.env.VERIFY_BROWSER || 'chromium';
const engine = ENGINES[engineName];
if (!engine) {
  console.error(`Unknown VERIFY_BROWSER "${engineName}" — expected one of: ${Object.keys(ENGINES).join(', ')}`);
  process.exit(1);
}

// Silent + gesture-free launch per engine. WebKit has no mute flag; the page keeps its tone at gain 0.005.
const LAUNCH = {
  chromium: { args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] },
  firefox: { firefoxUserPrefs: { 'media.volume_scale': '0.0', 'media.autoplay.default': 0, 'media.autoplay.block-webaudio': false, 'media.navigator.permission.disabled': true } },
  webkit: {},
};

function startServer() {
  const server = createServer((req, res) => {
    let urlPath;
    try { urlPath = normalize(decodeURIComponent(req.url.split('?')[0])); } catch { res.writeHead(400); res.end('bad request'); return; }
    const filePath = resolve(repoRoot, `.${urlPath}`);
    if (!filePath.startsWith(repoRoot) || !existsSync(filePath) || !statSync(filePath).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  });
  return new Promise((ok, fail) => { server.once('error', fail); server.listen(PORT, '127.0.0.1', () => ok(server)); });
}

let server, browser;
const t0 = Date.now();
try {
  server = await startServer();
  browser = await engine.launch(LAUNCH[engineName]);
  const context = await browser.newContext({ permissions: engineName === 'chromium' ? ['microphone'] : [] });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('crash', () => consoleErrors.push('page crashed'));
  if (process.env.VERIFY_AVATAR_MEDIA_DEBUG) page.on('console', (msg) => console.log(`[page:${msg.type()}] ${msg.text()}`));

  await page.goto(`http://127.0.0.1:${PORT}${PAGE}`);
  await page.click('#go');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
  const has = await page.evaluate(() => window.__has);
  let cells = await page.evaluate(() => window.__scenarios);
  const only = process.env.VERIFY_AVATAR_MEDIA_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
  if (only?.length) cells = cells.filter((c) => only.includes(c));
  console.log(`[${engineName}] features: ${JSON.stringify(has)}; ${cells.length} cells`);

  const results = [];
  for (const name of cells) {
    const errorsBefore = consoleErrors.length;
    await page.evaluate((n) => { window.__result = null; window.__gestureWanted = false; window.__p = window.__run(n); }, name);
    let result = null;
    try {
      // Autoplay cells park on `__gestureWanted`; a real click on #resume is the user gesture.
      await page.waitForFunction(() => window.__gestureWanted || window.__result, null, { timeout: CELL_TIMEOUT_MS });
      if (await page.evaluate(() => window.__gestureWanted && !window.__result)) await page.click('#resume');
      result = await page.waitForFunction(() => window.__result, null, { timeout: CELL_TIMEOUT_MS }).then((h) => h.jsonValue());
    } catch (e) {
      result = { name, pass: false, checks: [{ name: 'cell timed out', ok: false, detail: e.message }], skipped: [], ms: CELL_TIMEOUT_MS };
      // Recover the page so the following cells start clean.
      await page.evaluate(() => window.__p?.catch?.(() => {}));
    }
    const newErrors = consoleErrors.slice(errorsBefore);
    if (newErrors.length) result.checks.push({ name: 'no console errors / page errors', ok: false, detail: newErrors.join(' | ') });
    result.pass = result.checks.every((c) => c.ok);
    results.push(result);
    console.log(`[${engineName}] ${result.pass ? 'OK  ' : 'FAIL'} ${name} (${result.ms}ms, ${result.checks.length} checks${result.skipped.length ? `, ${result.skipped.length} skipped` : ''})`);
    for (const c of result.checks.filter((c) => !c.ok)) console.log(`         ✖ ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
    for (const s of result.skipped) console.log(`         ~ skipped ${s.name}: ${s.reason}`);
  }

  const failed = results.filter((r) => !r.pass);
  const skipped = results.flatMap((r) => r.skipped.map((s) => `${r.name}/${s.name}`));
  const elapsed = Date.now() - t0;
  console.log(`[${engineName}] ${results.length - failed.length}/${results.length} cells passed, ${results.reduce((a, r) => a + r.checks.length, 0)} checks, ${skipped.length} skipped, ${(elapsed / 1000).toFixed(1)}s`);
  if (skipped.length) console.log(`[${engineName}] skipped: ${skipped.join(', ')}`);
  if (results.length !== cells.length || failed.length) process.exitCode = 1;
  if (elapsed > BUDGET_MS) { console.error(`[${engineName}] FAIL — over the ${BUDGET_MS / 1000}s budget`); process.exitCode = 1; }
} catch (err) {
  console.error(`[${engineName}] FAIL —`, err);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server?.close();
}
