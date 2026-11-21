// Showroom example: the gesture video mixer. Pure, no DOM.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createLayers } from '../../examples/showroom/js/rig/layers.js';

const run = (layers, ms, per = 16) => { let last; for (let t = 0; t < ms; t += per) last = layers.step(per); return last; };
const total = (w) => w.idle + w.slots[0] + w.slots[1];

describe('gesture layers', () => {
  test('idle until a gesture has a frame', () => {
    const l = createLayers();
    assert.deepEqual(run(l, 100), { idle: 1, slots: [0, 0] });
    const i = l.start('wave');
    assert.deepEqual(run(l, 100), { idle: 1, slots: [0, 0] }, 'still loading');
    l.ready(i, true);
    const w = run(l, 400);
    assert.equal(w.slots[i], 1);
    assert.equal(w.idle, 0);
  });

  test('fades back to idle when the clip ends', () => {
    const l = createLayers();
    l.ready(l.start('wave'), true);
    run(l, 400);
    l.end(l.current);
    assert.deepEqual(run(l, 400), { idle: 1, slots: [0, 0] });
    assert.equal(l.busy, false);
  });

  test('a new gesture never drops to idle while it loads', () => {
    const l = createLayers();
    const a = l.start('beat');
    l.ready(a, true);
    run(l, 400);
    const b = l.start('present');
    assert.notEqual(a, b, 'the new clip loads in the other slot');
    for (let t = 0; t < 600; t += 16) {
      const w = l.step(16);
      assert.equal(w.slots[a], 1, 'the shown clip stays at full weight until the new one has a frame');
      assert.equal(w.idle, 0);
    }
    l.ready(b, true);
    for (let t = 0; t < 400; t += 16) {
      const w = l.step(16);
      assert.ok(Math.abs(total(w) - 1) < 1e-9, 'weights always add to 1');
      assert.ok(w.idle < 1e-9, 'idle does not come back during the cross-fade');
    }
    assert.equal(l.step(16).slots[b], 1);
  });

  test('no weight jumps more than one frame step in a swap', () => {
    const l = createLayers({ fadeMs: 200 });
    const a = l.start('beat');
    l.ready(a, true);
    run(l, 400);
    let prev = l.step(16);
    const b = l.start('celebrate');
    for (let t = 0; t < 1000; t += 16) {
      if (t === 300) l.ready(b, true);
      const w = l.step(16);
      for (let k = 0; k < 2; k++) assert.ok(Math.abs(w.slots[k] - prev.slots[k]) <= 16 / 200 + 1e-9, `slot ${k} at ${t}ms`);
      prev = w;
    }
  });

  test('asking again while a clip loads swaps what loads, not what is on screen', () => {
    const l = createLayers();
    const a = l.start('beat');
    l.ready(a, true);
    run(l, 400);
    const b = l.start('shrug');
    const c = l.start('celebrate');
    assert.equal(b, c, 'the loading slot is reused');
    assert.equal(l.step(16).slots[a], 1);
  });

  test('a clip that ends during the fade-in of the next one does not hide it', () => {
    const l = createLayers();
    const a = l.start('beat');
    l.ready(a, true);
    run(l, 400);
    const b = l.start('present');
    l.ready(b, true);
    run(l, 100);
    l.end(a); // not current: ignored
    assert.equal(l.current, b);
    assert.equal(run(l, 400).slots[b], 1);
  });

  test('release fades the playing clip out', () => {
    const l = createLayers();
    l.ready(l.start('beat'), true);
    run(l, 400);
    l.release();
    assert.deepEqual(run(l, 400), { idle: 1, slots: [0, 0] });
  });

  test('a clip loaded in a chosen slot starts there', () => {
    const l = createLayers();
    assert.equal(l.start('beat', 1), 1);
    l.ready(1, true);
    assert.deepEqual(run(l, 400).slots, [0, 1]);
    l.end(1);
    assert.equal(l.start('shrug', 0), 0);
    l.ready(0, true);
    const w = run(l, 40);
    assert.ok(Math.abs(w.idle + w.slots[0] + w.slots[1] - 1) < 1e-9, 'weights still sum to 1');
  });
});
