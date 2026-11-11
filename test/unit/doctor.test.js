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
  assert.deepEqual(by('knowledge_ids_over_cap')[0].agentIds, ['a1', 'a2'], 'finding names every agent that uses it');
  assert.equal(by('knowledge_ids_over_cap')[0].agentId, undefined);
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

test('doctor turns a failed template read into read_failed and keeps going', async () => {
  const ff = fakeFetch([
    { match: 'lifecycle/list', respond: pageOf([]) },
    { match: 'insight-settings/list', respond: pageOf([{ id: 's-orphan', key: 'X', status: 'active' }]) },
    { match: 'agent/list', respond: pageOf([]) },
    { match: 'email-template/list', respond: () => ({ status: 500, body: { message: 'boom' } }) },
  ]);
  const report = await new Management({ partnerId: '123', fetch: ff }).doctor(ADMIN_KS);
  const failed = report.findings.filter((f) => f.code === 'read_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].severity, 'info');
  assert.equal(failed[0].field, 'orphans');
  assert.match(failed[0].message, /HTTP 500/);
  assert.ok(report.skipped.includes('orphans'));
  assert.ok(report.findings.some((f) => f.code === 'orphan_insight_setting'), 'the settings orphans found before the failure stay');
});

test('doctor: a 401 on any read rejects the run', async () => {
  const ff = fakeFetch([
    { match: 'lifecycle/list', respond: pageOf([]) },
    { match: 'agent/list', respond: pageOf([{ agentId: 'a1', intellect: { id: 10 } }]) },
    { match: 'v1/intellect/get', respond: () => ({ status: 401, body: { message: 'expired' } }) },
  ]);
  await assert.rejects(() => new Management({ partnerId: '123', fetch: ff }).doctor(ADMIN_KS), (e) => e.status === 401);
});

test('doctor needs an admin token', async () => {
  const { mgmt, ff } = harness();
  await assert.rejects(() => mgmt.doctor({ ks: 'x', kind: 'conversation' }), (e) => e.code === 'wrong_token_scope');
  assert.equal(ff.calls.length, 0);
});

test('doctor reports prompt condition findings for a saved intellect', async () => {
  const prompts = [
    { key: 'tpl', headerTemplate: 'T', value: 'v', type: 'custom', condition: '{{ sys__avatar_enabled }}' },
    { key: 'sus', headerTemplate: 'S', value: 'v', type: 'custom', condition: 'plan = "pro"' },
    { key: 'ok', headerTemplate: 'O', value: 'v', type: 'custom', condition: null },
  ];
  const { mgmt } = harness({ intellects: { 10: { id: 10, type: 'brain', prompts } }, rules: [] });
  const report = await mgmt.doctor(ADMIN_KS, { agentIds: ['a1'] });
  const bad = report.findings.find((f) => f.code === 'prompt_bad_condition');
  const suspect = report.findings.find((f) => f.code === 'prompt_suspect_condition');
  assert.equal(bad?.severity, 'error');
  assert.equal(suspect?.severity, 'warn');
  assert.equal(report.findings.filter((f) => /condition/.test(f.code)).length, 2, 'the null condition adds nothing');
});

const rpt = (mgmt, opts) => mgmt.doctor(ADMIN_KS, opts);

test('doctor: a 403 on one intellect becomes read_failed, the others are still checked', async () => {
  const ff = fakeFetch([
    { match: 'lifecycle/list', respond: pageOf([]) },
    { match: 'insight-settings/list', respond: pageOf([]) },
    { match: 'email-template/list', respond: pageOf([]) },
    { match: 'agent/list', respond: pageOf([{ agentId: 'a1', intellect: { id: 10 } }, { agentId: 'a3', intellect: { id: 11 } }]) },
    { match: 'v1/intellect/get', respond: (req) => (req.body.id === 10 ? { status: 403, body: { message: 'no' } } : notFound) },
  ]);
  const report = await rpt(new Management({ partnerId: '123', fetch: ff }));
  const failed = report.findings.find((f) => f.code === 'read_failed');
  assert.equal(failed?.configId, 10);
  assert.match(failed?.message ?? '', /intellects 10/);
  assert.ok(report.skipped.includes('intellects'));
  assert.equal(report.findings.filter((f) => f.code === 'intellect_not_found').length, 1, 'intellect 11 is checked');
  assert.equal(report.findings.some((f) => f.agentId === 'a1' && f.code === 'intellect_not_found'), false, 'unread is not missing');
});

test('doctor: ignore hides matching findings and counts them in summary.suppressed', async () => {
  const { mgmt } = harness();
  const all = await rpt(mgmt);
  const hidden = await rpt(mgmt, { ignore: [{ code: 'orphan_insight_setting' }, { code: 'knowledge_ids_over_cap', agentId: 'a2' }] });
  assert.equal(hidden.findings.some((f) => f.code === 'orphan_insight_setting'), false);
  assert.equal(hidden.findings.some((f) => f.code === 'knowledge_ids_over_cap'), false, 'agentId matches a finding that lists the agent in agentIds');
  assert.equal(hidden.summary.suppressed, all.findings.length - hidden.findings.length);
  assert.equal(all.summary.suppressed, undefined, 'no ignore list, no suppressed key');
  const keep = await rpt(mgmt, { ignore: [{ code: 'orphan_insight_setting', agentId: 'a1' }] });
  assert.equal(keep.summary.suppressed, 0, 'every key must match');
});

test('doctor: a bad ignore list throws before any request', async () => {
  const { mgmt, ff } = harness();
  for (const ignore of ['x', [{}], [{ code: '' }], [null]]) {
    await assert.rejects(() => rpt(mgmt, { ignore }), (e) => e.code === 'bad_request');
  }
  assert.equal(ff.calls.length, 0);
});

test('doctor: findings are sorted by severity, then code, then id, the same on every run', async () => {
  const { mgmt } = harness();
  const a = await rpt(mgmt);
  const b = await rpt(mgmt);
  assert.deepEqual(a.findings, b.findings);
  const rank = { error: 0, warn: 1, info: 2 };
  for (let i = 1; i < a.findings.length; i++) assert.ok(rank[a.findings[i - 1].severity] <= rank[a.findings[i].severity]);
});

test('doctor: only and skip pick groups and checks by id or category', async () => {
  const { mgmt } = harness();
  const onlyOrphans = await rpt(mgmt, { only: ['orphans'] });
  assert.ok(onlyOrphans.findings.length > 0 && onlyOrphans.findings.every((f) => f.code.startsWith('orphan_')));
  const noOrphans = await rpt(mgmt, { skip: ['orphans'] });
  assert.equal(noOrphans.findings.some((f) => f.code.startsWith('orphan_')), false);
  const intellectOnly = await rpt(mgmt, { only: ['intellect'] });
  assert.ok(intellectOnly.findings.some((f) => f.code === 'knowledge_ids_over_cap'));
  const skipBoth = await rpt(mgmt, { only: ['orphans'], skip: ['orphans'] });
  assert.deepEqual(skipBoth.findings, [], 'skip wins');
});

// Agents with avatars: the voice and visual reads.
const VOICE = (language, extra = {}) => ({ itemId: 'v1', type: 'Voice', name: 'Maya', language, ...extra });
function avatarHarness({ voice = VOICE('he'), voiceListed = true, asr = { language: 'en', provider: 'kaltura' }, intellect = { id: 10, type: 'brain', force_language: 'Hebrew' } } = {}) {
  const agents = [{ agentId: 'a1', intellect: { id: 10 }, avatarIds: ['av1'], asr }];
  const ff = fakeFetch([
    { match: 'lifecycle/list', respond: pageOf([]) },
    { match: 'insight-settings/list', respond: pageOf([]) },
    { match: 'email-template/list', respond: pageOf([]) },
    { match: 'agent/list', respond: pageOf(agents) },
    { match: 'v1/intellect/get', respond: () => ({ body: intellect }) },
    { match: 'avatar/list', respond: pageOf([{ id: 'av1', voice: { id: 'v1' }, visual: { id: 'vis1' } }]) },
    { match: 'catalog-item/list', respond: (req) => pageOf(req.body.filter?.typeEqual === 'Voice' ? (voiceListed ? [voice] : []) : [{ itemId: 'vis1', type: 'Visual' }])(req) },
    { match: 'catalog-item/get', respond: (req) => (req.body.itemId === 'v1' ? { body: voice } : notFound) },
  ]);
  return { mgmt: new Management({ partnerId: '123', fetch: ff }), ff };
}

test('doctor: the incident setup (ASR en, Hebrew voice, replies in Hebrew) is one error with a fix', async () => {
  const { mgmt, ff } = avatarHarness();
  const report = await rpt(mgmt);
  assert.deepEqual(report.findings.map((f) => `${f.severity}:${f.code}`), ['error:asr_language_mismatch']);
  assert.equal(report.checked.avatars, 1);
  for (const c of ff.calls) assert.match(c.url, /\/(list|get)$/, 'read-only');
});

test('doctor: a voice scoped to one agent is found by id when the unscoped list misses it', async () => {
  const { mgmt, ff } = avatarHarness({ voiceListed: false });
  const report = await rpt(mgmt);
  assert.equal(report.findings.some((f) => f.code === 'voice_not_in_catalog'), false);
  assert.equal(report.findings.some((f) => f.code === 'asr_language_mismatch'), true, 'the language was read through catalog-item/get');
  assert.ok(ff.calls.some((c) => c.url.endsWith('catalog-item/get')));
});

test('doctor: a clean Hebrew agent gives no findings', async () => {
  const { mgmt } = avatarHarness({ asr: { language: 'he', provider: 'kaltura' } });
  const report = await rpt(mgmt);
  assert.deepEqual(report.findings, []);
});

test('doctor: skipping the avatar checks skips the avatar and catalog reads', async () => {
  const { mgmt, ff } = avatarHarness();
  const report = await rpt(mgmt, { only: ['lifecycle'] });
  assert.deepEqual(report.findings, []);
  assert.equal(ff.calls.some((c) => /\/(avatar|catalog-item|intellect)\//.test(c.url)), false);
});

test('doctor: 500 agents sharing 5 intellects read each intellect once, never more than 4 at a time', async () => {
  const agents = Array.from({ length: 500 }, (_, i) => ({ agentId: `a${i}`, intellect: { id: 100 + (i % 5) } }));
  let inFlight = 0;
  let peak = 0;
  const ff = fakeFetch([
    { match: 'lifecycle/list', respond: pageOf([]) },
    { match: 'insight-settings/list', respond: pageOf([]) },
    { match: 'email-template/list', respond: pageOf([]) },
    { match: 'agent/list', respond: pageOf(agents) },
    { match: 'v1/intellect/get', respond: (req) => { inFlight++; peak = Math.max(peak, inFlight); inFlight--; return { body: { id: req.body.id, type: 'brain' } }; } },
  ]);
  const report = await rpt(new Management({ partnerId: '123', fetch: ff }), { pageSize: 100 });
  assert.equal(ff.calls.filter((c) => c.url.endsWith('v1/intellect/get')).length, 5);
  assert.equal(report.checked.agents, 500);
  assert.equal(report.checked.agentIntellects, 5);
  assert.ok(peak <= 4);
});

test('doctor: agentIds scopes the agent checks and skips the reads the other agents need', async () => {
  const { mgmt, ff } = harness();
  await rpt(mgmt, { agentIds: ['a4'] });
  assert.equal(ff.calls.some((c) => c.url.endsWith('v1/intellect/get')), false, 'a4 has no intellect');
});
