// Showroom body shrink script: a tiny synthetic body goes in, a smaller copy with the same file set comes out. Needs ffmpeg, skipped without it.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const script = new URL('../../scripts/shrink-showroom-body.mjs', import.meta.url).pathname;

describe('shrink-showroom-body', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  let dir; let src; let out;
  const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  const size = (file) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'showroom-shrink-test-'));
    src = path.join(dir, 'body');
    out = path.join(dir, 'body-lite');
    execFileSync('mkdir', [src]);
    ff('-f', 'lavfi', '-i', 'testsrc2=s=360x1440:r=12:d=1', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '40', path.join(src, 'idle.webm'));
    ff('-f', 'lavfi', '-i', 'testsrc2=s=360x1440:r=12:d=1', '-pix_fmt', 'yuv420p', path.join(src, 'idle.mp4'));
    writeFileSync(path.join(src, 'idle.track.json'), '{"fps":12,"frames":[[0,0,0]]}');
    writeFileSync(path.join(src, 'manifest.json'), JSON.stringify({ aspect: [360, 720], packed: true, idle: 'idle', clips: {} }));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('scales both formats, copies the rest, and writes the new aspect', () => {
    execFileSync('node', [script, src, out, '--width=240', '--crf-vp9=50', '--crf-h264=35'], { stdio: 'pipe' });
    assert.equal(size(path.join(out, 'idle.webm')), '240,960');
    assert.equal(size(path.join(out, 'idle.mp4')), '240,960');
    assert.ok(existsSync(path.join(out, 'idle.track.json')));
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.aspect, [240, 480]);
    assert.equal(manifest.idle, 'idle');
  });

  test('refuses missing arguments and an odd width', () => {
    assert.equal(spawnSync('node', [script]).status, 2);
    assert.equal(spawnSync('node', [script, src, path.join(dir, 'x'), '--width=241']).status, 2);
  });
});
