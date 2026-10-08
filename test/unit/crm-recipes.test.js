import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubspotContactUpsert, salesforceContactUpsert, salesforceLeadUpsert } from '../../src/management/crm-recipes.js';
import * as management from '../../src/management/index.js';

test('hubspotContactUpsert builds a valid api tool targeting HubSpot CRM', () => {
  const tool = hubspotContactUpsert({ secretName: 'HUBSPOT_TOKEN' });
  assert.equal(tool.type, 'api');
  assert.equal(tool.name, 'hubspot_contact_upsert');
  assert.equal(new URL(tool.request.url).hostname, 'api.hubapi.com');
  assert.equal(tool.request.method, 'POST');
  assert.ok(tool.request.headers.Authorization.includes('HUBSPOT_TOKEN'));
  assert.ok('email' in tool.args, 'email arg present');
  assert.equal(tool.args.email.required, true);
});

test('hubspotContactUpsert accepts custom name, description, and properties', () => {
  const tool = hubspotContactUpsert({
    secretName: 'HS',
    name: 'my_hs_tool',
    description: 'Custom',
    propertiesToCapture: ['email', 'company'],
  });
  assert.equal(tool.name, 'my_hs_tool');
  assert.ok('company' in tool.args);
});

test('hubspotContactUpsert throws when secretName is missing', () => {
  assert.throws(() => hubspotContactUpsert({}), /secretName/);
});

test('salesforceContactUpsert builds a valid PATCH api tool targeting Salesforce', () => {
  const tool = salesforceContactUpsert({
    secretName: 'SF_TOKEN',
    instanceUrl: 'https://myorg.my.salesforce.com',
  });
  assert.equal(tool.type, 'api');
  assert.equal(tool.name, 'salesforce_contact_upsert');
  assert.equal(new URL(tool.request.url).hostname, 'myorg.my.salesforce.com');
  assert.equal(tool.request.method, 'PATCH');
  assert.ok('Email' in tool.args);
  assert.equal(tool.args.Email.required, true, 'external ID field is required');
});

test('salesforceContactUpsert strips trailing slash from instanceUrl', () => {
  const tool = salesforceContactUpsert({ secretName: 'SF', instanceUrl: 'https://myorg.salesforce.com/' });
  assert.ok(!tool.request.url.includes('//services'), 'double-slash from trailing / must not appear');
});

test('salesforceContactUpsert throws when instanceUrl is missing', () => {
  assert.throws(() => salesforceContactUpsert({ secretName: 'SF' }), /instanceUrl/);
});

test('salesforceContactUpsert throws when externalIdField not in fieldsToCapture', () => {
  assert.throws(
    () => salesforceContactUpsert({ secretName: 'SF', instanceUrl: 'https://x.sf.com', externalIdField: 'CustomId__c', fieldsToCapture: ['Email'] }),
    /externalIdField/,
  );
});

test('salesforceContactUpsert requires LastName when fieldsToCapture is given', () => {
  assert.throws(
    () => salesforceContactUpsert({ secretName: 'SF', instanceUrl: 'https://x.sf.com', fieldsToCapture: ['Email', 'FirstName'] }),
    /must include "LastName"/,
  );
  assert.ok(salesforceContactUpsert({ secretName: 'SF', instanceUrl: 'https://x.sf.com', fieldsToCapture: ['Email', 'LastName'] }));
});

test('both Salesforce builders accept only a clean https origin as instanceUrl', () => {
  for (const build of [salesforceContactUpsert, salesforceLeadUpsert]) {
    const bad = [
      'http://x.my.salesforce.com',
      'https://x.my.salesforce.com/services',
      'https://x.my.salesforce.com/?a=1',
      'https://x.my.salesforce.com?',
      'https://x.my.salesforce.com/#frag',
      'https://user:pw@x.my.salesforce.com',
      'x.my.salesforce.com',
      'javascript:alert(1)',
    ];
    for (const instanceUrl of bad) {
      assert.throws(() => build({ secretName: 'SF', instanceUrl }), /instanceUrl must be an https origin/, instanceUrl);
    }
    const tool = build({ secretName: 'SF', instanceUrl: 'https://X.my.salesforce.com/' });
    assert.ok(tool.request.url.startsWith('https://x.my.salesforce.com/services/data/'), 'origin is normalized, no double slash');
  }
});

test('hubspotContactUpsert says create, not upsert, and maps only the success fields', () => {
  const tool = hubspotContactUpsert({ secretName: 'HS' });
  assert.match(tool.description, /Create a new contact/);
  assert.match(tool.description, /does not update/);
  assert.doesNotMatch(tool.description, /upsert/i);
  assert.match(tool.description, /ONLY if the result has a contact_id/);
  assert.equal(tool.response_mapping.contact_id, 'id');
  assert.deepEqual(tool.response_mapping, { contact_id: 'id', result: 'properties' });
});

test('salesforceContactUpsert maps success only and warns about an empty result', () => {
  const tool = salesforceContactUpsert({ secretName: 'SF', instanceUrl: 'https://x.my.salesforce.com' });
  assert.deepEqual(tool.response_mapping, { result: 'id', success: 'success' });
  assert.match(tool.description, /result is empty, you cannot confirm/);
  assert.match(tool.description, /never say it is saved/i);
  assert.match(tool.request.url, /\/services\/data\/v59\.0\/sobjects\/Contact\/Email\//, 'Contact URL is unchanged');
});

test('a custom description replaces the default guidance', () => {
  const tool = salesforceLeadUpsert({ secretName: 'SF', instanceUrl: 'https://x.my.salesforce.com', description: 'Mine' });
  assert.equal(tool.description, 'Mine');
});

// ---------- salesforceLeadUpsert ----------

const LEAD_CFG = { secretName: 'SF_TOKEN', instanceUrl: 'https://myorg.develop.my.salesforce.com' };

test('salesforceLeadUpsert is exported from the management entry point', () => {
  assert.equal(management.salesforceLeadUpsert, salesforceLeadUpsert);
});

test('salesforceLeadUpsert builds the exact request shape', () => {
  const tool = salesforceLeadUpsert(LEAD_CFG);
  assert.equal(tool.type, 'api');
  assert.equal(tool.name, 'salesforce_lead_upsert');
  assert.equal(tool.request.method, 'PATCH');
  assert.equal(tool.request.url, 'https://myorg.develop.my.salesforce.com/services/data/v68.0/sobjects/Lead/Email/{Email}');
  assert.equal(tool.request.headers.Authorization, 'Bearer {{secrets.SF_TOKEN}}');
  assert.equal(tool.request.headers['Content-Type'], 'application/json');
  assert.deepEqual(tool.request.body, {
    FirstName: '{FirstName}',
    LastName: '{LastName}',
    Company: '{Company}',
    Phone: '{Phone}',
    Country: '{Country}',
    LeadSource: 'Web',
    Description: 'Captured by a Kaltura AI agent. Thread: {{ sys__thread_id }}. Consent to be contacted: {consent}.',
  });
});

test('salesforceLeadUpsert defaults: fields, required args, consent arg', () => {
  const tool = salesforceLeadUpsert(LEAD_CFG);
  assert.deepEqual(Object.keys(tool.args), ['FirstName', 'LastName', 'Company', 'Email', 'Phone', 'Country', 'consent']);
  const required = Object.entries(tool.args).filter(([, a]) => a.required).map(([k]) => k);
  assert.deepEqual(required, ['LastName', 'Company', 'Email', 'consent']);
  assert.equal(tool.args.consent.type, 'bool');
  assert.deepEqual(Object.keys(tool.response_mapping), ['result', 'success']);
  assert.match(tool.description, /upsert on Email/);
  assert.match(tool.args.Email.prompt, /"@" as "%40", "\+" as "%2B", "\/" as "%2F"/, 'the key arg tells the model to percent-encode');
  assert.ok(!JSON.stringify(tool.request.headers).includes('{Email}'), 'headers never take args');
  assert.match(tool.description, /ONLY if the result shows success true or an id/);
});

test('optional args ask for an empty string, required args do not', () => {
  const lead = salesforceLeadUpsert(LEAD_CFG);
  assert.match(lead.args.Phone.prompt, /pass an empty string/);
  assert.match(lead.args.Country.prompt, /pass an empty string/);
  assert.match(lead.args.Country.prompt, /full country name.*"United States"/, 'a country code is rejected by orgs that use country picklists');
  for (const k of ['LastName', 'Company', 'Email']) assert.doesNotMatch(lead.args[k].prompt, /empty string/, k);
  const hs = hubspotContactUpsert({ secretName: 'HS' });
  assert.match(hs.args.firstname.prompt, /pass an empty string/);
  assert.doesNotMatch(hs.args.email.prompt, /empty string/);
});

test('salesforceLeadUpsert strips a trailing slash and accepts overrides', () => {
  const tool = salesforceLeadUpsert({
    ...LEAD_CFG,
    instanceUrl: 'https://myorg.my.salesforce.com/',
    apiVersion: 'v70.0',
    leadSource: 'Partner Referral',
    name: 'my_lead_tool',
    externalIdField: 'Ext_Id__c',
    fieldsToCapture: ['LastName', 'Company', 'Ext_Id__c'],
  });
  assert.equal(tool.name, 'my_lead_tool');
  assert.equal(tool.request.url, 'https://myorg.my.salesforce.com/services/data/v70.0/sobjects/Lead/Ext_Id__c/{Ext_Id__c}');
  assert.equal(tool.request.body.LeadSource, 'Partner Referral');
  assert.ok(!('Ext_Id__c' in tool.request.body), 'the upsert key is in the URL, not the body');
  assert.equal(tool.args.Ext_Id__c.required, true);
});

test('salesforceLeadUpsert requireConsent:false drops the consent arg and its Description text', () => {
  const tool = salesforceLeadUpsert({ ...LEAD_CFG, requireConsent: false });
  assert.ok(!('consent' in tool.args));
  assert.equal(tool.request.body.Description, 'Captured by a Kaltura AI agent. Thread: {{ sys__thread_id }}.');
  assert.doesNotMatch(tool.description, /agree to be contacted/);
});

test('salesforceLeadUpsert throws on missing secretName or instanceUrl', () => {
  assert.throws(() => salesforceLeadUpsert({}), /secretName/);
  assert.throws(() => salesforceLeadUpsert({ secretName: 'SF' }), /instanceUrl/);
});

test('salesforceLeadUpsert throws when LastName, Company or the upsert key is missing from fieldsToCapture', () => {
  assert.throws(() => salesforceLeadUpsert({ ...LEAD_CFG, fieldsToCapture: ['Email', 'Company'] }), /must include "LastName"/);
  assert.throws(() => salesforceLeadUpsert({ ...LEAD_CFG, fieldsToCapture: ['Email', 'LastName'] }), /must include "Company"/);
  assert.throws(() => salesforceLeadUpsert({ ...LEAD_CFG, fieldsToCapture: ['LastName', 'Company'] }), /externalIdField "Email"/);
  assert.throws(() => salesforceLeadUpsert({ ...LEAD_CFG, fieldsToCapture: [] }), /non-empty string array/);
});

test('salesforceLeadUpsert refuses LeadSource or Description in fieldsToCapture', () => {
  for (const f of ['LeadSource', 'Description']) {
    assert.throws(() => salesforceLeadUpsert({ ...LEAD_CFG, fieldsToCapture: ['Email', 'LastName', 'Company', f] }), new RegExp(`"${f}" is set by the builder`));
  }
});

test('salesforceLeadUpsert validates apiVersion and leadSource', () => {
  assert.throws(() => salesforceLeadUpsert({ ...LEAD_CFG, apiVersion: '68' }), /apiVersion/);
  assert.throws(() => salesforceLeadUpsert({ ...LEAD_CFG, leadSource: '' }), /leadSource/);
});

test('salesforceLeadUpsert refuses a captured field that collides with the consent arg', () => {
  assert.throws(
    () => salesforceLeadUpsert({ ...LEAD_CFG, fieldsToCapture: ['Email', 'LastName', 'Company', 'consent'] }),
    /"consent" is a tool argument set by the builder/,
  );
  // With consent off the name is free to use as a field.
  assert.ok(salesforceLeadUpsert({ ...LEAD_CFG, requireConsent: false, fieldsToCapture: ['Email', 'LastName', 'Company', 'consent'] }));
});

test('salesforceLeadUpsert requireConsent must be a boolean', () => {
  for (const v of ['false', 0, null, {}]) {
    assert.throws(() => salesforceLeadUpsert({ ...LEAD_CFG, requireConsent: v }), /requireConsent must be a boolean/);
  }
});
