import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { parseContent } from '../../src/experience/genui/parse.js';

/**
 * parseContent string bodies: the YAML subset behind it. Every fixture under
 * test/fixtures/genui-yaml pairs a .yaml body with the .json a reference YAML
 * parser reads from the same text (the body trimmed, as parseContent trims it).
 */

const FIXTURES = new URL('../fixtures/genui-yaml/', import.meta.url);

test('yaml fixtures: parseContent matches the paired reference parse', () => {
  const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5));
  assert.ok(names.length >= 8, 'fixtures present');
  for (const n of names) {
    const text = readFileSync(new URL(`${n}.yaml`, FIXTURES), 'utf8');
    const want = JSON.parse(readFileSync(new URL(`${n}.json`, FIXTURES), 'utf8'));
    assert.deepStrictEqual(parseContent(text), want, n);
  }
});

test('yaml: an indentless list nests under its key', () => {
  const m = parseContent('keypoints:\n- title: a\n  citation:\n    clips:\n    - entry_id: 1_aaaaaaaa');
  assert.equal(m.raw, undefined);
  assert.equal(m.keypoints[0].title, 'a');
  assert.equal(m.keypoints[0].citation.clips[0].entry_id, '1_aaaaaaaa');
});

test('yaml: double-quoted escapes decode', () => {
  assert.equal(parseContent('t: "caf\\xE9 \\u2014 \\"q\\" a\\nb"').t, 'café — "q" a\nb');
  assert.equal(parseContent('t: "\\U0001F600 \\/ \\\\ \\t|"').t, '\u{1F600} / \\ \t|');
  assert.equal(parseContent('t: "bad \\q and \\xZZ"').t, 'bad \\q and \\xZZ');
});

test('yaml: escaped line break joins with no space', () => {
  assert.equal(parseContent('t: "abc\\\n  \\ def"').t, 'abc def');
  assert.equal(parseContent('t: "abc\\\n  def"').t, 'abcdef');
});

test("yaml: single-quoted '' unescapes; blank line folds to \\n", () => {
  assert.equal(parseContent("t: 'It''s'").t, "It's");
  assert.equal(parseContent("t: 'one\n\n  two'").t, 'one\ntwo');
  assert.equal(parseContent("t: 'one\n  two'").t, 'one two');
});

test('yaml: a plain title folded at 80 columns joins with one space', () => {
  const m = parseContent('title: How To Select Colors Step By Step for a Design System That Scales Across\n  Many Products\nnext: 1');
  assert.equal(m.title, 'How To Select Colors Step By Step for a Design System That Scales Across Many Products');
  assert.equal(m.next, 1);
  assert.equal(m.raw, undefined);
});

test('yaml: | and > block scalars, clip/strip/keep', () => {
  assert.deepEqual(parseContent('a: |\n  x\n  y\nb: 1'), { a: 'x\ny\n', b: 1 });
  assert.deepEqual(parseContent('a: |-\n  x\n  y\nb: 1'), { a: 'x\ny', b: 1 });
  assert.deepEqual(parseContent('a: |+\n  x\n\n\nb: 1'), { a: 'x\n\n\n', b: 1 });
  assert.deepEqual(parseContent('a: >\n  x\n  y\n\n  z\nb: 1'), { a: 'x y\nz\n', b: 1 });
  assert.deepEqual(parseContent('a: >-\n  x\n  y\nb: 1'), { a: 'x y', b: 1 });
  assert.deepEqual(parseContent('a: >+\n  x\n\nb: 1'), { a: 'x\n\n', b: 1 });
  assert.deepEqual(parseContent('a: |\n  x\n  y'), { a: 'x\ny' });
  assert.deepEqual(parseContent('a: |2\n    x\n  y\nb: 1'), { a: '  x\ny\n', b: 1 });
});

test('yaml: flow [] and {} parse; invalid flow is a plain string', () => {
  assert.deepEqual(parseContent('clips: []').clips, []);
  assert.deepEqual(parseContent('citation: {}').citation, {});
  assert.deepEqual(parseContent("a: [1, {b: 'x'}]").a, [1, { b: 'x' }]);
  assert.equal(parseContent('a: [1, 2').a, '[1, 2');
  assert.deepEqual(parseContent('a: [1,\n  2]').a, [1, 2]);
});

test('yaml: key with nothing after is null', () => {
  assert.deepEqual(parseContent('a:\nb: 1'), { a: null, b: 1 });
  assert.deepEqual(parseContent('b: 1\na:'), { b: 1, a: null });
});

test('yaml: no YAML 1.1 coercions', () => {
  const m = parseContent('a: yes\nb: off\nc: ~\nd: 1_000\ne: 0x1F\nf: 1:30\ng: 1e3');
  for (const k of 'abcdefg') assert.equal(typeof m[k], 'string', k);
  assert.equal(m.d, '1_000');
  assert.equal(parseContent('n: 012').n, 12);
  assert.equal(parseContent('n: -3\nm: 2.5\nt: true\nf: false\nz: null').t, true);
});

test('yaml: entry ids stay strings', () => {
  assert.equal(parseContent('entry_id: 1_aaaaaaaa').entry_id, '1_aaaaaaaa');
});

test('yaml: list items that look like URLs stay strings', () => {
  assert.deepEqual(parseContent('urls:\n- https://example.com/a').urls, ['https://example.com/a']);
});

test('yaml: key:value without a space goes to .raw', () => {
  assert.deepEqual(parseContent('a:b'), { raw: 'a:b' });
  assert.deepEqual(parseContent('a: 1\nb:c'), { a: 1, raw: 'b:c' });
});

test('yaml: proto keys dropped in block and flow', () => {
  const m = parseContent('__proto__:\n  polluted: 1\nconstructor: x\nsummary: y\nnested:\n  prototype: [1]\n  ok: {__proto__: {p: 1}, k: v}');
  assert.equal(Object.getPrototypeOf(m), Object.prototype);
  assert.equal(({}).polluted, undefined);
  assert.deepEqual(m, { summary: 'y', nested: { ok: { k: 'v' } } });
});

test('yaml: unterminated quote stays literal; prefix kept', () => {
  assert.deepEqual(parseContent('a: 1\nb: "half'), { a: 1, b: '"half' });
  const m = parseContent('title: "T"\nkeypoints:\n- title: "One"\n  summary: "half a sente');
  assert.equal(m.keypoints[0].title, 'One');
  assert.equal(m.keypoints[0].summary, '"half a sente');
});

test('yaml: depth past 64 never throws', () => {
  const stairs = Array.from({ length: 200 }, (_, i) => `${' '.repeat(i)}k${i}:`).join('\n');
  assert.equal(typeof parseContent(stairs), 'object');
  assert.equal(typeof parseContent(`a: ${'['.repeat(500)}`), 'object');
  assert.equal(typeof parseContent(`a:\n${Array.from({ length: 300 }, (_, i) => `${' '.repeat(i + 1)}- x`).join('\n')}`), 'object');
  assert.equal(typeof parseContent(`a: ${'- '.repeat(500)}x`), 'object');
});

test('yaml: 1 MB staircase parses in under 1 s', () => {
  const stairs = Array.from({ length: 1400 }, (_, i) => `${' '.repeat(i)}k${i}:`).join('\n');
  assert.ok(stairs.length > 900_000);
  const t0 = performance.now();
  assert.equal(typeof parseContent(stairs), 'object');
  assert.ok(performance.now() - t0 < 1000);
});

test('yaml: fuzz never throws', () => {
  const alphabet = ['a', 'b', 'k', '1', ':', ' ', ' ', '\n', '\n', '-', '- ', '"', "'", '\\', '[', ']', '{', '}', ',', '|', '>', '#', '!', '&', '*', '?', '%', '\t', '\r\n', '\u00e9'];
  let seed = 123456789;
  const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let n = 0; n < 2000; n++) {
    let s = '';
    const len = 1 + Math.floor(next() * 120);
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(next() * alphabet.length)];
    const m = parseContent(s);
    assert.equal(typeof m, 'object', JSON.stringify(s));
    assert.notEqual(m, null);
  }
});

test('yaml: lines it cannot place go to .raw, fences and JSON bodies are unchanged', () => {
  assert.deepEqual(parseContent('a: 1\n# comment\n---\nb: 2'), { a: 1, b: 2, raw: '# comment\n---' });
  assert.deepEqual(parseContent('{not valid json'), { raw: '{not valid json' });
  assert.deepEqual(parseContent('- a\n- b'), { raw: '- a\n- b' });
  assert.deepEqual(parseContent('```yaml\na: 1\n```'), { a: 1 });
});

test('yaml: a body indented as a whole parses as if flush-left', () => {
  assert.deepStrictEqual(parseContent('  title: A\n  summary: B'), { title: 'A', summary: 'B' });
  assert.deepStrictEqual(parseContent('\n    items:\n      - x\n      - y\n'), { items: ['x', 'y'] });
  assert.deepStrictEqual(parseContent(' title: A\nsummary: B'), { title: 'A', summary: 'B' });
});

test('yaml: a multi-line flow list or map keeps quoted line breaks and folds plain ones', () => {
  assert.deepStrictEqual(parseContent("t: ['one\n\n  two']"), { t: ['one\ntwo'] });
  assert.deepStrictEqual(parseContent("t: {a: 'one\n\n  two'}"), { t: { a: 'one\ntwo' } });
  assert.deepStrictEqual(parseContent('t: ["a\\\n  b"]'), { t: ['ab'] });
  assert.deepStrictEqual(parseContent('t: {a: "a\\\n  b"}'), { t: { a: 'ab' } });
  assert.deepStrictEqual(parseContent('t: ["a\n  b"]'), { t: ['a b'] });
  assert.deepStrictEqual(parseContent('t: [a\n  b, c\n\n  d]'), { t: ['a b', 'c\nd'] });
  assert.deepStrictEqual(parseContent('t: {a: x\n  y, b: 1}'), { t: { a: 'x y', b: 1 } });
});

test('yaml: a flow list or map closes at the key indentation without eating the next entry', () => {
  assert.deepStrictEqual(parseContent('questions: [\n  "One?",\n  "Two?"\n]'), { questions: ['One?', 'Two?'] });
  assert.deepStrictEqual(parseContent('questions: [\n  "One?",\n  "Two?"\n]\nnext: 1'), { questions: ['One?', 'Two?'], next: 1 });
  assert.deepStrictEqual(parseContent('q: {\n  a: 1,\n  b: 2\n}\nz: 3'), { q: { a: 1, b: 2 }, z: 3 });
  assert.deepStrictEqual(parseContent('q:\n  r: [\n    1,\n    2\n  ]\n  s: 2'), { q: { r: [1, 2], s: 2 } });
  assert.deepStrictEqual(parseContent('a: [1,\n  2\nb: 3'), { a: '[1, 2', b: 3 });
});
