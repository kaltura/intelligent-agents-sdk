import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/index.js';
import { assertRequestVars, RESERVED_VARS, SPIRAL_RECOVERY_PREFIX } from '../../src/management/conversations.js';
import { fakeFetch, streamFrom } from '../fakes/fetch.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

const STREAM = [
  '{"type":"think","content":"","threadId":"t9","messageId":"m9"}',
  '{"type":"text","content":"Adaptive "}',
  '{"type":"text","content":"bitrate streaming."}',
  '{"type":"unisphere-tool","content":{"q":[]},"metadata":{"runtimeName":"followups-tool"}}',
].join('\n') + '\n';

test('conversations.send streams + assembles text, thread, experiences', async () => {
  const f = fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: STREAM }) }]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const r = await m.conversations.send({ userMessage: 'what is ABR?' }, CONV_KS);
  assert.equal(r.text, 'Adaptive bitrate streaming.');
  assert.equal(r.threadId, 't9');
  assert.equal(r.messageId, 'm9');
  assert.ok(r.experiences['followups-tool']);
  // sent the right body
  const call = f.calls.find((c) => c.url.includes('/assistant/converse'));
  assert.equal(call.body.userMessage, 'what is ABR?');
  assert.equal(call.body.sse, false);
  assert.match(call.headers['authorization'], /^KS /);
});

test('conversations.stream yields segments lazily', async () => {
  const f = fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: STREAM }) }]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const types = [];
  for await (const seg of m.conversations.stream({ userMessage: 'hi' }, CONV_KS)) types.push(seg.type);
  assert.deepEqual(types, ['think', 'text', 'text', 'unisphere-tool']);
});

test('conversations.stream forwards a caller-supplied signal to the underlying fetch (so a caller can actually cancel a stalled stream)', async () => {
  let capturedSignal;
  const f = async (url, init = {}) => {
    capturedSignal = init.signal;
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => STREAM, body: streamFrom(STREAM) };
  };
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const ctrl = new AbortController();
  for await (const _ of m.conversations.stream({ userMessage: 'hi', signal: ctrl.signal }, CONV_KS)) { /* drain */ }
  assert.equal(capturedSignal, ctrl.signal);
});

test('conversations.stream rejects with a typed error when the caller aborts before the fetch resolves (no built-in timeout of its own — see client.js genieStream)', async () => {
  const ctrl = new AbortController();
  const f = async (url, init = {}) => {
    ctrl.abort();
    const e = new Error('The operation was aborted.');
    e.name = 'AbortError';
    throw e;
  };
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    async () => { for await (const _ of m.conversations.stream({ userMessage: 'hi', signal: ctrl.signal }, CONV_KS)) { /* */ } },
    (e) => e.status === 0 && e.detail === 'aborted by caller',
  );
});

test('converse rejects an admin token (entitlement must stay ON)', async () => {
  const adminKs = 'djJ8' + Buffer.from('v2|123|disableentitlement').toString('base64url');
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: fakeFetch([]) });
  await assert.rejects(async () => { for await (const _ of m.conversations.stream({ userMessage: 'x' }, adminKs)) { /* */ } }, (e) => e.code === 'wrong_token_scope');
});

test('extra converse params (force_experience, request_vars, capabilities) pass through', async () => {
  const f = fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: '{"type":"text","content":"ok"}\n' }) }]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await m.conversations.send({ userMessage: 'teach me', force_experience: 'flashcards', request_vars: { firstName: 'Sam' }, capabilities: { generate_followup_questions: 'on' } }, CONV_KS);
  const body = f.calls.find((c) => c.url.includes('/assistant/converse')).body;
  assert.equal(body.force_experience, 'flashcards');
  assert.deepEqual(body.request_vars, { firstName: 'Sam' });
  assert.deepEqual(body.capabilities, { generate_followup_questions: 'on' });
});

test('invalid force_experience is rejected BEFORE the network call (typed validation_error)', async () => {
  const f = fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: '{"type":"text","content":"ok"}\n' }) }]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    async () => { for await (const _ of m.conversations.stream({ userMessage: 'x', force_experience: 'flash_cars' }, CONV_KS)) { /* */ } },
    (e) => e.code === 'validation_error' && /markdown|flashcards/.test(e.detail),
  );
  // never hit the network
  assert.equal(f.calls.filter((c) => c.url.includes('/assistant/converse')).length, 0);
});

test('a server 422 with FastAPI array detail surfaces the actionable message (not server_error)', async () => {
  const detail = JSON.stringify({ detail: [{ loc: ['body', 'force_experience'], msg: "Input should be 'markdown','summarization','flashcards' or 'avatar_only'", type: 'enum' }] });
  const f = fakeFetch([{ match: '/assistant/converse', respond: () => ({ status: 422, body: detail }) }]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    async () => { for await (const _ of m.conversations.stream({ userMessage: 'x' }, CONV_KS)) { /* */ } },
    (e) => e.code === 'validation_error' && /Input should be/.test(e.detail),
  );
});

// ─────────── W5/W12: assertRequestVars (pure) ───────────

test('assertRequestVars rejects a RESERVED_VARS collision (sys__/secrets)', () => {
  for (const k of RESERVED_VARS) {
    assert.throws(() => assertRequestVars({ [k]: 'x' }), (e) => e.code === 'validation_error' && new RegExp(k).test(e.detail));
  }
});

test('assertRequestVars rejects a non-scalar (nested object/array) value', () => {
  assert.throws(() => assertRequestVars({ profile: { tier: 'gold' } }), (e) => e.code === 'validation_error' && /scalar/.test(e.detail));
  assert.throws(() => assertRequestVars({ ids: [1, 2] }), (e) => e.code === 'validation_error' && /scalar/.test(e.detail));
  assert.throws(() => assertRequestVars([1, 2]), (e) => e.code === 'validation_error');
});

test('assertRequestVars passes scalars + treats null/undefined as a no-op', () => {
  assert.deepEqual(assertRequestVars({ firstName: 'Sam', age: 40, vip: true, mid: null }), { firstName: 'Sam', age: 40, vip: true, mid: null });
  assert.equal(assertRequestVars(undefined), undefined);
  assert.equal(assertRequestVars(null), undefined);
});

test('stream() rejects reserved + nested request_vars BEFORE any fetch', async () => {
  const f = fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: '{"type":"text","content":"ok"}\n' }) }]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    async () => { for await (const _ of m.conversations.stream({ userMessage: 'x', request_vars: { sys__user_id: 'spoof' } }, CONV_KS)) { /* */ } },
    (e) => e.code === 'validation_error',
  );
  await assert.rejects(
    async () => { for await (const _ of m.conversations.stream({ userMessage: 'x', request_vars: { profile: { tier: 'gold' } } }, CONV_KS)) { /* */ } },
    (e) => e.code === 'validation_error',
  );
  assert.equal(f.calls.filter((c) => c.url.includes('/assistant/converse')).length, 0);
});

test('stream() rejects an unknown per-message capability BEFORE any fetch', async () => {
  const f = fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: '{"type":"text","content":"ok"}\n' }) }]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    async () => { for await (const _ of m.conversations.stream({ userMessage: 'x', capabilities: { not_a_capability: 'on' } }, CONV_KS)) { /* */ } },
    (e) => e.code === 'unknown_capability',
  );
  assert.equal(f.calls.filter((c) => c.url.includes('/assistant/converse')).length, 0);
});

test('a converse 403 saying "Client variables are not allowed" remaps to client_variables_disabled', async () => {
  const f = fakeFetch([{ match: '/assistant/converse', respond: () => ({ status: 403, body: { detail: 'Client variables are not allowed for this assistant' } }) }]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    async () => { for await (const _ of m.conversations.stream({ userMessage: 'x', request_vars: { firstName: 'Sam' } }, CONV_KS)) { /* */ } },
    (e) => e.code === 'client_variables_disabled' && e.status === 403,
  );
});

test('a generic converse 403 (scope/cross-partner) is left as a scope-403, NOT mislabeled', async () => {
  const f = fakeFetch([{ match: '/assistant/converse', respond: () => ({ status: 403, body: { detail: 'Forbidden: token scope mismatch' } }) }]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    async () => { for await (const _ of m.conversations.stream({ userMessage: 'x' }, CONV_KS)) { /* */ } },
    (e) => e.code === 'forbidden' && e.code !== 'client_variables_disabled',
  );
});

// ─────────── send({recoverFromSpiral:true}): one-shot nudge retry on an empty spiral ───────────

function spiralNdjson() {
  const seg = (type, content) => JSON.stringify({ type, content, threadId: 't-spiral' });
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(seg('tool', `show_widget {"kind":"summary","data":{"n":${i}}}`));
  return lines.join('\n') + '\n';
}

test('send({recoverFromSpiral:true}) retries ONCE with a nudge when the first attempt is an empty spiral', async () => {
  const f = fakeFetch([{
    match: '/assistant/converse',
    respond: (req) => (String(req.body.userMessage).startsWith(SPIRAL_RECOVERY_PREFIX)
      ? { body: '{"type":"text","content":"The answer is 42.","threadId":"t-spiral"}\n' }
      : { body: spiralNdjson() }),
  }]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const r = await m.conversations.send({ userMessage: 'what is the guidance?', recoverFromSpiral: true }, CONV_KS);
  assert.equal(r.text, 'The answer is 42.');
  assert.equal(r.spiralStopped, false);
  assert.equal(r.spiralRecovered, true);
  assert.equal(r.firstAttempt.spiralStopped, true);
  assert.ok(r.firstAttempt.toolCalls.length > 0);
  const converseCalls = f.calls.filter((c) => c.url.includes('/assistant/converse'));
  assert.equal(converseCalls.length, 2, 'exactly one retry, not an unbounded loop');
  assert.ok(converseCalls[1].body.userMessage.startsWith(SPIRAL_RECOVERY_PREFIX));
  assert.ok(converseCalls[1].body.userMessage.endsWith('what is the guidance?'), 'original question preserved, not replaced');
  assert.equal(converseCalls[1].body.threadId, 't-spiral', 'nudge stays on the same thread');
});

test('send({recoverFromSpiral:true}) does not retry when the spiral still produced spoken text', async () => {
  const f = fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: '{"type":"text","content":"partial answer"}\n{"type":"tool","content":"show_widget {}"}\n' }) }]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const r = await m.conversations.send({ userMessage: 'x', recoverFromSpiral: true }, CONV_KS);
  assert.equal(r.text, 'partial answer');
  assert.equal(r.spiralRecovered, undefined);
  assert.equal(f.calls.filter((c) => c.url.includes('/assistant/converse')).length, 1);
});

test('send({recoverFromSpiral:true}) gives up after one retry if the nudge ALSO spirals empty', async () => {
  const f = fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: spiralNdjson() }) }]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const r = await m.conversations.send({ userMessage: 'x', recoverFromSpiral: true }, CONV_KS);
  assert.equal(r.text, '');
  assert.equal(r.spiralStopped, true);
  assert.equal(r.spiralRecovered, false);
  assert.equal(f.calls.filter((c) => c.url.includes('/assistant/converse')).length, 2, 'never more than one retry');
});

test('send() without recoverFromSpiral is unchanged (back-compat: no retry, no new fields)', async () => {
  const f = fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: spiralNdjson() }) }]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const r = await m.conversations.send({ userMessage: 'x' }, CONV_KS);
  assert.equal(r.text, '');
  assert.equal(r.spiralStopped, true);
  assert.equal(r.spiralRecovered, undefined);
  assert.equal(f.calls.filter((c) => c.url.includes('/assistant/converse')).length, 1);
});

test('model_type passes through lowercase fast verbatim (no DEFAULT, no normalization)', async () => {
  const f = fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: '{"type":"text","content":"ok"}\n' }) }]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await m.conversations.send({ userMessage: 'x', model_type: 'fast' }, CONV_KS);
  const body = f.calls.find((c) => c.url.includes('/assistant/converse')).body;
  assert.equal(body.model_type, 'fast');
  // primary model: omit model_type entirely
  const f2 = fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: '{"type":"text","content":"ok"}\n' }) }]);
  const m2 = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f2 });
  await m2.conversations.send({ userMessage: 'x' }, CONV_KS);
  assert.ok(!('model_type' in f2.calls.find((c) => c.url.includes('/assistant/converse')).body));
});
