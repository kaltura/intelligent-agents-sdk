import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tools, api, csv, code, client, clientToolReadiness, validate, validateArgs, applyResponseMapping } from '../../src/management/tools.js';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/**
 * W3 — Tools builder/validators (PURE) + `mgmt.tools` resource (wire) tests.
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
  assert.match(b.warnings[0], /out-competes/i);
  // experiences off → ok
  const c = clientToolReadiness({ tool_ids: ['tool-1'], capabilities: { kaltura_genie_experiences: 'off' } });
  assert.deepEqual(c, { ok: true, warnings: [] });
  // no tool_ids → nothing to warn about
  assert.deepEqual(clientToolReadiness({ capabilities: {} }), { ok: true, warnings: [] });
  assert.deepEqual(clientToolReadiness({ tool_ids: [] }), { ok: true, warnings: [] });
  assert.deepEqual(clientToolReadiness(undefined), { ok: true, warnings: [] });
});

// ---------- client (issue #31 rules 1.2, 2.4, 6.3) ----------

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
  assert.throws(() => client({ name: '9bad', description: 'd' }), /name/);
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

test('oauth2 client_secret MUST be a secrets.<name> reference; plaintext rejected', () => {
  // plaintext rejected by construction
  let err;
  try {
    api(apiCfg({ request: { url: URL, authentication: { type: 'oauth2', client_id: 'cid', client_secret: 'sk-plaintext-leak', token_url: 'https://auth/x' } } }));
  } catch (e) { err = e; }
  assert.equal(err.code, 'bad_request');
  assert.match(err.detail, /secrets\.<name>/);

  // reference accepted
  const ok = api(apiCfg({ request: { url: URL, authentication: { type: 'oauth2', client_id: 'cid', client_secret: 'secrets.myOauth', token_url: 'https://auth/x' } } }));
  assert.equal(ok.request.authentication.client_secret, 'secrets.myOauth');
  assert.equal(ok.request.authentication.type, 'oauth2');
});

test('oauth2 token_url/auth_url are http(s)-validated', () => {
  assert.throws(
    () => api(apiCfg({ request: { url: URL, authentication: { client_secret: 'secrets.k', token_url: 'ftp://x' } } })),
    (e) => e.code === 'invalid_url',
  );
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

test('name must be a valid identifier; description required', () => {
  assert.throws(() => api(apiCfg({ name: '9bad' })), /name/);
  assert.throws(() => api(apiCfg({ name: 'has space' })), /name/);
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

test('validateArgs rejects missing prompt and bad arg name', () => {
  assert.throws(() => validateArgs({ a: { type: 'str' } }), /prompt/);
  assert.throws(() => validateArgs({ '1x': { prompt: 'p', type: 'str' } }), /identifier/);
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

test('delete requires confirmPermanent, then deletes by id', async () => {
  const { mgmt, ff } = harness([
    { match: 'v1/tool/delete', respond: () => ({ status: 200, body: {} }) },
  ]);
  await assert.rejects(() => mgmt.tools.delete('tool-1', ADMIN_KS, {}), (e) => e.code === 'confirmation_required');
  assert.equal(ff.calls.length, 0, 'no write before confirmation');

  const res = await mgmt.tools.delete('tool-1', ADMIN_KS, { confirmPermanent: true });
  assert.equal(res.removed, 'tool-1');
  assert.match(res._meta.generatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(ff.calls[0].body.id, 'tool-1');
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
