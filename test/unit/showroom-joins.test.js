// Showroom example: where a gesture joins the idle loop. Pure, no DOM.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ahead, parseJoins, planEntry, planExit } from '../../examples/showroom/js/rig/joins.js';

const N = 100;
/** A clip whose entry distance is `d(p)` for every idle frame, starting on frame `p % 7`. */
const make = (d, exits) => parseJoins({
  fps: 24,
  idle: N,
  clips: { beat: { frames: 120, entry: { k: Array.from({ length: N }, (_, p) => p % 7), d: Array.from({ length: N }, (_, p) => d(p)) }, exits } },
});

describe('joins file', () => {
  test('a good file parses, a broken clip is left out', () => {
    const j = make(() => 3, [[30, 5, 2], [119, 9, 4]]);
    assert.equal(j.idle, N);
    assert.ok(j.clips.beat);
    const bad = parseJoins({ fps: 24, idle: N, clips: { a: { frames: 5, entry: { k: [], d: [] }, exits: [[1, 2, 3]] } } });
    assert.deepEqual(bad.clips, {});
  });
  test('rejects what is not a joins file', () => {
    for (const x of [null, {}, { fps: 0, idle: 5, clips: {} }, { fps: 24, idle: 5 }]) assert.equal(parseJoins(x), null);
  });
});

describe('ahead', () => {
  test('counts frames forward on the loop and goes negative just after', () => {
    assert.equal(ahead(10, 15, N), 5);
    assert.equal(ahead(98, 3, N), 5, 'across the loop point');
    assert.equal(ahead(15, 14, N), -1, 'just passed');
    assert.equal(ahead(5, 5, N), 0);
  });
});

describe('planEntry', () => {
  test('waits for the frame that matches best', () => {
    const j = make((p) => (p === 20 ? 1 : 9), [[119, 0, 3]]);
    const plan = planEntry(j, 'beat', 10);
    assert.deepEqual([plan.p, plan.k, plan.d, plan.wait], [20, 20 % 7, 1, 10]);
  });
  test('does not wait long for a small gain', () => {
    const j = make((p) => (p === 10 + 30 ? 2.5 : 3), [[119, 0, 3]]);
    assert.equal(planEntry(j, 'beat', 10).wait, 8, 'the earliest start wins when later is only a little better');
  });
  test('never plans sooner than minAhead, and wraps the loop', () => {
    const j = make((p) => (p === 3 ? 0 : 5), [[119, 0, 3]]);
    assert.equal(planEntry(j, 'beat', 95).p, 3);
    assert.ok(planEntry(j, 'beat', 10, { minAhead: 12 }).wait >= 12);
  });
  test('an unknown clip has no plan', () => {
    assert.equal(planEntry(make(() => 1, [[119, 0, 3]]), 'wave', 0), null);
    assert.equal(planEntry(null, 'beat', 0), null);
  });
});

describe('planExit', () => {
  const j = make(() => 3, [[20, 5, 6], [60, 7, 2], [90, 9, 3], [119, 11, 4]]);
  test('picks a close match near the target', () => {
    assert.equal(planExit(j, 'beat', 0, { target: 62 }).k, 60);
    assert.equal(planExit(j, 'beat', 0, { target: 100 }).k, 90);
  });
  test('an exit before the target costs more than one after it', () => {
    assert.equal(planExit(j, 'beat', 0, { target: 75 }).k, 90);
  });
  test('never exits before fromK + minAhead', () => {
    assert.ok(planExit(j, 'beat', 50, { minAhead: 14, target: 0 }).k >= 64);
    assert.equal(planExit(j, 'beat', 10, { minAhead: 14, target: 0 }).k, 60, 'best of those left: the match at 20 is too soon');
  });
  test('past the last exit it still ends on the last frame', () => {
    const plan = planExit(j, 'beat', 118);
    assert.deepEqual([plan.k, plan.p], [119, 11]);
  });
});
