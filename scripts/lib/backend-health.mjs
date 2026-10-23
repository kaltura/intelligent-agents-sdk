/**
 * Is the production backend up? Used by the live-verify CI before the live steps run
 * (`live-verify-preflight.mjs`) and before a failed live step is retried (`live-step.mjs`).
 *
 * Each probe is one unauthenticated GET. A service counts as up when it answers with a
 * status below 500: a 404 from the app itself still means the app is serving. The
 * conversation server is probed with a socket.io polling handshake, the same first
 * request a live session makes. Output names services by their SDK config key, never a host.
 */
import { REGIONS } from '../../src/core/endpoints.js';
import { DEFAULT_CM_URL } from '../../src/experience/wire.js';

/** @typedef {{name:string, url:string}} Probe */
/** @typedef {{name:string, up:boolean, status:number|null, error?:string}} ProbeResult */

/** @type {ReadonlyArray<Probe>} */
export const PROD_PROBES = Object.freeze([
  { name: 'agenticUrl', url: REGIONS.nvp1.agenticUrl },
  { name: 'genieUrl', url: REGIONS.nvp1.genieUrl },
  { name: 'ovpUrl', url: `${REGIONS.nvp1.ovpUrl}/service/system/action/ping?format=1` },
  { name: 'conversation server', url: `${DEFAULT_CM_URL}/socket.io/?EIO=4&transport=polling` },
]);

/**
 * Probe every service once, in parallel.
 * @param {{probes?: ReadonlyArray<Probe>, fetch?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<ProbeResult[]>}
 */
export async function probeBackend({ probes = PROD_PROBES, fetch: f = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  return Promise.all(probes.map(async ({ name, url }) => {
    try {
      const res = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel?.().catch(() => {});
      return { name, up: res.status < 500, status: res.status };
    } catch (err) {
      return { name, up: false, status: null, error: String(/** @type {any} */ (err)?.name || err) };
    }
  }));
}

/** One line per round, e.g. `agenticUrl 404 up, conversation server 503 DOWN`. @param {ProbeResult[]} results */
export function formatProbes(results) {
  return results.map((r) => `${r.name} ${r.status ?? r.error} ${r.up ? 'up' : 'DOWN'}`).join(', ');
}

/**
 * Probe until every service is up or `deadlineMs` passes. Waits 5 s, 10 s, 20 s, then 30 s between rounds.
 * @param {{probes?: ReadonlyArray<Probe>, fetch?: typeof fetch, deadlineMs?: number, sleep?: (ms:number) => Promise<void>, log?: (line:string) => void, now?: () => number}} [opts]
 * @returns {Promise<{up:boolean, rounds:number, waitedMs:number, results:ProbeResult[]}>}
 */
export async function waitForBackend(opts = {}) {
  const { deadlineMs = 240_000, log = () => {}, now = Date.now } = opts;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  for (let round = 1; ; round++) {
    const results = await probeBackend(opts);
    const up = results.every((r) => r.up);
    const waitedMs = now() - start;
    log(`backend check ${round}: ${formatProbes(results)}`);
    if (up || waitedMs >= deadlineMs) return { up, rounds: round, waitedMs, results };
    await sleep(Math.min(5000 * 2 ** (round - 1), 30_000, Math.max(0, deadlineMs - waitedMs)));
  }
}
