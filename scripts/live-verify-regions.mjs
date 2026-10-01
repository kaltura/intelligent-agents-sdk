#!/usr/bin/env node
/**
 * Region reachability check. No credentials, no writes.
 *
 * Sends one unauthenticated POST to every non-null base URL in REGIONS and
 * records whether TLS succeeded, the HTTP status and the content type. A region
 * other than nvp1 passes when each of its hosts answers over TLS with the same
 * status and content type nvp1 gives for the same service. A failure means that
 * REGIONS field is wrong, or the service is down, and should be null until it works.
 *
 *   node scripts/live-verify-regions.mjs
 *
 * Exits 1 on any TLS failure or mismatch.
 */
import { REGIONS } from '../src/management/index.js';

/** One cheap, unauthenticated request per service. Each one is refused for lack of a token. */
const PROBES = {
  agenticUrl: '/agent/list',
  genieUrl: '/assistant/converse',
  ovpUrl: '/service/system/action/ping?format=1',
  messagingUrl: '/email-template/list',
};

/** @param {string} url */
async function probe(url) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    await res.body?.cancel();
    return { tls: 'ok', status: res.status, type: (res.headers.get('content-type') ?? '').split(';')[0].trim() };
  } catch (e) {
    const cause = /** @type {any} */ (e)?.cause;
    return { tls: `failed (${cause?.code ?? cause?.message ?? /** @type {any} */ (e)?.name ?? 'error'})`, status: null, type: null };
  }
}

const results = {};
for (const [region, urls] of Object.entries(REGIONS)) {
  for (const [key, path] of Object.entries(PROBES)) {
    const base = urls[key];
    results[`${region}.${key}`] = base ? { url: base + path, ...(await probe(base + path)) } : null;
  }
}

let failures = 0;
for (const [region, urls] of Object.entries(REGIONS)) {
  console.log(`\n${region}`);
  for (const key of Object.keys(PROBES)) {
    const r = results[`${region}.${key}`];
    if (!r) { console.log(`  ${key.padEnd(13)} null (not offered in this region)`); continue; }
    const ref = region === 'nvp1' ? null : results[`nvp1.${key}`];
    const problems = [];
    if (r.tls !== 'ok') problems.push(`TLS ${r.tls}`);
    else if (ref && ref.tls === 'ok' && (r.status !== ref.status || r.type !== ref.type)) {
      problems.push(`nvp1 gives ${ref.status} ${ref.type}`);
    }
    failures += problems.length ? 1 : 0;
    const shown = r.tls === 'ok' ? `TLS ok, ${r.status} ${r.type}` : r.tls;
    console.log(`  ${key.padEnd(13)} ${problems.length ? 'FAIL' : 'ok  '} ${new URL(urls[key]).host}: ${shown}${problems.length && r.tls === 'ok' ? ` (${problems.join('; ')})` : ''}`);
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll region hosts answer over TLS with the same shape as nvp1.');
process.exit(failures ? 1 : 0);
