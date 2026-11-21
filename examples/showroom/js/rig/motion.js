/**
 * How fast a gesture clip plays, frame by frame. Pure, no DOM, so it runs under tests.
 *
 * Footage is filmed at a steady, slow pace. Played as filmed, a reach looks mechanical. A person's arm
 * leaves fast, slows as it arrives, hangs a moment, then drops back with a little more energy. A style is
 * that shape as speed multipliers. The manifest marks three frames per clip:
 *   lift  the arm has arrived
 *   ret   the arm starts back
 *   end   the arm is home (the frame to hand back to the idle loop on)
 * A clip with no marks keeps the plain speed.
 */

/** @typedef {{lift:number, ret:number, end:number}} Marks */
/** @typedef {{weight:number, lift:[number,number], hold:number, ret:[number,number]}} Style */

/**
 * `lift` is the speed at the start and at the arrival of the reach, `hold` the speed while the hand stays out,
 * `ret` the speed at the start and at the end of the return.
 * @type {Record<string, Style>}
 */
export const STYLES = {
  quick: { weight: 1, lift: [2.6, 1.5], hold: 3, ret: [1.5, 2] },
  easy: { weight: 1.4, lift: [2, 1.3], hold: 1.8, ret: [1.3, 1.7] },
  linger: { weight: 1, lift: [2.3, 1.1], hold: 1.1, ret: [1.2, 1.8] },
};

const smooth = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Pick a style by weight. The one used last is out, so two reaches in a row never look the same.
 * @param {() => number} rng @param {string} [last] @param {Record<string, Style>} [styles]
 * @returns {string}
 */
export function pickStyle(rng, last = '', styles = STYLES) {
  const pool = Object.entries(styles).filter(([name]) => name !== last);
  const total = pool.reduce((sum, [, s]) => sum + s.weight, 0);
  let r = rng() * total;
  for (const [name, s] of pool) { r -= s.weight; if (r <= 0) return name; }
  return pool.at(-1)[0];
}

/**
 * The playback speed at clip frame `k`. Continuous: the speed at each boundary is the same on both sides, except the hold,
 * which the reach eases into and the return eases out of.
 * @param {number} k @param {Marks} marks @param {Style} style @param {number} [scale] a small per-gesture factor, so the same style is never exactly the same
 */
export function speedAt(k, marks, style, scale = 1) {
  const { lift, ret, end } = marks;
  let s;
  if (k < lift) s = lerp(style.lift[0], style.lift[1], smooth(k / lift));
  else if (k < ret) {
    // Ease from the arrival speed to the hold speed over the first quarter of the hold, and back out over the last quarter.
    const span = ret - lift;
    const into = smooth((k - lift) / (span * 0.25));
    const out = smooth((ret - k) / (span * 0.25));
    s = lerp(style.lift[1], style.hold, into);
    s = lerp(style.ret[0], s, out);
  } else s = lerp(style.ret[0], style.ret[1], smooth((k - ret) / Math.max(1, end - ret)));
  return s * scale;
}

/** Check manifest `motion` marks and return them, or null. @param {any} v @returns {Marks|null} */
export function parseMarks(v) {
  return v && v.lift > 0 && v.ret > v.lift && v.end > v.ret ? { lift: v.lift, ret: v.ret, end: v.end } : null;
}
