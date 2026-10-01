/**
 * Backend target for the live scripts: one resolver, so every script picks
 * production or another environment the same way, and a non-production run
 * can never reach a production host by accident.
 *
 *   const target = resolveTarget(process.env.TARGET ?? 'prod');
 *   const kaltura = new Management(target);
 *
 * Not imported by the SDK. Never prints secret values.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGIONS } from '../../src/management/index.js';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Load `KEY=value` lines from a .env file into process.env without overriding
 * values that are already set. Keys may contain digits. Surrounding quotes are stripped.
 * @param {string} path
 * @returns {boolean} true when the file was read
 */
export function loadEnvFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return false; }
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return true;
}

/**
 * Resolve a backend target into a full `Management` config. Exits the process
 * with a message naming the missing variables (never their values) on error.
 *
 * - `prod` (the default): `AGENTIC_PARTNER_ID` / `AGENTIC_ADMIN_SECRET` from the
 *   environment or the repo-root `.env`. URLs are `REGIONS.nvp1`.
 * - `<name>` or `<name>:<account>` (for example `nvq2`, `nvq2:2`): also reads the
 *   `.env` one level above the repo. The upper-cased name prefixes
 *   `_AGENTIC_API_URL`, `_GENIE_URL` and `_KALTURA_API_ENDPOINT` (all required)
 *   and `_MESSAGING_URL` (optional). Credentials come from the first pair that is
 *   set: `<P>_PARTNER_ID_<account>` / `<P>_ADMIN_SECRET_<account>` (account
 *   defaults to 1), then `<P>_PARTNER_ID` / `<P>_ADMIN_SECRET`, then
 *   `<P>_AGENTIC_PARTNER_ID` / `<P>_AGENTIC_ADMIN_SECRET`.
 *
 * The returned `fetch` refuses any host outside the target's URLs. So a target
 * without a messaging URL fails `emailTemplates.*` instead of reaching production.
 * @param {string} spec
 * @param {string} [label] How the caller names the option in error messages.
 * @returns {{name:string, partnerId:string, adminSecret:string, agenticUrl:string, genieUrl:string, ovpUrl:string, messagingUrl?:string, fetch:typeof fetch}}
 */
export function resolveTarget(spec, label = 'TARGET') {
  const fail = (/** @type {string} */ msg) => {
    console.error(`${label} ${spec}: ${msg}`);
    process.exit(1);
  };
  const need = (/** @type {string[]} */ keys) => {
    const missing = keys.filter((k) => !process.env[k]);
    if (missing.length) fail(`missing ${missing.join(', ')} (set them in the environment or a .env file).`);
  };
  loadEnvFile(resolve(repoRoot, '.env'));
  /** @type {{name:string, partnerId:string, adminSecret:string, agenticUrl:string, genieUrl:string, ovpUrl:string, messagingUrl?:string}} */
  let t;
  if (spec === 'prod') {
    need(['AGENTIC_PARTNER_ID', 'AGENTIC_ADMIN_SECRET']);
    t = { name: spec, partnerId: process.env.AGENTIC_PARTNER_ID, adminSecret: process.env.AGENTIC_ADMIN_SECRET, ...REGIONS.nvp1 };
  } else {
    const m = /^([a-z][a-z0-9]*)(?::([1-9][0-9]*))?$/.exec(spec);
    if (!m) fail('use prod, or <name>[:<account>] where <name> is lowercase and its upper-cased form prefixes the target\'s env vars.');
    const [, name, account = '1'] = m;
    loadEnvFile(resolve(repoRoot, '../.env'));
    const p = name.toUpperCase();
    const candidates = [[`${p}_PARTNER_ID_${account}`, `${p}_ADMIN_SECRET_${account}`]];
    if (account === '1') candidates.push([`${p}_PARTNER_ID`, `${p}_ADMIN_SECRET`], [`${p}_AGENTIC_PARTNER_ID`, `${p}_AGENTIC_ADMIN_SECRET`]);
    const creds = candidates.find(([id, secret]) => process.env[id] && process.env[secret]);
    if (!creds) fail(`missing credentials; set one pair of ${candidates.map(([id, secret]) => `${id} / ${secret}`).join(', or ')}.`);
    need([`${p}_AGENTIC_API_URL`, `${p}_GENIE_URL`, `${p}_KALTURA_API_ENDPOINT`]);
    t = {
      name: account === '1' ? name : `${name}-${account}`,
      partnerId: process.env[creds[0]],
      adminSecret: process.env[creds[1]],
      agenticUrl: process.env[`${p}_AGENTIC_API_URL`],
      genieUrl: process.env[`${p}_GENIE_URL`],
      ovpUrl: process.env[`${p}_KALTURA_API_ENDPOINT`],
      ...(process.env[`${p}_MESSAGING_URL`] ? { messagingUrl: process.env[`${p}_MESSAGING_URL`] } : {}),
    };
  }
  const hosts = new Set([t.agenticUrl, t.genieUrl, t.ovpUrl, t.messagingUrl].filter(Boolean).map((u) => new URL(u).host));
  /** @type {typeof fetch} */
  const guarded = (input, init) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).host;
    if (!hosts.has(host)) return Promise.reject(new Error(`target ${t.name}: refusing a request to ${host}, which is not one of this target's hosts.`));
    return fetch(input, init);
  };
  return { ...t, fetch: guarded };
}
