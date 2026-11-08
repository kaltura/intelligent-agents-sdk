/**
 * Small statistics helpers for the emotions eval. Pure, no I/O.
 * Rates use the Wilson score interval. A dimension passes or fails on the interval, never on one point estimate.
 */

const Z95 = 1.959964;

/**
 * Wilson score interval for k successes out of n trials.
 * With n = 0 there is no information, so the interval is the whole range.
 * @param {number} k @param {number} n @param {number} [z]
 * @returns {{rate:number|null, lo:number, hi:number, k:number, n:number}}
 */
export function wilson(k, n, z = Z95) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0) return { rate: null, lo: 0, hi: 1, k: 0, n: 0 };
  const kk = Math.min(Math.max(k, 0), n);
  const p = kk / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { rate: p, lo: Math.max(0, center - half), hi: Math.min(1, center + half), k: kk, n };
}

/**
 * Judge a rate against a target using its interval.
 *  - `atLeast`: PASS when the lower bound reaches the target. FAIL when the upper bound is below it. Otherwise INCONCLUSIVE.
 *  - `atMost`:  PASS when the upper bound is at or below the target. FAIL when the lower bound is above it. Otherwise INCONCLUSIVE.
 * @param {{lo:number, hi:number, n:number}} ci @param {'atLeast'|'atMost'} dir @param {number} target
 * @returns {'PASS'|'FAIL'|'INCONCLUSIVE'|'NO_DATA'}
 */
export function judge(ci, dir, target) {
  if (!ci || !ci.n) return 'NO_DATA';
  if (dir === 'atLeast') return ci.lo >= target ? 'PASS' : ci.hi < target ? 'FAIL' : 'INCONCLUSIVE';
  return ci.hi <= target ? 'PASS' : ci.lo > target ? 'FAIL' : 'INCONCLUSIVE';
}

/**
 * Upper 95% bound on a violation rate after seeing none in n tries (the "rule of three" form, exact for 95%).
 * @param {number} n @returns {number}
 */
export function zeroViolationBound(n) {
  return n > 0 ? 1 - Math.pow(0.05, 1 / n) : 1;
}

/** @param {number[]} xs @returns {number[]} a sorted copy without non-finite values */
function clean(xs) { return xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); }

/**
 * Percentile by linear interpolation. `null` for an empty list.
 * @param {number[]} xs @param {number} q 0..1
 * @returns {number|null}
 */
export function percentile(xs, q) {
  const s = clean(xs);
  if (!s.length) return null;
  const pos = (s.length - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** @param {number[]} xs @returns {number|null} */
export function median(xs) { return percentile(xs, 0.5); }

/**
 * Deterministic PRNG (mulberry32), so a report built twice from one file is identical.
 * @param {number} seed @returns {() => number}
 */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap 95% interval for median(a) - median(b). Needs at least 2 values on each side.
 * @param {number[]} a @param {number[]} b @param {{iters?:number, seed?:number}} [opts]
 * @returns {{diff:number, lo:number, hi:number}|null}
 */
export function bootstrapMedianDiff(a, b, opts = {}) {
  const x = clean(a);
  const y = clean(b);
  if (x.length < 2 || y.length < 2) return null;
  const iters = opts.iters ?? 1000;
  const rnd = seededRandom(opts.seed ?? 1);
  const pick = (/** @type {number[]} */ arr) => { const out = new Array(arr.length); for (let i = 0; i < arr.length; i++) out[i] = arr[Math.floor(rnd() * arr.length)]; return out; };
  const diffs = [];
  for (let i = 0; i < iters; i++) diffs.push(/** @type {number} */ (median(pick(x))) - /** @type {number} */ (median(pick(y))));
  return { diff: /** @type {number} */ (median(x)) - /** @type {number} */ (median(y)), lo: /** @type {number} */ (percentile(diffs, 0.025)), hi: /** @type {number} */ (percentile(diffs, 0.975)) };
}
