import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../../examples/showroom/js/retry.js';

const noWait = () => Promise.resolve();

describe('showroom withRetry', () => {
  test('returns the first success and does not clean up', async () => {
    let cleaned = 0;
    assert.equal(await withRetry(async () => 'ok', { wait: noWait, before: () => { cleaned++; } }), 'ok');
    assert.equal(cleaned, 0);
  });

  test('retries after a failure, cleans up before each retry, backs off', async () => {
    const waits = []; const attempts = [];
    const out = await withRetry(async (n) => { attempts.push(n); if (n < 3) throw new Error(`fail ${n}`); return n; }, { delayMs: 100, wait: async (ms) => { waits.push(ms); }, before: (n) => { attempts.push(`clean${n}`); } });
    assert.equal(out, 3);
    assert.deepEqual(attempts, [1, 'clean2', 2, 'clean3', 3]);
    assert.deepEqual(waits, [100, 200]);
  });

  test('throws the last error when every try fails', async () => {
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw new Error(`boom ${calls}`); }, { tries: 2, wait: noWait }), /boom 2/);
    assert.equal(calls, 2);
  });
});
