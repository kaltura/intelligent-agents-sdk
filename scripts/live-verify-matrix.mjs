#!/usr/bin/env node
/**
 * Run live scripts against every target, one at a time, and print one table.
 *
 *   npm run live-verify:matrix
 *   npm run live-verify:matrix -- --targets prod,nvq2:1 --scripts connect-timing,kickoff
 *   npm run live-verify:matrix -- --list
 *
 * Each script gets the target as `TARGET` (and as `--env` where it parses that). Logs go to
 * `<out>/<target>/<script>.log` (default out `live-verify-artifacts`). A target whose credentials
 * cannot be resolved fails every script for that target. It is never skipped. Exits 1 if any cell
 * is not a pass. Runs are sequential: the scripts create real agents and must not overlap.
 *
 * Credentials come from `scripts/lib/target.mjs` in each child. This runner never reads them.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from './lib/target.mjs';
import { parseMatrixArgs, selectScripts, buildCommand, targetDir, renderTable, allPassed } from './lib/matrix.mjs';

/** True when `resolveTarget` accepts the spec (credentials present). Prints nothing from the child. @param {string} target */
function targetResolves(target) {
  const code = "import('./scripts/lib/target.mjs').then((m) => m.resolveTarget(process.argv[1]))";
  const r = spawnSync(process.execPath, ['-e', code, target], { cwd: repoRoot, stdio: 'ignore' });
  return r.status === 0;
}

/** @returns {Promise<number>} exit code @param {ReturnType<typeof buildCommand>} c @param {string} logPath */
function run(c, logPath) {
  return new Promise((done) => {
    const log = createWriteStream(logPath);
    const child = spawn(c.cmd, c.args, { cwd: repoRoot, env: { ...process.env, ...c.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('error', () => { log.end(); done(1); });
    child.on('close', (code) => { log.end(); done(code ?? 1); });
  });
}

let opts;
let scripts;
try {
  opts = parseMatrixArgs(process.argv.slice(2));
  scripts = selectScripts(opts.scripts);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}

if (opts.list) {
  for (const s of scripts) console.log(s.name);
  process.exit(0);
}

/** @type {import('./lib/matrix.mjs').MatrixResult[]} */
const results = [];
for (const target of opts.targets) {
  const dir = resolve(repoRoot, opts.outDir, targetDir(target));
  mkdirSync(dir, { recursive: true });
  const ok = targetResolves(target);
  if (!ok) console.error(`target ${target}: credentials or URLs not found. Every script fails for it.`);
  for (const s of scripts) {
    if (!ok) { results.push({ target, script: s.name, status: 'unavailable', ms: 0 }); continue; }
    const log = resolve(dir, `${s.name}.log`);
    const t0 = Date.now();
    console.error(`[${target}] ${s.name} ...`);
    const code = await run(buildCommand(s, target, dir), log);
    results.push({ target, script: s.name, status: code === 0 ? 'pass' : 'fail', ms: Date.now() - t0, log });
    console.error(`[${target}] ${s.name} ${code === 0 ? 'pass' : `FAIL (exit ${code}), log: ${log}`}`);
  }
}

console.log(`\n${renderTable(results, opts.targets)}\n`);
process.exit(allPassed(results) ? 0 : 1);
