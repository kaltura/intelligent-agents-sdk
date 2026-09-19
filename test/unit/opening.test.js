import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SILENT_OPENING, SILENT_OPENING_LABEL, isSilentOpening } from '../../src/core/opening.js';
import * as management from '../../src/management/index.js';
import * as experience from '../../src/experience/index.js';

test('SILENT_OPENING is the silent phrase; SILENT_OPENING_LABEL is what a UI shows for it', () => {
  assert.equal(SILENT_OPENING, '<blank>');
  assert.equal(SILENT_OPENING_LABEL, '[silence]');
});

test('isSilentOpening matches the phrase, tolerating surrounding whitespace only', () => {
  assert.equal(isSilentOpening('<blank>'), true);
  assert.equal(isSilentOpening('  <blank>\n'), true);
  assert.equal(isSilentOpening(SILENT_OPENING), true);
  assert.equal(isSilentOpening('Hello!'), false);
  assert.equal(isSilentOpening('<blank> hi'), false);
  assert.equal(isSilentOpening(SILENT_OPENING_LABEL), false);
  assert.equal(isSilentOpening(''), false);
  assert.equal(isSilentOpening(undefined), false);
  assert.equal(isSilentOpening(null), false);
  assert.equal(isSilentOpening(42), false);
});

test('SILENT_OPENING, SILENT_OPENING_LABEL and isSilentOpening are exported from both entry points', () => {
  for (const entry of [management, experience]) {
    assert.equal(entry.SILENT_OPENING, SILENT_OPENING);
    assert.equal(entry.SILENT_OPENING_LABEL, SILENT_OPENING_LABEL);
    assert.equal(entry.isSilentOpening, isSilentOpening);
  }
});
