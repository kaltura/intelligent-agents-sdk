import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import {
  DEFAULT_PAGES, EMOTIONS_PAGE, parseArgs, pageList, newToken, connectOrigins, buildCsp, securityHeaders, route,
} from '../../manual-testing/feature-pages/serve.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pagesDir = join(root, 'manual-testing/feature-pages');
const TOKEN = 'a'.repeat(32);

test('parseArgs: defaults', () => {
  assert.deepEqual(parseArgs([], {}), { lan: false, port: 0, ttlMinutes: 60, envFile: undefined, emotions: false, target: undefined });
});

test('parseArgs: flags and ENV_FILE', () => {
  const a = parseArgs(['--lan', '--port', '8080', '--ttl-minutes', '5', '--env-file', 'x.env'], {});
  assert.equal(a.lan, true);
  assert.equal(a.port, 8080);
  assert.equal(a.ttlMinutes, 5);
  assert.equal(a.envFile, 'x.env');
  assert.equal(parseArgs([], { ENV_FILE: 'e.env' }).envFile, 'e.env');
});

test('parseArgs: --emotions needs TARGET and has no default', () => {
  assert.throws(() => parseArgs(['--emotions'], {}), /TARGET/);
  const a = parseArgs(['--emotions'], { TARGET: 'some-env' });
  assert.equal(a.emotions, true);
  assert.equal(a.target, 'some-env');
  assert.equal(parseArgs([], { TARGET: 'some-env' }).emotions, false);
});

test('parseArgs: rejects bad input', () => {
  assert.throws(() => parseArgs(['--port', 'x'], {}), /whole number/);
  assert.throws(() => parseArgs(['--port', '70000'], {}), /whole number/);
  assert.throws(() => parseArgs(['--ttl-minutes', '0'], {}), /whole number/);
  assert.throws(() => parseArgs(['--ttl-minutes', '241'], {}), /whole number/);
  assert.throws(() => parseArgs(['--ttl-minutes'], {}), /whole number/);
  assert.throws(() => parseArgs(['--env-file'], {}), /needs a path/);
  assert.throws(() => parseArgs(['--nope'], {}), /Unknown argument/);
});

test('pageList: emotions is never in the default list', () => {
  assert.deepEqual(pageList(false), [...DEFAULT_PAGES]);
  assert.ok(!DEFAULT_PAGES.includes(EMOTIONS_PAGE));
  assert.deepEqual(pageList(true), [EMOTIONS_PAGE]);
});

test('newToken: 128 random bits as hex, different each time', () => {
  const a = newToken();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newToken());
});

test('connectOrigins: adds the socket twin, skips junk and duplicates', () => {
  const out = connectOrigins(['https://a.example/path', 'https://a.example/other', 'http://b.example:81/x', 'not a url', null, undefined, 'ftp://c.example']);
  assert.deepEqual(out.sort(), ['http://b.example:81', 'https://a.example', 'wss://a.example', 'ws://b.example:81'].sort());
});

test('buildCsp: locked down, only the listed origins can be called', () => {
  const csp = buildCsp(['https://a.example', 'wss://a.example']);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self' https:\/\/cdn\.socket\.io/);
  assert.match(csp, /connect-src 'self' https:\/\/a\.example wss:\/\/a\.example/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  assert.match(buildCsp([]), /connect-src 'self'(;|$)/);
});

test('securityHeaders: carries the CSP and hardening headers', () => {
  const h = securityHeaders('x');
  assert.equal(h['content-security-policy'], 'x');
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.equal(h['referrer-policy'], 'no-referrer');
  assert.equal(h['cache-control'], 'no-store');
});

test('route: the token is the gate', () => {
  const pages = [...DEFAULT_PAGES];
  assert.deepEqual(route('/', TOKEN, pages), { kind: 'none' });
  assert.deepEqual(route('/wrong/', TOKEN, pages), { kind: 'none' });
  assert.deepEqual(route(`/${TOKEN}x/`, TOKEN, pages), { kind: 'none' });
  assert.deepEqual(route(`/${TOKEN}`, TOKEN, pages), { kind: 'index' });
  assert.deepEqual(route(`/${TOKEN}/`, TOKEN, pages), { kind: 'index' });
});

test('route: serves only listed page files', () => {
  const pages = [...DEFAULT_PAGES];
  const r = route(`/${TOKEN}/manual-testing/feature-pages/variables.html`, TOKEN, pages);
  assert.equal(r.kind, 'feature');
  assert.equal(/** @type {any} */ (r).file, join(pagesDir, 'variables.html'));
  assert.equal(route(`/${TOKEN}/manual-testing/feature-pages/common.js`, TOKEN, pages).kind, 'feature');
  assert.equal(route(`/${TOKEN}/manual-testing/feature-pages/style.css`, TOKEN, pages).kind, 'feature');
  assert.equal(route(`/${TOKEN}/manual-testing/feature-pages/serve.mjs`, TOKEN, pages).kind, 'none');
  assert.equal(route(`/${TOKEN}/manual-testing/feature-pages/README.md`, TOKEN, pages).kind, 'none');
  assert.equal(route(`/${TOKEN}/manual-testing/feature-pages/out/x.log`, TOKEN, pages).kind, 'none');
  assert.equal(route(`/${TOKEN}/manual-testing/other/x.js`, TOKEN, pages).kind, 'none');
});

test('route: the emotions page is served only when it is in the list', () => {
  const p = `/${TOKEN}/manual-testing/feature-pages/${EMOTIONS_PAGE}.html`;
  assert.equal(route(p, TOKEN, pageList(false)).kind, 'none');
  assert.equal(route(p, TOKEN, pageList(true)).kind, 'feature');
  assert.equal(route(`/${TOKEN}/manual-testing/feature-pages/variables.html`, TOKEN, pageList(true)).kind, 'none');
});

test('route: src serves .js files only and refuses path tricks', () => {
  const pages = [...DEFAULT_PAGES];
  const ok = route(`/${TOKEN}/src/management/index.js`, TOKEN, pages);
  assert.equal(ok.kind, 'src');
  assert.equal(/** @type {any} */ (ok).file, join(root, 'src/management/index.js'));
  assert.equal(route(`/${TOKEN}/src/management/index.json`, TOKEN, pages).kind, 'none');
  assert.equal(route(`/${TOKEN}/src/../package.json`, TOKEN, pages).kind, 'none');
  assert.equal(route(`/${TOKEN}/src/../../x.js`, TOKEN, pages).kind, 'none');
  assert.equal(route(`/${TOKEN}/src/a\\b.js`, TOKEN, pages).kind, 'none');
  assert.equal(route(`/${TOKEN}/src/a\0b.js`, TOKEN, pages).kind, 'none');
  assert.equal(route(`/${TOKEN}/package.json`, TOKEN, pages).kind, 'none');
});

test('route: api names are plain words, one level deep', () => {
  const pages = [...DEFAULT_PAGES];
  assert.deepEqual(route(`/${TOKEN}/api/config`, TOKEN, pages), { kind: 'api', name: 'config' });
  assert.deepEqual(route(`/${TOKEN}/api/catalog-state`, TOKEN, pages), { kind: 'api', name: 'catalog-state' });
  assert.equal(route(`/${TOKEN}/api/Config`, TOKEN, pages).kind, 'none');
  assert.equal(route(`/${TOKEN}/api/a/b`, TOKEN, pages).kind, 'none');
  assert.equal(route(`/${TOKEN}/api`, TOKEN, pages).kind, 'none');
});

const pageFiles = readdirSync(pagesDir).filter((f) => /\.(html|js|css|mjs|md)$/.test(f)).map((f) => join(pagesDir, f));

test('every page and script exists, and the page list matches the files', () => {
  for (const p of [...DEFAULT_PAGES, EMOTIONS_PAGE]) {
    assert.ok(pageFiles.includes(join(pagesDir, `${p}.html`)), `${p}.html`);
    assert.ok(pageFiles.includes(join(pagesDir, `${p}.js`)), `${p}.js`);
  }
});

test('pages: no inline script, inline style or event attributes', () => {
  for (const f of pageFiles.filter((x) => x.endsWith('.html'))) {
    const html = readFileSync(f, 'utf8');
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1], /\bsrc="/, `${f}: script without src`);
      assert.equal(m[2].trim(), '', `${f}: inline script body`);
      const src = /src="([^"]+)"/.exec(m[1])?.[1] ?? '';
      assert.ok(!/^https?:/.test(src) || src.startsWith('https://cdn.socket.io/'), `${f}: unexpected script origin ${src}`);
    }
    assert.ok(!/<style\b/i.test(html), `${f}: style element`);
    assert.ok(!/\sstyle=/i.test(html), `${f}: style attribute`);
    assert.ok(!/\son[a-z]+=/i.test(html), `${f}: event attribute`);
  }
});

test('pages: no admin secret handling in page code', () => {
  for (const f of pageFiles.filter((x) => /\.(html|js)$/.test(x))) {
    assert.ok(!/adminSecret|createAdminToken/.test(readFileSync(f, 'utf8')), f);
  }
});

// The words are built from parts so this file does not contain them itself.
const BANNED = [['q', 'a'], ['nvq', '2'], ['pre-?', 'release'], ['be', 'ta'], ['up', 'coming'], ['coming', ' soon']].map((p) => p.join(''));
const BANNED_RE = new RegExp(`\\b(?:${BANNED.join('|')})\\b`, 'i');
const scanned = [
  ...pageFiles,
  join(root, 'scripts/live-verify-feature-pages.mjs'),
  fileURLToPath(import.meta.url),
];

test('banned words and em dashes are absent from the harness, pages, README and this test', () => {
  assert.ok(scanned.length > 15);
  for (const f of scanned) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      assert.ok(!BANNED_RE.test(line), `${f}:${i + 1} has a banned word`);
      assert.ok(!line.includes('\u2014'), `${f}:${i + 1} has an em dash`);
    });
  }
});

test('the emotions page says Limited Availability', () => {
  assert.match(readFileSync(join(pagesDir, 'emotions.html'), 'utf8'), /Limited Availability/);
});
