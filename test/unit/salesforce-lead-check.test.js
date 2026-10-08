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

/** A fake org: upsert by email, required-field and email validation, bad-token 401, query, get, delete. */
function fakeOrg() {
  /** @type {Map<string, Record<string,string>>} */
  const leads = new Map();
  let seq = 0;
  const routes = [
    {
      match: /\/sobjects\/Lead\/Email\//,
      respond: (/** @type {any} */ req) => {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, body: [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }] };
        const email = decodeURIComponent(req.url.split('/Lead/Email/')[1]);
        if (!/^[^@\s]+@[^@\s]+\.\w+$/.test(email)) return { status: 400, body: [{ message: 'Email: invalid email address', errorCode: 'INVALID_EMAIL_ADDRESS', fields: ['Email'] }] };
        const missing = ['LastName', 'Company'].filter((f) => !req.body[f]);
        if (missing.length) return { status: 400, body: [{ message: `Required fields are missing: [${missing}]`, errorCode: 'REQUIRED_FIELD_MISSING', fields: missing }] };
        const existing = [...leads.entries()].find(([, l]) => l.Email === email);
        if (existing) { leads.set(existing[0], { ...existing[1], ...req.body }); return { status: 204 }; }
        const id = `00Q${++seq}`;
        leads.set(id, { Email: email, ...req.body });
        return { status: 201, body: { id, success: true, errors: [] } };
      },
    },
    { match: '/query?q=', respond: (/** @type {any} */ req) => {
      const q = decodeURIComponent(req.url.split('q=')[1]);
      const addr = /Email = '([^']+)'/.exec(q)?.[1];
      return { body: { records: [...leads.entries()].filter(([, l]) => l.Email === addr).map(([Id]) => ({ Id })) } };
    } },
    { match: /\/sobjects\/Lead\/00Q\d+$/, respond: (/** @type {any} */ req) => {
      const id = req.url.split('/').pop();
      if (req.method === 'DELETE') return leads.delete(id) ? { status: 204 } : { status: 404, body: [{ errorCode: 'ENTITY_IS_DELETED' }] };
      return { body: leads.get(id) };
    } },
  ];
  return { leads, fetch: fakeFetch(routes) };
}

test('renderTemplate fills {{ vars }} and {args} and blanks unknown ones', () => {
  const scope = { args: { x: 1 }, vars: { sys__thread_id: 't1', secrets: { S: 'sec' } } };
  assert.equal(renderTemplate('a {x} b {{ sys__thread_id }} c {nope} {{secrets.S}}', scope), 'a 1 b t1 c  sec');
  assert.equal(renderTemplate('Bearer {{secrets.S}} {x}', { args: {}, vars: scope.vars }), 'Bearer sec ');
});

test('renderRequest builds the exact request the tool config describes', () => {
  const tool = salesforceLeadUpsert({ secretName: 'SF_TOKEN', instanceUrl: INSTANCE });
  const req = renderRequest(tool, { args: { Email: 'a%40b.co', LastName: 'L', Company: 'C', consent: true }, secrets: { SF_TOKEN: TOKEN }, threadId: 'thr-1' });
  assert.equal(req.method, 'PATCH');
  assert.equal(req.url, `${INSTANCE}/services/data/v68.0/sobjects/Lead/Email/a%40b.co`);
  assert.equal(req.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(req.body.LastName, 'L');
  assert.equal(req.body.Phone, '', 'an omitted optional arg renders empty');
  assert.equal(req.body.LeadSource, 'Web');
  assert.match(req.body.Description, /Thread: thr-1\. Consent to be contacted: true\./);
});

test('renderRequest refuses a raw @ in the URL', () => {
  const tool = salesforceLeadUpsert({ secretName: 'SF_TOKEN', instanceUrl: INSTANCE });
  assert.throws(() => renderRequest(tool, { args: { Email: 'a@b.co' }, secrets: { SF_TOKEN: TOKEN }, threadId: 't' }), /raw @/);
});

test('callTool maps a 201 and an empty 204, and exposes the raw error body', async () => {
  const org = fakeOrg();
  const tool = salesforceLeadUpsert({ secretName: 'SF_TOKEN', instanceUrl: INSTANCE });
  const ctx = { args: { Email: 'a%40b.co', LastName: 'L', Company: 'C', consent: true }, secrets: { SF_TOKEN: TOKEN }, threadId: 't' };
  const first = await callTool(org.fetch, tool, ctx);
  assert.equal(first.status, 201);
  assert.equal(first.mapped.success, true);
  assert.ok(first.mapped.result);
  const second = await callTool(org.fetch, tool, ctx);
  assert.equal(second.status, 204);
  assert.deepEqual(second.mapped, { result: undefined, success: undefined });
  const failed = await callTool(org.fetch, tool, { ...ctx, args: { ...ctx.args, Company: undefined } });
  assert.equal(failed.status, 400);
  assert.equal(failed.json[0].errorCode, 'REQUIRED_FIELD_MISSING');
  assert.deepEqual(failed.json[0].fields, ['Company']);
});

test('runLeadChecks passes every step against the fake org and deletes its Leads', async () => {
  const org = fakeOrg();
  const { results, cleanup } = await runLeadChecks({ fetch: org.fetch, instanceUrl: INSTANCE, token: TOKEN, tag: 'abc' });
  const failing = results.filter((r) => !r.ok);
  assert.deepEqual(failing, [], JSON.stringify(failing));
  assert.ok(results.length >= 9);
  assert.equal(org.leads.size, 0, 'cleanup left no Leads');
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
