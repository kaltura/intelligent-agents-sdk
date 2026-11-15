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

function harness({ rules = [], reply = () => ({ body: REPLY }), toolResponse = () => ({ body: {} }), intellect = { id: 10, type: 'brain', model_configuration: { thinking_level: 'high', max_output_tokens: 2048 } } } = {}) {
  const ff = fakeFetch([
    { match: '/service/session/action/start', respond: () => ({ body: CONV_KS }) },
    { match: 'lifecycle/list', respond: () => ({ body: { objects: rules, totalCount: rules.length } }) },
    { match: 'agent/get', respond: () => ({ body: { agentId: 'a1', intellect: { id: 10 } } }) },
    { match: 'v1/intellect/get', respond: () => ({ body: intellect }) },
    { match: '/assistant/tool_response', respond: toolResponse },
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
  assert.deepEqual(r.reply, { toolCalls: 0, spiralStopped: false, replyChars: 11, errorSegments: 0, toolAcks: [], unansweredTools: [] });
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

const SPOKEN_REPLY = JSON.stringify({ type: 'text', content: 'EBITDA was 12% of $84 million, up from 9 last year. SaaS is fine.' }) + '\n';

test('doctorProbe: spoken reports raw terms, digit runs and symbols in the reply', async () => {
  const { mgmt } = harness({ reply: () => ({ body: SPOKEN_REPLY }) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', spoken: { rawTerms: ['EBITDA', 'SaaS', 'ARR', 'ebitda'] } });
  assert.deepEqual(r.reply.spoken, { rawTerms: ['EBITDA', 'SaaS'], digits: 3, digitRuns: ['12', '84', '9'], symbols: ['%', '$'] });
});

test('doctorProbe: spoken with no terms still counts digits and symbols, and is absent when not asked', async () => {
  const { mgmt } = harness({ reply: () => ({ body: SPOKEN_REPLY }) });
  assert.deepEqual((await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', spoken: {} })).reply.spoken, { rawTerms: [], digits: 3, digitRuns: ['12', '84', '9'], symbols: ['%', '$'] });
  assert.equal('spoken' in (await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1' })).reply, false);
});

test('doctorProbe: spoken matches a term with regex characters literally and whole words only', async () => {
  const body = JSON.stringify({ type: 'text', content: 'C++ and R&D, but not NONGAAP or xARR.' }) + '\n';
  const { mgmt } = harness({ reply: () => ({ body }) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', spoken: { rawTerms: ['R&D', 'GAAP', 'ARR', 'C++'] } });
  assert.deepEqual(r.reply.spoken.rawTerms, ['R&D', 'C++']);
});

test('doctorProbe: a bad spoken option is rejected before any request', async () => {
  const { mgmt, ff } = harness();
  for (const spoken of [null, 'x', [], { rawTerms: 'EBITDA' }, { rawTerms: [''] }, { rawTerms: [3] }, { allowSymbols: '%' }, { allowSymbols: ['!'] }, { allowSymbols: [3] }]) {
    await assert.rejects(() => mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', spoken }), { code: 'bad_request' });
  }
  assert.equal(ff.calls.length, 0);
});

test('doctorProbe: a failed intellect read leaves config null and still probes; an expired token rejects', async () => {
  const ff = fakeFetch([
    { match: '/service/session/action/start', respond: () => ({ body: CONV_KS }) },
    { match: 'lifecycle/list', respond: () => ({ body: { objects: [], totalCount: 0 } }) },
    { match: 'agent/get', respond: () => ({ body: { agentId: 'a1', intellect: { id: 10 } } }) },
    { match: 'v1/intellect/get', respond: () => ({ status: 500, body: { message: 'boom' } }) },
    { match: '/assistant/converse', respond: () => ({ body: REPLY }) },
  ]);
  const mgmt = new Management({ partnerId: '123', adminSecret: 's3cret', fetch: ff });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1' });
  assert.equal(r.config, null);
  assert.equal(r.ran, true);
  const ff401 = fakeFetch([
    { match: 'lifecycle/list', respond: () => ({ body: { objects: [], totalCount: 0 } }) },
    { match: 'agent/get', respond: () => ({ body: { agentId: 'a1', intellect: { id: 10 } } }) },
    { match: 'v1/intellect/get', respond: () => ({ status: 401, body: { message: 'expired' } }) },
  ]);
  await assert.rejects(() => new Management({ partnerId: '123', adminSecret: 's3cret', fetch: ff401 }).doctorProbe(ADMIN_KS, { agentId: 'a1' }));
});

test('doctorProbe: allowSymbols removes the listed symbols and keeps the rest; digitRuns stays complete', async () => {
  const { mgmt } = harness({ reply: () => ({ body: SPOKEN_REPLY }) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', spoken: { allowSymbols: ['%', '#'] } });
  assert.deepEqual(r.reply.spoken.symbols, ['$']);
  assert.equal(r.reply.spoken.digits, 3);
  assert.deepEqual(r.reply.spoken.digitRuns, ['12', '84', '9']);
  assert.deepEqual((await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', spoken: { allowSymbols: ['%', '$'] } })).reply.spoken.symbols, []);
});

test('doctorProbe: digitRuns is empty for a reply with no digits', async () => {
  const { mgmt } = harness();
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', spoken: {} });
  assert.deepEqual(r.reply.spoken, { rawTerms: [], digits: 0, digitRuns: [], symbols: [] });
});

test('doctorProbe: includeText adds reply.text, and only when asked', async () => {
  const { mgmt } = harness();
  assert.equal((await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', includeText: true })).reply.text, 'Hello world');
  assert.equal('text' in (await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', includeText: false })).reply, false);
  assert.equal('text' in (await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1' })).reply, false);
});

// ---- client tools -------------------------------------------------------------------------

const waitingTool = (name, args = {}, extra = {}) => seg({ type: 'tool', content: `${name} ${JSON.stringify(args)}`, tool_metadata: { id: 'turn-1', name, args, type: 'client', wait_for_response: true, ...extra } });
const toolReply = (...tools) => [seg({ type: 'think', content: '', threadId: 't', messageId: 'm' }), ...tools, seg({ type: 'text', content: 'Done.' })].join('\n') + '\n';
const acks = (ff) => ff.calls.filter((c) => c.url.endsWith('/assistant/tool_response'));

/** A converse reply that sends `head`, then stays open until the probe aborts it. */
function hangingFetch(inner, head) {
  const fn = async (url, init) => {
    if (!String(url).endsWith('/assistant/converse')) return inner(url, init);
    inner.calls.push({ url: String(url), method: 'POST', headers: {}, body: null });
    const enc = new TextEncoder();
    return {
      ok: true, status: 200, headers: { get: () => 'application/x-ndjson' },
      body: new ReadableStream({ start(c) { c.enqueue(enc.encode(head)); init.signal.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))); } }),
    };
  };
  fn.calls = inner.calls;
  return fn;
}

test('doctorProbe: a stub object answers a waiting client tool with the call ids and the turn finishes', async () => {
  const { mgmt, ff } = harness({ reply: () => ({ body: toolReply(waitingTool('navigate_to_slide', { slide_num: 4 })) }) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', clientTools: { navigate_to_slide: { ok: true, text: 'Showing slide 4' } } });
  assert.deepEqual(r.reply.toolAcks, [{ name: 'navigate_to_slide', ok: true }]);
  assert.deepEqual(r.reply.unansweredTools, []);
  assert.equal(r.error, null);
  assert.equal(acks(ff).length, 1);
  assert.deepEqual(acks(ff)[0].body, { tool_name: 'navigate_to_slide', tool_id: 'turn-1', tool_invocation_id: 'turn-1', response: { ok: true, text: 'Showing slide 4' } });
  assert.equal(acks(ff)[0].headers.authorization, `KS ${CONV_KS}`);
});

test('doctorProbe: a stub function gets the parsed args and the call, sync or async', async () => {
  const seen = [];
  const { mgmt, ff } = harness({ reply: () => ({ body: toolReply(waitingTool('a', { n: 1 }), waitingTool('b', { n: 2 })) }) });
  const r = await mgmt.doctorProbe(ADMIN_KS, {
    agentId: 'a1',
    clientTools: {
      a: (args, call) => { seen.push([args, call.name, call.toolMetadata.id]); return { got: args.n }; },
      b: async (args) => { await Promise.resolve(); return { got: args.n }; },
    },
  });
  assert.deepEqual(seen, [[{ n: 1 }, 'a', 'turn-1']]);
  assert.deepEqual(r.reply.toolAcks.map((a) => [a.name, a.ok]).sort(), [['a', true], ['b', true]]);
  assert.deepEqual(acks(ff).map((c) => c.body.response).sort((x, y) => x.got - y.got), [{ got: 1 }, { got: 2 }]);
});

test('doctorProbe: a waiting tool with no stub is listed as unanswered and gets no answer', async () => {
  const { mgmt, ff } = harness({ reply: () => ({ body: toolReply(waitingTool('navigate_to_slide'), waitingTool('navigate_to_slide'), waitingTool('other')) }) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', clientTools: { other: { ok: true } } });
  assert.deepEqual(r.reply.unansweredTools, ['navigate_to_slide']);
  assert.deepEqual(r.reply.toolAcks, [{ name: 'other', ok: true }]);
  assert.equal(acks(ff).length, 1);
});

test('doctorProbe: tools that do not wait, and plain tool segments, get no answer', async () => {
  const body = toolReply(waitingTool('go_to', {}, { wait_for_response: false }), seg({ type: 'tool', content: 'lookup {"q":1}' }));
  const { mgmt, ff } = harness({ reply: () => ({ body }) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', clientTools: { go_to: { ok: true }, lookup: { ok: true } } });
  assert.deepEqual(r.reply.toolAcks, []);
  assert.deepEqual(r.reply.unansweredTools, []);
  assert.equal(r.reply.toolCalls, 2);
  assert.equal(acks(ff).length, 0);
});

test('doctorProbe: a rejected answer is recorded with its status and counts as unanswered', async () => {
  const { mgmt } = harness({ reply: () => ({ body: toolReply(waitingTool('nav')) }), toolResponse: () => ({ status: 403, body: { message: 'no' } }) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', clientTools: { nav: { ok: true } } });
  assert.deepEqual(r.reply.toolAcks, [{ name: 'nav', ok: false, reason: 'http_error', status: 403 }]);
  assert.deepEqual(r.reply.unansweredTools, ['nav']);
});

test('doctorProbe: a failed answer without an HTTP status has no status field', async () => {
  const inner = fakeFetch([
    { match: '/service/session/action/start', respond: () => ({ body: CONV_KS }) },
    { match: 'lifecycle/list', respond: () => ({ body: { objects: [], totalCount: 0 } }) },
    { match: 'agent/get', respond: () => ({ body: { agentId: 'a1', intellect: { id: 10 } } }) },
    { match: 'v1/intellect/get', respond: () => ({ body: { id: 10, type: 'brain' } }) },
    { match: '/assistant/converse', respond: () => ({ body: toolReply(waitingTool('nav')) }) },
  ]);
  const ff = async (url, init) => { if (String(url).endsWith('/assistant/tool_response')) throw new Error('network down'); return inner(url, init); };
  const mgmt = new Management({ partnerId: '123', adminSecret: 's3cret', fetch: ff, retry: false });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', clientTools: { nav: { ok: true } } });
  assert.equal(r.reply.toolAcks[0].ok, false);
  assert.equal(r.reply.toolAcks[0].reason, 'http_error');
  assert.equal('status' in r.reply.toolAcks[0], false);
});

test('doctorProbe: a throwing stub function and a non-object answer are recorded and nothing is sent', async () => {
  const { mgmt, ff } = harness({ reply: () => ({ body: toolReply(waitingTool('a'), waitingTool('b'), waitingTool('c')) }) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', clientTools: { a: () => { throw new Error('x'); }, b: () => 'ok', c: () => [1] } });
  assert.deepEqual(r.reply.toolAcks.map((a) => [a.name, a.reason]).sort(), [['a', 'handler_error'], ['b', 'bad_response'], ['c', 'bad_response']]);
  assert.deepEqual(r.reply.unansweredTools.sort(), ['a', 'b', 'c']);
  assert.equal(acks(ff).length, 0);
});

test('doctorProbe: a tool named like an Object property is not answered by the prototype', async () => {
  const { mgmt, ff } = harness({ reply: () => ({ body: toolReply(waitingTool('constructor'), waitingTool('toString')) }) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', clientTools: { other: { ok: true } } });
  assert.deepEqual(r.reply.toolAcks, []);
  assert.deepEqual(r.reply.unansweredTools, ['constructor', 'toString']);
  assert.equal(acks(ff).length, 0);
});

test('doctorProbe: an answer that settles after the last segment is still sent and reported', async () => {
  const { mgmt, ff } = harness({ reply: () => ({ body: toolReply(waitingTool('slow')) }) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', timeoutMs: 5000, clientTools: { slow: async () => { await new Promise((ok) => setTimeout(ok, 40)); return { ok: true }; } } });
  assert.deepEqual(r.reply.toolAcks, [{ name: 'slow', ok: true }]);
  assert.deepEqual(r.reply.unansweredTools, []);
  assert.equal(acks(ff).length, 1);
});

test('doctorProbe: a handler that never settles ends at timeoutMs and is reported as handler_timeout', async () => {
  const { mgmt, ff } = harness({ reply: () => ({ body: toolReply(waitingTool('stuck')) }) });
  const started = Date.now();
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', timeoutMs: 60, clientTools: { stuck: () => new Promise(() => {}) } });
  assert.ok(Date.now() - started < 2000, 'returned near timeoutMs');
  assert.deepEqual(r.reply.toolAcks, [{ name: 'stuck', ok: false, reason: 'handler_timeout' }]);
  assert.deepEqual(r.reply.unansweredTools, ['stuck']);
  assert.equal(acks(ff).length, 0);
});

test('doctorProbe: a handler that rejects after the timeout raises no unhandled rejection', async () => {
  const { mgmt } = harness({ reply: () => ({ body: toolReply(waitingTool('late')) }) });
  const seen = [];
  const onRejection = (e) => seen.push(e);
  process.on('unhandledRejection', onRejection);
  try {
    const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', timeoutMs: 30, clientTools: { late: () => new Promise((_, no) => setTimeout(() => no(new Error('late')), 80)) } });
    assert.equal(r.reply.toolAcks[0].reason, 'handler_timeout');
    await new Promise((ok) => setTimeout(ok, 150));
  } finally { process.off('unhandledRejection', onRejection); }
  assert.deepEqual(seen, []);
});

test('doctorProbe: a handler is not waited for when the timeout has already fired', async () => {
  const { mgmt } = harness();
  const call = { name: 'nav', args: {}, toolMetadata: { id: 't1', waitForResponse: true } };
  assert.deepEqual(await mgmt._doctorProbe._answer('token', call, () => new Promise(() => {}), AbortSignal.abort()), { name: 'nav', ok: false, reason: 'handler_timeout' });
});

test('doctorProbe: an answer that is not plain JSON is bad_response and nothing is sent', async () => {
  const { mgmt, ff } = harness({ reply: () => ({ body: toolReply(waitingTool('big'), waitingTool('loop')) }) });
  const loop = {}; loop.self = loop;
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', clientTools: { big: { n: 10n }, loop } });
  assert.deepEqual(r.reply.toolAcks.map((a) => [a.name, a.ok, a.reason]).sort(), [['big', false, 'bad_response'], ['loop', false, 'bad_response']]);
  assert.equal(acks(ff).length, 0);
});

test('doctorProbe: the answer is sent while the stream is still open (not after it ends)', async () => {
  const inner = fakeFetch([
    { match: '/service/session/action/start', respond: () => ({ body: CONV_KS }) },
    { match: 'lifecycle/list', respond: () => ({ body: { objects: [], totalCount: 0 } }) },
    { match: 'agent/get', respond: () => ({ body: { agentId: 'a1', intellect: { id: 10 } } }) },
    { match: 'v1/intellect/get', respond: () => ({ body: { id: 10, type: 'brain' } }) },
    { match: '/assistant/tool_response', respond: () => ({ body: {} }) },
  ]);
  const mgmt = new Management({ partnerId: '123', adminSecret: 's3cret', fetch: hangingFetch(inner, toolReply(waitingTool('nav')).split('\n').slice(0, 2).join('\n') + '\n') });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', timeoutMs: 80, clientTools: { nav: { ok: true } } });
  assert.equal(acks({ calls: inner.calls }).length, 1, 'answered before the abort');
  assert.equal(r.error.code, 'probe_timeout');
  assert.deepEqual(r.error.unansweredTools, []);
  assert.doesNotMatch(r.error.message, /client tool/);
});

test('doctorProbe: a timeout names the client tools that were waiting and shows how to answer them', async () => {
  const inner = fakeFetch([
    { match: '/service/session/action/start', respond: () => ({ body: CONV_KS }) },
    { match: 'lifecycle/list', respond: () => ({ body: { objects: [], totalCount: 0 } }) },
    { match: 'agent/get', respond: () => ({ body: { agentId: 'a1', intellect: { id: 10 } } }) },
    { match: 'v1/intellect/get', respond: () => ({ body: { id: 10, type: 'brain' } }) },
  ]);
  const head = toolReply(waitingTool('navigate_to_slide'), waitingTool('second')).split('\n').slice(0, 3).join('\n') + '\n';
  const mgmt = new Management({ partnerId: '123', adminSecret: 's3cret', fetch: hangingFetch(inner, head) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', timeoutMs: 80 });
  assert.equal(r.reply, null);
  assert.equal(r.error.code, 'probe_timeout');
  assert.deepEqual(r.error.unansweredTools, ['navigate_to_slide', 'second']);
  assert.match(r.error.message, /No reply within 80 ms\./);
  assert.match(r.error.message, /"navigate_to_slide", "second"/);
  assert.match(r.error.message, /clientTools: \{ navigate_to_slide: \{ \.\.\. \} \}/);
});

test('doctorProbe: a timeout after a failed or unfinished answer says so instead of asking for clientTools', async () => {
  const inner = fakeFetch([
    { match: '/service/session/action/start', respond: () => ({ body: CONV_KS }) },
    { match: 'lifecycle/list', respond: () => ({ body: { objects: [], totalCount: 0 } }) },
    { match: 'agent/get', respond: () => ({ body: { agentId: 'a1', intellect: { id: 10 } } }) },
    { match: 'v1/intellect/get', respond: () => ({ body: { id: 10, type: 'brain' } }) },
    { match: '/assistant/tool_response', respond: () => ({ status: 500, body: { message: 'no' } }) },
  ]);
  const head = toolReply(waitingTool('rejected'), waitingTool('unfinished'), waitingTool('missing')).split('\n').slice(0, 4).join('\n') + '\n';
  const mgmt = new Management({ partnerId: '123', adminSecret: 's3cret', fetch: hangingFetch(inner, head) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', timeoutMs: 120, clientTools: { rejected: { ok: true }, unfinished: () => new Promise(() => {}) } });
  assert.equal(r.error.code, 'probe_timeout');
  assert.deepEqual(r.error.unansweredTools.sort(), ['missing', 'rejected', 'unfinished']);
  assert.match(r.error.message, /Pass clientTools: \{ missing: \{ \.\.\. \} \}/);
  assert.match(r.error.message, /The answer for client tool "rejected" failed \(http_error 500\)\./);
  assert.match(r.error.message, /The answer for client tool "unfinished" failed \(handler_timeout\)\./);
  assert.doesNotMatch(r.error.message, /clientTools: \{ (rejected|unfinished)/);
});

test('doctorProbe: a timeout while the answer is still being sent says it had not finished', async () => {
  const inner = fakeFetch([
    { match: '/service/session/action/start', respond: () => ({ body: CONV_KS }) },
    { match: 'lifecycle/list', respond: () => ({ body: { objects: [], totalCount: 0 } }) },
    { match: 'agent/get', respond: () => ({ body: { agentId: 'a1', intellect: { id: 10 } } }) },
    { match: 'v1/intellect/get', respond: () => ({ body: { id: 10, type: 'brain' } }) },
  ]);
  const stalled = Object.assign((url, init) => (String(url).endsWith('/assistant/tool_response') ? new Promise(() => {}) : inner(url, init)), { calls: inner.calls });
  const head = toolReply(waitingTool('sending')).split('\n').slice(0, 2).join('\n') + '\n';
  const mgmt = new Management({ partnerId: '123', adminSecret: 's3cret', fetch: hangingFetch(stalled, head) });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', timeoutMs: 80, clientTools: { sending: { ok: true } } });
  assert.deepEqual(r.error.unansweredTools, ['sending']);
  assert.match(r.error.message, /The answer for client tool "sending" had not finished\./);
});

test('doctorProbe: a plain timeout (no waiting tools) keeps the short message, and other errors list no tools', async () => {
  const inner = fakeFetch([
    { match: '/service/session/action/start', respond: () => ({ body: CONV_KS }) },
    { match: 'lifecycle/list', respond: () => ({ body: { objects: [], totalCount: 0 } }) },
    { match: 'agent/get', respond: () => ({ body: { agentId: 'a1', intellect: { id: 10 } } }) },
    { match: 'v1/intellect/get', respond: () => ({ body: { id: 10, type: 'brain' } }) },
  ]);
  const mgmt = new Management({ partnerId: '123', adminSecret: 's3cret', fetch: hangingFetch(inner, REPLY.split('\n')[0] + '\n') });
  const r = await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', timeoutMs: 50 });
  assert.equal(r.error.message, 'No reply within 50 ms.');
  assert.deepEqual(r.error.unansweredTools, []);
  const failed = await harness({ reply: () => ({ status: 500, body: { message: 'boom' } }) }).mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1' });
  assert.deepEqual(failed.error.unansweredTools, []);
});

test('doctorProbe: bad clientTools and includeText are rejected before any request', async () => {
  const { mgmt, ff } = harness();
  for (const extra of [{ clientTools: null }, { clientTools: [] }, { clientTools: 'x' }, { clientTools: { a: 1 } }, { clientTools: { a: null } }, { clientTools: { a: [] } }, { includeText: 'yes' }, { includeText: 1 }]) {
    await assert.rejects(() => mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', ...extra }), { code: 'bad_request' });
  }
  assert.equal(ff.calls.length, 0);
  await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1', clientTools: {} });
});

test('doctorProbe: a failure without code, status or detail falls back to a generic code and its own text', async () => {
  const { mgmt } = harness();
  const fail = (e) => { mgmt._doctorProbe._d.conversations.stream = () => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw e; } }) }); };
  fail(new Error('plain'));
  assert.deepEqual((await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1' })).error, { code: 'error', message: 'plain', unansweredTools: [] });
  fail('just text');
  assert.deepEqual((await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1' })).error, { code: 'error', message: 'just text', unansweredTools: [] });
  fail({ status: 502, detail: 'bad gateway' });
  assert.deepEqual((await mgmt.doctorProbe(ADMIN_KS, { agentId: 'a1' })).error, { code: '502', message: 'bad gateway', unansweredTools: [] });
});
