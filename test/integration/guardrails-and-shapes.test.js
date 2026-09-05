import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { Management } from '../../src/management/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia } from '../fakes/rtc.js';
import { fakeFetch } from '../fakes/fetch.js';

/**
 * Coverage closing the audit gaps (#9/#10/#11/#14):
 *  - #9  session-level guardrail GATE (agentActions policy + onAgentAction hook):
 *        a vetoed agent action emits NO brainSegment and DOES emit agentActionDenied.
 *  - #10 speak() guardrails: onBeforeSend transform/block + maxTurnsPerMinute valve,
 *        driven through the real speak() path with the injectable clock (cfg.now).
 *  - #11 conversation resource REQUEST shapes (rename/delete/transcript/share/list/
 *        feedback/followups/mcp-search) — a field-name typo would ship undetected.
 *  - #14 intellectConfig facade tool-linkage setter setToolIds.
 */

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const ADMIN = 'djJ8' + Buffer.from('v2|123|disableentitlement').toString('base64url');

/** Build a connected session with optional guardrail config. */
async function connect(cfg = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl: new FakeVideoEl(),
    socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: async () => ({ ok: true, status: 201, text: async () => 'a', headers: { get: () => 'loc' } }),
    getUserMedia: fakeGetUserMedia(), ...cfg,
  });
  scriptHappyPath(socket);
  await session.connect();
  return { session, socket };
}

/** A render-genui brain segment as the server streams it (JSON in agent_raw_text.delta). */
function genuiDelta() {
  return { delta: JSON.stringify({ type: 'flashcards-tool', metadata: { runtimeName: 'flashcards-tool', widgetName: 'unisphere.widget.genie' }, content: 'q1' }) };
}

// ─────────────────────────── #9 session-level guardrail gate ───────────────────────────

test('#9 agentActions policy {genui:false} DROPS the render-genui segment (no brainSegment) and fires agentActionDenied', async () => {
  const { session, socket } = await connect({ agentActions: { genui: false } });
  /** @type {string[]} */ const seen = [];
  let denied = null;
  session.on('brainSegment', (d) => seen.push(d.type));
  session.on('agentActionDenied', (e) => { denied = e; });

  socket.server('agent_raw_text', genuiDelta());

  assert.equal(denied?.type, 'render-genui', 'agentActionDenied fired for the vetoed action');
  assert.ok(!seen.includes('flashcards-tool'), 'the vetoed GenUI segment never reached brainSegment');
});

test('#9 onAgentAction hook returning false vetoes the action (no brainSegment); returning true allows it', async () => {
  // veto
  const v = await connect({ onAgentAction: () => false });
  const allowed = [];
  v.session.on('brainSegment', (d) => allowed.push(d.type));
  v.session.server = undefined;
  v.socket.server('agent_raw_text', genuiDelta());
  assert.ok(!allowed.includes('flashcards-tool'), 'onAgentAction:false blocks the segment');

  // allow (default-allow when the hook returns anything but false)
  const a = await connect({ onAgentAction: () => true });
  const got = [];
  a.session.on('brainSegment', (d) => got.push(d.type));
  a.socket.server('agent_raw_text', genuiDelta());
  await Promise.resolve(); // flush the async _gateAgentAction microtask
  assert.ok(got.includes('flashcards-tool'), 'onAgentAction:true lets the segment through');
});

test('#9 with NO policy/hook configured, GenUI flows untouched (default-allow — no behavior change)', async () => {
  const { session, socket } = await connect();
  const got = [];
  session.on('brainSegment', (d) => got.push(d.type));
  socket.server('agent_raw_text', genuiDelta());
  assert.ok(got.includes('flashcards-tool'), 'default-allow keeps GenUI flowing for apps that never opt in');
});

// ─────────────────────────── #10 speak() guardrails ───────────────────────────

test('#10 onBeforeSend TRANSFORM rewrites the onTextEntered payload', async () => {
  const { session, socket } = await connect({ onBeforeSend: (t) => t.replace(/secret/gi, '[redacted]') });
  await session.speak('tell me the secret');
  const sent = socket.emitsOf('onTextEntered').pop();
  assert.match(JSON.stringify(sent), /\[redacted\]/);
  assert.ok(!JSON.stringify(sent).match(/secret/i), 'the raw text was transformed before the wire');
});

test('#10 onBeforeSend returning false BLOCKS speak() (guardrail_blocked) and emits no socket text', async () => {
  const { session, socket } = await connect({ onBeforeSend: () => false });
  const before = socket.emitsOf('onTextEntered').length;
  await assert.rejects(() => session.speak('blocked please'), (e) => e.code === 'guardrail_blocked');
  assert.equal(socket.emitsOf('onTextEntered').length, before, 'no text emitted when blocked');
});

test('#10 maxTurnsPerMinute valve: the (N+1)th speak() within 60s rejects rate_limited (injectable clock)', async () => {
  let clock = 1_000_000;
  const { session } = await connect({ maxTurnsPerMinute: 2, now: () => clock });
  await session.speak('one');
  await session.speak('two');
  await assert.rejects(() => session.speak('three'), (e) => e.code === 'rate_limited', 'the 3rd turn in the window is throttled');
  // advance past the 60s window → allowed again
  clock += 61_000;
  await session.speak('four (new window)');
});

// ─────────────────────────── #11 conversation resource request shapes ───────────────────────────

test('#11 conversation resource methods send the EXACT documented request bodies', async () => {
  const seen = {};
  const cap = (k) => (req) => { seen[k] = { body: req.body, url: req.url }; return { body: {} }; };
  const f = fakeFetch([
    { match: 'v1/thread/list', respond: (req) => { seen.list = { body: req.body }; return { body: { objects: [], totalCount: 0 } }; } },
    { match: 'v1/thread/update', respond: (req) => { seen.rename = { body: req.body }; return { body: { id: req.body.id } }; } },
    { match: 'v1/thread/delete', respond: cap('delete') },
    { match: 'v1/thread/get_transcripts', respond: cap('transcript') },
    { match: 'message/share', respond: (req) => { seen.share = { body: req.body }; return { body: { newMessageId: 'm2' } }; } },
    { match: 'message/list', respond: (req) => { seen.messages = { body: req.body }; return { body: { objects: [], totalCount: 0 } }; } },
    { match: 'feedback/add', respond: (req) => { seen.feedback = { body: req.body }; return { body: { id: 'f1' } }; } },
    { match: 'followup/get-suggested-questions', respond: cap('followups') },
    { match: 'mcp/search', respond: (req) => { seen.mcp = { body: req.body }; return { body: { results: [] } }; } },
  ]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const TID = 't-1', MID = 'm-1';

  await m.threads.list(ADMIN).all();                                 // paginated → .all() drains one page
  await m.threads.rename(TID, 'New title', ADMIN);
  await m.threads.delete([TID], ADMIN, { confirmPermanent: true });
  await m.threads.transcript(TID, ADMIN);
  await m.messages.share(MID, 'Shared', ADMIN);
  await m.messages.list(ADMIN, { threadId: TID }).all();             // paginated → .all() drains one page
  await m.feedback.add({ message_id: MID, is_positive: true }, CONV_KS);
  await m.followups.getSuggested(CONV_KS);
  await m.knowledge.search('q', ADMIN);

  // v1/thread/list filter — NO "Genie" prefix ('GenieListThreadFilter' 422s)
  assert.equal(seen.list.body.filter.objectType, 'ListThreadFilter');
  // thread/update {id,title}
  assert.equal(seen.rename.body.id, TID);
  assert.equal(seen.rename.body.title, 'New title');
  // thread/delete {thread_ids:[...]} (plural)
  assert.deepEqual(seen.delete.body.thread_ids, [TID]);
  // v1/thread/get_transcripts {id}
  assert.equal(seen.transcript.body.id, TID);
  // message/share {id,newTitle}
  assert.equal(seen.share.body.id, MID);
  assert.equal(seen.share.body.newTitle, 'Shared');
  // message/list filter carries the thread filter
  assert.equal(seen.messages.body.filter.threadIdEquals, TID);
  // feedback/add {schemaVersion:1, data:{is_positive, message_id}}
  assert.equal(seen.feedback.body.schemaVersion, 1);
  assert.equal(seen.feedback.body.data.is_positive, true);
  assert.equal(seen.feedback.body.data.message_id, MID);
  // followup/get-suggested-questions?new_response=true
  assert.match(seen.followups.url, /new_response=true/);
  // mcp/search {query}
  assert.equal(seen.mcp.body.query, 'q');
});

// ─────────────────────────── client-side command dispatch (onToolCall) ───────────────────────────

/** A native tool-call brain segment as the server streams it (type:"tool", content "name {json}"). */
function toolDelta(content) { return { delta: JSON.stringify({ type: 'tool', content }) }; }

test('onToolCall(name) handler receives parsed args + a toolCall event fires', async () => {
  const { session, socket } = await connect();
  /** @type {object[]} */ const calls = [];
  /** @type {object[]} */ const events = [];
  const off = session.onToolCall('navigate_to_slide', (args, call) => calls.push({ args, call }));
  session.on('toolCall', (c) => events.push(c));

  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": 4}'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.slide_num, 4);
  assert.equal(calls[0].call.name, 'navigate_to_slide');
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'navigate_to_slide');

  // unsubscribe stops further dispatch
  off();
  socket.server('agent_start_speech', { speechId: 's2', isNewTurn: true });   // new turn (clears dedup)
  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": 9}'));
  assert.equal(calls.length, 1, 'unsubscribed handler no longer fires');
  assert.equal(events.length, 2, 'the broad toolCall event still fires');
});

test('onToolCall dedups within a turn but re-fires after turnStart', async () => {
  const { session, socket } = await connect();
  const seen = [];
  session.onToolCall('navigate_to_slide', ({ slide_num }) => seen.push(slide_num));

  // same call arrives twice in one turn → fires once
  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": 4}'));
  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": 4}'));
  assert.deepEqual(seen, [4]);

  // new turn resets dedup → same call fires again
  socket.server('agent_start_speech', { speechId: 's2', isNewTurn: true });
  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": 4}'));
  assert.deepEqual(seen, [4, 4]);
});

test('REGRESSION: dedup is semantic, not byte-string — differently-key-ordered JSON for the same call collapses to one dispatch', async () => {
  // The LLM can emit the same logical tool call twice with non-deterministic JSON key
  // order (e.g. {"reason":"resume","slide_num":18} then {"slide_num":18,"reason":"resume"}).
  // Byte-string dedup on the raw wire content lets both through; semantic dedup on
  // {name, canonicalized args} must not.
  const { session, socket } = await connect();
  const seen = [];
  session.onToolCall('navigate_to_slide', (args) => seen.push(args));

  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"reason": "resume", "slide_num": 18}'));
  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": 18, "reason": "resume"}'));
  assert.equal(seen.length, 1, 'the second call is a semantic duplicate of the first — must be deduped despite different key order');

  // A genuinely different call (different args) in the same turn must still dispatch.
  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": 4}'));
  assert.equal(seen.length, 2, 'a call with different args is not a duplicate');
});

test('agentActions.toolCall allow-list blocks a non-listed command (no dispatch, fires agentActionDenied)', async () => {
  const { session, socket } = await connect({ agentActions: { toolCall: ['navigate_to_slide'] } });
  const fired = [];
  let denied = null;
  session.on('toolCall', (c) => fired.push(c.name));
  session.on('agentActionDenied', (e) => { denied = e; });

  socket.server('agent_raw_text', toolDelta('drop_database {"all": true}'));
  assert.equal(fired.length, 0, 'non-allow-listed command never dispatches');
  assert.equal(denied?.type, 'tool-call');

  // an allow-listed command still flows
  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": 2}'));
  await Promise.resolve(); // flush the async _gateAgentAction microtask
  assert.deepEqual(fired, ['navigate_to_slide']);
});

test('agentActions.toolCall:false blocks ALL client commands', async () => {
  const { session, socket } = await connect({ agentActions: { toolCall: false } });
  const fired = [];
  session.on('toolCall', (c) => fired.push(c.name));
  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": 2}'));
  assert.equal(fired.length, 0);
});

test('a throwing onToolCall handler is isolated — other handlers still run', async () => {
  const { session, socket } = await connect();
  const ran = [];
  session.onToolCall('x', () => { throw new Error('boom'); });
  session.onToolCall('x', () => ran.push('second'));
  socket.server('agent_raw_text', toolDelta('x {"a":1}'));
  assert.deepEqual(ran, ['second']);
});

// ───────────────────── fused multi-tool segment recovery ─────────────────────
// Live capture: a two-tool turn (highlight_chart + open_filing) streamed as ONE type:"tool"
// segment naming only "open_filing", with highlight_chart's args concatenated ahead of it.
// Before the fix, highlight_chart's client-side action was silently lost while the server
// still executed both tools and the brain narrated success. Recovery pairs the queued
// (un-attributed) blob with the tool_response name that follows.

/** A tool_response segment as the server streams it. */
function toolResponseDelta(content) { return { delta: JSON.stringify({ type: 'tool_response', content }) }; }

const LIVE_FUSED_CONTENT = 'open_filing {"quarters": ["q1_2025", "q2_2025", "q3_2025", "q4_2025", "q1_2026"], "metric": "total_revenue"}{"quarter": "q1_2026", "docType": "press_release"}';

test('fused segment: the un-named earlier tool (highlight_chart) still dispatches, recovered from the tool_response echo', async () => {
  const { session, socket } = await connect();
  /** @type {object[]} */ const events = [];
  session.onToolCall('highlight_chart', (args) => events.push({ name: 'highlight_chart', args }));
  session.onToolCall('open_filing', (args) => events.push({ name: 'open_filing', args }));

  socket.server('agent_raw_text', toolDelta(LIVE_FUSED_CONTENT));
  // The named tool (open_filing) always dispatches immediately with its own real args.
  assert.deepEqual(events, [{ name: 'open_filing', args: { quarter: 'q1_2026', docType: 'press_release' } }]);

  // Server-side echoes stream next, in call order — highlight_chart's echo is the recovery signal.
  socket.server('agent_raw_text', toolResponseDelta('highlight_chart responded with size 113'));
  socket.server('agent_raw_text', toolResponseDelta('open_filing responded with size 104'));

  assert.equal(events.length, 2, 'highlight_chart now dispatches too — no client-side action lost');
  assert.equal(events[1].name, 'highlight_chart');
  assert.deepEqual(events[1].args, { quarters: ['q1_2025', 'q2_2025', 'q3_2025', 'q4_2025', 'q1_2026'], metric: 'total_revenue' });
});

test('fused segment: a tool_response echo for the ALREADY-dispatched named tool is not re-recovered as a second call', async () => {
  const { session, socket } = await connect();
  const calls = [];
  session.onToolCall('open_filing', (args) => calls.push(args));

  socket.server('agent_raw_text', toolDelta('open_filing {"a":1}{"quarter":"q1_2026","docType":"press_release"}'));
  assert.equal(calls.length, 1);
  // open_filing's own echo arrives first (server dispatch order isn't guaranteed to match
  // the fused string's blob order) — it must not consume the pending blob meant for the
  // OTHER tool, since open_filing already fired this turn.
  socket.server('agent_raw_text', toolResponseDelta('open_filing responded with size 104'));
  assert.equal(calls.length, 1, 'open_filing does not re-dispatch from its own echo');
});

test('fused segment: recovery state is turn-scoped — a stray tool_response next turn recovers nothing', async () => {
  const { session, socket } = await connect();
  const calls = [];
  session.onToolCall('highlight_chart', (args) => calls.push(args));
  session.onToolCall('open_filing', () => {});

  socket.server('agent_raw_text', toolDelta(LIVE_FUSED_CONTENT));
  socket.server('agent_start_speech', { speechId: 'next-turn', isNewTurn: true });   // new turn clears pending blobs
  socket.server('agent_raw_text', toolResponseDelta('highlight_chart responded with size 113'));

  assert.equal(calls.length, 0, 'a fused blob queued last turn is not recovered into a new turn');
});

test('non-fused calls are unaffected: a plain tool_response with no pending blobs is a no-op', async () => {
  const { session, socket } = await connect();
  const calls = [];
  session.onToolCall('navigate_to_slide', (args) => calls.push(args));

  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": 4}'));
  socket.server('agent_raw_text', toolResponseDelta('navigate_to_slide responded with size 10'));

  assert.deepEqual(calls, [{ slide_num: 4 }], 'exactly one dispatch — the response echo added nothing');
});

test('a name dispatched directly in one ASR sub-turn does not block that same name\'s fused recovery in the NEXT sub-turn of the same turn', async () => {
  const { session, socket } = await connect();
  const calls = [];
  session.onToolCall('navigate_to_slide', (args) => calls.push(args));
  session.onToolCall('highlight_chart', () => {});

  // Sub-turn 1 (isNewTurn:true): navigate_to_slide dispatches directly, named in its own segment.
  socket.server('agent_start_speech', { speechId: 's1', turnId: 't1', isNewTurn: true });
  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": 4}'));
  assert.deepEqual(calls, [{ slide_num: 4 }]);

  // Sub-turn 2 of the SAME turnId (isNewTurn:false, e.g. a tap-to-talk duplicate speechId):
  // a fresh fused segment names highlight_chart but concatenates navigate_to_slide's NEW
  // args ahead of it. Before the fix, `_turnDispatchedToolNames` from sub-turn 1 was never
  // cleared on an isNewTurn:false start, so the tool_response echo below would be skipped
  // as "already dispatched" — even though this is a genuinely new call with new args.
  socket.server('agent_start_speech', { speechId: 's2', turnId: 't1', isNewTurn: false });
  socket.server('agent_raw_text', toolDelta('highlight_chart {"slide_num": 7}{"metric": "total_revenue", "quarters": ["q1_2026"]}'));
  socket.server('agent_raw_text', toolResponseDelta('navigate_to_slide responded with size 10'));
  socket.server('agent_raw_text', toolResponseDelta('highlight_chart responded with size 20'));

  assert.deepEqual(calls, [{ slide_num: 4 }, { slide_num: 7 }], 'sub-turn 2\'s fused navigate_to_slide recovers instead of being dropped');
});

// ─────────────────────────── toolCallResult (local ack) ───────────────────────────

test('a handler returning a value emits toolCallResult {ok:true, value}', async () => {
  const { session, socket } = await connect();
  const results = [];
  session.on('toolCallResult', (r) => results.push(r));
  session.onToolCall('navigate_to_slide', () => ({ ok: true, slide: 4 }));

  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": 4}'));

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.deepEqual(results[0].value, { ok: true, slide: 4 });
  assert.equal(results[0].call.name, 'navigate_to_slide');
});

test('a handler returning undefined emits no toolCallResult (no regression for existing handlers)', async () => {
  const { session, socket } = await connect();
  const results = [];
  session.on('toolCallResult', (r) => results.push(r));
  session.onToolCall('navigate_to_slide', () => { /* no return */ });

  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": 4}'));

  assert.equal(results.length, 0);
});

test('a throwing handler emits toolCallResult {ok:false, error} in addition to being isolated', async () => {
  const { session, socket } = await connect();
  const results = [];
  const ran = [];
  session.on('toolCallResult', (r) => results.push(r));
  session.onToolCall('x', () => { throw new Error('boom'); });
  session.onToolCall('x', () => { ran.push('second'); });

  socket.server('agent_raw_text', toolDelta('x {"a":1}'));

  assert.deepEqual(ran, ['second'], 'other handlers still run');
  assert.equal(results.length, 1, 'only the throwing handler produced a result');
  assert.equal(results[0].ok, false);
  assert.match(results[0].error.message, /boom/);
});

test('an async handler that resolves a value emits toolCallResult after settling', async () => {
  const { session, socket } = await connect();
  const results = [];
  session.on('toolCallResult', (r) => results.push(r));
  session.onToolCall('save_note', async () => { await Promise.resolve(); return { saved: true }; });

  socket.server('agent_raw_text', toolDelta('save_note {"text":"hi"}'));
  assert.equal(results.length, 0, 'not yet settled synchronously');
  await Promise.resolve(); await Promise.resolve();

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.deepEqual(results[0].value, { saved: true });
});

test('an async handler that rejects emits toolCallResult {ok:false, error}', async () => {
  const { session, socket } = await connect();
  const results = [];
  session.on('toolCallResult', (r) => results.push(r));
  session.onToolCall('save_note', async () => { throw new Error('network down'); });

  socket.server('agent_raw_text', toolDelta('save_note {"text":"hi"}'));
  await Promise.resolve(); await Promise.resolve();

  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error.message, /network down/);
});

test('an async handler that resolves undefined emits no toolCallResult', async () => {
  const { session, socket } = await connect();
  const results = [];
  session.on('toolCallResult', (r) => results.push(r));
  session.onToolCall('save_note', async () => { await Promise.resolve(); });

  socket.server('agent_raw_text', toolDelta('save_note {"text":"hi"}'));
  await Promise.resolve(); await Promise.resolve();

  assert.equal(results.length, 0);
});

// ─────────────────────────── dispatch-time arg validation ───────────────────────────

test('onToolCall(name, handler, argsSchema) — a mismatched call never invokes the handler, emits toolCallInvalid instead of toolCall', async () => {
  const { session, socket } = await connect();
  const calls = []; const toolCallEvents = []; const invalid = [];
  session.onToolCall('navigate_to_slide', (args) => calls.push(args), { slide_num: { type: 'int', required: true } });
  session.on('toolCall', (c) => toolCallEvents.push(c));
  session.on('toolCallInvalid', (e) => invalid.push(e));

  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": "not-an-int"}'));

  assert.equal(calls.length, 0, 'the handler never runs on bad args');
  assert.equal(toolCallEvents.length, 0, 'no toolCall event for an invalid call');
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].call.name, 'navigate_to_slide');
  assert.match(invalid[0].errors[0], /must be of type int/);
});

test('a valid call still dispatches normally with a schema registered', async () => {
  const { session, socket } = await connect();
  const calls = []; const invalid = [];
  session.onToolCall('navigate_to_slide', (args) => calls.push(args), { slide_num: { type: 'int', required: true } });
  session.on('toolCallInvalid', (e) => invalid.push(e));

  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": 4}'));

  assert.deepEqual(calls, [{ slide_num: 4 }]);
  assert.equal(invalid.length, 0);
});

test('no schema passed → existing behavior unchanged (regression guard)', async () => {
  const { session, socket } = await connect();
  const calls = []; const invalid = [];
  session.onToolCall('navigate_to_slide', (args) => calls.push(args));   // no 3rd arg
  session.on('toolCallInvalid', (e) => invalid.push(e));

  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": "whatever"}'));

  assert.equal(calls.length, 1, 'no schema registered means no validation, handler still runs');
  assert.equal(invalid.length, 0);
});

test('an invalid call is still deduped within the turn (a retried bad call fires toolCallInvalid once)', async () => {
  const { session, socket } = await connect();
  const invalid = [];
  session.onToolCall('navigate_to_slide', () => {}, { slide_num: { type: 'int', required: true } });
  session.on('toolCallInvalid', (e) => invalid.push(e));

  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": "bad"}'));
  socket.server('agent_raw_text', toolDelta('navigate_to_slide {"slide_num": "bad"}'));   // identical retry, same turn

  assert.equal(invalid.length, 1);
});

test('enum mismatch is rejected the same way as a type mismatch', async () => {
  const { session, socket } = await connect();
  const calls = []; const invalid = [];
  session.onToolCall('set_track', (args) => calls.push(args), { track: { type: 'str', enum: ['business', 'developer'] } });
  session.on('toolCallInvalid', (e) => invalid.push(e));

  socket.server('agent_raw_text', toolDelta('set_track {"track": "finance"}'));
  assert.equal(calls.length, 0);
  assert.equal(invalid.length, 1);
  assert.match(invalid[0].errors[0], /must be one of/);

  socket.server('agent_start_speech', { speechId: 's2', isNewTurn: true });   // new turn (clears dedup)
  socket.server('agent_raw_text', toolDelta('set_track {"track": "developer"}'));
  assert.deepEqual(calls, [{ track: 'developer' }]);
});

// ─────────────────────────── respondToTool (wire ACK) ───────────────────────────

/** A native tool-call segment carrying wire tool_metadata (a `waitForResponse:true` client tool). */
function toolDeltaWithMetadata(content, id) {
  return { delta: JSON.stringify({ type: 'tool', content, tool_metadata: { id, wait_for_response: true, type: 'client' } }) };
}

test('respondToTool POSTs the ACK with the tracked tool name + clears the pending entry', async () => {
  const seen = [];
  const f = fakeFetch([
    { match: '/rtc/v1/whep/', respond: () => ({ status: 201, body: 'a', headers: { location: 'loc' } }) },
    { match: '/assistant/tool_response', respond: (req) => { seen.push(req); return { body: {} }; } },
  ]);
  const { session, socket } = await connect({ fetch: f });
  const calls = [];
  session.onToolCall('ask_user_to_pick_a_slide', (args, call) => calls.push(call));

  socket.server('agent_raw_text', toolDeltaWithMetadata('ask_user_to_pick_a_slide {}', 'req-1'));
  assert.equal(calls[0].toolMetadata.id, 'req-1');

  const r = await session.respondToTool('req-1', { slide: 4 });
  assert.deepEqual(r, { ok: true });
  assert.equal(seen[0].body.tool_name, 'ask_user_to_pick_a_slide');
  assert.equal(seen[0].body.tool_id, 'req-1');
  assert.deepEqual(seen[0].body.response, { slide: 4 });
  assert.match(seen[0].headers.authorization, /^KS /);

  // a second ACK for the same (now-resolved) id degrades gracefully rather than double-POSTing
  const r2 = await session.respondToTool('req-1', { slide: 4 });
  assert.deepEqual(r2, { ok: false, reason: 'unknown_or_stale' });
  assert.equal(seen.length, 1, 'no second POST for an already-resolved id');
});

test('respondToTool on an unknown id degrades gracefully — no throw, no network call', async () => {
  const f = fakeFetch([
    { match: '/rtc/v1/whep/', respond: () => ({ status: 201, body: 'a', headers: { location: 'loc' } }) },
    { match: '/assistant/tool_response', respond: () => { throw new Error('must not be called'); } },
  ]);
  const { session } = await connect({ fetch: f });
  const r = await session.respondToTool('never-issued', { ok: true });
  assert.deepEqual(r, { ok: false, reason: 'unknown_or_stale' });
});

test('respondToTool: a cold reconnect mid-flight resolves session_rebuilt instead of a false ok:true', async () => {
  // The gap: a cold reconnect that fires while
  // respondToTool()'s POST is still in flight discards the server-side session the ACK
  // targeted — the caller must learn the ACK didn't really land, not get a false ok:true.
  let sawToolPost = false;
  let releaseAck;
  const ackGate = new Promise((res) => { releaseAck = res; });
  const f = async (url) => {
    const u = String(url);
    if (u.includes('/assistant/tool_response')) { sawToolPost = true; await ackGate; }
    return { ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/r/1' } };
  };
  const { session, socket } = await connect({ fetch: f });
  session.onToolCall('ask_user_to_pick_a_slide', () => {});
  socket.server('agent_raw_text', toolDeltaWithMetadata('ask_user_to_pick_a_slide {}', 'req-1'));

  const ackCall = session.respondToTool('req-1', { slide: 1 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sawToolPost, true, 'the ACK POST must already be in flight');

  const reconnectDone = session._coldReconnect('media asr failed');   // bumps _sessionGen synchronously
  releaseAck();   // let the stalled POST resolve now that the session has moved on

  const r = await ackCall;
  assert.deepEqual(r, { ok: false, reason: 'session_rebuilt' }, 'a stale in-flight ACK must not report ok:true');

  await reconnectDone;
  assert.equal(session.state, 'connected', 'the cold reconnect itself still completes cleanly');
  session.disconnect();
});

test('a pending ACK older than the max age degrades to unknown_or_stale (bounds the Map even with no disconnect)', async () => {
  let clock = 1_000_000;
  const f = fakeFetch([
    { match: '/rtc/v1/whep/', respond: () => ({ status: 201, body: 'a', headers: { location: 'loc' } }) },
    { match: '/assistant/tool_response', respond: () => { throw new Error('must not be called — entry should be swept as stale'); } },
  ]);
  const { session, socket } = await connect({ fetch: f, now: () => clock });

  socket.server('agent_raw_text', toolDeltaWithMetadata('ask_user_to_pick_a_slide {}', 'req-old'));
  assert.equal(session._pendingToolAcks.has('req-old'), true);

  clock += 11 * 60_000;   // past PENDING_TOOL_ACK_MAX_AGE_MS (10 min)
  const r = await session.respondToTool('req-old', { slide: 1 });
  assert.deepEqual(r, { ok: false, reason: 'unknown_or_stale' });
  assert.equal(session._pendingToolAcks.has('req-old'), false, 'the stale entry is evicted, not retained');
});

test('a fresh waitForResponse dispatch sweeps stale sibling entries out of the pending-ACK Map', async () => {
  let clock = 1_000_000;
  const { session, socket } = await connect({ now: () => clock });

  socket.server('agent_raw_text', toolDeltaWithMetadata('ask_user_to_pick_a_slide {}', 'req-old'));
  assert.equal(session._pendingToolAcks.size, 1);

  clock += 11 * 60_000;   // the first entry is now stale
  socket.server('agent_start_speech', { speechId: 's2', isNewTurn: true });   // new turn (clears the dedup, not the ack map)
  socket.server('agent_raw_text', toolDeltaWithMetadata('ask_user_to_pick_a_slide {}', 'req-new'));

  assert.equal(session._pendingToolAcks.has('req-old'), false, 'stale entry swept when a new one is added');
  assert.equal(session._pendingToolAcks.has('req-new'), true);
  assert.equal(session._pendingToolAcks.size, 1, 'the Map never grows unbounded across a long session');
});

// ─────────────────────────── #14 facade tool linkage ───────────────────────────

test('#14 intellectConfig.setToolIds writes the tool_ids reference list via patch/read-merge-write', async () => {
  const seen = [];
  const f = fakeFetch([
    { match: 'v1/intellect/get', respond: () => ({ body: { id: 7, type: 'internal', status: 2, tool_ids: [] } }) },
    { match: 'v1/intellect/update', respond: (req) => { seen.push(req.body); return { body: { id: 7 } }; } },
  ]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const ic = m.intellectConfig;

  // setToolIds writes the plain reference array — tool bodies live on the separate mgmt.tools entity.
  const r = await ic.setToolIds(7, ['tool-1'], ADMIN);
  assert.equal(r.applied, true);
  assert.ok(seen.some((b) => Array.isArray(b.tool_ids) && b.tool_ids.includes('tool-1')), 'setToolIds wrote tool_ids via update');

  // rejects a bad id array BEFORE any network.
  seen.length = 0;
  await assert.rejects(() => ic.setToolIds(7, [123], ADMIN), (e) => e.code === 'bad_request');
  assert.equal(seen.length, 0, 'no write when validation fails');
});
