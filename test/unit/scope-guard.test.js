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

test('relaxed own-thread methods send a raw KS string this instance did not mint as a widget as is', async () => {
  const RAW = 'raw-ks-string';
  const ok = { status: 200, body: { objects: [], totalCount: 0, id: 't1', totalCountRemoved: 0 } };
  const ff = fakeFetch([
    { match: 'thread/list', respond: () => ok }, { match: 'thread/get_transcripts', respond: () => ok },
    { match: 'thread/get', respond: () => ok }, { match: 'thread/update', respond: () => ok },
    { match: 'thread/delete', respond: () => ok }, { match: 'message/list', respond: () => ok },
    { match: 'message/get', respond: () => ok },
    { match: 'message/share', respond: () => ({ status: 200, body: { status: 'success', data: { newMessageId: 'm2' } } }) },
  ]);
  const m = new Management({ partnerId: 999, adminSecret: 'x'.repeat(32), fetch: ff });
  const calls = [
    () => m.threads.list(RAW).all(),
    () => m.threads.get('t1', RAW),
    () => m.threads.transcript('t1', RAW),
    () => m.threads.rename('t1', 'title', RAW),
    () => m.threads.setAnalysis('t1', { a: 1 }, RAW),
    () => m.threads.clearAnalysis('t1', RAW),
    () => m.threads.delete(['t1'], RAW, { confirmPermanent: true }),
    () => m.messages.list(RAW).all(),
    () => m.messages.get('m1', RAW),
    () => m.messages.share('m1', 'copy', RAW),
  ];
  for (const call of calls) await call();
  assert.equal(ff.calls.length, calls.length);
  for (const c of ff.calls) assert.match(JSON.stringify(c.headers), /raw-ks-string/, `${c.url} carries the raw KS`);
});

test('a minted widget Token gets wrong_token_scope on all ten relaxed methods, before any request', async () => {
  const ff = fakeFetch([]);
  const m = new Management({ partnerId: 999, adminSecret: 'x'.repeat(32), fetch: ff });
  const W = { ks: CONV, kind: 'widget' };
  const calls = [
    () => m.threads.list(W).all(), () => m.threads.get('t1', W), () => m.threads.transcript('t1', W),
    () => m.threads.rename('t1', 'title', W), () => m.threads.setAnalysis('t1', { a: 1 }, W),
    () => m.threads.clearAnalysis('t1', W), () => m.threads.delete(['t1'], W, { confirmPermanent: true }),
    () => m.messages.list(W).all(), () => m.messages.get('m1', W), () => m.messages.share('m1', 'copy', W),
  ];
  assert.equal(calls.length, 10);
  for (const call of calls) await assert.rejects(async () => call(), (e) => e.code === 'wrong_token_scope');
  assert.equal(ff.calls.length, 0);
});

// ── the raw string of a widget token this instance minted is refused ──
const WKS = (n) => 'djJ8' + Buffer.from(`widget-${n}`).toString('base64url');

/** A Management whose startWidgetSession returns the next string from `nextKs`. */
function widgetHarness(nextKs, extraRoutes = []) {
  const ff = fakeFetch([
    { match: '/service/session/action/startWidgetSession', respond: () => ({ body: { ks: nextKs() } }) },
    { match: 'thread/list', respond: () => ({ status: 200, body: { objects: [], totalCount: 0 } }) },
    { match: 'thread/push', respond: () => ({ status: 200, body: { delivered: false } }) },
    { match: 'mcp/search', respond: () => ({ status: 200, body: { status: 'success', data: {} } }) },
    { match: '/service/session/action/start', respond: () => ({ body: `"${nextKs()}"` }) },
    ...extraRoutes,
  ]);
  return { ff, m: new Management({ partnerId: 999, adminSecret: 'x'.repeat(32), fetch: ff }) };
}

test('a raw widget KS string this instance minted is refused by threads.list and knowledge.search before any request', async () => {
  const { ff, m } = widgetHarness(() => WKS(1));
  const w = await m.sessions.createWidgetToken({ widgetId: '1_w' });
  const before = ff.calls.length;
  await assert.rejects(async () => m.threads.list(w.ks).all(), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(() => m.knowledge.search('q', w.ks), (e) => e.code === 'wrong_token_scope');
  assert.equal(ff.calls.length, before, 'no request after the mint');
});

test('a raw minted widget string on an admin method gets wrong_token_scope', async () => {
  const { ff, m } = widgetHarness(() => WKS(2));
  const w = await m.sessions.createWidgetToken({ widgetId: '1_w' });
  const before = ff.calls.length;
  await assert.rejects(async () => m.threads.push({ id: 't1', content: 'x' }, w.ks), (e) => e.code === 'wrong_token_scope');
  assert.equal(ff.calls.length, before);
});

test('a raw minted widget string still reaches a conversation method', async () => {
  const { ff, m } = widgetHarness(() => WKS(3), [{ match: 'assistant/status', respond: () => ({ status: 200, body: { aiConsent: true } }) }]);
  const w = await m.sessions.createWidgetToken({ widgetId: '1_w' });
  const before = ff.calls.length;
  await m.conversations.status(w.ks);
  assert.equal(ff.calls.length, before + 1);
});

test('a raw widget string minted by another Management instance is sent to the server', async () => {
  const a = widgetHarness(() => WKS(4));
  const b = widgetHarness(() => WKS(5));
  const w = await a.m.sessions.createWidgetToken({ widgetId: '1_w' });
  await b.m.threads.list(w.ks).all();
  assert.equal(b.ff.calls.filter((c) => c.url.includes('thread/list')).length, 1);
});

test('a conversation Token whose string matches a remembered widget string is allowed', async () => {
  const { ff, m } = widgetHarness(() => WKS(6));
  await m.sessions.createWidgetToken({ widgetId: '1_w' });
  const conv = { ks: WKS(6), kind: 'conversation' };
  await m.threads.list(conv).all();
  assert.equal(ff.calls.filter((c) => c.url.includes('thread/list')).length, 1);
});

test('widget string memory keeps the newest 32 mints', async () => {
  let n = 0;
  const { m } = widgetHarness(() => WKS(100 + n++));
  const tokens = [];
  for (let i = 0; i < 33; i++) tokens.push(await m.sessions.createWidgetToken({ widgetId: '1_w' }));
  await m.threads.list(tokens[0].ks).all(); // oldest is forgotten, so it goes to the server
  await assert.rejects(async () => m.threads.list(tokens[32].ks).all(), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => m.threads.list(tokens[1].ks).all(), (e) => e.code === 'wrong_token_scope');
});

test('a non-widget mint of the same string clears it', async () => {
  const { m } = widgetHarness(() => WKS(7));
  const w = await m.sessions.createWidgetToken({ widgetId: '1_w' });
  await assert.rejects(async () => m.threads.list(w.ks).all(), (e) => e.code === 'wrong_token_scope');
  await m.sessions.createAdminToken({ userId: 'ops-1' }); // same fake string, admin kind
  await m.threads.list(w.ks).all();
});

test('the remembered widget strings are not enumerable', async () => {
  const { m } = widgetHarness(() => WKS(8));
  const w = await m.sessions.createWidgetToken({ widgetId: '1_w' });
  assert.ok(!Object.keys(m.sessions).includes('_widgetKs'));
  assert.ok(!JSON.stringify(m.sessions).includes(w.ks));
});
