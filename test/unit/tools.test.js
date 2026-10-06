import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tools, api, csv, code, client, clientToolReadiness, validate, validateArgs, applyResponseMapping } from '../../src/management/tools.js';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/**
 * Tools builder/validators (PURE) + `mgmt.tools` resource (wire) tests.
 * Pure tests run with no transport; class tests drive the real SDK through
 * fakeFetch and assert the `/v1/tool/*` request bodies (standalone Tool entity,
 * not intellect-embedded).
 */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40); // looks like an opaque encrypted KS → server-enforced scope
const URL = 'https://api.example.com/q';

/** A minimal valid api tool (responseMapping mode). */
function apiCfg(over = {}) {
  return {
    name: 'lookup', description: 'Look something up.',
    request: { url: URL, method: 'get' },
    responseMapping: { answer: 'data.value' },
    ...over,
  };
}

// ---------- clientToolReadiness ----------

test('clientToolReadiness is exposed on the tools namespace', () => {
  assert.equal(typeof tools.clientToolReadiness, 'function');
});

test('clientToolReadiness warns when tool_ids are set without kaltura_genie_experiences:off', () => {
  // no capabilities at all → warn
  const a = clientToolReadiness({ tool_ids: ['tool-1'] });
  assert.equal(a.ok, false);
  assert.match(a.warnings[0], /capabilities/i);
  // experiences not off → warn
  const b = clientToolReadiness({ tool_ids: ['tool-1'], capabilities: { kaltura_genie_experiences: 'on' } });
  assert.equal(b.ok, false);
  assert.match(b.warnings[0], /prefer its built-in experience tool/i);
  // experiences off → ok
  const c = clientToolReadiness({ tool_ids: ['tool-1'], capabilities: { kaltura_genie_experiences: 'off' } });
  assert.deepEqual(c, { ok: true, warnings: [] });
  // no tool_ids → nothing to warn about
  assert.deepEqual(clientToolReadiness({ capabilities: {} }), { ok: true, warnings: [] });
  assert.deepEqual(clientToolReadiness({ tool_ids: [] }), { ok: true, warnings: [] });
  assert.deepEqual(clientToolReadiness(undefined), { ok: true, warnings: [] });
});

// ---------- client ----------

test('client builds a native type:"client" tool with no request/authentication block', () => {
  const t = client({ name: 'ask_user', description: 'Ask the viewer something.' });
  assert.equal(t.type, 'client');
  assert.equal(t.name, 'ask_user');
  assert.equal(t.request, undefined, 'client tools have no request block at all');
  assert.equal(t.authentication, undefined);
  assert.equal(t.wait_for_response, undefined, 'waitForResponse is optional, omitted when not passed');
  assert.equal(t.timeout, undefined);
});

test('client maps waitForResponse/timeout to snake_case', () => {
  const t = client({ name: 'ask_user', description: 'd', waitForResponse: true, timeout: 15 });
  assert.equal(t.wait_for_response, true);
  assert.equal(t.timeout, 15);
});

test('client validates waitForResponse as boolean and timeout as a bounded integer, before any network call', () => {
  assert.throws(() => client({ name: 'x', description: 'd', waitForResponse: 'yes' }), (e) => e.code === 'bad_request');
  assert.throws(() => client({ name: 'x', description: 'd', timeout: -1 }), (e) => e.code === 'bad_request');
  assert.throws(() => client({ name: 'x', description: 'd', timeout: 0 }), (e) => e.code === 'bad_request');
  assert.throws(() => client({ name: 'x', description: 'd', timeout: 121 }), (e) => e.code === 'bad_request');
  assert.throws(() => client({ name: 'x', description: 'd', timeout: 'abc' }), (e) => e.code === 'bad_request');
});

test('client is a PURE builder — two calls in the same process never leak state into each other', () => {
  const a = client({ name: 'toolA', description: 'd', waitForResponse: true, timeout: 10 });
  const b = client({ name: 'toolB', description: 'd' });
  assert.equal(a.name, 'toolA');
  assert.equal(b.name, 'toolB');
  assert.equal(b.wait_for_response, undefined, "toolB's config is untouched by toolA's waitForResponse/timeout");
  assert.equal(b.timeout, undefined);
});

test('client reuses buildShared/NAME_RE — same name/description/args rules as api/csv/code', () => {
  assert.throws(() => client({ name: 'has space', description: 'd' }), /name/);
  assert.throws(() => client({ name: 'x', description: '' }), /description/);
  const t = client({ name: 'x', description: 'd', args: { q: { prompt: 'p', type: 'str' } } });
  assert.deepEqual(t.args.q, { prompt: 'p', type: 'str' });
});

test('client is exposed on the tools namespace and round-trips through validate()', () => {
  assert.equal(typeof tools.client, 'function');
  const t = client({ name: 'ask_user', description: 'd', waitForResponse: true, timeout: 20 });
  assert.deepEqual(validate(t), t);
});

test('tools.client(...) called via the namespace produces the exact same shape as the destructured builder', () => {
  const viaNamespace = tools.client({ name: 'ask_user', description: 'd', waitForResponse: true, timeout: 20 });
  const viaImport = client({ name: 'ask_user', description: 'd', waitForResponse: true, timeout: 20 });
  assert.deepEqual(viaNamespace, viaImport);
});

// ---------- pure builders ----------

test('api builder assembles wire shape with defaults (method upper, timeout 10)', () => {
  const t = api(apiCfg());
  assert.equal(t.type, 'api');
  assert.equal(t.name, 'lookup');
  assert.deepEqual(t.request, { url: URL, method: 'GET', timeout: 10 });
  assert.deepEqual(t.response_mapping, { answer: 'data.value' });
  assert.equal(t.response_template, undefined);
  assert.equal(t.response_chapters, undefined);
});

test('api builder maps displayName/addToHistory/args/variablesMapping to snake_case', () => {
  const t = api(apiCfg({
    displayName: 'Lookup', addToHistory: true,
    args: { q: { prompt: 'the query', type: 'str', required: true, default: 'x' } },
    variablesMapping: { lastValue: 'data.value' },
  }));
  assert.equal(t.display_name, 'Lookup');
  assert.equal(t.add_to_history, true);
  assert.deepEqual(t.args.q, { prompt: 'the query', type: 'str', required: true, default: 'x' });
  assert.deepEqual(t.variables_mapping, { lastValue: 'data.value' });
});

test('api builder honors timeout bounds + the 5 verbs', () => {
  assert.equal(api(apiCfg({ request: { url: URL, method: 'PATCH', timeout: 120 } })).request.method, 'PATCH');
  assert.throws(() => api(apiCfg({ request: { url: URL, timeout: 0 } })), /timeout/);
  assert.throws(() => api(apiCfg({ request: { url: URL, timeout: 121 } })), /timeout/);
  assert.throws(() => api(apiCfg({ request: { url: URL, method: 'TRACE' } })), /method/);
});

test('api builder rejects non-http(s) url with invalid_url', () => {
  let err;
  try { api(apiCfg({ request: { url: 'ftp://x/y' } })); } catch (e) { err = e; }
  assert.equal(err.code, 'invalid_url');
});

test('api builder rejects a malformed url with invalid_url', () => {
  assert.throws(() => api(apiCfg({ request: { url: 'not a url' } })), (e) => e.code === 'invalid_url');
});

test('api builder rejects bad dot-path in responseMapping with bad_jsonpath', () => {
  let err;
  try { api(apiCfg({ responseMapping: { v: '$.data.value' } })); } catch (e) { err = e; } // leading $ not allowed
  assert.equal(err.code, 'bad_jsonpath');
  assert.throws(() => api(apiCfg({ responseMapping: { v: 'a(b)' } })), (e) => e.code === 'bad_jsonpath'); // parens
  assert.throws(() => api(apiCfg({ responseMapping: { v: 'a..b' } })), (e) => e.code === 'bad_jsonpath'); // empty segment
});

test('api builder requires EXACTLY ONE response mode', () => {
  let none;
  try { api({ name: 'x', description: 'd', request: { url: URL } }); } catch (e) { none = e; }
  assert.equal(none.code, 'bad_request');
  assert.match(none.detail, /exactly one/i);

  let two;
  try { api(apiCfg({ responseTemplate: 'hello {answer}' })); } catch (e) { two = e; }
  assert.equal(two.code, 'bad_request');
  assert.match(two.detail, /EXACTLY ONE/);
});

test('api builder accepts responseTemplate and responseChapters modes', () => {
  const tmpl = api({ name: 'x', description: 'd', request: { url: URL }, responseTemplate: 'V={answer}' });
  assert.equal(tmpl.response_template, 'V={answer}');
  const ch = api({ name: 'y', description: 'd', request: { url: URL }, responseChapters: { iterate_on: 'items', content: '{title}', link: '{url}' } });
  assert.deepEqual(ch.response_chapters, { iterate_on: 'items', content: '{title}', link: '{url}' });
});

const OAUTH = { type: 'oauth2', client_id: 'cid', client_secret: 'secrets.myOauth', token_url: 'https://auth/token', auth_url: 'https://auth/authorize' };
const authOf = (auth) => api(apiCfg({ request: { url: URL, authentication: auth } })).request.authentication;

test('oauth2 client_secret MUST be a secrets.<name> reference; plaintext rejected', () => {
  let err;
  try { authOf({ ...OAUTH, client_secret: 'sk-plaintext-leak' }); } catch (e) { err = e; }
  assert.equal(err.code, 'bad_request');
  assert.match(err.detail, /secrets\.<name>/);

  const ok = authOf(OAUTH);
  assert.equal(ok.client_secret, 'secrets.myOauth');
  assert.equal(ok.type, 'oauth2');
  assert.deepEqual(Object.keys(ok).sort(), ['auth_url', 'client_id', 'client_secret', 'token_url', 'type']);
});

test('oauth2 requires client_id, token_url and auth_url', () => {
  for (const missing of ['client_id', 'token_url', 'auth_url']) {
    const a = { ...OAUTH }; delete a[missing];
    assert.throws(() => authOf(a), (e) => e.code === 'bad_request' && e.detail.includes(missing), missing);
  }
});

test('oauth2 rejects scopes and flow (authorization-code flow only)', () => {
  for (const extra of [{ scopes: ['read'] }, { flow: 'client_credentials' }]) {
    const key = Object.keys(extra)[0];
    assert.throws(() => authOf({ ...OAUTH, ...extra }), (e) => e.code === 'bad_request' && e.detail.includes(key), key);
  }
});

test('oauth2 token_url/auth_url are http(s)-validated', () => {
  for (const key of ['token_url', 'auth_url']) {
    assert.throws(() => authOf({ ...OAUTH, [key]: 'ftp://x' }), (e) => e.code === 'invalid_url', key);
  }
});

test('csv builder: header parses, args optional', () => {
  const t = csv({ name: 'rates', description: 'lookup', csv: 'code,rate\nUSD,1.0\nEUR,1.1' });
  assert.equal(t.type, 'csv');
  assert.equal(t.csv.includes('USD'), true);
  assert.equal(t.args, undefined); // optional, auto-derived server-side
});

test('csv builder rejects empty / header-less csv', () => {
  assert.throws(() => csv({ name: 'r', description: 'd', csv: '' }), /non-empty/);
  let err;
  try { csv({ name: 'r', description: 'd', csv: '\n\n' }); } catch (e) { err = e; }
  assert.equal(err.code, 'bad_request');
});

test('code builder requires non-empty code', () => {
  const t = code({ name: 'compute', description: 'do math', code: 'result = 1+1' });
  assert.equal(t.type, 'code');
  assert.equal(t.code, 'result = 1+1');
  assert.throws(() => code({ name: 'c', description: 'd', code: '   ' }), /non-empty/);
});

test('name must be letters/digits/underscore/hyphen; digit-start and hyphens are allowed (live-confirmed against the real API); description required', () => {
  assert.doesNotThrow(() => api(apiCfg({ name: '9leading-digit_and-hyphen' })));
  assert.throws(() => api(apiCfg({ name: 'has space' })), /name/);
  assert.throws(() => api(apiCfg({ name: '' })), /name/);
  let err;
  try { api(apiCfg({ description: '' })); } catch (e) { err = e; }
  assert.equal(err.code, 'bad_request');
  assert.match(err.detail, /description/);
});

test('validateArgs enumerates the 6 types and rejects unknown', () => {
  for (const type of ['str', 'int', 'float', 'bool', 'list', 'dict']) {
    assert.doesNotThrow(() => validateArgs({ a: { prompt: 'p', type } }));
  }
  let err;
  try { validateArgs({ a: { prompt: 'p', type: 'number' } }); } catch (e) { err = e; }
  assert.equal(err.code, 'bad_request');
  assert.match(err.detail, /str, int, float, bool, list, dict/);
});

test('validateArgs rejects missing prompt and bad arg name; digit-start and hyphens are allowed (live-confirmed against the real API)', () => {
  assert.throws(() => validateArgs({ a: { type: 'str' } }), /prompt/);
  assert.doesNotThrow(() => validateArgs({ '1x-arg': { prompt: 'p', type: 'str' } }));
  assert.throws(() => validateArgs({ 'has space': { prompt: 'p', type: 'str' } }), /hyphen/);
});

test('validate() re-checks an assembled wire tool and routes by type', () => {
  const t = api(apiCfg());
  assert.deepEqual(validate(t), t); // round-trips clean
  let err;
  try { validate({ name: 'x', description: 'd', type: 'mystery' }); } catch (e) { err = e; }
  assert.equal(err.code, 'bad_request');
  assert.match(err.detail, /api, csv, code, client/);
});

test('tools namespace exposes the pure surface', () => {
  assert.equal(typeof tools.api, 'function');
  assert.equal(typeof tools.csv, 'function');
  assert.equal(typeof tools.code, 'function');
  assert.equal(typeof tools.client, 'function');
  assert.equal(typeof tools.validate, 'function');
  assert.equal(typeof tools.validateArgs, 'function');
  assert.equal(typeof tools.applyResponseMapping, 'function');
});

// ---------- applyResponseMapping (pure) ----------

test('applyResponseMapping extracts fields and list indices', () => {
  const resp = { data: { value: 42 }, items: [{ id: 1 }, { id: 2 }] };
  const out = applyResponseMapping(resp, {
    v: 'data.value',
    first: 'items.0.id',
    missing: 'data.nope.deep',
  });
  assert.equal(out.v, 42);
  assert.equal(out.first, 1);
  assert.equal(out.missing, undefined);
});

test('applyResponseMapping never throws on bad data', () => {
  assert.deepEqual(applyResponseMapping(null, { v: 'x' }), { v: undefined });
  assert.deepEqual(applyResponseMapping({ x: 1 }, {}), {});
});

// ---------- Tools resource (wire, `/v1/tool/*`, partner-level) ----------

/** Build a Management whose genie calls hit fakeFetch with the supplied routes. */
function harness(routes) {
  const ff = fakeFetch(routes);
  const mgmt = new Management({ partnerId: '123', fetch: ff });
  return { mgmt, ff };
}

test('add validates BEFORE any network call, then posts {name, config} to v1/tool/add', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/tool/add', respond: (req) => ({ status: 200, body: { id: 'tool-1', name: req.body.name, config: req.body.config, partner_id: 123 } }) },
  ]);
  const badTool = { name: 'lookup', type: 'api', description: 'd', request: { url: 'ftp://x' }, response_mapping: { v: 'x' } };
  await assert.rejects(() => mgmt.tools.add(badTool, ADMIN_KS), (e) => e.code === 'invalid_url');
  assert.equal(ff.calls.length, 0, 'no transport before validation passes');

  const tool = api(apiCfg({ name: 'lookup' }));
  const res = await mgmt.tools.add(tool, ADMIN_KS);
  assert.equal(res.id, 'tool-1');
  assert.equal(res.name, 'lookup');
  assert.deepEqual(res.config, tool);
  assert.match(ff.calls[0].url, /v1\/tool\/add$/);
  assert.deepEqual(ff.calls[0].body, { name: 'lookup', config: tool });
});

test('create is an alias for add — same validation, same wire call', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/tool/add', respond: (req) => ({ status: 200, body: { id: 'tool-1', name: req.body.name, config: req.body.config, partner_id: 123 } }) },
  ]);
  const badTool = { name: 'lookup', type: 'api', description: 'd', request: { url: 'ftp://x' }, response_mapping: { v: 'x' } };
  await assert.rejects(() => mgmt.tools.create(badTool, ADMIN_KS), (e) => e.code === 'invalid_url');

  const tool = api(apiCfg({ name: 'lookup' }));
  const res = await mgmt.tools.create(tool, ADMIN_KS);
  assert.equal(res.id, 'tool-1');
  assert.match(ff.calls[0].url, /v1\/tool\/add$/);
  assert.deepEqual(ff.calls[0].body, { name: 'lookup', config: tool });
});

test('get fetches a Tool by id', async () => {
  const t = api(apiCfg({ name: 'lookup' }));
  const { mgmt, ff } = harness([
    { match: 'v1/tool/get', respond: (req) => ({ status: 200, body: { id: req.body.id, name: 'lookup', config: t } }) },
  ]);
  const res = await mgmt.tools.get('tool-1', ADMIN_KS);
  assert.equal(res.id, 'tool-1');
  assert.deepEqual(res.config, t);
  assert.equal(ff.calls[0].body.id, 'tool-1');
});

test('get requires a non-empty string id', async () => {
  const { mgmt, ff } = harness([]);
  await assert.rejects(() => mgmt.tools.get('', ADMIN_KS), (e) => e.code === 'bad_request');
  await assert.rejects(() => mgmt.tools.get(/** @type {any} */ (7), ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0);
});

test('list posts a ToolListFilter and returns the first page (async-iterable + awaitable)', async () => {
  const t = api(apiCfg({ name: 'lookup' }));
  const { mgmt, ff } = harness([
    { match: 'v1/tool/list', respond: () => ({ status: 200, body: { totalCount: 1, objects: [{ id: 'tool-1', name: 'lookup', config: t }] } }) },
  ]);
  const page = await mgmt.tools.list(ADMIN_KS);
  assert.equal(page.length, 1);
  assert.equal(page[0].id, 'tool-1');
  assert.equal(ff.calls[0].body.filter.objectType, 'ToolListFilter');
});

test('update re-validates a supplied config BEFORE any network call', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/tool/update', respond: (req) => ({ status: 200, body: { id: req.body.id, name: req.body.name, config: req.body.config } }) },
  ]);
  await assert.rejects(() => mgmt.tools.update('tool-1', { config: { name: 'x', description: 'd', type: 'mystery' } }, ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0, 'no transport before validation passes');

  const tool = api(apiCfg({ name: 'lookup2' }));
  const res = await mgmt.tools.update('tool-1', { name: 'lookup2', config: tool }, ADMIN_KS);
  assert.equal(res.name, 'lookup2');
  assert.deepEqual(ff.calls[0].body, { id: 'tool-1', name: 'lookup2', config: tool });
});

test('update requires at least one of name/config', async () => {
  const { mgmt, ff } = harness([]);
  await assert.rejects(() => mgmt.tools.update('tool-1', {}, ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0);
});

test('delete requires confirmPermanent, then checks for referencing intellects, then deletes by id', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/tool/delete', respond: () => ({ status: 200, body: {} }) },
    { match: 'v1/intellect/list', respond: () => ({ status: 200, body: { totalCount: 0, objects: [] } }) },
  ]);
  await assert.rejects(() => mgmt.tools.delete('tool-1', ADMIN_KS, {}), (e) => e.code === 'confirmation_required');
  assert.equal(ff.calls.length, 0, 'no write before confirmation');

  const res = await mgmt.tools.delete('tool-1', ADMIN_KS, { confirmPermanent: true });
  assert.equal(res.removed, 'tool-1');
  assert.equal(res.skippedInUseCheck, undefined);
  assert.match(res._meta.generatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.match(ff.calls.at(-1).url, /v1\/tool\/delete$/);
  assert.equal(ff.calls.at(-1).body.id, 'tool-1');
});

test('delete refuses with tool_in_use when an intellect still carries the id in tool_ids', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/tool/delete', respond: () => ({ status: 200, body: {} }) },
    { match: 'v1/intellect/list', respond: () => ({ status: 200, body: { totalCount: 1, objects: [{ id: 42 }] } }) },
    { match: 'v1/intellect/get', respond: () => ({ status: 200, body: { id: 42, tool_ids: ['tool-1'] } }) },
  ]);
  await assert.rejects(
    () => mgmt.tools.delete('tool-1', ADMIN_KS, { confirmPermanent: true }),
    (e) => e.code === 'tool_in_use' && /42/.test(e.detail),
  );
  assert.equal(ff.calls.some((c) => /v1\/tool\/delete$/.test(c.url)), false, 'refuses before the destructive call');
});

test('delete with {force:true} skips the reference check entirely', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/tool/delete', respond: () => ({ status: 200, body: {} }) },
  ]);
  const res = await mgmt.tools.delete('tool-1', ADMIN_KS, { confirmPermanent: true, force: true });
  assert.equal(res.removed, 'tool-1');
  assert.equal(res.skippedInUseCheck, true);
  assert.equal(ff.calls.some((c) => /v1\/intellect\/list$/.test(c.url)), false, 'force bypasses the lookup entirely');
});

test('findReferencingIntellects and delete reject when an intellect lookup fails with a 500 (no silent "no references")', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/tool/delete', respond: () => ({ status: 200, body: {} }) },
    { match: 'v1/intellect/list', respond: () => ({ status: 200, body: { totalCount: 2, objects: [{ id: 42 }, { id: 43 }] } }) },
    { match: 'v1/intellect/get', respond: (req) => (req.body.id === 42 ? { status: 500, body: { message: 'boom' } } : { status: 200, body: { id: 43, tool_ids: ['tool-1'] } }) },
  ]);
  await assert.rejects(() => mgmt.tools.findReferencingIntellects('tool-1', ADMIN_KS), (e) => e.code === 'server_error');
  await assert.rejects(() => mgmt.tools.delete('tool-1', ADMIN_KS, { confirmPermanent: true }), (e) => e.code === 'server_error');
  assert.equal(ff.calls.some((c) => /v1\/tool\/delete$/.test(c.url)), false, 'delete does not proceed');
});

test('findReferencingIntellects skips an intellect whose get returns not_found (deleted between list and get)', async () => {
  const { mgmt } = harness([
    { match: 'v1/intellect/list', respond: () => ({ status: 200, body: { totalCount: 2, objects: [{ id: 42 }, { id: 43 }] } }) },
    { match: 'v1/intellect/get', respond: (req) => (req.body.id === 42 ? { status: 404, body: { message: 'gone' } } : { status: 200, body: { id: 43, tool_ids: ['tool-1'] } }) },
  ]);
  assert.deepEqual(await mgmt.tools.findReferencingIntellects('tool-1', ADMIN_KS), [43]);
});

test('findReferencingIntellects returns the configIds that carry the tool id; rejects non-admin and bad ids', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/intellect/list', respond: () => ({ status: 200, body: { totalCount: 2, objects: [{ id: 42 }, { id: 43 }] } }) },
    { match: 'v1/intellect/get', respond: (req) => ({ status: 200, body: req.body.id === 42 ? { id: 42, tool_ids: ['tool-1'] } : { id: 43, tool_ids: [] } }) },
  ]);
  assert.deepEqual(await mgmt.tools.findReferencingIntellects('tool-1', ADMIN_KS), [42]);
  assert.deepEqual(await mgmt.tools.findReferencingIntellects('other', ADMIN_KS), []);
  await assert.rejects(() => mgmt.tools.findReferencingIntellects('tool-1', { ks: 'djJ8conv', kind: 'conversation' }), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(() => mgmt.tools.findReferencingIntellects('', ADMIN_KS), (e) => e.code === 'bad_request');
  assert.ok(ff.calls.length > 0);
});

test('every wire method asserts admin scope (rejects a conversation token)', async () => {
  const { mgmt } = harness([]);
  const convToken = { ks: 'djJ8conv', kind: 'conversation' };
  await assert.rejects(async () => mgmt.tools.get('tool-1', convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.tools.add(api(apiCfg()), convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.tools.update('tool-1', { name: 'x' }, convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.tools.delete('tool-1', convToken, { confirmPermanent: true }), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.tools.list(convToken), (e) => e.code === 'wrong_token_scope');
});

test('oauth2 rejects any unknown authentication key and names it', () => {
  for (const extra of [{ audience: 'x' }, { clientId: 'cid' }, { client_credentials: true }]) {
    const key = Object.keys(extra)[0];
    assert.throws(() => authOf({ ...OAUTH, ...extra }), (e) => e.code === 'bad_request' && e.detail.includes(`\`${key}\``), key);
  }
});

test('oauth2 needs a client_secret (missing, undefined and non-string values are rejected)', () => {
  const noSecret = { ...OAUTH }; delete noSecret.client_secret;
  assert.throws(() => authOf(noSecret), (e) => e.code === 'bad_request' && e.detail.includes('client_secret'));
  assert.throws(() => authOf({ ...OAUTH, client_secret: undefined }), (e) => e.code === 'bad_request' && e.detail.includes('client_secret'));
  assert.throws(() => authOf({ ...OAUTH, client_secret: 42 }), (e) => e.code === 'bad_request' && e.detail.includes('secrets.<name>'));
});

test('oauth2 counts an explicit undefined `scopes`/`flow` as present and rejects it', () => {
  for (const key of ['scopes', 'flow']) {
    assert.throws(() => authOf({ ...OAUTH, [key]: undefined }), (e) => e.code === 'bad_request' && e.detail.includes(key), key);
  }
});

// ---------- code tool ----------

const CODE_SRC = 'def main(city: str):\n    return {"city": city}';
const codeCfg = (over = {}) => ({ name: 'fx_rate', description: 'Convert currency.', code: CODE_SRC, ...over });
const CODE_403 = "Tool type 'code' is unavailable by default, call support";

test('code builder emits the exact wire shape, with no optional keys when none are passed', () => {
  assert.deepEqual(code(codeCfg()), { name: 'fx_rate', type: 'code', description: 'Convert currency.', code: CODE_SRC });
});

test('code builder maps args/displayName/addToHistory to the snake_case wire form and keeps code verbatim', () => {
  const t = code(codeCfg({
    args: { city: { type: 'str', prompt: 'City name', required: true } },
    displayName: 'FX rate',
    addToHistory: false,
  }));
  assert.deepEqual(t, {
    name: 'fx_rate', type: 'code', description: 'Convert currency.',
    args: { city: { type: 'str', prompt: 'City name', required: true } },
    display_name: 'FX rate', add_to_history: false, code: CODE_SRC,
  });
  assert.equal(t.code, CODE_SRC, 'source is not trimmed or rewritten');
});

test('code builder rejects missing, empty and non-string code with bad_request', () => {
  for (const c of [undefined, null, '', '   \n', 42, {}, ['def main(): pass']]) {
    assert.throws(() => code(codeCfg({ code: c })), (e) => e.code === 'bad_request' && /non-empty `code` string/.test(e.detail), String(c));
  }
});

test('code builder applies the shared name/description/args/displayName/addToHistory rules', () => {
  const rejects = (over, re) => assert.throws(() => code(codeCfg(over)), (e) => e.code === 'bad_request' && re.test(e.detail), JSON.stringify(over));
  rejects({ name: 'has space' }, /`name` must match/);
  rejects({ name: '' }, /`name` must match/);
  rejects({ name: undefined }, /`name` must match/);
  rejects({ description: '  ' }, /`description` is required/);
  rejects({ description: undefined }, /`description` is required/);
  rejects({ displayName: 5 }, /`displayName` must be a string/);
  rejects({ addToHistory: 'yes' }, /`addToHistory` must be a boolean/);
  rejects({ args: { city: { type: 'datetime', prompt: 'x' } } }, /type/i);
  rejects({ args: { city: { type: 'str' } } }, /prompt/i);
  assert.throws(() => code(null), (e) => e.code === 'bad_request');
  assert.throws(() => code(undefined), (e) => e.code === 'bad_request');
});

test('code builder checks the config before the code, so a bad name wins over bad code', () => {
  assert.throws(() => code({ name: 'bad name', description: 'd', code: '' }), /`name` must match/);
});

test('code builder is PURE: it never mutates its input and calls do not share state', () => {
  const cfg = codeCfg({ args: { city: { type: 'str', prompt: 'City' } } });
  const snapshot = JSON.parse(JSON.stringify(cfg));
  const a = code(cfg);
  const b = code(cfg);
  assert.deepEqual(cfg, snapshot);
  assert.notEqual(a, b);
  assert.notEqual(a.args, b.args, 'args are copied per call');
  a.code = 'changed';
  assert.equal(code(cfg).code, CODE_SRC);
});

test('code tool round-trips through validate() with and without optional fields', () => {
  const plain = code(codeCfg());
  assert.deepEqual(validate(plain), plain);
  const full = code(codeCfg({ args: { n: { type: 'int', prompt: 'Count', required: false, default: 3 } }, displayName: 'FX', addToHistory: true }));
  assert.deepEqual(validate(full), full);
});

test('validate() rejects a code wire tool with empty or missing code, and bad shared fields', () => {
  const ok = code(codeCfg());
  assert.throws(() => validate({ ...ok, code: '' }), (e) => e.code === 'bad_request' && /non-empty/.test(e.detail));
  const noCode = { ...ok }; delete noCode.code;
  assert.throws(() => validate(noCode), (e) => e.code === 'bad_request' && /non-empty/.test(e.detail));
  assert.throws(() => validate({ ...ok, name: 'bad name' }), (e) => e.code === 'bad_request');
  assert.throws(() => validate({ ...ok, add_to_history: 'no' }), (e) => e.code === 'bad_request');
});

test('mgmt.tools.add sends a code tool as {name, config} to v1/tool/add and returns the entity', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/tool/add', respond: (req) => ({ status: 200, body: { id: 'tool-c1', name: req.body.name, config: req.body.config, partner_id: 123 } }) },
  ]);
  const tool = code(codeCfg({ args: { city: { type: 'str', prompt: 'City', required: true } } }));
  const res = await mgmt.tools.add(tool, ADMIN_KS);
  assert.equal(res.id, 'tool-c1');
  assert.deepEqual(res.config, tool);
  assert.equal(ff.calls.length, 1);
  assert.match(ff.calls[0].url, /v1\/tool\/add$/);
  assert.deepEqual(ff.calls[0].body, { name: 'fx_rate', config: tool });
});

test('mgmt.tools.add validates a code tool BEFORE any network call', async () => {
  const { mgmt, ff } = harness([]);
  await assert.rejects(() => mgmt.tools.add({ name: 'c', type: 'code', description: 'd', code: '  ' }, ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0);
});

test('mgmt.tools.add maps the "unavailable by default" 403 to a typed forbidden error', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/tool/add', respond: () => ({ status: 403, body: { detail: CODE_403 } }) },
  ]);
  await assert.rejects(() => mgmt.tools.add(code(codeCfg()), ADMIN_KS), (e) => {
    assert.equal(e.code, 'forbidden');
    assert.equal(e.status, 403);
    assert.match(JSON.stringify(e.detail ?? e.message), /unavailable by default/);
    return true;
  });
  assert.equal(ff.calls.length, 1, 'one attempt, no retry on 403');
});

test('mgmt.tools.update re-sends a code config and maps the same 403', async () => {
  const tool = code(codeCfg({ code: 'def main():\n    return 1' }));
  const ok = harness([
    { match: 'v1/tool/update', respond: (req) => ({ status: 200, body: { id: req.body.id, name: req.body.name, config: req.body.config } }) },
  ]);
  const res = await ok.mgmt.tools.update('tool-c1', { config: tool }, ADMIN_KS);
  assert.deepEqual(res.config, tool);
  assert.deepEqual(ok.ff.calls[0].body, { id: 'tool-c1', config: tool });

  const denied = harness([{ match: 'v1/tool/update', respond: () => ({ status: 403, body: { detail: CODE_403 } }) }]);
  await assert.rejects(() => denied.mgmt.tools.update('tool-c1', { config: tool }, ADMIN_KS), (e) => e.code === 'forbidden' && e.status === 403);

  const bad = harness([]);
  await assert.rejects(() => bad.mgmt.tools.update('tool-c1', { config: { ...tool, code: '' } }, ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(bad.ff.calls.length, 0);
});

test('mgmt.tools.get returns a stored code tool unchanged, and list passes through code entries', async () => {
  const tool = code(codeCfg());
  const get = harness([{ match: 'v1/tool/get', respond: () => ({ status: 200, body: { id: 'tool-c1', name: 'fx_rate', config: tool } }) }]);
  assert.deepEqual((await get.mgmt.tools.get('tool-c1', ADMIN_KS)).config, tool);
  const list = harness([{ match: 'v1/tool/list', respond: () => ({ status: 200, body: { objects: [{ id: 'tool-c1', name: 'fx_rate', config: tool }] } }) }]);
  const page = await list.mgmt.tools.list(ADMIN_KS);
  assert.equal(page[0].config.type, 'code');
  assert.equal(page[0].config.code, tool.code);
});

test('a created code tool is linked to an intellect by id via intellectConfig.setToolIds', async () => {
  const tool = code(codeCfg());
  const ff = fakeFetch([
    { match: 'v1/tool/add', respond: (req) => ({ status: 200, body: { id: 'tool-c1', name: req.body.name, config: req.body.config } }) },
    { match: 'v1/intellect/get', respond: () => ({ status: 200, body: { id: 7, name: 'i', config: { tool_ids: [] } } }) },
    { match: 'v1/intellect/update', respond: (req) => ({ status: 200, body: { id: 7, config: req.body.config ?? req.body } }) },
  ]);
  const mgmt = new Management({ partnerId: '123', fetch: ff });
  const { id } = await mgmt.tools.add(tool, ADMIN_KS);
  await mgmt.intellectConfig.setToolIds(7, [id], ADMIN_KS);
  const update = ff.calls.find((c) => /v1\/intellect\/update$/.test(c.url));
  assert.ok(update, 'an intellect update was sent');
  assert.match(JSON.stringify(update.body), /"tool_ids":\["tool-c1"\]/);
});

test('mgmt.tools.add and update reject a conversation token for code tools before any network call', async () => {
  const { mgmt, ff } = harness([]);
  const convToken = { ks: 'djJ8conv', kind: 'conversation' };
  await assert.rejects(async () => mgmt.tools.add(code(codeCfg()), convToken), (e) => e.code === 'wrong_token_scope');
  await assert.rejects(async () => mgmt.tools.update('tool-c1', { config: code(codeCfg()) }, convToken), (e) => e.code === 'wrong_token_scope');
  assert.equal(ff.calls.length, 0);
});
