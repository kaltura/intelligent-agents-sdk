// Showroom example: spring and gesture engine. Pure, no DOM.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpring } from '../../examples/showroom/js/rig/spring.js';
import { REST, HEAD_ONLY, gesture, createSequencer } from '../../examples/showroom/js/rig/gestures.js';

describe('spring', () => {
  test('settles on its target', () => {
    const sp = createSpring(0);
    sp.target = 100;
    for (let i = 0; i < 300; i++) sp.step(1 / 60);
    assert.ok(Math.abs(sp.value - 100) < 0.05);
    assert.equal(sp.settled, true);
  });
  test('frame rate does not change the result', () => {
    const run = (fps) => { const sp = createSpring(0); sp.target = 50; for (let i = 0; i < fps; i++) sp.step(1 / fps); return sp.value; };
    assert.ok(Math.abs(run(30) - run(144)) < 0.5);
  });
  test('a long pause is capped and stays finite', () => {
    const sp = createSpring(0);
    sp.target = 1e6;
    sp.step(60);
    assert.ok(Number.isFinite(sp.value));
  });
  test('snap jumps without motion', () => {
    const sp = createSpring(0);
    sp.snap(9);
    assert.equal(sp.value, 9);
    assert.equal(sp.settled, true);
  });
});

describe('gestures', () => {
  const names = ['wave', 'present', 'beat', 'beat2', 'think', 'celebrate', 'shrug', 'nod'];
  test('every gesture ends at rest', () => {
    for (const n of names) {
      const g = gesture(n, 'right');
      assert.ok(g, n);
      const end = g.keys.at(-1).pose;
      const touched = Object.keys(g.keys.reduce((a, k) => ({ ...a, ...k.pose }), {}));
      for (const j of touched) assert.equal(end[j] ?? null, REST[j], `${n}.${j}`);
    }
  });
  test('present points toward the panel', () => {
    assert.ok(gesture('present', 'up').keys[0].pose.lA > 100);
    assert.ok(gesture('present', 'right').keys[0].pose.rA > 40);
    assert.equal(gesture('nope'), null);
  });
  test('keyframes are in time order', () => {
    for (const n of names) { const k = gesture(n).keys; for (let i = 1; i < k.length; i++) assert.ok(k[i].at >= k[i - 1].at, n); }
  });
  test('sequencer applies keys when due and then goes idle', () => {
    const seen = [];
    const seq = createSequencer((p) => seen.push(p));
    seq.play(gesture('wave'));
    assert.equal(seq.busy, true);
    seq.tick(2000);
    assert.equal(seq.busy, false);
    assert.deepEqual(seen.at(-1), REST);
  });
  test('a new arm gesture replaces the old one, a head gesture layers', () => {
    const seq = createSequencer(() => {});
    seq.play(gesture('wave'));
    seq.play(gesture('nod'));
    assert.equal(seq.armBusy, true);
    seq.play(gesture('shrug'));
    seq.tick(5000);
    assert.equal(seq.busy, false);
    assert.ok(HEAD_ONLY.has('nod'));
  });
  test('cancel stops everything', () => {
    const seq = createSequencer(() => {});
    seq.play(gesture('think'));
    seq.cancel();
    assert.equal(seq.busy, false);
  });
});
