import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SILENT_OPENING, isSilentOpening } from '../../src/core/opening.js';
import * as management from '../../src/management/index.js';
import * as experience from '../../src/experience/index.js';

test('SILENT_OPENING is the SSML silence tag', () => {
  assert.equal(SILENT_OPENING, '<blank>');
});

test('isSilentOpening matches the tag, tolerating surrounding whitespace only', () => {
  assert.equal(isSilentOpening('<blank>'), true);
  assert.equal(isSilentOpening('  <blank>\n'), true);
  assert.equal(isSilentOpening(SILENT_OPENING), true);
  assert.equal(isSilentOpening('Hello!'), false);
  assert.equal(isSilentOpening('<blank> hi'), false);
  assert.equal(isSilentOpening(''), false);
  assert.equal(isSilentOpening(undefined), false);
  assert.equal(isSilentOpening(null), false);
  assert.equal(isSilentOpening(42), false);
});

test('SILENT_OPENING and isSilentOpening are exported from both entry points', () => {
  assert.equal(management.SILENT_OPENING, SILENT_OPENING);
  assert.equal(management.isSilentOpening, isSilentOpening);
  assert.equal(experience.SILENT_OPENING, SILENT_OPENING);
  assert.equal(experience.isSilentOpening, isSilentOpening);
});
