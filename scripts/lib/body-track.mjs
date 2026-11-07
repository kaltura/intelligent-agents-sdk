/**
 * Neck tracking for the showroom clip body (used by scripts/build-showroom-body.mjs).
 * The body sways, so the live head has to follow the neck on every frame. This finds where
 * two small patches of the collar moved, per frame, and turns that into [dx, dy, rotation].
 * Pure functions on 8-bit gray images. No dependencies.
 */

/** Average k×k blocks. Width and height must be multiples of k. @param {Uint8Array} img @param {number} w @param {number} h @param {number} k */
export function boxDown(img, w, h, k) {
  const [ow, oh] = [w / k, h / k];
  const out = new Float32Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let s = 0;
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += img[(y * k + j) * w + x * k + i];
      out[y * ow + x] = s / (k * k);
    }
  }
  return out;
}

/** Sum of absolute differences between a template and the haystack at offset (ox, oy). */
function sad(tpl, tw, th, hay, hw, ox, oy) {
  let s = 0;
  for (let y = 0; y < th; y++) {
    const [a, b] = [y * tw, (y + oy) * hw + ox];
    for (let x = 0; x < tw; x++) s += Math.abs(tpl[a + x] - hay[b + x]);
  }
  return s;
}

/** Sub-pixel peak of three costs around a minimum, from -0.5 to 0.5. */
const vertex = (l, c, r) => { const d = l - 2 * c + r; return d > 1e-9 ? Math.max(-0.5, Math.min(0.5, (l - r) / (2 * d))) : 0; };

/**
 * Where does `tpl` sit inside `hay`? The template's nominal spot is (margin, margin).
 * Searches coarse (every 4th pixel) then fine, and returns the shift from the nominal spot in pixels.
 * @param {Uint8Array} tpl @param {number} tw @param {number} th
 * @param {Uint8Array} hay @param {number} hw @param {number} hh
 * @param {number} margin  Pixels around the nominal spot to search. Multiple of 4.
 * @returns {[number, number]}
 */
export function locate(tpl, tw, th, hay, hw, hh, margin) {
  const K = 4;
  const [ct, ch] = [boxDown(tpl, tw, th, K), boxDown(hay, hw, hh, K)];
  const [ctw, cth, chw, cm] = [tw / K, th / K, hw / K, margin / K];
  let [best, bx, by] = [Infinity, 0, 0];
  for (let oy = 0; oy <= 2 * cm; oy++) {
    for (let ox = 0; ox <= 2 * cm; ox++) {
      const s = sad(ct, ctw, cth, ch, chw, ox, oy);
      if (s < best) { best = s; bx = ox; by = oy; }
    }
  }
  // Refine at full resolution around the coarse answer.
  const [fx, fy] = [bx * K, by * K];
  const cost = new Map();
  const at = (ox, oy) => {
    const key = oy * 4096 + ox;
    if (!cost.has(key)) cost.set(key, ox < 0 || oy < 0 || ox + tw > hw || oy + th > hh ? Infinity : sad(tpl, tw, th, hay, hw, ox, oy));
    return cost.get(key);
  };
  [best, bx, by] = [Infinity, fx, fy];
  for (let oy = fy - K; oy <= fy + K; oy++) for (let ox = fx - K; ox <= fx + K; ox++) { const s = at(ox, oy); if (s < best) { best = s; bx = ox; by = oy; } }
  const sx = Number.isFinite(at(bx - 1, by)) && Number.isFinite(at(bx + 1, by)) ? vertex(at(bx - 1, by), best, at(bx + 1, by)) : 0;
  const sy = Number.isFinite(at(bx, by - 1)) && Number.isFinite(at(bx, by + 1)) ? vertex(at(bx, by - 1), best, at(bx, by + 1)) : 0;
  return [bx + sx - margin, by + sy - margin];
}

/** Light smoothing over time ([1 2 1] / 4). Keeps the ends. @param {number[][]} frames */
export function smooth(frames) {
  return frames.map((f, i) => {
    if (i === 0 || i === frames.length - 1) return f;
    return f.map((_, k) => (frames[i - 1][k] + 2 * f[k] + frames[i + 1][k]) / 4);
  });
}

/**
 * Two patches, a left one and a right one, give a shift and a tilt for each frame.
 * `patch` is the patch size and `sep` the distance between the two patch centres, in pixels.
 * Output per frame: [dx, dy, rotation], dx and dy as a fraction of `unit` (the frame width), rotation in radians (clockwise is positive).
 * @param {Array<[[number, number], [number, number]]>} shifts  per frame: [left shift, right shift] in pixels
 * @param {number} sep @param {number} unit
 */
export function toTrack(shifts, sep, unit) {
  const raw = shifts.map(([[lx, ly], [rx, ry]]) => [(lx + rx) / 2 / unit, (ly + ry) / 2 / unit, Math.max(-0.12, Math.min(0.12, Math.atan2(ry - ly, sep)))]);
  return smooth(raw).map((f) => f.map((v) => Math.round(v * 1e5) / 1e5));
}

/**
 * Sample a track at a time. Linear between frames, held at the ends.
 * Same maths the browser uses (examples/showroom/js/rig/clip-body.js has its own copy, tested to match).
 * @param {number[][]} frames @param {number} fps @param {number} t seconds
 * @returns {number[]}
 */
export function sampleTrack(frames, fps, t) {
  const p = Math.max(0, Math.min(frames.length - 1, t * fps));
  const [i, f] = [Math.floor(p), p - Math.floor(p)];
  const [a, b] = [frames[i], frames[Math.min(frames.length - 1, i + 1)]];
  return a.map((v, k) => v + (b[k] - v) * f);
}

const clip01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * One gray mask per frame: 255 keeps the footage, 0 erases it. The erased hole is the head, and it
 * moves with the track, so the sway never uncovers a piece of the old head or leaves a stray collar edge.
 * Geometry matches the browser: the live head is moved by translate(dx, dy) then rotate(r) about the pivot.
 * @param {number[][]} frames  track, [dx, dy, rotation] per frame
 * @param {number} w @param {number} h  mask size in pixels
 * @param {{aspect:number, pivot:[number, number], blank:[number, number], feather:number, seam:[number, number], edge?:number}} g
 *   aspect = frame height / width. pivot = [x, y] as fractions of width and height. blank = erased columns (fraction of width).
 *   feather = soft edge (fraction of width). seam[0] = the row (fraction of height) where the footage is solid again. It fades in over `edge` above it (default 0.004).
 * @returns {Uint8Array}
 */
export function keepMasks(frames, w, h, g) {
  const out = new Uint8Array(frames.length * w * h);
  const [px, pyw] = [g.pivot[0], g.pivot[1] * g.aspect];
  const [bl, br, f] = [g.blank[0], g.blank[1], g.feather];
  const [st, edge] = [g.seam[0], g.edge ?? 0.004];
  frames.forEach(([dx, dy, r], n) => {
    const [c, s] = [Math.cos(r), Math.sin(r)];
    for (let y = 0; y < h; y++) {
      const v = ((y + 0.5) / h) * g.aspect - pyw - dy;
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w - px - dx;
        const lx = c * u + s * v + px;
        const fy = (-s * u + c * v + pyw) / g.aspect;
        const hole = clip01((lx - (bl - f)) / f) * clip01((br + f - lx) / f) * clip01((st - fy) / edge);
        out[n * w * h + y * w + x] = Math.round(255 * (1 - hole));
      }
    }
  });
  return out;
}
