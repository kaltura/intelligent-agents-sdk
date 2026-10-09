#!/usr/bin/env node
/**
 * Live verification that closing the tab releases the avatar stream on the server.
 * The browser closes the page, the script then asks the server, from Node, whether a viewer is
 * still attached to that avatar session. A request with a dummy offer is answered 409 while a
 * viewer is attached, and with anything else once the viewer is gone. This checks the outcome a
 * user sees. The SDK's own DELETE on page exit is covered by the offline browser cell `pagehide`
 * and `test/e2e/unload.test.js`.
 *
 * | id | fault                                        | asserts |
 * |----|----------------------------------------------|---------|
 * | U1 | the page is closed while connected            | before the close a viewer is attached (409), within RELEASE_BUDGET_MS after it the viewer is gone |
 * | U2 | the page is closed while connect() is running | the same, closed after the avatar stream answered and before connect() resolved |
 *
 * Usage
 *   node scripts/live-verify-unload.mjs                       # --env prod
 *   node scripts/live-verify-unload.mjs --env nvq2:1 --browser firefox
 *   flags: --only IDS --browser chromium|firefox|webkit --headed --out DIR --keep --agent-json PATH
 *
 * Artifacts (`--out`, default live-verify-artifacts/): <runId>.json + <runId>.md. No ids or secrets
 * are written. Unless --keep or --agent-json, the run checks that the throwaway agent, avatar and
 * intellect are gone after cleanup.
 */
import {
  bootstrap, Report, mdTable, management, ensureAgent, verifyDeleted, mintPageInit, startServer,
  browserChoice, launchBrowser, warmFirefoxMedia, contextOptions, openHarness, sleep,
} from './live-verify-kickoff-shared.mjs';
import { callHook } from './live-verify-hooks-shared.mjs';
import { whepResourceUrl } from '../src/experience/wire.js';

const { args, target, runId, outDir } = bootstrap(process.argv.slice(2), 'unload');
const ONLY = typeof args.only === 'string' ? new Set(args.only.split(',').map((s) => s.trim().toUpperCase())) : null;
const choice = browserChoice(args);
const HEADED = choice.headed || choice.browser === 'chrome';
const SETUP = `${choice.browser} ${HEADED ? 'headed' : 'headless'}`;
const RELEASE_BUDGET_MS = 3000;   // time after the close until the server shows no viewer
const LATE_BUDGET_MS = 15000;    // diagnostic only: how late a missed release happens

const report = new Report({ runId, target: target.name });
report.data.scenarios = [];
const kaltura = management(target);
const admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
const agent = await ensureAgent(kaltura, admin.ks, {
  agentJson: typeof args['agent-json'] === 'string' ? args['agent-json'] : undefined,
  keep: !!args.keep,
});
report.note('agent', agent.reused ? 'reused --agent-json ids' : 'provisioned throwaway agent');
/** @type {import('node:http').Server | undefined} */ let server;
let origin = '';
/** @type {import('playwright').Browser | undefined} */ let browser;

/**
 * Record each WHEP POST (an SDP offer) the context sends: its URL, and a promise for its answer.
 * @param {import('playwright').BrowserContext} context
 */
function watchWhep(context) {
  /** @type {{url: string, answered: Promise<number>}[]} */
  const posts = [];
  context.on('request', (req) => {
    if (req.method() !== 'POST' || !(req.postData() || '').startsWith('v=0')) return;
    posts.push({ url: req.url(), answered: req.response().then((r) => r?.status() ?? 0, () => 0) });
  });
  return posts;
}

/**
 * Record each WHEP DELETE the context sends, with how it ended ("200", "failed" or "none yet").
 * @param {import('playwright').BrowserContext} context
 */
function watchDeletes(context) {
  /** @type {string[]} */
  const seen = [];
  context.on('request', (req) => {
    if (req.method() !== 'DELETE') return;
    const i = seen.push('none yet') - 1;
    req.response().then((r) => { seen[i] = String(r?.status() ?? 'failed'); }, () => { seen[i] = 'failed'; });
  });
  return seen;
}

/** Ask the server whether a viewer is attached to the avatar session behind `url`. 409 means yes. Frees the probe's own viewer. */
async function probe(/** @type {string} */ url) {
  const sentAt = Date.now();
  const res = await globalThis.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0\r\n', signal: AbortSignal.timeout(5000) });
  const location = res.headers.get('location');
  if (res.status < 300 && location) await globalThis.fetch(whepResourceUrl(location, url), { method: 'DELETE', signal: AbortSignal.timeout(5000) }).catch(() => {});
  return { status: res.status, sentAt, tookMs: Date.now() - sentAt };
}

/**
 * Poll until the probe stops answering 409. Returns the ms from `since` to the probe that found the viewer gone
 * (its send time, because the freeing probe can take seconds to answer), or null at the budget. `trail` lists each
 * probe as "status@sentMs/tookMs" so a late release can be told from a probe that was slow.
 */
async function releasedWithin(/** @type {string} */ url, /** @type {number} */ since, /** @type {number} */ budgetMs = RELEASE_BUDGET_MS) {
  /** @type {string[]} */ const trail = [];
  while (Date.now() - since <= budgetMs) {
    const { status, sentAt, tookMs } = await probe(url);
    trail.push(`${status}@${sentAt - since}/${tookMs}`);
    if (status !== 409) return { ms: sentAt - since, trail };
    await sleep(100);
  }
  return { ms: null, trail };
}

const SCENARIOS = {
  U1: {
    name: 'the page is closed while connected',
    async run({ context, sink, id }) {
      const posts = watchWhep(context);
      const deletes = watchDeletes(context);
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const connect = await callHook(page, 'testConnect');
      report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      if (!connect.ok || !posts.length) { report.check(`${id}: a WHEP POST was seen`, posts.length > 0); return; }
      const { url } = posts[0];
      report.check(`${id}: a viewer is attached before the close`, (await probe(url)).status === 409);
      const at = Date.now();
      await page.close();
      const { ms, trail } = await releasedWithin(url, at);
      report.check(`${id}: viewer gone within ${RELEASE_BUDGET_MS} ms of the close`, ms !== null, { ms, probes: trail });
      if (ms === null) report.note(`${id}: late release (up to ${LATE_BUDGET_MS} ms)`, JSON.stringify((await releasedWithin(url, at, LATE_BUDGET_MS)).ms));
      report.note(`${id}: WHEP DELETE requests seen from the closed page`, JSON.stringify(deletes));
      report.data.timings = { ...report.data.timings, U1_release_ms: ms };
    },
  },
  U2: {
    name: 'the page is closed while connect() is running',
    async run({ context, sink, id }) {
      const posts = watchWhep(context);
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const connecting = callHook(page, 'testConnect').catch(() => null);
      const deadline = Date.now() + 15000;
      while (!posts.length && Date.now() < deadline) await sleep(10);
      report.check(`${id}: a WHEP POST was seen`, posts.length > 0);
      if (!posts.length) return;
      const { url, answered } = posts[0];
      const status = await answered;
      report.check(`${id}: the avatar stream answered`, status >= 200 && status < 300, { status });
      const at = Date.now();
      await page.close();
      const { ms, trail } = await releasedWithin(url, at);
      report.check(`${id}: viewer gone within ${RELEASE_BUDGET_MS} ms of the close`, ms !== null, { ms, probes: trail });
      report.data.timings = { ...report.data.timings, U2_release_ms: ms };
      await connecting;
    },
  },
};

try {
  ({ server, origin } = await startServer(() => mintPageInit(kaltura, agent, target.genieUrl)));
  browser = await launchBrowser(choice);
  report.note('setup', SETUP);
  const gmpMs = await warmFirefoxMedia(/** @type {import('playwright').Browser} */ (browser));
  if (gmpMs) report.note('firefox-openh264-ready', `${gmpMs} ms`);
  for (const [id, sc] of Object.entries(SCENARIOS)) {
    if (ONLY && !ONLY.has(id)) continue;
    console.log(`\n== ${id}: ${sc.name}`);
    const t0 = Date.now();
    const sink = { pageErrors: /** @type {string[]} */ ([]), pages: [], network: /** @type {any[]} */ ([]) };
    const context = await /** @type {import('playwright').Browser} */ (browser).newContext(contextOptions());
    const before = report.checks.length;
    let error = null;
    try {
      await sc.run({ context, sink, id });
    } catch (err) {
      error = String(/** @type {any} */ (err)?.message || err);
      report.check(`${id}: completed`, false, { error, pageErrors: sink.pageErrors.slice(0, 5) });
    } finally {
      report.data.scenarios.push({ id, name: sc.name, ok: report.checks.slice(before).every((c) => c.ok), checks: report.checks.length - before, ms: Date.now() - t0, error });
      await context.close();
    }
  }
} finally {
  await browser?.close();
  server?.close();
  await agent.cleanup();
  if (!agent.reused && !args.keep) {
    const gone = await verifyDeleted(kaltura, admin.ks, agent);
    report.check('cleanup: agent, avatar and intellect deleted', Object.values(gone).every((s) => s === 'deleted'), gone);
  }
}

const md = [
  `# unload: ${target.name}, ${report.meta.startedAt}`,
  '',
  `${SETUP}, one fresh browser context per scenario. The page is closed by the script; the server is then asked from Node whether a viewer is still attached.`,
  '',
  mdTable(['id', 'scenario', 'result', 'checks', 'ms', 'error'], report.data.scenarios.map((s) => [s.id, s.name, s.ok ? 'ok' : 'FAIL', s.checks, s.ms, s.error ?? ''])),
  '',
  '## Checks',
  '',
  mdTable(['result', 'check', 'detail'], report.checks.map((c) => [c.ok ? 'ok' : 'FAIL', c.name, c.detail === undefined ? '' : JSON.stringify(c.detail)])),
  '',
].join('\n');
report.write(outDir, md);
const failed = report.data.scenarios.filter((s) => !s.ok).map((s) => s.id);
console.log(`\n${report.data.scenarios.length} scenarios, ${failed.length ? `FAILED: ${failed.join(', ')}` : 'all ok'}`);
process.exit(report.failed ? 1 : 0);
