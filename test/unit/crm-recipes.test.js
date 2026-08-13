import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubspotContactUpsert, salesforceContactUpsert } from '../../src/management/crm-recipes.js';

test('hubspotContactUpsert builds a valid api tool targeting HubSpot CRM', () => {
  const tool = hubspotContactUpsert({ secretName: 'HUBSPOT_TOKEN' });
  assert.equal(tool.type, 'api');
  assert.equal(tool.name, 'hubspot_contact_upsert');
  assert.ok(tool.request.url.includes('hubapi.com'));
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
  assert.ok(tool.request.url.includes('myorg.my.salesforce.com'));
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
