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

test('knowledge.search sends only {query} when no tuning opts are given', async () => {
  const { mgmt, ff } = harness([
    { match: 'mcp/search', respond: () => ({ status: 200, body: { status: 'success', data: 'answer', chapters: null } }) },
  ]);
  await mgmt.knowledge.search('how do I reset my password', ADMIN_KS);
  assert.deepEqual(ff.calls[0].body, { query: 'how do I reset my password' });
});

test('knowledge.search passes through all five tuning params', async () => {
  const { mgmt, ff } = harness([
    { match: 'mcp/search', respond: () => ({ status: 200, body: { status: 'success', data: null, chapters: [] } }) },
  ]);
  await mgmt.knowledge.search('q', ADMIN_KS, {
    top_n: 2, with_line_numbers: true, margins_in_seconds: 30, include_sources: true, entry_description: true,
  });
  assert.deepEqual(ff.calls[0].body, {
    query: 'q', top_n: 2, with_line_numbers: true, margins_in_seconds: 30, include_sources: true, entry_description: true,
  });
});

test('knowledge.deleteRecord rejects when an intellect lookup fails with a 500, and does not delete', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/knowledge/delete', respond: () => ({ status: 200, body: {} }) },
    { match: 'v1/intellect/list', respond: () => ({ status: 200, body: { totalCount: 1, objects: [{ id: 42 }] } }) },
    { match: 'v1/intellect/get', respond: () => ({ status: 500, body: { message: 'boom' } }) },
  ]);
  await assert.rejects(() => mgmt.knowledge.deleteRecord(7, ADMIN_KS, { confirmPermanent: true }), (e) => e.code === 'server_error');
  assert.equal(ff.calls.some((c) => /knowledge\/delete/.test(c.url)), false, 'delete does not proceed');
});

test('knowledge.deleteRecord skips an intellect whose get returns not_found (deleted between list and get)', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/intellect/list', respond: () => ({ status: 200, body: { totalCount: 1, objects: [{ id: 42 }] } }) },
    { match: 'v1/intellect/get', respond: () => ({ status: 404, body: { message: 'gone' } }) },
    { match: 'delete', respond: () => ({ status: 200, body: {} }) },
  ]);
  await mgmt.knowledge.deleteRecord(7, ADMIN_KS, { confirmPermanent: true });
  assert.equal(ff.calls.some((c) => /delete/.test(c.url)), true);
});
