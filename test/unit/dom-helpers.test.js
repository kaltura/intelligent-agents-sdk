import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cssToken } from '../../src/experience/genui/renderers/dom-helpers.js';

/** cssToken — slugify a string into a safe CSS class/token fragment. Pure, no DOM. */

test('cssToken lowercases, replaces disallowed runs with a single dash, and trims leading/trailing dashes', () => {
  assert.equal(cssToken('--Hello World!!--'), 'hello-world');
  assert.equal(cssToken('a-b-c'), 'a-b-c');
  assert.equal(cssToken('Already_Fine-123'), 'already_fine-123');
});

test('cssToken never returns an empty token', () => {
  assert.equal(cssToken(''), 'x');
  assert.equal(cssToken('-----'), 'x');
  assert.equal(cssToken('!!!'), 'x');
  assert.equal(cssToken(null), 'x');
  assert.equal(cssToken(undefined), 'x');
});
