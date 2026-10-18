import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mgmt from '../../src/management/index.js';
import { LANGUAGE_CODES } from '../../src/management/languages.js';
import { LANGUAGE_NAMES } from '../../src/management/set-forced-language.js';

test('LANGUAGE_CODES is a frozen, sorted list of unique two-letter codes', () => {
  assert.ok(Object.isFrozen(LANGUAGE_CODES));
  assert.equal(LANGUAGE_CODES.length, 182);
  for (const c of LANGUAGE_CODES) assert.match(c, /^[a-z]{2}$/);
  assert.equal(new Set(LANGUAGE_CODES).size, LANGUAGE_CODES.length, 'no duplicates');
  assert.deepEqual([...LANGUAGE_CODES], [...LANGUAGE_CODES].sort());
});

test('LANGUAGE_CODES has no el', () => {
  assert.ok(!LANGUAGE_CODES.includes('el'));
});

test('every LANGUAGE_NAMES key is in LANGUAGE_CODES', () => {
  for (const k of Object.keys(LANGUAGE_NAMES)) assert.ok(LANGUAGE_CODES.includes(k), `${k} is not in LANGUAGE_CODES`);
});

test('the management entry re-exports LANGUAGE_CODES', () => {
  assert.equal(mgmt.LANGUAGE_CODES, LANGUAGE_CODES);
});
