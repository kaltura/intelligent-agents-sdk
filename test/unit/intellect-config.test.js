import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUserPropertiesForms, EDITABLE_FIELDS, SKILL_MODES, MODEL_IDS, THINKING_LEVELS, SUMMARY_CONTENT_TYPES, CALL_STAGES,
} from '../../src/management/intellect-config.js';
import * as mgmt from '../../src/management/index.js';

/**
 * PURE unit tests for {@link buildUserPropertiesForms} and the exported enums. No network.
 */

// ───────────────────────── exported enums ─────────────────────────

test('EDITABLE_FIELDS is the frozen 20-key customer-writable surface', () => {
  assert.ok(Object.isFrozen(EDITABLE_FIELDS));
  assert.equal(EDITABLE_FIELDS.length, 20);
  assert.deepEqual([...EDITABLE_FIELDS].sort(), [
    'allow_client_variables', 'avatar_summary_config', 'base_directive', 'capabilities', 'description',
    'force_language', 'glossary', 'knowledge_ids', 'mcp_servers', 'model_configuration', 'name',
    'opening_phrase', 'prompts', 'secrets', 'skill_ids', 'status', 'tags', 'thread_start_tools',
    'tool_ids', 'user_properties_forms',
  ]);
  assert.ok(!EDITABLE_FIELDS.includes('type'), 'type is immutable, not editable');
});

test('SKILL_MODES / THINKING_LEVELS / SUMMARY_CONTENT_TYPES / CALL_STAGES are frozen with exact values', () => {
  for (const e of [SKILL_MODES, THINKING_LEVELS, SUMMARY_CONTENT_TYPES, CALL_STAGES, MODEL_IDS]) assert.ok(Object.isFrozen(e));
  assert.deepEqual([...SKILL_MODES], ['adhoc', 'adhoc-save', 'preloaded']);
  assert.deepEqual([...THINKING_LEVELS], ['low', 'high']);
  assert.deepEqual([...SUMMARY_CONTENT_TYPES], ['text', 'html', 'html_with_js']);
  assert.deepEqual([...CALL_STAGES], ['start', 'middle', 'end']);
});

test('MODEL_IDS lists the nine selectable model ids (Claude Sonnet/Haiku us+eu, Gemini)', () => {
  assert.deepEqual([...MODEL_IDS], [
    'us.anthropic.claude-sonnet-4-20250514-v1:0',
    'eu.anthropic.claude-sonnet-4-20250514-v1:0',
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
  ]);
  assert.equal(new Set(MODEL_IDS).size, MODEL_IDS.length, 'no duplicates');
});

test('the management entry point re-exports every enum', () => {
  assert.equal(mgmt.EDITABLE_FIELDS, EDITABLE_FIELDS);
  assert.equal(mgmt.SKILL_MODES, SKILL_MODES);
  assert.equal(mgmt.MODEL_IDS, MODEL_IDS);
  assert.equal(mgmt.THINKING_LEVELS, THINKING_LEVELS);
  assert.equal(mgmt.SUMMARY_CONTENT_TYPES, SUMMARY_CONTENT_TYPES);
  assert.equal(mgmt.CALL_STAGES, CALL_STAGES);
});

// ───────────────────────── buildUserPropertiesForms ─────────────────────────

test('buildUserPropertiesForms builds the LIST wire shape and accepts callStage or call_stage', () => {
  // The server 422s a bare dict ("Input should be a valid list") — the wire shape
  // MUST be a list of forms, confirmed on a scratch intellect.
  const a = buildUserPropertiesForms([{ callStage: 'middle', properties: [{ key: 'email', type: 'str' }] }]);
  assert.deepEqual(a, [{ call_stage: 'middle', properties: [{ key: 'email', type: 'str' }] }]);
  const b = buildUserPropertiesForms([{ call_stage: 'end', properties: [{ key: 'name' }] }]);
  assert.equal(b[0].call_stage, 'end');
  assert.equal(b[0].properties[0].type, 'str'); // defaulted
});

test('buildUserPropertiesForms wraps a single form object into a one-element list', () => {
  const a = buildUserPropertiesForms({ callStage: 'start', properties: [{ key: 'email' }] });
  assert.ok(Array.isArray(a));
  assert.equal(a.length, 1);
  assert.equal(a[0].call_stage, 'start');
});

test('buildUserPropertiesForms builds multiple forms (one per call stage)', () => {
  const a = buildUserPropertiesForms([
    { callStage: 'start', properties: [{ key: 'name' }] },
    { callStage: 'end', properties: [{ key: 'email', type: 'str' }] },
  ]);
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((f) => f.call_stage), ['start', 'end']);
});

test('buildUserPropertiesForms: bad stage → bad_request', () => {
  assert.throws(() => buildUserPropertiesForms([{ callStage: 'whenever', properties: [{ key: 'x' }] }]), (e) => e.code === 'bad_request');
});

test('buildUserPropertiesForms: empty forms list → bad_request', () => {
  assert.throws(() => buildUserPropertiesForms([]), (e) => e.code === 'bad_request');
});

test('buildUserPropertiesForms: empty properties → bad_request', () => {
  assert.throws(() => buildUserPropertiesForms([{ callStage: 'start', properties: [] }]), (e) => e.code === 'bad_request');
});

test('buildUserPropertiesForms: bad property type → bad_request', () => {
  assert.throws(() => buildUserPropertiesForms([{ callStage: 'start', properties: [{ key: 'x', type: 'number' }] }]), (e) => e.code === 'bad_request');
});
