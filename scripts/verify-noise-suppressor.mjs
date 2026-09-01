#!/usr/bin/env node
/**
 * Real-browser correctness check for the noise-suppressor's actual DSP math
 * (`src/experience/noise-suppressor.js`'s `KalturaNoiseGateProcessor` AudioWorklet).
 *
 * Every existing test of this plugin (`test/unit/noise-suppressor.test.js`)
 * stubs `AudioWorkletNode` and only proves wiring — the gate math itself
 * (`AudioWorkletGlobalScope`, `registerProcessor`) has never executed outside
 * a real browser before this script. This drives it for real: builds a
 * synthetic input stream with known loud/quiet segments, runs it through the
 * real, unmocked `createNoiseSuppressor()`, and asserts the gate actually
 * passes loud audio and attenuates quiet audio.
 *
 * No live Kaltura credentials required — this never touches the network.
 * Run across a browser matrix via VERIFY_BROWSER=chromium|firefox|webkit
 * (default chromium), mirroring scripts/live-verify-session-complete.mjs's
 * pattern. WebKit needs a real click before AudioContext.resume() will ever
 * settle (its autoplay/gesture gate blocks a page's own unattended script) —
 * the driver clicks the fixture's #go button before calling window.__start().
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium, firefox, webkit } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const PORT = Number(process.env.VERIFY_NOISE_SUPPRESSOR_PORT) || 4788;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

const ENGINES = { chromium, firefox, webkit };
const engineName = process.env.VERIFY_BROWSER || 'chromium';
const engine = ENGINES[engineName];
if (!engine) {
  console.error(`Unknown VERIFY_BROWSER "${engineName}" — expected one of: ${Object.keys(ENGINES).join(', ')}`);
  process.exit(1);
}

function startServer() {
  const server = createServer((req, res) => {
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
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(PORT, '127.0.0.1', () => resolvePromise(server));
  });
}

// Loud segments should pass through with only modest attenuation; quiet
// segments (simulated room noise, ~40dB below the loud tone) should be
// gated down hard. Ratios rather than absolute levels, since exact gain
// staging can vary slightly by engine/sample rate.
const LOUD_MIN_RATIO = 0.5; // output RMS must retain at least half the input RMS
const QUIET_MAX_RATIO = 0.3; // output RMS must drop to at most 30% of input RMS

let server;
let browser;
try {
  server = await startServer();
  browser = await engine.launch(
    engineName === 'chromium'
      ? { args: ['--autoplay-policy=no-user-gesture-required'] }
      : engineName === 'firefox'
        ? { firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.autoplay.block-webaudio': false } }
        : {},
  );
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/scripts/verify-noise-suppressor.html`);
  await page.click('#go');
  await page.evaluate(() => window.__start());
  let result;
  try {
    result = await page.waitForFunction(() => window.__result, null, { timeout: 20000 }).then((h) => h.jsonValue());
  } catch (timeoutErr) {
    console.error(`[${engineName}] page never produced a result within the timeout.`);
    if (consoleErrors.length) console.error(`[${engineName}] page console:`, consoleErrors);
    throw timeoutErr;
  }

  if (result.error) {
    console.error(`[${engineName}] FAIL — page error: ${result.error}`);
    process.exitCode = 1;
  } else {
    console.log(`[${engineName}] segments:`);
    let allPass = true;
    for (const seg of result.segments) {
      if (seg.outputRms === null) {
        console.error(`  ${seg.type}: NO SAMPLES CAPTURED — polling never landed inside this segment`);
        allPass = false;
        continue;
      }
      const ratio = seg.outputRms / seg.inputRms;
      const ok = seg.type === 'loud' ? ratio >= LOUD_MIN_RATIO : ratio <= QUIET_MAX_RATIO;
      console.log(`  ${seg.type}: inputRms=${seg.inputRms.toFixed(5)} outputRms=${seg.outputRms.toFixed(5)} ratio=${ratio.toFixed(3)} (n=${seg.samples}) ${ok ? 'OK' : 'FAIL'}`);
      if (!ok) allPass = false;
    }
    if (consoleErrors.length) {
      console.error(`[${engineName}] page console errors:`, consoleErrors);
      allPass = false;
    }
    if (allPass) {
      console.log(`[${engineName}] PASS — noise gate correctly passes loud audio and attenuates quiet audio.`);
    } else {
      console.error(`[${engineName}] FAIL — see above.`);
      process.exitCode = 1;
    }
  }
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
}
