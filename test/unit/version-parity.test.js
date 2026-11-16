import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SDK_VERSION } from '../../src/core/version.js';

test('SDK_VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(SDK_VERSION, pkg.version);
});
