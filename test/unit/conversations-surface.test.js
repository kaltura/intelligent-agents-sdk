import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/**
 * Threads/Messages/Feedback additions: filter passthrough
 * (`objectType` always injected, caller filter merged under it),
 * `Threads.setAnalysis`/`clearAnalysis`/`push`, `Feedback.list`/`report`.
 */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);
const CONV_TOKEN = { ks: 'djJ8conv', kind: 'conversation' };

function harness(routes) {
  const ff = fakeFetch(routes);
  const mgmt = new Management({ partnerId: '123', fetch: ff });
  return { mgmt, ff };
}

test('threads.list merges opts.filter UNDER the fixed objectType (caller cannot override it)', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/thread/list', respond: () => ({ status: 200, body: { objects: [], totalCount: 0 } }) },
  ]);
  await mgmt.threads.list(ADMIN_KS, { filter: { agentIdEquals: 'a1', objectType: 'HACKED' } }).all();
  assert.equal(ff.calls[0].body.filter.objectType, 'ListThreadFilter', 'objectType always wins over a caller-supplied value');
  assert.equal(ff.calls[0].body.filter.genieIdEquals, 'a1', 'agentIdEquals is translated to the server-side filter key on the wire');
  assert.equal(ff.calls[0].body.filter.agentIdEquals, undefined, 'the SDK-only key name never reaches the wire');
});

test('threads.list forwards filter.agentIdIn unchanged', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/thread/list', respond: () => ({ status: 200, body: { objects: [], totalCount: 0 } }) },
  ]);
  await mgmt.threads.list(ADMIN_KS, { filter: { agentIdIn: ['a1', 'a2'] } }).all();
  assert.equal(ff.calls.length, 1);
  assert.deepEqual(ff.calls[0].body.filter.agentIdIn, ['a1', 'a2']);
  assert.equal(ff.calls[0].body.filter.objectType, 'ListThreadFilter');
  assert.equal(ff.calls[0].body.filter.genieIdIn, undefined, 'agentIdIn is not mapped to a genie* key');
});

test('threads.setAnalysis sends {id, thread_metadata:{analysis:patch}}; rejects a non-object patch before the network call', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/thread/update', respond: (req) => ({ status: 200, body: { id: req.body.id, thread_metadata: req.body.thread_metadata } }) },
  ]);
  await assert.rejects(() => mgmt.threads.setAnalysis('t1', 'not-an-object', ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.threads.setAnalysis('t1', ['a'], ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0, 'no transport before validation passes');

  const res = await mgmt.threads.setAnalysis('t1', { sentiment: 'positive' }, ADMIN_KS);
  assert.deepEqual(ff.calls[0].body, { id: 't1', thread_metadata: { analysis: { sentiment: 'positive' } } });
  assert.deepEqual(res.thread_metadata.analysis, { sentiment: 'positive' });
});

test('threads.clearAnalysis sends {id, thread_metadata:{}}', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/thread/update', respond: (req) => ({ status: 200, body: { id: req.body.id, thread_metadata: req.body.thread_metadata } }) },
  ]);
  await mgmt.threads.clearAnalysis('t1', ADMIN_KS);
  assert.deepEqual(ff.calls[0].body, { id: 't1', thread_metadata: {} });
});

test('threads.push sends {id, content} to the legacy genie thread/push route, request_vars/system_message only when given', async () => {
  const { mgmt, ff } = harness([
    { match: 'thread/push', respond: () => ({ status: 200, body: { status: 'success', data: {}, messageId: 'm1', delivered: false } }) },
  ]);
  const res = await mgmt.threads.push({ id: 't1', content: 'hi' }, ADMIN_KS);
  assert.deepEqual(ff.calls[0].body, { id: 't1', content: 'hi' });
  assert.match(ff.calls[0].url, /thread\/push$/);
  assert.deepEqual(res, { status: 'success', data: {}, messageId: 'm1', delivered: false });

  await mgmt.threads.push({ id: 't1', content: 'hi', request_vars: { name: 'x' }, system_message: 'sys' }, ADMIN_KS);
  assert.deepEqual(ff.calls[1].body, { id: 't1', content: 'hi', request_vars: { name: 'x' }, system_message: 'sys' });
});

test('threads.push rejects a reserved request_vars key BEFORE any network call', async () => {
  const { mgmt, ff } = harness([]);
  await assert.rejects(
    () => mgmt.threads.push({ id: 't1', content: 'hi', request_vars: { sys__thread_id: 'x' } }, ADMIN_KS),
    (e) => e.code === 'validation_error',
  );
  assert.equal(ff.calls.length, 0);
});

test('threads.push maps a client-variables 403 to client_variables_disabled, a 413 to payload_too_large, and leaves other 403s alone', async () => {
  const reply = { status: 403, body: { detail: 'Client variables are not allowed' } };
  const { mgmt } = harness([{ match: 'thread/push', respond: () => reply }]);
  const push = () => mgmt.threads.push({ id: 't1', content: 'hi', request_vars: { name: 'x' } }, ADMIN_KS);
  await assert.rejects(push, (e) => e.code === 'client_variables_disabled' && e.status === 403);

  Object.assign(reply, { status: 413, body: { detail: 'variable too large (max 100000)' } });
  await assert.rejects(push, (e) => e.code === 'payload_too_large' && e.status === 413 && /too large/.test(e.detail));

  Object.assign(reply, { status: 403, body: { detail: 'Not authorized' } });
  await assert.rejects(push, (e) => e.code === 'forbidden');
});

test('messages.list merges opts.filter under objectType; opts.threadId is sugar for filter.threadIdEquals', async () => {
  const { mgmt, ff } = harness([
    { match: 'message/list', respond: () => ({ status: 200, body: { objects: [], totalCount: 0 } }) },
  ]);
  await mgmt.messages.list(ADMIN_KS, { filter: { isPositiveEquals: true }, threadId: 't1' }).all();
  assert.equal(ff.calls[0].body.filter.objectType, 'GenieListMessageFilter');
  assert.equal(ff.calls[0].body.filter.isPositiveEquals, true);
  assert.equal(ff.calls[0].body.filter.threadIdEquals, 't1');
});

test('feedback.list sources from message/list, not a proxy of feedback/list', async () => {
  const { mgmt, ff } = harness([
    { match: 'message/list', respond: () => ({
      status: 200,
      body: {
        objects: [
          { id: 'm1', thread_id: 't1', genie_id: 'g1', user_id: 'u1', is_positive: true, comment: 'nice', created_at: '2026-01-01', updated_at: '2026-01-01' },
          { id: 'm2', thread_id: 't1', is_positive: null },
        ],
        totalCount: 2,
      },
    }) },
  ]);
  const rows = await mgmt.feedback.list(ADMIN_KS, { filter: { isPositiveEquals: true } });
  assert.equal(ff.calls[0].body.filter.objectType, 'GenieListMessageFilter');
  assert.equal(ff.calls[0].body.filter.isPositiveEquals, true);
  assert.equal(rows.length, 1, 'only the rated message survives the client-side filter');
  assert.deepEqual(rows[0], { message_id: 'm1', thread_id: 't1', genie_id: 'g1', user_id: 'u1', is_positive: true, comment: 'nice', created_at: '2026-01-01', updated_at: '2026-01-01' });
});

test('feedback.list agentIdEquals resolves matching threads first, then walks each thread\'s messages', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/thread/list', respond: () => ({ status: 200, body: { objects: [{ id: 't1' }, { id: 't2' }], totalCount: 2 } }) },
    { match: 'message/list', respond: (req) => (req.body.filter.threadIdEquals === 't1'
      ? { status: 200, body: { objects: [{ id: 'm1', thread_id: 't1', is_positive: true, comment: 'a' }], totalCount: 1 } }
      : { status: 200, body: { objects: [], totalCount: 0 } }) },
  ]);
  const rows = await mgmt.feedback.list(ADMIN_KS, { filter: { agentIdEquals: 'agent-1' } });
  assert.match(ff.calls[0].url, /v1\/thread\/list$/);
  assert.equal(ff.calls[0].body.filter.genieIdEquals, 'agent-1', 'agentIdEquals is translated to the server-side filter key on the wire');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_id, 'm1');
});

test('messages.share unwraps the {status, data:{newMessageId}} envelope; throws server_error when no id comes back', async () => {
  const { mgmt, ff } = harness([
    { match: 'message/share', respond: () => ({ status: 200, body: { status: 'success', data: { newMessageId: 'm2' } } }) },
  ]);
  assert.deepEqual(await mgmt.messages.share('m1', 'copy', ADMIN_KS), { newMessageId: 'm2' });
  assert.deepEqual(ff.calls[0].body, { id: 'm1', newTitle: 'copy' });

  const failed = harness([
    { match: 'message/share', respond: () => ({ status: 200, body: { status: 'failed', data: null } }) },
  ]);
  await assert.rejects(() => failed.mgmt.messages.share('m1', 'copy', ADMIN_KS), (e) => e.code === 'server_error');
});

test('Management has no followups namespace: starter questions live on the agent (widgetConfig.initialPage.initialQuestions)', () => {
  const { mgmt } = harness([]);
  assert.equal(mgmt.followups, undefined);
});

test('admin-only conversation methods reject a conversation token with wrong_token_scope', async () => {
  const { mgmt } = harness([]);
  await assert.rejects(async () => mgmt.threads.push({ id: 't1', content: 'x' }, CONV_TOKEN), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.messages.report(CONV_TOKEN), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.messages.reportSummary(CONV_TOKEN), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.feedback.list(CONV_TOKEN).all(), (e) => e.code === 'wrong_token_scope');
});

test('own-thread methods accept admin, conversation and agent tokens; reject widget tokens', async () => {
  const AGENT_TOKEN = { ks: 'djJ8agent', kind: 'agent' };
  const WIDGET_TOKEN = { ks: 'djJ8widget', kind: 'widget' };
  const ok = { status: 200, body: { objects: [], totalCount: 0, id: 't1', totalCountRemoved: 0 } };
  const routes = [
    { match: 'thread/list', respond: () => ok }, { match: 'thread/get_transcripts', respond: () => ok },
    { match: 'thread/get', respond: () => ok }, { match: 'thread/update', respond: () => ok },
    { match: 'thread/delete', respond: () => ok }, { match: 'message/list', respond: () => ok },
    { match: 'message/get', respond: () => ok },
    { match: 'message/share', respond: () => ({ status: 200, body: { status: 'success', data: { newMessageId: 'm2' } } }) },
  ];
  const calls = (m, k) => [
    () => m.threads.list(k).all(),
    () => m.threads.get('t1', k),
    () => m.threads.transcript('t1', k),
    () => m.threads.rename('t1', 'title', k),
    () => m.threads.setAnalysis('t1', { a: 1 }, k),
    () => m.threads.clearAnalysis('t1', k),
    () => m.threads.delete(['t1'], k, { confirmPermanent: true }),
    () => m.messages.list(k).all(),
    () => m.messages.get('m1', k),
    () => m.messages.share('m1', 'copy', k),
  ];
  for (const k of [ADMIN_KS, CONV_TOKEN, AGENT_TOKEN]) {
    const { mgmt } = harness(routes);
    for (const call of calls(mgmt, k)) await call();
  }
  const { mgmt, ff } = harness(routes);
  for (const call of calls(mgmt, WIDGET_TOKEN)) {
    await assert.rejects(async () => call(), (e) => e.code === 'wrong_token_scope');
  }
  assert.equal(ff.calls.length, 0, 'widget tokens are rejected before any network call');
});

test('knowledge.search rejects a widget Token before any request', async () => {
  const { mgmt, ff } = harness([]);
  await assert.rejects(async () => mgmt.knowledge.search('q', { ks: CONV_TOKEN.ks, kind: 'widget' }), (e) => e.code === 'wrong_token_scope');
  assert.equal(ff.calls.length, 0);
});

// threads.delete warns for ids its own response left out, and only on the current contract.
function deleteHarness(respond, logger) {
  const ff = fakeFetch([{ match: 'v1/thread/delete', respond }]);
  return new Management({ partnerId: '123', fetch: ff, logger });
}
const CONFIRM = { confirmPermanent: true };

test('threads.delete: every id deleted gives no warning and the server body unchanged', async () => {
  const warns = [];
  const body = { totalCount: 2, objects: [{ id: 'a', title: 'x' }, { id: 'b' }] };
  const m = deleteHarness(() => ({ status: 200, body }), (l, msg) => l === 'warn' && warns.push([l, msg]));
  assert.deepEqual(await m.threads.delete(['a', 'b'], ADMIN_KS, CONFIRM), body);
  assert.deepEqual(warns, []);
});

test('threads.delete: a partial or empty delete logs one warning naming the missing ids', async () => {
  const warns = [];
  const partial = deleteHarness(() => ({ status: 200, body: { totalCount: 1, objects: [{ id: 'a' }] } }), (l, msg) => l === 'warn' && warns.push([l, msg]));
  const res = await partial.threads.delete(['a', 'b', 'b'], ADMIN_KS, CONFIRM);
  assert.deepEqual(res, { totalCount: 1, objects: [{ id: 'a' }] }, 'no field is added to the result');
  assert.equal(warns.length, 1);
  assert.equal(warns[0][0], 'warn');
  assert.match(warns[0][1], /did not report 1 of 2 thread ids as deleted.*: b$/);

  const none = [];
  const empty = deleteHarness(() => ({ status: 200, body: { totalCount: 0, objects: [] } }), (l, msg) => l === 'warn' && none.push(msg));
  await empty.threads.delete(['t1', 't2', 't3', 't4', 't5', 't6', 't7'], ADMIN_KS, CONFIRM);
  assert.equal(none.length, 1);
  assert.match(none[0], /7 of 7 .*t1, t2, t3, t4, t5, \+2 more$/);
});

test('threads.delete: any other status or shape is returned as-is with no warning', async () => {
  const shapes = [
    { status: 202, body: { jobId: 'j1' } },
    { status: 202, body: { totalCount: 0, objects: [] } },
    { status: 200, body: { accepted: ['a'] } },
    { status: 200, body: { totalCount: 1, objects: [{ thread_id: 'a' }] } },
    { status: 200, body: { totalCount: 1, objects: [null] } },
    { status: 200, body: {} },
  ];
  for (const s of shapes) {
    const warns = [];
    const m = deleteHarness(() => s, (l, msg) => l === 'warn' && warns.push(msg));
    assert.deepEqual(await m.threads.delete(['a'], ADMIN_KS, CONFIRM), s.body, JSON.stringify(s));
    assert.deepEqual(warns, [], JSON.stringify(s));
  }
});

test('threads.delete: a throwing warn sink never breaks the delete; default sink is console.warn', async () => {
  const body = { totalCount: 0, objects: [] };
  const m = deleteHarness(() => ({ status: 200, body }), (level) => { if (level === 'warn') throw new Error('warn sink down'); });
  assert.deepEqual(await m.threads.delete(['a'], ADMIN_KS, CONFIRM), body);

  const orig = console.warn; const seen = [];
  console.warn = (msg) => seen.push(msg);
  try { await deleteHarness(() => ({ status: 200, body })).threads.delete(['a'], ADMIN_KS, CONFIRM); }
  finally { console.warn = orig; }
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^\[threads\.delete\] /);
});

test('threads.delete: an empty list throws validation_error before any request, with or without confirmation', async () => {
  const ff = fakeFetch([{ match: 'v1/thread/delete', respond: () => ({ status: 500, body: { detail: 'Internal Server Error' } }) }]);
  const m = new Management({ partnerId: '123', fetch: ff });
  const invalid = (e) => e.code === 'validation_error' && /threads\.delete/.test(e.detail) && /at least one thread id/.test(e.detail);
  await assert.rejects(() => m.threads.delete([], ADMIN_KS, CONFIRM), invalid);
  await assert.rejects(() => m.threads.delete([], ADMIN_KS), invalid, 'validation comes before the confirmation check');
  assert.equal(ff.calls.length, 0, 'no request for an empty list');
});

test('threads.delete: a non-string or empty id throws validation_error before any request', async () => {
  const ff = fakeFetch([{ match: 'v1/thread/delete', respond: () => ({ status: 200, body: { totalCount: 0, objects: [] } }) }]);
  const m = new Management({ partnerId: '123', fetch: ff });
  for (const ids of [[''], ['a', ''], [42], ['a', null], [undefined], [['a']], [{ id: 'a' }], undefined, null, '']) {
    await assert.rejects(() => m.threads.delete(/** @type {any} */ (ids), ADMIN_KS, CONFIRM), (e) => e.code === 'validation_error', JSON.stringify(ids));
  }
  assert.equal(ff.calls.length, 0);
});

test('threads.delete: a single id string and a one-item list still go through', async () => {
  const ff = fakeFetch([{ match: 'v1/thread/delete', respond: () => ({ status: 200, body: { totalCount: 1, objects: [{ id: 'a' }] } }) }]);
  const m = new Management({ partnerId: '123', fetch: ff });
  await m.threads.delete(/** @type {any} */ ('a'), ADMIN_KS, CONFIRM);
  await m.threads.delete(['a'], ADMIN_KS, CONFIRM);
  assert.deepEqual(ff.calls.map((c) => c.body.thread_ids), [['a'], ['a']]);
});
