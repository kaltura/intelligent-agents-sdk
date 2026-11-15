import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dominantScript, normalizeLanguage, sameLanguage, scriptFits, scriptOfLanguage, stripTemplateSyntax,
} from '../../src/management/doctor/language.js';
import { LANGUAGE_CODES } from '../../src/management/languages.js';

test('normalizeLanguage maps codes, region tags, names and legacy codes to one code', () => {
  for (const [input, code] of [
    ['he', 'he'], ['HE', 'he'], [' he ', 'he'], ['he-IL', 'he'], ['pt_BR', 'pt'], ['iw', 'he'], ['in', 'id'], ['ji', 'yi'],
    ['Hebrew', 'he'], ['hebrew', 'he'], ['Norwegian', 'no'], ['nb', 'no'], ['nn-NO', 'no'], ['en-US', 'en'],
  ]) assert.equal(normalizeLanguage(input), code, String(input));
});

test('normalizeLanguage returns null for what it does not know', () => {
  for (const input of [undefined, null, 42, '', '  ', 'xx', 'klingon', 'Hebrew (Israel)', {}]) assert.equal(normalizeLanguage(input), null, String(input));
});

test('normalizeLanguage maps every accepted language code to itself, except Norwegian variants', () => {
  for (const code of LANGUAGE_CODES) assert.equal(normalizeLanguage(code), code === 'nb' || code === 'nn' ? 'no' : code, code);
});

test('sameLanguage is null when either side is unknown, never a mismatch', () => {
  assert.equal(sameLanguage('he', 'Hebrew'), true);
  assert.equal(sameLanguage('he', 'en'), false);
  assert.equal(sameLanguage('he', 'zz'), null);
  assert.equal(sameLanguage(undefined, 'en'), null);
});

test('scriptOfLanguage knows non-Latin scripts, common Latin languages, and skips the rest', () => {
  assert.equal(scriptOfLanguage('he'), 'Hebrew');
  assert.equal(scriptOfLanguage('Arabic'), 'Arabic');
  assert.equal(scriptOfLanguage('ja'), 'Japanese');
  assert.equal(scriptOfLanguage('zh'), 'Han');
  assert.equal(scriptOfLanguage('ru'), 'Cyrillic');
  assert.equal(scriptOfLanguage('es'), 'Latin');
  assert.equal(scriptOfLanguage('en-GB'), 'Latin');
  assert.equal(scriptOfLanguage('sr'), null, 'Serbian uses two scripts');
  assert.equal(scriptOfLanguage('zz'), null);
});

test('dominantScript follows the majority of letters', () => {
  assert.equal(dominantScript('שלום, אני העוזר שלך היום'), 'Hebrew');
  assert.equal(dominantScript('Hello, I am your assistant today'), 'Latin');
  assert.equal(dominantScript('שלום, אני העוזר של Kaltura ושל Acme'), 'Hebrew', 'Latin names do not flip a Hebrew line');
  assert.equal(dominantScript('Здравствуйте, чем могу помочь'), 'Cyrillic');
  assert.equal(dominantScript('こんにちは、今日はどうしましたか'), 'Japanese');
  assert.equal(dominantScript('你好，今天我能帮你什么'), 'Han');
  assert.equal(dominantScript('안녕하세요, 무엇을 도와드릴까요'), 'Hangul');
});

test('dominantScript returns null under five letters and for non-text', () => {
  assert.equal(dominantScript('Hi!'), null);
  assert.equal(dominantScript('1234 56 78'), null);
  assert.equal(dominantScript(''), null);
  assert.equal(dominantScript(undefined), null);
});

test('dominantScript ignores template code and URLs', () => {
  assert.equal(dominantScript('{% if name %}Hello {{ name }}{% endif %} שלום לכולם ומה שלומכם'), 'Hebrew');
  assert.equal(dominantScript('https://example.com/some/long/path שלום לכולם'), 'Hebrew');
  assert.equal(stripTemplateSyntax('a {{ x }} b {% if y %} c {# n #} d').replace(/\s+/g, ' ').trim(), 'a b c d');
});

test('scriptFits lets Han and Japanese stand for each other, and nothing else', () => {
  assert.equal(scriptFits('Hebrew', 'Hebrew'), true);
  assert.equal(scriptFits('Latin', 'Hebrew'), false);
  assert.equal(scriptFits('Han', 'Japanese'), true);
  assert.equal(scriptFits('Japanese', 'Han'), true);
  assert.equal(scriptFits('Han', 'Hangul'), false);
});
