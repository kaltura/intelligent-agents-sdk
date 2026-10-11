#!/usr/bin/env node
/**
 * Live verification of `session.prepare()`: socket and join ahead of `connect()`.
 *
 * | id | scenario                                   | asserts |
 * |----|--------------------------------------------|---------|
 * | R1 | prepare(), then connect()                  | prepare() resolves with the state still `idle`, one `join` on the wire, no avatar session requested yet. connect() reuses the socket: still one `join`, and it connects |
 * | R2 | prepared vs plain connect(), alternating   | the prepared connect() has no join phase left (`connectTimings.joinComplete` under 100 ms at the median), and its best run beats the plain best run by at least half of the plain run's own socket + join time, and by 100 ms or more |
 * | R3 | prepare(), idle past `timeouts.prepareIdle` | warning `prepare_expired`, state stays `idle`, and a later connect() still works on a fresh socket |
 *
 * Usage
 *   node scripts/live-verify-prepare.mjs                       # --env prod
 *   node scripts/live-verify-prepare.mjs --env nvq2:1 --runs 3
 *   flags: --only IDS --runs N (pairs for R2, default 3) --browser chromium|firefox|webkit --headed
 *          --out DIR --keep --agent-json PATH
 *
 * Artifacts (`--out`, default live-verify-artifacts/): <runId>.json + <runId>.md. No ids or secrets
 * are written. Unless --keep or --agent-json, the run checks that the throwaway agent, avatar and
 * intellect are gone after cleanup.
 */
import {
  bootstrap, Report, mdTable, management, ensureAgent, verifyDeleted, mintPageInit, startServer,
  browserChoice, launchBrowser, warmFirefoxMedia, contextOptions, openHarness, netProblems, waitFor, find, all, sleep, stats, events,
} from './live-verify-kickoff-shared.mjs';
import { callHook } from './live-verify-hooks-shared.mjs';

const { args, target, runId, outDir } = bootstrap(process.argv.slice(2), 'prepare');
const ONLY = typeof args.only === 'string' ? new Set(args.only.split(',').map((s) => s.trim().toUpperCase())) : null;
const RUNS = Math.max(1, Number(typeof args.runs === 'string' ? args.runs : 3) || 3);
const choice = browserChoice(args);
const HEADED = choice.headed || choice.browser === 'chrome';
const SETUP = `${choice.browser} ${HEADED ? 'headed' : 'headless'}`;
const SAVING_SHARE = 0.5;   // prepare() must save at least this share of the plain run's own socket + join time
const SAVING_FLOOR_MS = 100;
const JOINED_MAX_MS = 100;
const IDLE_MS = 3000;

const report = new Report({ runId, target: target.name });
report.data.scenarios = [];
report.data.pairs = [];
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

/** @typedef {import('./live-verify-kickoff-shared.mjs').HarnessEvent} Ev */
const joins = (/** @type {Ev[]} */ evs) => all(evs, 'socket:out', (d) => d?.ev === 'join').length;
const sent = (/** @type {Ev[]} */ evs, /** @type {string} */ name) => all(evs, 'socket:out', (d) => d?.ev === name).length;

/** Server answers that say "try again" (the SDK marks them retryable). One pair run should not fail the script on one of them. */
const TRANSIENT = new Set(['timeout', 'capacity_unavailable']);

/** Time connect() takes in one fresh page, optionally after prepare(). `joinMs` is the socket + join time from the page's own timings. A transient server answer is retried in a fresh page, up to 3 tries. */
async function timedConnect(/** @type {import('playwright').BrowserContext} */ context, /** @type {any} */ sink, /** @type {boolean} */ prepared) {
  for (let attempt = 1; ; attempt++) {
    const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
    /** @param {string} what @param {{code?: string, message?: string}} r */
    const failed = async (what, r) => {
      await callHook(page, 'testDisconnect').catch(() => {});
      if (attempt < 3 && TRANSIENT.has(String(r.code))) { report.note(`${what} gave ${r.code} on try ${attempt}, trying again`, String(r.message).slice(0, 120)); return true; }
      throw new Error(`${what} failed: ${r.code} ${r.message}`);
    };
    if (prepared) {
      const p = await callHook(page, 'testPrepare');
      if (!p.ok) { await failed('prepare', p); continue; }
    }
    const t0 = Date.now();
    const c = await callHook(page, 'testConnect');
    const ms = Date.now() - t0;
    if (!c.ok) { await failed('connect', c); continue; }
    const { events: evs } = await waitFor(page, (e) => find(e, 'connectTimings'), 5000, 'connectTimings');
    const timings = find(evs, 'connectTimings')?.detail;
    const joinMs = timings?.joinComplete;
    await callHook(page, 'testDisconnect').catch(() => {});
    return { ms, joinMs, timings };
  }
}

const SCENARIOS = {
  R1: {
    name: 'prepare(), then connect() on the same socket',
    /** @param {{context: import('playwright').BrowserContext, sink: any, id: string}} c */
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const p = await callHook(page, 'testPrepare');
      report.check(`${id}: prepare() resolved`, p.ok, p.ok ? undefined : p);
      if (!p.ok) return;
      let evs = await events(page);
      report.check(`${id}: state is still idle`, (await callHook(page, 'testState')).state === 'idle');
      report.check(`${id}: exactly one join on the wire`, joins(evs) === 1, { joins: joins(evs) });
      report.check(`${id}: no avatar session requested yet`, sent(evs, 'stvNewSession') === 0, { stvNewSession: sent(evs, 'stvNewSession') });
      const c = await callHook(page, 'testConnect');
      report.check(`${id}: connect() resolved`, c.ok, c.ok ? undefined : c);
      if (!c.ok) return;
      evs = await events(page);
      report.check(`${id}: connect() sent no second join`, joins(evs) === 1, { joins: joins(evs) });
      report.check(`${id}: mediaReady has real video dimensions`, all(evs, 'mediaReady')[0]?.detail?.videoWidth > 0, all(evs, 'mediaReady').map((e) => e.detail));
      await callHook(page, 'testDisconnect').catch(() => {});
    },
  },

  R2: {
    name: `prepared vs plain connect(), ${RUNS} alternating pairs`,
    /** @param {{context: import('playwright').BrowserContext, sink: any, id: string}} c */
    async run({ context, sink, id }) {
      /** @type {number[]} */ const plain = []; /** @type {number[]} */ const prepared = []; /** @type {number[]} */ const joins = []; /** @type {any[]} */ const phases = [];
      for (let i = 0; i < RUNS; i++) {
        const p = await timedConnect(context, sink, false);
        plain.push(p.ms); joins.push(p.joinMs);
        const q = await timedConnect(context, sink, true);
        prepared.push(q.ms);
        phases.push({ plain: p.timings, prepared: q.timings });
      }
      const a = stats(plain), b = stats(prepared), j = stats(joins);
      report.data.pairs = { plain, prepared, plainJoin: joins, phases };
      const preparedJoin = stats(phases.map((x) => x.prepared?.joinComplete));
      report.check(`${id}: prepare() already did the join (median join phase under ${JOINED_MAX_MS} ms)`, /** @type {number} */ (preparedJoin.median) < JOINED_MAX_MS, { plainJoinMedian: j.median, preparedJoinMedian: preparedJoin.median });
      // The best run of each kind: server-side variance adds up to a second to single runs of either kind.
      const saving = /** @type {number} */ (a.min) - /** @type {number} */ (b.min);
      const need = Math.max(SAVING_FLOOR_MS, SAVING_SHARE * /** @type {number} */ (j.median));
      report.check(`${id}: prepared connect() is faster by at least ${Math.round(need)} ms (best run of each)`, saving >= need, { plainBest: a.min, preparedBest: b.min, plainMedian: a.median, preparedMedian: b.median, plainJoinMedian: j.median, saving, plain, prepared, plainJoin: joins });
    },
  },

  R3: {
    name: `idle past prepareIdle (${IDLE_MS} ms) → prepare_expired, then connect() works`,
    /** @param {{context: import('playwright').BrowserContext, sink: any, id: string}} c */
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar', timeouts: JSON.stringify({ prepareIdle: IDLE_MS }) }, sink);
      const p = await callHook(page, 'testPrepare');
      report.check(`${id}: prepare() resolved`, p.ok, p.ok ? undefined : p);
      if (!p.ok) return;
      const { events: evs } = await waitFor(page, (e) => find(e, 'warning', { where: (d) => d?.code === 'prepare_expired' }), IDLE_MS + 5000, 'warning prepare_expired');
      report.check(`${id}: prepare_expired warning emitted once`, all(evs, 'warning', (d) => d?.code === 'prepare_expired').length === 1);
      report.check(`${id}: state stays idle`, (await callHook(page, 'testState')).state === 'idle');
      const c = await callHook(page, 'testConnect');
      report.check(`${id}: connect() after expiry resolved`, c.ok, c.ok ? undefined : c);
      if (c.ok) {
        const after = await events(page);
        report.check(`${id}: a fresh join was sent`, joins(after) === 2, { joins: joins(after) });
      }
      await callHook(page, 'testDisconnect').catch(() => {});
    },
  },
};

try {
  ({ server, origin } = await startServer(() => mintPageInit(kaltura, agent, target.genieUrl)));
  browser = await launchBrowser(choice);
  report.note('setup', SETUP);
  const gmpMs = await warmFirefoxMedia(browser);
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
      await sleep(300);   // late request events land before the problems are read
      const problems = netProblems(sink.network);
      if (problems.length) report.note(`${id}: HTTP requests that failed or returned 4xx/5xx`, problems.slice(0, 10));
      report.data.scenarios.push({ id, name: sc.name, ok: report.checks.slice(before).every((c) => c.ok), checks: report.checks.length - before, ms: Date.now() - t0, error });
      await context.close().catch(() => {});
    }
  }
} finally {
  await browser?.close().catch(() => {});
  server?.close();
  await agent.cleanup();
  if (!agent.reused && !args.keep) {
    const gone = await verifyDeleted(kaltura, admin.ks, agent);
    report.check('cleanup: agent, avatar and intellect deleted', Object.values(gone).every((s) => s === 'deleted'), gone);
  }
}

const md = [
  `# prepare: ${target.name}, ${report.meta.startedAt}`,
  '',
  `${SETUP}, one fresh browser context per scenario.`,
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
