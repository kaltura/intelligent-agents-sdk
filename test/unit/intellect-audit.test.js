import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';
import { auditIntellectConfig } from '../../src/management/intellect-config.js';

/**
 * Intellect audit: the pure `auditIntellectConfig` (one table row per finding
 * code) and `mgmt.intellectConfig.audit` (fakeFetch).
 */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);
const prompt = (value, over = {}) => ({ type: 'custom', key: 'k1', label: 'L', headerTemplate: '## H', value, ...over });
const FORM = { call_stage: 'start', properties: [{ key: 'name', type: 'str' }] };
const base = (over = {}) => ({ id: 7, type: 'brain', ...over });

/** [name, config, ctx, expected finding codes (sorted)] */
const TABLE = [
  ['clean config', base({ prompts: [prompt('Be kind.')], tool_ids: ['t1'], capabilities: { kaltura_genie_experiences: 'off' } }), { tools: [{ id: 't1' }], skills: [] }, []],
  ['external_intellect returns early', { id: 7, type: 'external', tool_ids: ['gone'], knowledge_ids: [1, 2] }, { tools: [] }, ['external_intellect']],
  ['invalid_user_properties_forms', base({ user_properties_forms: [{ call_stage: 'bogus', properties: [] }] }), {}, ['invalid_user_properties_forms']],
  ['valid user_properties_forms', base({ user_properties_forms: [FORM] }), {}, []],
  ['secret_ref_unresolved: prompt names a missing secret', base({ prompts: [prompt('Key {{secrets.TOKEN}}')], secrets: {} }), {}, ['secret_ref_unresolved']],
  ['secret_ref: a known secret is fine', base({ prompts: [prompt('Key {{secrets.TOKEN}}')], secrets: { TOKEN: 'x' } }), {}, []],
  ['secret_ref_bad_prefix', base({ prompts: [prompt('Key {{variables.secrets.TOKEN}}')], secrets: { TOKEN: 'x' } }), {}, ['prompt_client_variable_not_allowed', 'secret_ref_bad_prefix']],
  ['secret_ref_unresolved: found in a tool config', base({ tool_ids: ['t1'], capabilities: { kaltura_genie_experiences: 'off' } }), { tools: [{ id: 't1', config: { request: { headers: { Authorization: 'Bearer {{secrets.API}}' } } } }] }, ['secret_ref_unresolved']],
  ['secret_ref: tool configs the intellect does not use are ignored', base(), { tools: [{ id: 't9', config: { x: '{{secrets.API}}' } }] }, []],
  ['prompt_duplicate_key (lint finding, warn)', base({ prompts: [prompt('a'), prompt('b')] }), {}, ['prompt_duplicate_key']],
  ['prompt_renderer_skip (lint finding, warn)', base({ prompts: [prompt('')] }), {}, ['prompt_renderer_skip']],
  ['client variable with allow_client_variables is not reported (the app supplies it at request time)', base({ allow_client_variables: true, prompts: [prompt('Page: {{page_context}}')] }), {}, []],
  ['capabilities_invalid', base({ capabilities: { not_a_capability: 'on' } }), {}, ['capabilities_invalid']],
  ['client_tools_not_ready: tools with no capabilities', base({ tool_ids: ['t1'] }), { tools: [{ id: 't1' }] }, ['client_tools_not_ready']],
  ['client_tools_not_ready: experiences not off', base({ tool_ids: ['t1'], capabilities: { kaltura_genie_experiences: 'on' } }), { tools: [{ id: 't1' }] }, ['client_tools_not_ready']],
  ['knowledge_ids_over_cap', base({ knowledge_ids: [1, 2] }), {}, ['knowledge_ids_over_cap']],
  ['knowledge_ids: one record is fine', base({ knowledge_ids: [1] }), {}, []],
  ['tool_not_found: tool_ids', base({ tool_ids: ['t1', 'gone'], capabilities: { kaltura_genie_experiences: 'off' } }), { tools: [{ id: 't1' }] }, ['tool_not_found']],
  ['tool ids read back as {id, condition} objects are found', base({ tool_ids: [{ id: 't1', condition: null }], thread_start_tools: [{ id: 't1', condition: 'sys__avatar_enabled' }], capabilities: { kaltura_genie_experiences: 'off' } }), { tools: [{ id: 't1' }] }, []],
  ['tool_not_found: object entry', base({ tool_ids: [{ id: 'gone', condition: null }], capabilities: { kaltura_genie_experiences: 'off' } }), { tools: [{ id: 't1' }] }, ['tool_not_found']],
  ['tool_not_found: thread_start_tools', base({ thread_start_tools: ['gone'] }), { tools: [] }, ['tool_not_found']],
  ['tool_not_found: skipped when tools are unknown', base({ tool_ids: ['gone'], capabilities: { kaltura_genie_experiences: 'off' } }), { tools: null }, []],
  ['skill_not_found', base({ skill_ids: [{ id: 's1', mode: 'adhoc' }, { id: 'gone', mode: 'adhoc' }] }), { skills: [{ id: 's1' }] }, ['skill_not_found']],
  ['skill_not_found: skipped when skills are unknown', base({ skill_ids: [{ id: 'gone', mode: 'adhoc' }] }), {}, []],
  ['skill_condition_template', base({ skill_ids: [{ id: 's1', mode: 'adhoc', condition: '{{ sys__avatar_enabled }}' }] }), { skills: [{ id: 's1' }] }, ['skill_condition_template']],
  ['conditions the server echoes as null are fine', base({ prompts: [prompt('a', { condition: null })], skill_ids: [{ id: 's1', mode: 'adhoc', condition: null }] }), { skills: [{ id: 's1' }] }, []],
  ['skill condition: a bare expression is fine', base({ skill_ids: [{ id: 's1', mode: 'adhoc', condition: 'not sys__avatar_enabled' }] }), { skills: [{ id: 's1' }] }, []],
  ['tool_condition_template', base({ tool_ids: ['t1'], capabilities: { kaltura_genie_experiences: 'off' } }), { tools: [{ id: 't1', config: { condition: '{% if x %}y{% endif %}' } }] }, ['tool_condition_template']],
  ['tool condition: a bare expression is fine', base({ tool_ids: ['t1'], capabilities: { kaltura_genie_experiences: 'off' } }), { tools: [{ id: 't1', config: { condition: 'sys__avatar_enabled' } }] }, []],
  ['prompt_bad_condition (lint finding, error)', base({ prompts: [prompt('Be kind.', { condition: '{{ plan }}' })] }), {}, ['prompt_bad_condition']],
  ['prompt_suspect_condition (lint finding, warn)', base({ prompts: [prompt('a', { condition: 'plan == "pro" AND x' })] }), {}, ['prompt_suspect_condition']],
  ['skill_condition_suspect', base({ skill_ids: [{ id: 's1', mode: 'adhoc', condition: 'a && b' }] }), { skills: [{ id: 's1' }] }, ['skill_condition_suspect']],
  ['tool_condition_suspect', base({ tool_ids: ['t1'], capabilities: { kaltura_genie_experiences: 'off' } }), { tools: [{ id: 't1', config: { condition: '!sys__avatar_enabled' } }] }, ['tool_condition_suspect']],
  ['a quoted AND in a condition is fine', base({ prompts: [prompt('a', { condition: 'plan != "AND" and visits is defined and visits > 2' })], skill_ids: [{ id: 's1', mode: 'adhoc', condition: "plan in ['pro', 'team']" }] }), { skills: [{ id: 's1' }] }, []],
  ['tool_arg_unused: api arg that no placeholder uses', base({ tool_ids: ['t1'], capabilities: { kaltura_genie_experiences: 'off' } }), { tools: [{ id: 't1', config: { type: 'api', args: { order_id: {} }, request: { url: 'https://api.example.com/order' } } }] }, ['tool_arg_unused']],
  ['tool_arg_unused: placeholders in url and nested body count as use', base({ tool_ids: ['t1'], capabilities: { kaltura_genie_experiences: 'off' } }), { tools: [{ id: 't1', config: { type: 'api', args: { a: {}, b: {} }, request: { url: 'https://api.example.com/{a}', body: { x: [{ y: 'v-{b}' }] } } } }] }, []],
  ['tool_arg_unused: only api tools are checked', base({ tool_ids: ['t1'], capabilities: { kaltura_genie_experiences: 'off' } }), { tools: [{ id: 't1', config: { type: 'var', args: { plan: {} } } }] }, []],
  ['a variable a linked var tool sets needs no allow_client_variables', base({ tool_ids: ['t1'], capabilities: { kaltura_genie_experiences: 'off' }, prompts: [prompt('Plan: {{plan}}')] }), { tools: [{ id: 't1', config: { type: 'var', args: { plan: {} } } }] }, []],
  ['a variable no linked var tool sets still needs the gate', base({ tool_ids: ['t1'], capabilities: { kaltura_genie_experiences: 'off' }, prompts: [prompt('Plan: {{other}}')] }), { tools: [{ id: 't1', config: { type: 'var', args: { plan: {} } } }] }, ['prompt_client_variable_not_allowed']],
  ['prompt types system and knowledge are fine', base({ prompts: [prompt('a', { key: 'a', type: 'system' }), prompt('b', { key: 'b', type: 'knowledge', condition: 'plan == "pro"' })] }), {}, []],
];

for (const [name, config, ctx, expected] of TABLE) {
  test(`auditIntellectConfig: ${name}`, () => {
    const findings = auditIntellectConfig(config, ctx);
    for (const f of findings) {
      assert.ok(f.message && f.fix, `${f.code} has a message and a fix`);
      assert.ok(f.field, `${f.code} names a field`);
    }
    assert.deepEqual(findings.map((f) => f.code).sort(), [...expected].sort());
  });
}

test('auditIntellectConfig: severities and configId', () => {
  const sev = (config, code, ctx) => auditIntellectConfig(config, ctx).find((f) => f.code === code);
  assert.equal(sev(base({ knowledge_ids: [1, 2] }), 'knowledge_ids_over_cap').severity, 'error');
  assert.equal(sev(base({ knowledge_ids: [1, 2] }), 'knowledge_ids_over_cap').configId, 7);
  assert.equal(sev(base({ capabilities: { nope: 'on' } }), 'capabilities_invalid').severity, 'warn');
  assert.equal(sev(base({ prompts: [prompt('a'), prompt('b')] }), 'prompt_duplicate_key').severity, 'warn');
  assert.equal(sev({ type: 'external' }, 'external_intellect').severity, 'info');
  assert.equal(sev({ type: 'external' }, 'external_intellect').configId, undefined);
});

test('auditIntellectConfig: odd input does not throw', () => {
  for (const bad of [null, undefined, 'x', 5, [], { prompts: 'x', tool_ids: 'x', skill_ids: 'x', capabilities: [], secrets: 'x' }]) {
    assert.doesNotThrow(() => auditIntellectConfig(/** @type {any} */ (bad), { tools: [], skills: [] }));
  }
});

// ---- intellectConfig.audit (wire) ----

function harness(config, { tools = {}, skills = {}, listed = [], cfg = {} } = {}) {
  const ff = fakeFetch([
    { match: 'v1/intellect/get', respond: () => (config ? { body: config } : { status: 404, body: { message: 'not found' } }) },
    { match: 'v1/tool/get', respond: (req) => (tools[req.body.id] ? { body: tools[req.body.id] } : { status: 404, body: { message: 'not found' } }) },
    { match: 'v1/skill/get', respond: (req) => (skills[req.body.id] ? { body: skills[req.body.id] } : { status: 404, body: { message: 'not found' } }) },
    { match: 'v1/skill/list', respond: () => ({ body: { totalCount: listed.length, objects: listed } }) },
  ]);
  return { mgmt: new Management({ partnerId: '123', fetch: ff, ...cfg }), ff };
}

test('intellectConfig.audit reads the intellect, then each tool and skill once, and reports', async () => {
  const config = base({
    tool_ids: ['t1', 'gone'], thread_start_tools: ['t1'], skill_ids: [{ id: 's1', mode: 'adhoc' }, { id: 'sgone', mode: 'adhoc' }],
    capabilities: { kaltura_genie_experiences: 'off' }, knowledge_ids: [1, 2],
  });
  const { mgmt, ff } = harness(config, { tools: { t1: { id: 't1' } }, skills: { s1: { id: 's1' } } });
  const report = await mgmt.intellectConfig.audit(7, ADMIN_KS);
  assert.deepEqual(report.findings.map((f) => f.code).sort(), ['knowledge_ids_over_cap', 'skill_not_found', 'tool_not_found']);
  assert.deepEqual(report.summary, { error: 3, warn: 0, info: 0 });
  assert.deepEqual(report.checked, { intellects: 1, tools: 1, skills: 1 });
  assert.equal(ff.calls.filter((c) => c.url.endsWith('v1/tool/get')).length, 2, 't1 once, gone once');
  for (const c of ff.calls) assert.match(c.url, /\/(get|list)$/, 'read-only');
});

test('intellectConfig.audit accepts an attached shared skill that skills.get cannot read', async () => {
  const config = base({ skill_ids: [{ id: 'shared-1', mode: 'adhoc' }, { id: 'gone', mode: 'adhoc' }] });
  const { mgmt, ff } = harness(config, { listed: [{ id: 'shared-1', partner_id: 0 }, { id: 'other', partner_id: 123 }] });
  const report = await mgmt.intellectConfig.audit(7, ADMIN_KS);
  const missing = report.findings.filter((f) => f.code === 'skill_not_found');
  assert.equal(missing.length, 1, 'only the id that is neither yours nor shared');
  assert.match(missing[0].message, /gone/);
  assert.equal(report.checked.skills, 1, 'the shared skill is counted');
  assert.equal(ff.calls.filter((c) => c.url.endsWith('v1/skill/list')).length, 1, 'the list is read once for all ids');
});

test('intellectConfig.audit does not read the skill list when every skill can be read by id', async () => {
  const { mgmt, ff } = harness(base({ skill_ids: [{ id: 's1', mode: 'adhoc' }] }), { skills: { s1: { id: 's1' } } });
  await mgmt.intellectConfig.audit(7, ADMIN_KS);
  assert.equal(ff.calls.filter((c) => c.url.endsWith('v1/skill/list')).length, 0);
});

test('intellectConfig.audit surfaces a missing intellect and rejects bad input', async () => {
  const { mgmt } = harness(null);
  await assert.rejects(() => mgmt.intellectConfig.audit(7, ADMIN_KS), (e) => e.code === 'not_found' || e.status === 404);
  await assert.rejects(() => mgmt.intellectConfig.audit(/** @type {any} */ ('x'), ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.intellectConfig.audit(7, { ks: 'x', kind: 'conversation' }), (e) => e.code === 'wrong_token_scope');
});

test('intellectConfig.audit lets non-404 tool errors through', async () => {
  const ff = fakeFetch([
    { match: 'v1/intellect/get', respond: () => ({ body: base({ tool_ids: ['t1'] }) }) },
    { match: 'v1/tool/get', respond: () => ({ status: 500, body: { message: 'boom' } }) },
  ]);
  const mgmt = new Management({ partnerId: '123', fetch: ff });
  await assert.rejects(() => mgmt.intellectConfig.audit(7, ADMIN_KS));
});
