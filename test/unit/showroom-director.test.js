// Showroom example: when the body moves. Pure, driven by a seeded random source.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirector } from '../../examples/showroom/js/rig/director.js';

/** A small seeded random source (mulberry32), so each run is the same. */
const seeded = (seed) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** A body that records what it is asked. A gesture counts as playing for `playMs`. */
function fakeBody({ playMs = 2400 } = {}) {
  const log = [];
  let clock = 0;
  let until = -1;
  const body = {
    log,
    get now() { return clock; },
    busy: false,
    perform(name, dir, opts) { if (!['beat', 'beat2', 'shrug', 'present', 'wave'].includes(name)) return false; log.push({ at: clock, kind: 'gesture', name, rate: opts?.rate }); body.busy = true; until = clock + playMs; return true; },
    release() { log.push({ at: clock, kind: 'release' }); body.busy = false; },
    cue(name, amount, side) { log.push({ at: clock, kind: 'cue', name, amount, side }); },
    drift(rate) { log.push({ at: clock, kind: 'drift', rate }); },
    setSpeaking() {}, setThinking() {}, setListening() {}, setLive() {},
    tick(dt) { clock += dt; if (body.busy && clock >= until) body.busy = false; },
  };
  return body;
}
const play = (d, body, ms, step = 16) => { for (let t = 0; t < ms; t += step) d.tick(step); return body.log; };
const gestures = (log) => log.filter((e) => e.kind === 'gesture');

describe('gesture director', () => {
  test('while she talks, hand gestures never repeat back to back and have gaps', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const body = fakeBody();
      const d = createDirector(body, { rng: seeded(seed) });
      d.setSpeaking(true);
      const g = gestures(play(d, body, 60_000));
      assert.ok(g.length >= 4 && g.length <= 14, `seed ${seed}: ${g.length} gestures in 60 s`);
      for (let i = 1; i < g.length; i++) {
        assert.notEqual(g[i].name, g[i - 1].name, `seed ${seed}: ${g[i].name} twice in a row`);
        assert.ok(g[i].at - g[i - 1].at >= 4000, `seed ${seed}: gestures overlap`);
      }
    }
  });

  test('gestures differ in speed', () => {
    const body = fakeBody();
    const d = createDirector(body, { rng: seeded(11) });
    d.setSpeaking(true);
    const rates = new Set(gestures(play(d, body, 60_000)).map((g) => g.rate.toFixed(2)));
    assert.ok(rates.size > 3);
    for (const r of rates) assert.ok(r >= 0.8 && r <= 0.95);
  });

  test('a question brings an open hand soon', () => {
    let opened = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const body = fakeBody();
      const d = createDirector(body, { rng: seeded(seed) });
      d.say('Want to see the camera?');
      d.setSpeaking(true);
      const first = gestures(play(d, body, 6000))[0];
      if (first?.name === 'shrug') opened++;
    }
    assert.ok(opened >= 11, `${opened} of 20 questions got an open hand first`);
  });

  test('no hand gesture when she is quiet, and hands stop when speech stops', () => {
    const body = fakeBody({ playMs: 20_000 });
    const d = createDirector(body, { rng: seeded(3) });
    d.setSpeaking(true);
    play(d, body, 4000);
    assert.ok(body.busy, 'a gesture is playing');
    d.setSpeaking(false);
    assert.ok(body.log.some((e) => e.kind === 'release'), 'the gesture was released');
    const before = gestures(body.log).length;
    play(d, body, 120_000);
    assert.equal(gestures(body.log).length, before, 'no hand gestures while waiting');
  });

  test('a real move is not cut off when speech stops', () => {
    const body = fakeBody({ playMs: 20_000 });
    const d = createDirector(body, { rng: seeded(3) });
    d.setSpeaking(true);
    d.perform('present', 'right');
    d.setSpeaking(false);
    assert.equal(body.log.filter((e) => e.kind === 'release').length, 0);
  });

  test('while the customer talks she nods now and then, and settles after', () => {
    const body = fakeBody();
    const d = createDirector(body, { rng: seeded(5) });
    for (let t = 0; t < 10_000; t += 16) { if (t % 1000 === 0) d.userTalking(); d.tick(16); }
    const nods = body.log.filter((e) => e.kind === 'cue' && e.name === 'nod');
    assert.ok(nods.length >= 2 && nods.length <= 8, `${nods.length} nods in 10 s`);
    assert.equal(gestures(body.log).length, 0, 'no arm gestures while listening');
  });

  test('waiting looks alive but calm: a head move every few seconds, a drifting loop', () => {
    const body = fakeBody();
    const d = createDirector(body, { rng: seeded(9) });
    const log = play(d, body, 60_000);
    const cues = log.filter((e) => e.kind === 'cue');
    assert.ok(cues.length >= 4 && cues.length <= 25, `${cues.length} head moves in 60 s`);
    assert.ok(log.filter((e) => e.kind === 'drift').length >= 3);
    for (const e of log.filter((x) => x.kind === 'drift')) assert.ok(e.rate >= 0.9 && e.rate <= 1.08);
    for (const e of cues) assert.ok(e.amount === undefined || (e.amount > 0 && e.amount <= 1));
  });

  test('thinking tilts the head and the answer levels it', () => {
    const body = fakeBody();
    const d = createDirector(body, { rng: seeded(2) });
    d.setThinking(true);
    d.setThinking(false);
    const cues = body.log.filter((e) => e.kind === 'cue').map((e) => e.name);
    assert.deepEqual(cues, ['tilt', 'level']);
  });

  test('reduced motion: nothing unprompted', () => {
    const body = fakeBody();
    const d = createDirector(body, { rng: seeded(1), reduced: true });
    d.setSpeaking(true);
    d.userTalking();
    d.setThinking(true);
    assert.equal(play(d, body, 30_000).length, 0);
  });

  test('the same seed replays the same run', () => {
    const run = () => { const body = fakeBody(); const d = createDirector(body, { rng: seeded(42) }); d.setSpeaking(true); return JSON.stringify(play(d, body, 30_000)); };
    assert.equal(run(), run());
  });

  test('other body calls pass straight through', () => {
    const body = fakeBody();
    const d = createDirector(body);
    assert.equal(d.perform('wave'), true);
    assert.equal(d.perform('think'), false);
    assert.equal(body.log[0].name, 'wave');
  });
});
