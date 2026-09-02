import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUserPropertiesForms } from '../../src/management/intellect-config.js';

/**
 * PURE unit tests for {@link buildUserPropertiesForms}. No network.
 */

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
