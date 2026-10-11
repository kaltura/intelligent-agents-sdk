/**
 * A fetch with a hard deadline. Used for the short control requests (tool replies, WHEP
 * release) that must never hang a session. Streams and long calls bring their own signal.
 */
import { KalturaError } from '../core/errors.js';

/** Deadline for a tool reply POST. */
export const TOOL_RESPONSE_TIMEOUT_MS = 15000;

/**
 * @param {typeof fetch} doFetch
 * @param {string} url
 * @param {RequestInit} init  Must not carry its own `signal`.
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 * @throws {KalturaError} `timeout` when no response arrived in time. Other fetch errors pass through.
 */
export async function fetchWithTimeout(doFetch, url, init, timeoutMs) {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac?.abort(); }, timeoutMs);
  timer.unref?.();
  try {
    return await doFetch(url, { ...init, signal: ac?.signal });
  } catch (err) {
    if (timedOut) throw new KalturaError({ type: 'about:blank', title: 'request timed out', code: 'timeout', retryable: true, detail: `No response within ${timeoutMs}ms.` });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
