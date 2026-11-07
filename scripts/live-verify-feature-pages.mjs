#!/usr/bin/env node
/**
 * Drives the real-browser feature pages (manual-testing/feature-pages/) in a real browser.
 * It starts serve.mjs as a child process, clicks through every page, checks what the
 * page shows, saves a screenshot per page, then stops the server and checks that
 * everything the server created is gone.
 *
 * Engine: LIVE_VERIFY_BROWSER=chromium|firefox|webkit (default chromium).
 * Credentials: same as serve.mjs (NVP1_* or AGENTIC_* variables, optional ENV_FILE).
 * The emotions page runs only when TARGET is set, and then it is the only page. It needs a
 * Limited Availability environment, for employees and certified partners only.
 * See manual-testing/feature-pages/README.md.
 *
 * Screenshots and the server log go to manual-testing/feature-pages/out/ (git-ignored).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { launchBrowser, warmFirefoxMedia, routeSocketIo, contextOptions, repoRoot, redact } from './live-verify-kickoff-shared.mjs';

const engineName = process.env.LIVE_VERIFY_BROWSER || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(engineName)) {
  console.error(`Unknown LIVE_VERIFY_BROWSER "${engineName}". Use chromium, firefox or webkit.`);
  process.exit(1);
}
const emotions = Boolean(process.env.TARGET);
const outDir = resolve(repoRoot, 'manual-testing/feature-pages/out');
mkdirSync(outDir, { recursive: true });

let failed = false;
/** @param {string} step @param {boolean} ok @param {unknown} [detail] */
function check(step, ok, detail) {
  if (!ok) failed = true;
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${step}${detail === undefined ? '' : ` ${redact(JSON.stringify(detail))}`}`);
}

/** Start serve.mjs and wait for its URL. @returns {Promise<{url:string, stop:()=>Promise<{code:number|null, log:string}>}>} */
function startServer() {
  const args = ['manual-testing/feature-pages/serve.mjs', '--ttl-minutes', '30', ...(emotions ? ['--emotions'] : [])];
  const child = spawn(process.execPath, args, { cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  const stop = async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 180_000))]);
    if (code === 'timeout') child.kill('SIGKILL');
    return { code: /** @type {number|null} */ (code === 'timeout' ? null : code), log };
  };
  const urlPromise = new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error('server did not print a URL in 5 minutes')), 300_000);
    const poll = setInterval(() => {
      const m = /^Open: (\S+)/m.exec(log);
      if (m) { clearTimeout(t); clearInterval(poll); ok(m[1]); }
    }, 250);
    exited.then(() => { clearTimeout(t); clearInterval(poll); fail(new Error(`server exited early:\n${redact(log)}`)); });
  });
  return urlPromise.then((url) => ({ url, stop }));
}

/** @param {string} text @param {string} label @returns {string|undefined} the value in a two-column table row */
const cell = (text, label) => text.split('\n').map((l) => l.split('\t')).find((p) => p[0] === label)?.[1];

async function main() {
  let server;
  try {
    server = await startServer();
  } catch (err) {
    check('server-start', false, String(err?.message || err));
    process.exit(1);
  }
  const base = server.url;
  const browser = await launchBrowser({ browser: engineName });
  const problems = [];
  try {
    const warmMs = await warmFirefoxMedia(browser);
    if (warmMs) console.log(`[info] firefox media warm-up ${warmMs} ms`);
    const context = await browser.newContext(contextOptions());
    await routeSocketIo(context);
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror: ${e?.message || e}`));
    // Playwright injects a style element while it takes a screenshot. WebKit reports the page's CSP refusing it. That is not a page error.
    let shooting = false;
    page.on('console', (m) => { if (m.type() === 'error' && !shooting) problems.push(`console.error: ${m.text()}`); });

    const open = async (name) => {
      await page.goto(`${base}manual-testing/feature-pages/${name}.html`);
      await page.waitForSelector('body[data-ready="true"]', { timeout: 20_000 });
    };
    const shot = async (name) => { shooting = true; try { await page.screenshot({ path: join(outDir, `${engineName}-${name}.png`), fullPage: true }); } finally { shooting = false; } };
    const text = (sel) => page.locator(sel).innerText();
    const waitData = (key, value, timeout = 90_000) => page.waitForFunction(([k, v]) => document.body.dataset[k] === v, [key, value], { timeout });
    const stepClick = async (sel, step) => { await page.click(sel); await waitData('step', step); };

    // The index lists only the pages this run serves.
    await page.goto(base);
    const links = await page.locator('a').allInnerTexts();
    check('index-lists-pages', emotions ? links.join() === 'emotions' : links.length === 5 && !links.includes('emotions'), links);

    if (!emotions) {
      // variables
      await open('variables');
      await page.click('#load');
      await waitData('loaded', 'true', 60_000);
      const sys = await text('#system');
      const custom = await text('#custom');
      check('variables-system-listed', sys.includes('sys__thread_id') && sys.includes('sys__user_message'), { rows: sys.split('\n').length });
      check('variables-custom-listed', custom.includes('sdk_live_color'), { custom: custom.replace(/\s+/g, ' ').slice(0, 120) });
      await shot('variables');

      // request-vars
      await open('request-vars');
      await page.click('#bad');
      await waitData('done', '1');
      const refused = await text('#result');
      await shot('request-vars-refused');
      check('request-vars-reserved-key-refused-offline', cell(refused, 'outcome') === 'refused' && cell(refused, 'code') === 'validation_error' && cell(refused, 'network calls') === '0', refused.replace(/\s+/g, ' ').slice(0, 200));
      await page.click('#good');
      await waitData('done', '2');
      const accepted = await text('#result');
      check('request-vars-allowed-key-reaches-agent', cell(accepted, 'outcome') === 'accepted' && cell(accepted, 'network calls') === '1' && (cell(accepted, 'reply') || '').length > 0, { reply: (cell(accepted, 'reply') || '').slice(0, 80) });
      await shot('request-vars');

      // side-question
      await open('side-question');
      await stepClick('#start', 'start');
      await stepClick('#side', 'side');
      await stepClick('#fork', 'fork');
      const st = await text('#state');
      check('side-question-unsaved-ask-adds-no-message', cell(st, 'saved messages in thread') === '1' && cell(st, 'saved messages after side question') === '1' && (cell(st, 'side answer') || '').length > 0, { saved: cell(st, 'saved messages in thread'), afterSide: cell(st, 'saved messages after side question') });
      check('side-question-fork-makes-new-thread', cell(st, 'fork thread') === 'new thread' && Number(cell(st, 'saved messages in fork')) >= 1 && cell(st, 'saved messages in source after fork') === '1', { fork: cell(st, 'fork thread'), forkSaved: cell(st, 'saved messages in fork'), source: cell(st, 'saved messages in source after fork') });
      await shot('side-question');

      // catalog-scope
      await open('catalog-scope');
      await stepClick('#create', 'create');
      let c = await text('#state');
      check('catalog-scope-created-in-scope-A', cell(c, 'item scope') === 'scope A' && cell(c, 'listed in scope A') === '1' && cell(c, 'listed in scope B') === '0' && cell(c, 'listed with no scope filter') === '0', c.replace(/\s+/g, ' '));
      await stepClick('#toB', 'toB');
      c = await text('#state');
      check('catalog-scope-moved-to-B', cell(c, 'item scope') === 'scope B' && cell(c, 'listed in scope A') === '0' && cell(c, 'listed in scope B') === '1', c.replace(/\s+/g, ' '));
      await stepClick('#clear', 'clear');
      c = await text('#state');
      check('catalog-scope-cleared', cell(c, 'item scope') === 'none' && cell(c, 'listed with no scope filter') === '1', c.replace(/\s+/g, ' '));
      const thumb = await page.evaluate(() => { const i = /** @type {HTMLImageElement} */ (document.getElementById('thumb')); return { shown: !i.hidden, w: i.naturalWidth }; });
      check('catalog-scope-thumbnail-loads', thumb.shown && thumb.w > 0, thumb);
      await shot('catalog-scope');

      // connect-errors
      await open('connect-errors');
      await page.click('#refuse');
      await waitData('refused', 'true', 60_000);
      const err = await text('#error');
      check('connect-errors-server-reason', cell(err, 'outcome') === 'refused' && cell(err, 'code') === 'unsupported_client' && cell(err, 'serverCode') === 'INVALID_KS', err.replace(/\s+/g, ' '));
      await page.click('#notice');
      await waitData('noticeDone', 'true', 90_000);
      const warn = await text('#warn');
      check('connect-errors-form-notice-once', cell(warn, 'connected') === 'yes' && cell(warn, 'notices after two calls') === '1', warn.replace(/\s+/g, ' ').slice(0, 200));
      await shot('connect-errors');
    } else {
      await open('emotions');
      await page.click('#on');
      await waitData('done', '1', 120_000);
      const on = await text('#result');
      const segs = Number(cell(on, 'avatar segments'));
      check('emotions-on-labels-present', cell(on, 'emotions') === 'on' && segs >= 1 && Number(cell(on, 'segments with a known label')) >= 1, on.replace(/\s+/g, ' '));
      await shot('emotions-on');
      await page.click('#off');
      await waitData('done', '2', 120_000);
      const off = await text('#result');
      check('emotions-off-no-labels', cell(off, 'emotions') === 'off' && cell(off, 'chunks carrying any emotion field') === '0' && Number(cell(off, 'avatar segments')) >= 0, off.replace(/\s+/g, ' '));
      await shot('emotions-off');
    }
    check('no-page-errors', problems.length === 0, problems.slice(0, 5));
    await context.close();
  } catch (err) {
    check('run', false, String(/** @type {any} */ (err)?.message || err));
  } finally {
    await browser.close().catch(() => {});
  }

  const { code, log } = await server.stop();
  writeFileSync(join(outDir, `${engineName}-serve.log`), redact(log));
  check('server-teardown-verified', code === 0 && /teardown verified/.test(log), { exit: code });

  // Leak scan: counts only.
  const secrets = ['NVP1_AGENTIC_ADMIN_SECRET', 'AGENTIC_ADMIN_SECRET', 'NVQ2_ADMIN_SECRET_1'].map((k) => process.env[k]).filter((v) => v && v.length > 8);
  let secretHits = 0; let ksHits = 0;
  for (const f of readdirSync(outDir)) {
    if (!/\.(log|txt|json)$/.test(f)) continue;
    const body = readFileSync(join(outDir, f), 'utf8');
    secretHits += secrets.filter((s) => body.includes(/** @type {string} */ (s))).length;
    ksHits += (body.match(/djJ8[A-Za-z0-9_=+/-]{8,}/g) || []).length;
  }
  check('no-secret-or-ks-in-logs', secretHits === 0 && ksHits === 0, { secretHits, ksHits });
  process.exit(failed ? 1 : 0);
}

await main();
