import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Teardown } from '../../src/experience/teardown.js';

test('track() returns the unsub closure unchanged', () => {
  const teardown = new Teardown();
  const unsub = () => {};
  assert.equal(teardown.track(unsub), unsub);
});

test('run() invokes every tracked unsub exactly once', () => {
  const teardown = new Teardown();
  let calls = 0;
  teardown.track(() => { calls++; });
  teardown.track(() => { calls++; });
  teardown.run();
  assert.equal(calls, 2);
});

test('run() is idempotent — a second call is a harmless no-op', () => {
  const teardown = new Teardown();
  let calls = 0;
  teardown.track(() => { calls++; });
  teardown.run();
  teardown.run();
  assert.equal(calls, 1);
});

test('run() isolates a throwing unsub — later unsubs still run', () => {
  const teardown = new Teardown();
  let ranAfterThrow = false;
  teardown.track(() => { throw new Error('boom'); });
  teardown.track(() => { ranAfterThrow = true; });
  assert.doesNotThrow(() => teardown.run());
  assert.equal(ranAfterThrow, true);
});

test('run() with no tracked unsubs is a harmless no-op', () => {
  const teardown = new Teardown();
  assert.doesNotThrow(() => teardown.run());
});
