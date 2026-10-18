// `catalog.list` sends `filter`, `orderBy` and `agentScope`. `type` stays a shortcut for `filter.typeEqual`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);

function harness(respond = () => ({ body: { totalCount: 1, objects: [{ itemId: 'i1' }] } })) {
  const ff = fakeFetch([{ match: 'catalog-item/list', respond }]);
  return { mgmt: new Management({ partnerId: 123, adminSecret: 's', fetch: ff }), ff };
}

test('sends only the pager when no options are passed', async () => {
  const { mgmt, ff } = harness();
  await mgmt.catalog.list(ADMIN_KS);
  assert.deepEqual(Object.keys(ff.calls[0].body), ['pager']);
});

test('type becomes filter.typeEqual, wire unchanged', async () => {
  const { mgmt, ff } = harness();
  await mgmt.catalog.list(ADMIN_KS, { type: 'Voice' });
  assert.deepEqual(ff.calls[0].body, { filter: { typeEqual: 'Voice' }, pager: { offset: 0, limit: 100 } });
});

test('all five filter keys pass through and type merges in', async () => {
  const { mgmt, ff } = harness();
  const filter = { itemIdEqual: 'x', idsIn: ['a', 'b'], languageEqual: 'en', adminTagsIn: ['t'] };
  const before = JSON.parse(JSON.stringify(filter));
  await mgmt.catalog.list(ADMIN_KS, { type: 'Voice', filter });
  assert.deepEqual(ff.calls[0].body.filter, { ...before, typeEqual: 'Voice' });
  assert.deepEqual(filter, before, 'the caller object is not changed');
});

test('filter.typeEqual alone is sent', async () => {
  const { mgmt, ff } = harness();
  await mgmt.catalog.list(ADMIN_KS, { filter: { typeEqual: 'Face' } });
  assert.equal(ff.calls[0].body.filter.typeEqual, 'Face');
});

test('orderBy and agentScope are top-level and omitted when unset', async () => {
  const { mgmt, ff } = harness();
  await mgmt.catalog.list(ADMIN_KS, { orderBy: '-createdAt', agentScope: 's' });
  assert.equal(ff.calls[0].body.orderBy, '-createdAt');
  assert.equal(ff.calls[0].body.agentScope, 's');
  assert.equal(ff.calls[0].body.filter, undefined);
  await mgmt.catalog.list(ADMIN_KS, { filter: {} });
  assert.equal('orderBy' in ff.calls[1].body, false);
  assert.equal('agentScope' in ff.calls[1].body, false);
  assert.equal('filter' in ff.calls[1].body, false, 'an empty filter is not sent');
});

test('filter and orderBy are kept on every page', async () => {
  const pages = [[{ itemId: 'a' }, { itemId: 'b' }], [{ itemId: 'c' }]];
  const { mgmt, ff } = harness((req) => ({ body: { totalCount: 3, objects: pages[req.body.pager.offset === 0 ? 0 : 1] } }));
  const all = await mgmt.catalog.list(ADMIN_KS, { pageSize: 2, filter: { languageEqual: 'en' }, orderBy: '-createdAt' }).all();
  assert.equal(all.length, 3);
  assert.deepEqual(ff.calls.map((c) => c.body.pager.offset), [0, 2]);
  for (const c of ff.calls) {
    assert.deepEqual(c.body.filter, { languageEqual: 'en' });
    assert.equal(c.body.orderBy, '-createdAt');
  }
});

test('type and filter.typeEqual that disagree throw before any request', () => {
  const { mgmt, ff } = harness();
  assert.throws(
    () => mgmt.catalog.list(ADMIN_KS, { type: 'Voice', filter: { typeEqual: 'Visual' } }),
    (e) => e.code === 'bad_request' && e.detail.includes("'Voice'") && e.detail.includes("'Visual'"),
  );
  assert.equal(ff.calls.length, 0);
  assert.doesNotThrow(() => mgmt.catalog.list(ADMIN_KS, { type: 'Voice', filter: { typeEqual: 'Voice' } }));
});

test('a non-object filter throws before any request; null is ignored', async () => {
  const { mgmt, ff } = harness();
  assert.throws(() => mgmt.catalog.list(ADMIN_KS, { filter: ['x'] }), (e) => e.code === 'bad_request' && e.detail.includes('must be an object') && e.detail.includes('an array'));
  assert.throws(() => mgmt.catalog.list(ADMIN_KS, { filter: 'Voice' }), (e) => e.code === 'bad_request' && e.detail.includes('a string'));
  assert.equal(ff.calls.length, 0);
  await mgmt.catalog.list(ADMIN_KS, { filter: null });
  assert.equal('filter' in ff.calls[0].body, false);
});

test('a server 400 surfaces as bad_request with the accepted values', async () => {
  const message = ['orderBy must be one of the following values: +createdAt, -createdAt'];
  const { mgmt } = harness(() => ({ status: 400, body: { message, error: 'Bad Request', statusCode: 400 } }));
  await assert.rejects(
    async () => { await mgmt.catalog.list(ADMIN_KS, { orderBy: 'createdAt' }); },
    (e) => e.code === 'bad_request' && e.status === 400 && e.body.message[0].includes('+createdAt') && e.detail.includes('-createdAt'),
  );
});

test('a __proto__ key in filter does not pollute Object.prototype', async () => {
  const { mgmt } = harness();
  await mgmt.catalog.list(ADMIN_KS, { type: 'Voice', filter: JSON.parse('{"__proto__":{"polluted":1},"typeEqual":"Voice"}') });
  assert.equal(({}).polluted, undefined);
});
