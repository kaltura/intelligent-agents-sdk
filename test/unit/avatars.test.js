import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/**
 * Avatars#listTemplates — curated preset {face,background} bundles
 * (`avatar-template/list`, agentic-hosted). Verified live: needs the
 * `{offset,limit}` pager (a `{pageIndex,pageSize}` attempt 400s).
 */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);

function harness(routes) {
  const ff = fakeFetch(routes);
  const mgmt = new Management({ partnerId: '123', fetch: ff });
  return { mgmt, ff };
}

const TEMPLATE = {
  id: '698b9ba5359cae8fee1d71fc', name: 'Adam',
  voice: { id: 'voice-1' }, face: { id: 'face-1', imageUrl: 'https://cdn.example/adam.jpg' },
};

test('avatars.listTemplates uses the {offset,limit} pager (NOT Genie pageIndex/pageSize)', async () => {
  const { mgmt, ff } = harness([
    { match: 'avatar-template/list', respond: () => ({ status: 200, body: { totalCount: 1, objects: [TEMPLATE] } }) },
  ]);
  const page = await mgmt.avatars.listTemplates(ADMIN_KS);
  assert.equal(page.length, 1);
  assert.equal(page[0].id, TEMPLATE.id);
  assert.match(ff.calls[0].url, /avatar-template\/list$/);
  assert.ok('offset' in ff.calls[0].body.pager && 'limit' in ff.calls[0].body.pager, 'offset/limit pager, not pageIndex/pageSize');
  assert.equal(ff.calls[0].body.filter, undefined, 'no filter key when idsIn is omitted');
});

test('avatars.listTemplates passes idsIn through as filter.idsIn', async () => {
  const { mgmt, ff } = harness([
    { match: 'avatar-template/list', respond: () => ({ status: 200, body: { totalCount: 1, objects: [TEMPLATE] } }) },
  ]);
  await mgmt.avatars.listTemplates(ADMIN_KS, { idsIn: [TEMPLATE.id] });
  assert.deepEqual(ff.calls[0].body.filter, { idsIn: [TEMPLATE.id] });
});

test('avatars.listTemplates asserts admin scope (rejects a conversation token)', async () => {
  const { mgmt } = harness([]);
  const convToken = { ks: 'djJ8conv', kind: 'conversation' };
  await assert.rejects(async () => mgmt.avatars.listTemplates(convToken), (e) => e.code === 'wrong_token_scope');
});
