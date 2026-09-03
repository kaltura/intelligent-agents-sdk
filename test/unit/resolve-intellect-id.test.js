/**
 * `resolveIntellectId` guards an agent's `intellect.id`: returns it only if
 * `intellect` is an object and `id` is a number, `undefined` otherwise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIntellectId } from '../../src/management/index.js';

test('resolveIntellectId reads the numeric id', () => {
  assert.equal(resolveIntellectId({ intellectType: 'genie', id: 3552 }), 3552);
  assert.equal(resolveIntellectId({ id: 1389 }), 1389);
});

test('resolveIntellectId ignores any other field', () => {
  assert.equal(resolveIntellectId({ configId: 3552 }), undefined);
  assert.equal(resolveIntellectId({ genieId: 'abc', configId: 3552 }), undefined);
});

test('resolveIntellectId returns undefined with no numeric id available', () => {
  assert.equal(resolveIntellectId({}), undefined);
  assert.equal(resolveIntellectId(null), undefined);
  assert.equal(resolveIntellectId(undefined), undefined);
  assert.equal(resolveIntellectId({ id: 'not-a-number' }), undefined);
});
