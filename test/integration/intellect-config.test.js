import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/index.js';
import { IntellectConfig } from '../../src/management/intellect-config.js';
import { fakeFetch } from '../fakes/fetch.js';

/**
 * G1 integration (fetch-fake): assert the EXACT update/partner-config bodies and
 * the honest probe-gated behavior for the intellects + intellect-config surface.
 */
const ADMIN = { ks: 'djJ8' + Buffer.from('v2|6516742|x').toString('base64url'), kind: 'admin', entitlementEnforced: false };
const PID = 6516742;

/** A representative stored intellect (server read façade). */
function fullDto(over = {}) {
  return {
    id: 1481, type: 'internal', status: 2,
    base_directive: 'You are Ron…',
    prompts: [{ key: 'goal', headerTemplate: 'Goal', value: 'Help', type: 'custom' }],
    glossary: 'ARR: Annual Recurring Revenue',
    capabilities: { avatar: 'on', use_web_search: 'off' },
    tool_ids: [],
    secrets: { EXISTING: '***' },
    allow_client_variables: false,
    partner_id: PID, user_id: 'u', created_at: 'x', updated_at: 'y',
    ...over,
  };
}

function mkMgmt(routes) {
  const f = fakeFetch(routes);
  const m = new Management({ partnerId: PID, adminSecret: 'a'.repeat(32), fetch: f });
  return { m, f, cfg: new IntellectConfig(m._ctx, m.intellects) };
}

const updateEcho = { match: '/v1/intellect/update', respond: (req) => ({ body: req.body }) };
const getDto = (over) => ({ match: '/v1/intellect/get', respond: () => ({ body: fullDto(over) }) });

// ─────────────────────────── capabilities (full-replace dict) ───────────────────────────

test('intellects.setCapability read-merge-writes the full dict, preserving siblings + status', async () => {
  const { m, f } = mkMgmt([getDto(), updateEcho]);
  await m.intellects.setCapability(1481, 'use_web_search', 'on', ADMIN);
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.equal(sent.capabilities.use_web_search, 'on');
  assert.equal(sent.capabilities.avatar, 'on', 'sibling preserved');
  assert.equal(sent.status, 2);
  assert.equal(sent.base_directive, 'You are Ron…', 'unrelated field preserved');
  assert.ok(!('partner_id' in sent) && !('created_at' in sent), 'read-only keys stripped');
});

test('intellects.setCapability refuses re-enabling a stored disabled without force', async () => {
  const { m } = mkMgmt([getDto({ capabilities: { external_video: 'disabled' } }), updateEcho]);
  await assert.rejects(() => m.intellects.setCapability(1481, 'external_video', 'on', ADMIN), (e) => e.code === 'capability_vetoed');
});

test('intellects.setCapability with force overrides the stored disabled', async () => {
  const { m, f } = mkMgmt([getDto({ capabilities: { external_video: 'disabled' } }), updateEcho]);
  await m.intellects.setCapability(1481, 'external_video', 'on', ADMIN, { force: true });
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.equal(sent.capabilities.external_video, 'on');
});

test('intellects.setCapability rejects an unknown capability with NO network call', async () => {
  const { m, f } = mkMgmt([getDto(), updateEcho]);
  await assert.rejects(() => m.intellects.setCapability(1481, 'not_a_cap', 'on', ADMIN), (e) => e.code === 'unknown_capability');
  assert.equal(f.calls.length, 0, 'aborted before any fetch');
});

test('intellects.resolveCapabilities resolves all 15 with partner_config layer', async () => {
  const { m } = mkMgmt([getDto({ capabilities: { use_web_search: 'on' } })]);
  const r = await m.intellects.resolveCapabilities(1481, ADMIN);
  assert.equal(Object.keys(r.capabilities).length, 15);
  assert.equal(r.capabilities.use_web_search.state, 'on');
  assert.equal(r.capabilities.use_web_search.resolvedFrom, 'partner_config');
});

// ─────────────────────────── client variables / prompts ───────────────────────────

test('intellects.setClientVariablesEnabled re-sends the whole config flipping only the flag', async () => {
  const { m, f } = mkMgmt([getDto(), updateEcho]);
  await m.intellects.setClientVariablesEnabled(1481, true, ADMIN);
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.equal(sent.allow_client_variables, true);
  assert.equal(sent.prompts.length, 1, 'prompts preserved');
  assert.equal(sent.type, 'internal');
});

test('intellects.setPrompts lints, aborts on an error finding with NO write', async () => {
  const { m, f } = mkMgmt([getDto(), updateEcho]);
  // empty {{}} is a lint ERROR
  await assert.rejects(
    () => m.intellects.setPrompts(1481, [{ key: 'k', headerTemplate: 'H', value: 'Hello {{}}', type: 'custom' }], ADMIN),
    (e) => e.code === 'prompt_lint_failed',
  );
  assert.ok(!f.calls.some((c) => c.url.includes('/v1/intellect/update')), 'no write on lint failure');
});

test('intellects.setPrompts publishes a clean prompt list (full-replace)', async () => {
  const { m, f } = mkMgmt([getDto(), updateEcho]);
  const prompts = [{ key: 'goal', headerTemplate: 'Goal', value: 'Be concise', type: 'custom' }];
  const r = await m.intellects.setPrompts(1481, prompts, ADMIN, { baseDirective: 'You are X', glossary: 'ARR: x' });
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.deepEqual(sent.prompts, prompts);
  assert.equal(sent.base_directive, 'You are X');
  assert.equal(sent.glossary, 'ARR: x');
  assert.ok(r.lint.ok);
});

test('intellects.previewPrompt renders the author layer client-side', async () => {
  const { m } = mkMgmt([getDto()]);
  const p = await m.intellects.previewPrompt(1481, ADMIN, { requestVars: {} });
  assert.match(p.text, /## Goal/);
  assert.equal(p._meta.renderer, 'client-side-replica');
});

test('intellects.snapshot → diffSnapshots detects modified + reorder', async () => {
  const { m } = mkMgmt([getDto()]);
  const a = await m.intellects.snapshot(1481, ADMIN, { label: 'before' });
  const b = JSON.parse(JSON.stringify(a));
  b.fields.prompts = [{ key: 'goal', headerTemplate: 'Goal', value: 'CHANGED', type: 'custom' }, { key: 'task', headerTemplate: 'T', value: 'v', type: 'custom' }];
  const d = m.intellects.diffSnapshots(a, b);
  assert.deepEqual(d.prompts.added, ['task']);
  assert.deepEqual(d.prompts.modified, ['goal']);
  assert.equal(d._meta.storage, 'client-side');
});

test('intellects.restore writes back the snapshot author layer (skips secrets)', async () => {
  const { m, f } = mkMgmt([getDto(), updateEcho]);
  const snap = await m.intellects.snapshot(1481, ADMIN);
  f.calls.length = 0;
  const r = await m.intellects.restore(snap, ADMIN);
  assert.ok(r.written.includes('prompts'));
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.ok(!('secrets' in r.written), 'secrets never in the written list');
  assert.equal(sent.base_directive, 'You are Ron…');
});

// ─────────────────────────── brain config (partner-config routed, probe-gated) ───────────────────────────

test('intellects.setBrainConfig sends the verified subset to partner-config/update when available', async () => {
  const { m, f } = mkMgmt([
    { match: '/partner-config/get', respond: () => ({ body: { id: 0, config: {} } }) },
    { match: '/partner-config/update', respond: (req) => ({ body: { id: req.body.id, config: req.body.config } }) },
  ]);
  const r = await m.intellects.setBrainConfig(1481, { agentLlm: 'us.sonnet', rateLimits: { perMinute: 250 } }, ADMIN);
  assert.equal(r.applied, true);
  const call = f.calls.find((c) => c.url.includes('/partner-config/update'));
  assert.equal(call.body.id, 1481);
  assert.equal(call.body.config.agent_llm, 'us.sonnet');
  assert.equal(call.body.config.rate_limit_per_minute, 250);
  assert.ok(r.sentKeys.includes('agent_llm'));
});

test('intellects.setBrainConfig returns {applied:false, reason} on a 403 probe WITHOUT throwing or writing', async () => {
  const { m, f } = mkMgmt([
    { match: '/partner-config/get', respond: () => ({ status: 403, body: { detail: '403 Forbidden' } }) },
    { match: '/partner-config/update', respond: () => ({ body: {} }) },
  ]);
  const r = await m.intellects.setBrainConfig(1481, { agentLlm: 'us.sonnet' }, ADMIN);
  assert.equal(r.applied, false);
  assert.equal(r.code, 'forbidden');
  assert.match(r.reason, /privilege/);
  assert.equal(r._meta.deploymentGated, true);
  assert.ok(!f.calls.some((c) => c.url.includes('/partner-config/update')), 'no write attempted when gated');
});

test('intellects.setBrainConfig returns {applied:false} on a GET-200/UPDATE-403 split WITHOUT throwing (write 403 caught)', async () => {
  // The probe READ succeeds but the WRITE is still privilege-gated — the honest
  // receipt must come back, not a raw 403 throw (audit #3).
  const { m, f } = mkMgmt([
    { match: '/partner-config/get', respond: () => ({ body: { id: 0, config: {} } }) },        // probe OK
    { match: '/partner-config/update', respond: () => ({ status: 403, body: { detail: '403 Forbidden' } }) }, // write gated
  ]);
  const r = await m.intellects.setBrainConfig(1481, { agentLlm: 'us.sonnet' }, ADMIN);
  assert.equal(r.applied, false);
  assert.equal(r.code, 'forbidden');
  assert.equal(r._meta.deploymentGated, true);
  assert.ok(f.calls.some((c) => c.url.includes('/partner-config/update')), 'the write WAS attempted (probe passed) and its 403 was caught');
});

test('intellects.setBrainConfig validates BEFORE probing (bad searchDepth, zero fetch)', async () => {
  const { m, f } = mkMgmt([{ match: '/partner-config/get', respond: () => ({ body: {} }) }]);
  await assert.rejects(() => m.intellects.setBrainConfig(1481, { webSearch: { searchDepth: 'turbo' } }, ADMIN), (e) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0, 'validation throws before any network call');
});

test('intellects.getBrainConfig reads partner-config/get and reports unsetUseDefault', async () => {
  const { m } = mkMgmt([{ match: '/partner-config/get', respond: () => ({ body: { config: { agent_llm: 'us.sonnet', rate_limit_per_minute: 250 } } }) }]);
  const r = await m.intellects.getBrainConfig(1481, ADMIN);
  assert.equal(r.brainConfig.agent_llm, 'us.sonnet');
  assert.ok(r.unsetUseDefault.includes('web_search_config'), 'absent key reported, not predicted off');
});

test('intellects.brainConfigAvailable mirrors linkAvailable shape', async () => {
  const ok = mkMgmt([{ match: '/partner-config/get', respond: () => ({ body: {} }) }]);
  assert.equal((await ok.m.intellects.brainConfigAvailable(ADMIN)).available, true);
  const gated = mkMgmt([{ match: '/partner-config/get', respond: () => ({ status: 403, body: {} }) }]);
  assert.equal((await gated.m.intellects.brainConfigAvailable(ADMIN)).code, 'forbidden');
  const missing = mkMgmt([{ match: '/partner-config/get', respond: () => ({ status: 404, body: {} }) }]);
  assert.equal((await missing.m.intellects.brainConfigAvailable(ADMIN)).code, 'not_deployed');
});

// ─────────────────────────── create defaults ───────────────────────────

test('intellects.create applies defaults + echoes resolved type; rejects url/protocol (external/BYO-LLM is unwired)', async () => {
  const { m, f } = mkMgmt([{ match: '/v1/intellect/add', respond: () => ({ body: { id: 99 } }) }]);
  const r = await m.intellects.create({}, ADMIN);
  assert.equal(r.type, 'internal');
  assert.equal(r.status, 2);
  assert.equal(r.configId, 99);
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/add')).body;
  assert.equal(sent.type, 'internal');
  assert.equal(sent.status, 2);
  // url/protocol (the external BYO-LLM type) has no converse-time delegation → rejected.
  await assert.rejects(() => m.intellects.create({ url: 'https://x' }, ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => m.intellects.create({ protocol: 'openai-compatible' }, ADMIN), (e) => e.code === 'bad_request');
});

// ─────────────────────────── intellect-config facade ───────────────────────────

test('intellectConfig.patch rejects a phantom-write field BEFORE any update', async () => {
  const { cfg, f } = mkMgmt([getDto(), updateEcho]);
  await assert.rejects(() => cfg.patch(1481, { web_search_config: { search_depth: 'basic' } }, ADMIN), (e) => e.code === 'bad_request' && /read-only/.test(e.detail));
  assert.ok(!f.calls.some((c) => c.url.includes('/v1/intellect/update')), 'no write for a phantom field');
});

test('intellectConfig.setCapabilities delegates the full-replace merge (no duplicated logic)', async () => {
  const { cfg, f } = mkMgmt([getDto(), updateEcho]);
  await cfg.setCapabilities(1481, { include_sources: 'on' }, ADMIN);
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.equal(sent.capabilities.include_sources, 'on');
  assert.equal(sent.capabilities.avatar, 'on', 'sibling preserved via mergeCapabilityWrite');
});

test('intellectConfig.setToolIds writes the tool_ids reference list directly (plain array, no merge)', async () => {
  const { cfg, f } = mkMgmt([getDto(), updateEcho]);
  const r = await cfg.setToolIds(1481, ['tool-1', 'tool-2'], ADMIN);
  assert.equal(r.applied, true);
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.deepEqual(sent.tool_ids, ['tool-1', 'tool-2']);
});

test('intellectConfig.setToolIds rejects a non-string-array BEFORE any network', async () => {
  const { cfg, f } = mkMgmt([getDto()]);
  await assert.rejects(() => cfg.setToolIds(1481, [1, 2], ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => cfg.setToolIds(1481, ['ok', ''], ADMIN), (e) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0);
});

test('intellectConfig.setSkillIds writes the skill_ids reference list directly (plain array, no merge)', async () => {
  const { cfg, f } = mkMgmt([getDto(), updateEcho]);
  const r = await cfg.setSkillIds(1481, [{ id: 'skill-1', mode: 'adhoc' }, { id: 'skill-2', mode: 'preloaded' }], ADMIN);
  assert.equal(r.applied, true);
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.deepEqual(sent.skill_ids, [{ id: 'skill-1', mode: 'adhoc' }, { id: 'skill-2', mode: 'preloaded' }]);
  assert.ok(!f.calls.some((c) => c.url.includes('/partner-config')), 'Path A writes via the intellect DTO, never partner-config');
});

test('intellectConfig.setSkillIds accepts [] to detach every skill', async () => {
  const { cfg, f } = mkMgmt([getDto({ skill_ids: [{ id: 'skill-1', mode: 'adhoc' }] }), updateEcho]);
  const r = await cfg.setSkillIds(1481, [], ADMIN);
  assert.equal(r.applied, true);
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.deepEqual(sent.skill_ids, []);
});

test('intellectConfig.setSkillIds rejects a bad mode, a missing id, or a non-array BEFORE any network', async () => {
  const { cfg, f } = mkMgmt([getDto()]);
  await assert.rejects(() => cfg.setSkillIds(1481, /** @type {any} */ ('nope'), ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => cfg.setSkillIds(1481, [{ id: 'skill-1', mode: 'always_on' }], ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => cfg.setSkillIds(1481, [{ mode: 'adhoc' }], ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => cfg.setSkillIds(1481, [{ id: '', mode: 'adhoc' }], ADMIN), (e) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0);
});

test('intellectConfig.setSecrets re-sends prior secrets as the mask sentinel + rejects literal mask', async () => {
  const { cfg, f } = mkMgmt([getDto(), updateEcho]);
  await cfg.setSecrets(1481, { NEW_KEY: 'sk_live_x' }, ADMIN);
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.equal(sent.secrets.EXISTING, '***', 'prior secret kept via mask sentinel');
  assert.equal(sent.secrets.NEW_KEY, 'sk_live_x');
  await assert.rejects(() => cfg.setSecrets(1481, { X: '***' }, ADMIN), (e) => e.code === 'bad_request');
});

test('intellectConfig.listSecretNames returns names only (never values)', async () => {
  const { cfg } = mkMgmt([getDto({ secrets: { A: '***', B: '***' } })]);
  const r = await cfg.listSecretNames(1481, ADMIN);
  assert.deepEqual(r.names, ['A', 'B']);
  assert.ok(!JSON.stringify(r).includes('sk_'), 'no values present');
});

test('intellectConfig.setUserPropertiesForms + clearUserPropertiesForms write the LIST wire shape', async () => {
  const { cfg, f } = mkMgmt([getDto(), updateEcho]);
  await cfg.setUserPropertiesForms(1481, [{ callStage: 'middle', properties: [{ key: 'email', type: 'str' }] }], ADMIN);
  let sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.deepEqual(sent.user_properties_forms, [{ call_stage: 'middle', properties: [{ key: 'email', type: 'str' }] }]);
  f.calls.length = 0;
  await cfg.clearUserPropertiesForms(1481, ADMIN);
  sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.equal(sent.user_properties_forms, null);
});

test('intellectConfig.setMetadata patches only the supplied row fields', async () => {
  const { cfg, f } = mkMgmt([getDto(), updateEcho]);
  await cfg.setMetadata(1481, { name: 'New Name', tags: ['qa'] }, ADMIN);
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.equal(sent.name, 'New Name');
  assert.deepEqual(sent.tags, ['qa']);
});

test('intellectConfig.setKnowledgeIds writes ungated via the update DTO (Path A — no partner-config probe)', async () => {
  // Verified live: knowledge_ids is in the v1/intellect/update DTO allow-list and writes
  // with NO partner-config/update and NO 403. setKnowledgeIds must NOT probe the gate.
  const { cfg, f } = mkMgmt([getDto(), updateEcho]);
  const r = await cfg.setKnowledgeIds(1481, [7], ADMIN);
  assert.equal(r.applied, true);
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.deepEqual(sent.knowledge_ids, [7]);
  assert.ok(!f.calls.some((c) => c.url.includes('/partner-config')), 'Path A writes via the intellect DTO, never partner-config');
});

test('intellectConfig.setKnowledgeIds rejects >1 id BEFORE any network', async () => {
  const { cfg, f } = mkMgmt([getDto()]);
  await assert.rejects(() => cfg.setKnowledgeIds(1481, [1, 2], ADMIN), (e) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0);
});

test('intellectConfig.describe partitions editable vs readOnly (phantom-write discipline)', async () => {
  const { cfg } = mkMgmt([getDto({ web_search_config: { search_depth: 'basic' } })]);
  const d = await cfg.describe(1481, ADMIN);
  assert.equal(d.type, 'internal');
  assert.ok('prompts' in d.editable && 'capabilities' in d.editable);
  assert.deepEqual(d.editable.secrets, { names: ['EXISTING'] }, 'secrets editable shows NAMES only');
  for (const k of ['web_search_config', 'run_quota_check', 'agent_avatar_llm', 'avatar_config']) {
    assert.ok(k in d.readOnly, `${k} is read-only`);
    assert.match(d.readOnly[k].note, /internal tooling|server-managed/);
  }
  assert.equal(d.capabilityNames.length, 15);
});

test('intellectConfig.setBrainConfig + brainConfigAvailable delegate to intellects', async () => {
  const { cfg, f } = mkMgmt([
    { match: '/partner-config/get', respond: () => ({ body: {} }) },
    { match: '/partner-config/update', respond: (req) => ({ body: { config: req.body.config } }) },
  ]);
  assert.equal((await cfg.brainConfigAvailable(ADMIN)).available, true);
  const r = await cfg.setBrainConfig(1481, { agentFastLlm: 'us.haiku' }, ADMIN);
  assert.equal(r.applied, true);
  assert.ok(f.calls.some((c) => c.url.includes('/partner-config/update')));
});

test('patch + setters require an admin KS (scope guard)', async () => {
  const { cfg } = mkMgmt([getDto()]);
  const conv = { ks: 'djJ8conv', kind: 'conversation' };
  await assert.rejects(() => cfg.patch(1481, { glossary: 'x' }, conv), (e) => e.code === 'wrong_token_scope');
});

test('intellectConfig.setMcpServers validates the name→{url} map BEFORE any network, then patches mcp_servers', async () => {
  const { m, f } = mkMgmt([getDto(), updateEcho]);
  await assert.rejects(() => m.intellectConfig.setMcpServers(1481, /** @type {any} */ (null), ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => m.intellectConfig.setMcpServers(1481, /** @type {any} */ ([{ url: 'https://x' }]), ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => m.intellectConfig.setMcpServers(1481, { docs: /** @type {any} */ ('https://x') }, ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => m.intellectConfig.setMcpServers(1481, { docs: { url: 'not a url' } }, ADMIN), (e) => e.code === 'invalid_url');
  await assert.rejects(() => m.intellectConfig.setMcpServers(1481, { docs: { url: 'ftp://x.example' } }, ADMIN), (e) => e.code === 'invalid_url');
  assert.equal(f.calls.length, 0, 'no transport before validation passes');

  const res = await m.intellectConfig.setMcpServers(1481, { docs: { url: 'https://mcp.example.com/sse' } }, ADMIN);
  assert.equal(res.applied, true);
  assert.match(res._meta.generatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.deepEqual(sent.mcp_servers, { docs: { url: 'https://mcp.example.com/sse' } });
});

test('intellectConfig.setMcpServers accepts {} to clear the server map', async () => {
  const { m, f } = mkMgmt([getDto({ mcp_servers: { docs: { url: 'https://old.example' } } }), updateEcho]);
  const res = await m.intellectConfig.setMcpServers(1481, {}, ADMIN);
  assert.equal(res.applied, true);
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.deepEqual(sent.mcp_servers, {});
});
