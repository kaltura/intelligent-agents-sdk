/**
 * Checks for the `salesforceLeadUpsert` tool against a Salesforce org.
 * Used by `scripts/live-verify-salesforce-lead.mjs`. It takes `fetch` as an
 * argument, so a fake `fetch` can test it offline (see
 * `test/unit/salesforce-lead-check.test.js`).
 *
 * It renders the tool's request itself (a plain `{{ path }}` substitution) and
 * sends it to Salesforce. That proves the request shape and the response
 * mapping. It does NOT prove how the Kaltura server renders the same
 * templates, and it does not run an agent conversation.
 *
 * Never prints the token. Every Lead it creates is deleted at the end.
 */
import { salesforceLeadUpsert, tools } from '../../src/management/index.js';

const SECRET_NAME = 'SF_TOKEN';
const API_VERSION = 'v68.0';

/**
 * Replace `{{ a.b }}` with the value at that path in `ctx`. Missing values become ''.
 * @param {string} text @param {Record<string,any>} ctx
 */
export function renderTemplate(text, ctx) {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path) => {
    let node = ctx;
    for (const seg of path.split('.')) node = node == null ? undefined : node[seg];
    return node == null ? '' : String(node);
  });
}

/**
 * Render a tool's `request` block.
 * @param {import('../../src/management/tools.js').GenieToolConfig} tool
 * @param {{args:Record<string,unknown>, secrets:Record<string,string>, threadId:string}} ctx
 */
export function renderRequest(tool, ctx) {
  const req = /** @type {any} */ (tool.request);
  const scope = { args: ctx.args, secrets: ctx.secrets, sys__thread_id: ctx.threadId };
  return {
    url: renderTemplate(req.url, scope),
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, renderTemplate(String(v), scope)])),
    body: Object.fromEntries(Object.entries(req.body).map(([k, v]) => [k, renderTemplate(String(v), scope)])),
  };
}

/**
 * Send the rendered tool request and map the response the way the tool config says.
 * @param {typeof fetch} fetchFn
 * @param {import('../../src/management/tools.js').GenieToolConfig} tool
 * @param {{args:Record<string,unknown>, secrets:Record<string,string>, threadId:string}} ctx
 */
export async function callTool(fetchFn, tool, ctx) {
  const req = renderRequest(tool, ctx);
  const res = await fetchFn(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(req.body) });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  const mapped = tools.applyResponseMapping(json, /** @type {any} */ (tool).response_mapping);
  return { status: res.status, json, mapped };
}

/**
 * @param {object} o
 * @param {typeof fetch} o.fetch
 * @param {string} o.instanceUrl  Org URL, no trailing slash.
 * @param {string} o.token        Access token (never printed).
 * @param {string} o.tag          Short unique run tag used in test emails.
 * @returns {Promise<{results:{step:string, ok:boolean, detail?:unknown}[], cleanup:{deleted:number, failed:number}}>}
 */
export async function runLeadChecks({ fetch: fetchFn, instanceUrl, token, tag }) {
  const tool = salesforceLeadUpsert({ secretName: SECRET_NAME, instanceUrl, apiVersion: API_VERSION });
  const secrets = { [SECRET_NAME]: token };
  const threadId = `live-verify-${tag}`;
  const email = `sdk-live-verify-${tag}@example.com`;
  const base = `${instanceUrl}/services/data/${API_VERSION}`;
  const auth = { Authorization: `Bearer ${token}` };
  const full = { FirstName: 'Sdk', LastName: 'LiveVerify', Company: 'Live Verify Co', Email: email, Phone: '555-0100', Country: 'US', consent: true };

  /** @type {{step:string, ok:boolean, detail?:unknown}[]} */
  const results = [];
  const check = (/** @type {string} */ step, /** @type {boolean} */ ok, /** @type {unknown} */ detail) => results.push({ step, ok, detail });
  const toDelete = new Set();

  /** @param {string} id */
  const getLead = async (id) => (await fetchFn(`${base}/sobjects/Lead/${id}`, { headers: auth })).json();
  const leadsFor = async (/** @type {string} */ addr) => {
    const res = await fetchFn(`${base}/query?q=${encodeURIComponent(`SELECT Id FROM Lead WHERE Email = '${addr}'`)}`, { headers: auth });
    const body = await res.json();
    return /** @type {string[]} */ ((body.records || []).map((/** @type {any} */ r) => r.Id));
  };

  try {
    // 1 create
    const created = await callTool(fetchFn, tool, { args: full, secrets, threadId });
    if (created.mapped.result) toDelete.add(created.mapped.result);
    check('1-create-lead', created.status === 201 && created.mapped.success === true && !!created.mapped.result, { status: created.status, mapped: created.mapped });
    if (created.mapped.result) {
      const lead = await getLead(created.mapped.result);
      check('1b-fields-and-tags', lead.Company === full.Company && lead.LeadSource === 'Web' && String(lead.Description).includes(threadId) && /consent to be contacted: true/i.test(String(lead.Description)),
        { LeadSource: lead.LeadSource, Description: lead.Description });
    }

    // 2 update with the same email: no second Lead, empty 204 body
    const updated = await callTool(fetchFn, tool, { args: { ...full, Company: 'Live Verify Co 2' }, secrets, threadId });
    const ids = await leadsFor(email);
    ids.forEach((id) => toDelete.add(id));
    check('2-update-same-email', updated.status === 204 && updated.mapped.result === undefined && updated.mapped.error_code === undefined, { status: updated.status, mapped: updated.mapped });
    check('2b-no-duplicate-lead', ids.length === 1, { leadsWithThisEmail: ids.length });
    if (ids[0]) check('2c-company-updated', (await getLead(ids[0])).Company === 'Live Verify Co 2', undefined);

    // 3 and 4 missing required fields
    for (const field of ['Company', 'LastName']) {
      const missing = await callTool(fetchFn, tool, { args: { ...full, [field]: undefined }, secrets, threadId });
      if (missing.mapped.result) toDelete.add(missing.mapped.result);
      check(`3-missing-${field}`, missing.status === 400 && missing.mapped.error_code === 'REQUIRED_FIELD_MISSING' && String(missing.mapped.error_fields).includes(field), { status: missing.status, mapped: missing.mapped });
    }

    // 5 invalid email
    const bad = await callTool(fetchFn, tool, { args: { ...full, Email: 'not-an-email' }, secrets, threadId });
    check('5-invalid-email', bad.status === 400 && bad.mapped.error_code === 'INVALID_EMAIL_ADDRESS', { status: bad.status, mapped: bad.mapped });

    // 6 bad token: the tool must report a failure, never an empty success
    const expired = await callTool(fetchFn, tool, { args: full, secrets: { [SECRET_NAME]: 'invalid-token' }, threadId });
    check('6-bad-token', expired.status === 401 && expired.mapped.error_code === 'INVALID_SESSION_ID', { status: expired.status, mapped: expired.mapped });
  } catch (err) {
    check('unexpected-error', false, { message: err instanceof Error ? err.message : String(err) });
  } finally {
    // Cleanup runs even after a failure. A leftover by email is caught too.
    try { (await leadsFor(email)).forEach((id) => toDelete.add(id)); } catch { /* best effort */ }
  }

  let deleted = 0;
  let failed = 0;
  for (const id of toDelete) {
    try {
      const res = await fetchFn(`${base}/sobjects/Lead/${id}`, { method: 'DELETE', headers: auth });
      if (res.status === 204 || res.status === 404) deleted++; else failed++;
    } catch { failed++; }
  }
  check('7-cleanup', failed === 0, { deleted, failed });
  return { results, cleanup: { deleted, failed } };
}
