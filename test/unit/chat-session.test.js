// KalturaChatSession — the text-only transport. Proves the HTTP converse loop
// end to end offline: lifecycle states, per-turn events, request_vars riding
// every turn, mid-stream tool dispatch with the same semantics as the live
// socket (dedup, schema gate, fused recovery), and the KS-authenticated
// waitForResponse ACK (respondToTool → /assistant/tool_response).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaChatSession, KalturaError } from '../../src/experience/index.js';
import { fakeFetch } from '../fakes/fetch.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

const seg = (o) => JSON.stringify(o);
const REPLY = [
  seg({ type: 'think', content: '', threadId: 't-1', messageId: 'm-1' }),
  seg({ type: 'text', content: 'Hello ' }),
  seg({ type: 'text', content: 'world' }),
].join('\n') + '\n';

/** @param {object} [opts] */
function newSession(opts = {}) {
  const fetch = opts.fetch ?? fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: opts.reply ?? REPLY }) }]);
  const session = new KalturaChatSession({ token: CONV_KS, fetch, ...(opts.cfg || {}) });
  return { session, fetch };
}

// ───────────────────────── construction ─────────────────────────

test('requires a token; validates requestVars and capabilities at construction', () => {
  assert.throws(() => new KalturaChatSession({}), /token/);
  assert.throws(() => new KalturaChatSession({ token: CONV_KS, requestVars: { sys__user_id: 'x' } }), (e) => e.code === 'validation_error');
  assert.throws(() => new KalturaChatSession({ token: CONV_KS, requestVars: { nested: { a: 1 } } }), (e) => e instanceof KalturaError);
  assert.throws(() => new KalturaChatSession({ token: CONV_KS, capabilities: { avatar: 'maybe' } }), (e) => e instanceof KalturaError);
});

test('token is non-enumerable — never serializes off the instance', () => {
  const { session } = newSession();
  assert.ok(!JSON.stringify(session).includes(CONV_KS));
  assert.ok(!Object.keys(session).includes('_token'));
});

test('rejects an http:// genieUrl unless allowInsecureTransport (loopback exempt)', () => {
  assert.throws(() => new KalturaChatSession({ token: CONV_KS, genieUrl: 'http://genie.example.com' }), /insecure/i);
  const warns = [];
  const s = new KalturaChatSession({ token: CONV_KS, genieUrl: 'http://localhost:8080', logger: (lvl, msg) => warns.push(msg) });
  assert.equal(s.state, 'idle');
});

// ───────────────────────── lifecycle ─────────────────────────

test('lifecycle: idle → connected → closed; connect is once-only; disconnect idempotent', async () => {
  const { session } = newSession();
  const states = [];
  session.on('stateChange', (p) => states.push(p.state));
  assert.equal(session.state, 'idle');
  await assert.rejects(() => session.sendText('hi'), (e) => e.code === 'invalid_state');
  await session.connect();
  assert.equal(session.state, 'connected');
  await assert.rejects(() => session.connect(), (e) => e.code === 'invalid_state');
  const ended = [];
  session.on('ended', (p) => ended.push(p));
  session.disconnect();
  session.disconnect();   // idempotent no-op
  assert.equal(session.state, 'closed');
  assert.deepEqual(states, ['connected', 'closed']);
  assert.equal(ended.length, 1);
  assert.deepEqual(ended[0], { reason: 'disconnected' });
  await assert.rejects(() => session.sendText('hi'), (e) => e.code === 'invalid_state');
});

// ───────────────────────── sendText ─────────────────────────

test('sendText: full turn — wire body, auth header, events in order, collected result', async () => {
  const { session, fetch } = newSession();
  await session.connect();
  const events = [];
  for (const ev of ['transcript', 'turnStart', 'responsePending', 'responseSettled', 'turnEnd']) {
    session.on(ev, (p) => events.push([ev, p]));
  }
  const r = await session.sendText('hi there');
  const req = fetch.calls[0];
  assert.ok(req.url.endsWith('/assistant/converse'));
  assert.equal(req.headers.authorization, `KS ${CONV_KS}`);
  assert.deepEqual(req.body, { userMessage: 'hi there', sse: false });   // no threadId/request_vars on a fresh, vars-free turn
  assert.equal(r.text, 'Hello world');
  assert.equal(r.threadId, 't-1');
  assert.equal(r.messageId, 'm-1');
  assert.equal(r.segments.length, 3);
  const order = events.map(([ev, p]) => (ev === 'transcript' ? `transcript:${p.type}` : ev));
  assert.deepEqual(order, ['transcript:user', 'turnStart', 'responsePending', 'responseSettled', 'transcript:final', 'transcript:final', 'turnEnd']);
  assert.equal(events[0][1].text, 'hi there');
  // Second turn continues the captured thread.
  await session.sendText('and again');
  assert.equal(fetch.calls[1].body.threadId, 't-1');
});

test('sendText rejects empty/non-string input', async () => {
  const { session } = newSession();
  await session.connect();
  await assert.rejects(() => session.sendText('   '), (e) => e.code === 'bad_request');
  await assert.rejects(() => session.sendText(42), (e) => e.code === 'bad_request');
});

test('cfg.threadId seeds the conversation (thread continuity from another transport)', async () => {
  const { session, fetch } = newSession({ cfg: { threadId: 'seeded-thread' } });
  assert.equal(session.threadId, 'seeded-thread');
  await session.connect();
  await session.sendText('continue');
  assert.equal(fetch.calls[0].body.threadId, 'seeded-thread');
});

test('turns are serialized — a second sendText waits for the first stream to finish', async () => {
  let inFlight = 0, maxInFlight = 0;
  const fetch = async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(REPLY)); c.close(); } });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '', body };
  };
  const { session } = newSession({ fetch });
  await session.connect();
  const [a, b] = await Promise.all([session.sendText('one'), session.sendText('two')]);
  assert.equal(maxInFlight, 1, 'two converse requests must never overlap');
  assert.equal(a.text, 'Hello world');
  assert.equal(b.text, 'Hello world');
});

// ───────────────────────── request_vars / capabilities ─────────────────────────

test('request_vars ride every turn; updateRequestVars merges; setDynamicPrompt sets page_context', async () => {
  const { session, fetch } = newSession({ cfg: { requestVars: { user_name: 'Dana' } } });
  await session.connect();
  await session.sendText('turn 1');
  assert.deepEqual(fetch.calls[0].body.request_vars, { user_name: 'Dana' });
  session.updateRequestVars({ plan: 'pro' });
  session.setDynamicPrompt({ page: '/pricing', headings: ['Plans'] });
  await session.sendText('turn 2');
  const vars = fetch.calls[1].body.request_vars;
  assert.equal(vars.user_name, 'Dana');
  assert.equal(vars.plan, 'pro');
  assert.deepEqual(JSON.parse(vars.page_context), { page: '/pricing', headings: ['Plans'] });
  assert.throws(() => session.updateRequestVars({ sys__user_id: 'nope' }), (e) => e.code === 'validation_error');
});

test('capabilities: omitted by default, sent verbatim when configured', async () => {
  const a = newSession();
  await a.session.connect();
  await a.session.sendText('x');
  assert.ok(!('capabilities' in a.fetch.calls[0].body));
  const b = newSession({ cfg: { capabilities: { kaltura_genie_experiences: 'off' } } });
  await b.session.connect();
  await b.session.sendText('x');
  assert.deepEqual(b.fetch.calls[0].body.capabilities, { kaltura_genie_experiences: 'off' });
});

test("silent empty turn with request_vars in play → one 'warning' with code empty_turn_with_request_vars, var KEYS only", async () => {
  const { session } = newSession({ reply: '', cfg: { requestVars: { user_name: 'Dana', page_context: '{"secret":"value"}' } } });
  await session.connect();
  const warnings = [];
  session.on('warning', (w) => warnings.push(w));
  const r1 = await session.sendText('hi');
  assert.equal(r1.text, '');
  assert.equal(r1.segments.length, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'empty_turn_with_request_vars');
  assert.deepEqual(warnings[0].requestVarKeys, ['user_name', 'page_context']);
  assert.ok(!JSON.stringify(warnings[0]).includes('Dana'), 'warning must never carry variable VALUES');
  await session.sendText('again');   // once per session, not per turn
  assert.equal(warnings.length, 1);
});

test('an empty turn with NO request_vars is not flagged', async () => {
  const { session } = newSession({ reply: '' });
  await session.connect();
  const warnings = [];
  session.on('warning', (w) => warnings.push(w));
  await session.sendText('hi');
  assert.equal(warnings.length, 0);
});

// ───────────────────────── errors ─────────────────────────

test('a pre-stream client-variables 403 (defensive remap) surfaces as typed client_variables_disabled; session stays usable', async () => {
  const fetch = fakeFetch([{
    match: '/assistant/converse',
    respond: (req) => req.body.request_vars
      ? { status: 403, body: { detail: 'Client variables are not allowed for this agent' } }
      : { body: REPLY },
  }]);
  const { session } = newSession({ fetch, cfg: { requestVars: { user_name: 'Dana' } } });
  await session.connect();
  const errors = [];
  session.on('error', (e) => errors.push(e));
  await assert.rejects(() => session.sendText('hi'), (e) => e.code === 'client_variables_disabled');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'client_variables_disabled');
  assert.equal(session.state, 'connected', 'a failed turn must not kill the session');
});

test('a scope 403 passes through untouched (not mislabeled as a variables problem)', async () => {
  const fetch = fakeFetch([{ match: '/assistant/converse', respond: () => ({ status: 403, body: { detail: 'KS scope mismatch' } }) }]);
  const { session } = newSession({ fetch });
  await session.connect();
  await assert.rejects(() => session.sendText('hi'), (e) => e.status === 403 && e.code !== 'client_variables_disabled');
});

/** A fetch that never resolves until its signal aborts; reports when the request is in flight. */
function hangingFetch() {
  let started;
  const inFlight = new Promise((r) => { started = r; });
  const fetch = (url, init) => new Promise((_, reject) => {
    started();
    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (init.signal.aborted) abort();
    else init.signal.addEventListener('abort', abort, { once: true });
  });
  return { fetch, inFlight };
}

test('disconnect mid-turn aborts the in-flight request without an error re-emit', async () => {
  const { fetch, inFlight } = hangingFetch();
  const { session } = newSession({ fetch });
  await session.connect();
  const errors = [];
  session.on('error', (e) => errors.push(e));
  const turn = session.sendText('hi');
  await inFlight;
  session.disconnect();
  await assert.rejects(() => turn, (e) => e.code === 'aborted');
  assert.equal(errors.length, 0, 'a turn killed by our own disconnect is not an error event');
});

test('caller AbortSignal cancels the turn', async () => {
  const { fetch, inFlight } = hangingFetch();
  const { session } = newSession({ fetch });
  await session.connect();
  const ac = new AbortController();
  const turn = session.sendText('hi', { signal: ac.signal });
  await inFlight;
  ac.abort();
  await assert.rejects(() => turn, (e) => e.code === 'aborted');
});

// ───────────────────────── tool calls ─────────────────────────

const TOOL_TURN = [
  seg({ type: 'think', content: '', threadId: 't-1', messageId: 'm-1' }),
  seg({ type: 'tool', content: 'echo_check {"probe":"ZX41"}', tool_metadata: { id: 'inv-9', wait_for_response: true, type: 'client' } }),
  seg({ type: 'text', content: 'Verified.' }),
].join('\n') + '\n';

test('waitForResponse loop: toolCall dispatched mid-stream, respondToTool ACKs over HTTP with the same KS', async () => {
  const fetch = fakeFetch([
    { match: '/assistant/tool_response', respond: () => ({ body: {} }) },
    { match: '/assistant/converse', respond: () => ({ body: TOOL_TURN }) },
  ]);
  const { session } = newSession({ fetch });
  await session.connect();
  const acks = [];
  session.onToolCall('echo_check', async (args, call) => {
    // ACK from inside the handler, mid-stream — the KalturaChatSession contract.
    acks.push(await session.respondToTool(call.toolMetadata.id, { verified: `OK-${args.probe}` }));
  });
  const r = await session.sendText('probe ZX41');
  assert.equal(r.text, 'Verified.');
  assert.deepEqual(acks, [{ ok: true }]);
  const ack = fetch.calls.find((c) => c.url.endsWith('/assistant/tool_response'));
  assert.equal(ack.headers.authorization, `KS ${CONV_KS}`);
  assert.deepEqual(ack.body, { tool_name: 'echo_check', tool_id: 'inv-9', tool_invocation_id: 'inv-9', response: { verified: 'OK-ZX41' } });
});

test('respondToTool degrades gracefully on unknown/stale ids and validates input', async () => {
  let t = 1_000;
  const fetch = fakeFetch([
    { match: '/assistant/tool_response', respond: () => ({ body: {} }) },
    { match: '/assistant/converse', respond: () => ({ body: TOOL_TURN }) },
  ]);
  const session = new KalturaChatSession({ token: CONV_KS, fetch, now: () => t });
  await session.connect();
  await assert.rejects(() => session.respondToTool('', {}), (e) => e.code === 'bad_request');
  await assert.rejects(() => session.respondToTool('inv-9', ['not', 'a', 'dict']), (e) => e.code === 'bad_request');
  assert.deepEqual(await session.respondToTool('never-seen', { a: 1 }), { ok: false, reason: 'unknown_or_stale' });
  await session.sendText('probe');   // registers pending ack inv-9
  t += 11 * 60_000;                  // older than PENDING_TOOL_ACK_MAX_AGE_MS
  assert.deepEqual(await session.respondToTool('inv-9', { a: 1 }), { ok: false, reason: 'unknown_or_stale' });
});

test('semantic dedup within a turn, reset across turns; argsSchema gates dispatch', async () => {
  const DUP_TURN = [
    seg({ type: 'tool', content: 'go {"n":1}' }),
    seg({ type: 'tool', content: 'go {"n":1}' }),     // identical → deduped
    seg({ type: 'tool', content: 'go {"n":"bad"}' }), // schema-invalid
    seg({ type: 'text', content: 'ok' }),
  ].join('\n') + '\n';
  const { session } = newSession({ reply: DUP_TURN });
  await session.connect();
  const fired = [], invalid = [];
  session.on('toolCallInvalid', (p) => invalid.push(p));
  session.onToolCall('go', (args) => fired.push(args), { n: { type: 'int', required: true } });
  await session.sendText('turn 1');
  assert.deepEqual(fired, [{ n: 1 }]);
  assert.equal(invalid.length, 1);
  await session.sendText('turn 2');   // dedup state resets per turn
  assert.deepEqual(fired, [{ n: 1 }, { n: 1 }]);
});

test('fused multi-tool segment: earlier blob recovered via the tool_response name pairing', async () => {
  const FUSED_TURN = [
    seg({ type: 'tool', content: 'open_filing {"quarter":"q1"}{"metric":"revenue"}' }),
    seg({ type: 'tool_response', content: 'show_chart responded with size 120' }),
    seg({ type: 'text', content: 'done' }),
  ].join('\n') + '\n';
  const { session } = newSession({ reply: FUSED_TURN });
  await session.connect();
  const calls = [];
  session.on('toolCall', (c) => calls.push(c.name));
  await session.sendText('go');
  assert.deepEqual(calls, ['open_filing', 'show_chart']);
});

test('a throwing handler is isolated: toolCallResult ok:false, turn still completes', async () => {
  const { session } = newSession({ reply: TOOL_TURN });
  await session.connect();
  const results = [];
  session.on('toolCallResult', (p) => results.push(p.ok));
  session.onToolCall('echo_check', () => { throw new Error('boom'); });
  const r = await session.sendText('probe');
  assert.equal(r.text, 'Verified.');
  assert.deepEqual(results, [false]);
});

test('onToolCall unsubscribe removes the handler and its schema', async () => {
  const { session } = newSession({ reply: TOOL_TURN });
  await session.connect();
  const fired = [];
  const off = session.onToolCall('echo_check', () => fired.push(1));
  off();
  await session.sendText('probe');
  assert.equal(fired.length, 0);
});

// ───────────────────────── brain-liveness watchdog (peer of session.js's R5) ─────────────────────────

/** A ReadableStream that enqueues each chunk after its own delay, then closes — for exercising real-time gaps between segments. */
function timedStream(chunks) {
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        if (c.delayMs) await new Promise((r) => setTimeout(r, c.delayMs));
        controller.enqueue(new TextEncoder().encode(c.text));
      }
      controller.close();
    },
  });
}
function timedFetch(chunks) {
  return async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '', body: timedStream(chunks) });
}

test('a bare keepalive does not settle "thinking", and a keepalive-only gap past brainStallMs surfaces brainStalled', async () => {
  const fetch = timedFetch([
    { delayMs: 0, text: seg({ type: 'keepalive', content: '' }) + '\n' },
    { delayMs: 130, text: seg({ type: 'keepalive', content: '' }) + '\n' },   // past brainStallMs (100) with no progress
    { delayMs: 130, text: seg({ type: 'text', content: 'Still here.' }) + '\n' },
  ]);
  const { session } = newSession({ fetch, cfg: { brainStallMs: 100 } });
  await session.connect();
  const pendingEvents = [];
  session.on('responsePending', () => pendingEvents.push('pending'));
  session.on('responseSettled', () => pendingEvents.push('settled'));
  const stalls = [];
  session.on('brainStalled', (p) => stalls.push(p));
  const r = await session.sendText('hi');
  assert.equal(r.text, 'Still here.');
  assert.deepEqual(pendingEvents, ['pending', 'settled'], 'keepalives must not settle "thinking" early — only the real text segment does');
  assert.ok(stalls.length >= 1, `a keepalive-only gap past brainStallMs must surface brainStalled (got ${stalls.length})`);
  assert.equal(stalls[0].afterMs, 100);
});

test('brain watchdog: REPEATS on sustained keepalive-only traffic, and spoken output clears it', async () => {
  const fetch = timedFetch([
    { delayMs: 0, text: '' },   // stream opens with no data yet
    { delayMs: 260, text: seg({ type: 'text', content: 'Done.' }) + '\n' },   // spans ~2-3 windows of 100ms
  ]);
  const { session } = newSession({ fetch, cfg: { brainStallMs: 100 } });
  await session.connect();
  const stalls = [];
  session.on('brainStalled', (p) => stalls.push(p));
  const r = await session.sendText('hi');
  assert.equal(r.text, 'Done.');
  assert.ok(stalls.length >= 2, `watchdog must repeat while nothing perceivable arrives (got ${stalls.length})`);
  assert.deepEqual(stalls.map((s) => s.count), stalls.map((_, i) => i + 1), 'count must increment each repeat');
  // Real text cleared the watchdog before the turn ended — no further fires after the reply.
  const countAtReply = stalls.length;
  await new Promise((r2) => setTimeout(r2, 250));
  assert.equal(stalls.length, countAtReply, 'spoken output must cancel the watchdog, not just the turn end');
});

test('a tool-only segment does not clear the watchdog (tool spirals still surface brainStalled)', async () => {
  const fetch = timedFetch([
    { delayMs: 0, text: seg({ type: 'tool', content: 'go {"n":1}' }) + '\n' },
    { delayMs: 150, text: seg({ type: 'text', content: 'ok' }) + '\n' },
  ]);
  const { session } = newSession({ fetch, cfg: { brainStallMs: 100 } });
  await session.connect();
  const stalls = [];
  session.on('brainStalled', (p) => stalls.push(p));
  session.onToolCall('go', () => {});
  const r = await session.sendText('hi');
  assert.equal(r.text, 'ok');
  assert.ok(stalls.length >= 1, 'a tool segment must not clear the watchdog before real output arrives');
});
