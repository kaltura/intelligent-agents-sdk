/**
 * Where a gesture clip can join the idle loop without a visible cut. Pure, no DOM, so it runs under tests.
 *
 * `joins.json` comes from `scripts/analyze-showroom-body.mjs`:
 *   { "fps": 24, "idle": 477,
 *     "clips": { "beat": { "frames": 177,
 *                "entry": { "k": [...], "d": [...] },      per idle frame p: the best clip frame k to start on, and how far apart they look
 *                "exits": [[k, p, d], ...] } } }           clip frames that look like idle frame p. The last frame is always one
 * A distance d of about 3 or less is invisible, about 6 is mild, 10 or more shows as a ghost.
 */

/** Check a joins file and return it, or null. @param {any} j */
export function parseJoins(j) {
  if (!j || !(j.fps > 0) || !(j.idle > 0) || !j.clips || typeof j.clips !== 'object') return null;
  const clips = {};
  for (const [name, c] of Object.entries(j.clips)) {
    const ok = c && c.frames > 0 && c.entry?.k?.length === j.idle && c.entry?.d?.length === j.idle
      && Array.isArray(c.exits) && c.exits.length > 0 && c.exits.every((e) => Array.isArray(e) && e.length === 3 && e.every(Number.isFinite));
    if (ok) clips[name] = c;
  }
  return { fps: j.fps, idle: j.idle, clips };
}

/** Frames from `from` forward to `to` on the idle loop, negative when `to` has just passed. @param {number} from @param {number} to @param {number} n */
export const ahead = (from, to, n) => ((((to - from) % n) + n * 1.5) % n) - n * 0.5;

/**
 * Pick where in the idle loop to start a clip. Looks a short way ahead for the idle frame that
 * looks most like a clip frame, and charges a little for every frame of waiting.
 * @param {ReturnType<typeof parseJoins>} joins
 * @param {string} clip
 * @param {number} phase the idle frame on screen now (may be fractional)
 * @param {{minAhead?:number, maxAhead?:number, waitCost?:number}} [opts] frames; `minAhead` leaves time to seek the clip
 * @returns {{p:number, k:number, d:number, wait:number} | null} start the clip on frame `k` when the idle loop reaches frame `p`
 */
export function planEntry(joins, clip, phase, { minAhead = 8, maxAhead = 36, waitCost = 0.08 } = {}) {
  const c = joins?.clips[clip];
  if (!c) return null;
  const n = joins.idle;
  const now = Math.floor(phase);
  let best = null;
  for (let wait = minAhead; wait <= maxAhead; wait++) {
    const p = (((now + wait) % n) + n) % n;
    const cost = c.entry.d[p] + waitCost * wait;
    if (!best || cost < best.cost) best = { p, k: c.entry.k[p], d: c.entry.d[p], wait, cost };
  }
  return best && { p: best.p, k: best.k, d: best.d, wait: best.wait };
}

/**
 * Pick where a clip hands back to the idle loop. Prefers a close match near `target`, never before `fromK + minAhead`.
 * An exit before the target costs more than one after it, so a gesture does not end early.
 * @param {ReturnType<typeof parseJoins>} joins
 * @param {string} clip
 * @param {number} fromK the clip frame on screen now
 * @param {{minAhead?:number, target?:number}} [opts] frames. `minAhead` leaves time to seek the idle loop
 * @returns {{k:number, p:number, d:number} | null} leave the clip at frame `k` and show idle frame `p`
 */
export function planExit(joins, clip, fromK, { minAhead = 14, target = fromK + minAhead } = {}) {
  const c = joins?.clips[clip];
  if (!c) return null;
  const earliest = fromK + minAhead;
  const pool = c.exits.filter(([k]) => k >= earliest);
  const exits = pool.length ? pool : [c.exits[c.exits.length - 1]];
  let best = null;
  for (const [k, p, d] of exits) {
    const cost = d + (k < target ? 0.15 * (target - k) : 0.03 * (k - target));
    if (!best || cost < best.cost) best = { k, p, d, cost };
  }
  return { k: best.k, p: best.p, d: best.d };
}
