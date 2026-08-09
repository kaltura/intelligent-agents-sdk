import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/**
 * Skills resource (wire, `/v1/skill/*`, partner-level) — verified live: add
 * returns the full uuid-id entity, delete replies `{id}` and a follow-up get
 * 404s, another partner's id 403s. There is NO skill/update endpoint.
 */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40); // looks like an opaque encrypted KS → server-enforced scope

/** Build a Management whose genie calls hit fakeFetch with the supplied routes. */
function harness(routes) {
  const ff = fakeFetch(routes);
  const mgmt = new Management({ partnerId: '123', fetch: ff });
  return { mgmt, ff };
}

const SKILL = {
  id: 'a1b2c3d4-0000-0000-0000-000000000001', name: 'greeter', description: 'Greets warmly.',
  instructions: null, partner_id: 123, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
};

test('skills.add validates {name, description} BEFORE any network call, then posts v1/skill/add', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/skill/add', respond: (req) => ({ status: 200, body: { ...SKILL, ...req.body } }) },
  ]);
  await assert.rejects(() => mgmt.skills.add(/** @type {any} */ (null), ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.skills.add({ name: '', description: 'd' }, ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.skills.add(/** @type {any} */ ({ name: 'x' }), ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.skills.add({ name: 'x', description: 'd', instructions: /** @type {any} */ (42) }, ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0, 'no transport before validation passes');

  const res = await mgmt.skills.add({ name: 'greeter', description: 'Greets warmly.' }, ADMIN_KS);
  assert.equal(res.name, 'greeter');
  assert.match(ff.calls[0].url, /v1\/skill\/add$/);
  // instructions omitted → NOT sent (stored null server-side)
  assert.deepEqual(ff.calls[0].body, { name: 'greeter', description: 'Greets warmly.' });
});

test('skills.add passes instructions through when given', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/skill/add', respond: (req) => ({ status: 200, body: { ...SKILL, ...req.body } }) },
  ]);
  await mgmt.skills.add({ name: 'greeter', description: 'd', instructions: 'Always say hi.' }, ADMIN_KS);
  assert.equal(ff.calls[0].body.instructions, 'Always say hi.');
});

test('skills.get fetches by uuid id; requires a non-empty string id', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/skill/get', respond: (req) => ({ status: 200, body: { ...SKILL, id: req.body.id } }) },
  ]);
  await assert.rejects(() => mgmt.skills.get('', ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.skills.get(/** @type {any} */ (7), ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0);

  const res = await mgmt.skills.get(SKILL.id, ADMIN_KS);
  assert.equal(res.id, SKILL.id);
  assert.equal(ff.calls[0].body.id, SKILL.id);
});

test('skills.list posts a SkillListFilter and returns the first page (async-iterable + awaitable)', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/skill/list', respond: () => ({ status: 200, body: { totalCount: 1, objects: [SKILL] } }) },
  ]);
  const page = await mgmt.skills.list(ADMIN_KS);
  assert.equal(page.length, 1);
  assert.equal(page[0].id, SKILL.id);
  assert.equal(ff.calls[0].body.filter.objectType, 'SkillListFilter');
});

test('skills.delete requires confirmPermanent, then deletes by id with a _meta receipt', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/skill/delete', respond: (req) => ({ status: 200, body: { id: req.body.id } }) },
  ]);
  await assert.rejects(() => mgmt.skills.delete(SKILL.id, ADMIN_KS, /** @type {any} */ ({})), (e) => e.code === 'confirmation_required');
  assert.equal(ff.calls.length, 0, 'no write before confirmation');

  const res = await mgmt.skills.delete(SKILL.id, ADMIN_KS, { confirmPermanent: true });
  assert.equal(res.removed, SKILL.id);
  assert.match(res._meta.generatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(res._meta.scope, `skill:${SKILL.id}`);
  assert.equal(ff.calls[0].body.id, SKILL.id);
});

test('every skills wire method asserts admin scope (rejects a conversation token)', async () => {
  const { mgmt } = harness([]);
  const convToken = { ks: 'djJ8conv', kind: 'conversation' };
  await assert.rejects(async () => mgmt.skills.add({ name: 'x', description: 'd' }, convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.skills.get(SKILL.id, convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.skills.delete(SKILL.id, convToken, { confirmPermanent: true }), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.skills.list(convToken), (e) => e.code === 'wrong_token_scope');
});
