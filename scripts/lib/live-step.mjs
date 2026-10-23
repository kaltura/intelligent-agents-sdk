/**
 * Run one live-verify step with at most one retry. See `scripts/live-step.mjs` for the CLI.
 *
 * Live steps talk to a shared production backend and a real browser stack, so a short
 * outside blip (a dropped connection, a reply that never comes) can fail a step the SDK
 * did nothing wrong in. A real regression fails both attempts, so the retry hides nothing
 * that matters, and a step that passes only on its retry is reported as a warning
 * annotation and in the job summary.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, appendFileSync } from 'node:fs';

/**
 * Run `cmd args` once. Output goes to this process's stdout and stderr and is appended to `log`.
 * SIGINT and SIGTERM on `signals` are forwarded, so a cancelled job still lets the script clean up.
 * @param {string} cmd @param {string[]} args @param {import('node:fs').WriteStream} log
 * @param {NodeJS.EventEmitter} [signals] Default `process`.
 * @returns {Promise<number>} The exit code; 1 when the child died from a signal.
 */
export function runOnce(cmd, args, log, signals = process) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const forward = (/** @type {NodeJS.Signals} */ sig) => child.kill(sig);
    signals.on('SIGINT', forward);
    signals.on('SIGTERM', forward);
    child.stdout.on('data', (d) => { process.stdout.write(d); log.write(d); });
    child.stderr.on('data', (d) => { process.stderr.write(d); log.write(d); });
    const done = (/** @type {number} */ code) => {
      signals.off('SIGINT', forward);
      signals.off('SIGTERM', forward);
      resolve(code);
    };
    child.on('error', (err) => { log.write(`live-step: ${err.message}\n`); done(1); });
    child.on('close', (code) => done(code ?? 1));
  });
}

/** `live-verify-kickoff-output.log` → `kickoff`. @param {string} logPath */
export function stepLabel(logPath) {
  return logPath.replace(/^.*\//, '').replace(/^live-verify-?/, '').replace(/-?output\.log$/, '') || 'smoke';
}

/**
 * Run a step, retrying once when a retry as long as the failed attempt still fits `budgetMs`.
 * Before the retry it pauses, then waits for the backend to answer (`waitForBackend`), for at
 * most the time the budget has left. When the backend is still down, or the job was cancelled
 * (SIGINT or SIGTERM), it does not retry.
 * @param {object} o
 * @param {string} o.cmd @param {string[]} o.args @param {string} o.logPath
 * @param {number} [o.retries] 0 turns retries off. Default 1.
 * @param {number} [o.budgetMs] Time for all attempts, pause and backend wait. Default 14 minutes,
 *   one minute under the 15-minute step timeout.
 * @param {number} [o.pauseMs] Pause before the retry. Default 20 s.
 * @param {(maxMs:number) => Promise<{up:boolean}>} [o.waitForBackend] Gets the most time it may wait.
 * @param {(ms:number) => Promise<void>} [o.sleep]
 * @param {(line:string) => void} [o.out] Where annotations go. Default stdout.
 * @param {string} [o.summaryPath] `GITHUB_STEP_SUMMARY`, when set.
 * @param {() => number} [o.now]
 * @param {NodeJS.EventEmitter} [o.signals] Where SIGINT and SIGTERM arrive. Default `process`.
 * @returns {Promise<{code:number, attempts:number, passedOnRetry:boolean}>}
 */
export async function runStep(o) {
  const { cmd, args, logPath, retries = 1, budgetMs = 840_000, pauseMs = 20_000, now = Date.now, signals = process } = o;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const out = o.out ?? ((line) => process.stdout.write(`${line}\n`));
  const label = stepLabel(logPath);
  const log = createWriteStream(logPath, { flags: 'w' });
  const summary = (/** @type {string} */ line) => { if (o.summaryPath) appendFileSync(o.summaryPath, `\n${line}\n`); };
  let cancelled = false;
  /** @type {() => void} */
  let markCancelled = () => {};
  const cancel = new Promise((/** @type {(v?: undefined) => void} */ r) => { markCancelled = r; });
  const onCancel = () => { cancelled = true; markCancelled(); };
  // The pause and the backend wait end early on a cancel.
  const orCancel = (/** @type {Promise<any>} */ p) => Promise.race([p, cancel]);
  const noticeCancelled = (/** @type {string} */ failure) => out(`::notice title=${label}: no retry::The step failed (${failure}) after the job was cancelled.`);
  signals.on('SIGINT', onCancel);
  signals.on('SIGTERM', onCancel);
  const t0 = now();
  let code;
  let attempt = 0;
  let firstFailure = '';
  try {
    while (true) {
      attempt++;
      if (attempt > 1) log.write(`\n===== live-step: attempt ${attempt} of ${retries + 1} =====\n`);
      const started = now();
      code = await runOnce(cmd, args, log, signals);
      const took = now() - started;
      if (code === 0) break;
      const failure = `exit ${code} after ${Math.round(took / 1000)} s`;
      if (attempt === 1) firstFailure = failure;
      if (attempt > retries) break;
      if (cancelled) {
        noticeCancelled(failure);
        break;
      }
      // Leave room for a retry that takes as long as the attempt that failed.
      const left = () => budgetMs - (now() - t0) - took;
      if (left() < pauseMs) {
        out(`::notice title=${label}: no retry::The step failed (${failure}), too late for a retry inside the step timeout.`);
        break;
      }
      out(`::warning title=${label}: retrying::The step failed (${failure}). Retrying once in ${Math.round(pauseMs / 1000)} s.`);
      await orCancel(sleep(pauseMs));
      const health = cancelled || !o.waitForBackend ? null : await orCancel(o.waitForBackend(Math.max(0, left())));
      if (cancelled) {
        noticeCancelled(failure);
        break;
      }
      if (health && !health.up) {
        out(`::error title=${label}: backend unavailable::The backend did not answer, so the step was not retried.`);
        summary(`> [!WARNING]\n> **${label}** failed and was not retried: the backend did not answer.`);
        break;
      }
    }
  } finally {
    signals.off('SIGINT', onCancel);
    signals.off('SIGTERM', onCancel);
    await new Promise((r) => log.end(r));
  }
  const passedOnRetry = code === 0 && attempt > 1;
  if (passedOnRetry) {
    out(`::warning title=${label}: passed on retry::The first attempt failed (${firstFailure}). Its log is at the top of ${logPath} in the artifacts.`);
    summary(`> [!WARNING]\n> **${label}** passed on retry. The first attempt failed (${firstFailure}). Its log is at the top of \`${logPath}\` in the artifacts.`);
  } else if (code !== 0 && attempt > 1 && cancelled) {
    out(`::notice title=${label}: cancelled::The retry was stopped by a cancel (first attempt: ${firstFailure}).`);
  } else if (code !== 0 && attempt > 1) {
    out(`::error title=${label}: failed twice::Both attempts failed (first: ${firstFailure}). This is not a one-off blip.`);
  }
  return { code, attempts: attempt, passedOnRetry };
}
