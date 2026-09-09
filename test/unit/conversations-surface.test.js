import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/**
 * Threads/Messages/Feedback/Followups additions: filter passthrough
 * (`objectType` always injected, caller filter merged under it),
 * `Threads.setAnalysis`/`clearAnalysis`/`push`, `Feedback.list`/`report`,
 * `Followups.list`.
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
  assert.equal(ff.calls[0].body.filter.agentIdEquals, 'a1');
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

test('messages.list merges opts.filter under objectType; opts.threadId is sugar for filter.threadIdEquals', async () => {
  const { mgmt, ff } = harness([
    { match: 'message/list', respond: () => ({ status: 200, body: { objects: [], totalCount: 0 } }) },
  ]);
  await mgmt.messages.list(ADMIN_KS, { filter: { isPositiveEquals: true }, threadId: 't1' }).all();
  assert.equal(ff.calls[0].body.filter.objectType, 'GenieListMessageFilter');
  assert.equal(ff.calls[0].body.filter.isPositiveEquals, true);
  assert.equal(ff.calls[0].body.filter.threadIdEquals, 't1');
});

test('feedback.list merges opts.filter under GenieListFeedbackFilter objectType', async () => {
  const { mgmt, ff } = harness([
    { match: 'feedback/list', respond: () => ({ status: 200, body: { objects: [], totalCount: 0 } }) },
  ]);
  await mgmt.feedback.list(ADMIN_KS, { filter: { isPositiveEquals: false } }).all();
  assert.equal(ff.calls[0].body.filter.objectType, 'GenieListFeedbackFilter');
  assert.equal(ff.calls[0].body.filter.isPositiveEquals, false);
});

test('feedback.report posts {filter:{objectType}} and an optional pager, returns the raw CSV (or null)', async () => {
  const { mgmt, ff } = harness([
    { match: 'feedback/report', respond: () => ({ status: 200, body: null }) },
  ]);
  const res = await mgmt.feedback.report(ADMIN_KS, { pageSize: 10 });
  assert.deepEqual(ff.calls[0].body, { filter: { objectType: 'GenieListFeedbackFilter' }, pager: { pageIndex: 1, pageSize: 10 } });
  assert.equal(res, null, 'an empty CSV body surfaces as null, not a thrown error');
});

test('followups.list merges opts.filter under GenieListQuestionFilter objectType', async () => {
  const { mgmt, ff } = harness([
    { match: 'followup/list', respond: () => ({ status: 200, body: { objects: [], totalCount: 0 } }) },
  ]);
  await mgmt.followups.list(ADMIN_KS, { filter: { idsIn: ['q1'] } }).all();
  assert.equal(ff.calls[0].body.filter.objectType, 'GenieListQuestionFilter');
  assert.deepEqual(ff.calls[0].body.filter.idsIn, ['q1']);
});

test('every admin-scoped conversation method rejects a conversation token with wrong_token_scope', async () => {
  const { mgmt } = harness([]);
  await assert.rejects(async () => mgmt.threads.list(CONV_TOKEN).all(), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.threads.setAnalysis('t1', {}, CONV_TOKEN), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.threads.clearAnalysis('t1', CONV_TOKEN), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.threads.push({ id: 't1', content: 'x' }, CONV_TOKEN), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.messages.list(CONV_TOKEN).all(), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.feedback.list(CONV_TOKEN).all(), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.feedback.report(CONV_TOKEN), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.followups.list(CONV_TOKEN).all(), (e) => e.code === 'wrong_token_scope');
});
