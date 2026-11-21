import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STYLES, parseMarks, pickStyle, speedAt } from '../../examples/showroom/js/rig/motion.js';
import { parseManifest } from '../../examples/showroom/js/rig/clip-body.js';

const marks = { lift: 60, ret: 106, end: 133 };
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

describe('speedAt', () => {
  for (const [name, style] of Object.entries(STYLES)) {
    test(`${name}: leaves fast, slows on arrival, no step at the marks`, () => {
      assert.ok(speedAt(0, marks, style) > speedAt(59, marks, style), 'slows into the arrival');
      for (const k of [marks.lift, marks.ret]) {
        assert.ok(Math.abs(speedAt(k - 0.01, marks, style) - speedAt(k + 0.01, marks, style)) < 0.05, `continuous at ${k}`);
      }
    });
    test(`${name}: every frame plays faster than filmed, and total time is shorter`, () => {
      let seconds = 0;
      for (let k = 0; k < marks.end; k++) { const s = speedAt(k, marks, style); assert.ok(s >= 1 && s <= 3, `speed ${s} at ${k}`); seconds += 1 / s / 24; }
      assert.ok(seconds < 4.2, `${name} takes ${seconds.toFixed(2)}s`);
    });
  }
  test('scale multiplies the speed', () => assert.equal(speedAt(30, marks, STYLES.easy, 1.1), speedAt(30, marks, STYLES.easy) * 1.1));
});

describe('pickStyle', () => {
  test('never repeats the last style', () => {
    for (const last of Object.keys(STYLES)) for (let i = 0; i < 20; i++) assert.notEqual(pickStyle(Math.random, last), last);
  });
  test('follows the random source across all styles', () => {
    const seen = new Set([0.01, 0.5, 0.99].map((r) => pickStyle(() => r)));
    assert.equal(seen.size, Object.keys(STYLES).length);
  });
  test('one style left still returns it', () => assert.equal(pickStyle(seq(0.5), 'a', { a: STYLES.quick, b: STYLES.easy }), 'b'));
});

describe('marks in the manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../examples/showroom/bodies/guide/manifest.json', import.meta.url), 'utf8'));
  test('parseMarks wants lift < ret < end', () => {
    assert.deepEqual(parseMarks(marks), marks);
    for (const bad of [null, {}, { lift: 10, ret: 5, end: 20 }, { lift: 10, ret: 20, end: 20 }]) assert.equal(parseMarks(bad), null);
  });
  test('the shipped body marks the present clip, and the end is one of its exits', () => {
    const m = parseManifest(manifest);
    const joins = JSON.parse(readFileSync(new URL('../../examples/showroom/bodies/guide/joins.json', import.meta.url), 'utf8'));
    assert.ok(m.motion['present-right']);
    assert.ok(joins.clips['present-right'].exits.some(([k]) => k === m.motion['present-right'].end), 'end is an exit frame');
  });
  test('bad marks fail with a clear message', () => {
    assert.throws(() => parseManifest({ ...manifest, motion: { x: { lift: 5, ret: 2, end: 9 } } }), /motion\.x/);
  });
  test('a gesture may list several clips', () => {
    const m = parseManifest({ ...manifest, clips: { ...manifest.clips, present: ['present-right', 'present-right'] } });
    assert.equal(m.clips.present.length, 2);
    assert.throws(() => parseManifest({ ...manifest, clips: { present: [] } }), /clip "present"/);
  });
});
