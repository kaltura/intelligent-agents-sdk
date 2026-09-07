import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  STOP_WORDS, BOILERPLATE_IDS, MANIFEST_VERSION, normalizeWords, pageSectionKeys, buildSectionsManifest,
  renderSiteMap, normalizePath, resolvePath, resolveSection, validateSectionsManifest,
} from '../../src/core/site-keys.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, '../fixtures/site-headings.json'), 'utf8'));
const snapshot = readFileSync(join(here, '../fixtures/site-map.snapshot.txt'), 'utf8');
const keys = (headings, opts) => pageSectionKeys(headings, opts).map((k) => (k ? k.key : null));

test('site-keys: snapshot of the real docs site is stable and deterministic', () => {
  const a = buildSectionsManifest(fixture, { generatedAt: '2026-01-01T00:00:00.000Z' });
  const b = buildSectionsManifest([...fixture].reverse(), { generatedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(renderSiteMap(a), snapshot.trimEnd());
  assert.deepEqual(a, b, 'input order does not change the manifest');
  assert.equal(a.version, MANIFEST_VERSION);
  assert.equal(a.pages.length, 49);
  assert.equal(a.pages.reduce((n, p) => n + p.sections.length, 0), 175);
  for (const p of a.pages) {
    const seen = new Set();
    for (const s of p.sections) { assert.ok(!seen.has(s.key), `${p.path} duplicate key ${s.key}`); seen.add(s.key); assert.match(s.key, /^[^\s,:]+$/); }
  }
});

test('site-keys: Unicode, emoji, punctuation, empty and colliding headings', () => {
  const input = ['הגדרת הסוכן שלך', 'Über die Einrichtung des Agenten', 'エージェントの設定方法', 'Configuración del agente (avanzado)', '🚀 Quick start', 'v2.3 → v2.4 changes', "What it is — and isn't", 'Step 1 — Get your credentials (~1 minute)', 'Recipe A — Extract a summary', 'Recipe B — Email a human', 'C++ & C# clients', '', '   ', '###', 'Q&A', 'FAQ', 'Gotcha 1 — `kaltura_genie_experiences` out-competes your tool. Turn it OFF.', 'Example', 'Example', 'Example'];
  assert.deepEqual(keys(input), ['הגדרת-הסוכן-שלך', 'über-die-einrichtung', 'エージェントの設定方法', 'configuración-del-agente', 'quick-start', 'v23-v24-changes', 'what-it-is', 'step-get-credentials', 'recipe-a-extract', 'recipe-b-email', 'c-c-clients', 'section', 'section-2', 'section-3', 'q-a', 'faq', 'gotcha-kaltura-genie', 'example', 'example-2', 'example-3']);
});

test('site-keys: collisions extend word by word before suffixing', () => {
  assert.deepEqual(keys(['Configure the agent', 'Configure the agent quickly', 'Configure the agent quickly today', 'Configure the agent quickly today']), ['configure-agent', 'configure-agent-quickly', 'configure-agent-quickly-today', 'configure-agent-quickly-today-2']);
});

test('site-keys: boilerplate headings are skipped by id, by derived key and by full text', () => {
  assert.deepEqual(keys([{ id: 'related-docs', text: 'Related docs' }, { id: 'x', text: 'Where to go next' }, 'Table of contents', 'On this page', 'Real section']), [null, null, null, null, 'real-section']);
  assert.ok(BOILERPLATE_IDS.has('where-to-go-next'));
});

test('site-keys: overrides, per-language stop words, maxWords, URLs in headings', () => {
  assert.deepEqual(keys([{ id: 'a', text: 'What it is' }], { overrides: { a: 'intro' } }), ['intro']);
  assert.deepEqual(keys(['What it is'], { overrides: { 'What it is': 'intro' } }), ['intro']);
  assert.deepEqual(keys(['Le guide de la configuration'], { lang: 'fr', stopWords: { fr: ['le', 'de', 'la'] } }), ['guide-configuration']);
  assert.deepEqual(keys(['Le guide de la configuration'], { lang: 'fr' }), ['le-guide-de'], 'unknown language: no stop words');
  assert.deepEqual(keys(['Configure the agent quickly today'], { maxWords: 2 }), ['configure-agent']);
  assert.deepEqual(keys(['See https://example.com/a?b=c for details']), ['see-details']);
  assert.deepEqual(normalizeWords(null), []);
  assert.deepEqual(normalizeWords("don't v2.3 Über"), ['dont', 'v23', 'Über']);
  assert.ok(STOP_WORDS.en.has('the'));
  assert.deepEqual(pageSectionKeys(undefined), []);
});

test('site-keys: buildSectionsManifest depth filter, targets, titles, bad pages', () => {
  const m = buildSectionsManifest([
    { path: 'guides/x', title: 'X', headings: [{ id: 'a', text: 'Alpha one', level: 2 }, { id: 'b', text: 'Beta two', level: 3 }, { id: 'c', text: 'Gamma three' }, { text: 'no id' }], targets: [{ id: 'demo-box', text: 'Live demo' }, { id: 'a' }, { id: 'alpha-one', text: 'Alpha one clone' }] },
    { path: '' }, null, { path: 'javascript:alert(1)' },
  ], { generatedAt: 't' });
  assert.deepEqual(m, { version: 1, lang: 'en', generatedAt: 't', pages: [{ path: '/guides/x/', title: 'X', sections: [
    { key: 'alpha-one', id: 'a', text: 'Alpha one' },
    { key: 'gamma-three', id: 'c', text: 'Gamma three' },
    { key: 'demo-box', id: 'demo-box', text: 'Live demo', kind: 'target' },
    { key: 'alpha-one-clone', id: 'alpha-one', text: 'Alpha one clone', kind: 'target' },
  ] }] });
  assert.equal(buildSectionsManifest([{ path: '/x/', headings: [{ id: 'b', text: 'B', level: 3 }] }], { depth: 3 }).pages[0].sections.length, 1);
  assert.deepEqual(buildSectionsManifest(undefined).pages, []);
  assert.equal(renderSiteMap({ pages: [{ path: '/a/', sections: [] }, { path: '/b/', sections: [{ key: 'k1' }, { key: 'k2' }] }] }), '/a/\n\n/b/: k1, k2');
  assert.equal(
    renderSiteMap({ pages: [{ path: '/a/', title: ' Alpha  Page ', sections: [] }, { path: '/b/', title: 'Beta', sections: [{ key: 'k1' }] }] }),
    'Alpha Page\n/a/\n\nBeta\n/b/: k1',
    'title on its own line above the path line; the path line carries only path and keys',
  );
  assert.equal(renderSiteMap(null), '');
});

test('site-keys: normalizePath canonical forms', () => {
  assert.equal(normalizePath('guides/x'), '/guides/x/');
  assert.equal(normalizePath('/guides/x/'), '/guides/x/');
  assert.equal(normalizePath('  /guides//x?y=1#z '), '/guides/x/');
  assert.equal(normalizePath('\\guides\\x'), '/guides/x/');
  assert.equal(normalizePath('/nova/sections.json'), '/nova/sections.json');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath(''), '');
  assert.equal(normalizePath(null), '');
  assert.equal(normalizePath('https://evil.com/x'), '');
  assert.equal(normalizePath('//evil.com/x'), '');
});

test('site-keys: resolvePath exact, normalized, fuzzy, invented, ambiguous', () => {
  const m = buildSectionsManifest(fixture, { generatedAt: 't' });
  assert.equal(resolvePath(m, '/guides/pause-resume/').path, '/guides/pause-resume/');
  assert.equal(resolvePath(m, 'guides/pause-resume').path, '/guides/pause-resume/');
  assert.equal(resolvePath(m, '/Guides/Pause-Resume/').path, '/guides/pause-resume/');
  assert.equal(resolvePath(m, '/docs/pause-resume/').path, '/guides/pause-resume/', 'wrong folder, right last segment');
  assert.equal(resolvePath(m, '/'), m.pages.find((p) => p.path === '/'));
  assert.equal(resolvePath(m, '/docs/faq/'), null, 'invented path never resolves');
  assert.equal(resolvePath(m, '/pricing/'), null);
  assert.equal(resolvePath(m, 42), null);
  assert.equal(resolvePath(m, 'javascript:alert(1)'), null);
  assert.equal(resolvePath({ pages: [] }, '/x/'), null);
  assert.equal(resolvePath(null, '/x/'), null);
  const tie = { pages: [{ path: '/a/reference/', sections: [] }, { path: '/b/reference/', sections: [] }] };
  assert.equal(resolvePath(tie, '/reference/'), null, 'two equally good pages: refuse to guess');
  assert.equal(resolvePath({ pages: [{ path: '/', sections: [] }, { path: '/x/', sections: [] }] }, '/home/').path, '/', 'root page answers to "home"');
});

test('site-keys: resolveSection key, id, text, subset, jaccard, tie, none', () => {
  const page = { path: '/p/', sections: [
    { key: 'what-it-is', id: 'what-it-is-and-isnt', text: "What it is — and isn't" },
    { key: 'edge-case-dont', id: 'the-edge-case-dont-leave-the-avatar-stuck-paused', text: "The edge case: don't leave the avatar stuck paused" },
    { key: 'salesforce-example', id: 'salesforce-example', text: 'Salesforce example' },
    { key: 'hubspot-example', id: 'hubspot-example', text: 'HubSpot example' },
  ] };
  assert.deepEqual(resolveSection(page, 'edge-case-dont').by, 'key');
  assert.deepEqual(resolveSection(page, 'salesforce-example').by, 'key');
  assert.deepEqual(resolveSection(page, 'what-it-is-and-isnt').by, 'id');
  assert.deepEqual(resolveSection(page, "What it is — and isn't").by, 'text');
  assert.deepEqual(resolveSection(page, 'Edge Case Dont').by, 'text');
  assert.equal(resolveSection(page, 'stuck paused').section.key, 'edge-case-dont');
  assert.equal(resolveSection(page, 'stuck paused').by, 'subset');
  assert.equal(resolveSection(page, 'salesforce example code').section.key, 'salesforce-example');
  assert.equal(resolveSection(page, 'salesforce example code').by, 'jaccard');
  assert.equal(resolveSection(page, 'salesforce examples sample'), null, 'overlap below 0.5');
  assert.equal(resolveSection(page, 'example'), null, 'two sections share the word: refuse to guess');
  assert.equal(resolveSection(page, 'troubleshooting'), null);
  assert.equal(resolveSection(page, ''), null);
  assert.equal(resolveSection(page, '   '), null);
  assert.equal(resolveSection(page, '---'), null);
  assert.equal(resolveSection(page, 7), null);
  assert.equal(resolveSection(null, 'x'), null);
  assert.equal(resolveSection({ path: '/p/', sections: [] }, 'x'), null);
});

test('site-keys: validateSectionsManifest accepts the built shape and rejects bad input', () => {
  const good = buildSectionsManifest(fixture, { generatedAt: 't' });
  assert.deepEqual(validateSectionsManifest(JSON.parse(JSON.stringify(good))), good);
  const rejects = (raw, re) => assert.throws(() => validateSectionsManifest(raw), (e) => e.code === 'bad_manifest' && re.test(e.detail));
  rejects(null, /JSON object/);
  rejects([], /JSON object/);
  rejects('x', /JSON object/);
  rejects({ version: 2, pages: [] }, /version 2 not supported/);
  rejects({ version: 1 }, /pages array/);
  rejects({ version: 1, pages: [{ path: 'no-slash', sections: [] }] }, /page 0: path/);
  rejects({ version: 1, pages: [null] }, /page 0: path/);
  rejects({ version: 1, pages: [{ path: '/x/', sections: 'nope' }] }, /sections must be an array/);
  rejects({ version: 1, pages: [{ path: '/x/', sections: [{ key: 'k' }] }] }, /string key and id/);
  rejects({ version: 1, pages: [{ path: '/x/', sections: [{ key: 1, id: 'a' }] }] }, /string key and id/);
  rejects({ version: 1, pages: [{ path: '//evil.example/x', sections: [] }] }, /page 0: path/);
  rejects({ version: 1, pages: [{ path: '/a b/', sections: [] }] }, /page 0: path/);
  rejects({ version: 1, pages: [{ path: '/x/', sections: [{ key: 'two words', id: 'a' }] }] }, /key "two words" must be non-empty/);
  rejects({ version: 1, pages: [{ path: '/x/', sections: [{ key: 'a,b', id: 'a' }] }] }, /key "a,b"/);
  rejects({ version: 1, pages: [{ path: '/x/', sections: [{ key: 'a:b', id: 'a' }] }] }, /key "a:b"/);
  rejects({ version: 1, pages: [{ path: '/x/', sections: [{ key: '', id: 'a' }] }] }, /key ""/);
  rejects({ version: 1, pages: [{ path: '/x/', sections: [{ key: 'dup', id: 'a' }, { key: 'dup', id: 'b' }] }] }, /duplicate key "dup"/);
  assert.ok(validateSectionsManifest({ version: 1, pages: [{ path: '/he/', sections: [{ key: 'שלום-עולם', id: 'a' }] }] }), 'non-Latin keys pass');
  const dirty = validateSectionsManifest(JSON.parse('{"version":1,"__proto__":{"x":1},"pages":[{"path":"/a/","constructor":{"y":1},"sections":[{"key":"k","id":"i","text":"T","fn":null}]}]}'));
  assert.equal(Object.prototype.hasOwnProperty.call(dirty, '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(dirty.pages[0], 'constructor'), false);
  assert.equal(dirty.pages[0].sections[0].key, 'k');
});
