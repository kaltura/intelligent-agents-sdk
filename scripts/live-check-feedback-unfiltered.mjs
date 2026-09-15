#!/usr/bin/env node
/**
 * One-off, read-only check: does `feedback/list` / `feedback/report` return
 * ANYTHING at all for the partner with no filter — i.e. is the `feedback`
 * table truly empty for this partner, or just not matching a specific
 * message/thread id? Both environments, admin token only, no provisioning.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

for (const envPath of [resolve(__dirname, '../../.env'), resolve(__dirname, '../.env')]) {
  try {
    const env = readFileSync(envPath, 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }
  } catch { /* missing is fine */ }
}

const ENVIRONMENTS = [
  { name: 'nvq2', partnerId: process.env.NVQ2_PARTNER_ID_1, adminSecret: process.env.NVQ2_ADMIN_SECRET_1, agenticUrl: process.env.NVQ2_AGENTIC_API_URL, genieUrl: process.env.NVQ2_GENIE_URL, ovpUrl: process.env.NVQ2_KALTURA_API_ENDPOINT },
  { name: 'nvp1', partnerId: process.env.NVP1_AGENTIC_PARTNER_ID, adminSecret: process.env.NVP1_AGENTIC_ADMIN_SECRET, agenticUrl: process.env.NVP1_AGENTIC_API_URL, genieUrl: process.env.NVP1_GENIE_URL, ovpUrl: process.env.NVP1_KALTURA_API_ENDPOINT },
];

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
