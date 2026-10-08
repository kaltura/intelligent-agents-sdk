#!/usr/bin/env node
/**
 * Live Salesforce Lead verification: checks `salesforceLeadUpsert` against a
 * real Salesforce org. It needs a Developer Edition org or a sandbox. Do not
 * point it at a production org: it creates, updates and deletes Leads.
 *
 *   SALESFORCE_INSTANCE_URL   e.g. https://yourorg.develop.my.salesforce.com
 *   SALESFORCE_ACCESS_TOKEN   a valid access token for an integration user
 *
 * Without both variables the script prints "skipped" and exits 0. For an org
 * that does not look like a dev or sandbox org, also set
 * SALESFORCE_CONFIRM_NON_PROD=1 to confirm it is not production.
 *
 * Steps: create, update the same email (no second Lead), missing Company,
 * missing LastName, invalid email, bad token, then cleanup of every Lead it
 * made. The logic lives in `scripts/lib/salesforce-lead-check.mjs`.
 *
 * This script talks to Salesforce only. It sends nothing to the Kaltura
 * backend, so there is no region or URL override to set. It does not run an
 * agent conversation. The token is never printed.
 *
 * Variables come from the environment or a .env file in the repo root.
 */
import { join } from 'node:path';
import { loadEnvFile, repoRoot } from './lib/target.mjs';
import { runLeadChecks } from './lib/salesforce-lead-check.mjs';

loadEnvFile(join(repoRoot, '.env'));

const instanceUrl = (process.env.SALESFORCE_INSTANCE_URL || '').replace(/\/$/, '');
const token = process.env.SALESFORCE_ACCESS_TOKEN || '';

if (!instanceUrl || !token) {
  console.log('skipped: no org credentials (set SALESFORCE_INSTANCE_URL and SALESFORCE_ACCESS_TOKEN to run this against a dev org)');
  process.exit(0);
}

let host;
try { host = new URL(instanceUrl).hostname; } catch { console.error('SALESFORCE_INSTANCE_URL is not a valid URL.'); process.exit(1); }
if (!/(\.develop\.|\.sandbox\.|\.scratch\.|-dev-ed\.)/.test(host) && process.env.SALESFORCE_CONFIRM_NON_PROD !== '1') {
  console.error(`refusing to run: ${host} does not look like a dev or sandbox org. Set SALESFORCE_CONFIRM_NON_PROD=1 if it is not production.`);
  process.exit(1);
}

const tag = Date.now().toString(36);
const { results } = await runLeadChecks({ fetch: globalThis.fetch, instanceUrl, token, tag });
for (const r of results) console.log(`[${r.ok ? 'ok' : 'FAIL'}] ${r.step}${r.detail ? ` ${JSON.stringify(r.detail)}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} step(s) failed` : 'all steps passed');
process.exit(failed ? 1 : 0);
