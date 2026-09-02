import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/index.js';
import { fakeFetch } from '../fakes/fetch.js';

/** A fake-fetch that mimics the documented Agentic+Genie responses for the full provision sequence. */
function provisionFetch() {
  return fakeFetch([
    { match: '/application/generateAgentProfile', respond: () => ({ body: { name: 'YogaBot', openingPhrase: 'Namaste!', goal: 'help', targetAudience: 'students', restrictedTopics: 'none' } }) },
    { match: '/v1/intellect/add', respond: () => ({ body: { id: 1389, status: 2, prompts: [] } }) },
    { match: '/v1/intellect/update', respond: () => ({ body: { id: 1389, status: 2 } }) },
    { match: '/agent/create', respond: () => ({ body: { agentId: 'agent-xyz' } }) },
    { match: '/catalog-item/list', respond: (req) => ({ body: { objects: [{ itemId: req.body?.filter?.typeEqual === 'Voice' ? 'voice-1' : 'visual-1' }], totalCount: 1 } }) },
    { match: '/avatar/create', respond: () => ({ body: { id: '6a07d63d8ccd85cbfafc5416' } }) },
    { match: '/application/resolveWidgetId', respond: () => ({ body: { widgetId: '1_v1mj1kxb' } }) },
    // applyTools()'s shared-by-name hazard guard checks this before overwriting a
    // name-matched existing Tool's config — no other intellect references it by default.
    { match: '/v1/intellect/list', respond: () => ({ body: { totalCount: 0, objects: [] } }) },
  ]);
}

test('provision runs the full documented sequence and returns every id', async () => {
  const f = provisionFetch();
  const m = new Management({ partnerId: 6496302, adminSecret: 'a'.repeat(32), fetch: f });
  // a real admin KS-shaped token so the scope guard passes
  const ks = 'djJ8' + Buffer.from('v2|6496302|disableentitlement').toString('base64url');
  const r = await m.provision({ brief: 'A friendly yoga-studio receptionist', ks });

  assert.equal(r.name, 'YogaBot');
  assert.equal(r.configId, 1389);
  assert.equal(r.avatarId, '6a07d63d8ccd85cbfafc5416');
  assert.equal(r.agentId, 'agent-xyz');
  assert.equal(r.widgetId, '1_v1mj1kxb');
  // provenance receipt present
  assert.match(r._meta.generatedAt, /Z$/);
  assert.ok(r._meta.scope.includes('disableentitlement'));

  // agent.create sends the intellect by configId directly — no genieId lookup
  const agentCreate = f.calls.find((c) => c.url.includes('/agent/create'));
  assert.deepEqual(agentCreate.body.intellect, { intellectType: 'genie', id: 1389 });

  // creates carry an Idempotency-Key header (hygiene)
  const avatarCreate = f.calls.find((c) => c.url.includes('/avatar/create'));
  assert.ok(avatarCreate.headers['idempotency-key'], 'avatar create must send Idempotency-Key');
  assert.ok(agentCreate.headers['idempotency-key'], 'agent create must send Idempotency-Key');
});

// Persona-name consistency lint surfaces on every provision()
// call (not opt-in like the optional blocks), since it's a cheap pure check.
test('provision surfaces a personaLint result, clean for a freshly-generated profile', async () => {
  const { m } = baseProvision();
  const r = await m.provision({ brief: 'A friendly yoga-studio receptionist', ks: ADMIN_KS });
  // openingPhrase 'Namaste!' names no proper noun → detectedName is null → clean by construction.
  assert.equal(r.personaLint.ok, true);
  assert.equal(r.personaLint.detectedName, null);
  assert.deepEqual(r.personaLint.findings, []);
});

test('provision surfaces a personaLint warning when the generated openingPhrase names a different persona than profile.name', async () => {
  const f = fakeFetch([
    { match: '/application/generateAgentProfile', respond: () => ({ body: { name: 'Nova', openingPhrase: "Hi! I'm Luna, ready to help!", goal: 'help', targetAudience: 'students', restrictedTopics: 'none' } }) },
    { match: '/v1/intellect/add', respond: () => ({ body: { id: 1389, status: 2, prompts: [] } }) },
    { match: '/v1/intellect/update', respond: () => ({ body: { id: 1389, status: 2 } }) },
    { match: '/agent/create', respond: () => ({ body: { agentId: 'agent-xyz' } }) },
    { match: '/catalog-item/list', respond: (req) => ({ body: { objects: [{ itemId: req.body?.filter?.typeEqual === 'Voice' ? 'voice-1' : 'visual-1' }], totalCount: 1 } }) },
    { match: '/avatar/create', respond: () => ({ body: { id: '6a07d63d8ccd85cbfafc5416' } }) },
    { match: '/application/resolveWidgetId', respond: () => ({ body: { widgetId: '1_v1mj1kxb' } }) },
    { match: '/v1/intellect/list', respond: () => ({ body: { totalCount: 0, objects: [] } }) },
  ]);
  const m = new Management({ partnerId: 6496302, adminSecret: 'a'.repeat(32), fetch: f });
  const r = await m.provision({ brief: 'x', ks: ADMIN_KS });
  assert.equal(r.personaLint.detectedName, 'Luna');
  assert.ok(r.personaLint.findings.some((fnd) => fnd.code === 'persona_name_mismatch'));
  assert.equal(r.agentId, 'agent-xyz', 'a persona-name warning never fails the provision');
});

test('provision surfaces the failing step on partial failure', async () => {
  const f = fakeFetch([
    { match: '/application/generateAgentProfile', respond: () => ({ body: { name: 'X' } }) },
    { match: '/v1/intellect/add', respond: () => ({ status: 500, body: { message: 'boom' } }) },
  ]);
  const m = new Management({ partnerId: 1, adminSecret: 'a'.repeat(32), fetch: f });
  const ks = 'djJ8' + Buffer.from('v2|1|disableentitlement').toString('base64url');
  await assert.rejects(() => m.provision({ brief: 'x', ks }), (e) => {
    assert.equal(e.code, 'provision_failed');
    assert.equal(e.body.failedStep, 'intellect.add');
    return true;
  });
});

// ─── OPTIONAL post-configure blocks (capabilities / tools / knowledge) ──────────
const ADMIN_KS = 'djJ8' + Buffer.from('v2|6496302|disableentitlement').toString('base64url');

function baseProvision() {
  const f = provisionFetch();
  const m = new Management({ partnerId: 6496302, adminSecret: 'a'.repeat(32), fetch: f });
  return { f, m };
}

test('optional blocks are ABSENT from the result when not requested (back-compat)', async () => {
  const { m } = baseProvision();
  const r = await m.provision({ brief: 'A friendly yoga-studio receptionist', ks: ADMIN_KS });
  assert.equal(r.blocks, undefined, 'no `blocks` key without optional opts');
  assert.equal(r._meta.optionalBlocks, undefined, 'no optionalBlocks receipt without optional opts');
  // existing fields untouched
  assert.equal(r.configId, 1389);
  assert.equal(r.agentId, 'agent-xyz');
});

test('opts.capabilities fires intellects.setCapabilities and records {applied:true}', async () => {
  const { m } = baseProvision();
  const captured = [];
  // Simulate the Stage-B G1 landing of intellects.setCapabilities.
  m.intellects.setCapabilities = async (configId, patch, ks) => { captured.push({ configId, patch, ks }); return { capabilities: patch }; };
  const r = await m.provision({ brief: 'x', ks: ADMIN_KS, capabilities: { use_web_search: 'on', avatar: 'on' } });
  assert.equal(captured.length, 1, 'setCapabilities called exactly once');
  assert.equal(captured[0].configId, 1389, 'called with the created configId, AFTER configure');
  assert.deepEqual(captured[0].patch, { use_web_search: 'on', avatar: 'on' });
  assert.equal(r.blocks.capabilities.applied, true);
  assert.deepEqual(r.blocks.capabilities.requested, ['use_web_search', 'avatar']);
  assert.deepEqual(r._meta.optionalBlocks, ['capabilities']);
});

test('opts.capabilities never fails the provision when the method is unmounted', async () => {
  const { m } = baseProvision();
  // setCapabilities is now a PROTOTYPE method on Intellects (Stage-B G1 landed),
  // so `delete` can't remove it; shadow it with an own `undefined` to faithfully
  // simulate a deployment where the contract method is not (yet) a function —
  // exercising provision's feature-detection (typeof fn !== 'function') branch.
  Object.defineProperty(m.intellects, 'setCapabilities', { value: undefined, configurable: true, writable: true });
  const r = await m.provision({ brief: 'x', ks: ADMIN_KS, capabilities: { avatar: 'on' } });
  assert.equal(r.agentId, 'agent-xyz', 'core sequence still completed');
  assert.equal(r.blocks.capabilities.applied, false);
  assert.match(r.blocks.capabilities.reason, /not available/);
});

test('opts.tools creates each tool entity via mgmt.tools.add, then links the successful ids via setToolIds', async () => {
  const { m } = baseProvision();
  const created = [];
  let linkedCall = null;
  // Simulate the Stage-B mount of the standalone, partner-level Tools resource; second tool throws.
  m.tools = {
    list: () => ({ all: async () => [] }),   // no pre-existing tools — every name is a fresh create
    add: async (tool) => {
      created.push(tool.name);
      if (tool.name === 'bad') throw new Error('boom');
      return { id: `id-${tool.name}` };
    },
  };
  m.intellectConfig.setToolIds = async (configId, ids) => { linkedCall = { configId, ids }; return { applied: true }; };
  const r = await m.provision({
    brief: 'x', ks: ADMIN_KS,
    tools: [{ type: 'code', name: 'good', description: 'd', code: '1' }, { type: 'code', name: 'bad', description: 'd', code: '1' }],
  });
  assert.equal(created.length, 2, 'both tools attempted (serialized)');
  assert.deepEqual(r.blocks.tools.attached, ['good']);
  assert.equal(r.blocks.tools.failed.length, 1);
  assert.equal(r.blocks.tools.failed[0].name, 'bad');
  assert.match(r.blocks.tools.failed[0].reason, /boom/);
  assert.deepEqual(r.blocks.tools.ids, ['id-good']);
  assert.equal(r.blocks.tools.linked, true, 'the successfully-created tool WAS linked');
  assert.deepEqual(linkedCall, { configId: 1389, ids: ['id-good'] });
  assert.equal(r.blocks.tools.applied, false, 'partial create failure → applied:false even though linking succeeded');
  assert.equal(r.agentId, 'agent-xyz', 'a tool failure never fails the provision');
});

test('opts.tools reuses (updates) an existing Tool entity sharing the definition\'s name instead of re-adding', async () => {
  const { m } = baseProvision();
  const added = [];
  const updated = [];
  m.tools = {
    list: () => ({ all: async () => [{ id: 'id-existing', name: 'good', config: {} }] }),
    add: async (tool) => { added.push(tool.name); return { id: `id-${tool.name}` }; },
    update: async (id, patch) => { updated.push({ id, name: patch.config.name }); return { id }; },
  };
  m.intellectConfig.setToolIds = async () => ({ applied: true });
  const r = await m.provision({
    brief: 'x', ks: ADMIN_KS,
    tools: [{ type: 'code', name: 'good', description: 'd', code: '1' }],
  });
  assert.deepEqual(added, [], 'add() must NOT be called for a name that already exists');
  assert.deepEqual(updated, [{ id: 'id-existing', name: 'good' }], 'update() reuses the existing entity by id');
  assert.deepEqual(r.blocks.tools.ids, ['id-existing'], 'the pre-existing id is linked, not a freshly-minted one');
  assert.deepEqual(r.blocks.tools.attached, ['good']);
});

test('opts.tools SKIPS overwriting a name-matched existing Tool that is already referenced by another intellect (shared-by-name hazard guard)', async () => {
  // A DIFFERENT intellect (999) still carries "id-existing" in its tool_ids —
  // the fake transport reports that instead of the usual empty /v1/intellect/list.
  const m = new Management({ partnerId: 6496302, adminSecret: 'a'.repeat(32), fetch: fakeFetchWithReferencingIntellect() });
  const updated = [];
  m.tools = {
    list: () => ({ all: async () => [{ id: 'id-existing', name: 'good', config: {} }] }),
    add: async (tool) => ({ id: `id-${tool.name}` }),
    update: async (id, patch) => { updated.push({ id, name: patch.config.name }); return { id }; },
  };
  m.intellectConfig.setToolIds = async () => ({ applied: true });
  const r = await m.provision({
    brief: 'x', ks: ADMIN_KS,
    tools: [{ type: 'code', name: 'good', description: 'd', code: '1' }],
  });
  assert.deepEqual(updated, [], 'update() must NOT be called — the entity is load-bearing for another intellect');
  assert.deepEqual(r.blocks.tools.skippedUpdates, [{ name: 'good', toolId: 'id-existing', referencedBy: [999] }]);
  assert.deepEqual(r.blocks.tools.ids, ['id-existing'], 'the existing id is still reused for THIS intellect\'s own linkage');
  assert.equal(r.blocks.tools.applied, true, 'a skipped (not failed) update does not block applied:true');
});

/** provisionFetch() + an /v1/intellect/list-and-get pair reporting configId 999 as a referencer of "id-existing". */
function fakeFetchWithReferencingIntellect() {
  return fakeFetch([
    { match: '/application/generateAgentProfile', respond: () => ({ body: { name: 'YogaBot', openingPhrase: 'Namaste!' } }) },
    { match: '/v1/intellect/add', respond: () => ({ body: { id: 1389, status: 2, prompts: [] } }) },
    { match: '/v1/intellect/update', respond: () => ({ body: { id: 1389, status: 2 } }) },
    { match: '/agent/create', respond: () => ({ body: { agentId: 'agent-xyz' } }) },
    { match: '/catalog-item/list', respond: (req) => ({ body: { objects: [{ itemId: req.body?.filter?.typeEqual === 'Voice' ? 'voice-1' : 'visual-1' }], totalCount: 1 } }) },
    { match: '/avatar/create', respond: () => ({ body: { id: '6a07d63d8ccd85cbfafc5416' } }) },
    { match: '/application/resolveWidgetId', respond: () => ({ body: { widgetId: '1_v1mj1kxb' } }) },
    { match: '/v1/intellect/list', respond: () => ({ body: { totalCount: 1, objects: [{ id: 999 }] } }) },
    { match: '/v1/intellect/get', respond: () => ({ body: { id: 999, tool_ids: ['id-existing'] } }) },
  ]);
}

test('opts.knowledge creates a category, mints a knowledge record, points it at the category, links it, and enables RAG', async () => {
  const { m } = baseProvision();
  let linkedConfigId = null;
  let linkedIds = null;
  let addedSource = null;
  let enabledCall = null;
  m.knowledge.createCategory = async () => ({ id: 4242 });
  m.knowledge.addRecord = async () => ({ id: 55 });
  m.knowledge.addSource = async (knowledgeId, source) => { addedSource = { knowledgeId, source }; return { applied: true }; };
  m.knowledge.setEnabled = async (configId, enabled) => { enabledCall = { configId, enabled }; return {}; };
  m.intellectConfig.setKnowledgeIds = async (configId, ids) => { linkedConfigId = configId; linkedIds = ids; return { applied: true }; };
  const r = await m.provision({
    brief: 'x', ks: ADMIN_KS,
    knowledge: { name: 'Docs', autoLink: true },
  });
  assert.equal(r.blocks.knowledge.created, true);
  assert.equal(r.blocks.knowledge.categoryId, 4242);
  assert.equal(r.blocks.knowledge.knowledgeId, 55);
  assert.equal(r.blocks.knowledge.linked, true);
  // the record is pointed at the corpus category — not left with an empty config.sources
  assert.deepEqual(addedSource, { knowledgeId: 55, source: { type: 'internal', categoryIds: ['4242'] } });
  assert.equal(linkedConfigId, 1389);
  assert.deepEqual(linkedIds, [55]);
  // use_knowledge_base is turned on — knowledge_ids alone doesn't enable RAG
  assert.deepEqual(enabledCall, { configId: 1389, enabled: true });
});

test('opts.knowledge records a failure without failing the provision', async () => {
  const { m } = baseProvision();
  m.knowledge.createCategory = async () => ({ id: 7 });
  m.knowledge.addRecord = async () => { throw new Error('genie unavailable'); };
  const r = await m.provision({ brief: 'x', ks: ADMIN_KS, knowledge: { name: 'Docs', autoLink: true } });
  assert.equal(r.blocks.knowledge.created, true);
  assert.equal(r.blocks.knowledge.categoryId, 7);
  assert.equal(r.blocks.knowledge.linked, false);
  assert.match(r.blocks.knowledge.reason, /genie unavailable/);
  assert.equal(r.agentId, 'agent-xyz', 'a knowledge-linkage failure NEVER fails the provision');
});

test('opts.knowledge without autoLink creates the category but skips linkage', async () => {
  const { m } = baseProvision();
  m.knowledge.createCategory = async () => ({ id: 9 });
  const r = await m.provision({ brief: 'x', ks: ADMIN_KS, knowledge: { categoryId: 9 } });
  assert.equal(r.blocks.knowledge.created, false, 'reused caller categoryId; nothing created');
  assert.equal(r.blocks.knowledge.linked, false);
  assert.match(r.blocks.knowledge.reason, /autoLink not requested/);
  assert.equal(r.agentId, 'agent-xyz');
});

test('all three optional blocks can fire together and ride the _meta receipt', async () => {
  const { m } = baseProvision();
  m.intellects.setCapabilities = async () => ({});
  m.tools = { list: () => ({ all: async () => [] }), add: async () => ({ id: 'id-good' }) };
  m.intellectConfig.setToolIds = async () => ({ applied: true });
  m.knowledge.createCategory = async () => ({ id: 1 });
  m.knowledge.addRecord = async () => ({ id: 55 });
  m.knowledge.addSource = async () => ({ applied: true });
  m.knowledge.setEnabled = async () => ({});
  m.intellectConfig.setKnowledgeIds = async () => ({ applied: true });
  const r = await m.provision({
    brief: 'x', ks: ADMIN_KS,
    capabilities: { avatar: 'on' },
    tools: [{ type: 'code', name: 'good', description: 'd', code: '1' }],
    knowledge: { name: 'Docs', autoLink: true },
  });
  assert.deepEqual(r._meta.optionalBlocks.sort(), ['capabilities', 'knowledge', 'tools']);
  assert.equal(r.blocks.capabilities.applied, true);
  assert.deepEqual(r.blocks.tools.attached, ['good']);
  assert.equal(r.blocks.knowledge.linked, true);
});

// ─── applyTools() unnamed-tool correctness ────────
// An unnamed tool def can never match an existing entry by name, so the
// existing-tools list() lookup is dead work for that iteration, and the id
// pushed into `ids` must be the id THIS iteration's own add() call returned —
// never a stale value read back out of the `existingByName` map under the
// `undefined` key (which silently holds whatever a PRIOR unnamed iteration set).

test('applyTools skips the existing-tools list() call when the first (and only) tool def has no name', async () => {
  const { m } = baseProvision();
  let listCalls = 0;
  m.tools = {
    list: () => { listCalls += 1; return { all: async () => [] }; },
    add: async (tool) => ({ id: 'fresh-id', name: tool.name }),
  };
  m.intellectConfig.setToolIds = async () => ({ applied: true });
  await m.provision({
    brief: 'x', ks: ADMIN_KS,
    tools: [{ type: 'code', description: 'no name here', code: '1' }], // no `name` field
  });
  assert.equal(listCalls, 0, 'an unnamed-only tool batch can never match anything by name — list() must not be called');
});

test('applyTools pushes the freshly-created id for an unnamed tool, not a stale map entry', async () => {
  const { m } = baseProvision();
  let addSeq = 0;
  m.tools = {
    list: () => ({ all: async () => [] }),
    add: async (tool) => { addSeq += 1; return { id: `own-id-${addSeq}`, name: tool.name }; },
  };
  m.intellectConfig.setToolIds = async () => ({ applied: true });
  const r = await m.provision({
    brief: 'x', ks: ADMIN_KS,
    tools: [
      { type: 'code', description: 'first unnamed tool', code: '1' },
      { type: 'code', description: 'second unnamed tool', code: '2' },
    ],
  });
  // Each unnamed tool's own add() result must land in `ids` at its own position —
  // never the FIRST unnamed tool's id read back for the second (a stale
  // `existingByName.get(undefined)` collision).
  assert.deepEqual(r.blocks.tools.ids, ['own-id-1', 'own-id-2'], 'each unnamed tool keeps its own freshly-created id, not a leftover from a prior iteration');
});
