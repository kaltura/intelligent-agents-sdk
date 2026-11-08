import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, writeOutputs } from '../../scripts/live-eval-emotions.mjs';
import { healthyRun } from '../fakes/emotion-results.js';

/** The eval command line: flags, output files, exit codes. No network. */

const CLI = fileURLToPath(new URL('../../scripts/live-eval-emotions.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('../../scripts/lib/emotion-eval/fixtures/sample-results.json', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'emo-eval-'));
// A clean environment: no target, no credentials, no proxy.
const cleanEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test' });
const run = (args, env = cleanEnv()) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60000 });

test('parseFlags reads values and switches, and rejects a stray argument', () => {
  assert.deepEqual(parseFlags(['--trials', '3', '--strict', '--out', 'x']), { trials: '3', strict: true, out: 'x' });
  assert.deepEqual(parseFlags([]), {});
  assert.deepEqual(parseFlags(['--open']), { open: true });
  assert.throws(() => parseFlags(['stray']), /unexpected argument: stray/);
});

test('writeOutputs writes the JSON and one HTML file, and returns the verdict exit code', () => {
  const dir = tmp();
  try {
    const out = writeOutputs(healthyRun(40), join(dir, 'nested', 'out'), { stamp: 'T1' });
    assert.equal(out.code, 0);
    assert.equal(out.analysis.verdict.label, 'PASS');
    assert.ok(out.jsonPath.endsWith('emotions-eval-T1.json') && out.htmlPath.endsWith('emotions-eval-T1.html'));
    assert.equal(JSON.parse(readFileSync(out.jsonPath, 'utf8')).turns.length, healthyRun(40).turns.length);
    assert.match(readFileSync(out.htmlPath, 'utf8'), /^<!doctype html>/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--strict turns PASS WITH WARNINGS into exit code 2', () => {
  const dir = tmp();
  try {
    const small = healthyRun(5);
    assert.equal(writeOutputs(small, dir, { stamp: 'a' }).analysis.verdict.label, 'PASS WITH WARNINGS');
    assert.equal(writeOutputs(small, dir, { stamp: 'b' }).code, 0);
    assert.equal(writeOutputs(small, dir, { stamp: 'c', strict: true }).code, 2);
    assert.equal(writeOutputs(healthyRun(40), dir, { stamp: 'd', strict: true }).code, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--dry-run reads the recorded fixture with no target and no network, and writes both files', () => {
  const dir = tmp();
  try {
    const r = run(['--dry-run', '--out', dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /VERDICT: /);
    const files = readdirSync(dir);
    assert.equal(files.filter((f) => f.endsWith('.json')).length, 1);
    assert.equal(files.filter((f) => f.endsWith('.html')).length, 1);
    const html = readFileSync(join(dir, files.find((f) => f.endsWith('.html'))), 'utf8');
    assert.match(html, /Recorded fixture, not a live run/);
    assert.equal(/<script/i.test(html), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--from rebuilds the report from a saved file and fails on a missing file', () => {
  const dir = tmp();
  try {
    const saved = join(dir, 'saved.json');
    writeFileSync(saved, JSON.stringify(healthyRun(40)));
    const ok = run(['--from', saved, '--out', join(dir, 'o')]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /VERDICT: PASS\./);
    const missing = run(['--from', join(dir, 'nope.json'), '--out', join(dir, 'o2')]);
    assert.equal(missing.status, 4);
    assert.match(missing.stderr, /^error: /);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a live run needs TARGET and has no default', () => {
  const dir = tmp();
  try {
    const r = run(['--out', dir]);
    assert.equal(r.status, 4);
    assert.match(r.stderr, /TARGET is not set/);
    assert.equal(existsSync(join(dir, 'x')), false);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bad flags exit with 4 before any work', () => {
  const dir = tmp();
  try {
    const env = { ...cleanEnv(), TARGET: 'example' };
    for (const args of [['--trials', '0'], ['--trials', 'x'], ['--rate', '0'], ['--paths', 'sideways'], ['--scenarios', 'nope'], ['stray']]) {
      const r = run([...args, '--out', dir], env);
      assert.equal(r.status, 4, args.join(' '));
      assert.match(r.stderr, /^error: /, args.join(' '));
    }
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the recorded fixture holds only placeholder data', () => {
  const text = readFileSync(FIXTURE, 'utf8');
  const j = JSON.parse(text);
  assert.equal(j.meta.target, 'example');
  assert.equal(j.meta.dryRun, false);
  assert.ok(j.turns.length > 50);
  assert.equal(/ks=|djJ8|secret|@[a-z]+\.[a-z]/i.test(text), false);
});
