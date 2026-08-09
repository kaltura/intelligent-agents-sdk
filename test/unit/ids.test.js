import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv4, randId, meta } from '../../src/core/ids.js';

test('uuidv4 is a valid v4 UUID', () => {
  const u = uuidv4();
  assert.match(u, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('uuidv4 has no collisions over 10k', () => {
  const seen = new Set();
  for (let i = 0; i < 10000; i++) seen.add(uuidv4());
  assert.equal(seen.size, 10000);
});

test('randId length + alphabet', () => {
  assert.equal(randId(16).length, 16);
  assert.equal(randId(12).length, 12);
  assert.match(randId(20), /^[a-z0-9]{20}$/);
});

test('meta receipt carries generatedAt + scope/source', () => {
  const m = meta({ partnerId: '123', source: 'genie/message/report', scope: 'partner' });
  assert.match(m.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(m.partnerId, '123');
  assert.equal(m.source, 'genie/message/report');
  assert.equal(m.scope, 'partner');
});
