import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../../scripts/lib/target.mjs';

test('loadEnvFile reads a .env saved with Windows line endings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-'));
  const keys = ['ENVTEST_A', 'ENVTEST_B'];
  try {
    writeFileSync(join(dir, '.env'), 'ENVTEST_A=one\r\nENVTEST_B="two"\r\n');
    assert.equal(loadEnvFile(join(dir, '.env')), true);
    assert.equal(process.env.ENVTEST_A, 'one');
    assert.equal(process.env.ENVTEST_B, 'two');
  } finally {
    for (const k of keys) delete process.env[k];
    rmSync(dir, { recursive: true, force: true });
  }
});
