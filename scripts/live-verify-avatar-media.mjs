#!/usr/bin/env node
/**
 * Live avatar-media verify — real Kaltura API, real provisioned avatar, real
 * headless browser, real WHEP downlink. Proves the merged-stream media path
 * (src/experience/avatar-media.js) against the actual server, in both layouts:
 *
 *   simple  — one `videoEl` carries video + audio (the default every existing app uses)
 *   split   — `videoEl` carries video only, a bring-your-own `audioEl` carries audio
 *
 * Per layout it asserts, from the page's own DOM and RTCPeerConnection.getStats():
 *   readiness  streamReady before any track; exactly one mediaReady {mode:'video', dims > 0};
 *              exactly one videoMetadata
 *   placement  each track lands on the right element, nothing else
 *   audio      remote audio track bound, `muted === false`, inbound-rtp packets grow over 2s
 *   video      videoWidth > 0, currentTime advances, a decoded frame is not black
 *   controls   muteAudioOutput / unmuteAudioOutput / setAudioOutputVolume hit the element
 *              carrying audio only; setAudioOutput(<enumerated output, else ''>) and
 *              setAudioOutput('') resolve true and land in `sinkId` where setSinkId exists
 *              (Chromium's 'default' pseudo-id is recorded as information only: Firefox
 *              rejects it); startPlayback resolves true
 *   teardown   disconnect clears both srcObjects and ends every downlink track
 *
 * Output is always silent: Chromium `--mute-audio`, Firefox `media.volume_scale=0`,
 * WebKit via the page's `silent=1` (element mute, applied before the first bind).
 *
 * Engine: LIVE_VERIFY_BROWSER=chromium|firefox|webkit (default chromium).
 * Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET from the environment or a
 * repo-root .env — never from a tracked file. Artifact JSON lands in
 * live-verify-artifacts/ (gitignored) and contains only ids and measurements.
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

const runId = `live-verify-avatar-media-${engineName}-${Date.now()}`;
const artifact = { runId, engine: engineName, startedAt: new Date().toISOString(), partnerId, steps: [] };
let failed = false;

function record(step, ok, detail) {
  if (!ok) failed = true;
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
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const LAUNCH = {
  chromium: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
  firefox: {
    firefoxUserPrefs: {
      'media.navigator.streams.fake': true,
      'media.navigator.permission.disabled': true,
      'media.autoplay.default': 0,
      'media.volume_scale': '0.0',
      // SRS only serves H264; Playwright's Firefox needs its OpenH264 GMP plugin fetched first.
      'media.gmp-manager.updateEnabled': true,
      'media.gmp-provider.enabled': true,
      'media.gmp-gmpopenh264.enabled': true,
      'media.gmp-gmpopenh264.autoupdate': true,
    },
  },
  webkit: {},
};

/** Run one layout on a fresh page; every check is recorded, none throws past the mode. */
async function runMode(context, port, mode) {
  const tag = `${mode}`;
  const pageErrors = [];
  const consoleLog = [];
  const page = await context.newPage();
  page.on('console', (msg) => { consoleLog.push(`[${msg.type()}] ${msg.text()}`); if (msg.type() === 'error') pageErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.addInitScript(() => {
    window.__pcs = [];
    const OrigPC = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...args) {
      const pc = new OrigPC(...args);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = OrigPC.prototype;
  });

  try {
    const silent = engineName === 'webkit' ? '&silent=1' : '';
    await page.goto(`http://127.0.0.1:${port}/scripts/live-verify-avatar-media.html?mode=${mode}${silent}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

    await page.evaluate(() => window.testConnect());
    // Wait until the video element has real dimensions AND the audio track is unmuted,
    // i.e. both downlink tracks are carrying media, not just negotiated.
    await page.waitForFunction(() => {
      const v = document.getElementById('v');
      const s = window.session;
      const a = s.avatarStream?.getAudioTracks()[0];
      return v.videoWidth > 0 && a && a.muted === false;
    }, null, { timeout: 90000, polling: 250 });
    record(`${tag}:connected`, true);

    // Readiness ordering + counts, from the page's event log.
    const events = await page.evaluate(() => window.__events);
    const idx = (t) => events.findIndex((e) => e.type === t);
    const count = (t) => events.filter((e) => e.type === t).length;
    const mediaReady = events.filter((e) => e.type === 'mediaReady').map((e) => e.payload);
    const readiness = {
      streamReadyCount: count('streamReady'), firstTrackIdx: idx('track'), streamReadyIdx: idx('streamReady'),
      mediaReadyCount: count('mediaReady'), mediaReady, videoMetadataCount: count('videoMetadata'),
      trackKinds: events.filter((e) => e.type === 'track').map((e) => e.payload.kind),
      warnings: events.filter((e) => e.type === 'warning').map((e) => e.payload?.code),
      errors: events.filter((e) => e.type === 'error').map((e) => e.payload),
    };
    record(`${tag}:readiness`,
      readiness.streamReadyCount >= 1 && readiness.streamReadyIdx < readiness.firstTrackIdx
      && readiness.mediaReadyCount === 1 && mediaReady[0]?.mode === 'video' && mediaReady[0]?.videoWidth > 0 && mediaReady[0]?.videoHeight > 0
      && readiness.videoMetadataCount === 1 && readiness.trackKinds.length === 2 && readiness.errors.length === 0,
      readiness);

    const probe = await page.evaluate(() => window.testProbe());
    const placementOk = mode === 'split'
      ? JSON.stringify(probe.videoElTracks) === '["video"]' && JSON.stringify(probe.audioElTracks) === '["audio"]' && probe.audioPaused === false
      : JSON.stringify(probe.videoElTracks) === '["audio","video"]' && probe.audioElTracks === null;
    record(`${tag}:placement`, placementOk && JSON.stringify(probe.avatarStreamKinds) === '["audio","video"]'
      && probe.canonicalNotOnElements && probe.elementTracksAreCanonical
      && probe.sessionGetters.videoEl && probe.sessionGetters.audioEl && probe.sessionGetters.mode === 'video', {
      videoElTracks: probe.videoElTracks, audioElTracks: probe.audioElTracks,
      canonicalNotOnElements: probe.canonicalNotOnElements, elementTracksAreCanonical: probe.elementTracksAreCanonical,
      avatarStreamKinds: probe.avatarStreamKinds, sessionGetters: probe.sessionGetters,
    });
    record(`${tag}:audio-flowing`, probe.audioTrackMuted === false && probe.audioTrackReadyState === 'live',
      { audioTrackMuted: probe.audioTrackMuted, readyState: probe.audioTrackReadyState });
    record(`${tag}:video-painting`, probe.videoWidth > 0 && probe.currentTimeAdvancing && probe.frame.nonBlack && probe.videoPaused === false,
      { videoWidth: probe.videoWidth, videoHeight: probe.videoHeight, currentTimeAdvancing: probe.currentTimeAdvancing, frame: probe.frame, videoPaused: probe.videoPaused });

    const inbound = await page.evaluate(() => window.testInbound());
    record(`${tag}:inbound-rtp-growing`, inbound.audioGrew && inbound.videoGrew, inbound);

    const controls = await page.evaluate(() => window.testControls());
    const sinkOk = controls.setSinkIdSupported
      ? controls.setAudioOutputTarget === true && controls.sinkIdAfter === controls.sinkTarget
        && controls.setAudioOutputSystemDefault === true && controls.sinkIdReset === ''
      : controls.setAudioOutputTarget === false && controls.setAudioOutputSystemDefault === false;
    record(`${tag}:controls`, controls.mutedApplied && controls.unmutedApplied && controls.volumeApplied && controls.otherUntouchedByMute
      && sinkOk && controls.startPlayback === true, controls);

    const down = await page.evaluate(() => window.testDisconnect());
    record(`${tag}:disconnect-clean`, down.videoSrcObjectCleared && down.audioSrcObjectCleared && down.avatarStreamCleared
      && down.tracksSeen === 2 && down.tracksEnded === 2, down);

    // disconnect() fires a best-effort WHEP DELETE at the server's `Location` resource. The
    // production viewer resource answers that preflight without CORS headers (Chromium: "blocked
    // by CORS policy" + net::ERR_FAILED; WebKit: "Preflight response is not successful. Status
    // code: 403" + "access control checks"), so the browser logs a console error even though
    // the SDK catches the rejection (audit `whep.release` fail) and local teardown is unaffected.
    // Pre-dates this media path (same on main). Recorded as informational; anything else fails.
    const isKnownWhepDeleteCors = (e) => /whep\/session\/.*\/viewer\/|CORS|net::ERR_FAILED|Preflight response is not successful|access control checks|NetworkError when attempting to fetch/.test(e);
    const unexpected = pageErrors.filter((e) => !isKnownWhepDeleteCors(e));
    if (pageErrors.length) record(`${tag}:page-console-errors`, unexpected.length === 0, { unexpected, knownWhepDeleteCors: pageErrors.length - unexpected.length });
  } catch (err) {
    record(`${tag}:run`, false, { message: err?.message || String(err), pageErrors, consoleTail: consoleLog.slice(-30) });
  } finally {
    await page.close().catch(() => {});
  }
}

const kaltura = new Management({ partnerId, adminSecret });
let admin;
let provisioned;
let createdSoFar = null;
let server;
let browser;

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  provisioned = await kaltura.provision({ brief: 'A friendly CI avatar-media verify greeter avatar', ks: admin.ks });
  record('provision', true, { configId: provisioned.configId, agentId: provisioned.agentId, avatarId: provisioned.avatarId, widgetId: provisioned.widgetId });

  let widgetId = provisioned.widgetId;
  if (!widgetId) widgetId = (await kaltura.application.resolveWidgetId(provisioned.agentId, admin.ks))?.widgetId;
  if (!widgetId) throw new Error('no widgetId resolved after provision');

  const widget = await kaltura.sessions.createWidgetToken({ widgetId });
  const init = await kaltura.application.appInit(widget.ks);
  record('app-init', true, { conversationManagerUrl: init.conversationManagerUrl, srsBaseUrl: init.srsBaseUrl });

  server = await startServer(init);
  const port = server.address().port;

  browser = await engine.launch(LAUNCH[engineName]);
  const context = await browser.newContext(engineName === 'webkit' ? { permissions: ['camera', 'microphone'] } : {});

  if (engineName === 'firefox') {
    const t0 = Date.now();
    const warm = await context.newPage();
    await warm.goto('data:text/html,<h1>gmp warmup</h1>');
    await warm.waitForFunction(
      () => window.RTCRtpReceiver.getCapabilities('video').codecs.some((c) => /h264/i.test(c.mimeType)),
      null, { timeout: 120000, polling: 2000 },
    );
    await warm.close();
    record('firefox-openh264-ready', true, { waitedMs: Date.now() - t0 });
  }

  for (const mode of ['simple', 'split']) await runMode(context, port, mode);
} catch (err) {
  createdSoFar = err?.body?.createdSoFar || null;
  record('live-verify-avatar-media', false, { message: err?.detail || err?.message || String(err), code: err?.code, createdSoFar });
} finally {
  if (browser) { try { await browser.close(); } catch { /* best-effort teardown */ } }
  if (server) { try { await new Promise((r) => server.close(r)); } catch { /* best-effort teardown */ } }

  const ids = provisioned || createdSoFar || {};
  const del = async (step, fn, id) => {
    if (!id) return;
    try { await fn(); record(step, true, { id }); } catch (err) { record(step, false, { id, message: err?.detail || err?.message || String(err) }); }
  };
  await del('agent-delete', () => kaltura.agents.delete(ids.agentId, admin.ks, { confirmPermanent: true }), ids.agentId);
  await del('avatar-delete', () => kaltura.avatars.delete(ids.avatarId, admin.ks, { confirmPermanent: true }), ids.avatarId);
  await del('intellect-delete', () => kaltura.intellects.delete(ids.configId, admin.ks, { confirmPermanent: true }), ids.configId);
}

artifact.finishedAt = new Date().toISOString();
artifact.ok = !failed;
mkdirSync(resolve(repoRoot, 'live-verify-artifacts'), { recursive: true });
const outPath = resolve(repoRoot, `live-verify-artifacts/${runId}.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written: ${outPath}`);
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
