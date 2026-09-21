/**
 * One bounded way to call the page-side `window.test*` hooks the live browser
 * scripts drive their sessions through.
 *
 * `page.evaluate` has no timeout of its own. When a hook awaits a session
 * promise that never settles — a `connect()` that neither resolves nor rejects
 * is the case seen in CI — the whole script stops at that line with no
 * diagnostic, until the job's own limit kills it. Killing the job skips the
 * script's `finally` block, so the throwaway intellect/avatar/agent it
 * provisioned are left behind on the partner.
 *
 * A deadline that rejects instead keeps `finally`: the run fails as a named
 * check, teardown deletes what it created, and the artifact says which hook
 * stopped responding.
 *
 * Nothing here is imported by the SDK.
 */

/**
 * Deadline for one hook call. Generous on purpose: text entered during an
 * opening turn is held until that turn ends, so awaiting `speak()` can
 * legitimately take over a minute. This bounds a hang, it does not police
 * latency — the timing assertions in the scripts themselves do that.
 */
export const HOOK_TIMEOUT_MS = 120_000;

/**
 * Call `window[fn](arg)` on the page, rejecting if it has not settled in time.
 * @template T
 * @param {import('playwright').Page} page
 * @param {string} fn                       Hook name, e.g. `'testConnect'`.
 * @param {any} [arg]                       Single argument, passed through.
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<T>}
 * @throws {Error} `window.<fn>() did not settle within <n> ms` once the deadline passes.
 */
export function callHook(page, fn, arg, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? HOOK_TIMEOUT_MS;
  /** @type {any} */
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`window.${fn}() did not settle within ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([
    page.evaluate(([f, a]) => /** @type {any} */ (window)[f](a), [fn, arg]),
    deadline,
  ]).finally(() => clearTimeout(timer));
}
