import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import {
  MATRIX_SCRIPTS, DEFAULT_TARGETS, parseMatrixArgs, selectScripts, buildCommand, targetDir, renderTable, allPassed,
} from '../../scripts/lib/matrix.mjs';

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts');

test('parseMatrixArgs: defaults cover both backends', () => {
  const o = parseMatrixArgs([]);
  assert.deepEqual(o.targets, ['prod', 'nvq2:1']);
  assert.deepEqual(DEFAULT_TARGETS, ['prod', 'nvq2:1']);
  assert.equal(o.scripts, null);
  assert.equal(o.list, false);
  assert.equal(o.outDir, 'live-verify-artifacts');
});

test('parseMatrixArgs: lists, out dir, list flag', () => {
  const o = parseMatrixArgs(['--targets', 'prod', '--scripts', 'kickoff, smoke', '--out', 'x', '--list']);
  assert.deepEqual(o.targets, ['prod']);
  assert.deepEqual(o.scripts, ['kickoff', 'smoke']);
  assert.equal(o.outDir, 'x');
  assert.equal(o.list, true);
});

test('parseMatrixArgs: bad input throws', () => {
  assert.throws(() => parseMatrixArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseMatrixArgs(['--targets']), /comma-separated/);
  assert.throws(() => parseMatrixArgs(['--scripts', ' , ']), /comma-separated/);
  assert.throws(() => parseMatrixArgs(['--out']), /directory/);
});

test('selectScripts: default is the whole list, unknown names are an error', () => {
  assert.equal(selectScripts(null).length, MATRIX_SCRIPTS.length);
  assert.deepEqual(selectScripts(['kickoff']).map((s) => s.file), ['live-verify-kickoff.mjs']);
  assert.throws(() => selectScripts(['nope']), /unknown script "nope"/);
});

test('every matrix script exists, has a unique name and a live-verify file name', () => {
  const files = new Set(readdirSync(scriptsDir));
  const names = new Set();
  for (const s of MATRIX_SCRIPTS) {
    assert.ok(files.has(s.file), `${s.file} missing`);
    assert.ok(!names.has(s.name), `duplicate ${s.name}`);
    names.add(s.name);
    assert.match(s.file, /^live-verify.*\.mjs$/);
  }
});

test('envFlag scripts really parse --env (via the shared bootstrap)', () => {
  for (const s of MATRIX_SCRIPTS) {
    const src = readFileSync(resolve(scriptsDir, s.file), 'utf8');
    assert.equal(!!s.envFlag, /bootstrap\(process\.argv/.test(src), `${s.name}: envFlag must match whether the script calls bootstrap()`);
  }
});

test('buildCommand: TARGET always, --env and --out only for envFlag scripts', () => {
  const plain = buildCommand({ name: 'a', file: 'live-verify-agents.mjs' }, 'nvq2:1', '/o');
  assert.deepEqual(plain.args, ['scripts/live-verify-agents.mjs']);
  assert.deepEqual(plain.env, { TARGET: 'nvq2:1' });
  const flagged = buildCommand({ name: 'k', file: 'live-verify-kickoff.mjs', envFlag: true, args: ['--runs', '9'] }, 'prod', '/o');
  assert.deepEqual(flagged.args, ['scripts/live-verify-kickoff.mjs', '--runs', '9', '--env', 'prod', '--out', '/o']);
  assert.deepEqual(flagged.env, { TARGET: 'prod' });
});

test('targetDir is filesystem safe', () => {
  assert.equal(targetDir('prod'), 'prod');
  assert.equal(targetDir('nvq2:1'), 'nvq2-1');
});

test('renderTable: one row per script, one column per target, "not run" for a gap', () => {
  const results = [
    { target: 'prod', script: 'a', status: 'pass', ms: 1500 },
    { target: 'nvq2:1', script: 'a', status: 'fail', ms: 2500 },
    { target: 'prod', script: 'b', status: 'unavailable', ms: 0 },
  ];
  const t = renderTable(/** @type {any} */ (results), ['prod', 'nvq2:1']).split('\n');
  assert.equal(t[0], '| script | prod | nvq2:1 |');
  assert.equal(t[2], '| a | pass 1.5s | fail 2.5s |');
  assert.equal(t[3], '| b | unavailable 0.0s | not run |');
});

test('allPassed: empty or any non-pass is red', () => {
  assert.equal(allPassed([]), false);
  assert.equal(allPassed([{ target: 't', script: 's', status: 'pass', ms: 1 }]), true);
  assert.equal(allPassed([{ target: 't', script: 's', status: 'pass', ms: 1 }, { target: 't', script: 'u', status: 'unavailable', ms: 0 }]), false);
});

/**
 * Scripts that never need a Kaltura target. Anything else under scripts/live-verify*.mjs must pick its
 * backend through `resolveTarget` (directly or through the shared `bootstrap`), so it can run on NVP1 and NVQ2.
 */
const NO_TARGET = new Map([
  ['live-verify-hooks-shared.mjs', 'helper, takes a ready Management'],
  ['live-verify-silent-mic-shared.mjs', 'helper, takes a ready page'],
  ['live-verify-regions.mjs', 'probes every region, no credentials'],
  ['live-verify-salesforce-lead.mjs', 'talks to Salesforce only'],
  ['live-verify-matrix.mjs', 'runner, each child resolves its own target'],
]);

test('every live script resolves its backend through scripts/lib/target.mjs', () => {
  const live = readdirSync(scriptsDir).filter((f) => /^live-verify.*\.mjs$/.test(f));
  assert.ok(live.length > 20);
  for (const f of live) {
    if (NO_TARGET.has(f)) continue;
    const src = readFileSync(resolve(scriptsDir, f), 'utf8');
    assert.match(src, /resolveTarget|bootstrap\(/, `${f} must use resolveTarget() or the shared bootstrap()`);
  }
});

test('no live script reads credentials from process.env directly', () => {
  const files = readdirSync(scriptsDir).filter((f) => /^live-verify.*\.mjs$/.test(f));
  for (const f of files) {
    const src = readFileSync(resolve(scriptsDir, f), 'utf8');
    assert.doesNotMatch(src, /process\.env\.(AGENTIC_|NVQ2_|NVP1_)/, `${f} reads backend env vars directly`);
  }
});

test('the allowlist names real files', () => {
  const files = new Set(readdirSync(scriptsDir));
  for (const f of NO_TARGET.keys()) assert.ok(files.has(f), `${f} no longer exists`);
});
