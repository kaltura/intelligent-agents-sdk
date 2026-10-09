#!/usr/bin/env node
/**
 * Live verification of recovery after the connection is lost. Nothing is broken on the server:
 * the browser closes a peer, answers a request itself or goes offline.
 *
 * | id | fault                                        | asserts |
 * |----|----------------------------------------------|---------|
 * | C1 | the avatar video peer is closed from the page | `mediaRecovering` then `mediaRecovered` (stv, re-subscribe) within RECOVER_BUDGET_MS, video decodes again, no socket reconnect |
 * | C2 | the video and mic peers are closed together   | the closed mic peer cannot restart ICE, so the session rebuilds: `reconnected` within REBUILD_BUDGET_MS, two open peers, video decodes |
 * | C3 | the first re-subscribe answers 404             | recovery still lands within RECOVER_BUDGET_MS with a new avatar session on the same socket (one `join`, no socket reconnect) |
 * | C4 | the browser is offline for OFFLINE_MS         | the session is `connected` again within BACK_BUDGET_MS of the network returning, and video decodes |
 *
 * Usage
 *   node scripts/live-verify-reconnect.mjs                       # --env prod
 *   node scripts/live-verify-reconnect.mjs --env nvq2:1 --browser firefox
 *   flags: --only IDS --browser chromium|firefox|webkit --headed --out DIR --keep --agent-json PATH
 *
 * Artifacts (`--out`, default live-verify-artifacts/): <runId>.json + <runId>.md. No ids or secrets
 * are written. Unless --keep or --agent-json, the run checks that the throwaway agent, avatar and
 * intellect are gone after cleanup.
 */
import {
  bootstrap, Report, mdTable, management, ensureAgent, verifyDeleted, mintPageInit, startServer,
  browserChoice, launchBrowser, warmFirefoxMedia, contextOptions, openHarness, netProblems, waitFor, find, all, sleep, events,
  routeWhep, fulfillStatus, sent,
} from './live-verify-kickoff-shared.mjs';
import { callHook } from './live-verify-hooks-shared.mjs';

const { args, target, runId, outDir } = bootstrap(process.argv.slice(2), 'reconnect');
const ONLY = typeof args.only === 'string' ? new Set(args.only.split(',').map((s) => s.trim().toUpperCase())) : null;
const choice = browserChoice(args);
const HEADED = choice.headed || choice.browser === 'chrome';
const SETUP = `${choice.browser} ${HEADED ? 'headed' : 'headless'}`;
const RECOVER_BUDGET_MS = 2500;   // watchdog tick (up to 1 s) + one re-subscribe
const REBUILD_BUDGET_MS = 8000;   // a closed mic peer cannot restart ICE, so the session rebuilds
const OFFLINE_MS = 6000;
const BACK_BUDGET_MS = 3000;

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

/** Close every live peer that carries avatar video (`video`) or only the mic uplink (`mic`), from inside the page. Returns Date.now() at the close. */
const closePeers = (/** @type {import('playwright').Page} */ page, /** @type {'video'|'mic'|'both'} */ which) => page.evaluate((w) => {
  const live = /** @type {any[]} */ (globalThis.__pcs).filter((pc) => pc.signalingState !== 'closed');
  const hasVideo = (pc) => pc.getReceivers().some((r) => r.track?.kind === 'video');
  const at = Date.now();
  for (const pc of live) if (w === 'both' || (w === 'video') === hasVideo(pc)) pc.close();
  return at;
}, which);

/** Decoded video frames on the live avatar peer, sampled twice. True when the count grows. */
async function videoDecodes(/** @type {import('playwright').Page} */ page) {
  const sample = () => page.evaluate(async () => {
    const pc = /** @type {any[]} */ (globalThis.__pcs).filter((p) => p.signalingState !== 'closed').find((p) => p.getReceivers().some((r) => r.track?.kind === 'video'));
    if (!pc) return -1;
    let n = 0;
    (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') n = s.framesDecoded || 0; });
    return n;
  });
  const a = await sample();
  await sleep(1000);
  const b = await sample();
  return { ok: a >= 0 && b > a, from: a, to: b };
}

/** Wait for `mediaRecovered` on `channel` after `since` (a Date.now() stamp). */
const recovered = (/** @type {import('playwright').Page} */ page, /** @type {string} */ channel, /** @type {number} */ since) =>
  waitFor(page, (e) => find(e, 'mediaRecovered', { where: (d, ev) => d?.channel === channel && ev.t >= since }), 15000, `mediaRecovered ${channel}`);

const SCENARIOS = {
  C1: {
    name: 'the avatar video peer is closed from the page',
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const connect = await callHook(page, 'testConnect');
      report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      if (!connect.ok) return;
      const at = await closePeers(page, 'video');
      const { value, events: evs } = await recovered(page, 'stv', at);
      const ms = value.t - at;
      report.check(`${id}: mediaRecovered stv by re-subscribe`, value.detail?.method === 're-subscribe', value.detail);
      report.check(`${id}: recovered within ${RECOVER_BUDGET_MS} ms`, ms <= RECOVER_BUDGET_MS, { ms });
      report.check(`${id}: mediaRecovering came first`, !!find(evs, 'mediaRecovering', { where: (d, ev) => d?.channel === 'stv' && ev.t >= at }));
      report.check(`${id}: no socket reconnect`, !all(evs, 'reconnecting').length && all(evs, 'socket:created').length === 1, { sockets: all(evs, 'socket:created').length });
      const flow = await videoDecodes(page);
      report.check(`${id}: video decodes again`, flow.ok, flow);
      report.data.timings = { ...report.data.timings, C1_recover_ms: ms };
      await callHook(page, 'testDisconnect').catch(() => {});
    },
  },
  C2: {
    name: 'the video and mic peers are closed together',
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const connect = await callHook(page, 'testConnect');
      report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      if (!connect.ok) return;
      const at = await closePeers(page, 'both');
      const { value, events: evs } = await waitFor(page, (e) => find(e, 'reconnected', { where: (_d, ev) => ev.t >= at }), 20000, 'reconnected');
      const ms = value.t - at;
      report.check(`${id}: the closed mic peer escalated to a session rebuild`, !!find(evs, 'reconnecting', { where: (d, ev) => d?.cold === true && ev.t >= at }), all(evs, 'reconnecting').map((e) => e.detail));
      report.check(`${id}: rebuilt within ${REBUILD_BUDGET_MS} ms`, ms <= REBUILD_BUDGET_MS, { ms });
      const state = await page.evaluate(() => /** @type {any} */ (globalThis).testState());
      report.check(`${id}: connected again`, state.state === 'connected', state);
      const open = await page.evaluate(() => /** @type {any[]} */ (globalThis.__pcs).map((pc, n) => ({ n: n + 1, signaling: pc.signalingState, ice: pc.iceConnectionState, video: pc.getReceivers().some((r) => r.track?.kind === 'video') })).filter((p) => p.signaling !== 'closed'));
      report.check(`${id}: exactly two peers left open (mic and avatar)`, open.length === 2, { open });
      const flow = await videoDecodes(page);
      report.check(`${id}: video decodes again`, flow.ok, flow);
      report.data.timings = { ...report.data.timings, C2_rebuild_ms: ms };
      await callHook(page, 'testDisconnect').catch(() => {});
    },
  },
  C3: {
    name: 'the first re-subscribe answers 404',
    async run({ context, sink, id }) {
      let armed = false;
      const served = { done: false };
      const route = await routeWhep(context, origin, async (_n, r) => { if (armed && !served.done) { served.done = true; await fulfillStatus(r, 404); return true; } });
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const connect = await callHook(page, 'testConnect');
      report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      if (!connect.ok) return;
      armed = true;
      const at = await closePeers(page, 'video');
      const { value, events: evs } = await recovered(page, 'stv', at);
      const ms = value.t - at;
      report.check(`${id}: the 404 was served`, served.done, { posts: route.posts() });
      report.check(`${id}: recovered within ${RECOVER_BUDGET_MS} ms`, ms <= RECOVER_BUDGET_MS, { ms });
      report.check(`${id}: a new avatar session on the same socket`, sent(evs, 'stvNewSession') === 2 && sent(evs, 'join') === 1, { stvNewSession: sent(evs, 'stvNewSession'), join: sent(evs, 'join') });
      report.check(`${id}: no socket reconnect`, !all(evs, 'reconnecting').length, all(evs, 'reconnecting').length);
      const flow = await videoDecodes(page);
      report.check(`${id}: video decodes again`, flow.ok, flow);
      report.data.timings = { ...report.data.timings, C3_recover_ms: ms };
      await callHook(page, 'testDisconnect').catch(() => {});
    },
  },
  C4: {
    name: `the browser is offline for ${OFFLINE_MS / 1000} s`,
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const connect = await callHook(page, 'testConnect');
      report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      if (!connect.ok) return;
      await context.setOffline(true);
      await sleep(OFFLINE_MS);
      const sawFault = (await events(page)).some((e) => ['reconnecting', 'mediaRecovering'].includes(e.type) || (e.type === 'connectivityChanged' && e.detail?.state !== 'connected'));
      report.check(`${id}: the outage was noticed while offline`, sawFault);
      const backAt = Date.now();
      await context.setOffline(false);
      let ms = null;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const st = await page.evaluate(() => /** @type {any} */ (globalThis).testState());
        const evs = await events(page);
        const settled = st.state === 'connected' && (!find(evs, 'reconnecting') || find(evs, 'reconnected'));
        if (settled) { ms = Date.now() - backAt; break; }
        await sleep(100);
      }
      const evs = await events(page);
      report.check(`${id}: connected again`, ms !== null, { events: evs.slice(-8).map((e) => e.type) });
      if (ms === null) return;
      report.check(`${id}: back within ${BACK_BUDGET_MS} ms of the network returning`, ms <= BACK_BUDGET_MS, { ms });
      const flow = await videoDecodes(page);
      report.check(`${id}: video decodes`, flow.ok, flow);
      report.data.timings = { ...report.data.timings, C4_back_ms: ms };
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
  `# reconnect: ${target.name}, ${report.meta.startedAt}`,
  '',
  `${SETUP}, one fresh browser context per scenario. Faults are injected in the browser only: a peer closed from the page, a request answered 404, the network switched off.`,
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
