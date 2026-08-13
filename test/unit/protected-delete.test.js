/**
 * Production-resource delete guard (regression for the incident where a blind
 * cleanup-by-tag sweep deleted a real, in-use agent's intellect).
 *
 * `agents.delete` must REFUSE an agent carrying a protected admin tag
 * (`prod`, `keep`, `do-not-delete`, `live`) unless the caller ALSO passes
 * `{ allowProtected: true }` — so an automated sweep that only sets
 * `{ confirmPermanent: true }` can never nuke production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management, matchProtectedTag, PROTECTED_TAGS } from '../../src/management/index.js';
import { fakeFetch } from '../fakes/fetch.js';

const ADMIN = 'djJ8MXxb=ADMIN-token-placeholder';

test('matchProtectedTag flags production markers + clears throwaway tags', () => {
  assert.equal(matchProtectedTag(['prod-eu']), 'prod-eu');
  assert.equal(matchProtectedTag(['keep']), 'keep');
  assert.equal(matchProtectedTag(['do-not-delete']), 'do-not-delete');
  assert.equal(matchProtectedTag(['qa-e2e-x', 'throwaway']), null);
  assert.equal(matchProtectedTag(undefined), null);
  assert.ok(PROTECTED_TAGS.length > 0);
});

test('agents.delete REFUSES a protected agent with only confirmPermanent (no agent/delete call fires)', async () => {
  const f = fakeFetch([
    { match: '/agent/get', respond: () => ({ body: { agentId: 'a1', adminTags: ['do-not-delete'] } }) },
    { match: '/agent/delete', respond: () => ({ body: { ok: true } }) },
  ]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    () => k.agents.delete('a1', ADMIN, { confirmPermanent: true }),
    (e) => e.code === 'protected_resource' && /do-not-delete/.test(e.detail) && /allowProtected/.test(e.detail),
  );
  // The guard fired BEFORE any destructive call.
  assert.equal(f.calls.filter((c) => c.url.includes('/agent/delete')).length, 0);
});

test('agents.delete ALLOWS a protected agent when allowProtected:true is passed', async () => {
  const f = fakeFetch([
    { match: '/agent/get', respond: () => ({ body: { agentId: 'a1', adminTags: ['do-not-delete'] } }) },
    { match: '/agent/delete', respond: () => ({ body: { ok: true } }) },
  ]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await k.agents.delete('a1', ADMIN, { confirmPermanent: true, allowProtected: true });
  assert.equal(f.calls.filter((c) => c.url.includes('/agent/delete')).length, 1);
});

test('agents.delete proceeds normally for a throwaway-tagged agent', async () => {
  const f = fakeFetch([
    { match: '/agent/get', respond: () => ({ body: { agentId: 'a2', adminTags: ['qa-e2e-tools'] } }) },
    { match: '/agent/delete', respond: () => ({ body: { ok: true } }) },
  ]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await k.agents.delete('a2', ADMIN, { confirmPermanent: true });
  assert.equal(f.calls.filter((c) => c.url.includes('/agent/delete')).length, 1);
});
