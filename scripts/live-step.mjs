/**
 * Run one live-verify CI step: tee its output to a log, and retry it once on failure.
 *
 *   node scripts/live-step.mjs --log live-verify-kickoff-output.log -- node scripts/live-verify-kickoff.mjs --env prod
 *
 * Before the retry it pauses 20 s and waits up to 3 minutes for the production backend
 * to answer. It retries only when a retry as long as the failed attempt still fits 14
 * minutes, one under the 15-minute step timeout, and never after a cancel. A step that
 * passes on its retry gets a warning annotation and a line in the job summary.
 *
 * Env: LIVE_STEP_RETRIES=0 turns retries off (the workflow's manual `retry` input sets it).
 * Exits with the last attempt's exit code.
 */
import { runStep } from './lib/live-step.mjs';
import { waitForBackend } from './lib/backend-health.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const logAt = argv.indexOf('--log');
if (sep < 0 || sep === argv.length - 1 || logAt < 0 || logAt > sep || !argv[logAt + 1] || logAt + 1 === sep) {
  console.error('usage: node scripts/live-step.mjs --log FILE -- CMD [ARGS...]');
  process.exit(2);
}
const retries = process.env.LIVE_STEP_RETRIES === '0' ? 0 : 1;
const [cmd, ...args] = argv.slice(sep + 1);

const { code } = await runStep({
  cmd, args, logPath: argv[logAt + 1], retries,
  waitForBackend: (maxMs) => waitForBackend({ deadlineMs: Math.min(180_000, maxMs), log: (l) => console.log(l) }),
  summaryPath: process.env.GITHUB_STEP_SUMMARY || undefined,
});
process.exitCode = code;
