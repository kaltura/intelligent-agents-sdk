#!/usr/bin/env node
/**
 * Live Salesforce Lead capture through a real agent: Kaltura backend plus a
 * Salesforce Developer Edition org or sandbox. Nothing is mocked. It runs
 * scripted text conversations against an agent that has `salesforceLeadUpsert`
 * and checks each outcome in Salesforce itself with a SOQL query.
 *
 *   SALESFORCE_INSTANCE_URL   e.g. https://yourorg.develop.my.salesforce.com
 *   SALESFORCE_ACCESS_TOKEN   a valid access token for an integration user
 *   TARGET                    Kaltura backend target, default `prod`. Use `nvq2` for QA.
 *   SALESFORCE_CONFIRM_NON_PROD=1   only for an org URL that does not look like dev or sandbox
 *   SALESFORCE_REVOKE_TOKEN=1       the token-expiry scenario revokes the real token first
 *
 * Without both Salesforce variables the script prints "skipped" and exits 0.
 * Never point it at a production org: it creates and deletes Leads.
 *
 * Scenarios (each one is a fresh thread):
 *   1  full data           one Lead with every field, thread id and consent in Description
 *   2  missing company     the visitor will not give a company: no Lead, no "saved"
 *   3  duplicate email     a Lead with this email exists: it is updated, no second Lead
 *   4  invalid email       no Lead, no "saved"
 *   5  visitor refuses     the tool is not called, no Lead, no "saved"
 *   6  two Leads, 1 email  the upsert writes nothing, the agent does not say "saved"
 *   7  expired token       the call fails and the agent says it could not save
 *
 * Every Lead whose email carries this run's tag is deleted at the end, and the
 * agent and tool are deleted. The Salesforce token is stored as an agent secret
 * (write-only) and is never printed. Replies are model output, so a flaky
 * phrase check is possible: the detail printed with each step shows the reply.
 */
import { Management, salesforceLeadUpsert } from '../src/management/index.js';
import { orgUrlProblem } from './lib/salesforce-lead-check.mjs';
import { resolveTarget, loadEnvFile, repoRoot } from './lib/target.mjs';
import { join } from 'node:path';

loadEnvFile(join(repoRoot, '.env'));

const instanceUrl = (process.env.SALESFORCE_INSTANCE_URL || '').replace(/\/$/, '');
const token = process.env.SALESFORCE_ACCESS_TOKEN || '';
if (!instanceUrl || !token) {
  console.log('skipped: no org credentials (set SALESFORCE_INSTANCE_URL and SALESFORCE_ACCESS_TOKEN to run this against a dev org)');
  process.exit(0);
}
const confirmNonProd = process.env.SALESFORCE_CONFIRM_NON_PROD === '1';
const urlProblem = orgUrlProblem(instanceUrl, confirmNonProd);
if (urlProblem) { console.error(`refusing to run: ${urlProblem}.`); process.exit(1); }

const target = resolveTarget(process.env.TARGET ?? 'prod');
const kaltura = new Management(target);
const tag = Date.now().toString(36);
const sfFetch = globalThis.fetch;
const API = `${instanceUrl}/services/data/v68.0`;
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const TOOL_NAME = `sf_lead_upsert_${tag}`;
const SECRET_NAME = 'SF_TOKEN';

let failed = false;
const check = (/** @type {string} */ step, /** @type {boolean} */ ok, /** @type {unknown} */ detail) => {
  if (!ok) failed = true;
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${step}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
};
const snippet = (/** @type {unknown} */ t, n = 220) => String(t ?? '').replace(/\s+/g, ' ').slice(0, n);

// --- Salesforce helpers (SOQL, create, delete). The token only goes in the Authorization header. ---
const soql = async (/** @type {string} */ q) => {
  const res = await sfFetch(`${API}/query?q=${encodeURIComponent(q)}`, { headers: auth });
  const body = await res.json();
  if (!res.ok) throw new Error(`SOQL failed: ${res.status} ${body?.[0]?.errorCode}`);
  return /** @type {any[]} */ (body.records);
};
const leadsFor = (/** @type {string} */ email) => soql(`SELECT Id, FirstName, LastName, Company, Email, Phone, Country, LeadSource, Description FROM Lead WHERE Email = '${email}'`);
const createLead = async (/** @type {Record<string,string>} */ fields) => {
  // allowSave lets a second Lead with the same email through the standard duplicate rule.
  const res = await sfFetch(`${API}/sobjects/Lead`, { method: 'POST', headers: { ...auth, 'Sforce-Duplicate-Rule-Header': 'allowSave=true' }, body: JSON.stringify(fields) });
  const body = await res.json();
  if (!res.ok) throw new Error(`seed Lead failed: ${res.status} ${body?.[0]?.errorCode}`);
  return /** @type {string} */ (body.id);
};

// --- Agent ---
const CAPABILITIES = {
  avatar: 'off', avatar_filler: 'off', use_knowledge_base: 'off',
  use_content_search: 'disabled', use_get_entry_content: 'disabled',
  use_related_files: 'disabled', use_web_search: 'disabled',
  generate_followup_questions: 'disabled', include_sources: 'disabled',
  video_gallery: 'disabled', external_video: 'disabled', show_link: 'disabled',
  avatar_show_content: 'disabled', kaltura_genie_experiences: 'disabled',
  screen_share_analysis: 'disabled',
};
const prompts = [
  { key: 'name', label: 'name', headerTemplate: 'Your name is:', type: 'custom', value: 'Sam, the sales assistant at Acme Video' },
  { key: 'rules', label: 'rules', headerTemplate: 'Rules you must obey without exception:', type: 'custom', value: [
    'You help visitors who want a sales contact. Collect their details, confirm them, and save them with the lead tool.',
    'Keep every reply to two short sentences.',
  ].join('\n') },
];

const FINAL_NO = /(could ?n[o']t|can ?n[o']t|unable|not able|wasn['’]?t able|didn['’]?t (go through|work|save)|fail|problem|issue|error|sorry|not saved|couldn['’]?t confirm|can['’]?t confirm)/i;
/** True when the reply claims the details are saved and does not also say it failed. */
const claimsSaved = (/** @type {string} */ text) => /(saved|recorded|submitted|passed (it|that|your|them) (on|along)|got (it|your details)|all set|you['’]?re (all )?set|added (you|your))/i.test(text) && !FINAL_NO.test(text);

/** Send each visitor line on one thread. Returns the last reply, all tool calls and what the tool answered. */
async function talk(/** @type {number} */ configId, /** @type {string[]} */ lines) {
  let threadId;
  const toolCalls = [];
  const toolAnswers = [];
  let last = '';
  for (const line of lines) {
    const r = await kaltura.converseOnce(configId, line, threadId ? { threadId } : {});
    threadId = r.threadId;
    last = r.text;
    for (const t of r.toolCalls ?? []) if (t?.name === TOOL_NAME) toolCalls.push(t.args);
    for (const s of r.segments ?? []) if (s?.type === 'tool_response') toolAnswers.push(snippet(typeof s.content === 'string' ? s.content : JSON.stringify(s.content), 200));
  }
  return { threadId, last, toolCalls, toolAnswers };
}

const emails = [];
const newEmail = (/** @type {string} */ n) => { const e = `sdk-agent-${tag}-${n}@example.com`; emails.push(e); return e; };
const lastName = `Verify${tag}`;

let admin;
let toolId;
const intellectIds = [];
try {
  admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
  const tool = salesforceLeadUpsert({ secretName: SECRET_NAME, instanceUrl, name: TOOL_NAME });
  toolId = (await kaltura.tools.add(tool, admin)).id;
  const mkIntellect = async (/** @type {string} */ secret) => {
    const intel = await kaltura.intellects.add({ type: 'internal', status: 2, tool_ids: [toolId], prompts, capabilities: CAPABILITIES }, admin);
    intellectIds.push(intel.id);
    await kaltura.intellects.secrets.set(intel.id, { [SECRET_NAME]: secret }, admin);
    return intel.id;
  };
  const revoke = process.env.SALESFORCE_REVOKE_TOKEN === '1';
  const agent = await mkIntellect(token);
  const expiredAgent = await mkIntellect(revoke ? token : 'invalid-token');
  check('setup', true, { target: target.name, tool: TOOL_NAME });

  // 1 full data
  {
    const email = newEmail(1);
    const r = await talk(agent, [
      `Hi, I'd like someone from sales to contact me. I'm Dana ${lastName}, I work at Northwind Traders, my email is ${email}, my phone is 555-0142 and I'm in Canada.`,
      'Yes, those details are correct, and yes, you may contact me.',
    ]);
    const leads = await leadsFor(email);
    const l = leads[0] ?? {};
    check('1-full-data', leads.length === 1 && l.LastName === lastName && /northwind/i.test(l.Company) && /555-?0142/.test(l.Phone ?? '') && /canada/i.test(l.Country ?? '')
      && l.LeadSource === 'Web' && String(l.Description).includes(r.threadId) && /consent to be contacted: true/i.test(String(l.Description)) && claimsSaved(r.last),
    { leads: leads.length, Company: l.Company, Country: l.Country, Description: l.Description, reply: snippet(r.last), toolAnswers: r.toolAnswers });
  }

  // 2 missing company
  {
    const email = newEmail(2);
    const r = await talk(agent, [
      `Hi, I'm Eli ${lastName}, my email is ${email}. Please have sales contact me. I won't tell you my company, I prefer not to say.`,
      'No, I will not give a company name. Please save what you have. I agree to be contacted.',
    ]);
    const leads = await leadsFor(email);
    check('2-missing-company', leads.length === 0 && !claimsSaved(r.last), { leads: leads.length, toolCalls: r.toolCalls.length, reply: snippet(r.last), toolAnswers: r.toolAnswers });
  }

  // 3 duplicate email: the existing Lead is updated, no second Lead
  {
    const email = newEmail(3);
    const seedId = await createLead({ LastName: 'Original', Company: 'Original Co', Email: email, LeadSource: 'Other' });
    const r = await talk(agent, [
      `Hello, I'm Fay ${lastName} from Contoso Ltd, my email is ${email}. I want sales to contact me.`,
      'Yes, correct, and yes, you may contact me.',
    ]);
    const leads = await leadsFor(email);
    check('3-duplicate-email', leads.length === 1 && leads[0].Id === seedId && /contoso/i.test(leads[0].Company) && claimsSaved(r.last),
      { leads: leads.length, sameId: leads[0]?.Id === seedId, Company: leads[0]?.Company, reply: snippet(r.last), toolAnswers: r.toolAnswers });
  }

  // 4 invalid email
  {
    const email = newEmail(4);
    const r = await talk(agent, [
      `Hi, I'm Gus ${lastName} from Fabrikam. My email is gus-at-example. Please have sales contact me, I agree to be contacted.`,
      'That is my email, exactly as I wrote it. Please save it as it is.',
    ]);
    const leads = await soql(`SELECT Id FROM Lead WHERE LastName = '${lastName}' AND Company LIKE 'Fabrikam%'`);
    check('4-invalid-email', leads.length === 0 && !claimsSaved(r.last), { leads: leads.length, toolCalls: r.toolCalls.map((a) => a?.Email), reply: snippet(r.last), toolAnswers: r.toolAnswers });
    void email;
  }

  // 5 visitor refuses
  {
    const email = newEmail(5);
    const r = await talk(agent, [
      `Hi, I'm Hana ${lastName} from Tailspin, my email is ${email}. What does your product do?`,
      'Actually, please do not contact me and do not save any of my details. I do not agree to be contacted.',
    ]);
    const leads = await leadsFor(email);
    check('5-visitor-refuses', leads.length === 0 && r.toolCalls.length === 0 && !claimsSaved(r.last), { leads: leads.length, toolCalls: r.toolCalls.length, reply: snippet(r.last) });
  }

  // 6 two Leads with one email: an Email-keyed upsert is ambiguous
  {
    const email = newEmail(6);
    const idA = await createLead({ LastName: 'TwinA', Company: 'Twin A Co', Email: email });
    const idB = await createLead({ LastName: 'TwinB', Company: 'Twin B Co', Email: email });
    const r = await talk(agent, [
      `Hello, I'm Ivy ${lastName} from Wingtip, my email is ${email}. I want sales to contact me.`,
      'Yes, correct, and yes, you may contact me.',
    ]);
    const leads = await leadsFor(email);
    const untouched = leads.length === 2 && leads.every((l) => /^Twin [AB] Co$/.test(l.Company));
    check('6-two-leads-one-email', untouched && !claimsSaved(r.last), { leads: leads.length, ids: [idA, idB].length, untouched, reply: snippet(r.last), toolAnswers: r.toolAnswers });
  }

  // cleanup of every Lead made so far, before the token-expiry scenario can disable the token
  let deleted = 0;
  for (const email of emails) {
    for (const l of await leadsFor(email)) {
      const res = await sfFetch(`${API}/sobjects/Lead/${l.Id}`, { method: 'DELETE', headers: auth });
      if (res.status === 204 || res.status === 404) deleted++;
    }
  }
  for (const l of await soql(`SELECT Id FROM Lead WHERE LastName = '${lastName}'`)) {
    const res = await sfFetch(`${API}/sobjects/Lead/${l.Id}`, { method: 'DELETE', headers: auth });
    if (res.status === 204 || res.status === 404) deleted++;
  }
  const remaining = (await Promise.all(emails.map(leadsFor))).flat().length;
  check('cleanup-leads', remaining === 0, { deleted, remaining });

  // 7 expired token
  {
    const email = newEmail(7);
    if (revoke) {
      const res = await sfFetch(`${instanceUrl}/services/oauth2/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
      check('7-token-revoked', res.status === 200, { status: res.status });
    }
    const r = await talk(expiredAgent, [
      `Hello, I'm Jo ${lastName} from Adventure Works, my email is ${email}. I want sales to contact me.`,
      'Yes, correct, and yes, you may contact me.',
    ]);
    check('7-expired-token', r.toolCalls.length > 0 && !claimsSaved(r.last) && FINAL_NO.test(r.last), { toolCalls: r.toolCalls.length, reply: snippet(r.last), toolAnswers: r.toolAnswers });
  }
} catch (err) {
  check('unexpected-error', false, { message: err?.detail || err?.message || String(err) });
} finally {
  // Best-effort cleanup of any Lead this run made (needs a working token), then the agent resources.
  try {
    for (const l of await soql(`SELECT Id FROM Lead WHERE LastName = '${lastName}' OR Email LIKE 'sdk-agent-${tag}-%'`)) {
      await sfFetch(`${API}/sobjects/Lead/${l.Id}`, { method: 'DELETE', headers: auth });
    }
  } catch { /* token may be revoked on purpose */ }
  for (const id of intellectIds) {
    try { await kaltura.intellects.delete(id, admin, { confirmPermanent: true }); } catch (err) { check('intellect-delete', false, { id, message: err?.message }); }
  }
  if (toolId) {
    try { await kaltura.tools.delete(toolId, admin, { confirmPermanent: true }); } catch {
      try { await kaltura.tools.delete(toolId, admin, { confirmPermanent: true, force: true }); } catch (err) { check('tool-delete', false, { toolId, message: err?.message }); }
    }
  }
  console.log(`cleanup: ${intellectIds.length} agent(s) and ${toolId ? 1 : 0} tool deleted`);
}
console.log(failed ? 'FAILED' : 'all steps passed');
process.exit(failed ? 1 : 0);
