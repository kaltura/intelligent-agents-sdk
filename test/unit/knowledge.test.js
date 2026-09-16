import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/**
 * Knowledge records (wire, `/v1/knowledge/*`, partner-level) — addRecord
 * mints a container record for RAG; createRecord is a permanent alias.
 */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);

function harness(routes) {
  const ff = fakeFetch(routes);
  const mgmt = new Management({ partnerId: '123', fetch: ff });
  return { mgmt, ff };
}

const RECORD = { id: 2049, name: 'Product docs', description: null, status: 'READY' };

test('knowledge.createRecord is an alias for knowledge.addRecord — same wire call', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/knowledge/add', respond: (req) => ({ status: 200, body: { ...RECORD, ...req.body } }) },
  ]);
  const viaAdd = await mgmt.knowledge.addRecord({ name: 'Product docs' }, ADMIN_KS);
  assert.equal(viaAdd.name, 'Product docs');
  assert.match(ff.calls[0].url, /v1\/knowledge\/add$/);

  const viaCreate = await mgmt.knowledge.createRecord({ name: 'Product docs' }, ADMIN_KS);
  assert.equal(viaCreate.name, 'Product docs');
  assert.match(ff.calls[1].url, /v1\/knowledge\/add$/);
  assert.deepEqual(ff.calls[1].body, ff.calls[0].body);
});
