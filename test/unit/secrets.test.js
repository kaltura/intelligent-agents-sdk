import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/index.js';
import { IntellectSecrets, validateSecretRefs, MASK } from '../../src/management/secrets.js';
import { fakeFetch } from '../fakes/fetch.js';

/**
 * Secrets lifecycle. Secrets are WRITE-ONLY (masked "***" on read) with a
 * server-side merge-keep guard: re-sending "***" preserves the stored value.
 * Every op is a read-merge-write of the FULL config.secrets dict. These tests
 * drive the REAL Management Ctx (scope guard + genie transport) via the fetch
 * double, capturing the intellect/update body the SDK sends.
 */

function fakeKs(priv) {
  const raw = `v2|999|${priv}`;
  const b64 = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'djJ8' + b64;
}
const ADMIN = fakeKs('disableentitlement');
const CONV = fakeKs('geniegpcid:1222');

/**
 * Build a Management whose genie backend mimics intellect/get + intellect/update
 * over a mutable in-memory `secrets` dict (the server-side store). The "***"
 * merge-keep guard is implemented on the GET side: get always returns "***" for
 * every stored secret. On UPDATE we record the raw body, then apply the
 * merge-keep rule to mutate the store (a value "***" keeps the prior value).
 * @param {{type?:unknown, secrets?:Record<string,string>}} [initial]
 */
function harness(initial = {}) {
  const store = { type: initial.type ?? 'internal', secrets: { ...(initial.secrets || {}) } };
  /** @type {object[]} */ const updateBodies = [];
  const fetch = fakeFetch([
    {
      match: 'v1/intellect/get',
      respond: () => ({ body: { id: 7, type: store.type, secrets: maskAll(store.secrets) } }),
    },
    {
      match: 'v1/intellect/update',
      respond: (req) => {
        updateBodies.push(req.body);
        const incoming = (req.body && req.body.secrets) || {};
        // Replace-the-whole-dict semantics with the merge-keep guard: omitted
        // keys are dropped; a "***" value preserves the prior stored value.
        const next = {};
        for (const [k, v] of Object.entries(incoming)) {
          next[k] = v === MASK ? store.secrets[k] : v;
        }
        store.secrets = next;
        return { body: { id: 7, type: store.type, secrets: maskAll(store.secrets) } };
      },
    },
  ]);
  const m = new Management({ partnerId: 999, adminSecret: 'x'.repeat(32), fetch });
  return { secrets: new IntellectSecrets(m._ctx), store, updateBodies, fetch };
}

function maskAll(s) {
  const out = {};
  for (const k of Object.keys(s)) out[k] = MASK;
  return out;
}
/** Last recorded intellect/update body's secrets dict. */
function lastSecretsBody(h) { return h.updateBodies[h.updateBodies.length - 1].secrets; }

test('listNames returns only names, masks values (no plaintext escapes)', async () => {
  const h = harness({ secrets: { A: 'aaa', B: 'bbb' } });
  const out = await h.secrets.listNames(7, ADMIN);
  assert.deepEqual(out.names, ['A', 'B']);
  // The masked/plaintext value must appear NOWHERE in the result.
  const json = JSON.stringify(out);
  assert.equal(json.includes('aaa'), false);
  assert.equal(json.includes('bbb'), false);
  assert.equal(json.includes(MASK), false, 'masks are dropped, only names surface');
  assert.equal(out._meta.scope, 'intellect:7');
  assert.ok(out._meta.generatedAt, '_meta carries a freshness receipt');
});

test('set merges a new key while preserving existing secrets via the "***" guard', async () => {
  const h = harness({ secrets: { A: 'aaa', B: 'bbb' } });
  const out = await h.secrets.set(7, { C: 'ccc' }, ADMIN);
  // The wire body re-sends prior secrets as "***" and the new value verbatim.
  assert.deepEqual(lastSecretsBody(h), { A: MASK, B: MASK, C: 'ccc' });
  assert.deepEqual(out.set, ['C']);
  assert.deepEqual(out.names, ['A', 'B', 'C']);
  // Server-side store kept A/B (the merge-keep guard) and added C.
  assert.deepEqual(h.store.secrets, { A: 'aaa', B: 'bbb', C: 'ccc' });
});

test('"***" round-trip preserves the stored value (no clobber on set of a sibling)', async () => {
  const h = harness({ secrets: { A: 'aaa', B: 'bbb' } });
  await h.secrets.set(7, { B: 'new-b' }, ADMIN);
  // A re-sent as "***" → preserved; B overwritten.
  assert.deepEqual(lastSecretsBody(h), { A: MASK, B: 'new-b' });
  assert.deepEqual(h.store.secrets, { A: 'aaa', B: 'new-b' });
});

test('delete removes one key without clobbering the others', async () => {
  const h = harness({ secrets: { A: 'aaa', B: 'bbb', C: 'ccc' } });
  const out = await h.secrets.delete(7, 'B', ADMIN, { confirmPermanent: true });
  // The update body omits B (drop) and re-sends A/C as "***".
  assert.deepEqual(lastSecretsBody(h), { A: MASK, C: MASK });
  assert.equal(out.removed, 'B');
  assert.deepEqual(out.names, ['A', 'C']);
  assert.deepEqual(h.store.secrets, { A: 'aaa', C: 'ccc' });
});

test('delete requires confirmation and guards not_found', async () => {
  const h = harness({ secrets: { A: 'aaa' } });
  await assert.rejects(() => h.secrets.delete(7, 'A', ADMIN), (e) => e.code === 'confirmation_required');
  await assert.rejects(
    () => h.secrets.delete(7, 'MISSING', ADMIN, { confirmPermanent: true }),
    (e) => e.code === 'not_found',
  );
});

test('set rejects the literal "***" and empty values BEFORE any network call', async () => {
  const h = harness({ secrets: { A: 'aaa' } });
  const before = h.fetch.calls.length;
  await assert.rejects(() => h.secrets.set(7, { X: MASK }, ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => h.secrets.set(7, { X: '' }, ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => h.secrets.set(7, {}, ADMIN), (e) => e.code === 'bad_request');
  assert.equal(h.fetch.calls.length, before, 'no fetch happened on invalid input');
});

test('has reports presence only', async () => {
  const h = harness({ secrets: { A: 'aaa' } });
  assert.equal(await h.secrets.has(7, 'A', ADMIN), true);
  assert.equal(await h.secrets.has(7, 'NOPE', ADMIN), false);
});

test('replaceAll drops omitted keys (destructive, confirmed)', async () => {
  const h = harness({ secrets: { A: 'aaa', B: 'bbb' } });
  await assert.rejects(() => h.secrets.replaceAll(7, { C: 'ccc' }, ADMIN), (e) => e.code === 'confirmation_required');
  const out = await h.secrets.replaceAll(7, { C: 'ccc' }, ADMIN, { confirmPermanent: true });
  assert.deepEqual(lastSecretsBody(h), { C: 'ccc' });
  assert.deepEqual(out.names, ['C']);
  assert.deepEqual(h.store.secrets, { C: 'ccc' });
});

test('every wire method asserts the admin scope (rejects a conversation token)', async () => {
  const h = harness({ secrets: { A: 'aaa' } });
  for (const call of [
    () => h.secrets.listNames(7, CONV),
    () => h.secrets.has(7, 'A', CONV),
    () => h.secrets.set(7, { B: 'b' }, CONV),
    () => h.secrets.delete(7, 'A', CONV, { confirmPermanent: true }),
    () => h.secrets.replaceAll(7, { B: 'b' }, CONV, { confirmPermanent: true }),
    () => h.secrets.validate(7, CONV),
  ]) {
    await assert.rejects(call, (e) => e.code === 'wrong_token_scope');
  }
});

test('configId must be a non-negative integer (typed bad_request before network)', async () => {
  const h = harness();
  const before = h.fetch.calls.length;
  await assert.rejects(() => h.secrets.listNames('7', ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => h.secrets.set(-1, { A: 'a' }, ADMIN), (e) => e.code === 'bad_request');
  assert.equal(h.fetch.calls.length, before);
});

test('the update body carries the {id,type} discriminator read from the DTO', async () => {
  const h = harness({ type: 'internal', secrets: {} });
  await h.secrets.set(7, { A: 'aaa' }, ADMIN);
  const body = h.updateBodies[h.updateBodies.length - 1];
  assert.equal(body.id, 7);
  assert.equal(body.type, 'internal');
});

test('validate flags an unresolved {{secrets.X}} ref and lists dead secrets', async () => {
  const tool = {
    weather: {
      type: 'api',
      request: {
        url: 'https://api.example.com',
        headers: { Authorization: 'Bearer {{secrets.MISSING}}' },
      },
    },
  };
  const fetch = fakeFetch([
    {
      match: 'v1/intellect/get',
      respond: () => ({ body: { id: 7, type: 'internal', config: { secrets: { UNUSED: MASK }, tools: tool } } }),
    },
  ]);
  const m = new Management({ partnerId: 999, adminSecret: 'x'.repeat(32), fetch });
  const s = new IntellectSecrets(m._ctx);
  const out = await s.validate(7, ADMIN);
  assert.equal(out.ok, false);
  assert.deepEqual(out.unresolved, [{ ref: 'MISSING', where: 'tools' }]);
  assert.deepEqual(out.unused, ['UNUSED']);
  assert.ok(out._meta.generatedAt);
});

test('validate flags the NON-RESOLVING {{variables.secrets.X}} prefix as a defect even for a KNOWN secret', async () => {
  // The prefixed form renders empty at the backend, so it is wrong regardless of whether
  // the bare name exists — it must NOT be normalized to ok:true (the masking bug this fixes).
  const tool = { weather: { type: 'api', request: { url: 'https://api.example.com', headers: { Authorization: 'Bearer {{variables.secrets.DEMO_API_KEY}}' } } } };
  const fetch = fakeFetch([{ match: 'v1/intellect/get', respond: () => ({ body: { id: 7, type: 'internal', config: { secrets: { DEMO_API_KEY: MASK }, tools: tool } } }) }]);
  const m = new Management({ partnerId: 999, adminSecret: 'x'.repeat(32), fetch });
  const out = await new IntellectSecrets(m._ctx).validate(7, ADMIN);
  assert.equal(out.ok, false, 'a {{variables.secrets.X}} prefix is never ok, even when X exists');
  assert.equal(out.unresolved.length, 0, 'not "unresolved" — the name is known; it is a bad PREFIX');
  assert.deepEqual(out.badPrefix.map((b) => b.ref), ['DEMO_API_KEY']);
  assert.match(out.badPrefix[0].note, /\{\{secrets\.X\}\}/);
});

/** ---- pure validateSecretRefs ---- */

test('validateSecretRefs (object form) resolves canonical {{secrets.X}} refs across tools/prompts', () => {
  const r = validateSecretRefs({
    secretNames: ['OAUTH', 'API_KEY'],
    tools: { t: { request: { authentication: { client_secret: '{{secrets.OAUTH}}' } } } },
    prompts: [{ value: 'reminder: send {{secrets.API_KEY}} in the X-Key header' }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.unresolved, []);
  assert.deepEqual(r.badPrefix, []);
  assert.deepEqual(r.unused, []);
  assert.equal(r.references.length, 2);
});

test('validateSecretRefs (toolConfig, secretNames) overload reports an unknown-name as unresolved', () => {
  const toolConfig = { request: { body: { token: '{{secrets.GHOST}}' } } };
  const r = validateSecretRefs(toolConfig, ['REAL']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unresolved, [{ ref: 'GHOST', where: 'tools' }]);
  assert.deepEqual(r.unused, ['REAL']);
});

test('validateSecretRefs DISTINGUISHES the bad {{variables.secrets.X}} prefix from canonical refs', () => {
  const r = validateSecretRefs({ secretNames: ['A', 'B'], tools: { a: '{{secrets.A}}', b: '{{ variables.secrets.B }}' } });
  assert.equal(r.ok, false, 'the prefixed B ref forces ok:false');
  assert.deepEqual(r.badPrefix.map((x) => x.ref), ['B']);
  assert.equal(r.references.length, 2);
  // A is canonical and known → not flagged; B is prefixed → flagged regardless of being known.
  assert.deepEqual(r.unresolved, []);
});

test('validateSecretRefs never throws on odd input and warns rather than errors', () => {
  const r = validateSecretRefs({ secretNames: ['ORPHAN'] });
  assert.equal(r.ok, true, 'no refs at all → ok, unresolved empty');
  assert.deepEqual(r.unused, ['ORPHAN']);
});
