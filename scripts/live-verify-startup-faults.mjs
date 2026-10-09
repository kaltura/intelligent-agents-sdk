#!/usr/bin/env node
/**
 * Live verification of connect() under client-side faults. Nothing is broken on the server:
 * the browser delays or drops the request itself (Playwright route).
 *
 * | id | fault                                  | asserts |
 * |----|----------------------------------------|---------|
 * | F1 | the first WHEP POST answers 4.5 s late | connect() resolves, `mediaReady` has real video dimensions, no `media_no_video` warning, `connectTimings` is emitted and ordered |
 * | F2 | the first WHEP POST is reset            | the POST is retried, connect() resolves with real video dimensions and no warning |
 * | F3 | every WHEP POST answers 503             | one POST only (an HTTP status is never retried), connect() rejects `whep_failed` with status 503 and `phase: 'whep'` |
 * | F4 | the first WHEP POST answers 404         | one new `stvNewSession` on the same socket (one `join`), connect() resolves with real video dimensions |
 * | F5 | the first WHEP POST answers 409         | same recovery as F4 |
 * | F6 | `timeouts.joinRoom` is 1 ms             | connect() rejects `timeout` with `phase: 'join'` and `retryable: true` |
 *
 * 4.5 s is under the 5 s limit for one POST try, so the first try is not retried. The 6 s
 * first-frame cap must start when the answer is applied, not when the request leaves.
 *
 * Usage
 *   node scripts/live-verify-startup-faults.mjs                       # --env prod
 *   node scripts/live-verify-startup-faults.mjs --env nvq2:1 --browser firefox
 *   flags: --only IDS --browser chromium|firefox|webkit --headed --out DIR --keep --agent-json PATH
 *
 * Artifacts (`--out`, default live-verify-artifacts/): <runId>.json + <runId>.md. No ids or secrets
 * are written. Unless --keep or --agent-json, the run checks that the throwaway agent, avatar and
 * intellect are gone after cleanup.
 */
import {
  bootstrap, Report, mdTable, management, ensureAgent, verifyDeleted, mintPageInit, startServer,
  browserChoice, launchBrowser, warmFirefoxMedia, contextOptions, openHarness, netProblems, waitFor, find, all, sleep,
  routeWhep, fulfillStatus, sent,
} from './live-verify-kickoff-shared.mjs';
import { callHook } from './live-verify-hooks-shared.mjs';

const { args, target, runId, outDir } = bootstrap(process.argv.slice(2), 'startup-faults');
const ONLY = typeof args.only === 'string' ? new Set(args.only.split(',').map((s) => s.trim().toUpperCase())) : null;
const choice = browserChoice(args);
const HEADED = choice.headed || choice.browser === 'chrome';
const SETUP = `${choice.browser} ${HEADED ? 'headed' : 'headless'}`;
const SLOW_MS = 4500;
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

/** @typedef {import('./live-verify-kickoff-shared.mjs').HarnessEvent} Ev */
const SCENARIOS = {
  F1: {
    name: `the first WHEP POST answers ${SLOW_MS / 1000} s late`,
    /** @param {{context: import('playwright').BrowserContext, sink: any, id: string}} c */
    async run({ context, sink, id }) {
      const route = await routeWhep(context, origin, async (n) => { if (n === 1) await sleep(SLOW_MS); });
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const connect = await callHook(page, 'testConnect');
      report.check(`${id}: the WHEP POST was seen`, route.posts() >= 1, { posts: route.posts() });
      report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      if (!connect.ok) return;
      const { events: evs } = await waitFor(page, (e) => find(e, 'connectTimings'), 5000, 'connectTimings');
      const ready = all(evs, 'mediaReady');
      const mr = ready[0]?.detail;
      report.check(`${id}: mediaReady fired once`, ready.length === 1, { count: ready.length });
      report.check(`${id}: mediaReady has real video dimensions`, mr?.mode === 'video' && mr.videoWidth > 0 && !mr.degraded, mr);
      report.check(`${id}: no media_no_video warning`, !all(evs, 'warning', (d) => d?.code === 'media_no_video').length, all(evs, 'warning').map((e) => e.detail?.code));
      const t = find(evs, 'connectTimings')?.detail;
      report.check(`${id}: connect() waited for the slow answer`, t?.connected >= SLOW_MS, { connected: t?.connected });
      report.check(`${id}: timings are ordered`, t && t.whepSent <= t.whepAnswer && t.whepAnswer <= t.mediaReady && t.mediaReady <= t.connected, t);
      await callHook(page, 'testDisconnect').catch(() => {});
    },
  },
  F2: {
    name: 'the first WHEP POST is reset',
    async run({ context, sink, id }) {
      const route = await routeWhep(context, origin, async (n, r) => { if (n === 1) { await r.abort('connectionreset').catch(() => {}); return true; } });
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const connect = await callHook(page, 'testConnect');
      report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      report.check(`${id}: the POST was retried`, route.posts() >= 2, { posts: route.posts() });
      if (!connect.ok) return;
      const { events: evs } = await waitFor(page, (e) => find(e, 'connectTimings'), 5000, 'connectTimings');
      const mr = all(evs, 'mediaReady')[0]?.detail;
      report.check(`${id}: mediaReady has real video dimensions`, mr?.mode === 'video' && mr.videoWidth > 0 && !mr.degraded, mr);
      report.check(`${id}: no warnings`, !all(evs, 'warning').length, all(evs, 'warning').map((e) => e.detail?.code));
      await callHook(page, 'testDisconnect').catch(() => {});
    },
  },
  F3: {
    name: 'every WHEP POST answers 503',
    async run({ context, sink, id }) {
      const route = await routeWhep(context, origin, async (_n, r) => { await fulfillStatus(r, 503); return true; });
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const connect = await callHook(page, 'testConnect');
      report.check(`${id}: connect() rejected whep_failed with status 503`, !connect.ok && connect.code === 'whep_failed' && connect.status === 503, connect);
      report.check(`${id}: error.phase is whep`, connect.phase === 'whep', connect);
      report.check(`${id}: an HTTP status is not retried`, route.posts() === 1, { posts: route.posts() });
      await callHook(page, 'testDisconnect').catch(() => {});
    },
  },
  F4: {
    name: 'the first WHEP POST answers 404',
    async run({ context, sink, id }) {
      const route = await routeWhep(context, origin, async (n, r) => { if (n === 1) { await fulfillStatus(r, 404); return true; } });
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const connect = await callHook(page, 'testConnect');
      report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      report.check(`${id}: a second POST followed`, route.posts() === 2, { posts: route.posts() });
      if (!connect.ok) return;
      const { events: evs } = await waitFor(page, (e) => find(e, 'connectTimings'), 5000, 'connectTimings');
      report.check(`${id}: a new avatar session on the same socket`, sent(evs, 'stvNewSession') === 2 && sent(evs, 'join') === 1, { stvNewSession: sent(evs, 'stvNewSession'), join: sent(evs, 'join') });
      const mr = all(evs, 'mediaReady')[0]?.detail;
      report.check(`${id}: mediaReady has real video dimensions`, mr?.mode === 'video' && mr.videoWidth > 0 && !mr.degraded, mr);
      await callHook(page, 'testDisconnect').catch(() => {});
    },
  },
  F5: {
    name: 'the first WHEP POST answers 409',
    async run({ context, sink, id }) {
      const route = await routeWhep(context, origin, async (n, r) => { if (n === 1) { await fulfillStatus(r, 409); return true; } });
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const connect = await callHook(page, 'testConnect');
      report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      report.check(`${id}: a second POST followed`, route.posts() === 2, { posts: route.posts() });
      if (!connect.ok) return;
      const { events: evs } = await waitFor(page, (e) => find(e, 'connectTimings'), 5000, 'connectTimings');
      report.check(`${id}: a new avatar session on the same socket`, sent(evs, 'stvNewSession') === 2 && sent(evs, 'join') === 1, { stvNewSession: sent(evs, 'stvNewSession'), join: sent(evs, 'join') });
      const mr = all(evs, 'mediaReady')[0]?.detail;
      report.check(`${id}: mediaReady has real video dimensions`, mr?.mode === 'video' && mr.videoWidth > 0 && !mr.degraded, mr);
      await callHook(page, 'testDisconnect').catch(() => {});
    },
  },
  F6: {
    name: 'timeouts.joinRoom is 1 ms',
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar', timeouts: JSON.stringify({ joinRoom: 1 }) }, sink);
      const connect = await callHook(page, 'testConnect');
      report.check(`${id}: connect() rejected timeout`, !connect.ok && connect.code === 'timeout', connect);
      report.check(`${id}: error.phase is join and retryable`, connect.phase === 'join' && connect.retryable === true, connect);
      await callHook(page, 'testDisconnect').catch(() => {});
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
      await sleep(300);
      const problems = netProblems(sink.network);
      if (problems.length) report.note(`${id}: HTTP requests that failed or returned 4xx/5xx`, problems.slice(0, 10));
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
  `# startup-faults: ${target.name}, ${report.meta.startedAt}`,
  '',
  `${SETUP}, one fresh browser context per scenario. Faults are injected in the browser only.`,
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
