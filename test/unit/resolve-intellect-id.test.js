/**
 * `resolveIntellectId` reads the canonical `id` field off an agent's embedded
 * `intellect` sub-object. `configId`/`genieId` are legacy backend fields
 * (`configId` is `@deprecated` on `AgentIntellectDto`, kept on the wire only
 * for backward compat) — deliberately not read here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIntellectId } from '../../src/management/index.js';

test('resolveIntellectId reads the numeric id', () => {
  assert.equal(resolveIntellectId({ intellectType: 'genie', id: 3552 }), 3552);
  assert.equal(resolveIntellectId({ id: 1389 }), 1389);
});

test('resolveIntellectId ignores legacy configId/genieId fields', () => {
  assert.equal(resolveIntellectId({ configId: 3552 }), undefined);
  assert.equal(resolveIntellectId({ genieId: 'abc', configId: 3552 }), undefined);
});

test('resolveIntellectId returns undefined with no numeric id available', () => {
  assert.equal(resolveIntellectId({}), undefined);
  assert.equal(resolveIntellectId(null), undefined);
  assert.equal(resolveIntellectId(undefined), undefined);
  assert.equal(resolveIntellectId({ id: 'not-a-number' }), undefined);
});
