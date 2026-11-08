#!/usr/bin/env node
/**
 * Live eval of avatar emotions (Limited Availability). Runs are for employees and certified partners only.
 * See docs/contributor/emotions-eval.md.
 *
 * Provisions one throwaway agent, runs every scenario N times on four paths, writes the raw turns to JSON,
 * then builds one HTML report from that JSON. The agent is deleted at the end, also on Ctrl-C.
 *
 *   on          stream, emotions on (the main path)
 *   off         stream, emotions off (leakage check and latency baseline)
 *   avatar-off  stream, `avatar` off with emotions on (must be refused or inert)
 *   send        the aggregate `conversations.send` call, emotions on
 *
 * Usage
 *   TARGET=<name> node scripts/live-eval-emotions.mjs [--trials 8] [--scenarios joy,sarcasm] [--concurrency 4]
 *        [--max-turns 400] [--turn-timeout 90] [--rate 80] [--paths on,off,avatar-off,send] [--out out/emotions-eval]
 *        [--strict] [--open] [--expand] [--experiences]
 *   node scripts/live-eval-emotions.mjs --dry-run            # recorded fixture, no network, no TARGET
 *   node scripts/live-eval-emotions.mjs --from results.json  # rebuild the report from saved results
 *
 * Exit code: 0 pass, 1 a hard dimension failed or turns failed so a hard dimension has no usable turn (an outage),
 * 2 a quality dimension failed (or is undecided with --strict), 3 a hard dimension had no data (for example a path
 * left out of --paths) or the run was stopped early, 4 bad usage or run error.
 * Not part of CI: CI has no credentials for this environment.
 */
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { pickScenarios, SCENARIOS } from './lib/emotion-eval/scenarios.mjs';
import { planJobs, runJobs, liveTurn, withPacing } from './lib/emotion-eval/runner.mjs';
import { analyze } from './lib/emotion-eval/analyze.mjs';
import { renderReport } from './lib/emotion-eval/report.mjs';
import { runParserChecks } from './lib/emotion-eval/parser-checks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, 'lib/emotion-eval/fixtures/sample-results.json');
const PATHS = ['on', 'off', 'avatar-off', 'send'];

/**
 * Parse `--flag value` and `--flag`.
 * @param {string[]} argv
 */
export function parseFlags(argv) {
  /** @type {Record<string, string|true>} */ const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; } else out[a.slice(2)] = true;
  }
  return out;
}

/** @param {string|true|undefined} v @param {number} dflt @param {string} name */
function intFlag(v, dflt, name) {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} needs a whole number of 1 or more`);
  return n;
}

/**
 * Turn raw results into the two output files.
 * @param {any} results @param {string} outDir @param {{expand?:boolean, strict?:boolean, stamp?:string}} o
 */
export function writeOutputs(results, outDir, o = {}) {
  mkdirSync(outDir, { recursive: true });
  const a = analyze(results);
  const stamp = o.stamp ?? new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = resolve(outDir, `emotions-eval-${stamp}.json`);
  const htmlPath = resolve(outDir, `emotions-eval-${stamp}.html`);
  writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(htmlPath, renderReport(results, a, { expandAll: !!o.expand }));
  let code = a.verdict.exitCode;
  if (o.strict && a.verdict.label === 'PASS WITH WARNINGS') code = 2;
  return { analysis: a, jsonPath, htmlPath, code };
}

/** @param {ReturnType<typeof analyze>} a */
function printSummary(a) {
  console.log(`\nVERDICT: ${a.verdict.label}. ${a.verdict.summary}`);
  for (const [k, d] of Object.entries(a.hard)) console.log(`  hard  ${d.status.padEnd(7)} ${k}: ${d.violations}/${d.n}`);
  for (const [k, d] of Object.entries(a.soft)) {
    const x = /** @type {any} */ (d);
    console.log(`  soft  ${x.status.padEnd(12)} ${k}${x.rate !== undefined && x.rate !== null ? `: ${x.k}/${x.n} (${Math.round(x.lo * 100)}-${Math.round(x.hi * 100)}%)` : ''}`);
  }
  for (const i of a.insights) console.log(`  ${i.level.toUpperCase().padEnd(5)} ${i.text}`);
}

/** @param {string} file */
function openFile(file) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [file], () => {});
}

/**
 * Is this file the one node was started with? Works for paths with spaces and for symlinks.
 * @param {string|undefined} argv1
 */
export function isEntry(argv1) {
  if (!argv1) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(argv1)).href; } catch { return false; }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const outDir = resolve(String(flags.out ?? 'out/emotions-eval'));
  const common = { expand: !!flags.expand, strict: !!flags.strict };

  if (flags['dry-run'] || flags.from) {
    const file = flags['dry-run'] ? FIXTURE : resolve(String(flags.from));
    const results = JSON.parse(readFileSync(file, 'utf8'));
    results.meta = { ...results.meta, ...(flags['dry-run'] ? { dryRun: true } : {}) };
    if (!results.parserChecks) results.parserChecks = await runParserChecks();
    const out = writeOutputs(results, outDir, common);
    printSummary(out.analysis);
    console.log(`\nresults: ${out.jsonPath}\nreport:  ${out.htmlPath}`);
    if (flags.open) openFile(out.htmlPath);
    return out.code;
  }

  if (!process.env.TARGET) {
    console.error('TARGET is not set. Set it to the name of the Limited Availability environment, for example: TARGET=<name> node scripts/live-eval-emotions.mjs');
    return 4;
  }
  const trials = intFlag(flags.trials, 8, 'trials');
  const concurrency = intFlag(flags.concurrency, 4, 'concurrency');
  const maxTurns = intFlag(flags['max-turns'], 400, 'max-turns');
  const rate = intFlag(flags.rate, 80, 'rate'); // requests per minute; the server allows 100
  const timeoutMs = intFlag(flags['turn-timeout'], 90, 'turn-timeout') * 1000;
  const paths = String(flags.paths ?? PATHS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const badPath = paths.filter((p) => !PATHS.includes(p));
  if (badPath.length) throw new Error(`unknown --paths value(s): ${badPath.join(', ')}. Known: ${PATHS.join(', ')}`);
  const scenarios = pickScenarios(typeof flags.scenarios === 'string' ? flags.scenarios.split(',').map((s) => s.trim()) : undefined);

  const { Management } = await import('../src/management/index.js');
  const { resolveTarget } = await import('./lib/target.mjs');
  const { ensureAgent } = await import('./live-verify-kickoff-shared.mjs');
  const target = resolveTarget(process.env.TARGET);
  const kaltura = new Management(target);

  // Speech-only by default, so replies are spoken and can carry an emotion. `--experiences` leaves widgets on.
  const baseCapabilities = flags.experiences ? {} : { kaltura_genie_experiences: 'off' };
  const { jobs, planned, cut } = planJobs({ scenarios, trials, paths: /** @type {any} */ (paths), maxTurns, baseCapabilities });
  const turnCount = jobs.reduce((n, j) => n + j.turns.length, 0);
  console.log(`plan: ${jobs.length} jobs, ${turnCount} turns (${planned} wanted${cut ? `, cut to the ${maxTurns}-turn budget` : ''}), concurrency ${concurrency}, at most ${rate} requests/min, timeout ${timeoutMs / 1000}s`);

  /** @type {Awaited<ReturnType<typeof ensureAgent>>|undefined} */
  let agent;
  let stop = false;
  let cleaning;
  const cleanup = () => (cleaning ??= (async () => { if (agent) { await agent.cleanup(); agent = undefined; } })());
  process.on('SIGINT', () => {
    if (stop) { cleanup().finally(() => process.exit(130)); return; }
    stop = true;
    console.error('\nstopping: finishing turns in flight, then writing results. Press Ctrl-C again to quit now.');
  });

  const startedAt = new Date().toISOString();
  let results;
  try {
    const adminKs = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-eval' });
    agent = await ensureAgent(kaltura, adminKs.ks, {
      openingPhrase: 'Hello there.',
      brief: 'A warm, natural conversational assistant for a live SDK evaluation. Answer the user directly and follow what they ask for, including requests for a long or very short answer. Always answer in spoken sentences. Do not use cards, widgets or experiences. When asked for a link, show one.',
    });
    const conv = await kaltura.sessions.createConversationToken({ configId: agent.configId });
    let done = 0;
    const turns = await runJobs({
      jobs, concurrency, shouldStop: () => stop,
      runTurn: withPacing(liveTurn(kaltura, conv.ks, timeoutMs), { perMinute: rate }),
      onTurn: () => { done++; if (done % 20 === 0 || done === turnCount) console.log(`  ${done}/${turnCount} turns`); },
    });
    results = {
      schema: 1,
      meta: { target: target.name, startedAt, finishedAt: new Date().toISOString(), trials, concurrency, ratePerMinute: rate, paths, maxTurns, experiences: !!flags.experiences, budgetCut: cut, turnTimeoutMs: timeoutMs, interrupted: stop, node: process.version, dryRun: false },
      scenarios: SCENARIOS.filter((s) => scenarios.some((x) => x.id === s.id)),
      turns,
      parserChecks: await runParserChecks(),
    };
  } finally {
    await cleanup();
  }
  const out = writeOutputs(results, outDir, common);
  printSummary(out.analysis);
  console.log(`\nresults: ${out.jsonPath}\nreport:  ${out.htmlPath}`);
  if (flags.open) openFile(out.htmlPath);
  return out.code;
}

if (isEntry(process.argv[1])) {
  main().then((code) => process.exit(code), (err) => { console.error(`error: ${err?.message ?? err}`); process.exit(4); });
}
