#!/usr/bin/env node
/**
 * Cross-browser check of the showroom example, in demo mode (no credentials).
 *
 *   node scripts/verify-showroom.mjs [--browsers=chromium,firefox,webkit] [--shots=<dir>]
 *
 * For each browser and each target screen size it checks layout, readable text,
 * touch-target size, accessibility (axe), and console errors. It then plays the video-clip
 * body (the default), checks a frame-time budget, and runs the
 * same purchase by voice and by touch and requires the same cart. Kiosk idle
 * reset and reduced motion get one run each, and the light theme gets an axe pass on every scene. Exits 1 on any failure.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const BROWSERS = { chromium, firefox, webkit };
const wanted = (args.browsers || 'chromium,firefox,webkit').split(',');
const shotsDir = args.shots ? path.resolve(args.shots) : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

const SIZES = [
  { name: 'phone', width: 390, height: 844, layout: 'phone', touch: true },
  { name: 'tablet', width: 820, height: 1180, layout: 'tall', touch: true },
  { name: 'laptop', width: 1366, height: 768, layout: 'wide' },
  { name: 'desktop', width: 1920, height: 1080, layout: 'wide' },
  { name: 'kiosk', width: 1080, height: 1920, layout: 'tall', touch: true },
];
const TABS = ['devices', 'accessories', 'plans', 'tradein', 'cart'];

const PORT = 8093;
const BASE = `http://127.0.0.1:${PORT}/examples/showroom/index.html`;
const failures = [];
const fail = (where, msg) => { failures.push(`${where}: ${msg}`); console.log(`  FAIL ${where}: ${msg}`); };
const check = (ok, where, msg) => { if (!ok) fail(where, msg); };

const server = spawn(process.execPath, ['examples/showroom/server.mjs'], { cwd: ROOT, env: { PORT: String(PORT), PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('Showroom on') && resolve()); server.on('exit', (c) => reject(new Error(`server exited ${c}`))); });

async function open(browser, size, query = '', ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, hasTouch: !!size.touch && browser.browserType().name() !== 'firefox', ...ctxOpts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}?demo&fast${query}`);
  await page.getByTestId('start').click();
  await page.getByTestId('scene-host').locator('.scene-welcome').waitFor();
  return { ctx, page, errors };
}

const goto = async (page, scene) => {
  if (await page.locator('.scene-welcome').count()) await page.getByTestId('go-devices').click();
  await page.getByTestId(`tab-${scene}`).click(); await page.locator(`.scene-${scene}`).waitFor(); };
const state = (page) => page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__showroom.store.getState())));

async function layoutChecks(page, where, size) {
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const rig = document.querySelector('.rig').getBoundingClientRect();
    const host = document.querySelector('.scene-host');
    // offset sizes ignore transforms, so the enter animation (scale) cannot skew the check
    const small = [...document.querySelectorAll('button:not([hidden])')].filter((b) => { if (!b.offsetWidth) return false; return b.offsetHeight < 44 || b.offsetWidth < 44; }).map((b) => b.dataset.testid || b.textContent.slice(0, 20));
    const stage = document.querySelector('.stage');
    // The fake phone clock is a picture of a screen, not text to read.
    const minText = Math.min(99, ...[...document.querySelectorAll('body *')].filter((e) => !e.closest('.phone') && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((e) => parseFloat(globalThis.getComputedStyle(e).fontSize)));
    return {
      minText,
      layout: stage.dataset.layout, font: parseFloat(globalThis.getComputedStyle(stage).fontSize),
      overflowX: doc.scrollWidth > globalThis.innerWidth + 1, hostOverflowX: host.scrollWidth > host.clientWidth + 1, hostOverflowY: host.scrollHeight - host.clientHeight,
      rig: { l: rig.left, r: rig.right, t: rig.top, b: rig.bottom }, vw: globalThis.innerWidth, vh: globalThis.innerHeight, small,
    };
  });
  check(m.layout === size.layout, where, `layout ${m.layout}, wanted ${size.layout}`);
  check(m.font >= 14, where, `font ${m.font}px under 14`);
  check(m.minText >= 12, where, `smallest text ${m.minText}px, floor is 12`);
  check(!m.overflowX, where, 'page scrolls sideways');
  check(!m.hostOverflowX, where, 'scene content wider than its panel');
  // Big screens show a whole scene at once. A phone may scroll.
  if (size.layout !== 'phone') check(m.hostOverflowY <= 40, where, `scene needs scrolling (${m.hostOverflowY}px too tall)`);
  // The tall kiosk frame is wider than its column. Its edges are see-through, so only the middle of the frame must be on screen.
  const wideFrame = size.layout === 'tall' && m.vw / m.vh < 0.62;
  const cx = (m.rig.l + m.rig.r) / 2;
  check((wideFrame ? cx - 0.25 * (m.rig.r - m.rig.l) >= -1 && cx + 0.25 * (m.rig.r - m.rig.l) <= m.vw + 1 : m.rig.l >= -1 && m.rig.r <= m.vw + 1) && m.rig.t >= -1 && m.rig.b <= m.vh + 1, where, `robot outside the screen ${JSON.stringify(m.rig)}`);
  check(m.small.length === 0, where, `touch targets under 44px: ${m.small.join(', ')}`);
}

async function axe(page, where) {
  await page.waitForTimeout(700); // let the scene enter animation finish, or contrast is measured mid-fade
  await page.addScriptTag({ path: axeSource });
  const res = await page.evaluate(() => globalThis.axe.run(document, { resultTypes: ['violations'] }));
  for (const v of res.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical')) fail(where, `axe ${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
}

const shot = async (page, name) => { if (!shotsDir) return; await page.waitForTimeout(700); await page.screenshot({ path: path.join(shotsDir, `${name}.png`) }); };

async function sizesRun(browser, bname) {
  for (const size of SIZES) {
    const where = `${bname} ${size.name} ${size.width}x${size.height}`;
    const { ctx, page, errors } = await open(browser, size);
    await layoutChecks(page, `${where} welcome`, size);
    await shot(page, `${bname}-${size.name}-welcome`);
    for (const scene of TABS) {
      await goto(page, scene);
      await layoutChecks(page, `${where} ${scene}`, size);
      if (scene === 'plans' || scene === 'cart') await axe(page, `${where} ${scene}`);
    }
    await goto(page, 'devices');
    await page.getByTestId('device-orbit-flip').click();
    await page.locator('.scene-device').waitFor();
    await layoutChecks(page, `${where} device`, size);
    await page.waitForTimeout(900); // let the reply to the tap note finish. A new turn clears older chips.
    await page.evaluate(() => globalThis.__showroom.session.hear('show me the flip'));
    await page.getByTestId('suggest').locator('.kgenui__chip').first().waitFor();
    await layoutChecks(page, `${where} device with chips`, size);
    await shot(page, `${bname}-${size.name}-device`);
    await axe(page, `${where} device`);
    await page.getByTestId('add-device').click();
    await goto(page, 'cart');
    await shot(page, `${bname}-${size.name}-cart`);
    check(errors.length === 0, where, `console errors: ${errors.slice(0, 2).join(' | ')}`);
    await ctx.close();
    console.log(`  ok ${where}`);
  }
}

async function parityRun(browser, bname) {
  const where = `${bname} voice-vs-touch`;
  const size = SIZES[3];
  // Voice
  const a = await open(browser, size);
  await a.page.evaluate(() => { const s = globalThis.__showroom.session; s.hear('show me the flip'); });
  await a.page.locator('.scene-device').waitFor();
  await a.page.evaluate(() => globalThis.__showroom.session.hear('I want 256'));
  await a.page.getByTestId('storage-256').and(a.page.locator('[aria-pressed=true]')).waitFor();
  await a.page.evaluate(() => globalThis.__showroom.session.hear('add it to my cart'));
  await a.page.locator('.scene-cart').waitFor();
  const voice = await state(a.page);
  await a.page.getByTestId('place-order').click();
  const voiceOrder = await a.page.getByTestId('order-number').textContent();
  await a.ctx.close();
  // Touch
  const b = await open(browser, size);
  await goto(b.page, 'devices');
  await b.page.getByTestId('device-orbit-flip').click();
  await b.page.getByTestId('storage-256').click();
  await b.page.getByTestId('add-device').click();
  await goto(b.page, 'cart');
  const touch = await state(b.page);
  await b.page.waitForTimeout(900); // notes are batched: the agent gets one note for a burst of taps
  const turns = await b.page.evaluate(() => globalThis.__showroom.session.turns);
  const vars = await b.page.evaluate(() => globalThis.__showroom.session.requestVars);
  await b.page.getByTestId('place-order').click();
  const touchOrder = await b.page.getByTestId('order-number').textContent();
  await b.ctx.close();

  check(JSON.stringify(voice.cart) === JSON.stringify(touch.cart), where, `carts differ: ${JSON.stringify(voice.cart)} vs ${JSON.stringify(touch.cart)}`);
  check(voice.cart.device?.id === 'orbit-flip' && voice.cart.device.storageGb === 256, where, 'voice journey did not build the expected cart');
  check(voiceOrder === touchOrder, where, `order numbers differ ${voiceOrder} vs ${touchOrder}`);
  check(turns.some((t) => t.includes('added the Orbit Flip to the cart')), where, `tap notes missing: ${JSON.stringify(turns)}`);
  check(/Orbit Flip/.test(vars.cart || '') && /cart/i.test(vars.screen || ''), where, `request vars stale: ${JSON.stringify(vars)}`);
  console.log(`  ok ${where}`);
}

async function chipsRun(browser, bname) {
  const where = `${bname} follow-up chips`;
  const { ctx, page, errors } = await open(browser, SIZES[3]);
  await page.evaluate(() => globalThis.__showroom.session.hear('show me the flip'));
  const chips = page.getByTestId('suggest').locator('.kgenui__chip');
  await chips.first().waitFor();
  check((await chips.count()) >= 2, where, 'fewer than two chips');
  check(!(await page.getByTestId('hint').isVisible()), where, '"Try saying" hint should give way to the chips');
  const label = (await chips.first().textContent()).trim();
  await chips.first().click();
  check((await chips.count()) === 0, where, 'chips stay after a tap');
  const turns = await page.evaluate(() => globalThis.__showroom.session.turns);
  check(turns.includes(label), where, `tapped chip was not sent to the agent: ${JSON.stringify(turns)}`);
  await page.getByTestId('hint').waitFor({ state: 'visible' });
  check(errors.length === 0, where, `console errors: ${errors.join(' | ')}`);
  await ctx.close();
  console.log(`  ok ${where}`);
}

async function clipBodyRun(browser, bname) {
  const where = `${bname} clip body`;
  for (const size of [SIZES[3], SIZES[4], SIZES[0]]) {
    const w = `${where} ${size.name}`;
    const { ctx, page, errors } = await open(browser, size);
    await page.locator('.rig-clips').waitFor();
    await layoutChecks(page, w, size);
    // The greeting wave holds the idle loop still while it plays, so wait for it to hand back.
    await page.waitForFunction(() => !globalThis.__showroom.rig.busy, null, { timeout: 15000 }).catch(() => fail(w, 'the greeting gesture never handed back'));
    const t0 = await page.evaluate(() => document.querySelector('.clip-idle').currentTime);
    await page.waitForTimeout(700);
    const idle = await page.evaluate(() => { const v = document.querySelector('.clip-idle'); return { t: v.currentTime, paused: v.paused, w: v.videoWidth }; });
    check(!idle.paused && idle.t !== t0 && idle.w > 0, w, `idle clip is not playing ${JSON.stringify({ t0, ...idle })}`);
    // Screens under 600 px wide load the phone-size copy, bigger screens the full body.
    const src = await page.evaluate(() => document.querySelector('.clip-idle').currentSrc);
    check(src.includes('/guide-lite/') === (size.width < 600), w, `wrong body for this width: ${src}`);
    await page.evaluate(() => globalThis.__showroom.rig.perform('celebrate'));
    await page.waitForFunction(() => { const playing = [...document.querySelectorAll('.clip-over')].some((o) => !o.paused && o.currentTime > 0); return document.querySelector('.rig').dataset.gesture === 'celebrate' && playing; }, null, { timeout: 6000 }).catch(() => fail(w, 'gesture clip did not start'));
    // The head must keep following the neck while the gesture plays: its offset changes from frame to frame and stays small.
    const follow = await page.evaluate(async () => {
      const slot = document.querySelector('.rig-visor');
      const seen = new Set();
      let worst = 0;
      for (let i = 0; i < 20; i++) {
        const [x, y, r] = ['--hx', '--hy', '--hr'].map((k) => parseFloat(slot.style.getPropertyValue(k)));
        seen.add(`${x.toFixed(1)},${y.toFixed(1)},${r.toFixed(4)}`);
        worst = Math.max(worst, Math.abs(r) || 0);
        await new Promise((res) => setTimeout(res, 60));
      }
      return { distinct: seen.size, worst };
    });
    check(follow.distinct > 3 && follow.worst < 0.3, w, `head did not follow the neck during the gesture ${JSON.stringify(follow)}`);
    await page.waitForFunction(() => document.querySelector('.rig').dataset.gesture === '', null, { timeout: 8000 }).catch(() => fail(w, 'gesture clip did not hand back to idle'));
    check(errors.length === 0, w, `console errors: ${errors.slice(0, 2).join(' | ')}`);
    await shot(page, `${bname}-${size.name}-clip-body`);
    await ctx.close();
  }
  // A body that cannot load must not leave the page empty.
  const { ctx, page } = await open(browser, SIZES[3], '&body=does-not-exist');
  check((await page.locator('.rig-body').count()) === 1 && (await page.locator('.rig-clips').count()) === 0, where, 'missing body did not fall back to the SVG robot');
  await ctx.close();
  // The SVG robot is the other body and must keep fitting every layout.
  for (const size of [SIZES[4], SIZES[0]]) {
    const r = await open(browser, size, '&body=rig');
    await layoutChecks(r.page, `${where} svg-robot ${size.name}`, size);
    await r.ctx.close();
  }
  console.log(`  ok ${where}`);
}

// Performance budget. Frame times come from rAF in every browser. Long tasks exist in Chromium only.
const BUDGET = { frameP95Ms: 40, readyMs: 3000, longTasks: 2 };
async function perfRun(browser, bname) {
  const where = `${bname} performance`;
  const ctx = await browser.newContext({ viewport: { width: SIZES[3].width, height: SIZES[3].height } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    globalThis.__long = 0;
    try { new globalThis.PerformanceObserver((l) => { globalThis.__long += l.getEntries().length; }).observe({ type: 'longtask', buffered: true }); } catch { /* not supported here */ }
  });
  const t0 = Date.now();
  await page.goto(`${BASE}?demo&fast`);
  await page.getByTestId('start').waitFor();
  const ready = Date.now() - t0;
  await page.getByTestId('start').click();
  await page.getByTestId('scene-host').locator('.scene-welcome').waitFor();
  // Three 3 s windows. The first holds a scene change, chips and a gesture. The median window by p95 is judged, so one load spike on a busy host does not fail a build.
  const windows = [];
  for (let i = 0; i < 3; i++) {
    windows.push(await page.evaluate((change) => new Promise((resolve) => {
      const dts = []; let last = globalThis.performance.now(); const end = last + 3000;
      if (change) globalThis.__showroom.session.hear('show me the flip');
      (function loop(now) {
        dts.push(now - last); last = now;
        if (now < end) globalThis.requestAnimationFrame(loop);
        else { dts.shift(); dts.sort((a, b) => a - b); resolve({ n: dts.length, p50: dts[Math.floor(dts.length * 0.5)], p95: dts[Math.floor(dts.length * 0.95)], max: dts.at(-1), long: globalThis.__long }); }
      })(last);
    }), i === 0));
  }
  const stats = [...windows].sort((x, y) => x.p95 - y.p95)[1];
  const r = (n) => Math.round(n * 10) / 10;
  console.log(`  ${where}: ready ${ready}ms, ${stats.n} frames, p50 ${r(stats.p50)}ms, p95 ${r(stats.p95)}ms, max ${r(stats.max)}ms, long tasks ${stats.long}`);
  check(ready <= BUDGET.readyMs, where, `ready in ${ready}ms, budget ${BUDGET.readyMs}`);
  check(stats.p95 <= BUDGET.frameP95Ms, where, `frame p95 ${r(stats.p95)}ms, budget ${BUDGET.frameP95Ms}`);
  check(stats.long <= BUDGET.longTasks, where, `${stats.long} long tasks, budget ${BUDGET.longTasks}`);
  await ctx.close();
}

async function kioskRun(browser, bname) {
  const where = `${bname} kiosk-reset`;
  const { ctx, page } = await open(browser, SIZES[4], '&kiosk&idle=800&warn=400');
  await goto(page, 'accessories');
  await page.getByTestId('add-buds').click();
  check((await state(page)).cart.accessories.buds === 1, where, 'could not add before idle');
  await page.waitForFunction(() => globalThis.__showroom.store.getState().scene === 'welcome', null, { timeout: 5000 }).catch(() => fail(where, 'no reset to the welcome screen'));
  const s = await state(page);
  check(Object.keys(s.cart.accessories).length === 0, where, 'cart not emptied after reset');
  // The visit ends with the cart: the next visitor gets the welcome card and a new conversation.
  await page.getByTestId('start').waitFor({ state: 'visible', timeout: 2000 }).catch(() => fail(where, 'no welcome card for the next visitor'));
  check(await page.getByTestId('mic').isHidden(), where, 'mic button still shown with no conversation');
  check(await page.locator('.stage').evaluate((st) => [...st.children].filter((c) => !c.classList.contains('start')).every((c) => c.hasAttribute('inert'))), where, 'the page behind the welcome card can still take focus');
  await ctx.close();
  console.log(`  ok ${where}`);
}

// A live start that keeps failing is tried three times, then shows the error and a way to try again.
async function retryRun(browser, bname) {
  const where = `${bname} start retry`;
  const ctx = await browser.newContext({ viewport: { width: SIZES[3].width, height: SIZES[3].height } });
  const page = await ctx.newPage();
  let initCalls = 0;
  await page.addInitScript(() => { globalThis.io = () => ({}); }); // skip the socket.io download: only the token call matters here
  await page.route('**/appInit', (r) => { initCalls++; r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }); });
  await page.goto(BASE);
  await page.getByTestId('start').click();
  check(await page.getByTestId('start-overlay').getAttribute('data-phase') === 'joining', where, 'no joining notice after the tap');
  check(await page.locator('.stage').getAttribute('data-presence') === 'joining', where, 'she looks present while still joining');
  await page.waitForFunction(() => document.querySelector('.chip')?.dataset.state === 'error', null, { timeout: 15000 }).catch(() => fail(where, 'no error state after failed starts'));
  check(initCalls === 3, where, `expected 3 tries, saw ${initCalls}`);
  check(await page.getByTestId('start').isVisible(), where, 'no way to try again after the last failure');
  check(await page.getByTestId('start-overlay').getAttribute('data-phase') === 'failed', where, 'the card does not say the start failed');
  check(await page.locator('.stage').getAttribute('data-presence') === 'away', where, 'she looks present after a failed start');
  await ctx.close();
  console.log(`  ok ${where}`);
}

async function motionRun(browser, bname) {
  const where = `${bname} reduced-motion`;
  const { ctx, page } = await open(browser, SIZES[3], '&body=rig', { reducedMotion: 'reduce' });
  const before = await page.locator('.rig-arm-r').getAttribute('transform');
  await page.evaluate(() => globalThis.__showroom.rig.perform('wave'));
  await page.waitForTimeout(800);
  const after = await page.locator('.rig-arm-r').getAttribute('transform');
  check(before === after, where, `arm moved under reduced motion: ${before} -> ${after}`);
  await ctx.close();
  console.log(`  ok ${where}`);
}

// The light theme: dark text on a bright scene must pass axe contrast on every scene, in a landscape and a portrait window.
async function lightRun(browser, bname) {
  for (const size of [SIZES[0], SIZES[3], SIZES[4]]) {
    const where = `${bname} light ${size.name}`;
    const { ctx, page, errors } = await open(browser, size, '&theme=light');
    check(await page.locator('.stage[data-theme="light"]').count() === 1, where, 'theme attribute missing');
    await axe(page, `${where} welcome`);
    for (const scene of TABS) { await goto(page, scene); await page.waitForTimeout(600); await axe(page, `${where} ${scene}`); } // the scene fades in: wait, or axe reads a half-faded color
    await page.getByTestId('tab-devices').click();
    await page.getByTestId('device-orbit-flip').click();
    await page.locator('.scene-device').waitFor();
    await page.waitForTimeout(600);
    await axe(page, `${where} device`);
    await shot(page, `${bname}-${size.name}-light`);
    check(errors.length === 0, where, `console errors: ${errors.slice(0, 2).join(' | ')}`);
    await ctx.close();
    console.log(`  ok ${where}`);
  }
}

let ran = 0;
try {
  for (const bname of wanted) {
    console.log(bname);
    let browser;
    try { browser = await BROWSERS[bname].launch(bname === 'chromium' ? { args: ['--mute-audio'] } : bname === 'firefox' ? { firefoxUserPrefs: { 'media.volume_scale': '0.0' } } : {}); } catch (e) { console.log(`  SKIP ${bname}: ${String(e.message).split('\n')[0]}`); continue; }
    ran++;
    try {
      await sizesRun(browser, bname);
      await parityRun(browser, bname);
      await chipsRun(browser, bname);
      await clipBodyRun(browser, bname);
      await perfRun(browser, bname);
      await kioskRun(browser, bname);
      await motionRun(browser, bname);
      await retryRun(browser, bname);
      await lightRun(browser, bname);
    } catch (e) { fail(bname, e.stack || String(e)); }
    await browser.close();
  }
} finally { server.kill(); }

if (!ran) { console.log('No browser could launch.'); process.exit(1); }
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nAll showroom checks passed.');
process.exit(failures.length ? 1 : 0);
