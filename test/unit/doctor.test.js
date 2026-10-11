import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/** `mgmt.doctor`: lifecycle audit + intellect audit per agent + orphans. fakeFetch only. */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);
const scope = (id) => [{ field: 'object.agent_id', operator: 'eq', value: id }];
const pageOf = (all) => (req) => {
  const { offset = 0, limit = 30 } = req.body.pager || {};
  return { body: { objects: all.slice(offset, offset + limit), totalCount: all.length } };
};
const notFound = { status: 404, body: { message: 'not found' } };

const RULES = [
  { id: 'r1', systemName: 'insights', status: 'active', eventType: 'session_ended', objectType: 'thread', eventConditions: scope('a1'), action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: ['s1'] } },
  { id: 'r2', systemName: 'email', status: 'active', eventType: 'analysis_updated', objectType: 'thread', eventConditions: [...scope('a1'), { field: 'changed_keys', operator: 'has_any', value: ['TOPIC'] }], action: { actionType: 'sendInsightEmail', recipients: ['u'], templateId: 'pinned' } },
];
const SETTINGS = [{ id: 's1', key: 'TOPIC', status: 'active' }, { id: 's-orphan', key: 'EXTRA', status: 'active' }];
const AGENTS = [
  { agentId: 'a1', intellect: { id: 10 } },
  { agentId: 'a2', intellect: { id: 10 } },
  { agentId: 'a3', intellect: { id: 11 } },
  { agentId: 'a4' },
];
const TEMPLATES = [
  { id: 'pinned', status: 'enabled', name: 'Pinned', msgParamsMap: {} },
  { id: 'loose', status: 'enabled', name: 'Loose', msgParamsMap: {} },
  { id: 'old', status: 'deleted', msgParamsMap: {} },
];

function harness({ cfg = {}, intellects = { 10: { id: 10, type: 'brain', knowledge_ids: [1, 2] } }, rules = RULES } = {}) {
  const ff = fakeFetch([
    { match: 'lifecycle/list', respond: pageOf(rules) },
    { match: 'insight-settings/list', respond: pageOf(SETTINGS) },
    { match: 'agent/list', respond: pageOf(AGENTS) },
    { match: 'email-template/list', respond: pageOf(TEMPLATES) },
    { match: 'email-template/get', respond: (req) => { const t = TEMPLATES.find((x) => x.id === req.body.id); return t ? { body: t } : notFound; } },
    { match: 'v1/intellect/get', respond: (req) => (intellects[req.body.id] ? { body: intellects[req.body.id] } : notFound) },
  ]);
  return { mgmt: new Management({ partnerId: '123', fetch: ff, ...cfg }), ff };
}

test('doctor merges lifecycle findings, intellect findings and orphans', async () => {
  const { mgmt, ff } = harness();
  const report = await mgmt.doctor(ADMIN_KS);
  const by = (code) => report.findings.filter((f) => f.code === code);

  assert.equal(by('knowledge_ids_over_cap').length, 1, 'shared intellect audited once');
  assert.equal(by('knowledge_ids_over_cap')[0].agentId, 'a1', 'finding names the first agent that uses it');
  assert.equal(by('intellect_not_found').length, 1);
  assert.equal(by('intellect_not_found')[0].agentId, 'a3');
  assert.equal(by('intellect_not_found')[0].configId, 11);
  assert.deepEqual(by('orphan_insight_setting').map((f) => f.severity), ['info']);
  assert.match(by('orphan_insight_setting')[0].message, /s-orphan/);
  assert.deepEqual(by('orphan_email_template').map((f) => f.message.includes('loose')), [true], 'only the loose, non-deleted template');
  assert.equal(by('agent_not_found').length, 0);
  assert.equal(report.checked.agentIntellects, 2);
  assert.equal(report.checked.rules, 2);
  assert.deepEqual(report.skipped, []);
  assert.deepEqual(report.summary, { error: 2, warn: 0, info: 2 });
  for (const c of ff.calls) assert.match(c.url, /\/(list|get)$/, 'read-only');
});

test('doctor({agentIds}) limits to those agents and skips orphan checks', async () => {
  const { mgmt } = harness();
  const report = await mgmt.doctor(ADMIN_KS, { agentIds: ['a3'] });
  assert.deepEqual(report.findings.map((f) => f.code), ['intellect_not_found']);
  assert.equal(report.checked.agentIntellects, 1);
});

test('doctor degrades when the messaging host is unavailable', async () => {
  const { mgmt, ff } = harness({ cfg: { region: 'frp2' } });
  const report = await mgmt.doctor(ADMIN_KS);
  assert.deepEqual(report.skipped, ['templates']);
  assert.equal(report.findings.some((f) => f.code === 'orphan_email_template' || f.code.startsWith('template_')), false);
  assert.equal(ff.calls.some((c) => c.url.includes('email-template')), false);
  assert.ok(report.findings.some((f) => f.code === 'orphan_insight_setting'), 'other checks still run');
});

test('doctor lets non-region template errors through', async () => {
  const ff = fakeFetch([
    { match: 'lifecycle/list', respond: pageOf([]) },
    { match: 'insight-settings/list', respond: pageOf([]) },
    { match: 'agent/list', respond: pageOf([]) },
    { match: 'email-template/list', respond: () => ({ status: 500, body: { message: 'boom' } }) },
  ]);
  const mgmt = new Management({ partnerId: '123', fetch: ff });
  await assert.rejects(() => mgmt.doctor(ADMIN_KS));
});

test('doctor needs an admin token', async () => {
  const { mgmt, ff } = harness();
  await assert.rejects(() => mgmt.doctor({ ks: 'x', kind: 'conversation' }), (e) => e.code === 'wrong_token_scope');
  assert.equal(ff.calls.length, 0);
});
