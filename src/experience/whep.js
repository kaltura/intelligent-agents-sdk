/**
 * WHEP POST with a per-try timeout and bounded retries. Pure: the fetch, the clock and the
 * sleep are injected, so tests drive it with fake timers.
 *
 * Only transport failures retry (the try timed out, or the network call threw). An HTTP
 * status never retries here, because the caller decides what each status means (404 and 409
 * re-create the session). A caller abort stops at once and is never retried.
 */
import { KalturaError } from '../core/errors.js';

/** Defaults, also the shape of the `cfg.timeouts` entries that override them. */
export const WHEP_DEFAULTS = Object.freeze({ whepTry: 5000, whepTries: 3, whepBackoff: 1000 });

/**
 * @param {object} o
 * @param {typeof fetch} o.fetch
 * @param {string} o.url
 * @param {string} o.sdp
 * @param {AbortSignal} [o.signal]            Caller abort. Stops all tries.
 * @param {number} [o.timeoutMs]              Per try. Default 5000.
 * @param {number} [o.tries]                  Total tries. Default 3.
 * @param {number} [o.backoffMs]              Wait between tries. Default 1000.
 * @param {{expired:()=>boolean}} [o.overall] Stops retrying once the caller's deadline has passed.
 * @returns {Promise<Response>} The first response of any status.
 * @throws {KalturaError} `whep_timeout` when every try timed out, `whep_failed` when the last try failed on the network.
 */
export async function whepPost({ fetch: doFetch, url, sdp, signal, timeoutMs = WHEP_DEFAULTS.whepTry, tries = WHEP_DEFAULTS.whepTries, backoffMs = WHEP_DEFAULTS.whepBackoff, overall }) {
  /** @type {any} */ let last;
  let timedOut = false, made = 0;
  tries = Math.max(1, tries);
  for (let attempt = 1; attempt <= tries; attempt++) {
    if (signal?.aborted) throw abortErr();
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const onAbort = () => ac?.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timedOut = false; made = attempt;
    const timer = setTimeout(() => { timedOut = true; ac?.abort(); }, timeoutMs);
    try {
      return await doFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: sdp, signal: ac?.signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      last = err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
    if (attempt < tries && !overall?.expired()) await sleep(backoffMs, signal);
    else break;
  }
  if (timedOut) {
    throw new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/whep_timeout', title: 'WHEP timeout', code: 'whep_timeout', phase: 'whep', retryable: true, detail: `The avatar stream request got no answer after ${made} ${made === 1 ? 'try' : 'tries'}.` });
  }
  throw new KalturaError({ type: 'about:blank', title: 'WHEP failed', code: 'whep_failed', phase: 'whep', retryable: true, detail: `The avatar stream request failed on the network: ${String(last?.message || last)}` });
}

/** @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { signal?.removeEventListener?.('abort', stop); resolve(undefined); }, ms);
    const stop = () => { clearTimeout(t); resolve(undefined); };
    signal?.addEventListener?.('abort', stop, { once: true });
  });
}

function abortErr() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
