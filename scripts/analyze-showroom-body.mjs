#!/usr/bin/env node
/**
 * Finds the frames where a gesture clip can join the idle loop without a visible cut, and writes `joins.json`.
 *
 *   node scripts/analyze-showroom-body.mjs <bodyDir> [--max-entry=48] [--max-exit-distance=8]
 *
 * Every frame is reduced to a small grey picture (the colour half of the packed clip). The distance between two
 * frames is the RMS difference of their pixels, on a 0 to 255 scale. About 3 or less is invisible, about 6 is mild,
 * 10 or more shows as a ghost.
 *
 *   entry   per idle frame p: the clip frame k (among the first `max-entry`) that looks most like it, and the distance
 *   exits   clip frames that look like some idle frame: [k, p, distance], local minima only, the last frame always
 *
 * The page uses `entry` to start a gesture when the idle loop reaches the matching pose, and `exits` to hand
 * back to the idle loop at the matching pose. Needs ffmpeg. Run it again after the footage changes.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const [dir] = argv.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')));
if (!dir) { console.error('usage: analyze-showroom-body.mjs <bodyDir> [--max-entry=48] [--max-exit-distance=8]'); process.exit(2); }
const maxEntry = Number(flags['max-entry'] ?? 48);
const maxExitDistance = Number(flags['max-exit-distance'] ?? 8);
const MIN_EXIT = 12; // an exit before this leaves no gesture at all
const W = 72;
const H = 128;
const FPS = 24;

const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const ah = manifest.aspect[1];

/** All frames of a clip as one grey picture each: the top (colour) half, scaled down. @param {string} name */
function frames(name) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(dir, `${name}.mp4`), '-vf', `crop=iw:${ah}:0:0,scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-r', String(FPS), '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) { console.error(`ffmpeg failed on ${name}`); process.exit(1); }
  const n = r.stdout.length / (W * H);
  return Array.from({ length: Math.floor(n) }, (_, i) => Float32Array.from(r.stdout.subarray(i * W * H, (i + 1) * W * H)));
}

/** RMS distance between two pictures. */
function dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s / a.length);
}

const idle = frames(manifest.idle);
const joins = { fps: FPS, idle: idle.length, clips: {} };
const round = (x) => Math.round(x * 10) / 10;
const names = Object.keys(manifest.clips).filter((c) => manifest.clips[c] === c);

for (const name of names) {
  const clip = frames(name);
  const entryK = new Array(idle.length);
  const entryD = new Array(idle.length);
  for (let p = 0; p < idle.length; p++) {
    let bestK = 0;
    let bestD = Infinity;
    for (let k = 0; k < Math.min(maxEntry, clip.length); k++) {
      const d = dist(idle[p], clip[k]);
      if (d < bestD) { bestD = d; bestK = k; }
    }
    entryK[p] = bestK;
    entryD[p] = round(bestD);
  }
  const best = clip.map((f) => {
    let bestP = 0;
    let bestD = Infinity;
    for (let p = 0; p < idle.length; p++) {
      const d = dist(f, idle[p]);
      if (d < bestD) { bestD = d; bestP = p; }
    }
    return [bestP, bestD];
  });
  const last = clip.length - 1;
  const exits = [];
  for (let k = MIN_EXIT; k <= last; k++) {
    const d = best[k][1];
    const isMin = best.slice(Math.max(0, k - 4), k + 5).every(([, o]) => o >= d);
    if (k === last || (d <= maxExitDistance && isMin)) exits.push([k, best[k][0], round(d)]);
  }
  joins.clips[name] = { frames: clip.length, entry: { k: entryK, d: entryD }, exits };
  const ds = entryD.slice().sort((a, b) => a - b);
  console.log(`${name}: ${clip.length} frames, entry median ${ds[ds.length >> 1]}, ${exits.length} exits, last-frame distance ${round(best[last][1])}`);
}

writeFileSync(path.join(dir, 'joins.json'), `${JSON.stringify(joins)}\n`);
if (manifest.joins !== 'joins.json') {
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ ...manifest, joins: 'joins.json' }, null, 2)}\n`);
}
console.log(`wrote ${path.join(dir, 'joins.json')}`);
