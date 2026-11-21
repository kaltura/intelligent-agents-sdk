// Showroom body build script: a tiny synthetic clip goes in, a valid body folder comes out. Needs ffmpeg, skipped without it.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseManifest } from '../../examples/showroom/js/rig/clip-body.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const script = new URL('../../scripts/build-showroom-body.mjs', import.meta.url).pathname;

describe('build-showroom-body', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  let dir; let out;
  const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'showroom-build-test-'));
    out = path.join(dir, 'body');
    for (const [name, seed] of [['idle', 1], ['wave', 9]]) ff('-f', 'lavfi', '-i', `testsrc2=s=270x480:r=24:d=1,hue=h=${seed * 20}`, '-pix_fmt', 'yuv420p', path.join(dir, `${name}.mp4`));
    ff('-f', 'lavfi', '-i', 'color=c=black:s=64x64,drawbox=x=12:y=6:w=40:h=52:c=white:t=fill', '-frames:v', '1', path.join(dir, 'mask.png'));
    ff('-f', 'lavfi', '-i', 'testsrc2=s=64x64', '-frames:v', '1', path.join(dir, 'still.jpg'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('writes both formats, tracks, a matte with alpha, and a manifest the page accepts', () => {
    execFileSync('node', [script, dir, out, '--width=90', `--still=${path.join(dir, 'still.jpg')}`, `--matte=${path.join(dir, 'mask.png')}`, '--fit=0.9,0.01,-0.01', '--floor=0.94,0.2', '--crf-vp9=50', '--crf-h264=35'], { stdio: 'pipe' });
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    const m = parseManifest(manifest);
    assert.equal(m.matte, 'head-matte.png');
    assert.deepEqual(m.fit, { scale: 0.9, dx: 0.01, dy: -0.01 });
    assert.deepEqual(m.floor, { y: 0.94, width: 0.2 });
    for (const file of ['idle.webm', 'idle.mp4', 'idle.track.json', 'head.jpg', 'head-matte.png']) assert.ok(existsSync(path.join(out, file)), file);
    const fmt = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', path.join(out, 'head-matte.png')]).toString().trim();
    assert.match(fmt, /a/, 'matte keeps an alpha channel');
  });

  test('refuses a folder with no idle clip', () => {
    const empty = mkdtempSync(path.join(dir, 'empty-'));
    const r = spawnSync('node', [script, empty, path.join(dir, 'x')]);
    assert.equal(r.status, 2);
  });
});
