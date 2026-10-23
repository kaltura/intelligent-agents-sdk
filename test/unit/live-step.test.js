import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { runStep, stepLabel } from '../../scripts/lib/live-step.mjs';
import { PROD_PROBES, probeBackend, formatProbes, waitForBackend } from '../../scripts/lib/backend-health.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'live-step-'));
const noSleep = async () => {};

/** A child that fails until it has run `failTimes` times, counting runs in a file. */
function flaky(dir, failTimes) {
  const counter = join(dir, 'count');
  writeFileSync(counter, '0');
  const src = `const fs=require('fs');const n=+fs.readFileSync(${JSON.stringify(counter)},'utf8')+1;`
    + `fs.writeFileSync(${JSON.stringify(counter)},String(n));console.log('run '+n);process.exit(n<=${failTimes}?3:0);`;
  return { cmd: process.execPath, args: ['-e', src], runs: () => Number(readFileSync(counter, 'utf8')) };
}

function step(dir, child, extra = {}) {
  const lines = [];
  const summaryPath = join(dir, 'summary.md');
  const logPath = join(dir, 'live-verify-kickoff-output.log');
  return {
    lines, summaryPath, logPath,
    run: () => runStep({ cmd: child.cmd, args: child.args, logPath, sleep: noSleep, out: (l) => lines.push(l), summaryPath, ...extra }),
  };
}

test('stepLabel: strips the live-verify prefix and the output suffix', () => {
  assert.equal(stepLabel('live-verify-kickoff-output.log'), 'kickoff');
  assert.equal(stepLabel('/a/b/live-verify-connect-timing-output.log'), 'connect-timing');
  assert.equal(stepLabel('live-verify-output.log'), 'smoke');
  assert.equal(stepLabel('mcp-verify.log'), 'mcp-verify.log');
});

test('runStep: a passing step runs once and writes its output to the log', async () => {
  const dir = tmp();
  const s = step(dir, flaky(dir, 0));
  const r = await s.run();
  assert.deepEqual(r, { code: 0, attempts: 1, passedOnRetry: false });
  assert.match(readFileSync(s.logPath, 'utf8'), /^run 1\n$/);
  assert.deepEqual(s.lines, []);
  assert.equal(existsSync(s.summaryPath), false);
});

test('runStep: a step that fails once passes on retry and says so in the annotations and summary', async () => {
  const dir = tmp();
  const child = flaky(dir, 1);
  let waited = 0;
  const s = step(dir, child, { waitForBackend: async () => { waited++; return { up: true }; } });
  const r = await s.run();
  assert.deepEqual(r, { code: 0, attempts: 2, passedOnRetry: true });
  assert.equal(child.runs(), 2);
  assert.equal(waited, 1);
  const log = readFileSync(s.logPath, 'utf8');
  assert.match(log, /run 1\n\n===== live-step: attempt 2 of 2 =====\nrun 2\n/);
  assert.match(s.lines[0], /^::warning title=kickoff: retrying::The step failed \(exit 3 after \d+ s\)/);
  assert.match(s.lines[1], /^::warning title=kickoff: passed on retry::/);
  assert.match(readFileSync(s.summaryPath, 'utf8'), /\*\*kickoff\*\* passed on retry\. The first attempt failed \(exit 3/);
});

test('runStep: a step that fails twice fails with an error annotation', async () => {
  const dir = tmp();
  const child = flaky(dir, 5);
  const s = step(dir, child);
  const r = await s.run();
  assert.deepEqual(r, { code: 3, attempts: 2, passedOnRetry: false });
  assert.equal(child.runs(), 2);
  assert.match(s.lines.at(-1), /^::error title=kickoff: failed twice::/);
});

test('runStep: retries 0 runs once and adds no annotation', async () => {
  const dir = tmp();
  const child = flaky(dir, 5);
  const s = step(dir, child, { retries: 0 });
  const r = await s.run();
  assert.deepEqual(r, { code: 3, attempts: 1, passedOnRetry: false });
  assert.equal(child.runs(), 1);
  assert.deepEqual(s.lines, []);
});

test('runStep: no retry when a retry as long as the failed attempt would not fit the budget', async () => {
  const dir = tmp();
  const child = flaky(dir, 5);
  let t = 0;
  // t0 = 400 s, the attempt runs 800 s → 1200 s: 400 s elapsed + 400 s again > 600 s budget.
  const s = step(dir, child, { budgetMs: 600_000, now: () => (t += 400_000) });
  const r = await s.run();
  assert.equal(r.attempts, 1);
  assert.equal(child.runs(), 1);
  assert.match(s.lines[0], /^::notice title=kickoff: no retry::.*too late/);
});

test('runStep: the backend wait gets only the time the budget has left', async () => {
  const dir = tmp();
  const child = flaky(dir, 1);
  let t = 0;
  const waits = [];
  // Each now() adds 100 s: t0 0, attempt 100 → 200 s (took 100 s), the wait reads 400 s: 1000 − 400 − 100 = 500 s.
  const s = step(dir, child, { budgetMs: 1_000_000, now: () => { const v = t; t += 100_000; return v; }, waitForBackend: async (ms) => { waits.push(ms); return { up: true }; } });
  const r = await s.run();
  assert.equal(r.passedOnRetry, true);
  assert.deepEqual(waits, [500_000]);
});

test('runStep: a cancel stops the child and skips the retry', async () => {
  const dir = tmp();
  const signals = new EventEmitter();
  const s = step(dir, { cmd: process.execPath, args: ['-e', 'setTimeout(() => process.exit(3), 10000)'] }, { signals });
  setTimeout(() => signals.emit('SIGTERM', 'SIGTERM'), 300);
  const r = await s.run();
  assert.deepEqual(r, { code: 1, attempts: 1, passedOnRetry: false });
  assert.match(s.lines[0], /^::notice title=kickoff: no retry::.*cancelled/);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('runStep: no retry when the backend is still down', async () => {
  const dir = tmp();
  const child = flaky(dir, 5);
  const s = step(dir, child, { waitForBackend: async () => ({ up: false }) });
  const r = await s.run();
  assert.deepEqual(r, { code: 3, attempts: 1, passedOnRetry: false });
  assert.equal(child.runs(), 1);
  assert.match(s.lines.at(-1), /^::error title=kickoff: backend unavailable::/);
  assert.match(readFileSync(s.summaryPath, 'utf8'), /was not retried: the backend did not answer/);
});

test('runStep: a command that cannot start fails without throwing', async () => {
  const dir = tmp();
  const s = step(dir, { cmd: join(dir, 'missing-binary'), args: [] }, { retries: 0 });
  const r = await s.run();
  assert.equal(r.code, 1);
  assert.match(readFileSync(s.logPath, 'utf8'), /live-step: .*ENOENT/);
});

/** A fake fetch that answers each probe url from `byUrl` (a status, or an Error to throw). */
const fakeFetch = (byUrl) => async (url) => {
  const v = byUrl(url);
  if (v instanceof Error) throw v;
  return { status: v, body: { cancel: async () => {} } };
};

test('PROD_PROBES: four services, named by SDK config key, all https', () => {
  assert.deepEqual(PROD_PROBES.map((p) => p.name), ['agenticUrl', 'genieUrl', 'ovpUrl', 'conversation server']);
  for (const p of PROD_PROBES) assert.match(p.url, /^https:\/\//);
});

test('probeBackend: below 500 is up, 5xx and network errors are down', async () => {
  const probes = [{ name: 'a', url: 'u404' }, { name: 'b', url: 'u503' }, { name: 'c', url: 'uerr' }];
  const err = Object.assign(new Error('x'), { name: 'TimeoutError' });
  const r = await probeBackend({ probes, fetch: fakeFetch((u) => (u === 'uerr' ? err : Number(u.slice(1)))) });
  assert.deepEqual(r, [
    { name: 'a', up: true, status: 404 },
    { name: 'b', up: false, status: 503 },
    { name: 'c', up: false, status: null, error: 'TimeoutError' },
  ]);
  assert.equal(formatProbes(r), 'a 404 up, b 503 DOWN, c TimeoutError DOWN');
});

test('waitForBackend: probes again until every service is up', async () => {
  let round = 0;
  const sleeps = [];
  const logs = [];
  const r = await waitForBackend({
    probes: [{ name: 'a', url: 'x' }],
    fetch: fakeFetch(() => (round < 2 ? 503 : 200)),
    sleep: async (ms) => { sleeps.push(ms); },
    log: (l) => { round++; logs.push(l); },
    now: () => 0,
  });
  assert.equal(r.up, true);
  assert.equal(r.rounds, 3);
  assert.deepEqual(sleeps, [5000, 10_000]);
  assert.equal(logs[0], 'backend check 1: a 503 DOWN');
});

test('waitForBackend: gives up at the deadline and caps the wait at the time left', async () => {
  let t = 0;
  const sleeps = [];
  const r = await waitForBackend({
    probes: [{ name: 'a', url: 'x' }],
    fetch: fakeFetch(() => 502),
    deadlineMs: 50_000,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    now: () => t,
  });
  assert.equal(r.up, false);
  assert.deepEqual(sleeps, [5000, 10_000, 20_000, 15_000]);
  assert.equal(r.waitedMs, 50_000);
  assert.equal(r.results[0].status, 502);
});

test('waitForBackend: the default sleep and log work with a short deadline', async () => {
  const r = await waitForBackend({ probes: [{ name: 'a', url: 'x' }], fetch: fakeFetch(() => 500), deadlineMs: 5 });
  assert.equal(r.up, false);
  assert.ok(r.rounds >= 2);
});

test('runStep: the default sleep and annotation output work', async () => {
  const dir = tmp();
  const child = flaky(dir, 1);
  const r = await runStep({ cmd: child.cmd, args: child.args, logPath: join(dir, 'x-output.log'), pauseMs: 0 });
  assert.equal(r.passedOnRetry, true);
});
