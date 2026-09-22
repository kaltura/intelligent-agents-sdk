#!/usr/bin/env node
/**
 * Live connect-timing verification for the silent-opening + kickoff pattern.
 *
 * Provisions a throwaway agent whose opening phrase is SILENT_OPENING, opens
 * `scripts/live-verify-kickoff.html` in the chosen browser, connects, and
 * measures the real startup path `--runs` times: SDK events, socket frames,
 * WebRTC peer state, `getStats()`, and what reaches the user's eyes and ears
 * (first decoded video frame, element `playing`, and audible sound on the remote
 * audio track measured with an AnalyserNode).
 *
 * Per run it asserts:
 *   1. connect() resolves
 *   2. STV media (ICE) is connected before connect() resolves
 *   3. with a silent opening: connect-resolved → opening avatarStopTalking < 1500 ms,
 *      and no sound is heard during that window
 *   4. with a kickoff: it leaves the client ≤ 50 ms after the opening's
 *      stvFinishedTalking, it is the only text sent, and the first speechChunk is
 *      on a non-opening speech id (real reply, not the opening)
 *   5. a video frame was decoded and rendered (video mode). When the STV answer carries no
 *      usable video section (port 0, no shared codec) the check reports that instead, with
 *      the codecs the browser offered, so a codec gap is not mistaken for an SDK bug
 *   6. sound was heard after avatarStartTalking (when the analyser is running)
 *   7. no transcript/speechChunk payload ever contains the silent-opening text
 * and records min/median/max of every timing relative to connect().
 *
 * Baseline before this pattern (same QA backend, fake mic, hand-timed with a
 * speak() nudge after connect): connect() 2.2–3.6 s, connect-resolved → first
 * words 1.75–1.85 s. The markdown artifact prints this baseline next to the
 * measured numbers so a regression is visible without opening the JSON.
 *
 * KPIs. After the runs, the median of each startup KPI over the successful runs
 * is checked against a budget. A miss fails the script like any other check, so
 * a startup regression fails the CI job instead of hiding in a table:
 *
 *   connect() resolved                         ≤ 2500 ms   (2200–3600 before the concurrent connect path)
 *   first video frame presented (rVFC)         ≤ 2500 ms
 *   first audio (remote audio track unmuted)   ≤ 2500 ms
 *   first agent words after connect() resolved ≤ 1850 ms   (1750–1850 with a manual speak() nudge)
 *   sound heard (AnalyserNode)                 ≤ 5000 ms
 *
 * Budgets are ms from connect() start (first words: from connect() resolved).
 * Defaults were calibrated on prod with headless Chromium, Firefox and WebKit
 * (medians: connect 1.5–1.8 s, first frame 1.3–1.6 s, first audio 1.2–1.5 s,
 * first words after connect 1.0–1.6 s, sound heard 3.0–3.9 s) and leave headroom
 * for a slower CI runner. A KPI with no sample in the run set is reported as n/a
 * and skipped, not failed. The two speech KPIs are reported but not enforced
 * with `--opening` or `--no-kickoff`, because the first words are then the opening
 * line, not the agent's reply. The report carries the table under `## KPI`
 * (markdown) and `data.kpi` (JSON).
 *
 * Resource hints (`--hints`). An app can add `<link rel=preconnect|dns-prefetch|
 * preload|modulepreload>` tags to its `<head>` so the browser opens the socket
 * and WHEP connections, resolves the TURN host and fetches socket.io/the SDK
 * before any script runs. `--hints ab` measures whether that helps here: runs
 * alternate between the plain harness page (odd runs, "off") and the same page
 * with the hints injected (even runs, "on"; see `resourceHints()` in the shared
 * module for the exact tags, built from the init response at runtime). Each run
 * uses a fresh browser context, so connection pools and TLS sessions are cold
 * for both arms and only the OS DNS cache is shared. Every run also records
 * Resource Timing for the cross-origin requests (socket.io script, WHEP POST)
 * and the SDK module graph, and the report prints per-arm min / median / max
 * plus the on − off median delta.
 *
 * Compare openings (`--compare jinja`). Runs rotate round-robin over three arms, each with
 * its own throwaway agent and local server:
 *
 * | arm | opening phrase | browser sends | first words are |
 * |---|---|---|---|
 * | `silent+kickoff` | SILENT_OPENING | kickoff | the reply to the kickoff |
 * | `jinja` | `{% if sys__is_new_thread %}` greeting with `{{ user_name }}` | requestVars `{ user_name }`, no kickoff | the scripted opening |
 * | `jinja-pill` | `{% if pending_question %}<blank>{% else %}` greeting | requestVars `{ pending_question: '1' }`, kickoff `{ text, echo: true }` | the reply to the preset question |
 *
 * Extra per-arm checks: `jinja` speaks the name and sends no text; `jinja-pill` has a silent
 * opening, answers the question, and echoes it once as a user transcript. Each arm is judged
 * against its own KPI budgets (first words after connect: 1850 / 800 / 1850 ms; sound after
 * connect: 3000 / 1500 / 3000 ms; the rest as above; `--budget-K` sets one value for every arm).
 * The report adds `## Compare` (markdown) and `data.compare = { baseline, arms: { <name>:
 * { runs, failed, kpi, summary } }, deltaMedianMs: { <arm>: { <metric>: arm − baseline } } }`
 * (JSON); `data.kpi` then lists every arm's KPIs with an `arm` field. Default `--runs` is 9.
 *
 * `--prompt-kb N` pads every agent's base directive with N KB of neutral text, to measure
 * how prompt size moves each opening. After the runs every throwaway agent is read back and
 * the script checks its agent, avatar and intellect are gone.
 *
 * Usage
 *   node scripts/live-verify-connect-timing.mjs                 # --env prod, AGENTIC_* vars
 *   node scripts/live-verify-connect-timing.mjs --env eu --env-file ../.env --runs 5
 *   node scripts/live-verify-connect-timing.mjs --browser chrome
 *   node scripts/live-verify-connect-timing.mjs --browser firefox --opening 'Hello!' --no-kickoff
 *   node scripts/live-verify-connect-timing.mjs --browser chrome --runs 10 --hints ab
 *   node scripts/live-verify-connect-timing.mjs --compare jinja --runs 9 --prompt-kb 25
 *
 * Flags
 *   --runs N                 default 5, 9 with --compare (with an A/B or compare: total, split per arm)
 *   --browser B              chromium (default) | chrome | firefox | webkit
 *   --headed                 show the browser (chrome is always headed, audio audible)
 *   --hints H                off (default) | on (every run gets the hints) | ab (alternate off/on)
 *   --compare jinja          compare the three opening arms above (not with --hints ab, --opening,
 *                            --no-kickoff or --agent-json)
 *   --prompt-kb N            pad each agent's base directive by N KB (not with --agent-json)
 *   --opening TEXT           spoken opening phrase instead of SILENT_OPENING (reset afterwards)
 *   --no-kickoff             connect without a kickoff (measures the opening only)
 *   --kickoff TEXT           kickoff text
 *   --mic M                  immediate (default) | deferred | denied
 *   --mode M                 avatar (default) | agent-avatar (KalturaAgentSession)
 *   --budget-K MS            override one KPI budget; K = connect | first-frame | first-audio | first-words | sound |
 *                            sound-after-connect (enforced with --compare only)
 *   --no-budgets             report the KPIs without failing on them
 *   --out DIR --keep --agent-json PATH
 *
 * Artifacts (`--out`, default live-verify-artifacts/): <runId>.json + <runId>.md.
 * No ids, tokens or secrets are written to them.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  bootstrap, Report, mdTable, stats, management, ensureAgent, verifyDeleted, mintPageInit, startServer, resourceHints, SOCKET_IO_CDN, repoRoot,
  browserChoice, launchBrowser, contextOptions, openHarness, whepSummary, netProblems, waitFor, find, all, isOpeningSpeechId, textsSent, SILENT_OPENING,
} from './live-verify-kickoff-shared.mjs';
import { callHook } from './live-verify-hooks-shared.mjs';

const { args, target, runId, outDir } = bootstrap(process.argv.slice(2), 'connect-timing');
const COMPARE = typeof args.compare === 'string' ? args.compare : null;
const KICKOFF = args['no-kickoff'] === true ? null : (typeof args.kickoff === 'string' ? args.kickoff : 'Greet the user in one short sentence and ask how you can help.');
const OPENING = typeof args.opening === 'string' && args.opening.trim() ? args.opening : null;
const MIC = typeof args.mic === 'string' ? args.mic : undefined;   // undefined → harness default (WebKit: synthetic)
const MODE = typeof args.mode === 'string' ? args.mode : 'avatar';
const HINTS = typeof args.hints === 'string' ? args.hints : 'off';
const AGENT_JSON = typeof args['agent-json'] === 'string' ? args['agent-json'] : undefined;
const PROMPT_KB = args['prompt-kb'] === undefined ? 0 : Number(args['prompt-kb']);
const fail = (/** @type {string} */ msg) => { console.error(msg); process.exit(1); };
if (MIC !== undefined && !['immediate', 'deferred', 'denied'].includes(MIC)) fail(`--mic ${MIC}: expected immediate, deferred or denied`);
if (!['avatar', 'agent-avatar'].includes(MODE)) fail(`--mode ${MODE}: expected avatar or agent-avatar`);
if (!['off', 'on', 'ab'].includes(HINTS)) fail(`--hints ${HINTS}: expected off, on or ab`);
if (COMPARE !== null && COMPARE !== 'jinja') fail(`--compare ${COMPARE}: expected jinja`);
if (COMPARE && HINTS === 'ab') fail('--compare and --hints ab each split the runs into arms; run them separately');
if (COMPARE && (OPENING || !KICKOFF || AGENT_JSON)) fail('--compare provisions one agent per arm; drop --opening, --no-kickoff and --agent-json');
if (!Number.isInteger(PROMPT_KB) || PROMPT_KB < 0) fail(`--prompt-kb ${args['prompt-kb']}: expected a whole number of KB`);
if (PROMPT_KB && AGENT_JSON) fail('--prompt-kb rewrites the intellect prompt; it needs a throwaway agent, not --agent-json');
const choice = browserChoice(args);
const BASELINE = { connectMs: '2200–3600', firstWordsMs: '1750–1850' };

/**
 * One way to open the conversation. Without `--compare` there is one variant, built from the flags.
 * - `spoken`: the opening phrase makes speech (a scripted line), so the first words are the opening itself
 * - `speechKpi`: enforce the speech KPIs for this variant
 * - `budgets`: per-variant KPI budgets (ms), keyed by KPI key; `--budget-K` overrides them for every variant
 * @typedef {{name:string, openingPhrase:string, spoken:boolean, kickoff:string|null, echo:boolean, requestVars?:Record<string,string>, clientVars:boolean, speechKpi:boolean, expectInOpening?:string, expectInReply?:RegExp, budgets:Record<string, number>}} Variant
 */
const NAME = 'Dana';
const GREETING = 'Hi, I am the test assistant. How can I help?';
const JINJA_TEMPLATE = `{% if sys__is_new_thread %}{% if user_name %}Hi {{ user_name }}, I am the test assistant. How can I help?{% else %}${GREETING}{% endif %}{% else %}Welcome back.{% endif %}`;
const PILL_QUESTION = 'What is two plus two? Answer with just the number.';
const PILL_TEMPLATE = `{% if pending_question %}${SILENT_OPENING}{% elif sys__is_new_thread %}${GREETING}{% else %}Welcome back.{% endif %}`;
const BASE_ARM = 'silent+kickoff';
/** @type {Variant[]} */
const VARIANTS = COMPARE ? [
  { name: BASE_ARM, openingPhrase: SILENT_OPENING, spoken: false, kickoff: KICKOFF, echo: false, clientVars: false, speechKpi: true, budgets: { firstWordsAfterConnectMs: 1850, soundAfterConnectMs: 3000 } },
  { name: 'jinja', openingPhrase: JINJA_TEMPLATE, spoken: true, kickoff: null, echo: false, requestVars: { user_name: NAME }, clientVars: true, speechKpi: true, expectInOpening: NAME, budgets: { firstWordsAfterConnectMs: 800, soundAfterConnectMs: 1500 } },
  { name: 'jinja-pill', openingPhrase: PILL_TEMPLATE, spoken: false, kickoff: PILL_QUESTION, echo: true, requestVars: { pending_question: '1' }, clientVars: true, speechKpi: true, expectInReply: /\b4\b|four/i, budgets: { firstWordsAfterConnectMs: 1850, soundAfterConnectMs: 3000 } },
] : [
  // Otherwise the first words are the opening line, not the reply, so the speech KPIs are reported only.
  { name: 'default', openingPhrase: OPENING ?? SILENT_OPENING, spoken: !!OPENING, kickoff: KICKOFF, echo: false, clientVars: false, speechKpi: !OPENING && !!KICKOFF, budgets: {} },
];
const RUNS = Number(args.runs || (COMPARE ? 3 * VARIANTS.length : 5));

/**
 * Startup KPIs: median over the successful runs must be ≤ budget (ms). See the header
 * for how the defaults were calibrated. `enforce: false` KPIs are reported only.
 * @typedef {{key:string, flag:string, label:string, budgetMs:number, enforce:boolean}} Kpi
 */
const ENFORCE = args['no-budgets'] !== true;
const KPI_DEFS = [
  { key: 'connectMs', flag: 'connect', label: 'connect() resolved', budgetMs: 2500, speech: false },
  { key: 'videoFirstFrameMs', flag: 'first-frame', label: 'first video frame presented (rVFC)', budgetMs: 2500, speech: false },
  { key: 'trackAudioMs', flag: 'first-audio', label: 'first audio (remote audio track unmuted)', budgetMs: 2500, speech: false },
  { key: 'firstWordsAfterConnectMs', flag: 'first-words', label: 'first agent words after connect() resolved', budgetMs: 1850, speech: true },
  { key: 'firstSoundMs', flag: 'sound', label: 'sound heard (AnalyserNode)', budgetMs: 5000, speech: true },
  // Enforced only with --compare, where each arm has its own budget.
  { key: 'soundAfterConnectMs', flag: 'sound-after-connect', label: 'sound heard after connect() resolved', budgetMs: 3000, speech: true, compareOnly: true },
];
/** @type {Record<string, number>} */
const BUDGET_FLAGS = {};
for (const k of KPI_DEFS) {
  const raw = args[`budget-${k.flag}`];
  if (raw === undefined) continue;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0) fail(`--budget-${k.flag} ${raw}: expected a positive integer (ms)`);
  BUDGET_FLAGS[k.key] = ms;
}
/** The KPI list for one variant: budget = --budget-K, else the variant's own, else the default. */
const kpisFor = (/** @type {Variant} */ v) => /** @type {Kpi[]} */ (KPI_DEFS.map((k) => ({
  key: k.key, flag: k.flag, label: k.label,
  budgetMs: BUDGET_FLAGS[k.key] ?? v.budgets[k.key] ?? k.budgetMs,
  enforce: ENFORCE && (!k.speech || v.speechKpi) && (!k.compareOnly || !!COMPARE),
})));
const MIC_LABEL = MIC ?? (choice.browser === 'webkit' ? 'synthetic' : 'immediate');
const OPENING_LABEL = COMPARE ? `arms ${VARIANTS.map((v) => v.name).join(' / ')} (round-robin)` : `opening ${OPENING ? `spoken (${JSON.stringify(OPENING)})` : 'silent'}, ${KICKOFF ? 'kickoff' : 'no kickoff'}`;
const SETUP = `${choice.browser}${choice.headed || choice.browser === 'chrome' ? ' headed' : ' headless'}, mic ${MIC_LABEL}, ${OPENING_LABEL}, mode ${MODE}, resource hints ${HINTS === 'ab' ? 'A/B (odd runs off, even runs on)' : HINTS}${PROMPT_KB ? `, prompt padded by ${PROMPT_KB} KB` : ''}`;
/** Which hints arm a run belongs to: `off` = plain page, `on` = page with resource hints in <head>. */
const hintsOf = (/** @type {number} */ i) => (HINTS === 'ab' ? (i % 2 === 0 ? 'on' : 'off') : HINTS);

const report = new Report({ runId, target: target.name, browser: choice.browser, headed: choice.headed || choice.browser === 'chrome', setup: SETUP });
report.data.runs = [];
const kaltura = management(target);
const admin = await kaltura.sessions.createAdminToken();
report.note('setup', SETUP);

/**
 * Grow the intellect's base directive by `PROMPT_KB` KB of neutral reference text (repo docs with
 * every Jinja and markup character removed), to measure how prompt size moves each opening.
 * @param {string} configId
 */
const padPrompt = async (configId) => {
  const cur = await kaltura.intellects.get(configId, admin.ks);
  const base = typeof cur?.base_directive === 'string' ? cur.base_directive : '';
  const prompts = Array.isArray(cur?.prompts) ? cur.prompts : [];
  const source = ['README.md', 'GETTING-STARTED.md', 'docs/ARCHITECTURE.md'].map((f) => readFileSync(resolve(repoRoot, f), 'utf8')).join('\n\n')
    .replace(/[{}%#`<>|]/g, ' ').replace(/[ \t]+/g, ' ');
  let pad = '';
  while (pad.length < PROMPT_KB * 1024) pad += `${source}\n\n`;
  pad = pad.slice(0, PROMPT_KB * 1024);
  await kaltura.intellects.setPrompts(configId, prompts, admin.ks, { baseDirective: `${base}\n\nReference material about the product. Use it only when relevant to the question:\n\n${pad}`, lint: false });
  const after = await kaltura.intellects.get(configId, admin.ks);
  return { baseDirectiveBytes: base.length, paddedBytes: (after?.base_directive || '').length };
};

/**
 * One provisioned arm: its variant, agent and local harness server (the server's /init mints for that agent).
 * @type {{v: Variant, agent: Awaited<ReturnType<typeof ensureAgent>>, origin: string, server: import('node:http').Server|null}[]}
 */
const arms = [];
/** @type {import('playwright').Browser|null} */
let browser = null;
/** @type {import('./live-verify-kickoff-shared.mjs').ResourceHint[]} */
let HINT_TAGS = [];
/**
 * Resource Timing view of one run, from `window.testResources()`.
 * - `scriptLoadMs`: socket.io script fetch (cross-origin CDN)
 * - `whepPostMs`: the STV WHEP POST (the one cross-origin `fetch()` on a `/whep/` path;
 *   its host comes from the server's session reply, so it is matched by path, not origin)
 * - `sdkLoadedAtMs`: last `/src/` module response end, ms since navigation start
 *   (a span measure would only widen when `modulepreload` starts the fetches earlier)
 * Connection-level fields (dns/tcp/tls, reused) are only present when the server
 * sends Timing-Allow-Origin; otherwise Resource Timing exposes duration alone.
 * @param {{entries: any[], hints: any[]}} res
 */
const resourceMetrics = (res) => {
  const cdn = res.entries.find((e) => e.url === SOCKET_IO_CDN);
  const whep = res.entries.find((e) => e.initiator === 'fetch' && !e.url.startsWith('/') && /\/whep(\/|\?|$)/.test(e.url));
  const sdk = res.entries.filter((e) => e.url.startsWith('/src/'));
  const sdkEnd = sdk.length ? Math.max(...sdk.map((e) => e.startMs + e.durationMs)) : null;
  return {
    scriptLoadMs: cdn?.durationMs ?? null,
    whepPostMs: whep?.durationMs ?? null,
    whepReusedConnection: whep?.reusedConnection ?? null,
    whepTao: whep?.tao ?? null,
    sdkLoadedAtMs: sdkEnd,
    sdkModules: sdk.length,
    crossOrigin: res.entries.filter((e) => !e.url.startsWith('/')).map((e) => ({ url: e.url.replace(/\?.*$/, ''), initiator: e.initiator, startRel: e.startRel, durationMs: e.durationMs, tao: e.tao, reused: e.reusedConnection })),
  };
};

/** @typedef {import('./live-verify-kickoff-shared.mjs').HarnessEvent} Ev */

/** First event of `type` at/after `from`, as ms after `base`. */
const at = (/** @type {Ev[]} */ evs, /** @type {string} */ type, /** @type {number} */ base, /** @type {{from?:number, where?:(d:any)=>boolean}} */ opts = {}) => {
  const e = find(evs, type, opts);
  return e ? e.tRel - base : null;
};

try {
  for (const v of VARIANTS) {
    const agent = await ensureAgent(kaltura, admin.ks, { agentJson: AGENT_JSON, keep: !!args.keep, openingPhrase: v.openingPhrase });
    /** @type {typeof arms[number]} */
    const a = { v, agent, origin: '', server: null };
    arms.push(a);
    const who = COMPARE ? `agent [${v.name}]` : 'agent';
    report.note(who, agent.reused ? 'reused --agent-json ids' : `provisioned throwaway agent, opening phrase ${v.openingPhrase === SILENT_OPENING ? 'SILENT_OPENING' : JSON.stringify(v.openingPhrase)}`);
    if (agent.reused && OPENING) await kaltura.intellectConfig.setOpeningPhrase(agent.configId, OPENING, admin.ks);
    // Client variables are off by default, and a session that sends requestVars without them never starts.
    if (v.clientVars) await kaltura.intellects.setClientVariablesEnabled(agent.configId, true, admin.ks);
    if (PROMPT_KB) report.note(`${who}: prompt padded`, await padPrompt(agent.configId));
    // One init up front gives the backend origins: the hint tags are built from them, and the
    // Resource Timing entries below are matched against them. Hostnames stay in memory only.
    const mintInit = () => mintPageInit(kaltura, agent, target.genieUrl);
    if (!HINT_TAGS.length) HINT_TAGS = resourceHints(await mintInit());
    ({ server: a.server, origin: a.origin } = await startServer(mintInit, { hints: HINT_TAGS }));
  }
  report.data.hints = HINT_TAGS.map((h) => ({ rel: h.rel, as: h.as, crossorigin: h.crossorigin }));   // rels only, no hosts
  if (HINTS !== 'off') report.note('resource hints under test', HINT_TAGS.map((h) => `${h.rel}${h.as ? ` as=${h.as}` : ''}${h.crossorigin ? ' crossorigin' : ''}`));
  browser = await launchBrowser(choice);

  for (let i = 1; i <= RUNS; i++) {
    const context = await browser.newContext(contextOptions());
    /** @type {{pageErrors: string[], pages: import('playwright').Page[], network: import('./live-verify-kickoff-shared.mjs').NetRecord[]}} */
    const sink = { pageErrors: [], pages: [], network: [] };
    const arm = hintsOf(i);
    const { v, origin } = arms[(i - 1) % arms.length];   // round-robin, so every arm sees the same drift
    const tag = COMPARE ? `run ${i} [${v.name}]` : `run ${i}`;
    /** @type {Record<string, any>} */
    const run = { n: i, arm: v.name, hints: arm };
    try {
      const page = await openHarness(context, origin, {
        mode: MODE, kickoff: v.kickoff ?? undefined, echo: v.echo ? 1 : undefined, mic: MIC, hints: arm === 'on' ? 1 : undefined,
        requestVars: v.requestVars ? JSON.stringify(v.requestVars) : undefined,
      }, sink);
      const ready = await page.evaluate(() => /** @type {any} */ (window).__events.find((/** @type {any} */ e) => e.type === 'harness:ready')?.detail ?? null);
      run.hintTags = ready?.hintTags ?? null;
      run.pageReadyMs = ready?.sinceNavMs ?? null;
      report.check(`${tag}: resource hints ${arm === 'on' ? 'present' : 'absent'} in <head> (${arm} arm)`, arm === 'on' ? run.hintTags === HINT_TAGS.length : run.hintTags === 0, { hintTags: run.hintTags, expected: arm === 'on' ? HINT_TAGS.length : 0 });
      const connect = await callHook(page, 'testConnect');
      report.check(`${tag}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      if (!connect.ok) { run.error = connect; continue; }

      // What "the agent spoke to the user" means for this setup.
      const isReply = (/** @type {any} */ d) => (v.kickoff ? !isOpeningSpeechId(d?.speechId) : typeof d?.text === 'string' && d.text.trim() !== '');
      let evs;
      if (v.kickoff || v.spoken) {
        ({ events: evs } = await waitFor(page, (e) => find(e, 'speechChunk', { where: isReply }), 30_000, 'first spoken words'));
      } else {
        ({ events: evs } = await waitFor(page, (e) => find(e, 'avatarStopTalking'), 30_000, 'silent opening end'));
      }
      const start = find(evs, 'connect:start');
      const resolved = find(evs, 'connect:resolved');
      const openingStop = find(evs, 'avatarStopTalking', { from: start.index });
      const openingFinished = find(evs, 'socket:in', { from: start.index, where: (d) => d.ev === 'stvFinishedTalking' });
      const firstChunk = find(evs, 'speechChunk', { where: isReply });
      // The talk event that starts the speech we measure: the reply's for a kickoff, the opening's otherwise.
      const talkStart = v.kickoff
        ? find(evs, 'avatarStartTalking', { from: openingStop ? openingStop.index + 1 : start.index })
        : find(evs, 'avatarStartTalking', { from: start.index });

      // Let the user actually hear it: wait for the first sound after that talk event (or 8 s), then one more stats tick.
      if (talkStart) {
        await waitFor(page, (e) => find(e, 'audio:soundStart', { from: talkStart.index }), 8_000, 'audible sound after avatarStartTalking').catch(() => {});
      }
      // The content checks need the whole line: the scripted opening, or the reply to a preset question.
      if (v.expectInOpening) await waitFor(page, (e) => find(e, 'avatarStopTalking', { from: start.index }), 20_000, 'end of the scripted opening').catch(() => {});
      if (v.expectInReply && firstChunk) await waitFor(page, (e) => find(e, 'avatarStopTalking', { from: firstChunk.index }), 20_000, 'end of the reply').catch(() => {});
      await waitFor(page, (e) => find(e, 'stats:sample', { from: evs.length }), 2_000, 'stats tick').catch(() => {});
      evs = await page.evaluate(() => /** @type {any} */ (window).__events.slice());
      const sound = await page.evaluate(() => /** @type {any} */ (window).__sound);
      const resources = resourceMetrics(await callHook(page, 'testResources'));

      const T = start.tRel;
      // Re-read after the waits: a scripted opening ends well after its first words.
      const openingEnd = find(evs, 'avatarStopTalking', { from: start.index });
      const stvN = find(evs, 'pc:track')?.detail?.n ?? null;               // the peer that receives media is STV
      const mediaMode = find(evs, 'mediaReady')?.detail?.mode ?? null;
      const ctxRunning = !!find(evs, 'audioctx:state', { where: (d) => d.state === 'running' });
      const firstSoundAfterTalk = talkStart ? find(evs, 'audio:soundStart', { from: talkStart.index }) : null;
      const openingSound = openingStop ? find(evs, 'audio:soundStart', { from: resolved.index, where: () => true }) : null;
      const openingSoundInWindow = openingSound && openingStop && openingSound.tRel <= openingStop.tRel ? openingSound : null;
      const kickoffOut = v.kickoff ? find(evs, 'socket:out', { from: start.index, where: (d) => d.ev === 'onTextEntered' && d.text === v.kickoff }) : null;
      const firstTickWith = (/** @type {(d:any)=>boolean} */ pred) => find(evs, 'stats:sample', { from: start.index, where: pred });
      const lastSample = all(evs, 'stats:sample').at(-1)?.detail;
      const pair = lastSample?.pairs?.find((/** @type {any} */ p) => p.pc === stvN) ?? lastSample?.pairs?.[0] ?? null;
      const video = lastSample?.video?.[0] ?? null;

      Object.assign(run, {
        engine: find(evs, 'harness:ready')?.detail?.engine ?? null,
        mediaMode,
        connectMs: resolved.tRel - T,
        socketConnectMs: at(evs, 'socket:connect', T, { from: start.index }),
        scriptLoadMs: resources.scriptLoadMs,
        sdkLoadedAtMs: resources.sdkLoadedAtMs,
        whepPostMs: resources.whepPostMs,
        resources,
        stvIceMs: stvN === null ? null : at(evs, 'pc:state', T, { from: start.index, where: (d) => d.n === stvN && (d.connection === 'connected' || d.ice === 'connected' || d.ice === 'completed') }),
        asrIceMs: stvN === null ? null : at(evs, 'pc:state', T, { from: start.index, where: (d) => d.n !== stvN && (d.connection === 'connected' || d.ice === 'connected' || d.ice === 'completed') }),
        trackAudioMs: at(evs, 'track:unmute', T, { where: (d) => d.kind === 'audio' }),
        trackVideoMs: at(evs, 'track:unmute', T, { where: (d) => d.kind === 'video' }),
        firstAudioPacketMs: (() => { const e = firstTickWith((d) => (d.inbound || []).some((/** @type {any} */ r) => r.packetsReceived > 0)); return e ? e.tRel - T : null; })(),
        firstDecodedFrameMs: (() => { const e = firstTickWith((d) => (d.video || []).some((/** @type {any} */ r) => r.framesDecoded > 0)); return e ? e.tRel - T : null; })(),
        videoFirstFrameMs: at(evs, 'video:firstFrame', T),
        videoPlayingMs: at(evs, 'video:playing', T),
        audioPlayingMs: at(evs, 'audio:playing', T),
        openingEndMs: openingEnd ? openingEnd.tRel - T : null,
        openingAfterConnectMs: openingEnd ? openingEnd.tRel - resolved.tRel : null,
        kickoffAfterReleaseMs: kickoffOut && openingFinished ? kickoffOut.tRel - openingFinished.tRel : null,
        talkStartMs: talkStart ? talkStart.tRel - T : null,
        firstWordsMs: firstChunk ? firstChunk.tRel - T : null,
        firstWordsAfterConnectMs: firstChunk ? firstChunk.tRel - resolved.tRel : null,
        firstSoundMs: firstSoundAfterTalk ? firstSoundAfterTalk.tRel - T : null,
        soundAfterConnectMs: firstSoundAfterTalk ? firstSoundAfterTalk.tRel - resolved.tRel : null,
        talkToSoundMs: firstSoundAfterTalk && talkStart ? firstSoundAfterTalk.tRel - talkStart.tRel : null,
        soundSpans: sound?.spans?.length ?? 0,
        analyser: sound?.error ? `error: ${sound.error}` : (ctxRunning ? 'running' : 'not running'),
        textsSent: textsSent(evs).length,
        candidatePair: pair ? `${pair.local ?? '?'}→${pair.remote ?? '?'} ${pair.protocol ?? ''} rtt ${pair.rtt ?? 'n/a'}` : null,
        videoStats: video ? { decoded: video.framesDecoded, dropped: video.framesDropped, size: `${video.frameWidth}x${video.frameHeight}`, fps: video.framesPerSecond, freezes: video.freezeCount } : null,
        whep: whepSummary(sink.network),
        // What the STV answer actually negotiated per m-section (kind, port, direction, codecs).
        negotiated: stvN === null ? null : (find(evs, 'pc:sdp', { where: (d) => d.n === stvN && d.role === 'remote' })?.detail?.media ?? null),
      });
      const videoSection = run.negotiated?.find((/** @type {any} */ m) => m.kind === 'video') ?? null;
      const videoNegotiated = !!videoSection && videoSection.port !== 0 && videoSection.codecs.length > 0 && videoSection.dir !== 'inactive';
      const offeredVideoCodecs = find(evs, 'pc:sdp', { where: (d) => d.n === stvN && d.role === 'local' })?.detail?.media?.find((/** @type {any} */ m) => m.kind === 'video')?.codecs ?? null;

      report.check(`${tag}: STV media connected before connect() resolved`, mediaMode === 'audio' || (run.stvIceMs !== null && run.stvIceMs <= run.connectMs), { stvIceMs: run.stvIceMs, connectMs: run.connectMs, mediaMode });
      if (!v.spoken) {
        report.check(`${tag}: silent opening ended < 1500 ms after connect resolved`, run.openingAfterConnectMs !== null && run.openingAfterConnectMs < 1500, { openingAfterConnectMs: run.openingAfterConnectMs });
        if (ctxRunning) report.check(`${tag}: no sound heard during the silent opening`, !openingSoundInWindow, { soundAtMs: openingSoundInWindow ? openingSoundInWindow.tRel - T : null, openingEndMs: run.openingEndMs });
        else report.note(`${tag}: analyser not running, silent-opening audibility not measured`, { analyser: run.analyser });
      }
      if (v.kickoff) {
        report.check(`${tag}: kickoff sent ≤ 50 ms after opening stvFinishedTalking`, run.kickoffAfterReleaseMs !== null && run.kickoffAfterReleaseMs >= 0 && run.kickoffAfterReleaseMs <= 50, { kickoffAfterReleaseMs: run.kickoffAfterReleaseMs });
        report.check(`${tag}: exactly one text sent (the kickoff)`, run.textsSent === 1, { textsSent: run.textsSent });
        report.check(`${tag}: first speechChunk is the reply, not the opening`, !!firstChunk && !isOpeningSpeechId(firstChunk.detail?.speechId), { speechId: firstChunk?.detail?.speechId });
      } else {
        report.check(`${tag}: no text sent without a kickoff`, run.textsSent === 0, { textsSent: run.textsSent });
      }
      if (mediaMode !== 'audio') {
        if (run.negotiated && !videoNegotiated) {
          // The browser and the media server share no video codec (or the section was refused), so no
          // frame can arrive. That is a negotiation fact, recorded with the codecs each side offered.
          report.check(`${tag}: video negotiated with the media server`, false, { answer: videoSection, browserOffered: offeredVideoCodecs, engine: run.engine });
        } else {
          report.check(`${tag}: a video frame was decoded and rendered`, run.videoFirstFrameMs !== null && run.firstDecodedFrameMs !== null, { videoFirstFrameMs: run.videoFirstFrameMs, firstDecodedFrameMs: run.firstDecodedFrameMs, negotiated: videoSection });
        }
      }
      // Without a kickoff and with a silent opening the only speech is the silent opening itself,
      // so "sound heard" is not expected; the silent-opening check above already covers that case.
      if (talkStart && (v.kickoff || v.spoken)) {
        if (ctxRunning) report.check(`${tag}: sound heard after avatarStartTalking`, run.talkToSoundMs !== null, { talkToSoundMs: run.talkToSoundMs, spans: run.soundSpans });
        else report.note(`${tag}: analyser not running, audibility not measured`, { analyser: run.analyser, firstAudioPacketMs: run.firstAudioPacketMs });
      }
      const spokenText = (/** @type {(id:any)=>boolean} */ pick) => all(evs, 'speechChunk', (d) => pick(d?.speechId) && typeof d?.text === 'string').map((e) => e.detail.text).join('').replace(/\s+/g, ' ').trim();
      if (v.expectInOpening) {
        const text = spokenText(isOpeningSpeechId);
        report.check(`${tag}: the scripted opening rendered the client variable`, text.includes(v.expectInOpening), { text });
      }
      if (v.expectInReply) {
        const text = spokenText((id) => !isOpeningSpeechId(id));
        report.check(`${tag}: the reply answers the preset question`, v.expectInReply.test(text), { text });
      }
      if (v.echo) {
        const echoes = all(evs, 'transcript', (d) => d?.type === 'user' && typeof d?.text === 'string' && d.text.includes(/** @type {string} */ (v.kickoff)));
        report.check(`${tag}: the preset question shows once as a user transcript (echo)`, echoes.length === 1, { echoes: echoes.length });
      }
      const leaked = [...all(evs, 'transcript'), ...all(evs, 'speechChunk')].filter((e) => typeof e.detail?.text === 'string' && e.detail.text.includes(SILENT_OPENING));
      report.check(`${tag}: silent opening never surfaces as text`, leaked.length === 0, { leaked: leaked.length });
      const whepBad = run.whep.filter((/** @type {string} */ l) => /^POST .*(FAILED|→ [45]\d\d)/.test(l));
      if (mediaMode !== 'audio') report.check(`${tag}: every WHEP POST succeeded`, whepBad.length === 0, { whep: run.whep });
      report.note(`${tag}: timings from connect()`, { connectMs: run.connectMs, stvIceMs: run.stvIceMs, trackVideoMs: run.trackVideoMs, videoFirstFrameMs: run.videoFirstFrameMs, firstWordsMs: run.firstWordsMs, firstSoundMs: run.firstSoundMs, talkToSoundMs: run.talkToSoundMs, pair: run.candidatePair, video: run.videoStats });
      report.note(`${tag}: resources (hints ${arm})`, { pageReadyMs: run.pageReadyMs, scriptLoadMs: run.scriptLoadMs, sdkLoadedAtMs: run.sdkLoadedAtMs, sdkModules: resources.sdkModules, socketConnectMs: run.socketConnectMs, whepPostMs: run.whepPostMs, whepTao: resources.whepTao, whepReusedConnection: resources.whepReusedConnection });

      await callHook(page, 'testDisconnect').catch(() => {});
      // The release DELETE is sent fire-and-forget, so wait for its record instead of
      // sampling once: 300 ms is not always enough for the response to come back. The
      // browser can also log a SECOND, aborted record for the same request when the page
      // goes away right after the response, so one 2xx is the signal and the poll stops
      // at the first one rather than requiring every record to be a success.
      const released = () => whepSummary(sink.network).some((/** @type {string} */ l) => /^DELETE .* → 2\d\d$/.test(l));
      const waitUntil = Date.now() + 5000;
      while (!released() && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 300));
      const late = whepSummary(sink.network).filter((l) => !run.whep.includes(l));
      if (late.length) report.note(`${tag}: WHEP after disconnect()`, late);
      // The viewer release itself, as a check and not a note. A DELETE that is refused
      // or blocked leaves this viewer held until the server releases the session on its
      // own, and a re-subscribe to the same session can come back 409 in the meantime.
      // Only a POST-shaped check ran here before, so a failing DELETE was invisible.
      if (mediaMode !== 'audio') {
        report.check(`${tag}: the WHEP viewer was released on disconnect()`, released(), { whepAfterDisconnect: late });
      }
      run.whep = whepSummary(sink.network);
    } catch (err) {
      run.error = String(/** @type {any} */ (err)?.message || err);
      report.check(`${tag}: completed`, false, { error: run.error, pageErrors: sink.pageErrors.slice(0, 5) });
    } finally {
      const problems = netProblems(sink.network);
      if (problems.length) report.note(`${tag}: HTTP requests that failed or returned 4xx/5xx`, problems.slice(0, 10));
      if (sink.pageErrors.length) report.note(`${tag}: page errors`, sink.pageErrors.slice(0, 5));
      report.data.runs.push(run);
      await context.close();
    }
  }
} finally {
  if (browser) await browser.close();
  for (const a of arms) a.server?.close();
  for (const a of arms) {
    if (a.agent.reused && OPENING) await kaltura.intellectConfig.setOpeningPhrase(a.agent.configId, SILENT_OPENING, admin.ks).catch((e) => console.warn(`reset opening phrase failed: ${e?.message || e}`));
    await a.agent.cleanup();
    if (!a.agent.reused && !args.keep) {
      const gone = await verifyDeleted(kaltura, admin.ks, a.agent);
      report.check(`cleanup${COMPARE ? ` [${a.v.name}]` : ''}: agent, avatar and intellect deleted`, Object.values(gone).every((x) => x === 'deleted'), gone);
    }
  }
}

const ok = report.data.runs.filter((r) => !r.error);
const col = (/** @type {string} */ k, /** @type {Record<string, any>[]} */ rows = ok) => stats(rows.map((r) => r[k]).filter((x) => typeof x === 'number'));
const METRICS = /** @type {[string, string, string][]} */ ([
  ['pageReadyMs', 'page ready (navigation → harness ready)', ''],
  ['scriptLoadMs', 'socket.io script fetch (Resource Timing)', ''],
  ['sdkLoadedAtMs', 'SDK module graph loaded, since navigation (Resource Timing)', ''],
  ['socketConnectMs', 'socket connected', ''],
  ['whepPostMs', 'WHEP POST round trip (Resource Timing)', ''],
  ['connectMs', 'connect() resolved', BASELINE.connectMs],
  ['asrIceMs', 'ASR peer ICE connected', ''],
  ['stvIceMs', 'STV peer ICE connected', ''],
  ['trackAudioMs', 'remote audio track unmuted', ''],
  ['trackVideoMs', 'remote video track unmuted', ''],
  ['firstAudioPacketMs', 'first inbound audio packet (getStats)', ''],
  ['firstDecodedFrameMs', 'first decoded video frame (getStats)', ''],
  ['videoFirstFrameMs', 'first video frame presented (rVFC)', ''],
  ['videoPlayingMs', '<video> playing', ''],
  ['audioPlayingMs', '<audio> playing', ''],
  ['openingEndMs', 'opening avatarStopTalking', ''],
  ['openingAfterConnectMs', '  …relative to connect resolved', ''],
  ['kickoffAfterReleaseMs', 'opening stvFinishedTalking → kickoff on the wire', 'manual speak() after connect'],
  ['talkStartMs', 'avatarStartTalking (measured speech)', ''],
  ['firstWordsMs', 'first speechChunk (measured speech)', ''],
  ['firstWordsAfterConnectMs', '  …relative to connect resolved', BASELINE.firstWordsMs],
  ['firstSoundMs', 'sound heard (AnalyserNode)', ''],
  ['soundAfterConnectMs', '  …relative to connect resolved', ''],
  ['talkToSoundMs', 'avatarStartTalking → sound heard', ''],
]);
report.data.summary = Object.fromEntries(METRICS.map(([k]) => [k, col(k)]));
report.data.baseline = BASELINE;

const fmt = (/** @type {{min:any, median:any, max:any}} */ s) => (s.min === null ? 'n/a' : `${s.min} / ${s.median} / ${s.max}`);

// KPI budgets: one check per enforced KPI on the median, so a regression fails the run.
// With --compare every arm is judged on its own runs against its own budgets.
const kpiRows = (/** @type {Variant} */ v, /** @type {Record<string, any>[]} */ rows) => kpisFor(v).map((k) => {
  const s = col(k.key, rows);
  const measured = typeof s.median === 'number';
  const within = measured ? s.median <= k.budgetMs : null;
  let status = 'n/a';
  if (measured && k.enforce) status = within ? 'ok' : 'FAIL';
  else if (measured) status = within ? 'ok (not enforced)' : 'over budget (not enforced)';
  const detail = { medianMs: s.median, minMs: s.min, maxMs: s.max, n: s.n, budgetMs: k.budgetMs };
  const prefix = COMPARE ? `KPI [${v.name}]` : 'KPI';
  if (measured && k.enforce) report.check(`${prefix}: median ${k.label} ≤ ${k.budgetMs} ms`, within === true, detail);
  else report.note(`${prefix}: ${k.label} ${measured ? 'reported only, budget not enforced' : 'not measured in this run set'}`, detail);
  return { ...(COMPARE ? { arm: v.name } : {}), key: k.key, label: k.label, medianMs: s.median, minMs: s.min, maxMs: s.max, n: s.n, budgetMs: k.budgetMs, enforced: k.enforce && measured, ok: within, status };
});
const COMPARE_METRICS = ['connectMs', 'videoFirstFrameMs', 'trackAudioMs', 'openingAfterConnectMs', 'kickoffAfterReleaseMs', 'firstWordsAfterConnectMs', 'soundAfterConnectMs'];
const sign = (/** @type {number|null} */ d) => (d === null ? 'n/a' : `${d > 0 ? '+' : ''}${d}`);
/** @type {string[]} */
let compareMd = [];
let compareLine = '';
if (COMPARE) {
  const rowsOf = (/** @type {string} */ name) => ok.filter((r) => r.arm === name);
  /** @type {Record<string, any>} */
  const byArm = {};
  for (const v of VARIANTS) {
    const rows = rowsOf(v.name);
    byArm[v.name] = { runs: rows.length, failed: report.data.runs.filter((r) => r.arm === v.name && r.error).length, kpi: kpiRows(v, rows), summary: Object.fromEntries(METRICS.map(([k]) => [k, col(k, rows)])) };
  }
  const base = byArm[BASE_ARM].summary;
  /** arm median − silent+kickoff median per metric; negative = sooner than the baseline arm. */
  const deltaMedianMs = Object.fromEntries(VARIANTS.filter((v) => v.name !== BASE_ARM).map((v) => [v.name, Object.fromEntries(COMPARE_METRICS.map((k) => {
    const a = base[k].median; const b = byArm[v.name].summary[k].median;
    return [k, typeof a === 'number' && typeof b === 'number' ? b - a : null];
  }))]));
  report.data.compare = { baseline: BASE_ARM, arms: byArm, deltaMedianMs };
  report.data.kpi = VARIANTS.flatMap((v) => byArm[v.name].kpi);
  const others = VARIANTS.filter((v) => v.name !== BASE_ARM).map((v) => v.name);
  const label = Object.fromEntries(METRICS.map(([k, l]) => [k, l.trim()]));
  label.openingAfterConnectMs = 'opening ends after connect() resolved';
  label.firstWordsAfterConnectMs = 'first words after connect() resolved';
  label.soundAfterConnectMs = 'sound heard after connect() resolved';
  compareMd = [
    '## Compare',
    '',
    `min / median / max per arm, ms from connect() start (after-connect rows: from connect() resolved). Δ is the arm median − the ${BASE_ARM} median; negative is sooner. Runs per arm: ${VARIANTS.map((v) => `${v.name} ${byArm[v.name].runs}`).join(', ')}.`,
    '',
    mdTable(['metric', BASE_ARM, ...others.flatMap((n) => [n, `Δ ${n}`])], COMPARE_METRICS.map((k) => [label[k], fmt(base[k]), ...others.flatMap((n) => [fmt(byArm[n].summary[k]), sign(deltaMedianMs[n][k])])])),
    '',
  ];
  compareLine = `\ncompare, median first words / sound after connect(): ${VARIANTS.map((v) => `${v.name} ${byArm[v.name].summary.firstWordsAfterConnectMs.median ?? 'n/a'} / ${byArm[v.name].summary.soundAfterConnectMs.median ?? 'n/a'} ms`).join('; ')}`;
} else {
  report.data.kpi = kpiRows(VARIANTS[0], ok);
}
const kpiMd = [
  '## KPI',
  '',
  `Median over the ${ok.length} successful run${ok.length === 1 ? '' : 's'}${COMPARE ? ', per arm,' : ''} vs budget, ms from connect() start (after-connect KPIs: from connect() resolved). ${ENFORCE ? 'An enforced KPI over budget fails the run.' : 'Budgets not enforced (--no-budgets).'}`,
  '',
  mdTable([...(COMPARE ? ['arm'] : []), 'KPI', 'median', 'budget', 'min / max', 'result'], report.data.kpi.map((/** @type {any} */ k) => [...(COMPARE ? [k.arm] : []), k.label, k.medianMs ?? 'n/a', `≤ ${k.budgetMs}`, k.medianMs === null ? '' : `${k.minMs} / ${k.maxMs}`, k.status])),
  '',
];
const kpiLine = report.data.kpi.map((/** @type {any} */ k) => `${k.arm ? `[${k.arm}] ` : ''}${k.label.replace(/ \(.*\)$/, '')} ${k.medianMs ?? 'n/a'}${k.medianMs === null ? '' : ` ≤ ${k.budgetMs}`} ${k.status}`).join('; ');

// A/B: per-arm stats and the on − off median delta (negative = hints made it faster).
/** @type {string[]} */
let abMd = [];
let abLine = '';
if (HINTS === 'ab') {
  const off = ok.filter((r) => r.hints === 'off');
  const on = ok.filter((r) => r.hints === 'on');
  const delta = (/** @type {string} */ k) => { const a = col(k, off).median; const b = col(k, on).median; return typeof a === 'number' && typeof b === 'number' ? b - a : null; };
  report.data.ab = Object.fromEntries(METRICS.map(([k]) => [k, { off: col(k, off), on: col(k, on), deltaMedianMs: delta(k) }]));
  abMd = [
    `## Resource hints A/B (${off.length} runs off, ${on.length} runs on)`,
    '',
    'Hints under test: ' + HINT_TAGS.map((h) => `\`${h.rel}${h.as ? ` as=${h.as}` : ''}${h.crossorigin ? ' crossorigin' : ''}\``).join(', ') + '. Delta is the on − off median; negative means the hints made it faster.',
    '',
    mdTable(['metric', 'off (min / median / max)', 'on (min / median / max)', 'Δ median'], METRICS.map(([k, label]) => [label, fmt(report.data.ab[k].off), fmt(report.data.ab[k].on), sign(report.data.ab[k].deltaMedianMs)])),
    '',
  ];
  abLine = `\nhints A/B, Δ median (on − off): connect ${sign(delta('connectMs'))} ms; socket ${sign(delta('socketConnectMs'))} ms; WHEP POST ${sign(delta('whepPostMs'))} ms; stv ice ${sign(delta('stvIceMs'))} ms; first frame ${sign(delta('videoFirstFrameMs'))} ms; first words ${sign(delta('firstWordsMs'))} ms; sound ${sign(delta('firstSoundMs'))} ms`;
}

const md = [
  `# connect timing — ${target.name} — ${report.meta.startedAt}`,
  '',
  `${RUNS} runs. ${SETUP}. Values are ms from connect() start as min / median / max unless stated.`,
  '',
  ...kpiMd,
  ...compareMd,
  '## All timings',
  '',
  mdTable(['metric', 'measured', 'baseline (before)'], METRICS.map(([k, label, base]) => [label, fmt(report.data.summary[k]), base])),
  '',
  ...abMd,
  mdTable(['run', 'arm', 'hints', 'page ready', 'socket', 'whep post', 'connect', 'stv ice', 'video unmute', 'first frame', 'video playing', 'opening end', 'kickoff Δ', 'first words', 'sound heard', 'talk→sound', 'pair', 'video codecs', 'error'],
    report.data.runs.map((r) => [r.n, r.arm ?? '', r.hints ?? '', r.pageReadyMs ?? '', r.socketConnectMs ?? '', r.whepPostMs ?? '', r.connectMs ?? '', r.stvIceMs ?? '', r.trackVideoMs ?? '', r.videoFirstFrameMs ?? '', r.videoPlayingMs ?? '', r.openingEndMs ?? '', r.kickoffAfterReleaseMs ?? '', r.firstWordsMs ?? '', r.firstSoundMs ?? '', r.talkToSoundMs ?? '', r.candidatePair ?? '', (r.negotiated ?? []).filter((/** @type {any} */ m) => m.kind === 'video').map((/** @type {any} */ m) => (m.port === 0 ? 'rejected' : m.codecs.join('/') || 'none')).join(' ') || '', r.error ?? ''])),
  '',
  '## Cross-origin resources per run (Resource Timing)',
  '',
  ...report.data.runs.map((r) => `- run ${r.n} (hints ${r.hints}): ${(r.resources?.crossOrigin ?? []).map((/** @type {any} */ e) => `${e.initiator} ${e.url} +${e.startRel} ms, ${e.durationMs} ms${e.tao ? (e.reused ? ', reused connection' : ', new connection') : ''}`).join('; ') || 'none recorded'}`),
  '',
  '## WHEP requests per run',
  '',
  ...report.data.runs.map((r) => `- run ${r.n}: ${(r.whep || []).join('; ') || 'none recorded'}`),
  '',
  '## Checks',
  '',
  mdTable(['result', 'check', 'detail'], report.checks.map((c) => [c.ok ? 'ok' : 'FAIL', c.name, c.detail === undefined ? '' : JSON.stringify(c.detail)])),
  '',
].join('\n');
report.write(outDir, md);
const pooled = COMPARE ? '' : `\nconnect() ${fmt(report.data.summary.connectMs)} ms (baseline ${BASELINE.connectMs}); first words after connect ${fmt(report.data.summary.firstWordsAfterConnectMs)} ms (baseline ${BASELINE.firstWordsMs}); sound heard ${fmt(report.data.summary.firstSoundMs)} ms; first frame ${fmt(report.data.summary.videoFirstFrameMs)} ms`;
// With --compare the pooled line would mix arms, so only the per-arm line prints.
console.log(`\n${SETUP}${pooled}${abLine}${compareLine}\nKPI (median ≤ budget): ${kpiLine}`);
process.exit(report.failed ? 1 : 0);
