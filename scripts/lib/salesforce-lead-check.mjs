/**
 * Checks for the `salesforceLeadUpsert` and `salesforceContactUpsert` tools against a Salesforce org.
 * Used by `scripts/live-verify-salesforce-lead.mjs`. It takes `fetch` as an
 * argument, so a fake `fetch` can test it offline (see
 * `test/unit/salesforce-lead-check.test.js`).
 *
 * It renders the tool's request itself (a plain `{{ path }}` substitution) and
 * sends it to Salesforce. It checks Salesforce itself and the SDK's request
 * shapes. It does NOT check the agent tool runtime: how Kaltura renders the
 * same templates, what the agent sees on an error, or any conversation.
 *
 * Never prints the token. Every Lead it creates is deleted at the end.
 */
import { salesforceLeadUpsert, salesforceContactUpsert, tools } from '../../src/management/index.js';

const SECRET_NAME = 'SF_TOKEN';
const DEV_HOST = /(\.develop\.|\.sandbox\.|\.scratch\.|-dev-ed\.)/;
const API_VERSION = 'v68.0';

/**
 * Check that an org URL is safe to write test Leads to. Always requires an
 * `https:` URL on a `.salesforce.com` or `.force.com` host. Unless
 * `confirmNonProd` is true, the host must also look like a dev, sandbox or
 * scratch org. `confirmNonProd` never relaxes the https or domain rules.
 * @param {string} instanceUrl @param {boolean} [confirmNonProd]
 * @returns {string|null} A reason to refuse, or null when the URL is fine.
 */
export function orgUrlProblem(instanceUrl, confirmNonProd = false) {
  let u;
  try { u = new URL(instanceUrl); } catch { return 'the org URL is not a valid URL'; }
  if (u.protocol !== 'https:') return 'the org URL must use https';
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return 'the org URL must be a plain origin with no path, query or credentials';
  const host = u.hostname.toLowerCase();
  if (!host.endsWith('.salesforce.com') && !host.endsWith('.force.com')) return `${host} is not a .salesforce.com or .force.com host`;
  if (!confirmNonProd && !DEV_HOST.test(host)) return `${host} does not look like a dev or sandbox org (set SALESFORCE_CONFIRM_NON_PROD=1 to confirm it is not production)`;
  return null;
}

/**
 * Fill a tool template the way the tool runtime does. `{{ path }}` reads
 * request variables and secrets (`secrets.NAME`, `sys__thread_id`). `{Name}`
 * reads a tool arg, inserted as is. An omitted arg
 * becomes the text "None" and an empty string becomes blank, as on the runtime.
 * A missing `{{ }}` value becomes ''.
 * @param {string} text @param {{args:Record<string,unknown>, vars:Record<string,any>}} scope
 */
export function renderTemplate(text, scope) {
  return text
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path) => {
      let node = scope.vars;
      for (const seg of path.split('.')) node = node == null ? undefined : node[seg];
      return node == null ? '' : String(node);
    })
    .replace(/\{(\w+)\}/g, (_m, name) => (scope.args[name] == null ? 'None' : String(scope.args[name])));
}

/**
 * Fill every string in a JSON value (nested objects and lists included).
 * @param {unknown} node @param {{args:Record<string,unknown>, vars:Record<string,any>}} scope
 * @returns {unknown}
 */
function renderDeep(node, scope) {
  if (typeof node === 'string') return renderTemplate(node, scope);
  if (Array.isArray(node)) return node.map((n) => renderDeep(n, scope));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, renderDeep(v, scope)]));
  return node;
}

/**
 * Render a tool's `request` block. Header values get request variables and
 * secrets only, never args. The URL holds no arg, so the check throws if one
 * ever appears there.
 * @param {import('../../src/management/tools.js').GenieToolConfig} tool
 * @param {{args:Record<string,unknown>, secrets:Record<string,string>, threadId:string}} ctx
 */
export function renderRequest(tool, ctx) {
  const req = /** @type {any} */ (tool.request);
  const vars = { secrets: ctx.secrets, sys__thread_id: ctx.threadId };
  const scope = { args: ctx.args, vars };
  const noArgs = { args: {}, vars };
  if (/\{\w+\}/.test(req.url)) throw new Error('the tool URL holds an {arg}. The Salesforce tools keep every arg in the body.');
  const url = renderTemplate(req.url, scope);
  return {
    url,
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, renderTemplate(String(v), noArgs)])),
    body: renderDeep(req.body, scope),
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
 * @param {boolean} [o.confirmNonProd]  Allow an org host that does not look like dev or sandbox. The https and domain rules still apply.
 * @returns {Promise<{results:{step:string, ok:boolean, detail?:unknown}[], cleanup:{deleted:number, failed:number}}>}
 */
export async function runLeadChecks({ fetch: fetchFn, instanceUrl, token, tag, confirmNonProd = false }) {
  const problem = orgUrlProblem(instanceUrl, confirmNonProd);
  if (problem) throw new Error(`refusing to run: ${problem}.`);
  const tool = salesforceLeadUpsert({ secretName: SECRET_NAME, instanceUrl, apiVersion: API_VERSION });
  const secrets = { [SECRET_NAME]: token };
  const threadId = `live-verify-${tag}`;
  const email = `sdk-live-verify-${tag}@example.com`;
  const base = `${instanceUrl}/services/data/${API_VERSION}`;
  const auth = { Authorization: `Bearer ${token}` };
  const full = { FirstName: 'Sdk', LastName: 'LiveVerify', Company: 'Live Verify Co', Email: email, Phone: '555-0100', Country: 'United States', consent: true };

  /** @type {{step:string, ok:boolean, detail?:unknown}[]} */
  const results = [];
  const check = (/** @type {string} */ step, /** @type {boolean} */ ok, /** @type {unknown} */ detail) => results.push({ step, ok, detail });
  const toDelete = new Set();
  const multiEmail = `sdk-live-verify-${tag}-twins@example.com`;
  const contactEmail = `sdk-live-verify-${tag}-contact@example.com`;
  const contactTool = salesforceContactUpsert({ secretName: SECRET_NAME, instanceUrl });
  const toDeleteContacts = new Set();
  /** @type {string[]} */
  const multi = [];

  /** @param {string} id */
  const getLead = async (id) => (await fetchFn(`${base}/sobjects/Lead/${id}`, { headers: auth })).json();
  // allowSave lets a second Lead with the same email past the standard duplicate rule.
  const createLead = async (/** @type {string} */ LastName, /** @type {string} */ Company) => {
    const res = await fetchFn(`${base}/sobjects/Lead`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Sforce-Duplicate-Rule-Header': 'allowSave=true' }, body: JSON.stringify({ LastName, Company, Email: multiEmail }) });
    return /** @type {string} */ ((await res.json()).id);
  };
  const recordsFor = async (/** @type {string} */ sobject, /** @type {string} */ addr) => {
    const res = await fetchFn(`${base}/query?q=${encodeURIComponent(`SELECT Id FROM ${sobject} WHERE Email = '${addr}'`)}`, { headers: auth });
    const body = await res.json();
    return /** @type {string[]} */ ((body.records || []).map((/** @type {any} */ r) => r.Id));
  };
  const leadsFor = (/** @type {string} */ addr) => recordsFor('Lead', addr);

  try {
    // The collections upsert answers 200 with one entry per record, for insert and update.
    // A refused record has success false. When it matched an existing record it still carries that record's id,
    // so the agent must read `success`, never the id alone.
    /** @param {{status:number, mapped:Record<string,any>}} r */
    const notSaved = (r) => r.mapped.success !== true;
    /** @param {any} r */
    const errorCode = (r) => r.json?.[0]?.errors?.[0]?.statusCode ?? r.json?.[0]?.errors?.[0]?.errorCode;

    // 1 create
    const created = await callTool(fetchFn, tool, { args: full, secrets, threadId });
    if (created.mapped.result) toDelete.add(created.mapped.result);
    check('1-create-lead', created.status === 200 && created.mapped.success === true && !!created.mapped.result, { status: created.status, mapped: created.mapped });
    if (created.mapped.result) {
      const lead = await getLead(created.mapped.result);
      check('1b-fields-and-tags', lead.Company === full.Company && lead.LeadSource === 'Web' && String(lead.Description).includes(threadId) && /consent to be contacted: true/i.test(String(lead.Description)),
        { LeadSource: lead.LeadSource, Description: lead.Description });
    }

    // 2 update with the same email: no second Lead, same id
    const updated = await callTool(fetchFn, tool, { args: { ...full, Company: 'Live Verify Co 2' }, secrets, threadId });
    const ids = await leadsFor(email);
    ids.forEach((id) => toDelete.add(id));
    check('2-update-same-email', updated.status === 200 && updated.mapped.success === true && updated.mapped.result === created.mapped.result, { status: updated.status, mapped: updated.mapped });
    check('2b-no-duplicate-lead', ids.length === 1, { leadsWithThisEmail: ids.length });
    if (ids[0]) check('2c-company-updated', (await getLead(ids[0])).Company === 'Live Verify Co 2', undefined);

    // 2d two Leads with one email: the upsert is ambiguous. Whatever status Salesforce uses,
    // the agent must not get success true, and neither Lead may change.
    multi.push(await createLead('TwinA', 'Twin A Co'), await createLead('TwinB', 'Twin B Co'));
    multi.forEach((id) => toDelete.add(id));
    const ambiguous = await callTool(fetchFn, tool, { args: { ...full, Email: multiEmail, Company: 'Live Verify Co 3' }, secrets, threadId });
    const twins = await Promise.all(multi.map(getLead));
    check('2d-two-leads-one-email', notSaved(ambiguous) && twins.every((l) => /^Twin [AB] Co$/.test(l.Company)),
      { status: ambiguous.status, errorCode: errorCode(ambiguous), mapped: ambiguous.mapped });

    // 3 and 4 missing required fields (an empty string is written as blank; an omitted arg would be written as "None")
    for (const field of ['Company', 'LastName']) {
      const missing = await callTool(fetchFn, tool, { args: { ...full, [field]: '' }, secrets, threadId });
      if (missing.mapped.result) toDelete.add(missing.mapped.result);
      check(`3-missing-${field}`, notSaved(missing) && errorCode(missing) === 'REQUIRED_FIELD_MISSING', { status: missing.status, errorCode: errorCode(missing), mapped: missing.mapped });
    }

    // 5 invalid email
    const bad = await callTool(fetchFn, tool, { args: { ...full, Email: 'not-an-email' }, secrets, threadId });
    check('5-invalid-email', notSaved(bad) && errorCode(bad) === 'INVALID_EMAIL_ADDRESS', { status: bad.status, errorCode: errorCode(bad), mapped: bad.mapped });

    // 6 bad token: the whole call fails with 401. In the tool runtime the agent only sees a generic error status.
    const expired = await callTool(fetchFn, tool, { args: full, secrets: { [SECRET_NAME]: 'invalid-token' }, threadId });
    check('6-bad-token', expired.status === 401 && expired.json?.[0]?.errorCode === 'INVALID_SESSION_ID', { status: expired.status, errorCode: expired.json?.[0]?.errorCode });

    // 8 Contact tool (its own API version): create, then update the same email with no second Contact
    const contactArgs = { Email: contactEmail, FirstName: 'Sdk', LastName: 'ContactOne' };
    const c1 = await callTool(fetchFn, contactTool, { args: contactArgs, secrets, threadId });
    if (c1.mapped.result) toDeleteContacts.add(c1.mapped.result);
    check('8-contact-create', c1.status === 200 && c1.mapped.success === true && !!c1.mapped.result, { status: c1.status, mapped: c1.mapped });
    const c2 = await callTool(fetchFn, contactTool, { args: { ...contactArgs, LastName: 'ContactTwo' }, secrets, threadId });
    const contactIds = await recordsFor('Contact', contactEmail);
    contactIds.forEach((id) => toDeleteContacts.add(id));
    check('8b-contact-update-same-email', c2.status === 200 && c2.mapped.success === true && c2.mapped.result === c1.mapped.result && contactIds.length === 1, { status: c2.status, mapped: c2.mapped, contactsWithThisEmail: contactIds.length });
  } catch (err) {
    check('unexpected-error', false, { message: err instanceof Error ? err.message : String(err) });
  } finally {
    // Cleanup runs even after a failure. A leftover by email is caught too.
    try { for (const addr of [email, multiEmail]) (await leadsFor(addr)).forEach((id) => toDelete.add(id)); } catch { /* best effort */ }
    try { (await recordsFor('Contact', contactEmail)).forEach((id) => toDeleteContacts.add(id)); } catch { /* best effort */ }
  }

  let deleted = 0;
  let failed = 0;
  for (const [sobject, ids] of /** @type {[string, Set<string>][]} */ ([['Lead', toDelete], ['Contact', toDeleteContacts]])) {
    for (const id of ids) {
      try {
        const res = await fetchFn(`${base}/sobjects/${sobject}/${id}`, { method: 'DELETE', headers: auth });
        if (res.status === 204 || res.status === 404) deleted++; else failed++;
      } catch { failed++; }
    }
  }
  check('7-cleanup', failed === 0, { deleted, failed });
  return { results, cleanup: { deleted, failed } };
}
