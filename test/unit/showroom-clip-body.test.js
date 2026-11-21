// Showroom example: video-clip body manifest. Pure, no DOM.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseJoins } from '../../examples/showroom/js/rig/joins.js';
import { parseManifest, parseTrack, sampleTrack, clipFor, createCompositor } from '../../examples/showroom/js/rig/clip-body.js';

const good = { aspect: [600, 1000], packed: true, head: { left: 0.3, top: 0.15, width: 0.4, height: 0.2 }, seam: [0.28, 0.32], matte: 'head-matte.png', still: 'head.jpg', idle: 'idle', clips: { wave: 'wave', 'present-up': 'pu' } };

describe('clip body manifest', () => {
  test('accepts a valid manifest', () => {
    const m = parseManifest(good);
    assert.deepEqual(m.aspect, [600, 1000]);
    assert.equal(m.idle, 'idle');
    assert.deepEqual(m.seam, [0.28, 0.32]);
    assert.equal(m.still, 'head.jpg');
  });
  test('tracked is off unless the manifest says true', () => {
    assert.equal(parseManifest(good).tracked, false);
    assert.equal(parseManifest({ ...good, tracked: true }).tracked, true);
  });
  test('fit defaults to no change and is checked', () => {
    assert.deepEqual(parseManifest(good).fit, { scale: 1, dx: 0, dy: 0 });
    assert.deepEqual(parseManifest({ ...good, fit: { scale: 0.9 } }).fit, { scale: 0.9, dx: 0, dy: 0 });
    for (const fit of [{ scale: 0.4 }, { scale: 1.6 }, { scale: 'big' }, { dx: 0.2 }, { dy: -0.2 }, { dx: 'left' }]) assert.throws(() => parseManifest({ ...good, fit }), /fit\./);
  });
  test('mirror is optional and off by default', () => {
    assert.equal(parseManifest(good).mirror, false);
    assert.equal(parseManifest({ ...good, mirror: true }).mirror, true);
  });

  test('floor is optional and checked', () => {
    assert.equal(parseManifest(good).floor, null);
    assert.deepEqual(parseManifest({ ...good, floor: { y: 0.94, width: 0.2 } }).floor, { y: 0.94, width: 0.2 });
    for (const floor of [{}, { y: 0.9 }, { y: 0, width: 0.2 }, { y: 0.9, width: 1.2 }, null, 'low']) assert.throws(() => parseManifest({ ...good, floor }), /floor/);
  });
  test('joins is optional and must be a file name', () => {
    assert.equal(parseManifest(good).joins, null);
    assert.equal(parseManifest({ ...good, joins: 'joins.json' }).joins, 'joins.json');
    for (const joins of ['', 7, {}]) assert.throws(() => parseManifest({ ...good, joins }), /joins/);
  });
  test('still is optional, seam and matte are not', () => {
    assert.equal(parseManifest({ ...good, still: undefined }).still, null);
    assert.equal(parseManifest(good).matte, 'head-matte.png');
    assert.throws(() => parseManifest({ ...good, seam: undefined }), /seam/);
    for (const matte of [undefined, '', 7]) assert.throws(() => parseManifest({ ...good, matte }), /matte/);
  });
  test('rejects each bad field with a message that names it', () => {
    const bad = (patch, re) => assert.throws(() => parseManifest({ ...good, ...patch }), re);
    bad({ aspect: [0, 10] }, /aspect/);
    bad({ aspect: 'wide' }, /aspect/);
    bad({ head: { ...good.head, left: 0.8 } }, /head.*fit/);
    bad({ head: { ...good.head, top: -0.1 } }, /head\.top/);
    bad({ seam: [0.1, 0.3] }, /seam/);
    bad({ seam: [0.32, 0.28] }, /seam/);
    bad({ seam: [0.3, 0.4] }, /seam/);
    bad({ seam: 'low' }, /seam/);
    bad({ still: 7 }, /still/);
    bad({ packed: undefined }, /packed/);
    bad({ idle: '' }, /idle/);
    bad({ clips: { wave: 3 } }, /wave/);
    assert.throws(() => parseManifest(null), /not an object/);
  });
  test('a body with no gesture clips is valid', () => {
    assert.deepEqual(parseManifest({ ...good, clips: undefined }).clips, {});
  });
  test('clipFor prefers the direction, then the plain name', () => {
    const { clips } = parseManifest(good);
    assert.equal(clipFor(clips, 'present', 'up'), 'pu');
    assert.equal(clipFor(clips, 'wave', 'down'), 'wave');
    assert.equal(clipFor(clips, 'shrug', 'right'), null);
  });
});

describe('neck track', () => {
  const track = { fps: 10, frames: [[0, 0, 0], [0.1, 0.2, 0.4], [0.2, 0, 0]] };
  test('sampleTrack is linear between frames and held at the ends', () => {
    assert.deepEqual(sampleTrack(track, 0), [0, 0, 0]);
    const mid = sampleTrack(track, 0.05);
    assert.ok(Math.abs(mid[0] - 0.05) < 1e-9 && Math.abs(mid[1] - 0.1) < 1e-9 && Math.abs(mid[2] - 0.2) < 1e-9);
    assert.deepEqual(sampleTrack(track, 9), [0.2, 0, 0]);
    assert.deepEqual(sampleTrack(track, -1), [0, 0, 0]);
  });
  test('parseTrack accepts a good file and rejects a bad one', () => {
    assert.deepEqual(parseTrack(track), track);
    for (const bad of [null, {}, { fps: 0, frames: track.frames }, { fps: 10, frames: [] }, { fps: 10, frames: [[0, 0]] }, { fps: 10, frames: [[0, 0, NaN]] }]) assert.equal(parseTrack(bad), null);
  });
});

describe('body shipped with the example', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../examples/showroom/bodies/guide/manifest.json', import.meta.url), 'utf8'));
  test('manifest is valid, packed and tracked', () => {
    const m = parseManifest(manifest);
    assert.equal(m.tracked, true);
    assert.ok(m.fit.scale >= 0.5 && m.fit.scale <= 1.5, 'fit is valid');
    assert.ok(m.floor, 'floor is set');
  });
  test('every clip ships a track with one entry per frame pair', () => {
    const { idle, clips } = parseManifest(manifest);
    for (const name of new Set([idle, ...Object.values(clips)])) {
      const file = new URL(`../../examples/showroom/bodies/guide/${name}.track.json`, import.meta.url);
      assert.ok(existsSync(file), `${name}.track.json`);
      assert.ok(parseTrack(JSON.parse(readFileSync(file, 'utf8'))), `${name} track is valid`);
    }
  });
  test('every arm gesture the app can ask for has a clip', () => {
    const { clips } = parseManifest(manifest);
    for (const name of ['wave', 'present', 'beat', 'beat2', 'celebrate', 'shrug']) assert.ok(clipFor(clips, name, 'right'), name);
    for (const dir of ['up', 'down']) assert.ok(clipFor(clips, 'present', dir), `present ${dir} falls back to the plain clip`);
  });
  test('the head area has a seam, plus a still and a matte that ship with the body', () => {
    const { seam, still, matte } = parseManifest(manifest);
    assert.ok(seam, 'seam');
    for (const [what, file] of [['still', still], ['matte', matte]]) assert.ok(file && existsSync(new URL(`../../examples/showroom/bodies/guide/${file}`, import.meta.url)), `${what} file`);
  });
  test('joins ship with the body and cover every gesture clip', () => {
    const m = parseManifest(manifest);
    assert.equal(m.joins, 'joins.json');
    const joins = parseJoins(JSON.parse(readFileSync(new URL('../../examples/showroom/bodies/guide/joins.json', import.meta.url), 'utf8')));
    assert.ok(joins, 'joins.json is valid');
    for (const clip of new Set(Object.values(m.clips))) assert.ok(joins.clips[clip], `${clip} has joins`);
    for (const [clip, c] of Object.entries(joins.clips)) assert.equal(c.exits.at(-1)[0], c.frames - 1, `${clip} always has its last frame as an exit`);
  });
  test('every gesture can join and leave the idle loop close to invisibly', () => {
    const joins = parseJoins(JSON.parse(readFileSync(new URL('../../examples/showroom/bodies/guide/joins.json', import.meta.url), 'utf8')));
    for (const [clip, c] of Object.entries(joins.clips)) {
      assert.ok(Math.min(...c.entry.d) <= 4, `${clip}: some idle pose matches a start frame (distance 4 or less)`);
      assert.ok(c.exits.at(-1)[2] <= 6, `${clip}: the last frame matches an idle pose (distance 6 or less)`);
      assert.ok(c.exits.filter(([, , d]) => d <= 5).length >= 2, `${clip}: at least two good exits`);
    }
  });
  test('every named clip ships as WebM and MP4', () => {
    const { idle, clips } = parseManifest(manifest);
    for (const name of new Set([idle, ...Object.values(clips)])) {
      for (const ext of ['webm', 'mp4']) assert.ok(existsSync(new URL(`../../examples/showroom/bodies/guide/${name}.${ext}`, import.meta.url)), `${name}.${ext}`);
    }
  });
});

describe('compositor', () => {
  // A stand-in WebGL context: constants are their own names, every call is recorded.
  const fake = () => {
    const calls = [];
    const gl = new Proxy({}, { get: (_t, k) => (typeof k === 'string' && k === k.toUpperCase() ? k : (...a) => { calls.push([k, ...a]); return k.startsWith('get') && k.endsWith('Parameter') ? true : {}; }) });
    return { calls, canvas: { getContext: () => gl, width: 0, height: 0 } };
  };
  const clip = (extra = {}) => ({ readyState: 4, videoWidth: 10, videoHeight: 20, currentTime: 0, ...extra });

  test('layers add, so a crossfade never lets the scene show through', () => {
    const { calls, canvas } = fake();
    createCompositor(canvas);
    assert.deepEqual(calls.find((c) => c[0] === 'blendFunc').slice(1), ['ONE', 'ONE']);
  });
  test('a frame is uploaded when its media time changes, not when currentTime moves', () => {
    const { calls, canvas } = fake();
    const gpu = createCompositor(canvas);
    const v = clip();
    const uploads = () => calls.filter((c) => c[0] === 'texImage2D').length;
    gpu.draw([{ video: v, alpha: 1, time: 0.5 }]);
    v.currentTime = 0.9;
    gpu.draw([{ video: v, alpha: 1, time: 0.5 }]);
    assert.equal(uploads(), 1, 'same frame, no upload');
    gpu.draw([{ video: v, alpha: 1, time: 0.54 }]);
    assert.equal(uploads(), 2, 'new frame, one upload');
  });
  test('a lost GPU context blanks nothing for good: drawing waits, then restarts when the context returns', () => {
    const { calls, canvas } = fake();
    const on = {};
    canvas.addEventListener = (name, fn) => { on[name] = fn; };
    const gpu = createCompositor(canvas);
    const v = clip();
    gpu.draw([{ video: v, alpha: 1, time: 0.1 }]);
    const drawsBefore = calls.filter((c) => c[0] === 'drawArrays').length;
    let prevented = false;
    on.webglcontextlost({ preventDefault: () => { prevented = true; } });
    assert.ok(prevented, 'the browser is told we want the context back');
    gpu.draw([{ video: v, alpha: 1, time: 0.2 }]);
    assert.equal(calls.filter((c) => c[0] === 'drawArrays').length, drawsBefore, 'no GPU calls while lost');
    on.webglcontextrestored();
    gpu.draw([{ video: v, alpha: 1, time: 0.2 }]);
    assert.equal(calls.filter((c) => c[0] === 'drawArrays').length, drawsBefore + 1, 'redrawn with fresh textures');
    assert.equal(calls.filter((c) => c[0] === 'linkProgram').length, 2, 'the program is rebuilt');
  });
});
