/**
 * CRM AI-SDR recipe helpers. Build validated `api` tool configs for common
 * CRM lead and contact capture (HubSpot create, Salesforce Contact and Lead
 * upsert). These are PURE
 * config builders — they produce a `GenieToolConfig` object ready to pass to
 * `mgmt.tools.add()` (tools are a separate, partner-level entity), then link
 * it with `mgmt.intellectConfig.setToolIds(configId, [toolId], ks)`.
 * No network calls; no secrets stored here (inject via `mgmt.intellects.secrets.set`).
 *
 * See README.md ("AI-SDR / CRM lead capture") for a walkthrough.
 *
 * Each tool maps the CRM response to fields the agent can read, and its
 * default description tells the agent to say "saved" only when the result
 * proves it. A custom `description` replaces that guidance.
 *
 * Usage:
 *   const tool = hubspotContactUpsert({ secretName: 'HUBSPOT_TOKEN' });
 *   const { id } = await mgmt.tools.add(tool, adminKs);
 *   await mgmt.intellectConfig.setToolIds(configId, [id], adminKs);
 */
import { api } from './tools.js';

const HUBSPOT_RESULT_RULES = 'Tell the visitor the contact is saved ONLY if the result has a contact_id. If the call fails or returns an error status (for example the email already exists), say you could not save it. Never say it is saved otherwise.';

const SALESFORCE_RESULT_RULES = 'Tell the visitor the details are saved ONLY if the result shows success true or an id. If the call fails or returns an error status, say you could not save it. If the result is empty, you cannot confirm the save: say you could not confirm it. Never say it is saved otherwise.';

/**
 * Response mapping shared by the Salesforce builders. A successful insert
 * returns `{id, success}`. An update returns an empty body, so both keys are
 * then empty. An error status never reaches the mapping: the agent only gets
 * a generic "API returned error status" line.
 */
const SALESFORCE_RESPONSE_MAPPING = {
  result: 'id',
  success: 'success',
};

/**
 * Build a validated HubSpot Contacts v3 CREATE tool (the name says "upsert"
 * for compatibility; it does not update).
 * Creates a contact via `POST /crm/v3/objects/contacts`. HubSpot rejects the
 * call with a conflict if a contact with the same email already exists. Use
 * it for new-lead capture, not for updating an existing contact. The agent
 * collects the fields listed in `propertiesToCapture` and writes them to the
 * new HubSpot contact. The result carries `contact_id` on success. A failure
 * (such as that conflict) reaches the agent only as a generic error status.
 *
 * @param {object} [cfg]
 * @param {string} [cfg.secretName]      Name of the HubSpot private-app token secret (set via `setSecrets`) — REQUIRED (checked at runtime; declared optional in the JSDoc only so an omitted `cfg` degrades to the same TypeError below instead of crashing on `undefined.secretName`).
 * @param {string[]} [cfg.propertiesToCapture]  HubSpot property keys to send (default: `['email','firstname','lastname']`).
 * @param {string} [cfg.name]            Tool name (default: `'hubspot_contact_upsert'`).
 * @param {string} [cfg.description]     Tool description fed to the LLM (default: auto-generated).
 * @returns {import('./tools.js').GenieToolConfig}
 */
export function hubspotContactUpsert(cfg = {}) {
  const secretName = cfg.secretName;
  if (!secretName || typeof secretName !== 'string') throw new TypeError('hubspotContactUpsert: cfg.secretName is required (the HubSpot private-app token secret name).');
  const props = cfg.propertiesToCapture || ['email', 'firstname', 'lastname'];
  if (!Array.isArray(props) || props.length === 0 || props.some((p) => typeof p !== 'string' || !p.trim())) {
    throw new TypeError('hubspotContactUpsert: propertiesToCapture must be a non-empty string array.');
  }
  const name = cfg.name || 'hubspot_contact_upsert';
  const description = cfg.description || `Create a new contact in HubSpot CRM. This does not update an existing contact. Collect the user's information (${props.join(', ')}) and call this tool once to save them. ${HUBSPOT_RESULT_RULES}`;

  /** @type {Record<string,{type:string,prompt:string,required:boolean}>} */
  const args = {};
  for (const prop of props) {
    args[prop] = { type: 'str', prompt: `Contact ${prop}`, required: prop === 'email' };
  }

  return api({
    name,
    description,
    args,
    request: {
      url: 'https://api.hubapi.com/crm/v3/objects/contacts',
      method: 'POST',
      headers: {
        Authorization: `Bearer {{secrets.${secretName}}}`,
        'Content-Type': 'application/json',
      },
      body: {
        properties: Object.fromEntries(props.map((p) => [p, `{${p}}`])),
      },
    },
    responseMapping: { contact_id: 'id', result: 'properties' },
  });
}

/**
 * Validate a Salesforce instance URL: an `https:` origin with no credentials,
 * path, query or hash. Returns the origin without a trailing slash.
 * @param {string} fn @param {string} value
 */
function parseInstanceUrl(fn, value) {
  const hint = `${fn}: cfg.instanceUrl must be an https origin such as "https://yourorg.my.salesforce.com" (no path, query or credentials).`;
  let u;
  try { u = new URL(value); } catch { throw new TypeError(hint); }
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash || /[?#]/.test(value)) throw new TypeError(hint);
  return u.origin;
}

/**
 * Shared builder for the Salesforce sobject upsert tools. Validates the
 * common config, then builds `PATCH {instanceUrl}/services/data/{apiVersion}/sobjects/{sobject}/{key}/{value}`.
 * @param {object} o
 * @param {string} o.fn                 Public builder name, for error messages.
 * @param {string} o.sobject            Salesforce object (`Contact`, `Lead`).
 * @param {string} o.apiVersion         REST API version, such as `v68.0`.
 * @param {object} o.cfg                The caller's config.
 * @param {string[]} o.defaultFields    Fields captured when `cfg.fieldsToCapture` is absent.
 * @param {string} o.defaultName        Default tool name.
 * @param {string[]} [o.alsoRequired]   Fields the object needs besides the upsert key.
 * @param {Record<string,string>} [o.fixedBody]  Literal or templated body values the agent does not supply.
 * @param {Record<string,{type:string,prompt:string,required:boolean}>} [o.extraArgs]  Extra tool args that are not Salesforce fields.
 * @param {(fields:string[], key:string) => string} o.describe  Default description.
 * @returns {import('./tools.js').GenieToolConfig}
 */
function buildSalesforceUpsert(o) {
  const { fn, sobject, cfg } = o;
  const secretName = cfg.secretName;
  if (!secretName || typeof secretName !== 'string') throw new TypeError(`${fn}: cfg.secretName is required (the Salesforce access-token secret name).`);
  if (!cfg.instanceUrl || typeof cfg.instanceUrl !== 'string') throw new TypeError(`${fn}: cfg.instanceUrl is required (e.g. "https://yourorg.my.salesforce.com").`);
  const instanceUrl = parseInstanceUrl(fn, cfg.instanceUrl);
  const externalIdField = cfg.externalIdField || 'Email';
  const fields = cfg.fieldsToCapture || o.defaultFields;
  if (!Array.isArray(fields) || fields.length === 0 || fields.some((f) => typeof f !== 'string' || !f.trim())) {
    throw new TypeError(`${fn}: fieldsToCapture must be a non-empty string array.`);
  }
  if (!fields.includes(externalIdField)) throw new TypeError(`${fn}: fieldsToCapture must include the externalIdField "${externalIdField}".`);
  for (const f of o.alsoRequired || []) {
    if (!fields.includes(f)) throw new TypeError(`${fn}: fieldsToCapture must include "${f}" (Salesforce requires it on a ${sobject}).`);
  }
  for (const f of Object.keys(o.fixedBody || {})) {
    if (fields.includes(f)) throw new TypeError(`${fn}: "${f}" is set by the builder and cannot be in fieldsToCapture.`);
  }
  for (const f of Object.keys(o.extraArgs || {})) {
    if (fields.includes(f)) throw new TypeError(`${fn}: "${f}" is a tool argument set by the builder and cannot be in fieldsToCapture.`);
  }
  const required = new Set([externalIdField, ...(o.alsoRequired || [])]);

  /** @type {Record<string,{type:string,prompt:string,required:boolean}>} */
  const args = {};
  for (const field of fields) {
    const prompt = field === externalIdField
      ? `${sobject} ${field}. It goes into a URL: write "@" as "%40" and percent-encode other special characters.`
      : `${sobject} ${field}`;
    args[field] = { type: 'str', prompt, required: required.has(field) };
  }
  Object.assign(args, o.extraArgs);

  return api({
    name: cfg.name || o.defaultName,
    description: cfg.description || o.describe(fields, externalIdField),
    args,
    request: {
      url: `${instanceUrl}/services/data/${o.apiVersion}/sobjects/${sobject}/${externalIdField}/{${externalIdField}}`,
      method: 'PATCH',
      headers: {
        Authorization: `Bearer {{secrets.${secretName}}}`,
        'Content-Type': 'application/json',
      },
      body: {
        ...Object.fromEntries(fields.filter((f) => f !== externalIdField).map((f) => [f, `{${f}}`])),
        ...o.fixedBody,
      },
    },
    // An upsert PATCH returns 201 + {id, success} on insert and an EMPTY 204 on
    // update, so both keys are empty on update. The default description tells
    // the agent that an empty result is "unconfirmed", never "saved".
    responseMapping: { ...SALESFORCE_RESPONSE_MAPPING },
  });
}

/**
 * Build a validated Salesforce Contact upsert tool.
 * Upserts a contact using Salesforce REST API sobjects endpoint with a named
 * External ID field. Requires a Salesforce Connected App OAuth2 access token
 * stored as a secret. Salesforce access tokens expire (about 2 hours by
 * default), so see README.md ("AI-SDR / CRM lead capture") for the token options.
 * The result carries `result` (the id) and `success` on insert, and nothing on
 * update (an empty 204). A failure reaches the agent only as a generic error
 * status. The default description tells the agent not to say "saved" on an
 * empty or failed result.
 *
 * Tool args are filled into the URL and body as `{Name}`. They go in raw, and
 * a raw `@` in the URL makes the call fail, so the upsert key arg tells the
 * model to write `@` as `%40`.
 *
 * @param {object} [cfg]
 * @param {string} [cfg.secretName]       Name of the Salesforce access-token secret (set via `setSecrets`) — REQUIRED (checked at runtime; declared optional in the JSDoc only so an omitted `cfg` degrades to the same TypeError below instead of crashing on `undefined.secretName`).
 * @param {string} [cfg.instanceUrl]      Salesforce instance URL (e.g. `https://yourorg.my.salesforce.com`). It must be an `https:` origin with no path, query or credentials. REQUIRED (same runtime-checked contract as `secretName` above).
 * @param {string} [cfg.externalIdField]  External ID field on Contact used for upsert (default: `'Email'`).
 * @param {string[]} [cfg.fieldsToCapture] Salesforce field API names to capture (default: `['Email','FirstName','LastName']`). Must include `LastName` and the upsert key.
 * @param {string} [cfg.name]             Tool name (default: `'salesforce_contact_upsert'`).
 * @param {string} [cfg.description]      Tool description fed to the LLM (default: auto-generated). A custom value replaces the "say saved only on success" guidance.
 * @returns {import('./tools.js').GenieToolConfig}
 */
export function salesforceContactUpsert(cfg = {}) {
  return buildSalesforceUpsert({
    fn: 'salesforceContactUpsert',
    sobject: 'Contact',
    apiVersion: 'v59.0',
    cfg,
    defaultFields: ['Email', 'FirstName', 'LastName'],
    defaultName: 'salesforce_contact_upsert',
    alsoRequired: ['LastName'],
    describe: (fields) => `Create or update a Salesforce Contact (upsert). Collect the user's information (${fields.join(', ')}) and call this tool to save them. ${SALESFORCE_RESULT_RULES}`,
  });
}

/**
 * Build a validated Salesforce Lead upsert tool.
 * Upserts a Lead with `PATCH /sobjects/Lead/{externalIdField}/{value}`. A new
 * Lead needs `LastName` and `Company`, so both are required tool args with the
 * upsert key (default `Email`, which Salesforce accepts as an upsert key on
 * Lead). The builder sets two body fields the agent cannot change:
 * `LeadSource` (default `'Web'`) and `Description`, which holds the thread id
 * and the consent answer.
 *
 * By default the tool also has a required boolean arg `consent`. Its prompt
 * tells the agent to call the tool only after the visitor agrees to be
 * contacted. The value is written to `Description` (Salesforce has no standard
 * Lead consent field). Set `requireConsent: false` to drop it.
 *
 * Salesforce access tokens expire (about 2 hours by default). See README.md
 * ("AI-SDR / CRM lead capture") for the token options. The result fields are
 * the same as {@link salesforceContactUpsert}: an empty result (an update) is
 * unconfirmed, and the default description tells the agent so.
 *
 * @param {object} [cfg]
 * @param {string} [cfg.secretName]       Name of the Salesforce access-token secret (set via `setSecrets`). REQUIRED (runtime-checked, like `salesforceContactUpsert`).
 * @param {string} [cfg.instanceUrl]      Salesforce instance URL (e.g. `https://yourorg.my.salesforce.com`). Same rules as `salesforceContactUpsert`. REQUIRED (runtime-checked).
 * @param {string} [cfg.externalIdField]  Upsert key on Lead (default: `'Email'`). It must be in `fieldsToCapture`. A custom External ID field needs field access granted to the integration user.
 * @param {string[]} [cfg.fieldsToCapture] Lead field API names to capture (default: `['FirstName','LastName','Company','Email','Phone','Country']`). Must include `LastName`, `Company` and the upsert key. `LeadSource` and `Description` are set by the builder and cannot be listed.
 * @param {string} [cfg.leadSource]       Fixed `LeadSource` value (default: `'Web'`). Must be a valid Lead Source value in the org.
 * @param {boolean} [cfg.requireConsent]  Add the required `consent` arg and record it in `Description` (default: `true`).
 * @param {string} [cfg.apiVersion]       Salesforce REST API version (default: `'v68.0'`).
 * @param {string} [cfg.name]             Tool name (default: `'salesforce_lead_upsert'`).
 * @param {string} [cfg.description]      Tool description fed to the LLM (default: auto-generated). A custom value replaces the "say saved only on success" guidance.
 * @returns {import('./tools.js').GenieToolConfig}
 */
export function salesforceLeadUpsert(cfg = {}) {
  const apiVersion = cfg.apiVersion || 'v68.0';
  if (typeof apiVersion !== 'string' || !/^v\d{2,3}\.0$/.test(apiVersion)) throw new TypeError('salesforceLeadUpsert: apiVersion must look like "v68.0".');
  const leadSource = cfg.leadSource === undefined ? 'Web' : cfg.leadSource;
  if (typeof leadSource !== 'string' || !leadSource.trim()) throw new TypeError('salesforceLeadUpsert: leadSource must be a non-empty string.');
  if (cfg.requireConsent !== undefined && typeof cfg.requireConsent !== 'boolean') throw new TypeError('salesforceLeadUpsert: requireConsent must be a boolean.');
  const requireConsent = cfg.requireConsent !== false;
  const note = 'Captured by a Kaltura AI agent. Thread: {{ sys__thread_id }}.';
  return buildSalesforceUpsert({
    fn: 'salesforceLeadUpsert',
    sobject: 'Lead',
    apiVersion,
    cfg,
    defaultFields: ['FirstName', 'LastName', 'Company', 'Email', 'Phone', 'Country'],
    defaultName: 'salesforce_lead_upsert',
    alsoRequired: ['LastName', 'Company'],
    fixedBody: { LeadSource: leadSource, Description: requireConsent ? `${note} Consent to be contacted: {consent}.` : note },
    extraArgs: requireConsent
      ? { consent: { type: 'bool', prompt: 'True only if the visitor clearly agreed to be contacted about their request. If they refused or did not answer, do not call this tool.', required: true } }
      : undefined,
    describe: (fields, key) => `Create or update a Salesforce Lead (upsert on ${key}). Ask the visitor for any missing details (${fields.join(', ')}). LastName and Company are required. Confirm the details with the visitor${requireConsent ? ' and ask if they agree to be contacted' : ''}, then call this tool once. ${SALESFORCE_RESULT_RULES}`,
  });
}
