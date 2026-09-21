#!/usr/bin/env node
/**
 * Live verification of the intellect-owned opening phrase, including Jinja2
 * personalization with client variables.
 *
 * Provisions a throwaway agent with `provision({ openingPhrase: <Jinja2 template> })`,
 * checks what landed (intellect `opening_phrase` set, avatar `openingPhrase`
 * unset, `allow_client_variables` on), then opens `scripts/live-verify-kickoff.html`
 * once per scenario and asserts the opening line the session actually voices.
 *
 * | id | scenario                                   | asserts |
 * |----|--------------------------------------------|---------|
 * | P0 | what provision() stored                    | intellect phrase = template, avatar phrase unset, client variables enabled |
 * | P1 | requestVars: { user_name: 'Dana' }         | the `{% if %}` branch is spoken, with the name rendered |
 * | P2 | no requestVars                             | the `{% else %}` branch is spoken, no name |
 * | P3 | SILENT_OPENING on the intellect only       | the opening turn runs and ends, surfaced only as the `[silence]` label |
 *
 * Usage
 *   node scripts/live-verify-opening-phrase.mjs                        # --env prod, AGENTIC_* vars
 *   node scripts/live-verify-opening-phrase.mjs --env nvq2 --env-file ../.env --only P1,P2
 *   flags: --only IDS --browser chromium|chrome|firefox|webkit --headed --out DIR --keep
 *          --agent-json PATH --dump-events
 *
 * Artifacts (`--out`, default live-verify-artifacts/): <runId>.json + <runId>.md,
 * plus <runId>-<id>-events.json for every failed scenario (all with --dump-events).
 * Tokens and URL query strings are redacted; no ids or secrets are written.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  bootstrap, Report, mdTable, management, ensureAgent, mintPageInit, startServer,
  browserChoice, launchBrowser, contextOptions, openHarness, whepSummary, netProblems, redact, waitFor, find, all, isOpeningSpeechId, sleep, SILENT_OPENING,
} from './live-verify-kickoff-shared.mjs';
import { callHook } from './live-verify-hooks-shared.mjs';
import { SILENT_OPENING_LABEL } from '../src/core/opening.js';

const { args, target, runId, outDir } = bootstrap(process.argv.slice(2), 'opening-phrase');
const ONLY = typeof args.only === 'string' ? new Set(args.only.split(',').map((s) => s.trim().toUpperCase())) : null;
const OPENING_TIMEOUT = 45_000;
const choice = browserChoice(args);
const HEADED = choice.headed || choice.browser === 'chrome';
const SETUP = `${choice.browser} ${HEADED ? 'headed' : 'headless'}`;

// One phrase, two outcomes. `user_name` is a client variable sent by the
// browser as `KalturaAvatarSession({ requestVars: { user_name } })`; when it is
// missing the `{% else %}` branch renders.
const NAME = 'Dana';
const IF_TEXT = 'welcome back to the studio';
const ELSE_TEXT = 'Hello there, welcome to the studio';
const TEMPLATE = `{% if user_name %}Hello {{ user_name }}, ${IF_TEXT}.{% else %}${ELSE_TEXT}.{% endif %}`;

const report = new Report({ runId, target: target.name, browser: choice.browser, headed: HEADED });
report.data.scenarios = [];
const kaltura = management(target);
const admin = await kaltura.sessions.createAdminToken();
const agent = await ensureAgent(kaltura, admin.ks, {
  agentJson: typeof args['agent-json'] === 'string' ? args['agent-json'] : undefined,
  keep: !!args.keep,
  openingPhrase: TEMPLATE,
});
if (agent.reused) await kaltura.intellectConfig.setOpeningPhrase(agent.configId, TEMPLATE, admin.ks);
report.note('agent', agent.reused ? 'reused --agent-json ids, opening phrase set on the intellect' : 'provisioned throwaway agent with a Jinja2 opening phrase');

// Client variables are off by default. Without this the session fails to start
// as soon as the browser sends `requestVars`.
await kaltura.intellects.setClientVariablesEnabled(agent.configId, true, admin.ks);

const { server, origin } = await startServer(() => mintPageInit(kaltura, agent, target.genieUrl));
const browser = await launchBrowser(choice);
report.note('setup', SETUP);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** @typedef {import('./live-verify-kickoff-shared.mjs').HarnessEvent} Ev */

const ev = (/** @type {import('playwright').Page} */ page, /** @type {string} */ fn, /** @type {any} */ arg) =>
  callHook(page, fn, arg);

/**
 * The opening line as the session voiced it: every speechChunk on the opening
 * speech id, concatenated. Chunks split mid-word, so they are joined as-is.
 */
const openingText = (/** @type {Ev[]} */ evs) => all(evs, 'speechChunk', (d) => isOpeningSpeechId(d?.speechId) && typeof d?.text === 'string')
  .map((e) => e.detail.text).join('').replace(/\s+/g, ' ').trim();
/** The server's end-of-opening marker. */
const openingEnd = (/** @type {Ev[]} */ evs, from = 0) => find(evs, 'socket:in', { from, where: (d) => d.ev === 'stvFinishedTalking' });
/** Any surfaced text carrying the silent marker. */
const leaks = (/** @type {Ev[]} */ evs) => [...all(evs, 'transcript'), ...all(evs, 'speechChunk')].filter((e) => typeof e.detail?.text === 'string' && e.detail.text.includes(SILENT_OPENING));

/** connect() and wait for the opening turn to end. */
async function connectAndOpening(/** @type {import('playwright').Page} */ page, /** @type {string} */ id) {
  const connect = await ev(page, 'testConnect');
  report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
  if (!connect.ok) throw new Error(`connect failed: ${connect.code} ${connect.message}`);
  const { events: evs } = await waitFor(page, (e) => openingEnd(e), OPENING_TIMEOUT, 'end of the opening turn (stvFinishedTalking)');
  return evs;
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
  P0: {
    name: 'what provision() stored',
    async run({ id }) {
      // Read the config back rather than trusting the writes.
      const intellect = await kaltura.intellects.get(agent.configId, admin.ks);
      report.check(`${id}: intellect opening_phrase is the template`, intellect?.opening_phrase === TEMPLATE, { stored: intellect?.opening_phrase });
      report.check(`${id}: intellect allow_client_variables is on`, intellect?.allow_client_variables === true, { stored: intellect?.allow_client_variables });
      if (agent.avatarId) {
        const avatar = await kaltura.avatars.get(agent.avatarId, admin.ks);
        report.check(`${id}: avatar openingPhrase is unset`, !avatar?.openingPhrase, { stored: avatar?.openingPhrase ?? null });
      } else {
        report.note(`${id}: avatar openingPhrase not checked`, '--agent-json carries no avatarId');
      }
    },
  },

  P1: {
    name: `requestVars { user_name: '${NAME}' } → the if-branch is spoken`,
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar', requestVars: JSON.stringify({ user_name: NAME }) }, sink);
      const evs = await connectAndOpening(page, id);
      const text = openingText(evs);
      report.check(`${id}: opening spoken with the client variable rendered`, text.includes(NAME) && text.includes(IF_TEXT), { text });
      report.check(`${id}: else-branch not spoken`, !text.includes(ELSE_TEXT), { text });
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },

  P2: {
    name: 'no requestVars → the else-branch is spoken',
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
      const evs = await connectAndOpening(page, id);
      const text = openingText(evs);
      report.check(`${id}: else-branch spoken`, text.includes(ELSE_TEXT), { text });
      report.check(`${id}: no name and no if-branch text`, !text.includes(NAME) && !text.includes(IF_TEXT), { text });
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },

  P3: {
    name: 'SILENT_OPENING on the intellect only → the opening turn ends, surfaced only as the [silence] label',
    async run({ context, sink, id }) {
      await kaltura.intellectConfig.setOpeningPhrase(agent.configId, SILENT_OPENING, admin.ks);
      try {
        const page = await openHarness(context, origin, { mode: 'avatar' }, sink);
        const evs = await connectAndOpening(page, id);
        const start = find(evs, 'connect:start');
        const end = openingEnd(evs);
        report.check(`${id}: opening turn ran and ended`, !!start && !!end, { openingMs: start && end ? end.tRel - start.tRel : null });
        // The SDK never surfaces the raw phrase: the opening turn shows up as the
        // `[silence]` label (or nothing at all), the same marker captions use.
        const text = openingText(evs);
        report.check(`${id}: opening surfaced only as the silence label`, text === '' || text === SILENT_OPENING_LABEL, { text });
        report.check(`${id}: silent marker never surfaces as text`, leaks(evs).length === 0, { leaked: leaks(evs).length });
        await ev(page, 'testDisconnect').catch(() => {});
      } finally {
        await kaltura.intellectConfig.setOpeningPhrase(agent.configId, TEMPLATE, admin.ks);
      }
    },
  },
};

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

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
      // Let the fire-and-forget WHEP DELETE from disconnect() land before we read the network log.
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
}

const md = [
  `# opening-phrase scenarios — ${target.name} — ${report.meta.startedAt}`,
  '',
  `${SETUP}, one fresh browser context per scenario. Intellect-owned Jinja2 opening phrase, avatar phrase unset.`,
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
