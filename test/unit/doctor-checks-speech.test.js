import { test } from 'node:test';
import assert from 'node:assert/strict';
import { respellingStyle, spokenDigitsCrossLanguage, spokenFormRows, spokenOutputUndeclared } from '../../src/management/doctor/checks/speech.js';
import { CHECKS, DOCTOR_CODES } from '../../src/management/doctor/checks/index.js';
import { DEFAULT_THRESHOLDS } from '../../src/management/doctor/model.js';

/** Pure checks over hand-built views. No network, no fakes. */

const voice = (language) => ({ id: `v-${language}`, state: 'found', item: { itemId: `v-${language}`, adminTags: [], attributes: { voice: { name: `Voice ${language}`, language } } } });
const avatar = (id, v) => ({ id, state: 'found', avatar: { id }, voice: v });
const agentView = (intellect, { avatars = [avatar('av1', voice('he'))], asr = 'en' } = {}) => ({
  agentId: 'a1', agent: { agentId: 'a1', asr: { language: asr, provider: 'kaltura' } }, configId: 10, intellectState: 'found', intellect, avatars,
});
const intellectView = (config, avatars = [avatar('av1', voice('en'))]) => ({ configId: 10, config, agentIds: ['a1'], agents: [{ agentId: 'a1', agent: {}, avatars }] });
const run = (check, v) => check.run(v, DEFAULT_THRESHOLDS);
const table = (rows) => ({ id: 10, type: 'brain', prompts: [{ key: 'pron', value: `Spoken forms:\n${rows.join('\n')}\n` }] });

test('spokenFormRows reads arrow rows with plain, curly and bulleted forms', () => {
  const rows = spokenFormRows(table(['EBITDA -> "ebitda"', '- KGER → “kay ger”', 'Non-GAAP => "non gap"', 'not a row']));
  assert.deepEqual(rows, [{ term: 'EBITDA', spoken: 'ebitda' }, { term: 'KGER', spoken: 'kay ger' }, { term: 'Non-GAAP', spoken: 'non gap' }]);
});

test('respelling_hyphen_or_mixed_case: flags KAY-ger and kayGer, not plain words, number hyphens or spaced capitals', () => {
  const f = run(respellingStyle, intellectView(table(['CAGR -> "KAY-ger"', 'X -> "kayGer"', 'EBITDA -> "ebitda"', 'Y -> "eighty-four million"', 'AI -> "A I"'])));
  assert.equal(f.length, 1);
  assert.equal(f[0].code, 'respelling_hyphen_or_mixed_case');
  assert.equal(f[0].severity, 'info');
  assert.match(f[0].message, /2 spoken form/);
  assert.match(f[0].message, /"KAY-ger"/);
  assert.deepEqual(f[0].agentIds, ['a1']);
});

test('respelling_hyphen_or_mixed_case: quiet with no table, and for an external intellect', () => {
  assert.deepEqual(run(respellingStyle, intellectView({ id: 10, type: 'brain', prompts: [{ value: 'Be nice.' }] })), []);
  assert.deepEqual(run(respellingStyle, intellectView({ id: 10, type: 'external', prompts: [{ value: 'X -> "KAY-ger"' }] })), []);
});

test('spoken_text_digits_cross_language: a he voice, English replies, digits in the opening and the table', () => {
  const cfg = { ...table(['Q3 -> "Q3"', 'EBITDA -> "ebitda"']), opening_phrase: 'Welcome. Revenue grew 12% this year.' };
  const f = run(spokenDigitsCrossLanguage, agentView(cfg));
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'warn');
  assert.equal(f[0].code, 'spoken_text_digits_cross_language');
  assert.equal(f[0].agentId, 'a1');
  assert.match(f[0].message, /"he"/);
  assert.match(f[0].message, /prompt row "Q3"/);
  assert.match(f[0].message, /opening_phrase/);
});

test('spoken_text_digits_cross_language: forced language wins over ASR language', () => {
  const cfg = { ...table(['A -> "12"']), force_language: 'Hebrew' };
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView(cfg, { asr: 'en' })), []);
});

test('spoken_text_digits_cross_language: quiet for a matching voice, a silent opening, words only, or an unknown language', () => {
  const cfg = { ...table(['A -> "12"']), opening_phrase: 'Revenue grew 12%.' };
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView(cfg, { avatars: [avatar('av1', voice('en'))] })), []);
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView({ ...table(['A -> "twelve"']), opening_phrase: '<blank>' })), []);
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView(cfg, { asr: 'zz-unknown' })), []);
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView(cfg, { avatars: [avatar('av1', voice('zz-unknown'))] })), []);
});

test('spoken_text_digits_cross_language: ignores digits inside template code', () => {
  const cfg = { id: 10, type: 'brain', opening_phrase: 'Welcome {% if x == 3 %}back{% endif %} to the review.' };
  assert.deepEqual(run(spokenDigitsCrossLanguage, agentView(cfg)), []);
});

const longPrompt = (extra = '') => ({ id: 10, type: 'brain', base_directive: `You are a helpful analyst who answers questions about the company results. Be brief and clear. ${'Stay on topic. '.repeat(15)}${extra}` });

test('spoken_output_undeclared: an avatar agent whose prompt never mentions speech', () => {
  const f = run(spokenOutputUndeclared, intellectView(longPrompt()));
  assert.deepEqual(f.map((x) => `${x.severity}:${x.code}`), ['info:spoken_output_undeclared']);
  assert.deepEqual(f[0].agentIds, ['a1']);
});

test('spoken_output_undeclared: quiet when the prompt says it, with no avatar, for a short prompt, or a non-English forced language', () => {
  assert.deepEqual(run(spokenOutputUndeclared, intellectView(longPrompt('Your reply is spoken aloud by a voice.'))), []);
  assert.deepEqual(run(spokenOutputUndeclared, intellectView(longPrompt(), [])), []);
  assert.deepEqual(run(spokenOutputUndeclared, intellectView({ id: 10, type: 'brain', base_directive: 'Be brief.' })), []);
  assert.deepEqual(run(spokenOutputUndeclared, intellectView({ ...longPrompt(), force_language: 'French' })), []);
});

test('the speech checks are registered and their codes are doctor codes', () => {
  for (const c of [spokenOutputUndeclared, respellingStyle, spokenDigitsCrossLanguage]) {
    assert.ok(CHECKS.includes(c));
    assert.equal(c.category, 'speech');
    for (const code of c.codes) assert.ok(DOCTOR_CODES.includes(code));
  }
});
