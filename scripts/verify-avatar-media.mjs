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
import { createReadStream, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
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
const TRACK_TO_READY_MS = 2500;      // B12: same ceiling the page asserts per subscribe
const ARTIFACT_DIR = resolve(repoRoot, '.harness-output');   // gitignored

/**
 * B13: the cells this file expects the page to expose, in page order. A cell renamed, dropped or
 * added without updating this list fails the run: a silently missing cell is a silently missing gate.
 */
const EXPECTED_CELLS = [
  'shapes-simple', 'shapes-split', 'shapes-headless', 'shapes-audio-only-el',
  'shapes-twoAV', 'shapes-oneVA', 'shapes-oneAV', 'audible-path',
  'video-only', 'audio-only', 'late-audio', 'late-video', 'readiness-order',
  'mutes', 'volume', 'devices', 'devices-race', 'swaps', 'swaps-edge',
  'mixing', 'mixing-three', 'recording', 'recording-ops', 'multi-avatar', 'multi-avatar-three',
  'races-recover', 'races-split-in-listener', 'races-disconnect-mid-play', 'races-start-playback', 'races-double-disconnect',
  'autoplay-simple', 'autoplay-split', 'autoplay-split-audio-blocked', 'autoplay-rebind-rearm',
  'teardown', 'leaks-connect-cycles', 'leaks-audio-el-toggles', 'controls-before-connect',
  'chroma-key', 'compat-patterns', 'scripted',
];

/**
 * B13: the only checks allowed to skip, and the only reasons that excuse them. A skip whose
 * cell/check/reason/engine is not listed here fails the run, so "unsupported in this engine"
 * can never quietly grow into "we stopped testing this".
 * `engines` defaults to every engine because the same engine name covers different builds
 * (macOS WebKit has setSinkId and MediaRecorder, headless WebKitGTK on CI has neither).
 */
const NO_SINK = /HTMLMediaElement\.setSinkId is not implemented in this engine|no audiooutput device is enumerable in this engine/;
const NO_RECORDER = /MediaRecorder is not implemented in this engine|^NotSupportedError: /;
const NO_PLAY_BLOCK = /engine started playback without a successful play\(\)/;
const ALLOWED_SKIPS = [
  { cell: 'audible-path', check: 'B1 element-source energy', reason: /AudioContext\.createMediaElementSource is not implemented in this engine/ },
  // Chromium and WebKit feed no energy from a srcObject-backed element into Web Audio; Firefox does, and must keep proving it.
  { cell: 'audible-path', check: 'B1 createMediaElementSource(videoEl) energy', reason: /feeds no energy from a srcObject-backed element into Web Audio/, engines: ['chromium', 'webkit'] },
  { cell: 'devices', check: 'B2 sink id on the audio-carrying element', reason: NO_SINK },
  { cell: 'devices-race', check: 'B11 pending setAudioOutput follows a setAudioEl swap', reason: NO_SINK },
  { cell: 'mixing', check: 'Web Audio energy from avatarStream', reason: /^\w*Error: / },
  { cell: 'recording', check: 'MediaRecorder(avatarStream)', reason: NO_RECORDER },
  { cell: 'recording-ops', check: 'B6 MediaRecorder across the media-control surface', reason: NO_RECORDER },
  { cell: 'recording-ops', check: 'B6 MediaRecorder(videoEl.captureStream())', reason: /neither captureStream\(\) nor mozCaptureStream\(\) exists|^\w*Error: / },
  { cell: 'recording-ops', check: 'B6 the element capture recorded into a video container', reason: /reports no mimeType on the recorder or on its blobs/ },
  { cell: 'multi-avatar-three', check: 'B7 per-session setAudioOutput', reason: NO_SINK },
  { cell: 'autoplay-simple', check: 'elements paused', reason: NO_PLAY_BLOCK },
  { cell: 'autoplay-split', check: 'elements paused', reason: NO_PLAY_BLOCK },
  { cell: 'autoplay-split-audio-blocked', check: 'B4 retry only on the blocked element', reason: NO_PLAY_BLOCK },
  { cell: 'autoplay-rebind-rearm', check: 'B5 startPlayback while still blocked', reason: NO_PLAY_BLOCK },
  { cell: 'controls-before-connect', check: 'B10 pre-connect setAudioOutput lands on the element', reason: NO_SINK },
];

const ENGINES = { chromium, firefox, webkit };
const engineName = process.env.VERIFY_BROWSER || 'chromium';
const engine = ENGINES[engineName];
if (!engine) {
  console.error(`Unknown VERIFY_BROWSER "${engineName}" — expected one of: ${Object.keys(ENGINES).join(', ')}`);
  process.exit(1);
}

// Silent + gesture-free launch per engine. WebKit has no mute flag; the page keeps its tone at gain 0.005.
const LAUNCH = {
  // `--use-fake-device-for-media-stream` also gives Chromium enumerable fake audiooutput devices, which B2/B10/B11 need.
  chromium: { args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  // Firefox lists audiooutput devices only after a microphone grant; `streams.fake` makes that grant a fake mic, so the page can unlock B2/B7/B10/B11 without touching real hardware.
  firefox: { firefoxUserPrefs: { 'media.volume_scale': '0.0', 'media.autoplay.default': 0, 'media.autoplay.block-webaudio': false, 'media.navigator.permission.disabled': true, 'media.navigator.streams.fake': true, 'media.setsinkid.enabled': true } },
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
  const consoleErrors = [];
  let cellLog = [];      // the page's console output during the current cell, printed when it fails
  let crashed = false;
  let page;
  // A page crash (seen on WebKitGTK) kills every later evaluate on that page. Reopen the harness
  // on a fresh page so the remaining cells still report; the crashed cell is recorded as failed.
  const openHarness = async () => {
    crashed = false;
    page = await context.newPage();
    page.on('console', (msg) => {
      const line = `[${msg.type()}] ${msg.text()}`;
      if (cellLog.length < 200) cellLog.push(line);
      if (msg.type() === 'error') consoleErrors.push(msg.text());
      if (process.env.VERIFY_AVATAR_MEDIA_DEBUG) console.log(`[page:${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('crash', () => { crashed = true; consoleErrors.push('page crashed'); });
    await page.goto(`http://127.0.0.1:${PORT}${PAGE}`);
    await page.click('#go');
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
  };
  await openHarness();
  const has = await page.evaluate(() => window.__has);
  const exposed = await page.evaluate(() => window.__scenarios);
  // B13: manifest check runs against everything the page exposes, before any subset filter.
  const missing = EXPECTED_CELLS.filter((c) => !exposed.includes(c));
  const unexpected = exposed.filter((c) => !EXPECTED_CELLS.includes(c));
  console.log(`[${engineName}] manifest: ${exposed.length} cells exposed, ${EXPECTED_CELLS.length} expected${missing.length ? `, MISSING: ${missing.join(', ')}` : ''}${unexpected.length ? `, UNEXPECTED: ${unexpected.join(', ')}` : ''}`);
  if (!exposed.length || missing.length || unexpected.length) {
    console.error(`[${engineName}] FAIL: cell manifest mismatch (update EXPECTED_CELLS in this script when a cell is renamed, added or removed)`);
    process.exitCode = 1;
  }
  let cells = exposed;
  const only = process.env.VERIFY_AVATAR_MEDIA_ONLY?.split(',').map((s) => s.trim()).filter(Boolean);
  if (only?.length) cells = cells.filter((c) => only.includes(c));
  console.log(`[${engineName}] features: ${JSON.stringify(has)}; ${cells.length} cells`);

  const results = [];
  for (const name of cells) {
    const errorsBefore = consoleErrors.length;
    cellLog = [];
    const started = Date.now();
    let result = null;
    try {
      await page.evaluate((n) => { window.__result = null; window.__gestureWanted = false; window.__p = window.__run(n); }, name);
      // Autoplay cells park on `__gestureWanted`; a real click on #resume is the user gesture.
      await page.waitForFunction(() => window.__gestureWanted || window.__result, null, { timeout: CELL_TIMEOUT_MS });
      if (await page.evaluate(() => window.__gestureWanted && !window.__result)) await page.click('#resume');
      result = await page.waitForFunction(() => window.__result, null, { timeout: CELL_TIMEOUT_MS }).then((h) => h.jsonValue());
    } catch (e) {
      const why = crashed || page.isClosed() || /crashed/i.test(e.message) ? 'page crashed' : 'cell timed out';
      result = { name, pass: false, checks: [{ name: why, ok: false, detail: e.message }], skipped: [], lat: [], ms: Date.now() - started };
      if (why === 'page crashed') await openHarness();
      else await page.evaluate(() => window.__p?.catch?.(() => {})).catch(() => {});   // settle the cell's promise so the next cell starts clean
    }
    const newErrors = consoleErrors.slice(errorsBefore);
    if (newErrors.length) result.checks.push({ name: 'no console errors / page errors', ok: false, detail: newErrors.join(' | ') });
    result.pass = result.checks.every((c) => c.ok);
    results.push(result);
    console.log(`[${engineName}] ${result.pass ? 'OK  ' : 'FAIL'} ${name} (${result.ms}ms, ${result.checks.length} checks${result.skipped.length ? `, ${result.skipped.length} skipped` : ''})`);
    for (const c of result.checks.filter((c) => !c.ok)) console.log(`         ✖ ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
    for (const s of result.skipped) console.log(`         ~ skipped ${s.name}: ${s.reason}`);
    if (!result.pass && cellLog.length) {
      console.log(`         page console (last ${Math.min(cellLog.length, 40)} of ${cellLog.length} lines):`);
      for (const line of cellLog.slice(-40)) console.log(`         │ ${line}`);
    }
  }

  const failed = results.filter((r) => !r.pass);
  const skipped = results.flatMap((r) => r.skipped.map((s) => `${r.name}/${s.name}`));
  const elapsed = Date.now() - t0;

  // B13: every skip must be on the allowed list, with a reason that matches. Anything else is a failure.
  const unlisted = [];
  for (const r of results) {
    for (const s of r.skipped) {
      const rule = ALLOWED_SKIPS.find((a) => a.cell === r.name && a.check === s.name && (!a.engines || a.engines.includes(engineName)));
      if (!rule) unlisted.push(`${r.name}/${s.name}: not on the allowed-skip list`);
      else if (!rule.reason.test(s.reason)) unlisted.push(`${r.name}/${s.name}: reason not allowed: ${s.reason}`);
    }
  }
  console.log(`[${engineName}] skip validation: ${skipped.length} skipped, ${unlisted.length} not allowed`);
  for (const u of unlisted) console.log(`         ✖ ${u}`);
  if (unlisted.length) process.exitCode = 1;

  // B12: one line for the mediaReady latency of every subscribe the run performed.
  const lat = results.flatMap((r) => (r.lat || []).map((l) => l.trackToReadyMs));
  const over = lat.filter((ms) => ms > TRACK_TO_READY_MS);
  const sorted = [...lat].sort((a, b) => a - b);
  console.log(`[${engineName}] first track → mediaReady: ${lat.length} subscribes, max ${sorted.at(-1) ?? 0}ms, median ${sorted[Math.floor(sorted.length / 2)] ?? 0}ms, mean ${lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0}ms (budget ${TRACK_TO_READY_MS}ms, ${over.length} over)`);

  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    writeFileSync(resolve(ARTIFACT_DIR, `avatar-media-${engineName}.json`), `${JSON.stringify({
      engine: engineName, features: has, ms: elapsed, budgetMs: BUDGET_MS,
      cells: results.length, checks: results.reduce((a, r) => a + r.checks.length, 0),
      failedCells: failed.map((r) => r.name), unlistedSkips: unlisted,
      latency: { trackToReadyMs: lat, max: sorted.at(-1) ?? 0, over: over.length, budgetMs: TRACK_TO_READY_MS },
      results: results.map((r) => ({ name: r.name, pass: r.pass, ms: r.ms, checks: r.checks.length, failures: r.checks.filter((c) => !c.ok), skipped: r.skipped, lat: r.lat || [] })),
    }, null, 2)}\n`);
  } catch (err) { console.log(`[${engineName}] could not write the run artifact: ${err.message}`); }

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
