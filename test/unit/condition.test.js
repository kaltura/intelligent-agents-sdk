import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionProblem, assertCondition } from '../../src/management/condition.js';

/** Condition expression guard (PURE). */

test('conditionProblem accepts bare expressions', () => {
  for (const ok of ['sys__avatar_enabled', 'not sys__avatar_enabled', "plan == 'pro' and sys__avatar_enabled", 'x > 1']) {
    assert.equal(conditionProblem(ok), null, ok);
  }
});

test('conditionProblem rejects template delimiters, empty and non-string values', () => {
  for (const bad of ['{{ sys__avatar_enabled }}', '{{x}}', '{% if x %}1{% endif %}', '{# note #} x']) {
    assert.match(conditionProblem(bad), /bare expression/, bad);
  }
  for (const bad of ['', '   ', 5, {}, [], true]) {
    assert.match(conditionProblem(bad), /non-empty expression string/, String(bad));
  }
});

test('assertCondition returns the expression or throws bad_request naming the field', () => {
  assert.equal(assertCondition('sys__avatar_enabled', 'f'), 'sys__avatar_enabled');
  assert.throws(() => assertCondition('{{ a }}', 'skill.condition'), (e) => e.code === 'bad_request' && e.detail.startsWith('skill.condition must be a bare expression'));
});
