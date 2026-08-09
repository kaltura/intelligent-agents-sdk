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

test('opts.knowledge creates a category and links when ungated', async () => {
  const { m } = baseProvision();
  // createCategory is the Stage-B G2 landing — simulate it; linkAvailable says OK.
  let linked = null;
  m.knowledge.createCategory = async () => ({ id: 4242 });
  m.knowledge.linkAvailable = async () => ({ available: true, reason: 'reachable' });
  m.knowledge.linkCategory = async (opts) => { linked = opts; return { ok: true }; };
  const r = await m.provision({
    brief: 'x', ks: ADMIN_KS,
    knowledge: { name: 'Docs', autoLink: true, modalities: ['document', 'ocr'] },
  });
  assert.equal(r.blocks.knowledge.created, true);
  assert.equal(r.blocks.knowledge.categoryId, 4242);
  assert.equal(r.blocks.knowledge.linked, true);
  assert.equal(r.blocks.knowledge.gated, false);
  assert.equal(linked.configId, 1389);
  assert.equal(linked.categoryId, 4242);
  assert.deepEqual(linked.modalities, ['document', 'ocr']);
});

test('opts.knowledge records the HONEST gate (403) without failing the provision', async () => {
  const { m } = baseProvision();
  m.knowledge.createCategory = async () => ({ id: 7 });
  // The linkage write is deployment-gated → linkAvailable reports unavailable.
  m.knowledge.linkAvailable = async () => ({ available: false, reason: 'partner-config/update needs a higher privilege than a partner admin KS (deployment-gated)' });
  let linkCalled = false;
  m.knowledge.linkCategory = async () => { linkCalled = true; throw new Error('should not be called when gated'); };
  const r = await m.provision({ brief: 'x', ks: ADMIN_KS, knowledge: { name: 'Docs', autoLink: true } });
  assert.equal(linkCalled, false, 'short-circuits on the gate; never attempts the 403 write');
  assert.equal(r.blocks.knowledge.created, true);
  assert.equal(r.blocks.knowledge.categoryId, 7);
  assert.equal(r.blocks.knowledge.linked, false);
  assert.equal(r.blocks.knowledge.gated, true);
  assert.match(r.blocks.knowledge.reason, /privilege|403/);
  assert.equal(r.agentId, 'agent-xyz', 'gated linkage NEVER fails the provision');
});

test('opts.knowledge surfaces a runtime 403 from linkCategory as gated, not fatal', async () => {
  const { m } = baseProvision();
  m.knowledge.createCategory = async () => ({ id: 9 });
  m.knowledge.linkAvailable = async () => ({ available: true, reason: 'reachable' }); // probe passes…
  m.knowledge.linkCategory = async () => { const e = new Error('Forbidden'); e.status = 403; throw e; }; // …but the write 403s
  const r = await m.provision({ brief: 'x', ks: ADMIN_KS, knowledge: { categoryId: 9, autoLink: true } });
  assert.equal(r.blocks.knowledge.created, false, 'reused caller categoryId; nothing created');
  assert.equal(r.blocks.knowledge.linked, false);
  assert.equal(r.blocks.knowledge.gated, true);
  assert.match(r.blocks.knowledge.reason, /403/);
  assert.equal(r.agentId, 'agent-xyz');
});

test('opts.knowledge honors the REAL linkCategory contract: applied:false (not a throw) → gated, never faked linked:true', async () => {
  const { m } = baseProvision();
  m.knowledge.createCategory = async () => ({ id: 11 });
  m.knowledge.linkAvailable = async () => ({ available: true, reason: 'reachable' }); // probe passes…
  // The LANDED Knowledge.linkCategory (conversations.js) does NOT throw on the deployment gate —
  // it catches the 403 and RETURNS {applied:false, code:'forbidden', reason}. provision
  // must inspect that and report gated, NOT fake linked:true off a resolved promise.
  m.knowledge.linkCategory = async () => ({ applied: false, code: 'forbidden', reason: 'partner-config/update needs a higher privilege than a partner admin KS (deployment-gated)' });
  const r = await m.provision({ brief: 'x', ks: ADMIN_KS, knowledge: { name: 'Docs', autoLink: true } });
  assert.equal(r.blocks.knowledge.created, true);
  assert.equal(r.blocks.knowledge.categoryId, 11);
  assert.equal(r.blocks.knowledge.linked, false, 'must NOT fake linked:true when the real method returns applied:false');
  assert.equal(r.blocks.knowledge.gated, true);
  assert.match(r.blocks.knowledge.reason, /privilege|403|forbidden/);
  assert.equal(r.agentId, 'agent-xyz', 'gated linkage NEVER fails the provision');
});

test('opts.knowledge: a 404 not_deployed from the real linkCategory is gated, not linked', async () => {
  const { m } = baseProvision();
  m.knowledge.createCategory = async () => ({ id: 12 });
  m.knowledge.linkAvailable = async () => ({ available: true });
  m.knowledge.linkCategory = async () => ({ applied: false, code: 'not_deployed', reason: 'partner-config route not on this deployment' });
  const r = await m.provision({ brief: 'x', ks: ADMIN_KS, knowledge: { categoryId: 12, autoLink: true } });
  assert.equal(r.blocks.knowledge.linked, false);
  assert.equal(r.blocks.knowledge.gated, true);
  assert.equal(r.agentId, 'agent-xyz');
});

test('opts.knowledge: a genuine applied:true from linkCategory reports linked:true', async () => {
  const { m } = baseProvision();
  m.knowledge.createCategory = async () => ({ id: 13 });
  m.knowledge.linkAvailable = async () => ({ available: true });
  m.knowledge.linkCategory = async () => ({ applied: true, result: { ok: true } });
  const r = await m.provision({ brief: 'x', ks: ADMIN_KS, knowledge: { categoryId: 13, autoLink: true } });
  assert.equal(r.blocks.knowledge.linked, true);
  assert.equal(r.blocks.knowledge.gated, false);
});

test('all three optional blocks can fire together and ride the _meta receipt', async () => {
  const { m } = baseProvision();
  m.intellects.setCapabilities = async () => ({});
  m.tools = { list: () => ({ all: async () => [] }), add: async () => ({ id: 'id-good' }) };
  m.intellectConfig.setToolIds = async () => ({ applied: true });
  m.knowledge.createCategory = async () => ({ id: 1 });
  m.knowledge.linkAvailable = async () => ({ available: true });
  m.knowledge.linkCategory = async () => ({});
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

// ─── issue #17 (rules 3.1 / 3.2) — applyTools() unnamed-tool correctness ────────
// An unnamed tool def can never match an existing entry by name, so the
// existing-tools list() lookup is dead work for that iteration, and the id
// pushed into `ids` must be the id THIS iteration's own add() call returned —
// never a stale value read back out of the `existingByName` map under the
// `undefined` key (which silently holds whatever a PRIOR unnamed iteration set).

test('applyTools skips the existing-tools list() call when the first (and only) tool def has no name (#17 rule 3.1)', async () => {
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

test('applyTools pushes the freshly-created id for an unnamed tool, not a stale map entry (#17 rule 3.2)', async () => {
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
