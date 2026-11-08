import { test } from 'node:test';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import {
  DEFAULT_PAGES, EMOTIONS_PAGE, parseArgs, createAgent, pageList, newToken, connectOrigins, buildCsp, securityHeaders, route, pickTarget, once, createHandler, installCrashGuards, emotionsTarget, loadEnvironmentFiles, createTeardown,
} from '../../manual-testing/feature-pages/serve.mjs';
import { leakCounts } from '../../scripts/lib/leak-scan.mjs';
import { startServer, absoluteEnvFile } from '../../scripts/lib/start-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pagesDir = join(root, 'manual-testing/feature-pages');
const TOKEN = 'a'.repeat(32);

test('parseArgs: defaults', () => {
  assert.deepEqual(parseArgs([], {}), { lan: false, port: 0, ttlMinutes: 60, envFile: undefined, emotions: false });
});

test('parseArgs: flags and ENV_FILE', () => {
  const a = parseArgs(['--lan', '--port', '8080', '--ttl-minutes', '5', '--env-file', 'x.env'], {});
  assert.equal(a.lan, true);
  assert.equal(a.port, 8080);
  assert.equal(a.ttlMinutes, 5);
  assert.equal(a.envFile, 'x.env');
  assert.equal(parseArgs([], { ENV_FILE: 'e.env' }).envFile, 'e.env');
});

test('parseArgs: --emotions sets the flag only. TARGET is read later, after the env files', () => {
  assert.equal(parseArgs(['--emotions'], {}).emotions, true);
  assert.equal(parseArgs([], { TARGET: 'some-env' }).emotions, false);
  assert.throws(() => emotionsTarget({}), /TARGET/);
  assert.equal(emotionsTarget({ TARGET: 'some-env' }), 'some-env');
});

test('loadEnvironmentFiles: loads the named file, keeps values already set, refuses an unreadable file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-env-'));
  const file = join(dir, 'x.env');
  writeFileSync(file, 'FP_TEST_NEW=from-file\nFP_TEST_KEEP=from-file\nTARGET=from-file\n');
  process.env.FP_TEST_KEEP = 'already';
  const hadTarget = 'TARGET' in process.env;
  try {
    loadEnvironmentFiles(file);
    assert.equal(process.env.FP_TEST_NEW, 'from-file');
    assert.equal(process.env.FP_TEST_KEEP, 'already');
    if (!hadTarget) assert.equal(emotionsTarget(process.env), 'from-file', 'TARGET set only in the file is found');
    assert.throws(() => loadEnvironmentFiles(join(dir, 'missing.env')), /--env-file/);
  } finally {
    delete process.env.FP_TEST_NEW; delete process.env.FP_TEST_KEEP;
    if (!hadTarget) delete process.env.TARGET;
    rmSync(dir, { recursive: true });
  }
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
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
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

// The words are stored reversed so this file does not contain them itself.
const BANNED = ['aq', '2qvn', 'esaeler?-erp', 'ateb', 'gnimocpu', 'noos gnimoc'].map((w) => [...w].reverse().join(''));
// An underscore or a digit next to a word does not hide it: ENV_NAME_2_X must still match.
const BANNED_RE = new RegExp(`(?<![A-Za-z])(?:${BANNED.join('|')})(?![A-Za-z])`, 'i');
const scanned = [
  ...pageFiles,
  join(root, 'scripts/live-verify-feature-pages.mjs'),
  join(root, 'scripts/lib/leak-scan.mjs'),
  join(root, 'scripts/lib/start-server.mjs'),
  fileURLToPath(import.meta.url),
];

test('banned words and em dashes are absent from the harness, pages, README and this test', () => {
  assert.ok(scanned.length > 15);
  assert.ok(BANNED_RE.test(`${BANNED[1].toUpperCase()}_ADMIN_SECRET_1`), 'the scan must see a banned word next to an underscore and a digit');
  assert.ok(!BANNED_RE.test('quality'), 'it must not match inside a longer word');
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

function fakeKaltura(provisionResults) {
  const calls = { deleted: [], provision: 0 };
  const removed = new Set();
  const gone = () => { throw Object.assign(new Error('nf'), { status: 404 }); };
  return {
    calls,
    provision: async (opts) => {
      const r = provisionResults[calls.provision++];
      if (r instanceof Error) throw r;
      assert.ok(opts.adminTags.some((t) => /^sdk-pages-check-[0-9a-f]{6}$/.test(t)));
      return r;
    },
    agents: { delete: async (id) => { calls.deleted.push(`agent:${id}`); }, get: async () => gone() },
    avatars: { delete: async (id) => { calls.deleted.push(`avatar:${id}`); }, get: async () => gone() },
    intellects: {
      delete: async (id) => { calls.deleted.push(`intellect:${id}`); removed.add(id); }, get: async (id) => { if (removed.has(id)) gone(); return { prompts: [] }; },
      setPrompts: async () => {}, setClientVariablesEnabled: async () => {},
    },
  };
}
const provisionError = (partial) => Object.assign(new Error('x'), { code: 'provision_failed', body: { failedStep: 'avatar.create', createdSoFar: partial } });
const okResult = { configId: 7, agentId: 'a1', widgetId: 'w1', avatarId: 'v1' };

test('createAgent: retries once after a failed provision and removes the failed attempt first', async () => {
  const k = fakeKaltura([provisionError({ configId: 5, avatarId: 'old' }), okResult]);
  const seen = [];
  const ids = await createAgent(k, async () => ({ ks: 'x' }), 'abc123', (x) => seen.push(x), 0);
  assert.equal(ids.agentId, 'a1');
  assert.equal(k.calls.provision, 2);
  assert.deepEqual(k.calls.deleted, ['avatar:old', 'intellect:5']);
  assert.deepEqual(seen, [{ configId: 5, avatarId: 'old' }, undefined, ids], 'ids are reported before the failed attempt is removed, cleared after, then set');
});

test('createAgent: a second failure is thrown and its ids reach onCreated', async () => {
  const k = fakeKaltura([provisionError({}), provisionError({ configId: 9 })]);
  let seen;
  await assert.rejects(createAgent(k, async () => ({ ks: 'x' }), 'abc123', (p) => { seen = p; }, 0), { code: 'provision_failed' });
  assert.equal(k.calls.provision, 2);
  assert.deepEqual(seen, { configId: 9 });
});

test('createAgent: an error that is not a provision failure is not retried', async () => {
  const k = fakeKaltura([Object.assign(new Error('bad'), { code: 'forbidden' })]);
  await assert.rejects(createAgent(k, async () => ({ ks: 'x' }), 'abc123', undefined, 0), { code: 'forbidden' });
  assert.equal(k.calls.provision, 1);
});

test('createAgent: ids of a failed attempt are reported before cleanup starts and named when cleanup fails', async () => {
  const k = fakeKaltura([provisionError({ configId: 5, avatarId: 'old' }), okResult]);
  k.avatars.get = async () => ({ id: 'old' });
  const seen = [];
  await assert.rejects(createAgent(k, async () => ({ ks: 'x' }), 'abc123', (x) => seen.push(x), 0), /avatar old: still present/);
  assert.deepEqual(seen, [{ configId: 5, avatarId: 'old' }]);
  assert.equal(k.calls.provision, 1);
});

test('pickTarget: AGENTIC credentials win, then NVP1 credentials, then prod', () => {
  assert.equal(pickTarget({ AGENTIC_PARTNER_ID: '1', AGENTIC_ADMIN_SECRET: 's', NVP1_AGENTIC_PARTNER_ID: '2', NVP1_AGENTIC_ADMIN_SECRET: 't' }), 'prod');
  assert.equal(pickTarget({ NVP1_AGENTIC_PARTNER_ID: '2', NVP1_AGENTIC_ADMIN_SECRET: 't' }), 'nvp1');
  assert.equal(pickTarget({ NVP1_AGENTIC_PARTNER_ID: '2' }), 'prod');
  assert.equal(pickTarget({}), 'prod');
});

test('once: parallel calls share one run, and a failed run can be tried again', async () => {
  let runs = 0; let fail = true;
  const f = once(async () => { runs++; await new Promise((r) => setTimeout(r, 5)); if (fail) throw new Error('x'); return runs; });
  const [a, b] = await Promise.allSettled([f(), f()]);
  assert.equal(runs, 1);
  assert.equal(a.status, 'rejected');
  assert.equal(b.status, 'rejected');
  fail = false;
  const [c, d] = await Promise.all([f(), f()]);
  assert.equal(runs, 2);
  assert.equal(c, d);
  assert.equal(await f(), c);
  assert.equal(runs, 2);
  await f.settled();
});

/** Serve createHandler on a free local port for one test. */
async function withServer(api, fn) {
  const logs = [];
  const handler = createHandler({ api, token: TOKEN, pages: [...DEFAULT_PAGES], csp: buildCsp([]), title: 'Feature pages', log: (m) => logs.push(m) });
  const server = createServer(handler);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}/${TOKEN}`;
  try { return await fn(base, logs); } finally { server.closeAllConnections(); await new Promise((ok) => server.close(ok)); }
}

const circular = () => { const o = {}; o.self = o; return o; };

test('createHandler: inherited names are not endpoints, GET and POST, and the server stays up', async () => {
  const api = { config: async () => ({ ok: true }), 'catalog-init': async () => ({ ok: true }) };
  await withServer(api, async (base) => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      for (const method of ['GET', 'POST']) {
        const res = await fetch(`${base}/api/${name}`, { method, ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}) });
        assert.equal(res.status, 404, `${method} ${name}`);
      }
    }
    const ok = await fetch(`${base}/api/config`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
  });
});

test('createHandler: a reply that cannot be turned into JSON is a clean 500, not a crash', async () => {
  const api = { config: async () => circular(), variables: async () => ({ ok: true }) };
  await withServer(api, async (base) => {
    const bad = await fetch(`${base}/api/config`);
    assert.equal(bad.status, 500);
    assert.equal((await bad.json()).code, null);
    assert.equal((await fetch(`${base}/api/variables`)).status, 200, 'the server still answers');
  });
});

test('createHandler: handler errors reach the log, never the browser', async () => {
  const api = { config: async () => { throw Object.assign(new Error('internal path /srv/x and detail'), { code: 'some_code', stack: 'at secret.js:1' }); }, variables: async () => { throw new Error('plain'); } };
  await withServer(api, async (base, logs) => {
    const res = await fetch(`${base}/api/config`);
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(text), { error: 'The request failed. The server log has the detail.', code: 'some_code' });
    assert.ok(!/internal path|secret\.js/.test(text));
    assert.ok(logs.some((l) => l.includes('internal path /srv/x')));
    const plain = await (await fetch(`${base}/api/variables`)).json();
    assert.equal(plain.code, null);
    assert.ok(!JSON.stringify(plain).includes('plain'));
  });
});

test('createHandler: wrong method, bad body and missing files', async () => {
  const api = { 'catalog-init': async () => ({ ok: true }), config: async () => ({}) };
  await withServer(api, async (base) => {
    assert.equal((await fetch(`${base}/api/config`, { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await fetch(`${base}/api/catalog-init`)).status, 405);
    assert.equal((await fetch(`${base}/api/catalog-init`, { method: 'POST', body: '{not json' })).status, 400);
    assert.equal((await fetch(`${base}/api/catalog-init`, { method: 'POST', body: 'x'.repeat(20_000) })).status, 400);
    assert.equal((await fetch(`${base}/src/nope.js`)).status, 404);
    assert.equal((await fetch(`${base}/src/management/does-not-exist.js`)).status, 404);
    assert.equal((await fetch(`${base}/manual-testing/feature-pages/common.js`)).status, 200);
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get('content-security-policy'), buildCsp([]));
  });
});

test('createHandler: two parallel catalog-init calls make one item', async () => {
  let made = 0;
  const init = once(async () => { made++; await new Promise((r) => setTimeout(r, 20)); return { itemId: 'i1' }; });
  await withServer({ 'catalog-init': () => init() }, async (base) => {
    const post = () => fetch(`${base}/api/catalog-init`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }).then((r) => r.json());
    const [a, b] = await Promise.all([post(), post()]);
    assert.equal(made, 1);
    assert.deepEqual(a, b);
  });
});

test('installCrashGuards: an uncaught error or a rejected promise runs teardown instead of killing the process', () => {
  const proc = new EventEmitter();
  const calls = []; const logs = [];
  installCrashGuards(proc, (code) => calls.push(code), (m) => logs.push(m));
  proc.emit('uncaughtException', new Error('boom'));
  proc.emit('unhandledRejection', new Error('late'));
  assert.deepEqual(calls, [1, 1]);
  assert.match(logs[0], /uncaught exception: boom/);
  assert.match(logs[1], /unhandled rejection: late/);
});

test('leakCounts: finds any ADMIN_SECRET value and session tokens, and returns counts only', () => {
  const env = { SOME_ADMIN_SECRET_2: 'twelve-chars!', OTHER: 'twelve-chars!', SHORT_ADMIN_SECRET: 'abc' };
  const r = leakCounts(['ok text', 'has twelve-chars! inside', 'token djJ8abcdefghijkl and djJ8short'], env);
  assert.deepEqual(r, { secretHits: 1, ksHits: 1, secretsChecked: 1 });
  assert.deepEqual(leakCounts(['clean'], env), { secretHits: 0, ksHits: 0, secretsChecked: 1 });
  assert.equal(leakCounts(['clean'], {}).secretsChecked, 0, 'no secret to look for must be visible to the caller');
});

/** A fake backend that records deletes and says "not found" for a deleted id. */
function teardownKaltura() {
  const removed = new Set(); const order = [];
  const gone = (id) => { if (removed.has(id)) throw Object.assign(new Error('nf'), { status: 404 }); return { id }; };
  const del = (kind) => async (id) => { order.push(`${kind}:${id}`); removed.add(`${kind}:${id}`); };
  const get = (kind) => async (id) => gone(`${kind}:${id}`);
  return {
    order, removed,
    threads: { list: () => ({ all: async () => [] }), delete: async () => {} },
    catalog: { delete: del('item'), get: get('item') },
    agents: { delete: del('agent'), get: get('agent') },
    avatars: { delete: del('avatar'), get: get('avatar') },
    intellects: { delete: del('intellect'), get: get('intellect') },
  };
}

test('createTeardown: a stop signal during a slow provision waits for it, then removes what it made', async () => {
  const k = teardownKaltura();
  const state = { ids: undefined, catalog: undefined };
  const logs = [];
  // Setup finishes 30 ms after teardown starts, as a slow provision would.
  const settle = () => new Promise((r) => setTimeout(() => { state.ids = { configId: 5, agentId: 'a1', avatarId: 'v1' }; r(undefined); }, 30));
  const teardown = createTeardown({ kaltura: k, admin: async () => 'ks', state, settle, runId: 'abc123', log: (m) => logs.push(m), logIds: (m) => logs.push(m) });
  assert.equal(await teardown(), 0);
  assert.deepEqual(k.order.sort(), ['agent:a1', 'avatar:v1', 'intellect:5']);
  assert.ok(logs.some((l) => l.startsWith('teardown verified')));
});

test('createTeardown: with no ids it does not claim anything was verified', async () => {
  const k = teardownKaltura();
  const logs = [];
  const teardown = createTeardown({ kaltura: k, admin: async () => 'ks', state: {}, settle: async () => {}, runId: 'abc123', log: (m) => logs.push(m), logIds: (m) => logs.push(m) });
  assert.equal(await teardown(), 1);
  assert.deepEqual(k.order, []);
  assert.ok(!logs.some((l) => /teardown verified/.test(l)));
  assert.match(logs[0], /no ids were recorded.*sdk-pages-check-abc123/);
});

test('createTeardown: something still present is a failure that names the ids', async () => {
  const k = teardownKaltura();
  k.avatars.get = async () => ({ id: 'v1' });
  const logs = [];
  const teardown = createTeardown({ kaltura: k, admin: async () => 'ks', state: { ids: { configId: 5, agentId: 'a1', avatarId: 'v1' }, catalog: { itemId: 'i1' } }, settle: async () => {}, runId: 'abc123', log: (m) => logs.push(m), logIds: (m) => logs.push(`${m} [agent a1, avatar v1, item i1]`) });
  assert.equal(await teardown(), 1);
  assert.ok(logs.some((l) => /avatar: still present.*avatar v1/.test(l)));
  assert.ok(!logs.some((l) => /teardown verified/.test(l)));
});

test('createTeardown: a partial run without an agent id never lists threads without a filter', async () => {
  const k = teardownKaltura();
  let listed = 0;
  k.threads.list = () => { listed++; return { all: async () => [] }; };
  const teardown = createTeardown({ kaltura: k, admin: async () => 'ks', state: { ids: { configId: 9 } }, settle: async () => {}, runId: 'abc123', log: () => {}, logIds: () => {} });
  assert.equal(await teardown(), 0);
  assert.equal(listed, 0);
  assert.deepEqual(k.order, ['intellect:9']);
});

test('absoluteEnvFile: a relative ENV_FILE becomes absolute against the given folder. Unset stays unset', () => {
  const env = { ENV_FILE: 'secrets/.env' };
  assert.equal(absoluteEnvFile(env, '/work/here'), env);
  assert.equal(env.ENV_FILE, '/work/here/secrets/.env');
  assert.equal(absoluteEnvFile({ ENV_FILE: '/abs/.env' }, '/work/here').ENV_FILE, '/abs/.env');
  assert.equal('ENV_FILE' in absoluteEnvFile({}, '/work/here'), false);
});

test('startServer: resolves with the URL from the Open line', async () => {
  const code = "console.log('Open: http://127.0.0.1:1/x/'); setInterval(() => {}, 1000)";
  const s = await startServer({ command: process.execPath, args: ['-e', code], cwd: tmpdir(), env: process.env, pollMs: 20 });
  assert.equal(s.url, 'http://127.0.0.1:1/x/');
  assert.match((await s.stop()).log, /Open: /);
});

test('startServer: a child that exits early is reported with its log', async () => {
  await assert.rejects(
    startServer({ command: process.execPath, args: ['-e', "console.log('boom'); process.exit(3)"], cwd: tmpdir(), env: process.env, pollMs: 20 }),
    /server exited early:\nboom/,
  );
});

test('startServer: on the URL timeout the timeout message wins, and a late Open line is ignored', async () => {
  // On SIGTERM the child prints an Open line and exits a little later, like a server that was almost ready.
  const code = "process.on('SIGTERM', () => { console.log('Open: http://late/'); setTimeout(() => process.exit(0), 150); }); setInterval(() => {}, 1000)";
  const started = Date.now();
  await assert.rejects(
    startServer({ command: process.execPath, args: ['-e', code], cwd: tmpdir(), env: process.env, urlTimeoutMs: 200, pollMs: 20 }),
    (err) => /did not print a URL in time, so it was stopped/.test(err.message) && !/exited early/.test(err.message),
  );
  assert.ok(Date.now() - started < 5000);
});
