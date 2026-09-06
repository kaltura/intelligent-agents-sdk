import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  goToTool, siteMapPrompt, SITE_NAV_RULES_PROMPT, SITE_NAV_TOOL_NAME, loadSectionsManifest, estimateTokens,
  PAGE_CONTEXT_PROMPT, buildSectionsManifest,
} from '../../src/management/index.js';

const MANIFEST = buildSectionsManifest([
  { path: '/guides/pause-resume/', headings: [{ id: 'what-it-is', text: 'What it is', level: 2 }, { id: 'the-edge-case', text: "The edge case: don't leave the avatar stuck paused", level: 2 }] },
  { path: '/', headings: [] },
], { generatedAt: 't' });

/** Minimal Response-like object for the injected fetch. */
const response = ({ status = 200, body = '', contentLength } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k === 'content-length' && contentLength != null ? String(contentLength) : null) },
  text: async () => body,
});

test('goToTool: emits the verified wire config, idempotently', () => {
  const t = goToTool();
  assert.deepEqual(t, {
    name: 'go_to',
    description: t.description,
    args: {
      path: { prompt: 'Page path from the SITE MAP, with leading and trailing slash.', type: 'str', required: true },
      section: { prompt: 'Section key from the SITE MAP for that page. Omit for the page top.', type: 'str', required: false },
    },
    type: 'client',
    wait_for_response: false,
    timeout: 5,
  });
  assert.equal(t.name, SITE_NAV_TOOL_NAME);
  assert.match(t.description, /the docs site/);
  assert.match(t.description, /at most once per turn/);
  assert.match(t.description, /no result to wait for/);
  assert.ok(t.description.length < 400, `description stays short (${t.description.length} chars)`);
  assert.deepEqual(goToTool(), t, 'same options, same config');
  const custom = goToTool({ name: 'open_page', siteLabel: 'the Acme help center', timeout: 10, displayName: 'Open page' });
  assert.equal(custom.name, 'open_page');
  assert.equal(custom.timeout, 10);
  assert.equal(custom.display_name, 'Open page');
  assert.match(custom.description, /the Acme help center/);
  assert.equal(custom.wait_for_response, false);
});

test('siteMapPrompt: renders the map and warns above the token budget', () => {
  const warnings = [];
  const p = siteMapPrompt(MANIFEST, { warn: (m) => warnings.push(m) });
  assert.deepEqual(p, {
    key: 'siteMap',
    label: 'Site map',
    headerTemplate: 'SITE MAP. One line per page: path, then that page\'s section keys.',
    type: 'custom',
    value: '/\n/guides/pause-resume/: what-it-is, edge-case-dont',
  });
  assert.deepEqual(warnings, []);
  const tight = siteMapPrompt(MANIFEST, { maxTokens: 5, warn: (m) => warnings.push(m), key: 'map', label: 'Map' });
  assert.equal(tight.key, 'map');
  assert.equal(tight.label, 'Map');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SITE MAP is ~\d+ tokens \(limit 5\)/);
  assert.equal(siteMapPrompt({ pages: [] }, { warn: () => {} }).value, '');
});

test('SITE_NAV_RULES_PROMPT: frozen, names the tool, four numbered rules', () => {
  assert.ok(Object.isFrozen(SITE_NAV_RULES_PROMPT));
  assert.equal(SITE_NAV_RULES_PROMPT.type, 'custom');
  assert.equal(SITE_NAV_RULES_PROMPT.key, 'navRules');
  const lines = SITE_NAV_RULES_PROMPT.value.split('\n');
  assert.equal(lines[0], `${SITE_NAV_TOOL_NAME} rules:`);
  assert.deepEqual(lines.slice(1).map((l) => l.slice(0, 2)), ['1.', '2.', '3.', '4.']);
  assert.match(lines[2], /do not call go_to/);
  assert.match(lines[3], /never two/);
  assert.match(lines[4], /Never mention the screen/);
  assert.equal(typeof PAGE_CONTEXT_PROMPT.value, 'string', 'the page-context block ships alongside');
});

test('estimateTokens: chars / 3.2, rounded up, empty is 0', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens('abc'), 1);
  assert.equal(estimateTokens('x'.repeat(32)), 10);
  assert.equal(estimateTokens('x'.repeat(33)), 11);
});

test('loadSectionsManifest: happy path with injected fetch', async () => {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return response({ body: JSON.stringify(MANIFEST), contentLength: 200 }); };
  const m = await loadSectionsManifest('https://docs.example.com/nova/sections.json', { fetch: f });
  assert.deepEqual(m, MANIFEST);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://docs.example.com/nova/sections.json');
  assert.equal(calls[0].init.headers.accept, 'application/json');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('loadSectionsManifest: rejects bad URL, missing fetch, HTTP error, oversize, bad JSON, wrong version', async () => {
  const code = async (p, want, status) => { const e = await p.then(() => null, (x) => x); assert.ok(e, `expected rejection ${want}`); assert.equal(e.code, want, e.detail); if (status) assert.equal(e.status, status); return e; };
  await code(loadSectionsManifest('/relative/sections.json', { fetch: async () => response() }), 'bad_arg');
  await code(loadSectionsManifest('ftp://x/sections.json', { fetch: async () => response() }), 'bad_arg');
  await code(loadSectionsManifest(42, { fetch: async () => response() }), 'bad_arg');
  await code(loadSectionsManifest('https://x/s.json', { fetch: null }), 'bad_arg');
  await code(loadSectionsManifest('https://x/s.json', { fetch: async () => response({ status: 404 }) }), 'http_error', 404);
  await code(loadSectionsManifest('https://x/s.json', { fetch: async () => response({ body: '{}', contentLength: 999 }), maxBytes: 100 }), 'too_large');
  await code(loadSectionsManifest('https://x/s.json', { fetch: async () => response({ body: 'x'.repeat(101) }), maxBytes: 100 }), 'too_large');
  await code(loadSectionsManifest('https://x/s.json', { fetch: async () => response({ body: '{not json' }) }), 'bad_manifest');
  const wrong = await code(loadSectionsManifest('https://x/s.json', { fetch: async () => response({ body: JSON.stringify({ ...MANIFEST, version: 2 }) }) }), 'bad_manifest');
  assert.match(wrong.detail, /version 2 not supported/);
  await code(loadSectionsManifest('https://x/s.json', { fetch: async () => response({ body: '[]' }) }), 'bad_manifest');
});

test('loadSectionsManifest: aborts through the timeout signal', async () => {
  const f = (url, { signal }) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted'))); });
  await assert.rejects(loadSectionsManifest('https://x/s.json', { fetch: f, timeoutMs: 5 }), /aborted/);
});
