/**
 * CRM AI-SDR recipe helpers. Build validated `api` tool configs for common
 * CRM contact-upsert integrations (HubSpot, Salesforce). These are PURE
 * config builders — they produce a `GenieToolConfig` object ready to pass to
 * `mgmt.tools.add()` (tools are a separate, partner-level entity), then link
 * it with `mgmt.intellectConfig.setToolIds(configId, [toolId], ks)`.
 * No network calls; no secrets stored here (inject via `mgmt.intellects.secrets.set`).
 *
 * These builders are aimed at external SDK consumers building an AI-SDR or
 * concierge agent; see `sdk/README.md` ("AI-SDR / CRM lead capture") for a
 * fuller walkthrough.
 *
 * Usage:
 *   const tool = hubspotContactUpsert({ secretName: 'HUBSPOT_TOKEN' });
 *   const { id } = await mgmt.tools.add(tool, adminKs);
 *   await mgmt.intellectConfig.setToolIds(configId, [id], adminKs);
 */
import { api } from './tools.js';

/**
 * Build a validated HubSpot Contacts v3 upsert tool.
 * Upserts a contact by email using the HubSpot CRM Contacts API (create-or-update
 * semantics via `POST /crm/v3/objects/contacts`). The agent collects the fields
 * listed in `propertiesToCapture` and writes them to the HubSpot contact.
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
  const description = cfg.description || `Capture and upsert a contact into HubSpot CRM. Collect the user's information (${props.join(', ')}) and call this tool to save them as a HubSpot contact.`;

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
        properties: Object.fromEntries(props.map((p) => [p, `{{args.${p}}}`])),
      },
    },
    responseMapping: { contact_id: 'id', result: 'properties' },
  });
}

/**
 * Build a validated Salesforce Contact upsert tool.
 * Upserts a contact using Salesforce REST API sobjects endpoint with a named
 * External ID field. Requires a Salesforce Connected App OAuth2 access token
 * stored as a secret.
 *
 * @param {object} [cfg]
 * @param {string} [cfg.secretName]       Name of the Salesforce access-token secret (set via `setSecrets`) — REQUIRED (checked at runtime; declared optional in the JSDoc only so an omitted `cfg` degrades to the same TypeError below instead of crashing on `undefined.secretName`).
 * @param {string} [cfg.instanceUrl]      Salesforce instance URL (e.g. `https://yourorg.my.salesforce.com`) — REQUIRED (same runtime-checked contract as `secretName` above).
 * @param {string} [cfg.externalIdField]  External ID field on Contact used for upsert (default: `'Email'`).
 * @param {string[]} [cfg.fieldsToCapture] Salesforce field API names to capture (default: `['Email','FirstName','LastName']`).
 * @param {string} [cfg.name]             Tool name (default: `'salesforce_contact_upsert'`).
 * @param {string} [cfg.description]      Tool description fed to the LLM (default: auto-generated).
 * @returns {import('./tools.js').GenieToolConfig}
 */
export function salesforceContactUpsert(cfg = {}) {
  const secretName = cfg.secretName;
  if (!secretName || typeof secretName !== 'string') throw new TypeError('salesforceContactUpsert: cfg.secretName is required (the Salesforce access-token secret name).');
  if (!cfg.instanceUrl || typeof cfg.instanceUrl !== 'string') throw new TypeError('salesforceContactUpsert: cfg.instanceUrl is required (e.g. "https://yourorg.my.salesforce.com").');
  const instanceUrl = cfg.instanceUrl.replace(/\/$/, '');
  const externalIdField = cfg.externalIdField || 'Email';
  const fields = cfg.fieldsToCapture || ['Email', 'FirstName', 'LastName'];
  if (!Array.isArray(fields) || fields.length === 0 || fields.some((f) => typeof f !== 'string' || !f.trim())) {
    throw new TypeError('salesforceContactUpsert: fieldsToCapture must be a non-empty string array.');
  }
  if (!fields.includes(externalIdField)) throw new TypeError(`salesforceContactUpsert: fieldsToCapture must include the externalIdField "${externalIdField}".`);
  const name = cfg.name || 'salesforce_contact_upsert';
  const description = cfg.description || `Capture and upsert a contact into Salesforce CRM. Collect the user's information (${fields.join(', ')}) and call this tool to save them as a Salesforce Contact.`;

  /** @type {Record<string,{type:string,prompt:string,required:boolean}>} */
  const args = {};
  for (const field of fields) {
    args[field] = { type: 'str', prompt: `Contact ${field}`, required: field === externalIdField };
  }

  const url = `${instanceUrl}/services/data/v59.0/sobjects/Contact/${externalIdField}/{{args.${externalIdField}}}`;

  return api({
    name,
    description,
    args,
    request: {
      url,
      method: 'PATCH',
      headers: {
        Authorization: `Bearer {{secrets.${secretName}}}`,
        'Content-Type': 'application/json',
      },
      body: Object.fromEntries(fields.filter((f) => f !== externalIdField).map((f) => [f, `{{args.${f}}}`])),
    },
    // Salesforce's upsert-by-external-id PATCH returns 201+{id} on insert but
    // 204 with an EMPTY body on update — there's no field guaranteed present on
    // both, and the backend's dot-path mapping has no "whole response" root
    // token, so map the one field that matters when it exists; the real product
    // of this tool is the side effect (the contact write), not the mapped output.
    responseMapping: { result: 'id' },
  });
}
