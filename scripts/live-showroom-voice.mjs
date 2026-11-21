#!/usr/bin/env node
/**
 * Hands-free check of the live showroom agent in Chromium, Firefox and WebKit.
 *
 *   node --env-file=.env scripts/live-showroom-voice.mjs [--browsers=chromium,firefox,webkit] [--wav=<file>] [--shots=<dir>] [--size=1920x1080]
 *
 * Needs AGENTIC_PARTNER_ID and AGENTIC_ADMIN_SECRET, and an agent made by
 * examples/showroom/agent/provision.mjs. No real microphone is used. The script
 * swaps `getUserMedia` for a WebAudio stream that plays a recorded sentence, so the
 * real path runs: mic → speech recognition → agent → `show_device` tool → screen.
 * The sentence comes from `--wav`, or from macOS `say` and ffmpeg when you give none.
 * The browsers run silent, so nothing plays through your speakers.
 * Passes when the device screen and the suggested-question chips appear without a tap, the raw live video stays hidden,
 * and the neck seam of the clip body shows no cut in 12 screenshots (the sharpest row step is under 6 times the even-fade step).
 */
import { spawn, spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const BROWSERS = { chromium, firefox, webkit };
const wanted = (args.browsers || 'chromium,firefox,webkit').split(',');
const PORT = 8095;
const PHRASE = 'Show me the Orbit Flip phone.';
const LEAD_IN_S = 12; // the agent greets first. Speak after it finishes.

if (!process.env.AGENTIC_PARTNER_ID || !process.env.AGENTIC_ADMIN_SECRET) { console.error('Set AGENTIC_PARTNER_ID and AGENTIC_ADMIN_SECRET (for example with node --env-file=.env).'); process.exit(2); }

const tmp = mkdtempSync(path.join(tmpdir(), 'showroom-voice-'));
let wavFile = args.wav && path.resolve(args.wav);
if (!wavFile) {
  const aiff = path.join(tmp, 'say.aiff');
  wavFile = path.join(tmp, 'voice.wav');
  if (spawnSync('say', ['-o', aiff, PHRASE]).status !== 0) { console.error('No --wav given and macOS `say` is not available.'); process.exit(2); }
  const ff = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', aiff, '-af', `adelay=${LEAD_IN_S * 1000}:all=1,apad=pad_dur=20`, '-ar', '48000', '-ac', '1', wavFile]);
  if (ff.status !== 0) { console.error('ffmpeg could not make the sentence.'); process.exit(2); }
}
const wav = readFileSync(wavFile);

const server = spawn(process.execPath, ['examples/showroom/server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('Showroom on') && resolve()); server.on('exit', (c) => reject(new Error(`server exited ${c}`))); });

/** Runs in the page before any script. Keeps every media element silent, so the test never plays through the speakers. WebKit has no mute switch, so this covers all three. The page still thinks it is unmuted. */
function silenceMedia() {
  const proto = globalThis.HTMLMediaElement.prototype;
  Object.defineProperty(proto, 'volume', { configurable: true, get: () => 1, set: () => {} });
  const mutedDesc = Object.getOwnPropertyDescriptor(proto, 'muted');
  let real = false;
  Object.defineProperty(proto, 'muted', { configurable: true, get() { return real; }, set(v) { real = !!v; mutedDesc.set.call(this, true); } });
  const attach = (el) => { try { mutedDesc.set.call(el, true); } catch { /* element not ready */ } };
  new globalThis.MutationObserver((list) => list.forEach((r) => r.addedNodes.forEach((n) => { if (n.matches?.('audio,video')) attach(n); n.querySelectorAll?.('audio,video').forEach(attach); }))).observe(globalThis.document, { childList: true, subtree: true });
  const play = proto.play;
  proto.play = function silentPlay(...a) { attach(this); return play.apply(this, a); };
}

/** Runs in the page before any script. Patches `navigator.mediaDevices` on every access, since WebKit can hand out a new object. */
function installFakeMic() {
  const original = Object.getOwnPropertyDescriptor(globalThis.Navigator.prototype, 'mediaDevices').get;
  const done = new WeakSet();
  const fake = async () => {
    const ac = new (globalThis.AudioContext || globalThis.webkitAudioContext)({ sampleRate: 48000 });
    await ac.resume();
    const dest = ac.createMediaStreamDestination();
    const src = ac.createBufferSource();
    src.buffer = await ac.decodeAudioData(await (await globalThis.fetch('/__voice.wav')).arrayBuffer());
    src.connect(dest);
    src.start();
    globalThis.__fakeMicCalls = (globalThis.__fakeMicCalls || 0) + 1;
    return dest.stream;
  };
  Object.defineProperty(globalThis.Navigator.prototype, 'mediaDevices', {
    configurable: true,
    get() {
      const md = original.call(this);
      if (md && !done.has(md)) { done.add(md); Object.defineProperty(md, 'getUserMedia', { configurable: true, writable: true, value: fake }); }
      return md;
    },
  });
}

/** Decodes an 8-bit, non-interlaced PNG (what Playwright screenshots are) to `{ w, h, bpp, data }` without filters left. */
function decodePng(buf) {
  let off = 8, w = 0, h = 0, bpp = 4; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8), body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); bpp = body[9] === 6 ? 4 : 3; } else if (type === 'IDAT') idat.push(body);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, data = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? data[dst + i - bpp] : 0, b = y ? data[dst - stride + i] : 0, c = i >= bpp && y ? data[dst - stride + i - bpp] : 0, x = raw[src + i];
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      data[dst + i] = (x + (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : (pa <= pb && pa <= pc ? a : pb <= pc ? b : c))) & 255;
    }
  }
  return { w, h, bpp, data };
}

/**
 * How sharp the sharpest row-to-row colour step in the neck seam is, compared with an even fade across the same rows (1 = perfectly even).
 * A cut shows as one row that carries far more than its share. Measuring the ratio keeps the result the same at any figure size,
 * since a small figure has fewer rows in the seam and so a bigger step per row.
 */
function seamStep(png, box) {
  const { w, bpp, data } = png; const steps = []; let prev = null;
  for (let y = Math.max(0, box.y0); y <= box.y1; y++) {
    const row = [0, 0, 0]; let n = 0;
    for (let x = box.x0; x < box.x1; x++) { const i = (y * w + x) * bpp; row[0] += data[i]; row[1] += data[i + 1]; row[2] += data[i + 2]; n++; }
    const mean = row.map((v) => v / n);
    if (prev) steps.push((Math.abs(mean[0] - prev[0]) + Math.abs(mean[1] - prev[1]) + Math.abs(mean[2] - prev[2])) / 3);
    prev = mean;
  }
  if (!steps.length) return 0;
  const even = Math.max(2, steps.reduce((a, b) => a + b, 0) / steps.length);
  return Math.max(...steps) / even;
}
const SEAM_LIMIT = 6; // an even fade measures about 3 at any size. A cut puts several rows' worth of change into one row.
const passed = (r) => r.device && r.chips && !r.rawShown && !(r.seamWorst > SEAM_LIMIT);
const SEAM_SAMPLES = 12;

const results = [];
async function run(bname) {
  let browser;
  try { browser = await BROWSERS[bname].launch(bname === 'firefox' ? { firefoxUserPrefs: { 'media.autoplay.default': 0, 'media.volume_scale': '0.0' } } : bname === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] } : {}); } catch (e) { return { bname, skipped: String(e.message).split('\n')[0] }; }
  const [vw, vh] = (args.size || '1920x1080').split('x').map(Number);
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  await ctx.route('**/__voice.wav', (r) => r.fulfill({ body: wav, contentType: 'audio/wav' }));
  await ctx.addInitScript(silenceMedia);
  await ctx.addInitScript(installFakeMic);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 140)); });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 140)));
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/examples/showroom/index.html`);
  await page.getByTestId('start').click();
  const device = await page.locator('.scene-device').waitFor({ timeout: 60000 }).then(() => true, () => false);
  const chips = device && await page.getByTestId('suggest').locator('.kgenui__chip').first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  if (args.shots) { await page.waitForTimeout(1500); await page.screenshot({ path: path.join(path.resolve(args.shots), `live-${bname}${args.size ? `-${args.size}` : ''}.png`) });
    // The raw avatar frame, to check how it lines up with the body.
    const frame = await page.evaluate(() => { const v = document.querySelector('.avatar-video'); if (!v?.videoWidth) return null; const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0); return { w: c.width, h: c.height, png: c.toDataURL('image/png').split(',')[1] }; }).catch(() => null);
    if (frame) writeFileSync(path.join(path.resolve(args.shots), `live-${bname}-video.png`), Buffer.from(frame.png, 'base64'));
  }
  // Sample the neck seam over several frames while she is speaking and gesturing. Skipped when the page has no clip body.
  let seamWorst = null;
  const geo = await page.evaluate(async () => {
    const rig = document.querySelector('.rig-clips'); if (!rig) return null;
    const m = await (await globalThis.fetch('bodies/guide/manifest.json')).json(); const r = rig.getBoundingClientRect();
    return { l: r.left, t: r.top, w: r.width, h: r.height, head: m.head, seam: m.seam };
  }).catch(() => null);
  if (geo?.seam) {
    const cx = geo.l + geo.w * (geo.head.left + geo.head.width / 2), half = geo.w * geo.head.width * 0.12;
    const box = { x0: Math.max(0, Math.round(cx - half)), x1: Math.round(cx + half), y0: Math.round(geo.t + geo.h * geo.seam[0]), y1: Math.round(geo.t + geo.h * geo.seam[1]) };
    seamWorst = 0;
    for (let i = 0; i < SEAM_SAMPLES; i++) { seamWorst = Math.max(seamWorst, seamStep(decodePng(await page.screenshot({ type: 'png' })), box)); await page.waitForTimeout(400); }
  }
  // The head is drawn from the live video onto a canvas. The raw video must stay hidden, or its backdrop shows as a box around the head.
  const rawShown = await page.evaluate(() => [...document.querySelectorAll('.rig-clips .rig-visor video')].some((v) => Number(globalThis.getComputedStyle(v).opacity) > 0)).catch(() => false);
  const micCalls = await page.evaluate(() => globalThis.__fakeMicCalls || 0);
  const seconds = (Date.now() - t0) / 1000;
  await browser.close();
  return { bname, device, chips, micCalls, seconds, errors, seamWorst, rawShown };
}

try {
  for (const bname of wanted) {
    // The backend sometimes answers 500 on session start. Retry a start failure, never a wrong answer.
    let r = await run(bname);
    for (let i = 0; i < 2 && !r.skipped && !r.micCalls; i++) r = await run(bname);
    results.push(r);
    if (r.skipped) console.log(`SKIP ${bname}: ${r.skipped}`);
    else console.log(`${passed(r) ? 'ok  ' : 'FAIL'} ${bname}: mic opened ${r.micCalls}x, device screen ${r.device}, chips ${r.chips}${r.rawShown ? ', raw live video visible' : ''}${r.seamWorst == null ? '' : `, neck seam sharpness ${r.seamWorst.toFixed(1)}x over ${SEAM_SAMPLES} frames (limit ${SEAM_LIMIT})`}, ${r.seconds.toFixed(1)}s${r.errors.length ? `, console errors: ${r.errors.slice(0, 2).join(' | ')}` : ''}`);
  }
} finally { server.kill(); rmSync(tmp, { recursive: true, force: true }); }
const ran = results.filter((r) => !r.skipped);
process.exit(ran.length && ran.every(passed) ? 0 : 1);
