import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, renderRequest, callTool, runLeadChecks, orgUrlProblem } from '../../scripts/lib/salesforce-lead-check.mjs';
import { salesforceLeadUpsert } from '../../src/management/crm-recipes.js';
import { fakeFetch } from '../fakes/fetch.js';

/**
 * The live Salesforce script cannot run without an org. These tests drive its
 * logic against a small fake Salesforce, so the request building, response
 * mapping and cleanup are covered offline. They do NOT prove behavior of a
 * real org.
 */

const INSTANCE = 'https://fake.develop.my.salesforce.com';
const TOKEN = 'fake-token-' + 'x'.repeat(8);

/** A fake org: collections upsert by email (200 with one entry per record, success false for a refused record), required-field and email validation, bad-token 401, create, query, get, delete. */
function fakeOrg() {
  /** @type {Map<string, Record<string,string>>} */
  const leads = new Map();
  /** @type {Map<string, Record<string,string>>} */
  const contacts = new Map();
  let seq = 0;
  const routes = [
    {
      match: /\/composite\/sobjects\/Contact\/Email$/,
      respond: (/** @type {any} */ req) => {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: [{ errorCode: 'INVALID_SESSION_ID' }] };
        const { attributes: _a, ...fields } = req.body.records[0];
        const found = [...contacts.entries()].find(([, c]) => c.Email === fields.Email);
        if (found) { contacts.set(found[0], { ...found[1], ...fields }); return { body: [{ id: found[0], success: true, errors: [], created: false }] }; }
        const id = `003${++seq}`;
        contacts.set(id, fields);
        return { body: [{ id, success: true, errors: [], created: true }] };
      },
    },
    { match: /\/sobjects\/Contact\/003\d+$/, respond: (/** @type {any} */ req) => (contacts.delete(req.url.split('/').pop()) ? { status: 204 } : { status: 404, body: [{ errorCode: 'ENTITY_IS_DELETED' }] }) },
    {
      match: /\/composite\/sobjects\/Lead\/Email$/,
      respond: (/** @type {any} */ req) => {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }] };
        const rec = req.body.records[0];
        const refuse = (/** @type {string} */ statusCode, /** @type {string[]} */ fields) => ({ status: 200, body: [{ success: false, errors: [{ statusCode, message: statusCode, fields }] }] });
        if (req.body.records.length !== 1 || rec.attributes?.type !== 'Lead') return { status: 400, body: [{ errorCode: 'JSON_PARSER_ERROR' }] };
        if (!/^[^@\s]+@[^@\s]+\.\w+$/.test(rec.Email)) return refuse('INVALID_EMAIL_ADDRESS', ['Email']);
        const missing = ['LastName', 'Company'].filter((f) => !rec[f]);
        const { attributes: _a, ...fields } = rec;
        const matches = [...leads.entries()].filter(([, l]) => l.Email === rec.Email);
        // A real org returns the matched record's id even when the update is refused.
        if (missing.length) return { status: 200, body: [{ ...(matches.length === 1 ? { id: matches[0][0] } : {}), success: false, errors: [{ statusCode: 'REQUIRED_FIELD_MISSING', message: 'missing', fields: missing }] }] };
        if (matches.length > 1) return refuse('DUPLICATE_VALUE', ['Email']);
        if (matches.length === 1) { leads.set(matches[0][0], { ...matches[0][1], ...fields }); return { status: 200, body: [{ id: matches[0][0], success: true, errors: [], created: false }] }; }
        const id = `00Q${++seq}`;
        leads.set(id, fields);
        return { status: 200, body: [{ id, success: true, errors: [], created: true }] };
      },
    },
    {
      match: /\/sobjects\/Lead$/,
      respond: (/** @type {any} */ req) => {
        const id = `00Q${++seq}`;
        leads.set(id, { ...req.body });
        return { status: 201, body: { id, success: true, errors: [] } };
      },
    },
    { match: '/query?q=', respond: (/** @type {any} */ req) => {
      const q = decodeURIComponent(req.url.split('q=')[1]);
      const addr = /Email = '([^']+)'/.exec(q)?.[1];
      const table = /FROM Contact/.test(q) ? contacts : leads;
      return { body: { records: [...table.entries()].filter(([, l]) => l.Email === addr).map(([Id]) => ({ Id })) } };
    } },
    { match: /\/sobjects\/Lead\/00Q\d+$/, respond: (/** @type {any} */ req) => {
      const id = req.url.split('/').pop();
      if (req.method === 'DELETE') return leads.delete(id) ? { status: 204 } : { status: 404, body: [{ errorCode: 'ENTITY_IS_DELETED' }] };
      return { body: leads.get(id) };
    } },
  ];
  return { leads, contacts, fetch: fakeFetch(routes) };
}

test('renderTemplate fills {{ vars }} and {args}, and writes "None" for an omitted arg', () => {
  const scope = { args: { x: 1 }, vars: { sys__thread_id: 't1', secrets: { S: 'sec' } } };
  assert.equal(renderTemplate('a {x} b {{ sys__thread_id }} c {nope} {{secrets.S}}', scope), 'a 1 b t1 c None sec');
  assert.equal(renderTemplate('Bearer {{secrets.S}} {x}', { args: {}, vars: scope.vars }), 'Bearer sec None');
  assert.equal(renderTemplate('[{x}]', { args: { x: '' }, vars: {} }), '[]', 'an empty string is blank');
  assert.equal(renderTemplate('{x}', { args: { x: 'a{b}c' }, vars: {} }), 'a{b}c', 'braces inside a value are kept');
});

test('renderRequest builds the exact request the tool config describes', () => {
  const tool = salesforceLeadUpsert({ secretName: 'SF_TOKEN', instanceUrl: INSTANCE });
  const req = renderRequest(tool, { args: { Email: 'a@b.co', LastName: 'L', Company: 'C', consent: true }, secrets: { SF_TOKEN: TOKEN }, threadId: 'thr-1' });
  assert.equal(req.method, 'PATCH');
  assert.equal(req.url, `${INSTANCE}/services/data/v68.0/composite/sobjects/Lead/Email`);
  assert.equal(req.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(req.body.allOrNone, true);
  const rec = req.body.records[0];
  assert.deepEqual(rec.attributes, { type: 'Lead' });
  assert.equal(rec.Email, 'a@b.co', 'the key goes in the body as is');
  assert.equal(rec.LastName, 'L');
  assert.equal(rec.Phone, 'None', 'an omitted optional arg is written as the text None');
  assert.equal(rec.LeadSource, 'Web');
  assert.match(rec.Description, /Thread: thr-1\. Consent to be contacted: true\./);
});

test('a value with URL characters stays in the body and the URL never changes', () => {
  const tool = salesforceLeadUpsert({ secretName: 'SF_TOKEN', instanceUrl: INSTANCE });
  const email = 'a+b/c?d#e&f@x.co';
  const req = renderRequest(tool, { args: { Email: email, LastName: 'L', Company: 'C', consent: true }, secrets: { SF_TOKEN: TOKEN }, threadId: 't' });
  assert.equal(req.url, `${INSTANCE}/services/data/v68.0/composite/sobjects/Lead/Email`);
  assert.equal(req.body.records[0].Email, email);
});

test('renderRequest refuses a tool whose URL holds an {arg}', () => {
  const tool = salesforceLeadUpsert({ secretName: 'SF_TOKEN', instanceUrl: INSTANCE });
  const old = { ...tool, request: { ...tool.request, url: `${tool.request.url}/{Email}` } };
  assert.throws(() => renderRequest(/** @type {any} */ (old), { args: { Email: 'a@b.co' }, secrets: { SF_TOKEN: TOKEN }, threadId: 't' }), /holds an \{arg\}/);
});

test('callTool maps an insert and an update, and a refused update is success false even with an id', async () => {
  const org = fakeOrg();
  const tool = salesforceLeadUpsert({ secretName: 'SF_TOKEN', instanceUrl: INSTANCE });
  const ctx = { args: { Email: 'a@b.co', LastName: 'L', Company: 'C', consent: true }, secrets: { SF_TOKEN: TOKEN }, threadId: 't' };
  const first = await callTool(org.fetch, tool, ctx);
  assert.equal(first.status, 200);
  assert.equal(first.mapped.success, true);
  assert.ok(first.mapped.result);
  const second = await callTool(org.fetch, tool, ctx);
  assert.deepEqual(second.mapped, { result: first.mapped.result, success: true });
  const failed = await callTool(org.fetch, tool, { ...ctx, args: { ...ctx.args, Company: '' } });
  assert.equal(failed.status, 200);
  assert.equal(failed.mapped.success, false);
  assert.equal(failed.mapped.result, first.mapped.result, 'a refused update still carries the matched id');
  assert.equal(failed.json[0].errors[0].statusCode, 'REQUIRED_FIELD_MISSING');
  assert.deepEqual(failed.json[0].errors[0].fields, ['Company']);
});

test('runLeadChecks passes every step against the fake org and deletes its Leads', async () => {
  const org = fakeOrg();
  const { results, cleanup } = await runLeadChecks({ fetch: org.fetch, instanceUrl: INSTANCE, token: TOKEN, tag: 'abc' });
  const failing = results.filter((r) => !r.ok);
  assert.deepEqual(failing, [], JSON.stringify(failing));
  assert.ok(results.length >= 10);
  assert.equal(results.find((r) => r.step === '2d-two-leads-one-email')?.ok, true);
  assert.equal(results.find((r) => r.step === '8b-contact-update-same-email')?.ok, true);
  assert.equal(org.leads.size, 0, 'cleanup left no Leads');
  assert.equal(org.contacts.size, 0, 'cleanup left no Contacts');
  assert.equal(cleanup.failed, 0);
  assert.ok(cleanup.deleted >= 1);
});

test('runLeadChecks reports a failing step and still cleans up', async () => {
  const org = fakeOrg();
  // An org that accepts a bad token: step 6 must fail, cleanup must still run.
  const lenient = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    const headers = { ...(init.headers || {}) };
    if (headers.Authorization === 'Bearer invalid-token') headers.Authorization = `Bearer ${TOKEN}`;
    return org.fetch(url, { ...init, headers });
  };
  const { results } = await runLeadChecks({ fetch: /** @type {any} */ (lenient), instanceUrl: INSTANCE, token: TOKEN, tag: 'def' });
  assert.equal(results.find((r) => r.step === '6-bad-token')?.ok, false);
  assert.equal(org.leads.size, 0);
});

test('the check never puts the token in a result', async () => {
  const org = fakeOrg();
  const { results } = await runLeadChecks({ fetch: org.fetch, instanceUrl: INSTANCE, token: TOKEN, tag: 'ghi' });
  assert.ok(!JSON.stringify(results).includes(TOKEN));
});

test('orgUrlProblem enforces https, the Salesforce domain and the dev-org pattern', () => {
  assert.equal(orgUrlProblem('https://acme.develop.my.salesforce.com'), null);
  assert.equal(orgUrlProblem('https://acme--qa.sandbox.my.salesforce.com/'), null);
  assert.equal(orgUrlProblem('https://acme-dev-ed.my.salesforce.com'), null);
  assert.match(orgUrlProblem('https://acme.my.salesforce.com') || '', /dev or sandbox/);
  assert.equal(orgUrlProblem('https://acme.my.salesforce.com', true), null, 'the confirm flag allows a non-dev host');
  for (const confirm of [false, true]) {
    assert.match(orgUrlProblem('http://acme.develop.my.salesforce.com', confirm) || '', /https/);
    assert.match(orgUrlProblem('https://acme.develop.example.com', confirm) || '', /not a \.salesforce\.com or \.force\.com/);
    assert.match(orgUrlProblem('https://evil.com/.develop.my.salesforce.com', confirm) || '', /not a \.salesforce\.com|no path/);
    assert.match(orgUrlProblem('https://salesforce.com.evil.com', confirm) || '', /not a \.salesforce\.com/);
    assert.match(orgUrlProblem('https://acme.develop.my.salesforce.com/x', confirm) || '', /no path/);
    assert.match(orgUrlProblem('not a url', confirm) || '', /not a valid URL/);
  }
});

test('runLeadChecks refuses an unsafe org URL before any request', async () => {
  const org = fakeOrg();
  await assert.rejects(runLeadChecks({ fetch: org.fetch, instanceUrl: 'http://fake.develop.my.salesforce.com', token: TOKEN, tag: 'x' }), /refusing to run/);
  await assert.rejects(runLeadChecks({ fetch: org.fetch, instanceUrl: 'https://fake.example.com', token: TOKEN, tag: 'x', confirmNonProd: true }), /refusing to run/);
  assert.equal(org.fetch.calls.length, 0);
});

test('runLeadChecks refuses a tag that could widen the cleanup query', async () => {
  await assert.rejects(() => runLeadChecks({ fetch: /** @type {any} */ (() => { throw new Error('no network'); }), instanceUrl: INSTANCE, token: TOKEN, tag: "x' OR Email LIKE '%" }), /tag must be/);
});
