import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/**
 * InsightSettings resource (wire, `/insight-settings/*`, agentic-hosted,
 * `{offset,limit}` pager) — same `{status,data}` unwrap shape as Avatars.
 */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);

/** Build a Management whose agentic calls hit fakeFetch with the supplied routes. */
function harness(routes) {
  const ff = fakeFetch(routes);
  const mgmt = new Management({ partnerId: '123', fetch: ff });
  return { mgmt, ff };
}

const SETTING = {
  id: '68b0000000000000000000a1', partnerId: 123, key: 'NEXT_STEP', title: 'Next step',
  prompt: 'One actionable next step for the support team, or "none".', valueType: 'string', status: 'active',
  createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
};

test('insightSettings.create validates {key, title, prompt, valueType} BEFORE any network call, then posts insight-settings/create', async () => {
  const { mgmt, ff } = harness([
    { match: 'insight-settings/create', respond: (req) => ({ status: 200, body: { ...SETTING, ...req.body } }) },
  ]);
  await assert.rejects(() => mgmt.insightSettings.create(/** @type {any} */ (null), ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.insightSettings.create({ key: '' }, ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.insightSettings.create({ key: 'NEXT_STEP', title: 'Next step', prompt: 'do it' }, ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.insightSettings.create({ key: 'NEXT_STEP', title: 'Next step', prompt: 'do it', valueType: 'bogus' }, ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0, 'no transport before validation passes');

  const res = await mgmt.insightSettings.create(
    { key: SETTING.key, title: SETTING.title, prompt: SETTING.prompt, valueType: SETTING.valueType },
    ADMIN_KS,
  );
  assert.equal(res.key, 'NEXT_STEP');
  assert.match(ff.calls[0].url, /insight-settings\/create$/);
  assert.deepEqual(ff.calls[0].body, { key: SETTING.key, title: SETTING.title, prompt: SETTING.prompt, valueType: SETTING.valueType });
});

test('insightSettings.get fetches by id; requires a non-empty string id', async () => {
  const { mgmt, ff } = harness([
    { match: 'insight-settings/get', respond: (req) => ({ status: 200, body: { ...SETTING, id: req.body.id } }) },
  ]);
  await assert.rejects(() => mgmt.insightSettings.get('', ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0);

  const res = await mgmt.insightSettings.get(SETTING.id, ADMIN_KS);
  assert.equal(res.id, SETTING.id);
  assert.equal(ff.calls[0].body.id, SETTING.id);
});

test('insightSettings.list uses the {offset,limit} pager, passes filter + orderBy through', async () => {
  const { mgmt, ff } = harness([
    { match: 'insight-settings/list', respond: () => ({ status: 200, body: { totalCount: 1, objects: [SETTING] } }) },
  ]);
  const page = await mgmt.insightSettings.list(ADMIN_KS, { filter: { statusEqual: 'active' }, orderBy: '-createdAt' });
  assert.equal(page.length, 1);
  assert.equal(page[0].id, SETTING.id);
  assert.deepEqual(ff.calls[0].body.filter, { statusEqual: 'active' });
  assert.equal(ff.calls[0].body.orderBy, '-createdAt');
  assert.ok('offset' in ff.calls[0].body.pager && 'limit' in ff.calls[0].body.pager, 'offset/limit pager, not pageIndex/pageSize');
});

test('insightSettings.update validates BEFORE any network call, then posts a patch to insight-settings/update', async () => {
  const { mgmt, ff } = harness([
    { match: 'insight-settings/update', respond: (req) => ({ status: 200, body: { ...SETTING, ...req.body } }) },
  ]);
  await assert.rejects(() => mgmt.insightSettings.update('', { title: 'x' }, ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.insightSettings.update(SETTING.id, /** @type {any} */ (null), ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.insightSettings.update(SETTING.id, {}, ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.insightSettings.update(SETTING.id, { valueType: 'bogus' }, ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.insightSettings.update(SETTING.id, { status: 'bogus' }, ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0, 'no transport before validation passes');

  const res = await mgmt.insightSettings.update(SETTING.id, { status: 'disabled' }, ADMIN_KS);
  assert.equal(res.status, 'disabled');
  assert.deepEqual(ff.calls[0].body, { id: SETTING.id, status: 'disabled' });
});

test('insightSettings.delete requires confirmPermanent, then deletes by id', async () => {
  const { mgmt, ff } = harness([
    { match: 'insight-settings/delete', respond: () => ({ status: 200, body: { success: true } }) },
  ]);
  await assert.rejects(() => mgmt.insightSettings.delete(SETTING.id, ADMIN_KS, /** @type {any} */ ({})), (e) => e.code === 'confirmation_required');
  assert.equal(ff.calls.length, 0, 'no write before confirmation');

  const res = await mgmt.insightSettings.delete(SETTING.id, ADMIN_KS, { confirmPermanent: true });
  assert.equal(res.success, true);
  assert.match(ff.calls.at(-1).url, /insight-settings\/delete$/);
});

test('every insightSettings wire method asserts admin scope (rejects a conversation token)', async () => {
  const { mgmt } = harness([]);
  const convToken = { ks: 'djJ8conv', kind: 'conversation' };
  await assert.rejects(async () => mgmt.insightSettings.create({ key: 'k', title: 't', prompt: 'p', valueType: 'string' }, convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.insightSettings.get(SETTING.id, convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.insightSettings.list(convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.insightSettings.update(SETTING.id, { status: 'disabled' }, convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.insightSettings.delete(SETTING.id, convToken, { confirmPermanent: true }), (e) => e.code === 'wrong_token_scope');
});
