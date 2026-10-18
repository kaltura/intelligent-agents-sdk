import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionProblem, assertCondition, assertPromptConditions, conditionWarnings, stripQuoted } from '../../src/management/condition.js';

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

test('assertPromptConditions throws bad_request naming the call and block index', () => {
  const blocks = [{ key: 'a' }, { key: 'b', condition: '{{ x }}' }];
  assert.throws(() => assertPromptConditions(blocks, 'intellects.update'), (e) => e.code === 'bad_request' && e.detail.startsWith('intellects.update: prompts[1].condition must be a bare expression'));
});

test('assertPromptConditions leaves unset conditions and non-arrays alone', () => {
  assert.doesNotThrow(() => assertPromptConditions([{ key: 'a' }, { key: 'b', condition: null }, { key: 'c', condition: undefined }, null], 'f'));
  assert.doesNotThrow(() => assertPromptConditions(undefined, 'f'));
  assert.doesNotThrow(() => assertPromptConditions('x', 'f'));
  assert.throws(() => assertPromptConditions([{ condition: '' }], 'f'), (e) => e.code === 'bad_request');
});

test('conditionWarnings flags the forms that blank the turn or never match', () => {
  const flagged = ['a AND b', 'a OR b', 'NOT a', 'a && b', 'a || b', '!a', 'plan = "pro"', 'len(x) > 1', 'int(n) > 5', 'x == true', 'x == false', 'plan is "pro"', "plan is not 'pro'", 'visits > 2', 'visits >= 2', 'visits < 2'];
  for (const c of flagged) assert.ok(conditionWarnings(c).length > 0, c);
});

test('conditionWarnings stays quiet on valid forms and quoted text', () => {
  const quiet = ['plan == "AND"', 'note == "a && b"', "note == 'x = y'", 'a != b', 'a <= b', 'x is defined', 'plan in ["a", "b"]', '(a) and not b', 'visits is defined and visits > 2', 'n > "5"', "plan.startswith('p')", 'sys__avatar_enabled'];
  for (const c of quiet) assert.deepEqual(conditionWarnings(c), [], c);
});

test('conditionWarnings returns [] for values conditionProblem already rejects', () => {
  for (const v of ['', '{{ a AND b }}', 5, null, undefined]) assert.deepEqual(conditionWarnings(v), []);
});

test('conditionWarnings reads escaped quotes, ignores quoted operators and stays linear on hostile input', () => {
  assert.deepEqual(conditionWarnings(`plan == 'it\\'s AND fine'`), []);
  assert.deepEqual(conditionWarnings(`plan == "a && b" and x`), []);
  assert.equal(conditionWarnings(`plan == 'open AND x`).length, 1, 'an unterminated quote keeps its text');
  const started = process.hrtime.bigint();
  conditionWarnings(`'${'\\\''.repeat(50_000)}`);
  conditionWarnings(`"${'\\"'.repeat(50_000)}`);
  conditionWarnings('A'.repeat(50_000));
  conditionWarnings(`a${' '.repeat(50_000)}x`);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 500, 'linear time');
});

test('stripQuoted replaces quoted strings and keeps an unterminated quote', () => {
  assert.equal(stripQuoted(`a == 'x y' and b == "z"`), "a == '' and b == ''");
  assert.equal(stripQuoted("a == 'it\\'s'"), "a == ''");
  assert.equal(stripQuoted("a == 'open"), "a == 'open");
});
