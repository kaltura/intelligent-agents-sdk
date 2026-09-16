import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/**
 * EmailTemplates resource (wire, `email-template/*`, Kaltura Messaging API,
 * `{offset,limit}` pager, `{objects,totalCount}` list response) — the ONE
 * resource that authenticates with a bare `Authorization: Bearer <KS>`
 * header rather than the `Authorization: KS <ks>` scheme every other
 * resource in this SDK uses.
 */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);

/** Build a Management whose messaging calls hit fakeFetch with the supplied routes. */
function harness(routes) {
  const ff = fakeFetch(routes);
  const mgmt = new Management({ partnerId: '123', fetch: ff });
  return { mgmt, ff };
}

const TEMPLATE = {
  id: '6aaafb1e936767489a395fa1', partnerId: 123, appGuid: 'app-guid-1',
  name: 'Conversation Insight', subject: 'Your conversation insights', body: '<p>{SUMMARY}</p>',
  toAttributePath: '{USER.email}', msgParamsMap: { USER: { type: 'User' }, SUMMARY: { type: 'String' } },
  status: 'enabled', templateType: 'email', version: 1,
  createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z',
};

test('emailTemplates.create validates required fields BEFORE any network call, then posts email-template/add with a Bearer header', async () => {
  const { mgmt, ff } = harness([
    { match: 'email-template/add', respond: (req) => ({ status: 200, body: { ...TEMPLATE, ...req.body, id: TEMPLATE.id } }) },
  ]);
  await assert.rejects(() => mgmt.emailTemplates.create(/** @type {any} */ (null), ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.emailTemplates.create({ appGuid: 'a' }, ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.emailTemplates.create({ appGuid: 'a', name: 'n', subject: 's', body: 'b', toAttributePath: '{USER.email}' }, ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0, 'no transport before validation passes');

  const res = await mgmt.emailTemplates.create(
    { appGuid: 'app-guid-1', name: 'Conversation Insight', subject: 'Your conversation insights', body: '<p>{SUMMARY}</p>', toAttributePath: '{USER.email}', msgParamsMap: TEMPLATE.msgParamsMap },
    ADMIN_KS,
  );
  assert.equal(res.id, TEMPLATE.id);
  assert.match(ff.calls[0].url, /email-template\/add$/);
  assert.equal(ff.calls[0].headers.authorization, `Bearer ${ADMIN_KS}`);
});

test('emailTemplates.get fetches by id; requires a non-empty string id', async () => {
  const { mgmt, ff } = harness([
    { match: 'email-template/get', respond: (req) => ({ status: 200, body: { ...TEMPLATE, id: req.body.id } }) },
  ]);
  await assert.rejects(() => mgmt.emailTemplates.get('', ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0);

  const res = await mgmt.emailTemplates.get(TEMPLATE.id, ADMIN_KS);
  assert.equal(res.id, TEMPLATE.id);
  assert.equal(ff.calls[0].body.id, TEMPLATE.id);
});

test('emailTemplates.list uses the {offset,limit} pager, passes filter through, reads {objects,totalCount}', async () => {
  const { mgmt, ff } = harness([
    { match: 'email-template/list', respond: () => ({ status: 200, body: { totalCount: 1, objects: [TEMPLATE] } }) },
  ]);
  const page = await mgmt.emailTemplates.list(ADMIN_KS, { filter: { appGuidIn: ['app-guid-1'] } });
  assert.equal(page.length, 1);
  assert.equal(page[0].id, TEMPLATE.id);
  assert.deepEqual(ff.calls[0].body.filter, { appGuidIn: ['app-guid-1'] });
  assert.ok('offset' in ff.calls[0].body.pager && 'limit' in ff.calls[0].body.pager, 'offset/limit pager');
});

test('emailTemplates.update validates BEFORE any network call, then posts a patch to email-template/update', async () => {
  const { mgmt, ff } = harness([
    { match: 'email-template/update', respond: (req) => ({ status: 200, body: { ...TEMPLATE, ...req.body, version: 2 } }) },
  ]);
  await assert.rejects(() => mgmt.emailTemplates.update('', { subject: 'x' }, ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.emailTemplates.update(TEMPLATE.id, /** @type {any} */ (null), ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.emailTemplates.update(TEMPLATE.id, {}, ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0, 'no transport before validation passes');

  const res = await mgmt.emailTemplates.update(TEMPLATE.id, { status: 'disabled' }, ADMIN_KS);
  assert.equal(res.status, 'disabled');
  assert.deepEqual(ff.calls[0].body, { id: TEMPLATE.id, status: 'disabled' });
});

test('emailTemplates.delete requires confirmPermanent, then deletes by id, returning {removed, _meta}', async () => {
  const { mgmt, ff } = harness([
    { match: 'email-template/delete', respond: () => ({ status: 200, body: { ...TEMPLATE, status: 'deleted' } }) },
  ]);
  await assert.rejects(() => mgmt.emailTemplates.delete(TEMPLATE.id, ADMIN_KS, /** @type {any} */ ({})), (e) => e.code === 'confirmation_required');
  assert.equal(ff.calls.length, 0, 'no write before confirmation');

  const res = await mgmt.emailTemplates.delete(TEMPLATE.id, ADMIN_KS, { confirmPermanent: true });
  assert.equal(res.removed, TEMPLATE.id);
  assert.match(res._meta.generatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(res._meta.scope, `emailTemplate:${TEMPLATE.id}`);
  assert.match(ff.calls.at(-1).url, /email-template\/delete$/);
});

test('every emailTemplates wire method asserts admin scope (rejects a conversation token)', async () => {
  const { mgmt } = harness([]);
  const convToken = { ks: 'djJ8conv', kind: 'conversation' };
  await assert.rejects(async () => mgmt.emailTemplates.create({ appGuid: 'a', name: 'n', subject: 's', body: 'b', toAttributePath: '{USER.email}', msgParamsMap: {} }, convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.emailTemplates.get(TEMPLATE.id, convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.emailTemplates.list(convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.emailTemplates.update(TEMPLATE.id, { status: 'disabled' }, convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.emailTemplates.delete(TEMPLATE.id, convToken, { confirmPermanent: true }), (e) => e.code === 'wrong_token_scope');
});
