import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/index.js';
import { inspectKs } from '../../src/management/ks-inspect.js';
import { fakeFetch } from '../fakes/fetch.js';

/** Build a fake KSv2 carrying the given privilege string (matches inspectKs decoding). */
function fakeKs(priv) {
  const raw = `v2|999|${priv}`;
  const b64 = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'djJ8' + b64;
}

const ADMIN = fakeKs('disableentitlement');
const CONV = fakeKs('geniegpcid:1222');

test('inspectKs decodes partnerId + kind', () => {
  assert.equal(inspectKs(ADMIN).kind, 'admin');
  assert.equal(inspectKs(ADMIN).disableEntitlement, true);
  assert.equal(inspectKs(CONV).kind, 'conversation');
  assert.equal(inspectKs(CONV).partnerId, '999');
  assert.equal(inspectKs('not-a-ks').ok, false);
});

test('management methods reject a conversation token where admin is required', async () => {
  const m = new Management({ partnerId: 999, adminSecret: 'x'.repeat(32) });
  await assert.rejects(async () => m.agents.list(CONV), (e) => e.code === 'wrong_token_scope');
});

test('conversation methods reject an admin token (never converse with disableentitlement)', async () => {
  const m = new Management({ partnerId: 999, adminSecret: 'x'.repeat(32) });
  await assert.rejects(() => m.conversations.status(ADMIN), (e) => e.code === 'wrong_token_scope');
});

test('conversations.stream is a generator: its scope guard fires on iteration, not at call time (DW-05 documented behavior)', async () => {
  const m = new Management({ partnerId: 999, adminSecret: 'x'.repeat(32) });
  // Calling stream() with a wrong-scope admin token does NOT throw synchronously —
  // the generator body (incl. assertConversation) only runs on the first .next().
  const gen = m.conversations.stream({ userMessage: 'hi' }, ADMIN);
  // Iterating triggers the guard with the documented typed error.
  await assert.rejects(() => gen.next(), (e) => e.code === 'wrong_token_scope');
});

test('createConversationToken refuses disableentitlement', async () => {
  const m = new Management({ partnerId: 999, adminSecret: 'x'.repeat(32) });
  await assert.rejects(
    () => m.sessions.createConversationToken({ configId: 1, extraPrivileges: 'disableentitlement' }),
    (e) => e.code === 'entitlement_violation',
  );
});

test('createConversationToken requires a configId', async () => {
  const m = new Management({ partnerId: 999, adminSecret: 'x'.repeat(32) });
  await assert.rejects(() => m.sessions.createConversationToken({}), (e) => e.code === 'bad_request');
});

test('destructive ops require confirmPermanent', async () => {
  const m = new Management({ partnerId: 999, adminSecret: 'x'.repeat(32) });
  await assert.rejects(() => m.agents.delete('a1', ADMIN), (e) => e.code === 'confirmation_required');
  await assert.rejects(() => m.threads.delete(['t1'], ADMIN), (e) => e.code === 'confirmation_required');
});

// assertUserOrAdmin: own-thread methods (threads.get and similar).
function userOrAdminCall(ks) {
  const ff = fakeFetch([{ match: 'thread/get', respond: () => ({ status: 200, body: { id: 't1' } }) }]);
  const m = new Management({ partnerId: 999, adminSecret: 'x'.repeat(32), fetch: ff });
  return { calls: ff.calls, run: () => m.threads.get('t1', ks) };
}

test('assertUserOrAdmin accepts plaintext admin and conversation KS and minted admin, conversation and agent tokens', async () => {
  for (const ks of [
    ADMIN, CONV,
    { ks: ADMIN, kind: 'admin' },
    { ks: CONV, kind: 'conversation' },
    { ks: CONV, kind: 'agent' },
  ]) {
    const { calls, run } = userOrAdminCall(ks);
    await run();
    assert.equal(calls.length, 1);
  }
});

test('assertUserOrAdmin rejects a widget token before any network call', async () => {
  const { calls, run } = userOrAdminCall({ ks: CONV, kind: 'widget' });
  await assert.rejects(run, (e) => e.code === 'wrong_token_scope');
  assert.equal(calls.length, 0);
});

test('assertUserOrAdmin passes a raw encrypted KS through to the server', async () => {
  const { calls, run } = userOrAdminCall(['djJ8', 'opaque-encrypted-ks'].join(''));
  await run();
  assert.equal(calls.length, 1);
});

test('admin-only methods still reject a conversation token (threads.push)', async () => {
  const m = new Management({ partnerId: 999, adminSecret: 'x'.repeat(32) });
  await assert.rejects(async () => m.threads.push({ id: 't1', content: 'x' }, CONV), (e) => e.code === 'wrong_token_scope');
});
