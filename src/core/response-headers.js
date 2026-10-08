/**
 * Response-header diagnostics. The Kaltura servers and the edge in front of
 * them stamp each response with ids (`x-kaltura-session`, `x-session-id`, ...).
 * Support and log search need them, so the SDK keeps them: on `KalturaError.headers` for failures and in the
 * `onResponse` hook for every response.
 *
 * Kept: `x-*`, `via`, `server`, `age`, `retry-after`, `traceparent`,
 * `tracestate`. Dropped: cookies, auth headers, headers whose name suggests a
 * credential (token, key, secret, auth, cookie, ks), client-IP headers and
 * browser-hardening noise. Trace-id headers keep their 32-hex ids; every other
 * value gets the full {@link redactString} scrub.
 */
import { redactString, redactHeaderValue } from './redact.js';

const KEEP_EXACT = new Set(['via', 'server', 'age', 'retry-after', 'traceparent', 'tracestate']);
const DROP_X = new Set(['x-content-type-options', 'x-frame-options', 'x-xss-protection', 'x-powered-by', 'x-dns-prefetch-control', 'x-permitted-cross-domain-policies', 'x-download-options', 'x-forwarded-for', 'x-real-ip', 'x-client-ip']);
// A name that hints at a credential. Dropped, whatever the value looks like.
const SENSITIVE_NAME = /secret|password|credential|token|key|auth|cookie|csrf|(^|-)ks($|-)/;
// Trace-id headers keep their 32-hex ids. Other values get the bare-hex scrub too.
const TRACE_NAME = /session|request|trace|correlation|(^|-)id$/;

/**
 * @typedef {object} ResponseInfo
 * @property {string} method
 * @property {string} path
 * @property {number} status
 * @property {boolean} ok
 * @property {number} attempt         1-based attempt number (a retried call reports each attempt).
 * @property {string} requestId       Server id when sent, else the SDK's correlation id (`''` on streamed converse calls with no server id).
 * @property {Record<string,string>} headers  Filtered, redacted, lowercase names. `{}` when none matched.
 */

/**
 * Pick the diagnostic headers from a fetch `Headers` (or any `forEach`/`entries` source).
 * @param {unknown} headers
 * @returns {Record<string,string>}
 */
export function pickResponseHeaders(headers) {
  /** @type {Record<string,string>} */
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  const add = (/** @type {unknown} */ v, /** @type {unknown} */ k) => {
    if (typeof k !== 'string' || typeof v !== 'string') return;
    const name = k.toLowerCase();
    if (!(KEEP_EXACT.has(name) || (name.startsWith('x-') && !DROP_X.has(name)))) return;
    if (SENSITIVE_NAME.test(name)) return;
    out[name] = TRACE_NAME.test(name) ? redactHeaderValue(v) : redactString(v);
  };
  const h = /** @type {any} */ (headers);
  if (typeof h.forEach === 'function') h.forEach(add);
  return out;
}

/**
 * Wrap an `onResponse` hook so a throwing hook can never break a request.
 * @param {((info: ResponseInfo) => void)|undefined} hook
 * @param {(level:string,msg:string,data?:unknown)=>void} [log]
 * @returns {(info: ResponseInfo) => void}
 */
export function makeResponseNotifier(hook, log) {
  if (typeof hook !== 'function') return () => {};
  return (info) => {
    try { hook({ ...info, headers: { ...info.headers } }); } catch (err) { log?.('warn', 'onResponse hook threw', String((err && /** @type {any} */ (err).message) || err)); }
  };
}
