// Showroom example: neck tracking used by scripts/build-showroom-body.mjs. Pure functions on gray images.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, toTrack, smooth, keepMasks, sampleTrack } from '../../scripts/lib/body-track.mjs';

/** A smooth blob image, shifted by (sx, sy) pixels. */
function blob(w, h, sx, sy) {
  const img = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img[y * w + x] = Math.round(255 * Math.exp(-(((x - sx - w / 2) ** 2) + ((y - sy - h / 2) ** 2)) / 60) * (1 + 0.3 * Math.sin((x - sx) / 5)) / 1.3);
  return img;
}
/** Crop a window from an image. */
function crop(img, w, x0, y0, cw, ch) {
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = img[(y0 + y) * w + x0 + x];
  return out;
}

describe('locate', () => {
  const [W, H, M, TW, TH] = [96, 80, 16, 64, 48];
  const tpl = crop(blob(W, H, 0, 0), W, M, M, TW, TH);
  test('finds a whole-pixel shift', () => {
    const [dx, dy] = locate(tpl, TW, TH, blob(W, H, 5, -3), W, H, M);
    assert.ok(Math.abs(dx - 5) < 0.6 && Math.abs(dy + 3) < 0.6, `${dx}, ${dy}`);
  });
  test('reports no shift for the same image', () => {
    const [dx, dy] = locate(tpl, TW, TH, blob(W, H, 0, 0), W, H, M);
    assert.ok(Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1);
  });
});

describe('track maths', () => {
  test('toTrack averages the two patches and turns their height gap into a tilt', () => {
    const [f] = toTrack([[[10, 2], [10, 2]]], 100, 1000);
    assert.deepEqual(f, [0.01, 0.002, 0]);
    const [g] = toTrack([[[0, 0], [0, 10]]], 100, 1000);
    assert.ok(g[2] > 0.09 && g[2] < 0.11, 'right side lower = clockwise');
  });
  test('smooth keeps the ends and softens a spike', () => {
    const out = smooth([[0], [4], [0]]);
    assert.deepEqual(out, [[0], [2], [0]]);
  });
  test('sampleTrack matches the browser maths at a half frame', () => {
    assert.deepEqual(sampleTrack([[0, 0, 0], [2, 4, 6]], 10, 0.05), [1, 2, 3]);
  });
});

describe('keepMasks', () => {
  const g = { aspect: 2, pivot: [0.5, 0.25], blank: [0.3, 0.7], feather: 0.02, seam: [0.2, 0.3] };
  const at = (m, w, x, y) => m[y * w + x];
  test('erases the head hole and keeps the body and the sides', () => {
    const [w, h] = [50, 100];
    const m = keepMasks([[0, 0, 0]], w, h, g);
    assert.equal(at(m, w, 25, 10), 0, 'inside the hole');
    assert.equal(at(m, w, 25, 90), 255, 'below the seam');
    assert.equal(at(m, w, 2, 10), 255, 'outside the blank columns');
  });
  test('the footage is solid from the seam row, with a short fade above it', () => {
    const [w, h] = [50, 1000];
    const m = keepMasks([[0, 0, 0]], w, h, g); // seam row 0.2 of the height = row 400 here (aspect 2 only scales the width)
    const col = (y) => at(m, w, 25, y);
    assert.equal(col(Math.floor(0.2 * h) + 2), 255, 'solid at the seam row');
    assert.equal(col(Math.floor(0.2 * h) - Math.ceil(0.004 * h) - 2), 0, 'erased above the fade');
    const mid = col(Math.floor(0.2 * h) - 2);
    assert.ok(mid > 0 && mid < 255, 'part way in the fade');
  });
  test('the hole moves with the track', () => {
    const [w, h] = [50, 100];
    const m = keepMasks([[0.2, 0, 0]], w, h, g); // moved right by 10 px
    assert.equal(at(m, w, 17, 10), 255, 'old left edge is now kept');
    assert.equal(at(m, w, 40, 10), 0, 'new right part is erased');
  });
});
