import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wilson, judge, zeroViolationBound, percentile, median, seededRandom, bootstrapMedianDiff } from '../../scripts/lib/emotion-eval/stats.mjs';

/** Statistics behind the emotions eval. */

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} is not within ${eps} of ${b}`);

test('wilson matches known values', () => {
  const w = wilson(8, 10);
  near(w.rate, 0.8);
  near(w.lo, 0.4902);
  near(w.hi, 0.9433);
  const half = wilson(50, 100);
  near(half.lo, 0.4038);
  near(half.hi, 0.5962);
});

test('wilson handles zero trials, all pass and all fail', () => {
  assert.deepEqual(wilson(0, 0), { rate: null, lo: 0, hi: 1, k: 0, n: 0 });
  assert.deepEqual(wilson(3, -1), { rate: null, lo: 0, hi: 1, k: 0, n: 0 });
  assert.equal(wilson(NaN, 5).rate, null);
  const all = wilson(10, 10);
  near(all.hi, 1);
  near(all.lo, 0.7225);
  const none = wilson(0, 10);
  near(none.lo, 0);
  near(none.hi, 0.2775);
});

test('wilson clamps k into 0..n', () => {
  assert.equal(wilson(15, 10).k, 10);
  assert.equal(wilson(-2, 10).k, 0);
});

test('judge atLeast: pass, fail and inconclusive come from the interval, not the point estimate', () => {
  assert.equal(judge(wilson(100, 100), 'atLeast', 0.8), 'PASS');
  assert.equal(judge(wilson(0, 30), 'atLeast', 0.8), 'FAIL');
  // 8 of 10 is exactly the target, but the interval is wide.
  assert.equal(judge(wilson(8, 10), 'atLeast', 0.8), 'INCONCLUSIVE');
  assert.equal(judge(wilson(0, 0), 'atLeast', 0.8), 'NO_DATA');
});

test('judge atMost mirrors atLeast', () => {
  assert.equal(judge(wilson(0, 100), 'atMost', 0.05), 'PASS');
  assert.equal(judge(wilson(50, 100), 'atMost', 0.05), 'FAIL');
  assert.equal(judge(wilson(1, 10), 'atMost', 0.05), 'INCONCLUSIVE');
  assert.equal(judge(null, 'atMost', 0.05), 'NO_DATA');
});

test('zeroViolationBound follows the rule of three', () => {
  near(zeroViolationBound(100), 0.0295);
  near(zeroViolationBound(10), 0.2589);
  assert.equal(zeroViolationBound(0), 1);
});

test('percentile and median ignore non-finite values and interpolate', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([NaN, 5, Infinity, 7]), 6);
  assert.equal(percentile([10, 20, 30, 40, 50], 0.9), 46);
  assert.equal(percentile([1, 2], 5), 2);
  assert.equal(percentile([1, 2], -1), 1);
});

test('seededRandom is deterministic and in [0, 1)', () => {
  const a = seededRandom(7), b = seededRandom(7);
  for (let i = 0; i < 50; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test('bootstrapMedianDiff needs two values per side and is repeatable', () => {
  assert.equal(bootstrapMedianDiff([1], [1, 2]), null);
  assert.equal(bootstrapMedianDiff([1, 2], []), null);
  const on = [110, 120, 130, 140, 150, 160];
  const off = [100, 105, 110, 115, 120, 125];
  const r1 = bootstrapMedianDiff(on, off);
  const r2 = bootstrapMedianDiff(on, off);
  assert.deepEqual(r1, r2);
  assert.equal(r1.diff, 22.5);
  assert.ok(r1.lo <= r1.diff && r1.diff <= r1.hi);
  const same = bootstrapMedianDiff([5, 5, 5], [5, 5, 5], { iters: 50, seed: 3 });
  assert.deepEqual(same, { diff: 0, lo: 0, hi: 0 });
});
