import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/**
 * Avatars#listTemplates — curated preset {voice,face} bundles
 * (`avatar-template/list`, agentic-hosted). Needs the
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

// ─────────────────────────── face/background composition guard ───────────────────────────

test('avatars.create/update reject face without background, and background without face, BEFORE any network call', async () => {
  const { mgmt, ff } = harness([]);
  await assert.rejects(() => mgmt.avatars.create({ voice: { id: 'v1' }, face: { id: 'f1' } }, ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.avatars.create({ voice: { id: 'v1' }, background: { type: 'color', value: '#fff' } }, ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.avatars.update({ id: 'a1', face: { id: 'f1' } }, ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.avatars.update({ id: 'a1', background: { type: 'color', value: '#fff' } }, ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0, 'no transport before the composition guard passes');
});

test('avatars.create/update reject a malformed background (missing type or value)', async () => {
  const { mgmt, ff } = harness([]);
  await assert.rejects(() => mgmt.avatars.create({ voice: { id: 'v1' }, face: { id: 'f1' }, background: { value: '#fff' } }, ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.avatars.create({ voice: { id: 'v1' }, face: { id: 'f1' }, background: { type: 'color' } }, ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0);
});

test('avatars.create accepts a valid face+background pairing, or visual alone, or templateId+background', async () => {
  const { mgmt, ff } = harness([
    { match: 'avatar/create', respond: (req) => ({ status: 200, body: { id: 'a1', ...req.body } }) },
  ]);
  await mgmt.avatars.create({ voice: { id: 'v1' }, face: { id: 'f1' }, background: { type: 'color', value: '#fff' } }, ADMIN_KS);
  assert.deepEqual(ff.calls[0].body.background, { type: 'color', value: '#fff' });

  await mgmt.avatars.create({ voice: { id: 'v1' }, visual: { id: 'vis1' } }, ADMIN_KS);
  assert.equal(ff.calls[1].body.visual.id, 'vis1');

  await mgmt.avatars.create({ voice: { id: 'v1' }, templateId: 't1', background: { type: 'visual', value: 'bg1' } }, ADMIN_KS);
  assert.equal(ff.calls[2].body.templateId, 't1');
});

test('avatars.update accepts a valid face+background recomposition and name alone', async () => {
  const { mgmt, ff } = harness([
    { match: 'avatar/update', respond: (req) => ({ status: 200, body: { id: req.body.id, ...req.body } }) },
  ]);
  await mgmt.avatars.update({ id: 'a1', face: { id: 'f1' }, background: { type: 'color', value: '#000' } }, ADMIN_KS);
  assert.deepEqual(ff.calls[0].body.background, { type: 'color', value: '#000' });

  await mgmt.avatars.update({ id: 'a1', name: 'New name' }, ADMIN_KS);
  assert.equal(ff.calls[1].body.name, 'New name');
});
