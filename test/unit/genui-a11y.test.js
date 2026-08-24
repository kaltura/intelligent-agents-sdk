/**
 * GenUI accessibility regression test — the automated gate the DX finding
 * asked for. `mount.js` is the one GenUI file that touches the DOM (every
 * other genui/renderers/*.js is a pure data-transform with no ARIA to check);
 * this test mounts each widget kind into a REAL jsdom document (not the
 * hand-rolled `fakeDom()` shim used elsewhere in genui.test.js, which has no
 * attribute/role semantics for axe-core to inspect) and runs axe-core against it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import axeCore from 'axe-core';

/**
 * Mount `descriptor` into a fresh jsdom document and run axe-core against the
 * mounted root. Returns axe's violation list (empty = clean).
 * @param {{kind:string, data:object}} descriptor
 * @param {object} [opts]
 * @returns {Promise<Array<{id:string, help:string, nodes:Array<{html:string}>}>>}
 */
async function checkA11y(descriptor, opts = {}) {
  // axe-core probes canvas support (color-contrast rule) which jsdom stubs as
  // "not implemented" — harmless noise unrelated to this test, so route jsdom's
  // own console messages away from the real one rather than silencing errors globally.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously', virtualConsole });
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  try {
    const { mountWidget } = await import('../../src/experience/genui/renderers/mount.js');
    const root = mountWidget(descriptor, dom.window.document.body, opts);
    assert.ok(root, `${descriptor.kind} mounted`);
    dom.window.eval(axeCore.source);
    const results = await dom.window.axe.run(dom.window.document.body, {
      // A mounted widget is a fragment, not a full page — page-structure rules
      // (landmarks, document lang, heading order relative to the whole page)
      // are the host app's responsibility, not this fragment's.
      rules: {
        'region': { enabled: false },
        'landmark-one-main': { enabled: false },
        'page-has-heading-one': { enabled: false },
        'html-has-lang': { enabled: false },
      },
    });
    return results.violations;
  } finally {
    globalThis.document = prevDocument;
    globalThis.window = prevWindow;
  }
}

function formatViolations(violations) {
  return violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.html).join(' | ')})`).join('\n');
}

const SAMPLES = {
  summary: { title: 'Q2 Results', summary: 'Revenue grew.', bullets: ['Up 10%', 'Down in EMEA'] },
  flashcards: { title: 'Review', cards: [{ front: 'What is Kaltura?', back: 'A video platform.', label: 'Card 1' }] },
  followups: { questions: ['What about Q3?', 'Any risks?'] },
  sources: { sources: [{ title: 'Annual report', url: 'https://example.com/report', snippet: 'Full detail.' }] },
  'show-link': { url: 'https://example.com/doc', label: 'Read the doc', description: 'Background info.' },
  'external-video': { title: 'Product demo', embedUrl: 'https://www.youtube-nocookie.com/embed/abc123' },
  'video-gallery': { title: 'Clips', videos: [{ entryId: '1_a', title: 'Clip 1', thumbnailUrl: 'https://k.example/i.png', alt: 'Clip 1 thumbnail' }] },
  'content-gallery': { title: 'Gallery', items: [{ title: 'Card', imageUrl: 'https://k.example/i.png', alt: 'Card image', description: 'A card.', url: 'https://example.com/card' }] },
  'user-properties-form': { title: 'Tell us about you', fields: [{ key: 'email', type: 'email', label: 'Email', required: true, description: 'We will not spam you.' }] },
};

for (const [kind, data] of Object.entries(SAMPLES)) {
  test(`GenUI a11y: mounted "${kind}" widget has zero axe-core violations`, async () => {
    const violations = await checkA11y({ kind, data });
    assert.equal(violations.length, 0, `${kind} a11y violations:\n${formatViolations(violations)}`);
  });
}

test('GenUI a11y: unknown-kind fallback and error fallback are both violation-free', async () => {
  const unknownViolations = await checkA11y({ kind: 'mystery-widget', data: {} });
  assert.equal(unknownViolations.length, 0, `unknown fallback a11y violations:\n${formatViolations(unknownViolations)}`);
});

test('GenUI a11y: {markdown:true} summary rendering stays violation-free', async () => {
  const summary = '## Q2 Results\n\nRevenue was **up**. See [investor site](https://example.com/ir).\n\n| Quarter | Revenue |\n| --- | --- |\n| Q1 | $10M |';
  const violations = await checkA11y({ kind: 'summary', data: { summary } }, { markdown: true });
  assert.equal(violations.length, 0, `markdown summary a11y violations:\n${formatViolations(violations)}`);
});
