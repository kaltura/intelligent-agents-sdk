import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConverseStream,
  collectConverse,
  segmentKind,
  parseToolCall,
  parseToolResponseName,
  validateToolArgs,
  GENUI_RUNTIMES,
} from '../../src/core/stream.js';
import { streamFrom, streamFromChunks } from '../fakes/fetch.js';

const NDJSON = [
  '{"type":"think","content":"","threadId":"t1","messageId":"m1"}',
  '{"type":"text","content":"Hello "}',
  '{"type":"text","content":"world"}',
  '{"type":"unisphere-tool","content":{"a":1},"metadata":{"runtimeName":"flashcards-tool"}}',
  '{"type":"share","content":{"canShare":true},"segmentStart":true,"segmentEnd":true,"isFinal":true}',
].join('\n') + '\n';

test('parses NDJSON into segments', async () => {
  const segs = [];
  for await (const s of parseConverseStream(streamFrom(NDJSON))) segs.push(s);
  assert.equal(segs.length, 5);
  assert.equal(segs[1].content, 'Hello ');
});

test('collectConverse assembles text + thread/message + experiences', async () => {
  const r = await collectConverse(parseConverseStream(streamFrom(NDJSON)));
  assert.equal(r.text, 'Hello world');
  assert.equal(r.threadId, 't1');
  assert.equal(r.messageId, 'm1');
  assert.ok(r.experiences['flashcards-tool']);
  assert.equal(r.segments.length, 5);
});

test('segmentKind truth table', () => {
  assert.equal(segmentKind({ type: 'text' }), 'spoken');
  assert.equal(segmentKind({ type: 'avatar' }), 'spoken');
  assert.equal(segmentKind({ type: 'avatar-filler' }), 'spoken');
  assert.equal(segmentKind({ type: 'unisphere-tool' }), 'experience');
  assert.equal(segmentKind({ type: 'error' }), 'error');
  assert.equal(segmentKind({ type: 'think' }), 'control');
  assert.equal(segmentKind({ type: 'tool' }), 'control');
  assert.equal(segmentKind({ type: 'tool_response' }), 'control');
  assert.equal(segmentKind({ type: 'share' }), 'control');
  assert.equal(segmentKind({ type: 'thread' }), 'control');
  assert.equal(segmentKind({ type: 'totally-unknown' }), 'control');
  // odd / missing input never throws → control
  assert.equal(segmentKind({}), 'control');
  assert.equal(segmentKind(undefined), 'control');
  assert.equal(segmentKind(null), 'control');
});

test('parseToolCall parses a type:"tool" segment into {name,args,raw}', () => {
  const c = parseToolCall({ type: 'tool', content: 'navigate_to_slide {"slide_num": 4}' });
  assert.equal(c.name, 'navigate_to_slide');
  assert.deepEqual(c.args, { slide_num: 4 });
  assert.equal(c.raw, 'navigate_to_slide {"slide_num": 4}');
});

test('parseToolCall: no-args tool → args {}', () => {
  const c = parseToolCall({ type: 'tool', content: 'refresh_page' });
  assert.equal(c.name, 'refresh_page');
  assert.deepEqual(c.args, {});
});

test('parseToolCall: malformed json args → {name, args:{}} (never throws)', () => {
  const c = parseToolCall({ type: 'tool', content: 'call_page_function {not json' });
  assert.equal(c.name, 'call_page_function');
  assert.deepEqual(c.args, {});
});

test('parseToolCall: non-tool / odd input → null', () => {
  assert.equal(parseToolCall({ type: 'text', content: 'hi' }), null);
  assert.equal(parseToolCall({ type: 'tool_response', content: 'x responded' }), null);
  assert.equal(parseToolCall({ type: 'tool', content: '' }), null);
  assert.equal(parseToolCall({ type: 'tool' }), null);
  assert.equal(parseToolCall(null), null);
  assert.equal(parseToolCall(undefined), null);
});

test('parseToolCall: only a JSON OBJECT is read as args (a bare array is left in args:{})', () => {
  // Real tool args are always a JSON object. A `{`-prefixed array-ish payload that
  // does not parse to a plain object leaves args empty rather than mis-binding.
  const c = parseToolCall({ type: 'tool', content: 'foo {"items":[1,2,3]}' });
  assert.equal(c.name, 'foo');
  assert.deepEqual(c.args, { items: [1, 2, 3] });
});

// ─────────────────────────── fused multi-tool segments (live-verified) ───────────────────────────
// A brain turn that calls 2+ tools can arrive as ONE type:"tool" segment naming only the
// LAST tool, with earlier tools' arg objects concatenated into the same content string —
// e.g. captured live: `open_filing {"quarters":[...],"metric":"total_revenue"}{"quarter":"q1_2026","docType":"press_release"}`.
// Before this fix, JSON.parse on the whole tail failed (SyntaxError: multiple JSON roots),
// so `catch{}` silently dropped BOTH blobs and the printed tool dispatched with args:{}.

const FUSED_CONTENT = 'open_filing {"quarters": ["q1_2025", "q2_2025", "q3_2025", "q4_2025", "q1_2026"], "metric": "total_revenue"}{"quarter": "q1_2026", "docType": "press_release"}';

test('parseToolCall: a fused multi-tool segment recovers the NAMED tool\'s own args (the last blob), not {}', () => {
  const c = parseToolCall({ type: 'tool', content: FUSED_CONTENT });
  assert.equal(c.name, 'open_filing');
  assert.deepEqual(c.args, { quarter: 'q1_2026', docType: 'press_release' });
});

test('parseToolCall: earlier blobs in a fused segment surface as fusedArgs, in arrival order', () => {
  const c = parseToolCall({ type: 'tool', content: FUSED_CONTENT });
  assert.equal(c.fusedArgs.length, 1);
  assert.deepEqual(c.fusedArgs[0], { quarters: ['q1_2025', 'q2_2025', 'q3_2025', 'q4_2025', 'q1_2026'], metric: 'total_revenue' });
});

test('parseToolCall: a single-object (non-fused) call never gets a fusedArgs field', () => {
  const c = parseToolCall({ type: 'tool', content: 'navigate_to_slide {"slide_num": 4}' });
  assert.equal('fusedArgs' in c, false);
});

test('parseToolCall: three fused blobs recover all as fusedArgs (2) + the named tool\'s own args (last)', () => {
  const content = 'open_filing {"a":1}{"b":2}{"quarter":"q1_2026","docType":"press_release"}';
  const c = parseToolCall({ type: 'tool', content });
  assert.deepEqual(c.args, { quarter: 'q1_2026', docType: 'press_release' });
  assert.deepEqual(c.fusedArgs, [{ a: 1 }, { b: 2 }]);
});

test('parseToolCall: a brace inside a quoted string value does not miscount fused-object boundaries', () => {
  const content = 'show_widget {"text":"note: { still one object }"}{"quarter":"q1_2026","docType":"press_release"}';
  const c = parseToolCall({ type: 'tool', content });
  assert.deepEqual(c.args, { quarter: 'q1_2026', docType: 'press_release' });
  assert.deepEqual(c.fusedArgs, [{ text: 'note: { still one object }' }]);
});

test('parseToolCall: tool_metadata.args on a fused segment (verbatim wire echo) never breaks toolMetadata lifting', () => {
  const c = parseToolCall({ type: 'tool', content: FUSED_CONTENT, tool_metadata: { id: 'req-1', name: 'open_filing', args: FUSED_CONTENT, type: 'api', wait_for_response: true } });
  assert.deepEqual(c.toolMetadata, { id: 'req-1', waitForResponse: true, type: 'api' });
  assert.equal(c.name, 'open_filing');
});

test('parseToolResponseName: extracts the tool name from "<name> responded with size <n>"', () => {
  assert.equal(parseToolResponseName({ type: 'tool_response', content: 'highlight_chart responded with size 113' }), 'highlight_chart');
  assert.equal(parseToolResponseName({ type: 'tool_response', content: 'open_filing responded with size 104' }), 'open_filing');
});

test('parseToolResponseName: non-matching / non-tool_response input → null (never throws)', () => {
  assert.equal(parseToolResponseName({ type: 'tool_response', content: '' }), null);
  assert.equal(parseToolResponseName({ type: 'tool_response' }), null);
  assert.equal(parseToolResponseName({ type: 'tool', content: 'open_filing responded with size 104' }), null);
  assert.equal(parseToolResponseName(null), null);
  assert.equal(parseToolResponseName(undefined), null);
});

test('parseToolCall lifts tool_metadata (issue #31 rule 5.2/gap 2)', () => {
  const c = parseToolCall({
    type: 'tool', content: 'navigate_to_slide {"slide_num": 4}',
    tool_metadata: { id: 'req-1', name: 'navigate_to_slide', args: { slide_num: 4 }, type: 'client', wait_for_response: true },
  });
  assert.deepEqual(c.toolMetadata, { id: 'req-1', waitForResponse: true, type: 'client' });
});

test('parseToolCall: no tool_metadata on the segment → toolMetadata absent, not synthesized', () => {
  const c = parseToolCall({ type: 'tool', content: 'navigate_to_slide {"slide_num": 4}' });
  assert.equal('toolMetadata' in c, false);
});

test('parseToolCall: malformed/partial tool_metadata (no string id) is dropped, never half-populated', () => {
  assert.equal('toolMetadata' in parseToolCall({ type: 'tool', content: 'x {}', tool_metadata: {} }), false);
  assert.equal('toolMetadata' in parseToolCall({ type: 'tool', content: 'x {}', tool_metadata: { id: 7 } }), false);
  assert.equal('toolMetadata' in parseToolCall({ type: 'tool', content: 'x {}', tool_metadata: null }), false);
});

test('collectConverse surfaces toolCalls[] in arrival order', async () => {
  const ndjson = [
    '{"type":"text","content":"ok"}',
    '{"type":"tool","content":"navigate_to_slide {\\"slide_num\\": 11}"}',
    '{"type":"tool_response","content":"navigate_to_slide responded with size 12"}',
    '{"type":"tool","content":"create_slide {\\"title\\": \\"New\\"}"}',
  ].join('\n') + '\n';
  const r = await collectConverse(parseConverseStream(streamFrom(ndjson)));
  assert.equal(r.toolCalls.length, 2);
  assert.equal(r.toolCalls[0].name, 'navigate_to_slide');
  assert.equal(r.toolCalls[0].args.slide_num, 11);
  assert.equal(r.toolCalls[1].name, 'create_slide');
  assert.equal(r.toolCalls[1].args.title, 'New');
});

test('collectConverse tool-spiral guard: dedups, caps per-tool, stops a runaway early', async () => {
  // Build NDJSON safely via JSON.stringify (no hand-escaping). A tool-eager brain loops
  // show_widget 20× (the observed runaway) after one good flashcards call.
  const seg = (type, content) => JSON.stringify({ type, content });
  const lines = [seg('text', 'here is a quiz'), seg('tool', 'show_widget {"kind":"flashcards","data":"{}"}')];
  for (let i = 0; i < 20; i++) lines.push(seg('tool', `show_widget {"kind":"followups","data":"{\\"q\\":${i}}"}`));
  const ndjson = lines.join('\n') + '\n';
  const r = await collectConverse(parseConverseStream(streamFrom(ndjson)));
  assert.equal(r.spiralStopped, true, 'spiral detected + stopped');
  assert.ok(r.toolCalls.length <= 3, `capped tool calls (got ${r.toolCalls.length})`);
  assert.equal(r.toolCalls[0].name, 'show_widget');         // the good first call survives
  assert.ok(r.text.includes('quiz'), 'spoken text still captured');
  // back-compat: a normal turn is unaffected
  const normNd = [seg('tool', 'navigate_to_slide {"slide_num":2}'), seg('tool', 'set_track {"track":"developer"}')].join('\n') + '\n';
  const norm = await collectConverse(parseConverseStream(streamFrom(normNd)));
  assert.equal(norm.spiralStopped, false);
  assert.equal(norm.toolCalls.length, 2);
  // disabling the cap restores raw collection (all 21 tool calls)
  const raw = await collectConverse(parseConverseStream(streamFrom(ndjson)), { maxToolCalls: Infinity, maxPerTool: Infinity });
  assert.equal(raw.spiralStopped, false);
  assert.equal(raw.toolCalls.length, 21);
});

test('collectConverse tool-spiral guard caps DISTINCT valid tool calls too, not just dupes/invalid ones', async () => {
  // N+1 unique, valid, under-per-tool-cap tool-call segments with maxToolCalls:N must
  // stop at N — the guard's own JSDoc promises "STOPS reading the stream once a spiral
  // threshold is crossed (maxToolCalls)" with no carve-out for all-distinct streams.
  // (Regression test: the original compound condition `rawToolSegments > toolCalls.length`
  // never held for an all-unique-valid run, since every accepted call increments both
  // counters 1:1 — so the guard silently never fired for this case.)
  const seg = (type, content) => JSON.stringify({ type, content });
  const N = 5;
  const lines = [];
  for (let i = 0; i < N + 1; i++) lines.push(seg('tool', `set_track {"track":"t${i}"}`));
  const ndjson = lines.join('\n') + '\n';
  const r = await collectConverse(parseConverseStream(streamFrom(ndjson)), { maxToolCalls: N, maxPerTool: Infinity });
  assert.equal(r.spiralStopped, true, 'spiral guard fires even with zero dupes/invalid calls');
  assert.equal(r.toolCalls.length, N, `capped at maxToolCalls=${N} (got ${r.toolCalls.length})`);
});

// ─────────────────────────── issue #24: validateToolArgs ───────────────────────────

test('validateToolArgs: no schema (or non-object) never blocks', () => {
  assert.deepEqual(validateToolArgs({ slide_num: 'not-an-int' }, undefined), { ok: true });
  assert.deepEqual(validateToolArgs({ slide_num: 'not-an-int' }, null), { ok: true });
  assert.deepEqual(validateToolArgs({}, 'not-an-object'), { ok: true });
});

test('validateToolArgs: type check catches a bare string where an int was declared', () => {
  const r = validateToolArgs({ slide_num: '4' }, { slide_num: { type: 'int', required: true } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /"slide_num" must be of type int/);
});

test('validateToolArgs: a well-typed value passes for every declared ARG_TYPE', () => {
  const schema = {
    a: { type: 'str' }, b: { type: 'int' }, c: { type: 'float' },
    d: { type: 'bool' }, e: { type: 'list' }, f: { type: 'dict' },
  };
  const r = validateToolArgs({ a: 'x', b: 4, c: 4.5, d: true, e: [1], f: { k: 1 } }, schema);
  assert.deepEqual(r, { ok: true });
});

test('validateToolArgs: required catches a missing key', () => {
  const r = validateToolArgs({}, { title: { type: 'str', required: true } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /"title" is required/);
});

test('validateToolArgs: a missing optional key is fine', () => {
  const r = validateToolArgs({}, { title: { type: 'str' } });
  assert.deepEqual(r, { ok: true });
});

test('validateToolArgs: enum rejects a value outside the closed set', () => {
  const r = validateToolArgs({ track: 'finance' }, { track: { type: 'str', enum: ['business', 'developer'] } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /"track" must be one of/);
});

test('validateToolArgs: enum accepts a member of the closed set', () => {
  const r = validateToolArgs({ track: 'business' }, { track: { type: 'str', enum: ['business', 'developer'] } });
  assert.deepEqual(r, { ok: true });
});

test('validateToolArgs: collects multiple errors across keys, never throws', () => {
  const r = validateToolArgs({ slide_num: 'x' }, { slide_num: { type: 'int' }, title: { type: 'str', required: true } });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
});

test('collectConverse: toolArgSchemas diverts a mismatched call to toolCallsInvalid, not toolCalls', async () => {
  const ndjson = [
    '{"type":"tool","content":"navigate_to_slide {\\"slide_num\\": \\"nope\\"}"}',
    '{"type":"tool","content":"navigate_to_slide {\\"slide_num\\": 4}"}',
  ].join('\n') + '\n';
  const r = await collectConverse(parseConverseStream(streamFrom(ndjson)), {
    toolArgSchemas: { navigate_to_slide: { slide_num: { type: 'int', required: true } } },
  });
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].args.slide_num, 4);
  assert.equal(r.toolCallsInvalid.length, 1);
  assert.equal(r.toolCallsInvalid[0].call.args.slide_num, 'nope');
  assert.match(r.toolCallsInvalid[0].errors[0], /must be of type int/);
});

test('collectConverse: no toolArgSchemas → toolCallsInvalid is always empty (no behavior change)', async () => {
  const ndjson = '{"type":"tool","content":"navigate_to_slide {\\"slide_num\\": \\"nope\\"}"}\n';
  const r = await collectConverse(parseConverseStream(streamFrom(ndjson)));
  assert.deepEqual(r.toolCallsInvalid, []);
  assert.equal(r.toolCalls.length, 1, 'unrecognized tool name in schema map still passes through unchanged');
});

test('GENUI_RUNTIMES is the 9 wire-form (-tool) runtime names, frozen', () => {
  assert.equal(GENUI_RUNTIMES.length, 9);
  assert.ok(GENUI_RUNTIMES.includes('flashcards-tool'));
  assert.ok(GENUI_RUNTIMES.every((n) => n.endsWith('-tool')));
  assert.ok(Object.isFrozen(GENUI_RUNTIMES));
});

test('collectConverse adds _meta/experiencesList/kindCounts without breaking back-compat shape', async () => {
  const r = await collectConverse(parseConverseStream(streamFrom(NDJSON)));
  // back-compat: original shape unchanged
  assert.equal(r.text, 'Hello world');
  assert.equal(r.threadId, 't1');
  assert.equal(r.messageId, 'm1');
  assert.equal(r.segments.length, 5);
  assert.ok(r.experiences['flashcards-tool']);
  // additive: _meta receipt
  assert.equal(r._meta.source, 'sdk/core/stream');
  assert.match(r._meta.generatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.ok(r._meta.scope);
  // additive: experiencesList is the flat array of unisphere-tool segments
  assert.equal(r.experiencesList.length, 1);
  assert.equal(r.experiencesList[0], r.experiences['flashcards-tool'][0]);
  // additive: kindCounts tally (think=control, 2×text=spoken, 1 experience, share=control)
  assert.deepEqual(r.kindCounts, { spoken: 2, control: 2, experience: 1, error: 0 });
});

test('collectConverse kindCounts tallies error segments', async () => {
  const ndjson = [
    '{"type":"text","content":"hi"}',
    '{"type":"error","content":"boom"}',
  ].join('\n') + '\n';
  const r = await collectConverse(parseConverseStream(streamFrom(ndjson)));
  assert.equal(r.kindCounts.error, 1);
  assert.equal(r.kindCounts.spoken, 1);
  // error content is NOT spoken text
  assert.equal(r.text, 'hi');
});

test('parses SSE (data: prefixed) lines', async () => {
  const sse = 'data: {"type":"text","content":"hi"}\n\ndata: [DONE]\n';
  const r = await collectConverse(parseConverseStream(streamFrom(sse), { sse: true }));
  assert.equal(r.text, 'hi');
});

test('tolerates split chunks across reads', async () => {
  const chunks = ['{"type":"text","con', 'tent":"abc"}\n{"type":"text","content":"def"}\n'];
  const r = await collectConverse(parseConverseStream(streamFromChunks(chunks)));
  assert.equal(r.text, 'abcdef');
});

test('accumulates avatar-type spoken segments (avatar:on intellect), not control types', async () => {
  // On an avatar-enabled intellect the spoken content arrives as `avatar` segments
  // (WIRE-PROTOCOL §4e), interleaved with control types that must NOT be in `text`.
  const ndjson = [
    '{"type":"think","content":"…"}',
    '{"type":"tool_response","content":"get_experience_instructions responded"}',
    '{"type":"avatar","content":"Total revenue "}',
    '{"type":"avatar-filler","content":"for "}',
    '{"type":"avatar","content":"Q1 was $44.6 million."}',
    '{"type":"share","content":{"canShare":true}}',
  ].join('\n') + '\n';
  const r = await collectConverse(parseConverseStream(streamFrom(ndjson)));
  assert.equal(r.text, 'Total revenue for Q1 was $44.6 million.');
});

test('skips malformed lines without throwing', async () => {
  const bad = '{"type":"text","content":"ok"}\nNOT JSON\n{"type":"text","content":"!"}\n';
  const r = await collectConverse(parseConverseStream(streamFrom(bad)));
  assert.equal(r.text, 'ok!');
});
