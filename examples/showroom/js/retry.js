// Runs an async step again when it fails, so one dropped connection does not end a visit on a screen nobody can restart.
// `before` runs ahead of every retry (clean up the failed attempt there). The last error is thrown when all tries fail.
export async function withRetry(step, { tries = 3, delayMs = 1200, before = () => {}, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (attempt > 1) { await before(attempt); await wait(delayMs * (attempt - 1)); }
    try { return await step(attempt); } catch (e) { last = e; }
  }
  throw last;
}
