#!/usr/bin/env node
/**
 * One-off, read-only check: with no filter at all, does feedback read-back
 * return ANYTHING for this partner? Tells "this partner has no rated messages"
 * apart from "a specific message/thread filter matched nothing". Admin token
 * only, no provisioning.
 *
 * Credentials, from the environment or a `.env` in the repo root:
 * `AGENTIC_PARTNER_ID`/`AGENTIC_ADMIN_SECRET`/`AGENTIC_API_URL`/`GENIE_URL`/
 * `KALTURA_API_ENDPOINT`, plus the same five names with an `ALT_` prefix for an
 * optional second target. URL overrides are always explicit, so a run never
 * falls back to the constructor's built-in defaults.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
} catch { /* no .env — credentials must already be in the environment */ }

const target = (name, prefix) => ({
  name,
  partnerId: process.env[`${prefix}AGENTIC_PARTNER_ID`],
  adminSecret: process.env[`${prefix}AGENTIC_ADMIN_SECRET`],
  agenticUrl: process.env[`${prefix}AGENTIC_API_URL`],
  genieUrl: process.env[`${prefix}GENIE_URL`],
  ovpUrl: process.env[`${prefix}KALTURA_API_ENDPOINT`],
});

// The secondary target is optional: skipped unless its credentials are set.
const ENVIRONMENTS = [target('primary', ''), target('secondary', 'ALT_')].filter((e) => e.partnerId && e.adminSecret);

if (ENVIRONMENTS.length === 0) {
  console.error('AGENTIC_PARTNER_ID and AGENTIC_ADMIN_SECRET are required (env or repo-root .env).');
  process.exit(1);
}

for (const env of ENVIRONMENTS) {
  const kaltura = new Management({ partnerId: env.partnerId, adminSecret: env.adminSecret, agenticUrl: env.agenticUrl, genieUrl: env.genieUrl, ovpUrl: env.ovpUrl });
  const admin = await kaltura.sessions.createAdminToken();

  const listRows = await kaltura.feedback.list(admin, { pageSize: 500 });
  console.log(`[${env.name}] feedback.list (no filter): rowCount=${listRows.length}`);
  if (listRows.length) console.log(`[${env.name}] sample row:`, JSON.stringify(listRows[0]));

  const report = await kaltura.feedback.report(admin);
  console.log(`[${env.name}] feedback.report (no filter): ${report === null ? 'null (empty body)' : `${report.length} bytes of CSV`}`);
  if (report) console.log(`[${env.name}] report head:`, report.split('\n').slice(0, 3).join(' | '));
}
