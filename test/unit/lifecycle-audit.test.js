import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';
import { auditLifecycleRules, MAX_INSIGHT_SETTINGS_PER_RULE } from '../../src/management/lifecycle-audit.js';
import { isNotFound } from '../../src/management/audit-report.js';
import { hasAgentScope, scopedAgentIds, changedKeysFilter, hasEmailTrigger, isAgentCondition } from '../../src/management/lifecycle-rules.js';

/**
 * Lifecycle audit: the pure `auditLifecycleRules` (one table row per finding
 * code, plain objects) and `mgmt.lifecycle.audit` (fakeFetch, pagination,
 * the `region_unavailable` degrade).
 */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);

const scope = (...ids) => (ids.length === 1
  ? [{ field: 'object.agent_id', operator: 'eq', value: ids[0] }]
  : [{ field: 'object.agent_id', operator: 'in', value: ids }]);
const changed = (operator, value) => ({ field: 'changed_keys', operator, value });

const SETTINGS = [
  { id: 's1', key: 'TOPIC', status: 'active' },
  { id: 's2', key: 'CUSTOM', status: 'active' },
  { id: 's3', key: 'OFF', status: 'disabled' },
];
const AGENTS = [{ agentId: 'a1' }, { agentId: 'a2' }];

/** Writes TOPIC and CUSTOM for a1, and SUMMARY comes free. */
const PRODUCER = {
  id: 'p1', systemName: 'producer', status: 'active', eventType: 'session_ended', objectType: 'thread',
  eventConditions: scope('a1'), action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: ['s1', 's2'] },
};

const emailRule = (over = {}) => ({
  id: 'r1', systemName: 'email', status: 'active', eventType: 'analysis_updated', objectType: 'thread',
  eventConditions: [...scope('a1'), changed('has_all', ['SUMMARY', 'TOPIC', 'CUSTOM'])],
  action: { actionType: 'sendInsightEmail', recipients: ['u1'], presetType: 'conversationInsightExample' },
  ...over,
});
const insightRule = (over = {}) => ({
  id: 'r1', systemName: 'insights', status: 'active', eventType: 'session_ended', objectType: 'thread',
  eventConditions: scope('a1'), action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: ['s1'] },
  ...over,
});
const dtcRule = (over = {}) => ({
  id: 'r1', systemName: 'dtc', status: 'active', eventType: 'session_ended', objectType: 'thread',
  eventConditions: scope('a1'), action: { actionType: 'triggerDtcKai' },
  ...over,
});

const TEMPLATE = { id: 't1', status: 'enabled', msgParamsMap: { recipient: { type: 'User' }, SUMMARY: { type: 'String' }, TOPIC: { type: 'String' }, AGENTNAME: { type: 'String' } } };

/** Audit with PRODUCER present and return the codes found on rule `r1`. */
function codesFor(rule, { extra = [], ...ctx } = {}, extraRules = [PRODUCER]) {
  const findings = auditLifecycleRules([rule, ...extraRules, ...extra], { insightSettings: SETTINGS, agents: AGENTS, emailTemplates: [TEMPLATE], ...ctx });
  for (const f of findings) {
    assert.ok(f.message && f.fix, `${f.code} has a message and a fix`);
    assert.ok(['error', 'warn', 'info'].includes(f.severity));
  }
  return findings.filter((f) => f.ruleId === 'r1').map((f) => f.code);
}

/** [name, rule, ctx, expected codes on r1] */
const TABLE = [
  ['unscoped_rule: thread rule with no agent condition', insightRule({ eventConditions: [] }), {}, ['unscoped_rule']],
  ['unscoped_rule: blank agent id does not count', insightRule({ eventConditions: [{ field: 'object.agent_id', operator: 'eq', value: ' ' }] }), {}, ['unscoped_rule']],
  ['unscoped_rule: other object types are not flagged', insightRule({ objectType: 'other', eventConditions: [] }), {}, []],
  ['agent_not_found', insightRule({ eventConditions: scope('ghost') }), {}, ['agent_not_found']],
  ['agent_not_found: "default" is exempt', insightRule({ eventConditions: scope('default') }), {}, []],
  ['agent_not_found: one finding per missing id in an `in` list', insightRule({ eventConditions: scope('a1', 'ghost', 'phantom') }), {}, ['agent_not_found', 'agent_not_found']],
  ['duplicate_agent_ids', insightRule({ eventConditions: scope('a1', 'a1') }), {}, ['duplicate_agent_ids']],
  ['insight_setting_missing', insightRule({ action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: ['s1', 'gone'] } }), {}, ['insight_setting_missing']],
  ['insight_setting_disabled', insightRule({ action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: ['s3'] } }), {}, ['insight_setting_disabled']],
  ['too_many_insight_settings: over the limit', insightRule({ action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: Array(MAX_INSIGHT_SETTINGS_PER_RULE + 1).fill('s1') } }), {}, ['too_many_insight_settings']],
  ['too_many_insight_settings: exactly the limit is fine', insightRule({ action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: Array(MAX_INSIGHT_SETTINGS_PER_RULE).fill('s1') } }), {}, []],
  ['email_on_session_ended', emailRule({ eventType: 'session_ended' }), {}, ['email_on_session_ended']],
  ['email_unfiltered', emailRule({ eventConditions: scope('a1') }), {}, ['email_unfiltered']],
  ['email_unfiltered: an empty changed_keys list does not count', emailRule({ eventConditions: [...scope('a1'), changed('has_all', [])] }), {}, ['email_unfiltered']],
  ['changed_keys_unproduced: has_all with one unproduced key', emailRule({ eventConditions: [...scope('a1'), changed('has_all', ['SUMMARY', 'NOPE'])] }), {}, ['changed_keys_unproduced']],
  ['changed_keys_unproduced: keys are case-sensitive', emailRule({ eventConditions: [...scope('a1'), changed('has_all', ['summary'])] }), {}, ['changed_keys_unproduced']],
  ['changed_keys_unproduced: has_any is fine when one key is produced', emailRule({ eventConditions: [...scope('a1'), changed('has_any', ['NOPE', 'TOPIC'])] }), {}, []],
  ['changed_keys_unproduced: has_any with no produced key', emailRule({ eventConditions: [...scope('a1'), changed('has_any', ['NOPE'])] }), {}, ['changed_keys_unproduced']],
  ['changed_keys_unproduced: a producer on another agent does not count', emailRule({ eventConditions: [...scope('a2'), changed('has_all', ['TOPIC'])] }), {}, ['changed_keys_unproduced', 'template_tokens_unproduced']],
  ['changed_keys_unproduced: an unscoped producer covers every agent', emailRule({ eventConditions: [...scope('a2'), changed('has_all', ['TOPIC', 'CUSTOM'])] }), { extra: [{ ...PRODUCER, id: 'p2', eventConditions: [] }] }, []],
  ['template_missing_or_deleted: unknown id', emailRule({ action: { actionType: 'sendInsightEmail', recipients: ['u1'], templateId: 'gone' } }), {}, ['template_missing_or_deleted']],
  ['template_missing_or_deleted: deleted template', emailRule({ action: { actionType: 'sendInsightEmail', recipients: ['u1'], templateId: 't1' } }), { emailTemplates: [{ ...TEMPLATE, status: 'deleted' }] }, ['template_missing_or_deleted']],
  ['template_missing_or_deleted: a disabled template is not flagged', emailRule({ action: { actionType: 'sendInsightEmail', recipients: ['u1'], templateId: 't1' } }), { emailTemplates: [{ ...TEMPLATE, status: 'disabled' }] }, []],
  ['template_missing_or_deleted: skipped when templates are unavailable', emailRule({ action: { actionType: 'sendInsightEmail', recipients: ['u1'], templateId: 'gone' } }), { emailTemplates: null }, []],
  ['template_tokens_unproduced: template needs a key nobody writes', emailRule({ eventConditions: scope('a1'), action: { actionType: 'sendInsightEmail', recipients: ['u1'], templateId: 't1' } }), { emailTemplates: [{ ...TEMPLATE, msgParamsMap: { ...TEMPLATE.msgParamsMap, MISSING: { type: 'String' } } }] }, ['email_unfiltered', 'template_tokens_unproduced']],
  ['template_tokens_unproduced: auto-filled and non-String tokens are ignored', emailRule({ action: { actionType: 'sendInsightEmail', recipients: ['u1'], templateId: 't1' } }), {}, []],
  ['template_tokens_unproduced: preset needs TOPIC and CUSTOM', emailRule({ eventConditions: [...scope('a1'), changed('has_all', ['SUMMARY'])] }), {}, []],
  ['dtc_without_forms: empty forms', dtcRule(), { intellects: { a1: { user_properties_forms: [] } } }, ['dtc_without_forms']],
  ['dtc_without_forms: no forms field', dtcRule(), { intellects: { a1: {} } }, ['dtc_without_forms']],
  ['dtc_without_forms: forms present', dtcRule(), { intellects: { a1: { user_properties_forms: [{ call_stage: 'start', properties: [{ key: 'name', type: 'str' }] }] } } }, []],
  ['dtc_without_forms: unreadable intellect is not flagged', dtcRule(), { intellects: { a1: null } }, []],
  ['dtc_without_forms: skipped without intellects', dtcRule(), {}, []],
  ['rule_disabled: only that finding', insightRule({ status: 'disabled', eventConditions: [], action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: ['gone'] } }), {}, ['rule_disabled']],
  ['clean email rule reports nothing', emailRule(), {}, []],
  ['clean insight rule reports nothing', insightRule(), {}, []],
];

for (const [name, rule, ctx, expected] of TABLE) {
  test(`auditLifecycleRules: ${name}`, () => {
    assert.deepEqual(codesFor(rule, ctx).sort(), [...expected].sort());
  });
}

test('auditLifecycleRules: severities are error for broken rules, warn for probable mistakes, info for notes', () => {
  const sev = (rule, code, ctx = {}) => auditLifecycleRules([rule, PRODUCER], { insightSettings: SETTINGS, agents: AGENTS, emailTemplates: [TEMPLATE], ...ctx }).find((f) => f.code === code && f.ruleId === 'r1').severity;
  assert.equal(sev(emailRule({ eventType: 'session_ended' }), 'email_on_session_ended'), 'error');
  assert.equal(sev(emailRule({ action: { actionType: 'sendInsightEmail', recipients: ['u'], templateId: 'gone' } }), 'template_missing_or_deleted'), 'error');
  assert.equal(sev(insightRule({ action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: Array(21).fill('s1') } }), 'too_many_insight_settings'), 'error');
  assert.equal(sev(insightRule({ eventConditions: [] }), 'unscoped_rule'), 'warn');
  assert.equal(sev(emailRule({ eventConditions: scope('a1') }), 'email_unfiltered'), 'warn');
  assert.equal(sev(insightRule({ status: 'disabled' }), 'rule_disabled'), 'info');
  assert.equal(sev(insightRule({ eventConditions: scope('a1', 'a1') }), 'duplicate_agent_ids'), 'info');
});

test('auditLifecycleRules: findings carry ruleId and systemName', () => {
  const [f] = auditLifecycleRules([insightRule({ eventConditions: [] })], { insightSettings: SETTINGS, agents: AGENTS });
  assert.equal(f.ruleId, 'r1');
  assert.equal(f.systemName, 'insights');
});

test('auditLifecycleRules: a disabled producer or a disabled insight setting writes nothing', () => {
  const rule = emailRule({ eventConditions: [...scope('a1'), changed('has_all', ['TOPIC'])] });
  const off = { ...PRODUCER, status: 'disabled' };
  assert.ok(codesFor(rule, {}, [off]).includes('changed_keys_unproduced'));
  const offSettings = [{ id: 's1', key: 'TOPIC', status: 'disabled' }, SETTINGS[1]];
  const findings = auditLifecycleRules([rule, PRODUCER], { insightSettings: offSettings, agents: AGENTS });
  assert.ok(findings.some((f) => f.ruleId === 'r1' && f.code === 'changed_keys_unproduced'));
});

test('auditLifecycleRules: an overlapping triggerDtcKai rule skips the key checks', () => {
  const dtc = dtcRule({ id: 'd1' });
  assert.deepEqual(codesFor(emailRule({ eventConditions: [...scope('a1'), changed('has_all', ['NOPE'])] }), {}, [dtc]), []);
  // A DTC rule on another agent does not hide the problem.
  assert.deepEqual(codesFor(emailRule({ eventConditions: [...scope('a1'), changed('has_all', ['NOPE'])] }), {}, [PRODUCER, dtcRule({ id: 'd1', eventConditions: scope('a2') })]), ['changed_keys_unproduced']);
});

test('auditLifecycleRules: preset rules are never reported, and odd input does not throw', () => {
  const preset = { id: 'preset__summary_on_session_ended', eventType: 'session_ended', objectType: 'thread', eventConditions: [], action: { actionType: '<system-internal>' } };
  assert.deepEqual(auditLifecycleRules([preset], { insightSettings: [], agents: [] }), []);
  assert.deepEqual(auditLifecycleRules(/** @type {any} */ (null), { insightSettings: [], agents: [] }), []);
  assert.doesNotThrow(() => auditLifecycleRules([{ id: 'x' }, null, { id: 'y', action: 'bad', eventConditions: 'bad' }].filter(Boolean), { insightSettings: [], agents: [] }));
});

test('lifecycle-rules predicates match the create/update guards', () => {
  assert.equal(isAgentCondition({ field: 'object.agent_id', operator: 'eq', value: 'a' }), true);
  assert.equal(isAgentCondition({ field: 'object.agent_id', operator: 'in', value: [] }), false);
  assert.equal(isAgentCondition({ field: 'object.agent_id', operator: 'ne', value: 'a' }), false);
  assert.equal(isAgentCondition(null), false);
  assert.equal(hasAgentScope(scope('a')), true);
  assert.equal(hasAgentScope('nope'), false);
  assert.deepEqual(scopedAgentIds(scope('a', 'b')), ['a', 'b']);
  assert.deepEqual(scopedAgentIds(scope('a')), ['a']);
  assert.deepEqual(scopedAgentIds([]), []);
  assert.deepEqual(scopedAgentIds(undefined), []);
  assert.equal(changedKeysFilter([changed('has_any', ['K'])]).operator, 'has_any');
  assert.equal(changedKeysFilter([changed('eq', ['K'])]), undefined);
  assert.equal(changedKeysFilter('nope'), undefined);
  assert.equal(hasEmailTrigger([changed('has_all', ['K'])]), true);
  assert.equal(hasEmailTrigger([changed('has_all', [''])]), false);
});

test('isNotFound accepts a 404, a *not_found code, and a *_NOT_FOUND title', () => {
  assert.equal(isNotFound({ status: 404 }), true);
  assert.equal(isNotFound({ code: 'not_found' }), true);
  assert.equal(isNotFound({ code: 'api_exception', status: 200, title: 'TEMPLATE_NOT_FOUND' }), true);
  assert.equal(isNotFound({ code: 'api_exception', status: 200, title: 'LIFECYCLE_RULE_NOT_FOUND' }), true);
  assert.equal(isNotFound({ code: 'api_exception', status: 200, title: 'SOMETHING_ELSE' }), false);
  assert.equal(isNotFound({ status: 500 }), false);
  assert.equal(isNotFound(undefined), false);
});

// ---- lifecycle.audit (wire) ----

/** A page of `list` results, honoring the offset/limit pager. */
const pageOf = (all) => (req) => {
  const { offset = 0, limit = 30 } = req.body.pager || {};
  return { body: { objects: all.slice(offset, offset + limit), totalCount: all.length } };
};

function harness({ rules = [], settings = SETTINGS, agents = [], routes = [], cfg = {} } = {}) {
  const ff = fakeFetch([
    { match: 'lifecycle/list', respond: pageOf(rules) },
    { match: 'insight-settings/list', respond: pageOf(settings) },
    { match: 'agent/list', respond: pageOf(agents) },
    ...routes,
  ]);
  return { mgmt: new Management({ partnerId: '123', fetch: ff, ...cfg }), ff };
}

test('lifecycle.audit reads every page of rules and reports the summary', async () => {
  const rules = [
    PRODUCER,
    insightRule({ id: 'r1', eventConditions: [] }),
    insightRule({ id: 'r2', eventConditions: scope('ghost') }),
  ];
  const { mgmt, ff } = harness({ rules, agents: [{ agentId: 'a1' }, { agentId: 'a2' }, { agentId: 'a3' }] });
  const report = await mgmt.lifecycle.audit(ADMIN_KS, { pageSize: 2 });
  const listCalls = ff.calls.filter((c) => c.url.endsWith('lifecycle/list'));
  assert.deepEqual(listCalls.map((c) => c.body.pager), [{ offset: 0, limit: 2 }, { offset: 2, limit: 2 }]);
  assert.deepEqual(report.findings.map((f) => f.code).sort(), ['agent_not_found', 'unscoped_rule']);
  assert.deepEqual(report.summary, { error: 0, warn: 2, info: 0 });
  assert.equal(report.checked.rules, 3);
  assert.equal(report.checked.insightSettings, 3);
  assert.equal(report.checked.agents, 3);
  assert.deepEqual(report.skipped, []);
});

test('lifecycle.audit is read-only: only list/get calls', async () => {
  const { mgmt, ff } = harness({ rules: [PRODUCER], agents: AGENTS });
  await mgmt.lifecycle.audit(ADMIN_KS);
  assert.ok(ff.calls.length > 0);
  for (const c of ff.calls) assert.match(c.url, /\/(list|get)$/);
});

test('lifecycle.audit reads each pinned template by id and flags a deleted or missing one', async () => {
  const pin = (id) => ({ actionType: 'sendInsightEmail', recipients: ['u'], templateId: id });
  const rules = [PRODUCER, emailRule({ id: 'r1', action: pin('t-del') }), emailRule({ id: 'r2', action: pin('t-gone') }), emailRule({ id: 'r3', action: pin('t-del') })];
  const { mgmt, ff } = harness({
    rules, agents: AGENTS,
    routes: [{ match: 'email-template/get', respond: (req) => (req.body.id === 't-del' ? { body: { id: 't-del', status: 'deleted', msgParamsMap: {} } } : { status: 404, body: { message: 'not found' } }) }],
  });
  const report = await mgmt.lifecycle.audit(ADMIN_KS);
  assert.equal(ff.calls.filter((c) => c.url.endsWith('email-template/get')).length, 2, 'each id read once');
  assert.deepEqual(report.findings.filter((f) => f.code === 'template_missing_or_deleted').map((f) => f.ruleId).sort(), ['r1', 'r2', 'r3']);
  assert.equal(report.checked.emailTemplates, 1);
});

test('lifecycle.audit skips template checks when the region has no messaging host', async () => {
  const rule = emailRule({ id: 'r1', action: { actionType: 'sendInsightEmail', recipients: ['u'], templateId: 'whatever' } });
  const { mgmt, ff } = harness({ rules: [PRODUCER, rule], agents: AGENTS, cfg: { region: 'frp2' } });
  const report = await mgmt.lifecycle.audit(ADMIN_KS);
  assert.deepEqual(report.skipped, ['templates']);
  assert.equal(report.findings.some((f) => f.code.startsWith('template_')), false);
  assert.equal(ff.calls.some((c) => c.url.includes('email-template')), false, 'no request went to a messaging host');
});

test('lifecycle.audit lets other template errors through', async () => {
  const rule = emailRule({ id: 'r1', action: { actionType: 'sendInsightEmail', recipients: ['u'], templateId: 't1' } });
  const { mgmt } = harness({ rules: [PRODUCER, rule], agents: AGENTS, routes: [{ match: 'email-template/get', respond: () => ({ status: 500, body: { message: 'boom' } }) }] });
  await assert.rejects(() => mgmt.lifecycle.audit(ADMIN_KS), (e) => e.code !== 'region_unavailable');
});

test('lifecycle.audit fetches the intellect of each triggerDtcKai agent once, with get', async () => {
  const rules = [dtcRule({ id: 'r1', eventConditions: scope('a1', 'a2', 'a-no-intellect', 'ghost') }), dtcRule({ id: 'r2', eventConditions: scope('a1') })];
  const agents = [
    { agentId: 'a1', intellect: { id: 77 } }, { agentId: 'a2', intellect: { id: 77 } },
    { agentId: 'a-no-intellect' }, { agentId: 'a-unused', intellect: { id: 5 } },
  ];
  const { mgmt, ff } = harness({ rules, agents, routes: [{ match: 'intellect/get', respond: () => ({ body: { id: 77, user_properties_forms: [] } }) }] });
  const report = await mgmt.lifecycle.audit(ADMIN_KS);
  const gets = ff.calls.filter((c) => c.url.endsWith('intellect/get'));
  assert.equal(gets.length, 1, 'one get for the shared intellect, none for unused agents');
  assert.deepEqual(gets[0].body, { id: 77 });
  assert.equal(ff.calls.some((c) => c.url.endsWith('intellect/list')), false, 'never list');
  const dtc = report.findings.filter((f) => f.code === 'dtc_without_forms');
  assert.deepEqual(dtc.map((f) => `${f.ruleId}:${f.agentId}`).sort(), ['r1:a1', 'r1:a2', 'r2:a1']);
});

test('lifecycle.audit treats a missing intellect as unreadable, not as a finding', async () => {
  const { mgmt } = harness({
    rules: [dtcRule()], agents: [{ agentId: 'a1', intellect: { id: 9 } }],
    routes: [{ match: 'intellect/get', respond: () => ({ status: 404, body: { message: 'not found' } }) }],
  });
  assert.deepEqual((await mgmt.lifecycle.audit(ADMIN_KS)).findings, []);
});

test('lifecycle.audit({agentIds}) keeps rules that run for those agents, plus unscoped rules', async () => {
  const rules = [
    insightRule({ id: 'x1', eventConditions: scope('a1', 'ghost') }),
    insightRule({ id: 'x2', eventConditions: scope('a2', 'ghost2') }),
    insightRule({ id: 'x3', eventConditions: [] }),
  ];
  const { mgmt } = harness({ rules, agents: AGENTS });
  const report = await mgmt.lifecycle.audit(ADMIN_KS, { agentIds: ['a1'] });
  assert.deepEqual(report.findings.map((f) => f.ruleId).sort(), ['x1', 'x3']);
});

test('lifecycle.audit needs an admin token', async () => {
  const { mgmt, ff } = harness();
  await assert.rejects(() => mgmt.lifecycle.audit({ ks: 'x', kind: 'conversation' }), (e) => e.code === 'wrong_token_scope');
  assert.equal(ff.calls.length, 0);
});
