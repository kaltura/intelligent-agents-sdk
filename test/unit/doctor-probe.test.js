import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/** `mgmt.doctorProbe`: one timed text turn. fakeFetch only. */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);
const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:10').toString('base64url');
const seg = (o) => JSON.stringify(o);
const REPLY = [seg({ type: 'think', content: '', threadId: 't-1', messageId: 'm-1' }), seg({ type: 'text', content: 'Hello ' }), seg({ type: 'text', content: 'world' })].join('\n') + '\n';
const scope = (id) => [{ field: 'object.agent_id', operator: 'eq', value: id }];
const rule = (id, extra = {}) => ({ id, systemName: `r-${id}`, status: 'active', eventType: 'session_ended', objectType: 'thread', eventConditions: scope('a1'), action: { actionType: 'triggerInsightSettingsKai' }, ...extra });

function harness({ rules = [], reply = () => ({ body: REPLY }), intellect = { id: 10, type: 'brain', model_configuration: { thinking_level: 'high', max_output_tokens: 2048 } } } = {}) {
  const ff = fakeFetch([
    { match: '/service/session/action/start', respond: () => ({ body: CONV_KS }) },
    { match: 'lifecycle/list', respond: () => ({ body: { objects: rules, totalCount: rules.length } }) },
    { match: 'agent/get', respond: () => ({ body: { agentId: 'a1', intellect: { id: 10 } } }) },
    { match: 'v1/intellect/get', respond: () => ({ body: intellect }) },
    { match: '/assistant/converse', respond: reply },
  ]);
  let t = 0;
  const mgmt = new Management({ partnerId: '123', adminSecret: 's3cret', fetch: ff });
  mgmt._doctorProbe._now = () => (t += 100);
  return { mgmt, ff };
}
const converse = (ff) => ff.calls.filter((c) => c.url.endsWith('/assistant/converse'));

test('doctorProbe sends one unstored message and reports timings, reply facts and the config in effect', async () => {
  const { mgmt, ff } = harness();
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', message: 'Hi there' });
  assert.equal(r.ran, true);
  assert.equal(r.error, null);
  assert.deepEqual(r.reply, { toolCalls: 0, spiralStopped: false, replyChars: 11, errorSegments: 0 });
  assert.ok(r.timings.firstSegmentMs > 0 && r.timings.firstTextMs >= r.timings.firstSegmentMs && r.timings.totalMs >= r.timings.firstTextMs);
  assert.deepEqual(r.config, { type: 'brain', thinkingLevel: 'high', includeThoughts: undefined, maxOutputTokens: 2048 });
  assert.equal(r.configId, 10);
  assert.match(r.limits, /no speech recognition/);
  assert.equal(converse(ff).length, 1);
  assert.deepEqual(converse(ff)[0].body, { userMessage: 'Hi there', sse: false, add_message_in_db: false });
});

test('doctorProbe: matching rules stop the run, and are listed', async () => {
  const rules = [rule('r1'), rule('r2', { eventConditions: [] }), rule('other', { eventConditions: scope('a9') }), rule('off', { status: 'inactive' }), rule('obj', { objectType: 'user' })];
  const { mgmt, ff } = harness({ rules });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1' });
  assert.equal(r.ran, false);
  assert.deepEqual(r.rules.map((x) => x.id), ['r1', 'r2']);
  assert.equal(r.rules[0].actionType, 'triggerInsightSettingsKai');
  assert.equal(r.timings, null);
  assert.equal(converse(ff).length, 0);
  assert.equal(ff.calls.some((c) => c.url.includes('/service/session/action/start')), false, 'no token minted');
});

test('doctorProbe: allowSideEffects runs the probe and still lists the rules', async () => {
  const { mgmt, ff } = harness({ rules: [rule('r1')] });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', allowSideEffects: true });
  assert.equal(r.ran, true);
  assert.deepEqual(r.rules.map((x) => x.id), ['r1']);
  assert.equal(converse(ff).length, 1);
});

test('doctorProbe: a failed request is returned in error with the timings so far', async () => {
  const { mgmt } = harness({ reply: () => ({ status: 500, body: { message: 'boom' } }) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1' });
  assert.equal(r.ran, true);
  assert.equal(r.reply, null);
  assert.ok(r.error.code && r.error.message);
  assert.ok(r.timings.totalMs > 0);
});

test('doctorProbe: a 401 from the converse call rejects', async () => {
  const { mgmt } = harness({ reply: () => ({ status: 401, body: { message: 'expired' } }) });
  await assert.rejects(() => mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1' }), (e) => e.status === 401);
});

test('doctorProbe: counts tool segments and reports a spiral', async () => {
  const tool = (i) => seg({ type: 'tool', content: `lookup {"i":${i}}` });
  const reply = [seg({ type: 'think', content: '', threadId: 't', messageId: 'm' }), ...Array.from({ length: 12 }, (_, i) => tool(i))].join('\n') + '\n';
  const { mgmt } = harness({ reply: () => ({ body: reply }) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1' });
  assert.equal(r.reply.spiralStopped, true);
  assert.ok(r.reply.toolCalls >= 8, `raw tool segments are counted (got ${r.reply.toolCalls})`);
});

test('doctorProbe: needs an admin token and valid options, and sends nothing otherwise', async () => {
  const { mgmt, ff } = harness();
  await assert.rejects(() => mgmt.doctorProbe({ ks: 'x', kind: 'conversation' }, { agentId: 'a1' }), (e) => e.code === 'wrong_token_scope');
  for (const opts of [undefined, {}, { agentId: '' }, { agentId: 'a1', message: '' }, { agentId: 'a1', message: 'x'.repeat(501) }, { agentId: 'a1', timeoutMs: 0 }, { agentId: 'a1', timeoutMs: Infinity }, { agentId: 'a1', timeoutMs: NaN }, { agentId: 'a1', timeoutMs: 2147483648 }, { agentId: 'a1', timeoutMs: '5' }]) {
    await assert.rejects(() => mgmt.doctorProbe(ADMIN_KS, opts), (e) => e.code === 'bad_request');
  }
  assert.equal(ff.calls.length, 0);
});

test('doctorProbe: an agent with no intellect cannot be probed', async () => {
  const ff = fakeFetch([
    { match: 'agent/get', respond: () => ({ body: { agentId: 'a4' } }) },
    { match: 'lifecycle/list', respond: () => ({ body: { objects: [], totalCount: 0 } }) },
  ]);
  const mgmt = new Management({ partnerId: '123', adminSecret: 's', fetch: ff });
  await assert.rejects(() => mgmt.doctorProbe(ADMIN_KS, { agentId: 'a4' }), (e) => e.code === 'intellect_not_found');
});
