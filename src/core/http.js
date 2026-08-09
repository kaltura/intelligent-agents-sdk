/**
 * HTTP transport — the single chokepoint for every REST call on both backends.
 *
 * - `fetch` is INJECTABLE (constructor option) so the SDK has zero runtime deps
 *   and is fully unit-testable with a fake. Defaults to `globalThis.fetch`
 *   (native in Node ≥18 and all browsers).
 * - Every failed response becomes an {@link KalturaError} (RFC 9457).
 * - HTTP-200-with-exception bodies (a KalturaAPIException in a 200 response) are caught too.
 * - A `requestId` is attached to every call (echoed from the server when it
 *   sends one, else a client-generated correlation id) and rides on errors.
 * - Diagnostic logging routes through {@link redact}; a token can't leak.
 * - Transient failures (429/502/503/504, network error) are retried with
 *   truncated exponential backoff + full jitter.
 * - Response bodies are size-capped at `maxResponseBytes` (default 10 MiB).
 *   A response exceeding the cap throws `response_too_large`.
 */
import { errorFromResponse, errorFromOkBody } from './errors.js';
import { redact } from './redact.js';
import { uuidv4 } from './ids.js';
import { KalturaError } from './errors.js';

/**
 * @typedef {object} HttpOptions
 * @property {typeof fetch} [fetch]      Injected fetch (default globalThis.fetch).
 * @property {(level:string,msg:string,data?:unknown)=>void} [logger] Redacted diagnostic sink.
 * @property {(type:string,outcome:string,fields?:object)=>void} [audit] Structured security-event emitter (auth.fail on 401/403).
 * @property {number} [timeoutMs]        Per-request timeout in ms (default 30 000).
 * @property {number} [maxRetries]       Max retry attempts on transient failures (default 3).
 * @property {number} [baseDelayMs]      Base backoff delay in ms (default 200).
 * @property {number} [maxDelayMs]       Max backoff delay cap in ms (default 10 000).
 * @property {(ms:number)=>Promise<void>} [delayFn] Inject a custom sleep (default setTimeout). Used in tests to run retries at zero cost.
 * @property {number} [maxResponseBytes] Max response body size in bytes (default 10 MiB).
 */

/** HTTP status codes that are safe to retry (transient server/infra errors). */
const RETRIABLE_STATUSES = new Set([429, 502, 503, 504]);

/** Status 0 = network-layer error (no bytes sent/received). Always retriable. */
const NETWORK_ERROR_STATUS = 0;

/**
 * HTTP transport with injectable fetch, retry/backoff, and response size budgeting.
 */
export class Http {
  /** @param {HttpOptions} [opts] */
  constructor(opts = {}) {
    const f = opts.fetch || globalThis.fetch;
    if (typeof f !== 'function') {
      throw new Error('No fetch available — pass { fetch } (Node <18 has no global fetch).');
    }
    // Bind to globalThis so the native browser `fetch` keeps its required receiver
    // (calling `this._fetch(...)` on an unbound native fetch throws "Illegal invocation").
    // A user-injected fetch is bound too — harmless for ordinary functions.
    /** @type {typeof fetch} */ this._fetch = f.bind(globalThis);
    this._log = opts.logger || (() => {});
    this._audit = typeof opts.audit === 'function' ? opts.audit : () => {};
    this._timeoutMs = opts.timeoutMs ?? 30000;
    this._maxRetries = opts.maxRetries ?? 3;
    this._baseDelayMs = opts.baseDelayMs ?? 200;
    this._maxDelayMs = opts.maxDelayMs ?? 10000;
    this._delayFn = opts.delayFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._maxResponseBytes = opts.maxResponseBytes ?? 10 * 1024 * 1024; // 10 MiB
  }

  /**
   * POST JSON (the shape of nearly every Agentic/Genie call) and parse the body.
   * @param {object} req
   * @param {string} req.url            Absolute URL.
   * @param {string} req.ks             KS token for the Authorization header.
   * @param {unknown} [req.body]        JSON body (omitted if undefined).
   * @param {string} [req.idempotencyKey] Sent as `Idempotency-Key` on creates.
   * @returns {Promise<{data:any, requestId:string}>}
   */
  async postJson(req) {
    return this.request({ method: 'POST', ...req, json: true });
  }

  /**
   * Generic request with full control. Returns parsed JSON (or text) + requestId.
   * Retries on transient failures (429/502/503/504/network) with exponential backoff.
   * @param {object} req
   * @param {string} req.method
   * @param {string} req.url
   * @param {string} [req.ks]
   * @param {unknown} [req.body]
   * @param {boolean} [req.json]        Serialize body as JSON + set content-type.
   * @param {Record<string,string>} [req.headers]
   * @param {string} [req.idempotencyKey]
   * @param {AbortSignal} [req.signal]
   * @returns {Promise<{data:any, requestId:string, status:number, headers:Headers}>}
   */
  async request(req) {
    const { method, url, ks, body, json, headers = {}, idempotencyKey, signal } = req;
    const path = pathOf(url);
    const isGet = method === 'GET' || method === 'HEAD';
    // A POST is retry-safe on network error (status 0 — bytes may not have been sent)
    // only when it carries an idempotency key OR it's a GET.
    const isSafeToRetryHttpError = isGet || !!idempotencyKey;

    const h = { ...headers };
    if (ks) h['Authorization'] = `KS ${ks}`;
    let payload;
    if (body !== undefined) {
      if (json) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      else payload = /** @type {any} */ (body);
    }
    if (idempotencyKey) h['Idempotency-Key'] = idempotencyKey;

    let lastErr;
    for (let attempt = 0; attempt <= this._maxRetries; attempt++) {
      // Honour caller abort before starting each attempt
      if (signal && signal.aborted) throw errorFromResponse({ status: 0, path, body: 'aborted by caller', requestId: '' });

      if (attempt > 0) {
        const delay = Math.min(this._maxDelayMs, this._baseDelayMs * Math.pow(2, attempt - 1));
        const jittered = delay * (0.5 + Math.random() * 0.5);
        await this._delayFn(jittered);
        // Recheck abort after the sleep
        if (signal && signal.aborted) throw errorFromResponse({ status: 0, path, body: 'aborted by caller', requestId: '' });
        this._log('debug', `↺ retry ${attempt}/${this._maxRetries} ${method} ${path}`);
      }

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this._timeoutMs);
      const sig = mergeSignals(signal, ctrl.signal);

      this._log('debug', `→ ${method} ${path}`, attempt > 0 ? `(attempt ${attempt + 1})` : redact(body));
      let res, text;
      try {
        res = await this._fetch(url, { method, headers: h, body: payload, signal: sig });
        // Enforce response size budget before reading the body (P-1)
        const cl = res.headers.get('content-length');
        if (cl && parseInt(cl, 10) > this._maxResponseBytes) {
          clearTimeout(t);
          throw new KalturaError({
            type: 'https://docs.kaltura.com/agentic/errors/response_too_large',
            title: 'response too large',
            status: res.status,
            detail: `Response Content-Length ${cl} bytes exceeds limit of ${this._maxResponseBytes} bytes`,
            instance: path,
            code: 'response_too_large',
          });
        }
        text = await res.text();
        // Also enforce after reading (covers chunked responses without Content-Length)
        if (text.length > this._maxResponseBytes) {
          clearTimeout(t);
          throw new KalturaError({
            type: 'https://docs.kaltura.com/agentic/errors/response_too_large',
            title: 'response too large',
            status: res.status,
            detail: `Response body ${text.length} bytes exceeds limit of ${this._maxResponseBytes} bytes`,
            instance: path,
            code: 'response_too_large',
          });
        }
      } catch (err) {
        clearTimeout(t);
        // response_too_large is not retriable — re-throw immediately
        if (err instanceof KalturaError && err.code === 'response_too_large') throw err;
        const aborted = ctrl.signal.aborted;
        const kErr = errorFromResponse({
          status: NETWORK_ERROR_STATUS, path,
          body: aborted ? `request timed out after ${this._timeoutMs}ms` : String(err && err.message || err),
          requestId: '',
        });
        // Network errors (status 0) are retriable on all methods
        if (attempt < this._maxRetries) { lastErr = kErr; continue; }
        throw kErr;
      }
      clearTimeout(t);

      const requestId = res.headers.get('x-request-id') || res.headers.get('x-kaltura-request-id') || uuidv4();
      const data = parseBody(text, res.headers.get('content-type') || '');
      this._log('debug', `← ${res.status} ${path}`, redact(data));

      // Auth failures are security-relevant (OWASP "always log"; NIST AU-2).
      if (res.status === 401 || res.status === 403) this._audit('auth.fail', 'fail', { action: `${method} ${path}`, reason: `HTTP ${res.status}`, requestId });

      if (!res.ok) {
        const kErr = errorFromResponse({ status: res.status, path, body: data, requestId });
        // Only retry transient server errors; do NOT retry auth/validation/client errors
        if (RETRIABLE_STATUSES.has(res.status) && isSafeToRetryHttpError && attempt < this._maxRetries) {
          lastErr = kErr; continue;
        }
        throw kErr;
      }

      const okErr = errorFromOkBody(data, path);
      if (okErr) { okErr.requestId = requestId; throw okErr; }
      return { data, requestId, status: res.status, headers: res.headers };
    }
    // Should only reach here if all retries exhausted
    throw lastErr;
  }
}

/** @param {string} text @param {string} contentType */
function parseBody(text, contentType) {
  if (!text) return null;
  if (contentType.includes('application/json') || /^[[{]/.test(text.trim())) {
    try { return JSON.parse(text); } catch { /* fall through */ }
  }
  // KS endpoints return a bare quoted string; CSV reports return raw text.
  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) { try { return JSON.parse(trimmed); } catch { /* */ } }
  return text;
}

/** @param {string} url */
function pathOf(url) { try { return new URL(url).pathname; } catch { return url; } }

/** @param {AbortSignal|undefined} a @param {AbortSignal} b */
function mergeSignals(a, b) {
  if (!a) return b;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  if (a.aborted) return a;
  const ac = new AbortController();
  const fire = () => ac.abort(a.reason ?? b.reason);
  a.addEventListener('abort', fire, { once: true });
  b.addEventListener('abort', fire, { once: true });
  return ac.signal;
}
