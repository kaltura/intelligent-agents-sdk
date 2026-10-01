#!/usr/bin/env node
/**
 * One-off, read-only check: with no filter at all, does feedback read-back
 * return ANYTHING for this partner? Tells "this partner has no rated messages"
 * apart from "a specific message/thread filter matched nothing". Admin token
 * only, no provisioning.
 *
 * Targets come from scripts/lib/target.mjs. The primary target is `TARGET`
 * (default `prod`). The optional second target is `alt` (`ALT_*` vars), run
 * only when such vars are set.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';
import { loadEnvFile, resolveTarget } from './lib/target.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnvFile(resolve(__dirname, '../.env'));
const ENVIRONMENTS = [{ ...resolveTarget(process.env.TARGET ?? 'prod'), name: 'primary' }];
if (Object.keys(process.env).some((k) => k.startsWith('ALT_'))) ENVIRONMENTS.push({ ...resolveTarget('alt'), name: 'secondary' });

for (const env of ENVIRONMENTS) {
  const kaltura = new Management(env);
  const admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });

  const listRows = await kaltura.feedback.list(admin, { pageSize: 500 });
  console.log(`[${env.name}] feedback.list (no filter): rowCount=${listRows.length}`);
  if (listRows.length) console.log(`[${env.name}] sample row:`, JSON.stringify(listRows[0]));
}
