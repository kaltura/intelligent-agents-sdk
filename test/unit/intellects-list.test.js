import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);

function harness(routes) {
  const ff = fakeFetch(routes);
  const mgmt = new Management({ partnerId: '123', fetch: ff });
  return { mgmt, ff };
}

test('intellects.list passes filter fields through to v1/intellect/list as-is', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/intellect/list', respond: () => ({ status: 200, body: { totalCount: 1, objects: [{ id: 1, name: 'x' }] } }) },
  ]);
  const filter = { typeEquals: 'external', statusEquals: 2, nameLike: 'demo' };
  const page = await mgmt.intellects.list(ADMIN_KS, { filter });
  assert.equal(page.length, 1);
  assert.deepEqual(ff.calls[0].body.filter, filter);
});

test('intellects.list defaults to an empty filter (lists everything)', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/intellect/list', respond: () => ({ status: 200, body: { totalCount: 0, objects: [] } }) },
  ]);
  await mgmt.intellects.list(ADMIN_KS);
  assert.deepEqual(ff.calls[0].body.filter, {});
});
