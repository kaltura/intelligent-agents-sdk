import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stripServerManaged } from '../../src/management/intellect-body.js';

/** management/intellect-body.js — the shared read-merge-write body primitive. */

test('stripServerManaged drops server-managed keys and re-asserts id/type/status', () => {
  const cur = {
    id: 999, partner_id: 111, user_id: 222, created_at: '2026-01-01', updated_at: '2026-02-02',
    type: 'internal', status: 2, name: 'Ron', base_directive: 'be helpful',
  };
  const body = stripServerManaged(cur, 42);
  assert.equal(body.id, 42); // overridden with the passed configId, not the DTO's own id
  assert.equal(body.partner_id, undefined);
  assert.equal(body.user_id, undefined);
  assert.equal(body.created_at, undefined);
  assert.equal(body.updated_at, undefined);
  assert.equal(body.type, 'internal');
  assert.equal(body.status, 2);
  assert.equal(body.name, 'Ron');
  assert.equal(body.base_directive, 'be helpful');
});

test('stripServerManaged defaults type to "internal" and status to 2 when absent', () => {
  const body = stripServerManaged({}, 7);
  assert.deepEqual(body, { id: 7, type: 'internal', status: 2 });
});

test('stripServerManaged treats status:0 as a real value, not "absent" (nullish-coalesce, not ||)', () => {
  const body = stripServerManaged({ status: 0 }, 7);
  assert.equal(body.status, 0);
});

test('stripServerManaged tolerates a non-object input', () => {
  assert.deepEqual(stripServerManaged(null, 5), { id: 5, type: 'internal', status: 2 });
  assert.deepEqual(stripServerManaged(undefined, 5), { id: 5, type: 'internal', status: 2 });
});
