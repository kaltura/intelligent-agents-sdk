/**
 * `resolveIntellectId` normalizes the Agent DTO's embedded `intellect`
 * sub-object across the backend's id-field naming history: `id` (oldest,
 * still the only field on the standalone Intellect entity) → `configId`
 * (current live shape, kept on the wire for backward compat) → `intellectId`
 * (the backend's announced replacement for `configId` — same underlying id,
 * just a clearer name).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIntellectId } from '../../src/management/index.js';

test('resolveIntellectId prefers intellectId when present', () => {
  assert.equal(resolveIntellectId({ intellectId: 3552, configId: 3552, id: 3552 }), 3552);
  assert.equal(resolveIntellectId({ intellectId: 42, configId: 99 }), 42);
});

test('resolveIntellectId falls back to configId (current live Agent DTO shape)', () => {
  assert.equal(resolveIntellectId({ intellectType: 'genie', configId: 3552, id: 3552 }), 3552);
});

test('resolveIntellectId falls back to id (standalone Intellect entity, oldest shape)', () => {
  assert.equal(resolveIntellectId({ id: 1389 }), 1389);
});

test('resolveIntellectId returns undefined with no numeric id available', () => {
  assert.equal(resolveIntellectId({}), undefined);
  assert.equal(resolveIntellectId(null), undefined);
  assert.equal(resolveIntellectId(undefined), undefined);
  assert.equal(resolveIntellectId({ configId: 'not-a-number' }), undefined);
});
