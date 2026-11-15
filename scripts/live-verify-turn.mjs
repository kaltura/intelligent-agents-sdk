#!/usr/bin/env node
/**
 * Live verification of per-session TURN credentials, in a real browser against the real backend.
 *
 * Provisions a throwaway agent, opens `scripts/live-verify-kickoff.html` once per scenario and
 * reads what the SDK gave each RTCPeerConnection (schemes, transports, which entries share a
 * username) plus whether any TURN secret reached the event log, the session state or the page.
 * Secrets are never recorded: the page only reports counts.
 *
 * | id | scenario                          | asserts |
 * |----|-----------------------------------|---------|
 * | T1 | default session                   | connects, media plays, opening ends. With `--expect-server-turn yes` the server entry is listed first, beside the configured one. With `no` there is one credential group. No secret leaks. No `[turn]` warning |
 * | T2 | own credentials, other host        | the caller's entry is used alone (the server's credentials never go to the caller's host), the refusal ends as `ice_failed` / `turn_credentials_rejected` (`no_candidates` on WebKit). No secret leaks |
 * | T3 | wrong credentials, server's host   | both entries share one host, the server entry carries the session: connects, media plays. No secret leaks |
 *
 * Usage
 *   node scripts/live-verify-turn.mjs                                   # --env prod, AGENTIC_* vars
 *   node scripts/live-verify-turn.mjs --env nvq2:1 --env-file ../.env --expect-server-turn yes
 *   flags: --expect-server-turn yes|no|auto (default auto: report only)
 *          --only IDS --browser chromium|chrome|firefox|webkit --headed --out DIR --keep --agent-json PATH --dump-events
 *
 * QA note: non-production targets such as nvq2 are for employees and certified partners only.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  bootstrap, Report, mdTable, management, ensureAgent, undoOnThrow, verifyDeleted, mintPageInit, startServer,
  browserChoice, launchBrowser, contextOptions, openHarness, whepSummary, netProblems, redact, waitFor, find, all, sleep,
} from './live-verify-kickoff-shared.mjs';
import { callHook } from './live-verify-hooks-shared.mjs';

const { args, target, runId, outDir } = bootstrap(process.argv.slice(2), 'turn');
const ONLY = typeof args.only === 'string' ? new Set(args.only.split(',').map((s) => s.trim().toUpperCase())) : null;
const EXPECT = ['yes', 'no'].includes(String(args['expect-server-turn'])) ? String(args['expect-server-turn']) : 'auto';
const OPENING_TIMEOUT = 45_000;
const choice = browserChoice(args);
const HEADED = choice.headed || choice.browser === 'chrome';
const SETUP = `${choice.browser} ${HEADED ? 'headed' : 'headless'}`;
const OPENING = 'Hello there, welcome to the studio.';

const report = new Report({ runId, target: target.name, browser: choice.browser, headed: HEADED });
report.data.scenarios = [];
const kaltura = management(target);
const admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
const agent = await ensureAgent(kaltura, admin.ks, {
  agentJson: typeof args['agent-json'] === 'string' ? args['agent-json'] : undefined,
  keep: !!args.keep,
  openingPhrase: OPENING,
});
if (agent.reused) await kaltura.intellectConfig.setOpeningPhrase(agent.configId, OPENING, admin.ks);
report.note('agent', agent.reused ? 'reused --agent-json ids' : 'provisioned throwaway agent with a plain opening phrase');
report.note('expect-server-turn', EXPECT);

/** Overrides merged into the page's `/init` answer for the current scenario (credentials stay out of the URL). */
let initOverride = {};
const { server, origin } = await undoOnThrow(
  () => startServer(async () => ({ ...(await mintPageInit(kaltura, agent, target.genieUrl)), ...initOverride })),
  () => agent.cleanup(),
);
const browser = await undoOnThrow(() => launchBrowser(choice), () => { server.close(); return agent.cleanup(); });
report.note('setup', SETUP);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** @typedef {import('./live-verify-kickoff-shared.mjs').HarnessEvent} Ev */
/** @typedef {{urls: number, schemes: string[], transports: string[], hosts: number[], configuredHost: boolean, auth: number}} IceEntry */

const ev = (/** @type {import('playwright').Page} */ page, /** @type {string} */ fn, /** @type {any} */ arg) => callHook(page, fn, arg);
const openingEnd = (/** @type {Ev[]} */ evs) => find(evs, 'socket:in', { where: (d) => d.ev === 'stvFinishedTalking' });

/** The ICE entries each peer was created with, in creation order. */
const peers = (/** @type {Ev[]} */ evs) => all(evs, 'pc:created').map((e) => /** @type {IceEntry[]} */ (e.detail?.ice ?? []));
/** The peer that carries TURN entries, with the most entries (the avatar downlink). */
const turnPeer = (/** @type {Ev[]} */ evs) => peers(evs).filter((p) => p.length).sort((a, b) => b.length - a.length)[0] ?? [];
const groups = (/** @type {IceEntry[]} */ entries) => new Set(entries.filter((e) => e.auth).map((e) => e.auth)).size;
const turnWarnings = (/** @type {Ev[]} */ evs) => all(evs, 'warning').filter((e) => JSON.stringify(e.detail ?? {}).includes('[turn]'));

/**
 * Connect, wait for the opening turn, and check the media path.
 * @returns {Promise<Ev[]>}
 */
async function connectAndPlay(/** @type {import('playwright').Page} */ page, /** @type {string} */ id) {
  const connect = await ev(page, 'testConnect');
  report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
  if (!connect.ok) throw new Error(`connect failed: ${connect.code} ${connect.message}`);
  const { events: evs } = await waitFor(page, (e) => openingEnd(e), OPENING_TIMEOUT, 'end of the opening turn (stvFinishedTalking)');
  report.check(`${id}: media is ready`, !!find(evs, 'mediaReady'), undefined);
  report.check(`${id}: a video frame is shown`, !!find(evs, 'video:firstFrame'), undefined);
  return evs;
}

/** No TURN secret in the event log, `session.clientConfig` or the page text. Where each one is held in `state` is reported, not asserted. */
async function noLeaks(/** @type {import('playwright').Page} */ page, /** @type {string} */ id, needSecrets = true) {
  const r = await ev(page, 'testTurnLeaks');
  report.check(`${id}: no TURN secret in events, clientConfig or page text`, r.leaked === 0 && (!needSecrets || r.secrets > 0), r);
}

/**
 * Write every page's recorded event log to `<outDir>/<runId>-<id>-events.json`, redacted.
 * @param {string} id @param {import('playwright').Page[]} pages
 */
async function dumpEvents(id, pages) {
  const logs = [];
  for (const page of pages) {
    if (page.isClosed()) continue;
    try { logs.push(await page.evaluate(() => /** @type {any} */ (window).__events.slice())); } catch { /* page gone */ }
  }
  if (!logs.length) return;
  const file = resolve(outDir, `${runId}-${id}-events.json`);
  writeFileSync(file, redact(JSON.stringify(logs, null, 1)));
  console.log(`[events] ${id}: ${file}`);
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

/** @typedef {{pageErrors: string[], pages: import('playwright').Page[], network: import('./live-verify-kickoff-shared.mjs').NetRecord[]}} Sink */
/** @type {Record<string, {name: string, run: (ctx: {context: import('playwright').BrowserContext, sink: Sink, id: string}) => Promise<void>}>} */
const SCENARIOS = {
  T1: {
    name: 'default session: server entry first beside the configured one, media plays, no leak',
    async run({ context, sink, id }) {
      initOverride = {};
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const evs = await connectAndPlay(page, id);
      const entries = turnPeer(evs);
      const server = groups(entries) >= 2;
      report.note(`${id}: TURN entries on the avatar peer`, { entries, serverEntry: server });
      if (EXPECT === 'yes') {
        report.check(`${id}: the server entry is listed first, beside the configured one`, entries.length >= 2 && groups(entries) === 2 && entries[0].auth !== entries[entries.length - 1].auth, { entries });
      } else if (EXPECT === 'no') {
        report.check(`${id}: one credential group (the server sent no TURN entry)`, entries.length >= 1 && groups(entries) === 1, { entries });
      }
      report.check(`${id}: no [turn] warning`, turnWarnings(evs).length === 0, { warnings: turnWarnings(evs).length });
      await noLeaks(page, id, server);
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },

  T2: {
    name: "caller's own credentials for a host the server did not name: used alone, as before",
    async run({ context, sink, id }) {
      initOverride = { turnCredentials: { username: 'sdk-live-verify-bad', credential: 'sdk-live-verify-bad' } };
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const connect = await ev(page, 'testConnect');
      const evs = /** @type {Ev[]} */ (await page.evaluate(() => /** @type {any} */ (window).__events.slice()));
      const entries = turnPeer(evs);
      report.note(`${id}: TURN entries on the avatar peer`, { entries });
      report.check(`${id}: one entry only, the server's credentials are not sent to the caller's host`, entries.length === 1 && groups(entries) === 1, { entries });
      // WebKit does not report relay refusals, so the cause there is the generic one.
      const cause = choice.browser === 'webkit' ? 'no_candidates' : 'turn_credentials_rejected';
      report.check(`${id}: refused credentials end as ice_failed / ${cause}`, !connect.ok && connect.code === 'ice_failed' && connect.ice?.cause === cause, { ok: connect.ok, code: connect.code, cause: connect.ice?.cause });
      await noLeaks(page, id);
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },

  T3: {
    name: "caller's wrong credentials for the server's own host: the server entry carries the session",
    async run({ context, sink, id }) {
      // Learn the server's TURN host with a plain session, then use it as the configured host with wrong credentials.
      initOverride = {};
      const probe = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const c0 = await ev(probe, 'testConnect');
      if (!c0.ok) throw new Error(`probe connect failed: ${c0.code} ${c0.message}`);
      const host = await ev(probe, 'testServerTurnHost');
      await ev(probe, 'testDisconnect').catch(() => {});
      if (!host) {
        report.note(`${id}: the server sent no TURN entry, so this scenario does not apply`);
        if (EXPECT === 'yes') report.check(`${id}: the server sent a TURN entry`, false);
        return;
      }
      initOverride = { turnServerUrl: host, turnCredentials: { username: 'sdk-live-verify-bad', credential: 'sdk-live-verify-bad' } };
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const evs = await connectAndPlay(page, id);
      const entries = turnPeer(evs);
      report.note(`${id}: TURN entries on the avatar peer`, { entries, turnWarnings: turnWarnings(evs).length });
      report.check(`${id}: both entries are listed, server first, on one host`, entries.length === 2 && groups(entries) === 2 && entries.every((e) => e.hosts.length === 1 && e.hosts[0] === entries[0].hosts[0]), { entries });
      await noLeaks(page, id);
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },
};

try {
  for (const [id, sc] of Object.entries(SCENARIOS)) {
    if (ONLY && !ONLY.has(id)) continue;
    console.log(`\n== ${id}: ${sc.name}`);
    const t0 = Date.now();
    /** @type {Sink} */
    const sink = { pageErrors: [], pages: [], network: [] };
    const context = await browser.newContext(contextOptions());
    const before = report.checks.length;
    let error = null;
    try {
      await sc.run({ context, sink, id });
    } catch (err) {
      error = String(/** @type {any} */ (err)?.message || err);
      report.check(`${id}: completed`, false, { error, pageErrors: sink.pageErrors.slice(0, 5) });
    } finally {
      await sleep(300);
      const whep = whepSummary(sink.network);
      const whepBad = whep.filter((l) => /^POST .*(FAILED|→ [45]\d\d)/.test(l));
      if (whep.length) report.check(`${id}: every WHEP POST succeeded`, whepBad.length === 0, { whep });
      const problems = netProblems(sink.network);
      if (problems.length) report.note(`${id}: HTTP requests that failed or returned 4xx/5xx`, problems.slice(0, 10));
      if (sink.pageErrors.length) report.note(`${id}: page errors`, sink.pageErrors.slice(0, 5));
      const own = report.checks.slice(before);
      const ok = own.every((c) => c.ok);
      if (!ok || args['dump-events']) await dumpEvents(id, sink.pages);
      report.data.scenarios.push({ id, name: sc.name, ok, checks: own.length, ms: Date.now() - t0, error, whep });
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
  await agent.cleanup();
  if (!agent.reused && !args.keep) {
    const gone = await verifyDeleted(kaltura, admin.ks, agent);
    report.check('cleanup: agent, avatar and intellect deleted', Object.values(gone).every((s) => s === 'deleted'), gone);
  }
}

const md = [
  `# turn-credentials scenarios — ${target.name} — ${report.meta.startedAt}`,
  '',
  `${SETUP}, one fresh browser context per scenario. Expect a server TURN entry: ${EXPECT}.`,
  '',
  mdTable(['id', 'scenario', 'result', 'checks', 'ms', 'WHEP requests', 'error'],
    report.data.scenarios.map((s) => [s.id, s.name, s.ok ? 'ok' : 'FAIL', s.checks, s.ms, (s.whep || []).join('; '), s.error ?? ''])),
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
