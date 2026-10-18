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

const UPLOAD_REPLY = { upload_token_id: '0_tok', entry_id: '0_ent', category_id: '77' };
const CONVERSATION_TOKEN = { ks: 'djJ8' + 'B'.repeat(40), kind: 'conversation' };

test('knowledge.upload posts id, name and file_name to v1/knowledge/upload and returns the raw reply', async () => {
  const { mgmt, ff } = harness([{ match: 'v1/knowledge/upload', respond: () => ({ status: 200, body: UPLOAD_REPLY }) }]);
  const out = await mgmt.knowledge.upload(5, { fileName: 'guide.pdf' }, ADMIN_KS);
  assert.deepEqual(out, UPLOAD_REPLY);
  assert.equal(ff.calls.length, 1);
  assert.match(ff.calls[0].url, /v1\/knowledge\/upload$/);
  assert.deepEqual(ff.calls[0].body, { id: 5, name: 'guide.pdf', file_name: 'guide.pdf' });
});

test('knowledge.upload sends category_id as a string, and description, tags, language only when given', async () => {
  const { mgmt, ff } = harness([{ match: 'v1/knowledge/upload', respond: () => ({ status: 200, body: UPLOAD_REPLY }) }]);
  await mgmt.knowledge.upload(5, { fileName: 'a.pdf', name: 'Guide', categoryId: 12, description: 'd', tags: ['x'], language: 'en' }, ADMIN_KS);
  assert.deepEqual(ff.calls[0].body, { id: 5, name: 'Guide', file_name: 'a.pdf', category_id: '12', description: 'd', tags: ['x'], language: 'en' });
});

test('knowledge.upload defaults name to fileName', async () => {
  const { mgmt, ff } = harness([{ match: 'v1/knowledge/upload', respond: () => ({ status: 200, body: UPLOAD_REPLY }) }]);
  await mgmt.knowledge.upload(0, { fileName: 'notes.txt' }, ADMIN_KS);
  assert.equal(ff.calls[0].body.name, 'notes.txt');
  assert.equal(ff.calls[0].body.id, 0);
});

test('knowledge.upload rejects a bad id, a missing fileName and a fileName without an extension before any request', async () => {
  const { mgmt, ff } = harness([{ match: 'v1/knowledge/upload', respond: () => ({ status: 200, body: UPLOAD_REPLY }) }]);
  await assert.rejects(() => mgmt.knowledge.upload('5', { fileName: 'a.pdf' }, ADMIN_KS), { code: 'bad_request' });
  await assert.rejects(() => mgmt.knowledge.upload(5, {}, ADMIN_KS), { code: 'bad_request', detail: /with an extension, for example 'guide\.pdf'/ });
  await assert.rejects(() => mgmt.knowledge.upload(5, undefined, ADMIN_KS), { code: 'bad_request' });
  await assert.rejects(() => mgmt.knowledge.upload(5, { fileName: 'noext' }, ADMIN_KS), { code: 'bad_request' });
  await assert.rejects(() => mgmt.knowledge.upload(5, { fileName: 'dir.d/noext' }, ADMIN_KS), { code: 'bad_request' });
  await assert.rejects(() => mgmt.knowledge.upload(5, { fileName: 'trailing.' }, ADMIN_KS), { code: 'bad_request' });
  assert.equal(ff.calls.length, 0);
});

test('knowledge.upload rejects a conversation token with wrong_token_scope', async () => {
  const { mgmt, ff } = harness([{ match: 'v1/knowledge/upload', respond: () => ({ status: 200, body: UPLOAD_REPLY }) }]);
  await assert.rejects(() => mgmt.knowledge.upload(5, { fileName: 'a.pdf' }, CONVERSATION_TOKEN), { code: 'wrong_token_scope' });
  assert.equal(ff.calls.length, 0);
});

test('knowledge.upload maps a 400 to bad_request and keeps the server detail', async () => {
  const { mgmt } = harness([{ match: 'v1/knowledge/upload', respond: () => ({ status: 400, body: { detail: 'Unsupported file type. Supported: pdf, txt' } }) }]);
  await assert.rejects(() => mgmt.knowledge.upload(5, { fileName: 'a.exe' }, ADMIN_KS), (e) => e.code === 'bad_request' && /Supported: pdf, txt/.test(e.detail));
});

test('knowledge.upload is not retried on 503', async () => {
  const { mgmt, ff } = harness([{ match: 'v1/knowledge/upload', respond: () => ({ status: 503, body: { detail: 'down' } }) }]);
  await assert.rejects(() => mgmt.knowledge.upload(5, { fileName: 'a.pdf' }, ADMIN_KS));
  assert.equal(ff.calls.length, 1);
});
