#!/usr/bin/env node
/**
 * Turn green-screen footage into a showroom clip body (see examples/showroom/js/rig/clip-body.js).
 *
 *   node scripts/build-showroom-body.mjs <rawDir> <outDir> [--head=left,top,width,height] [--seam=top,bottom] [--blank=left,right] [--still=<image>] [--matte=<mask>] [--fit=scale,dx,dy] [--floor=y,width] [--mirror] [--width=720] [--crf-vp9=30] [--crf-h264=21]
 *
 * <rawDir> holds `idle.mp4` plus one mp4 per gesture (`wave.mp4`, `present-right.mp4`, `beat.mp4`, ...).
 * Each file is keyed and encoded as VP9 WebM and H.264 MP4, with the matte packed under the picture:
 * the top half is the colour (green removed from the edges), the bottom half is the alpha as gray.
 * The page draws them together on a canvas, so edges are smooth and dark clothes stay dark. A manifest.json is written.
 *   - idle: played forward then backward, so the loop has no jump.
 *   - gestures: trimmed to the moving part, found by comparing each frame with the resting pose at the end.
 *   - track: the collar is followed on every frame, and `<clip>.track.json` holds [dx, dy, rotation] per frame.
 *     The page moves the live head with it. The erased head hole moves with it too.
 * Needs ffmpeg and ffprobe on PATH.
 *
 * The footage head is erased, because the live avatar video draws the head. All numbers are fractions of the frame.
 *   --head   where the live video goes (a square patch that holds the head, neck and collar tips)
 *   --seam   top,bottom rows (fractions of the frame height). The footage is solid from `top` (it fades in over the 0.4% above). The live head fades out over the first half of that band, across the neck and collar
 *   --blank  the columns of the erased head (a little wider than the hair). Raised hands outside them stay
 *   --fit    size and place the live head on the footage body: scale about the neck, then dx and dy as fractions of the frame width.
 *            Match the neck width and the face width of the footage head, for example `0.86,0.0056,-0.0056`. Default `1,0,0`
 *   --floor  where the soles are (fraction of the frame height) and how wide the feet stand (fraction of the frame width), for example `0.943,0.2`. Draws a contact shadow. Default: none
 *   --mirror show the whole figure as a mirror image on screen (adds `"mirror": true`). Use it when the footage gestures away from the scene panel, which sits to her right
 *   --still  the live avatar's first frame (same crop as the live video). Shown until a session is live
 *   --matte  a gray image the size of the still: white where the head is, black elsewhere (any background remover makes one). Cuts the live video out of its backdrop
 *
 * The last step runs `analyze-showroom-body.mjs`, which writes `joins.json` (where each gesture joins the idle loop).
 *
 * The key is "green dominance", not a flat colour key. It removes green by how far the green channel
 * is above red and blue, and despills the edge. A flat colour key also eats teal shirts and dark trousers.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { keepMasks, locate, toTrack } from './lib/body-track.mjs';

const [rawDir, outDir, ...flags] = process.argv.slice(2);
if (!rawDir || !outDir) {
  console.error('usage: build-showroom-body.mjs <rawDir> <outDir> [--head=l,t,w,h] [--seam=top,bottom] [--blank=left,right] [--still=<image>] [--matte=<mask>] [--fit=scale,dx,dy] [--floor=y,width] [--width=720] [--crf-vp9=30] [--crf-h264=21]');
  process.exit(2);
}
const flag = (name, fallback) => (flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback);
const nums = (v) => v.split(',').map(Number);
const [hl, ht, hw, hh] = nums(flag('head', '0.347,0.0918,0.299,0.168'));
const [seamTop, seamBottom] = nums(flag('seam', '0.239,0.2561'));
const [blankLeft, blankRight] = nums(flag('blank', '0.3639,0.705'));
const stillFile = flag('still', '');
const matteFile = flag('matte', '');
const [fitScale, fitDx, fitDy] = nums(flag('fit', '1,0,0'));
const mirror = flags.includes('--mirror');
// Seconds of a clip that hold its movement, e.g. beat:2.6-4.8,shrug:0.3-4.5. Only that part plays.
const floorFlag = flag('floor', '');
const floor = floorFlag ? (([y, width]) => ({ y, width }))(nums(floorFlag)) : null;
const FEATHER = 0.02; // soft edge of the erased columns, as a fraction of the frame width
const WIDTH = Number(flag('width', '720')); // output frame width
const CRF_VP9 = Number(flag('crf-vp9', '30'));
const CRF_H264 = Number(flag('crf-h264', '21'));
const FPS = 24;
const PAD = 0.25; // seconds kept before and after the moving part

// Warm pixels (skin) lose green above 60% of the way from blue to red, which removes the olive tint at their edges. Other pixels lose green above max(red, blue).
// Alpha: green above max(red, blue) by 28 or less stays; by 83 or more is removed; in between fades.
const GD = 'clip(1-(g(X,Y)-max(r(X,Y),b(X,Y))-28)/55,0,1)';
/** The picture with the matte packed under it: colour on top (green spill removed), alpha as gray below. Input label [0:v], output label [p0]. */
const PACK = `[0:v]format=rgb24,split[s1][s2];`
  + `[s1]geq=r='r(X,Y)':g='if(gt(r(X,Y),b(X,Y)),min(g(X,Y),b(X,Y)+0.6*(r(X,Y)-b(X,Y))),min(g(X,Y),max(r(X,Y),b(X,Y))))':b='b(X,Y)'[c];`
  + `[s2]geq=r='255*${GD}':g='255*${GD}':b='255*${GD}'[a];`
  + `[c][a]vstack[p0]`;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 29, ...opts });
const probe = (file) => JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file]).toString()).streams[0];

/** First and last second of the moving part, below the head (the live video draws the head). */
function movingSpan(file) {
  const [w, h] = [48, 86];
  const raw = run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-']);
  const n = Math.floor(raw.length / (w * h));
  const y0 = Math.floor(h * 0.22) * w;
  const body = (i) => raw.subarray(i * w * h + y0, (i + 1) * w * h);
  // A frame is "moving" when it differs from both the opening pose and the closing pose.
  const mean = (from, to) => { const m = new Float64Array(w * h - y0); for (let i = from; i < to; i++) body(i).forEach((v, k) => { m[k] += v / (to - from); }); return m; };
  const [open, close] = [mean(0, 6), mean(n - 12, n)];
  const dist = (i, ref) => body(i).reduce((s, v, k) => s + Math.abs(v - ref[k]), 0) / ref.length;
  const diff = Array.from({ length: n }, (_, i) => Math.min(dist(i, open), dist(i, close)));
  const thr = Math.max(1.5, 0.3 * Math.max(...diff));
  const active = diff.map((d, i) => (d > thr ? i : -1)).filter((i) => i >= 0);
  if (!active.length) return null;
  return { start: Math.max(0, active[0] / FPS - PAD), end: Math.min(n / FPS, (active.at(-1) + 1) / FPS + PAD) };
}

/** `-ss/-to/-i` for a file, or just `-i` when the whole clip is used. */
const inputArgs = (file, span) => (span ? ['-ss', span.start.toFixed(3), '-to', span.end.toFixed(3), '-i', file] : ['-i', file]);

// Collar patches: two small squares of collar and shoulder, side by side, centred on the seam.
// Their shift from the first idle frame is the neck's motion.
const fourth = (v) => Math.max(4, Math.round(v / 4) * 4);
function patchGeometry(iw, ih) {
  const [pw, ph, m] = [fourth(0.14 * iw), fourth(0.075 * ih), fourth(0.09 * iw)];
  const x0 = Math.round((hl + hw / 2) * iw) - pw;
  const y0 = Math.round(seamBottom * ih - ph / 2);
  return { pw, ph, m, rx: x0 - m, ry: y0 - m, rw: 2 * pw + 2 * m, rh: ph + 2 * m };
}
/** Gray frames of the patch region, same time range and rate as the encode. */
function grayRegion(file, span, geo, firstOnly = false) {
  const raw = run('ffmpeg', ['-v', 'error', ...inputArgs(file, span), '-an', '-vf', `crop=${geo.rw}:${geo.rh}:${geo.rx}:${geo.ry},format=gray`, '-r', String(FPS), ...(firstOnly ? ['-frames:v', '1'] : []), '-f', 'rawvideo', '-']);
  const size = geo.rw * geo.rh;
  return Array.from({ length: Math.floor(raw.length / size) }, (_, i) => raw.subarray(i * size, (i + 1) * size));
}
const sub = (img, stride, x, y, w, h) => { const o = new Uint8Array(w * h); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) o[j * w + i] = img[(y + j) * stride + x + i]; return o; };

mkdirSync(outDir, { recursive: true });
const files = readdirSync(rawDir).filter((f) => f.endsWith('.mp4')).sort();
if (!files.includes('idle.mp4')) { console.error('rawDir needs idle.mp4'); process.exit(2); }

const { width: iw, height: ih } = probe(path.join(rawDir, 'idle.mp4'));
const height = Math.round((WIDTH * ih) / iw / 2) * 2;
const scale = `scale=${WIDTH}:${2 * height}:flags=lanczos,format=yuv420p`;

const geo = patchGeometry(iw, ih);
const refFrame = grayRegion(path.join(rawDir, 'idle.mp4'), null, geo, true)[0];
const templates = [0, 1].map((k) => sub(refFrame, geo.rw, geo.m + k * geo.pw, geo.m, geo.pw, geo.ph));
const hayW = geo.pw + 2 * geo.m;
/** Per frame [dx, dy, rotation] of the collar against the first idle frame. */
function trackClip(src, span) {
  const shifts = grayRegion(src, span, geo).map((f) => [0, 1].map((k) => locate(templates[k], geo.pw, geo.ph, sub(f, geo.rw, k * geo.pw, 0, hayW, geo.rh), hayW, geo.rh, geo.m)));
  return toTrack(shifts, geo.pw, iw);
}
const tmp = mkdtempSync(path.join(tmpdir(), 'showroom-body-'));
const [maskW, maskH] = [Math.round(iw / 4) * 2, Math.round(ih / 4) * 2];
const clips = {};
/** Put a white block over each erase mask, so the colour half passes through the multiply unchanged. @param {Uint8Array} masks */
function packedMasks(masks) {
  const size = maskW * maskH;
  const out = Buffer.alloc(masks.length * 2, 255);
  for (let n = 0; n < masks.length / size; n++) out.set(masks.subarray(n * size, (n + 1) * size), n * size * 2 + size);
  return out;
}

for (const f of files) {
  const name = f.replace(/\.mp4$/, '');
  const src = path.join(rawDir, f);
  const isIdle = name === 'idle';
  const span = isIdle ? null : movingSpan(src);
  if (!isIdle && !span) { console.log(`skip ${name}: no motion found`); continue; }
  const forward = trackClip(src, span);
  const frames = isIdle ? [...forward, ...[...forward].reverse()] : forward;
  writeFileSync(path.join(outDir, `${name}.track.json`), `${JSON.stringify({ fps: FPS, frames })}\n`);
  const maskFile = path.join(tmp, `${name}.gray`);
  writeFileSync(maskFile, packedMasks(keepMasks(frames, maskW, maskH, { aspect: ih / iw, pivot: [hl + hw / 2, seamBottom], blank: [blankLeft, blankRight], feather: FEATHER, seam: [seamTop, seamBottom] })));
  // The packed mask is white over the colour half (no change) and the erase mask over the matte half.
  const mask = `[1:v]scale=${iw}:${2 * ih}:flags=bilinear,format=gbrp[m]`;
  const stage = isIdle ? '[p0]split[x][y];[y]reverse[r];[x][r]concat=n=2:v=1:a=0[p]' : '[p0]copy[p]';
  const graph = `${PACK};${stage};${mask};[p][m]blend=all_mode=multiply:shortest=1,${scale}`;
  const base = ['-v', 'error', '-y', ...inputArgs(src, span), '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${maskW}x${2 * maskH}`, '-r', String(FPS), '-i', maskFile, '-an', '-filter_complex', graph, '-r', String(FPS)];
  run('ffmpeg', [...base, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(CRF_VP9), '-row-mt', '1', path.join(outDir, `${name}.webm`)]);
  run('ffmpeg', [...base, '-c:v', 'libx264', '-crf', String(CRF_H264), '-preset', 'slow', '-profile:v', 'main', '-movflags', '+faststart', path.join(outDir, `${name}.mp4`)]);
  if (!isIdle) clips[name] = name;
  console.log(`ok ${name}${span ? ` ${span.start.toFixed(2)}-${span.end.toFixed(2)}s` : ' (ping-pong loop)'}`);
}
if (clips['present-right'] && !clips.present) clips.present = 'present-right';

if (matteFile) {
  // White, with the mask as its alpha. Shrunk a pixel and softened, so no black from the backdrop rings the hair.
  run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=white:s=512x512', '-i', matteFile, '-filter_complex', '[1:v]scale=512:512,format=gray,erosion,gblur=sigma=2[m];[0:v]format=rgb24[w];[w][m]alphamerge', '-frames:v', '1', path.join(outDir, 'head-matte.png')]);
}
if (stillFile) run('ffmpeg', ['-v', 'error', '-y', '-i', stillFile, '-vf', 'scale=512:512:flags=lanczos', '-q:v', '3', path.join(outDir, 'head.jpg')]);
const manifest = { aspect: [WIDTH, height], packed: true, ...(mirror ? { mirror } : {}), fit: { scale: fitScale, dx: fitDx, dy: fitDy }, ...(floor ? { floor } : {}), head: { left: hl, top: ht, width: hw, height: hh }, seam: [seamTop, seamBottom], ...(stillFile ? { still: 'head.jpg' } : {}), ...(matteFile ? { matte: 'head-matte.png' } : {}), idle: 'idle', tracked: true, joins: 'joins.json', clips };
writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
rmSync(tmp, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(import.meta.dirname, 'analyze-showroom-body.mjs'), outDir], { stdio: 'inherit' });
console.log(`wrote ${path.join(outDir, 'manifest.json')}`);
