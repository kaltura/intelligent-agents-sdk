import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/**
 * Lifecycle resource (wire, `/lifecycle/*`, agentic-hosted, `{offset,limit}`
 * pager) — create returns `status:"active"` immediately,
 * delete replies `{success:boolean}`, match's `eventData` must be
 * `{object?, changed_keys?}` (not a bare `object` field), list needs the
 * `{offset,limit}` pager (NOT Genie's `{pageIndex,pageSize}`).
 */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);

/** Build a Management whose agentic calls hit fakeFetch with the supplied routes. */
function harness(routes) {
  const ff = fakeFetch(routes);
  const mgmt = new Management({ partnerId: '123', fetch: ff });
  return { mgmt, ff };
}

const RULE = {
  id: '507f1f77bcf86cd799439011', partnerId: 123, name: 'Summarize after call', systemName: 'summarize_after_call',
  status: 'active', eventType: 'session_ended', objectType: 'thread', eventConditions: [],
  action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: ['68b0000000000000000000a1'] },
  createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z', createdBy: 'user-1',
};

test('lifecycle.create validates {name, systemName, eventType, objectType, action} BEFORE any network call, then posts lifecycle/create', async () => {
  const { mgmt, ff } = harness([
    { match: 'lifecycle/create', respond: (req) => ({ status: 200, body: { ...RULE, ...req.body } }) },
  ]);
  await assert.rejects(() => mgmt.lifecycle.create(/** @type {any} */ (null), ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.lifecycle.create({ name: '' }, ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.lifecycle.create({ name: 'x', systemName: 's', eventType: 'session_ended', objectType: 'thread' }, ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0, 'no transport before validation passes');

  const res = await mgmt.lifecycle.create(
    { name: 'Summarize after call', systemName: 'summarize_after_call', eventType: 'session_ended', objectType: 'thread', action: RULE.action },
    ADMIN_KS,
  );
  assert.equal(res.systemName, 'summarize_after_call');
  assert.match(ff.calls[0].url, /lifecycle\/create$/);
  assert.deepEqual(ff.calls[0].body, {
    name: 'Summarize after call', systemName: 'summarize_after_call', eventType: 'session_ended', objectType: 'thread', action: RULE.action,
  });
});

test('lifecycle.create passes eventConditions through when given', async () => {
  const { mgmt, ff } = harness([
    { match: 'lifecycle/create', respond: (req) => ({ status: 200, body: { ...RULE, ...req.body } }) },
  ]);
  const conditions = [{ field: 'object.agent_id', operator: 'eq', value: 'uuid-1' }];
  await mgmt.lifecycle.create(
    { name: 'x', systemName: 's', eventType: 'session_ended', objectType: 'thread', eventConditions: conditions, action: RULE.action },
    ADMIN_KS,
  );
  assert.deepEqual(ff.calls[0].body.eventConditions, conditions);
});

test('lifecycle.get fetches by id; requires a non-empty string id', async () => {
  const { mgmt, ff } = harness([
    { match: 'lifecycle/get', respond: (req) => ({ status: 200, body: { ...RULE, id: req.body.id } }) },
  ]);
  await assert.rejects(() => mgmt.lifecycle.get('', ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0);

  const res = await mgmt.lifecycle.get(RULE.id, ADMIN_KS);
  assert.equal(res.id, RULE.id);
  assert.equal(ff.calls[0].body.id, RULE.id);
});

test('lifecycle.list uses the {offset,limit} pager (NOT Genie pageIndex/pageSize), passes filter + orderBy through', async () => {
  const { mgmt, ff } = harness([
    { match: 'lifecycle/list', respond: () => ({ status: 200, body: { totalCount: 1, objects: [RULE] } }) },
  ]);
  const page = await mgmt.lifecycle.list(ADMIN_KS, { filter: { actionTypeIn: ['sendInsightEmail'] }, orderBy: '-createdAt' });
  assert.equal(page.length, 1);
  assert.equal(page[0].id, RULE.id);
  assert.deepEqual(ff.calls[0].body.filter, { actionTypeIn: ['sendInsightEmail'] });
  assert.equal(ff.calls[0].body.orderBy, '-createdAt');
  assert.ok('offset' in ff.calls[0].body.pager && 'limit' in ff.calls[0].body.pager, 'offset/limit pager, not pageIndex/pageSize');
});

test('lifecycle.create rejects a renamed action name BEFORE any network call, naming the replacement', async () => {
  const { mgmt, ff } = harness([]);
  await assert.rejects(
    () => mgmt.lifecycle.create({ name: 'x', systemName: 's', eventType: 'session_ended', objectType: 'thread', action: { actionType: 'triggerInsight', insights: [] } }, ADMIN_KS),
    (e) => e.code === 'bad_request' && /triggerInsightSettingsKai/.test(e.detail),
  );
  await assert.rejects(
    () => mgmt.lifecycle.create({ name: 'x', systemName: 's', eventType: 'session_ended', objectType: 'thread', action: { actionType: 'triggerDataToCollectInsight' } }, ADMIN_KS),
    (e) => e.code === 'bad_request' && /triggerDtcKai/.test(e.detail),
  );
  await assert.rejects(
    () => mgmt.lifecycle.create({ name: 'x', systemName: 's', eventType: 'session_ended', objectType: 'thread', action: { actionType: 'triggerOverridableSummaryInsight' } }, ADMIN_KS),
    (e) => e.code === 'bad_request',
  );
  assert.equal(ff.calls.length, 0, 'no transport for any renamed action type');
});

test('lifecycle.create rejects the system-preset-only action name BEFORE any network call', async () => {
  const { mgmt, ff } = harness([]);
  await assert.rejects(
    () => mgmt.lifecycle.create({ name: 'x', systemName: 's', eventType: 'session_ended', objectType: 'thread', action: { actionType: '_triggerKaiBase' } }, ADMIN_KS),
    (e) => e.code === 'bad_request' && /_triggerKaiBase/.test(e.detail) && /system-seeded preset rule/.test(e.detail),
  );
  assert.equal(ff.calls.length, 0, 'no transport for the system-preset-only action type');
});

test('lifecycle.create accepts triggerDtcKai — it is a normal, caller-creatable action type', async () => {
  const dtcAction = { actionType: 'triggerDtcKai' };
  const { mgmt, ff } = harness([
    { match: 'lifecycle/create', respond: (req) => ({ status: 200, body: { ...RULE, ...req.body } }) },
  ]);
  const res = await mgmt.lifecycle.create(
    { name: 'Scope DTC to one agent', systemName: 'scope_dtc_to_agent', eventType: 'session_ended', objectType: 'thread', eventConditions: [{ field: 'object.agent_id', operator: 'eq', value: 'uuid-1' }], action: dtcAction },
    ADMIN_KS,
  );
  assert.equal(res.systemName, 'scope_dtc_to_agent');
  assert.deepEqual(ff.calls[0].body.action, dtcAction);
});

test('lifecycle.update rejects the system-preset-only action name in patch.action BEFORE any network call', async () => {
  const { mgmt, ff } = harness([]);
  await assert.rejects(
    () => mgmt.lifecycle.update(RULE.id, { action: { actionType: '_triggerKaiBase' } }, ADMIN_KS),
    (e) => e.code === 'bad_request' && /_triggerKaiBase/.test(e.detail),
  );
  assert.equal(ff.calls.length, 0);
});

test('lifecycle.update rejects a renamed action name in patch.action BEFORE any network call', async () => {
  const { mgmt, ff } = harness([]);
  await assert.rejects(
    () => mgmt.lifecycle.update(RULE.id, { action: { actionType: 'triggerInsight', insights: [] } }, ADMIN_KS),
    (e) => e.code === 'bad_request' && /triggerInsightSettingsKai/.test(e.detail),
  );
  assert.equal(ff.calls.length, 0);
});

test('lifecycle.update validates BEFORE any network call, then posts a patch to lifecycle/update', async () => {
  const { mgmt, ff } = harness([
    { match: 'lifecycle/update', respond: (req) => ({ status: 200, body: { ...RULE, ...req.body } }) },
  ]);
  await assert.rejects(() => mgmt.lifecycle.update('', { name: 'x' }, ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.lifecycle.update(RULE.id, /** @type {any} */ (null), ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.lifecycle.update(RULE.id, {}, ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0, 'no transport before validation passes');

  const res = await mgmt.lifecycle.update(RULE.id, { status: 'inactive' }, ADMIN_KS);
  assert.equal(res.status, 'inactive');
  assert.deepEqual(ff.calls[0].body, { id: RULE.id, status: 'inactive' });
});

test('lifecycle.delete requires confirmPermanent, then deletes by id, returning {removed, success, _meta} (no in-use scan)', async () => {
  const { mgmt, ff } = harness([
    { match: 'lifecycle/delete', respond: () => ({ status: 200, body: { success: true } }) },
  ]);
  await assert.rejects(() => mgmt.lifecycle.delete(RULE.id, ADMIN_KS, /** @type {any} */ ({})), (e) => e.code === 'confirmation_required');
  assert.equal(ff.calls.length, 0, 'no write before confirmation');

  const res = await mgmt.lifecycle.delete(RULE.id, ADMIN_KS, { confirmPermanent: true });
  assert.equal(res.removed, RULE.id);
  assert.equal(res.success, true);
  assert.match(res._meta.generatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(res._meta.scope, `lifecycle:${RULE.id}`);
  assert.match(ff.calls.at(-1).url, /lifecycle\/delete$/);
});

test('lifecycle.match rejects a bare {object} shape outside eventData BEFORE any network call, requires eventData object', async () => {
  const { mgmt, ff } = harness([]);
  await assert.rejects(() => mgmt.lifecycle.match('thread', 'session_ended', /** @type {any} */ (null), ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.lifecycle.match('thread', 'session_ended', /** @type {any} */ ('not-an-object'), ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0);
});

test('lifecycle.match posts {objectType, eventType, eventData} and returns matchedRules[] (grouped preset + custom rule)', async () => {
  const { mgmt, ff } = harness([
    {
      match: 'lifecycle/match',
      respond: () => ({
        status: 200,
        body: {
          matchedRules: [
            {
              isGrouped: true, groupKey: '_system_grouped_kai_insights',
              rules: [
                { id: 'preset__summary_on_session_ended', systemName: 'summary_on_session_ended', action: { actionType: '_triggerKaiBase' } },
                RULE,
              ],
            },
          ],
        },
      }),
    },
  ]);
  const res = await mgmt.lifecycle.match('thread', 'session_ended', { object: { thread_id: 't1' }, changed_keys: ['SESSIONSUMMARY'] }, ADMIN_KS);
  assert.equal(res.matchedRules.length, 1);
  assert.equal(res.matchedRules[0].isGrouped, true);
  assert.equal(res.matchedRules[0].rules.some((r) => r.id.startsWith('preset__')), true);
  assert.deepEqual(ff.calls[0].body, {
    objectType: 'thread', eventType: 'session_ended', eventData: { object: { thread_id: 't1' }, changed_keys: ['SESSIONSUMMARY'] },
  });
});

test('lifecycle.listObjects/listEvents/describeFields are one-call READ passthroughs', async () => {
  const { mgmt, ff } = harness([
    { match: 'lifecycle/listObjects', respond: () => ({ status: 200, body: { objects: [{ objectType: 'thread', description: 'A conversation thread' }] } }) },
    { match: 'lifecycle/listEvents', respond: (req) => ({ status: 200, body: { objectType: req.body.objectType, events: [{ eventType: 'session_ended', description: 'Fired when a session ends' }] } }) },
    { match: 'lifecycle/describeFields', respond: (req) => ({ status: 200, body: { objectType: req.body.objectType, eventType: req.body.eventType, fields: [{ path: 'object.status', type: 'number', description: 'status' }] } }) },
  ]);
  const objects = await mgmt.lifecycle.listObjects(ADMIN_KS);
  assert.deepEqual(objects.objects[0].objectType, 'thread');

  const events = await mgmt.lifecycle.listEvents('thread', ADMIN_KS);
  assert.equal(events.objectType, 'thread');
  assert.equal(ff.calls.find((c) => c.url.includes('lifecycle/listEvents')).body.objectType, 'thread');

  const fields = await mgmt.lifecycle.describeFields('thread', 'session_ended', ADMIN_KS);
  assert.equal(fields.eventType, 'session_ended');
  assert.deepEqual(ff.calls.find((c) => c.url.includes('lifecycle/describeFields')).body, { objectType: 'thread', eventType: 'session_ended' });
});

test('every lifecycle wire method asserts admin scope (rejects a conversation token)', async () => {
  const { mgmt } = harness([]);
  const convToken = { ks: 'djJ8conv', kind: 'conversation' };
  await assert.rejects(async () => mgmt.lifecycle.create({ name: 'x', systemName: 's', eventType: 'session_ended', objectType: 'thread', action: {} }, convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.lifecycle.get(RULE.id, convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.lifecycle.list(convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.lifecycle.update(RULE.id, { status: 'inactive' }, convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.lifecycle.delete(RULE.id, convToken, { confirmPermanent: true }), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.lifecycle.match('thread', 'session_ended', {}, convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.lifecycle.listObjects(convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.lifecycle.listEvents('thread', convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.lifecycle.describeFields('thread', 'session_ended', convToken), (e) => e.code === 'wrong_token_scope');
});
