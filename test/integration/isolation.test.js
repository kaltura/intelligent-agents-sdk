import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/index.js';
import { fakeFetch } from '../fakes/fetch.js';

/**
 * Isolation (tracker #17, rule 1.1/1.2 — "per-instance state only, no
 * module-level mutable state"). Proves:
 *
 *  1. Two independent `Management` instances never share their resource
 *     objects (`tools`, `intellectConfig`, `intellects`, `agents`) or their
 *     internal `ctx` — each is constructed fresh per `new Management(...)`
 *     (client.js constructor) and `Tools`/`IntellectConfig` hold ONLY that
 *     `ctx` reference (`this._`), no other mutable field (tools.js,
 *     intellect-config.js).
 *  2. `provision.js`'s `applyTools()` internal `existingByName` lookup map
 *     (declared with `let existingByName;` INSIDE the function body) is
 *     call-scoped, not hoisted to module scope. This is proven BEHAVIORALLY,
 *     not by reading the source: two `provision()` calls — on two different
 *     `Management` instances, each with its OWN (stubbed) `tools` resource —
 *     request a tool with the SAME `name`. One instance's store already has
 *     that name (must UPDATE its own existing id); the other's store is
 *     empty (must ADD a fresh one). If `existingByName` were ever hoisted to
 *     module scope, the second call would find the first call's cached
 *     entry already populated — skipping its OWN `tools.list()` fetch (the
 *     `??=` short-circuit) and incorrectly reusing the first call's id via
 *     `update()` instead of creating its own via `add()`. That regression is
 *     exactly what these tests would catch.
 */

/** Build an admin (disableentitlement) KS for a given partner — same shape used across the suite. */
function adminKs(partnerId) {
  return 'djJ8' + Buffer.from(`v2|${partnerId}|disableentitlement`).toString('base64url');
}

/** A fake-fetch mimicking the full documented provision sequence, parameterized so two instances produce distinguishable ids (mirrors provision.test.js's provisionFetch). */
function provisionFetch({ configId, agentId, avatarId, widgetId, voiceItemId, visualItemId }) {
  return fakeFetch([
    { match: '/application/generateAgentProfile', respond: () => ({ body: { name: `Bot-${configId}`, openingPhrase: 'Hi!' } }) },
    { match: '/v1/intellect/add', respond: () => ({ body: { id: configId, status: 2, prompts: [] } }) },
    { match: '/v1/intellect/update', respond: () => ({ body: { id: configId, status: 2 } }) },
    { match: '/agent/create', respond: () => ({ body: { agentId } }) },
    { match: '/catalog-item/list', respond: (req) => ({ body: { objects: [{ itemId: req.body?.filter?.typeEqual === 'Voice' ? voiceItemId : visualItemId }], totalCount: 1 } }) },
    { match: '/avatar/create', respond: () => ({ body: { id: avatarId } }) },
    { match: '/application/resolveWidgetId', respond: () => ({ body: { widgetId } }) },
    // applyTools()'s shared-by-name hazard guard checks this before overwriting a
    // name-matched existing Tool's config — no other intellect references it here.
    { match: '/v1/intellect/list', respond: () => ({ body: { totalCount: 0, objects: [] } }) },
  ]);
}

/** One fully independent {m, f, ks} triple for a given partner+configId. */
function mkInstance(partnerId, configId) {
  const f = provisionFetch({
    configId, agentId: `agent-${configId}`,
    avatarId: `avatar-${configId}`, widgetId: `widget-${configId}`,
    voiceItemId: `voice-${configId}`, visualItemId: `visual-${configId}`,
  });
  const m = new Management({ partnerId, adminSecret: 'a'.repeat(32), fetch: f });
  return { m, f, ks: adminKs(partnerId) };
}

describe('Isolation (issue #17 §1.1/1.2): per-instance state only, no module-level mutable state', () => {
  test('two Management instances never share resource objects or ctx', () => {
    const a = mkInstance(1001, 111).m;
    const b = mkInstance(2002, 222).m;

    assert.notStrictEqual(a, b);
    // Every resource namespace is constructed fresh per `new Management(...)`
    // (client.js constructor: `this.tools = new Tools(ctx)`, etc.) — never a
    // shared/module-level singleton.
    assert.notStrictEqual(a.tools, b.tools, 'Tools instances must be independent');
    assert.notStrictEqual(a.intellectConfig, b.intellectConfig, 'IntellectConfig instances must be independent');
    assert.notStrictEqual(a.intellects, b.intellects, 'Intellects instances must be independent');
    assert.notStrictEqual(a.agents, b.agents, 'Agents instances must be independent');
    assert.notStrictEqual(a.avatars, b.avatars, 'Avatars instances must be independent');

    // The internal ctx (partnerId + transport closures) is independent too.
    assert.notStrictEqual(a._ctx, b._ctx, 'ctx object must be independent');
    assert.notStrictEqual(a._ctx.partnerId, b._ctx.partnerId);
    assert.equal(a._ctx.partnerId, '1001');
    assert.equal(b._ctx.partnerId, '2002');

    // Tools and IntellectConfig hold ONLY the ctx they were constructed with
    // (`this._ = ctx` — tools.js `class Tools`, intellect-config.js
    // `class IntellectConfig`) — no other mutable field, so per-instance
    // isolation reduces to "each got its own ctx", asserted directly.
    assert.notStrictEqual(a.tools._, b.tools._);
    assert.strictEqual(a.tools._, a._ctx);
    assert.strictEqual(b.tools._, b._ctx);
    assert.notStrictEqual(a.intellectConfig._, b.intellectConfig._);
    assert.strictEqual(a.intellectConfig._, a._ctx);
    assert.strictEqual(b.intellectConfig._, b._ctx);
  });

  test('concurrent tools.add() on two instances never cross-contaminate requests or receipts', async () => {
    // Two more independent instances, each with a fake transport that ALSO
    // serves /v1/tool/add, so tools.add() can be driven directly.
    const routedA = mkRoutedForTools(3001, 301);
    const routedB = mkRoutedForTools(3002, 302);

    const [resA, resB] = await Promise.all([
      routedA.m.tools.add({ type: 'code', name: 'toolA', description: 'd', code: '1' }, routedA.ks),
      routedB.m.tools.add({ type: 'code', name: 'toolB', description: 'd', code: '2' }, routedB.ks),
    ]);

    assert.equal(resA.id, 'tool-301-toolA');
    assert.equal(resB.id, 'tool-302-toolB');
    // Each instance's OWN fake transport only ever saw its OWN tool name.
    const namesSeenByA = routedA.f.calls.filter((c) => c.url.includes('/v1/tool/add')).map((c) => c.body?.name);
    const namesSeenByB = routedB.f.calls.filter((c) => c.url.includes('/v1/tool/add')).map((c) => c.body?.name);
    assert.deepEqual(namesSeenByA, ['toolA']);
    assert.deepEqual(namesSeenByB, ['toolB']);
  });
});

/** A Management instance whose fake transport additionally serves /v1/tool/add so `tools.add` can be driven directly. */
function mkRoutedForTools(partnerId, configId) {
  const f = fakeFetch([
    { match: '/v1/tool/add', respond: (req) => ({ body: { id: `tool-${configId}-${req.body?.name}`, name: req.body?.name, config: req.body?.config } }) },
  ]);
  const m = new Management({ partnerId, adminSecret: 'a'.repeat(32), fetch: f });
  return { m, f, ks: adminKs(partnerId) };
}

describe('provision.js applyTools(): existingByName lookup map is call-scoped, not module-scoped', () => {
  /** A stubbed `mgmt.tools` resource that records list()/add()/update() calls against a private, per-call store. */
  function stubToolsResource(existing) {
    const calls = { list: 0, add: [], update: [] };
    return {
      calls,
      tools: {
        list: () => { calls.list++; return { all: async () => existing.slice() }; },
        add: async (tool) => { calls.add.push(tool.name); return { id: `new-${tool.name}` }; },
        update: async (id, patch) => { calls.update.push({ id, name: patch.config.name }); return { id }; },
      },
    };
  }

  test('sequential provision() calls with an overlapping tool NAME on two Management instances never share the cache', async () => {
    const a = mkInstance(4001, 401);
    const b = mkInstance(4002, 402);

    // A's OWN tool store already has a tool literally named "shared" —
    // provision(A) must UPDATE it and keep using A's own id.
    const stubA = stubToolsResource([{ id: 'A-existing', name: 'shared', config: {} }]);
    a.m.tools = stubA.tools;
    a.m.intellectConfig.setToolIds = async () => ({ applied: true });

    // B's OWN tool store is EMPTY — a tool named "shared" is brand-new for B
    // and MUST be ADDED, never resolved from A's map/id.
    const stubB = stubToolsResource([]);
    b.m.tools = stubB.tools;
    b.m.intellectConfig.setToolIds = async () => ({ applied: true });

    const toolDef = { type: 'code', name: 'shared', description: 'd', code: '1' };

    // Run A's provision, THEN B's. If `existingByName` were hoisted to module
    // scope, B's call would find A's already-populated map (the `??=` guard
    // short-circuiting BEFORE B's own tools.list() ever runs) and would
    // incorrectly UPDATE A's "A-existing" id instead of ADDing a fresh Tool
    // against B's own (empty) store.
    const rA = await a.m.provision({ brief: 'x', ks: a.ks, tools: [toolDef] });
    const rB = await b.m.provision({ brief: 'x', ks: b.ks, tools: [toolDef] });

    assert.equal(stubA.calls.list, 1, "A's own tools.list() was consulted");
    assert.deepEqual(stubA.calls.update, [{ id: 'A-existing', name: 'shared' }], 'A updates its OWN existing tool');
    assert.deepEqual(stubA.calls.add, [], 'A never calls add() for a name it already has');
    assert.deepEqual(rA.blocks.tools.ids, ['A-existing']);

    assert.equal(stubB.calls.list, 1, "B's own tools.list() MUST be consulted fresh — proves no leaked cache short-circuited the lazy fetch");
    assert.deepEqual(stubB.calls.add, ['shared'], "B creates a NEW tool — must not reuse A's cached entry/id");
    assert.deepEqual(stubB.calls.update, [], 'B never "updates" a tool it never had');
    assert.deepEqual(rB.blocks.tools.ids, ['new-shared'], "B's id is its own fresh id, not A's \"A-existing\"");
    assert.notEqual(rB.blocks.tools.ids[0], rA.blocks.tools.ids[0]);
  });

  test('concurrent provision() calls (Promise.all) with an overlapping tool NAME stay isolated', async () => {
    const a = mkInstance(5001, 501);
    const b = mkInstance(5002, 502);
    const stubA = stubToolsResource([{ id: 'A-existing-2', name: 'dup', config: {} }]);
    const stubB = stubToolsResource([]);
    a.m.tools = stubA.tools; a.m.intellectConfig.setToolIds = async () => ({ applied: true });
    b.m.tools = stubB.tools; b.m.intellectConfig.setToolIds = async () => ({ applied: true });
    const toolDef = { type: 'code', name: 'dup', description: 'd', code: '1' };

    const [rA, rB] = await Promise.all([
      a.m.provision({ brief: 'x', ks: a.ks, tools: [toolDef] }),
      b.m.provision({ brief: 'x', ks: b.ks, tools: [toolDef] }),
    ]);

    assert.deepEqual(rA.blocks.tools.ids, ['A-existing-2'], "A resolves its OWN existing id even when B's call races it");
    assert.deepEqual(rB.blocks.tools.ids, ['new-dup'], "B creates its OWN fresh tool even when A's call races it");
    assert.deepEqual(stubA.calls.add, [], 'A never adds — it already had "dup"');
    assert.deepEqual(stubB.calls.update, [], 'B never updates — it never had "dup"');
  });
});
