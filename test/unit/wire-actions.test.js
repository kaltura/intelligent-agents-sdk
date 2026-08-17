import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAgentAction, modelTypeWire, MODEL_TYPES } from '../../src/experience/wire.js';

/**
 * classifyAgentAction — maps a streamed brain segment to the AGENT-initiated
 * action the guardrail gate operates on. Asserted over the REAL adapter-normalized
 * type strings (trailing `-tool`) and `metadata.runtimeName` (NOT a top-level field).
 */

test('spoken/control/empty segments are NOT actions (default-allow flow)', () => {
  assert.equal(classifyAgentAction({ type: 'text', content: 'hello' }), null);
  assert.equal(classifyAgentAction({ type: 'avatar', content: 'hi' }), null);
  assert.equal(classifyAgentAction({ type: 'avatar-filler', content: '…' }), null);
  assert.equal(classifyAgentAction({ type: 'think' }), null);
  assert.equal(classifyAgentAction(null), null);
  assert.equal(classifyAgentAction('nope'), null);
  assert.equal(classifyAgentAction({}), null);
});

test('sources / followups classify as render-genui and are NOT a distinct vetoable type', () => {
  // Real segments carry runtime in metadata.runtimeName + a `-tool` typed segment.
  const sources = classifyAgentAction({ type: 'sources-tool', metadata: { runtimeName: 'sources-tool', widgetName: 'unisphere.widget.genie' }, content: { items: [] } });
  assert.equal(sources.type, 'render-genui');
  assert.equal(sources.runtime, 'sources');
  const followups = classifyAgentAction({ type: 'followups-tool', metadata: { runtimeName: 'followups-tool' } });
  assert.equal(followups.type, 'render-genui');
  assert.equal(followups.runtime, 'followups');
});

test('the GenUI runtimes all classify as render-genui (except user-properties-form)', () => {
  for (const rt of ['flashcards', 'summarization', 'show-link', 'content-gallery', 'external-video']) {
    const a = classifyAgentAction({ type: `${rt}-tool`, metadata: { runtimeName: `${rt}-tool` } });
    assert.equal(a.type, 'render-genui', rt);
    assert.equal(a.runtime, rt);
  }
});

test('user-properties-form classifies as structured-data-form', () => {
  const a = classifyAgentAction({ type: 'user-properties-form-tool', metadata: { runtimeName: 'user-properties-form-tool' } });
  assert.equal(a.type, 'structured-data-form');
  assert.equal(a.runtime, 'user-properties-form');
});

test('reads metadata.runtimeName even when seg.type is generic (CM-adapter shape)', () => {
  const a = classifyAgentAction({ type: 'unisphere-tool', metadata: { runtimeName: 'flashcards-tool', widgetName: 'unisphere.widget.genie' }, content: 'x' });
  assert.equal(a.type, 'render-genui');
  assert.equal(a.runtime, 'flashcards');
  assert.equal(a.widgetName, 'unisphere.widget.genie');
});

test('navigate is SYNTHETIC (no real typed nav segment) — classified only for the fixture', () => {
  const a = classifyAgentAction({ type: 'navigate', content: { to: 24 } });
  assert.equal(a.type, 'navigate');
  assert.equal(a.runtime, 'navigate');
  assert.deepEqual(a.payload, { to: 24 });
});

test('a native tool call carrying tool_metadata surfaces toolMetadata on the payload (issue #31 gap 2, for respondToTool)', () => {
  const a = classifyAgentAction({
    type: 'tool', content: 'navigate_to_slide {"slide_num": 4}',
    tool_metadata: { id: 'req-1', name: 'navigate_to_slide', wait_for_response: true, type: 'client' },
  });
  assert.equal(a.type, 'tool-call');
  assert.deepEqual(a.payload.toolMetadata, { id: 'req-1', waitForResponse: true, type: 'client' });
});

test('a native tool call classifies as tool-call with the tool name as runtime + parsed payload', () => {
  const a = classifyAgentAction({ type: 'tool', content: 'navigate_to_slide {"slide_num": 4}' });
  assert.equal(a.type, 'tool-call');
  assert.equal(a.runtime, 'navigate_to_slide');
  assert.equal(a.runtimeName, 'navigate_to_slide');
  assert.equal(a.payload.name, 'navigate_to_slide');
  assert.deepEqual(a.payload.args, { slide_num: 4 });
});

test('an empty/odd tool segment is NOT an action', () => {
  assert.equal(classifyAgentAction({ type: 'tool', content: '' }), null);
  assert.equal(classifyAgentAction({ type: 'tool' }), null);
  // tool_response is the post-execution echo, not a call → not an action
  assert.equal(classifyAgentAction({ type: 'tool_response', content: 'x responded' }), null);
});

// ── MODEL_TYPES / modelTypeWire ──
test('MODEL_TYPES: fast is lowercase, primary is the omit sentinel (null) — no DEFAULT', () => {
  assert.equal(MODEL_TYPES.fast, 'fast');
  assert.equal(MODEL_TYPES.primary, null);
  assert.equal('DEFAULT' in MODEL_TYPES, false);
});

test('modelTypeWire: fast (any case) → "fast"; primary/default/empty → omit (undefined)', () => {
  assert.equal(modelTypeWire('fast'), 'fast');
  assert.equal(modelTypeWire('FAST'), 'fast');
  assert.equal(modelTypeWire(' Fast '), 'fast');
  assert.equal(modelTypeWire('primary'), undefined);
  assert.equal(modelTypeWire('default'), undefined);
  assert.equal(modelTypeWire(''), undefined);
  assert.equal(modelTypeWire(null), undefined);
  assert.equal(modelTypeWire(undefined), undefined);
});
