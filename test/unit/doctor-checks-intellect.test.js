import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientToolFireAndForget, clientToolWaitBlocks, conditionUnquotedName, latencyOutputTokens, latencyPreloadedSkills,
  latencyPromptSize, latencyThinking, openingPhraseMayRenderEmpty, threadStartToolBlocks, toolSurfaceLarge,
} from '../../src/management/doctor/checks/intellect.js';
import { DEFAULT_THRESHOLDS } from '../../src/management/doctor/model.js';

/** Pure checks over hand-built intellect views. No network, no fakes. */

const withAvatar = { agentId: 'a1', agent: {}, intellectState: 'found', avatars: [{ id: 'av1', state: 'found' }] };
const headless = { agentId: 'a2', agent: {}, intellectState: 'found', avatars: [] };
const view = (config = {}, { tools = [], skills = [], refs = 'ok', agents = [withAvatar] } = {}) => ({
  configId: 10, config: { id: 10, type: 'brain', ...config }, agentIds: agents.map((a) => a.agentId), agents, tools, skills, refs,
});
const run = (check, v, t = DEFAULT_THRESHOLDS) => check.run(v, t);
const codes = (findings) => findings.map((f) => `${f.severity}:${f.code}`);

test('latency_thinking: medium or high thinking, thoughts or think_process on an agent with an avatar is info', () => {
  assert.deepEqual(codes(run(latencyThinking, view({ model_configuration: { thinking_level: 'high' } }))), ['info:latency_thinking']);
  assert.deepEqual(codes(run(latencyThinking, view({ model_configuration: { thinking_level: 'medium' } }))), ['info:latency_thinking']);
  assert.deepEqual(codes(run(latencyThinking, view({ model_configuration: { include_thoughts: true } }))), ['info:latency_thinking']);
  assert.deepEqual(codes(run(latencyThinking, view({ capabilities: { think_process: 'on' } }))), ['info:latency_thinking']);
  const f = run(latencyThinking, view({ model_configuration: { thinking_level: 'high', include_thoughts: true } }))[0];
  assert.match(f.message, /thinking_level is "high" and include_thoughts is true/);
  assert.match(f.message, /Measure a real turn/);
  assert.deepEqual(f.agentIds, ['a1']);
  assert.equal(f.configId, 10);
});

test('latency_thinking: silent for low thinking, the default, think_process off or disabled, a headless agent, an external intellect', () => {
  assert.deepEqual(run(latencyThinking, view({ model_configuration: { thinking_level: 'low' } })), []);
  assert.deepEqual(run(latencyThinking, view({})), [], 'think_process is off by default');
  assert.deepEqual(run(latencyThinking, view({ capabilities: { think_process: 'off' } })), []);
  assert.deepEqual(run(latencyThinking, view({ capabilities: { think_process: 'disabled' } })), []);
  assert.deepEqual(run(latencyThinking, view({ model_configuration: { thinking_level: 'high' } }, { agents: [headless] })), []);
  assert.deepEqual(run(latencyThinking, view({ type: 'external', model_configuration: { thinking_level: 'high' } })), []);
});

test('latency_output_tokens: above the limit is info, at the limit or unset is silent, the limit is an option', () => {
  assert.deepEqual(codes(run(latencyOutputTokens, view({ model_configuration: { max_output_tokens: 4096 } }))), ['info:latency_output_tokens']);
  assert.deepEqual(run(latencyOutputTokens, view({ model_configuration: { max_output_tokens: 1024 } })), []);
  assert.deepEqual(run(latencyOutputTokens, view({})), []);
  assert.deepEqual(run(latencyOutputTokens, view({ model_configuration: { max_output_tokens: 'x' } })), []);
  assert.deepEqual(run(latencyOutputTokens, view({ model_configuration: { max_output_tokens: 4096 } }), { ...DEFAULT_THRESHOLDS, maxOutputTokens: 8192 }), []);
  assert.deepEqual(run(latencyOutputTokens, view({ type: 'external', model_configuration: { max_output_tokens: 4096 } })), []);
});

test('latency_preloaded_skills: counts only preloaded skills and only their instructions', () => {
  const skills = [{ id: 's1', instructions: 'x'.repeat(5000) }, { id: 's2', instructions: 'x'.repeat(5000) }, { id: 's3', instructions: 'x'.repeat(9000) }];
  const ids = (modes) => modes.map((mode, i) => ({ id: `s${i + 1}`, mode }));
  const f = run(latencyPreloadedSkills, view({ skill_ids: ids(['preloaded', 'preloaded', 'adhoc']) }, { skills }));
  assert.deepEqual(codes(f), ['info:latency_preloaded_skills']);
  assert.match(f[0].message, /2 preloaded skill\(s\) add 10000 characters/);
  assert.deepEqual(run(latencyPreloadedSkills, view({ skill_ids: ids(['preloaded', 'adhoc', 'adhoc']) }, { skills })), [], '5000 is under 8000');
  assert.deepEqual(run(latencyPreloadedSkills, view({ skill_ids: ids(['adhoc', 'adhoc', 'adhoc-save']) }, { skills })), [], 'adhoc skills are not in the prompt');
  assert.deepEqual(run(latencyPreloadedSkills, view({ skill_ids: ids(['preloaded', 'preloaded', 'preloaded']) }, { skills: [{ id: 's1', instructions: null }] })), [], 'null instructions count as zero');
  assert.deepEqual(run(latencyPreloadedSkills, view({ skill_ids: ids(['preloaded', 'preloaded', 'preloaded']) }, { skills, refs: 'unread' })), [], 'an incomplete read is skipped');
});

test('latency_prompt_size: sums the prompt blocks, silent at the limit', () => {
  const block = (n) => ({ key: `k${n}`, value: 'x'.repeat(n) });
  assert.deepEqual(codes(run(latencyPromptSize, view({ prompts: [block(5000), block(4000)] }))), ['info:latency_prompt_size']);
  assert.deepEqual(run(latencyPromptSize, view({ prompts: [block(4000), block(4000)] })), [], '8000 is the limit');
  assert.deepEqual(run(latencyPromptSize, view({})), []);
  assert.deepEqual(run(latencyPromptSize, view({ prompts: [{ key: 'a' }, null] })), []);
  assert.deepEqual(run(latencyPromptSize, view({ type: 'external', prompts: [block(9000)] })), []);
});

// Live shape: the entity holds id and name, the wire config sits under `config`.
const apiTool = (over = {}, id = 't1') => ({ id, name: 'lookup', config: { type: 'api', request: { url: 'https://example.com', timeout: 30 }, ...over } });

test('thread_start_tool_blocks: a slow api tool at thread start without wait_for_response false is a warn', () => {
  const f = run(threadStartToolBlocks, view({ thread_start_tools: ['t1'] }, { tools: [apiTool()] }));
  assert.deepEqual(codes(f), ['warn:thread_start_tool_blocks']);
  assert.match(f[0].message, /up to 30 s/);
  assert.deepEqual(codes(run(threadStartToolBlocks, view({ thread_start_tools: [{ id: 't1' }] }, { tools: [apiTool()] }))), ['warn:thread_start_tool_blocks'], 'an {id} reference works');
});

test('thread_start_tool_blocks: silent for a fast tool, wait_for_response false, a tool in tool_ids only, a client tool, or an unread tool', () => {
  const start = { thread_start_tools: ['t1'] };
  assert.deepEqual(run(threadStartToolBlocks, view(start, { tools: [apiTool({ request: { timeout: 10 } })] })), [], '10 s is allowed');
  assert.deepEqual(run(threadStartToolBlocks, view(start, { tools: [apiTool({ request: {} })] })), [], 'the default timeout is 10 s');
  assert.deepEqual(run(threadStartToolBlocks, view(start, { tools: [apiTool({ wait_for_response: false })] })), []);
  assert.deepEqual(run(threadStartToolBlocks, view({ tool_ids: ['t1'] }, { tools: [apiTool()] })), []);
  assert.deepEqual(run(threadStartToolBlocks, view(start, { tools: [{ id: 't1', config: { type: 'client' } }] })), []);
  assert.deepEqual(run(threadStartToolBlocks, view(start, { tools: [] })), [], 'a missing tool is tool_not_found, not this');
  assert.deepEqual(run(threadStartToolBlocks, view(start, { tools: [apiTool()], refs: 'unread' })), []);
});

test('tool_surface_large: counts tools, adhoc skills, MCP servers and built-in tools that are on', () => {
  const many = { tool_ids: ['1', '2', '3', '4', '5'], skill_ids: [{ id: 's', mode: 'adhoc' }, { id: 't', mode: 'adhoc-save' }, { id: 'u', mode: 'preloaded' }], mcp_servers: { a: {} } };
  const f = run(toolSurfaceLarge, view(many));
  assert.deepEqual(codes(f), ['info:tool_surface_large']);
  assert.match(f[0].message, /5 tools, 2 adhoc skills, 1 MCP servers, 4 built-in tools/);
  assert.match(f[0].message, /12 tools/);
});

test('tool_surface_large: one kind of tool is not broken down', () => {
  const off = { use_knowledge_base: 'off', use_content_search: 'off', use_get_entry_content: 'off', use_related_files: 'off' };
  const f = run(toolSurfaceLarge, view({ tool_ids: Array.from({ length: 12 }, (_, i) => String(i)), capabilities: off }));
  assert.match(f[0].message, /^The model can choose from 12 tools, above 8\./);
});

test('tool_surface_large: preloaded skills and capabilities that are off do not count, the limit is exclusive and an option', () => {
  const off = { use_knowledge_base: 'off', use_content_search: 'off', use_get_entry_content: 'disabled', use_related_files: 'off' };
  assert.deepEqual(run(toolSurfaceLarge, view({ tool_ids: ['1', '2', '3', '4', '5', '6', '7', '8'], capabilities: off })), [], 'exactly 8');
  assert.deepEqual(codes(run(toolSurfaceLarge, view({ tool_ids: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], capabilities: off }))), ['info:tool_surface_large']);
  assert.deepEqual(run(toolSurfaceLarge, view({ tool_ids: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], capabilities: off }), { ...DEFAULT_THRESHOLDS, toolSurface: 12 }), []);
  assert.deepEqual(run(toolSurfaceLarge, view({ tool_ids: ['1', '2', '3', '4'], skill_ids: [{ id: 'u', mode: 'preloaded' }] })), [], '4 tools + 4 built-in = 8, and the preloaded skill adds none');
});

const client = (over = {}) => ({ id: 'c1', name: 'go_to_slide', config: { type: 'client', description: 'Open a slide.', ...over } });

test('client_tool_wait_blocks: an unset wait_for_response on a client tool is info with the real timeout', () => {
  const f = run(clientToolWaitBlocks, view({ tool_ids: ['c1'] }, { tools: [client({ timeout: 15 })] }));
  assert.deepEqual(codes(f), ['info:client_tool_wait_blocks']);
  assert.match(f[0].message, /up to 15 s/);
  assert.match(run(clientToolWaitBlocks, view({ tool_ids: ['c1'] }, { tools: [client({ wait_for_response: null })] }))[0].message, /up to 30 s/);
});

test('client_tool_wait_blocks: silent when it is set either way, for api tools and for tools not in tool_ids', () => {
  const ids = { tool_ids: ['c1'] };
  assert.deepEqual(run(clientToolWaitBlocks, view(ids, { tools: [client({ wait_for_response: true })] })), []);
  assert.deepEqual(run(clientToolWaitBlocks, view(ids, { tools: [client({ wait_for_response: false })] })), []);
  assert.deepEqual(run(clientToolWaitBlocks, view(ids, { tools: [apiTool({}, 'c1')] })), []);
  assert.deepEqual(run(clientToolWaitBlocks, view({}, { tools: [client()] })), []);
  assert.deepEqual(run(clientToolWaitBlocks, view(ids, { tools: [client()], refs: 'unread' })), []);
});

test('client_tool_fire_and_forget_unbudgeted: wait_for_response false with no once-per-turn wording is info', () => {
  const f = run(clientToolFireAndForget, view({ tool_ids: ['c1'] }, { tools: [client({ wait_for_response: false })] }));
  assert.deepEqual(codes(f), ['info:client_tool_fire_and_forget_unbudgeted']);
});

test('client_tool_fire_and_forget_unbudgeted: silent with once wording, a waiting tool, an api tool or an unset flag', () => {
  const ids = { tool_ids: ['c1'] };
  for (const description of ['Open a slide. Call once per turn.', 'Call this at most one time.', 'Use only once.']) {
    assert.deepEqual(run(clientToolFireAndForget, view(ids, { tools: [client({ wait_for_response: false, description })] })), [], description);
  }
  assert.deepEqual(run(clientToolFireAndForget, view(ids, { tools: [client({ wait_for_response: true })] })), []);
  assert.deepEqual(run(clientToolFireAndForget, view(ids, { tools: [client()] })), []);
  assert.deepEqual(run(clientToolFireAndForget, view(ids, { tools: [apiTool({ wait_for_response: false }, 'c1')] })), []);
});

const prompt = (condition) => ({ key: 'p', headerTemplate: 'P', value: 'v', condition });

test('condition_unquoted_name: a bare word on the right of == or != is info and names the word', () => {
  const f = run(conditionUnquotedName, view({ prompts: [prompt('plan == pro')] }));
  assert.deepEqual(codes(f), ['info:condition_unquoted_name']);
  assert.match(f[0].message, /bare name pro/);
  assert.match(f[0].field, /prompt p/);
  assert.equal(run(conditionUnquotedName, view({ prompts: [prompt('plan != pro')] })).length, 1);
  assert.equal(run(conditionUnquotedName, view({ skill_ids: [{ id: 's', mode: 'adhoc', condition: 'tier == gold' }] }))[0].field, 'skill_ids[0]');
  assert.equal(run(conditionUnquotedName, view({ tool_ids: [{ id: 't', condition: 'tier == gold' }] }))[0].field, 'tool_ids[0]');
});

test('condition_unquoted_name: silent for quoted text, true/false/none, numbers, underscored names, attributes and quoted words', () => {
  for (const condition of ['plan == "pro"', "plan == 'pro'", 'flag == true', 'flag == False', 'x == none', 'visits == 3', 'a == user_plan', 'a == sys__locale', 'a == user.plan', 'a == f(x)', 'note == "a == b"', null]) {
    assert.deepEqual(run(conditionUnquotedName, view({ prompts: [prompt(condition)] })), [], String(condition));
  }
  assert.deepEqual(run(conditionUnquotedName, view({ type: 'external', prompts: [prompt('plan == pro')] })), []);
});

test('opening_phrase_may_render_empty: one if with no else around the whole line is info', () => {
  const f = run(openingPhraseMayRenderEmpty, view({ opening_phrase: '{% if user_name %}Hello {{ user_name }}!{% endif %}' }));
  assert.deepEqual(codes(f), ['info:opening_phrase_may_render_empty']);
  assert.equal(f[0].field, 'opening_phrase');
  assert.equal(run(openingPhraseMayRenderEmpty, view({ opening_phrase: '  {%- if sys__is_new_thread -%}Welcome{%- endif -%}  ' })).length, 1);
});

test('opening_phrase_may_render_empty: silent with an else, an elif, text outside the if, two ifs, plain text, SILENT_OPENING, none or external', () => {
  for (const opening_phrase of [
    '{% if a %}Hi{% else %}Hello{% endif %}',
    '{% if a %}Hi{% elif b %}Hey{% endif %}',
    'Welcome! {% if a %}Hi {{ a }}{% endif %}',
    '{% if a %}Hi{% endif %}{% if b %}There{% endif %}',
    'Hello there',
    '<blank>',
    undefined,
  ]) assert.deepEqual(run(openingPhraseMayRenderEmpty, view({ opening_phrase })), [], String(opening_phrase));
  assert.deepEqual(run(openingPhraseMayRenderEmpty, view({ type: 'external', opening_phrase: '{% if a %}Hi{% endif %}' })), []);
});
