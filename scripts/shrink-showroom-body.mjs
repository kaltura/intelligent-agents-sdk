#!/usr/bin/env node
/**
 * Makes a smaller copy of a showroom body, for phones.
 *
 *   node scripts/shrink-showroom-body.mjs <bodyDir> <outDir> [--width=720] [--crf-vp9=34] [--crf-h264=25]
 *
 * Scales every packed clip to the new width, copies the tracks, the still and the matte
 * (all fractions of the frame, so they still fit), and writes a manifest with the new aspect.
 * The page loads `<name>-lite` on narrow screens when that folder exists. Needs ffmpeg.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const [src, out] = argv.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')));
if (!src || !out) { console.error('usage: shrink-showroom-body.mjs <bodyDir> <outDir> [--width=720] [--crf-vp9=34] [--crf-h264=25]'); process.exit(2); }
const width = Number(flags.width ?? 720);
const crfVp9 = String(flags['crf-vp9'] ?? 34);
const crfH264 = String(flags['crf-h264'] ?? 25);
if (!(width >= 240 && width % 2 === 0)) { console.error('--width must be an even number of at least 240'); process.exit(2); }

const manifest = JSON.parse(readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const [aw, ah] = manifest.aspect;
const height = Math.round((ah * width) / aw / 2) * 2;
mkdirSync(out, { recursive: true });

const run = (args) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' }); if (r.status !== 0) { console.error('ffmpeg failed'); process.exit(1); } };
for (const file of readdirSync(src)) {
  const from = path.join(src, file);
  const to = path.join(out, file);
  if (file.endsWith('.webm')) run(['-i', from, '-vf', `scale=${width}:-2:flags=lanczos`, '-an', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', crfVp9, '-row-mt', '1', to]);
  else if (file.endsWith('.mp4')) run(['-i', from, '-vf', `scale=${width}:-2:flags=lanczos`, '-an', '-c:v', 'libx264', '-crf', crfH264, '-preset', 'slow', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', to]);
  else if (file !== 'manifest.json') copyFileSync(from, to);
}
writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify({ ...manifest, aspect: [width, height] }, null, 2)}\n`);
console.log(`Wrote ${out} at ${width}x${height}`);
