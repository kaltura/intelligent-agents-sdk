/**
 * Wait for the production backend before the live-verify CI steps run. Read-only:
 * unauthenticated GETs only, no credentials, nothing created.
 *
 *   node scripts/live-verify-preflight.mjs            # wait up to 4 minutes
 *   node scripts/live-verify-preflight.mjs --wait 0   # probe once
 *
 * Exits 0 when every service answers below 500, 1 when one is still down at the
 * deadline. A failure means the backend was unavailable, not that the SDK broke:
 * re-run the job once the backend is back.
 */
import { waitForBackend } from './lib/backend-health.mjs';

const at = process.argv.indexOf('--wait');
const deadlineMs = at > 0 ? Number(process.argv[at + 1]) * 1000 : 240_000;
if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
  console.error('usage: node scripts/live-verify-preflight.mjs [--wait SECONDS]');
  process.exit(2);
}

const { up, waitedMs, results } = await waitForBackend({ deadlineMs, log: (l) => console.log(l) });
if (up) {
  console.log(`backend is up (${Math.round(waitedMs / 1000)} s)`);
} else {
  const down = results.filter((r) => !r.up).map((r) => r.name).join(', ');
  console.log(`::error title=Backend unavailable::${down} did not answer for ${Math.round(waitedMs / 1000)} s. The live steps were skipped. This is not an SDK failure: re-run the job once the backend is back.`);
  process.exitCode = 1;
}
