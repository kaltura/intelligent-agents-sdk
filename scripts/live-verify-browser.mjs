#!/usr/bin/env node
/**
 * Live-BROWSER smoke test — real Kaltura API, real provisioned avatar, real
 * headless Chromium, real WHEP/WebRTC media. Fills the gap `live-verify.mjs`
 * documents as out of scope (server-side management/conversation path only).
 *
 * Provisions a throwaway agent+avatar+intellect, serves `examples/chroma-key-avatar.html`
 * from a local HTTP server (with `/appInit` backed by the real appInit response),
 * loads it in a real headless browser with fake-but-real-pipeline media flags
 * (auto-grants getUserMedia — the actual WHEP downlink, mic uplink, and
 * chroma-key compositing are unfaked), waits for the chroma-key compositor to
 * render real, varying, partially-transparent frames (proof the green screen
 * is actually being keyed, not just present-or-blank), asserts real mic audio
 * actually reached the ASR peer (`RTCPeerConnection.getStats()` outbound-rtp
 * `bytesSent > 0`), captures a screenshot of the composited output for human
 * visual QA, then tears down all three provisioned resources.
 *
 * Engine: LIVE_VERIFY_BROWSER=chromium|firefox|webkit (default chromium).
 * All three pass end-to-end against the real backend.
 * webkit needed a real fix to get there: its native RTCPeerConnection
 * rejects any `?transport=` query string on a turn:/turns: URL, which
 * src/experience/wire.js's createPeerConnection() now retries around (see
 * that function's comment). webkit here is desktop Safari's engine, not
 * iOS Safari — real mobile OS behavior isn't reachable from any Playwright
 * engine (see manual-testing/session-complete/ for that coverage).
 *
 * firefox needed its OpenH264 GMP plugin fetch explicitly enabled via
 * firefoxUserPrefs (off by default in Playwright's launch profile) plus a
 * wait for the fetch to land before navigating (measured 20-40s against
 * Mozilla's real update service across repeated runs, 120s budget) — without it,
 * RTCRtpReceiver.getCapabilities('video') has no H264, and since the SRS
 * WHEP server only serves H264 video, the server answers Firefox's
 * VP8/VP9/AV1-only offer with `a=inactive` on the video m-line (ICE/DTLS
 * still connect fine; only video is silently dropped).
 *
 * Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the environment
 * or a .env file in the repo root (same convention as scripts/live-verify.mjs).
 */
import { readFileSync, writeFileSync, mkdirSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { Management } from '../src/management/index.js';

const ENGINES = { chromium, firefox, webkit };
const engineName = process.env.LIVE_VERIFY_BROWSER || 'chromium';
const engine = ENGINES[engineName];
if (!engine) {
  console.error(`Unknown LIVE_VERIFY_BROWSER "${engineName}" — expected one of: ${Object.keys(ENGINES).join(', ')}`);
  process.exit(1);
}

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
const runId = `ci-live-verify-browser-${engineName}-${Date.now()}`;
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
const pageErrors = [];
const consoleLog = [];

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

  browser = await engine.launch(
    engineName === 'chromium'
      ? { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] }
      : engineName === 'firefox'
        ? {
          firefoxUserPrefs: {
            'media.navigator.streams.fake': true,
            'media.navigator.permission.disabled': true,
            'media.autoplay.default': 0,
            // Playwright's bundled Firefox has no H264 support until its OpenH264 GMP
            // plugin is fetched — off by default in this launch profile. These turn
            // the fetch on; the SRS WHEP server only serves H264 (WIRE-PROTOCOL.md §6),
            // so without this the video m-line always comes back `a=inactive`.
            'media.gmp-manager.updateEnabled': true,
            'media.gmp-provider.enabled': true,
            'media.gmp-gmpopenh264.enabled': true,
            'media.gmp-gmpopenh264.autoupdate': true,
          },
        }
        : {},
  );
  const context = engineName === 'webkit'
    ? await browser.newContext({ permissions: ['camera', 'microphone'] })
    : browser;
  const page = await context.newPage();
  page.on('console', (msg) => {
    consoleLog.push(`[${msg.type()}] ${msg.text()}`);
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  if (engineName === 'firefox') {
    // The GMP fetch runs in the background after launch, on its own schedule — measured
    // 20-40s across repeated real runs against Mozilla's actual update service, no fixed
    // interval. 120s budget covers that with real margin before the ASR/STV peer
    // connections negotiate without H264.
    const ffGmpStart = Date.now();
    await page.goto('data:text/html,<h1>gmp warmup</h1>');
    await page.waitForFunction(
      () => window.RTCRtpReceiver.getCapabilities('video').codecs.some((c) => /h264/i.test(c.mimeType)),
      null,
      { timeout: 120000, polling: 2000 },
    );
    record('firefox-openh264-ready', true, { waitedMs: Date.now() - ffGmpStart });
  }

  // The example never exposes its RTCPeerConnections on window — wrap the
  // constructor before any SDK code runs so getStats() below can find the
  // real ASR uplink peer without touching examples/chroma-key-avatar.html.
  // ICE/connection-state transitions are logged via console.log (captured into
  // consoleLog above) purely so a timeout below has a diagnostic trail instead
  // of a bare "Timeout Xms exceeded" — this traced a real WebKit CI timeout to
  // slow-but-correct ICE/decode on the runner rather than a stuck connection.
  await page.addInitScript(() => {
    window.__pcs = [];
    const OrigPC = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...args) {
      const pc = new OrigPC(...args);
      const label = `pc${window.__pcs.length}`;
      pc.addEventListener('iceconnectionstatechange', () => console.log(`[rtc:${label}] iceConnectionState=${pc.iceConnectionState}`));
      pc.addEventListener('connectionstatechange', () => console.log(`[rtc:${label}] connectionState=${pc.connectionState}`));
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = OrigPC.prototype;
  });

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
    // WebKit on the CI runner's constrained, GPU-less hardware decodes real H264
    // measurably slower than on a dev machine (confirmed via manual instrumented
    // repro: identical code path clears this same check in 1-2s locally) — 90s
    // gives real margin without masking an actually-stuck connection, which the
    // ICE/connection-state console logging above would surface either way.
    { timeout: 90000, polling: 500 },
  );
  const stats = await statsHandle.jsonValue();
  record('compositor-keying-verified', true, stats);

  // Real mic audio must actually reach a peer, not just get captured locally —
  // find an outbound-rtp audio report with real bytes sent, on any of the
  // page's RTCPeerConnections (the ASR uplink is whichever one negotiates a
  // sendonly/sendrecv audio m-line; we don't need to know which by name).
  const audioFlow = await page.waitForFunction(
    async () => {
      for (const pc of window.__pcs || []) {
        const report = await pc.getStats();
        for (const stat of report.values()) {
          if (stat.type === 'outbound-rtp' && stat.kind === 'audio' && stat.bytesSent > 0) {
            return { bytesSent: stat.bytesSent, packetsSent: stat.packetsSent };
          }
        }
      }
      return false;
    },
    null,
    { timeout: 20000, polling: 500 },
  ).then((h) => h.jsonValue());
  record('mic-audio-flow-verified', true, audioFlow);

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
  record('live-verify-browser', false, {
    message: err?.detail || err?.message || String(err), code: err?.code, createdSoFar, pageErrors,
    consoleTail: consoleLog.slice(-40),
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
}

artifact.finishedAt = new Date().toISOString();
artifact.ok = !failed;

mkdirSync(resolve(repoRoot, 'live-verify-artifacts'), { recursive: true });
const outPath = resolve(repoRoot, `live-verify-artifacts/${runId}.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written: ${outPath}`);

process.exit(failed ? 1 : 0);
