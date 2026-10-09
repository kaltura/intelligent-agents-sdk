/**
 * Error model — every error the SDK throws is a {@link KalturaError} shaped as
 * an RFC 9457 "problem detail" ({type,title,status,detail,instance,...}), even
 * though the upstream APIs return errors inconsistently (sometimes HTTP 200
 * with a `{message}` body). The SDK normalizes all of them into one stable
 * contract, so callers branch on a machine-readable `code`, never on prose.
 *
 * Every field that can carry upstream free text (`title`, `detail`, `body`) is
 * passed through {@link redact}/{@link redactString} so a token embedded in an
 * upstream error message can never surface in a thrown error.
 */
import { redact, redactString } from './redact.js';

/**
 * @typedef {object} ProblemDetail
 * @property {string} type            A URI-reference identifying the problem class.
 * @property {string} title           Short human-readable summary.
 * @property {number} [status]        HTTP status, when there was one.
 * @property {string} [detail]        Human-readable explanation for this occurrence.
 * @property {string} [instance]      The request path/instance.
 * @property {string} code            Stable machine-readable code (SDK-assigned).
 * @property {string} [requestId]     Correlation id echoed from the response, if any.
 * @property {Record<string,string>} [headers]  Diagnostic response headers (see response-headers.js), when a response arrived.
 * @property {unknown} [body]         The (redacted) upstream response body.
 * @property {string} [phase]         The connect step that failed, on a live-session error (`serverConnect`, `join`, `joinComplete`, `agent`, `asr`, `whep`, `connect`, `reconnect`).
 * @property {boolean} [retryable]    True when trying the same call again can succeed. Absent when the SDK has no opinion.
 * @property {unknown} [cause]        The error this one wraps, when the SDK replaced it with a clearer one.
 */

export class KalturaError extends Error {
  /** @param {ProblemDetail} problem */
  constructor(problem) {
    super(redactString(problem.detail || problem.title || problem.code));
    this.name = 'KalturaError';
    /** @type {string} */ this.type = problem.type;
    /** @type {string} */ this.title = redactString(problem.title);
    /** @type {number|undefined} */ this.status = problem.status;
    /** @type {string|undefined} */ this.detail = problem.detail ? redactString(problem.detail) : undefined;
    /** @type {string|undefined} */ this.instance = problem.instance;
    /** @type {string} */ this.code = problem.code;
    /** @type {string|undefined} */ this.requestId = problem.requestId;
    /** @type {Record<string,string>|undefined} */ this.headers = problem.headers && Object.keys(problem.headers).length ? { ...problem.headers } : undefined;
    /** @type {unknown} */ this.body = redact(problem.body);
    /** @type {string|undefined} */ this.phase = problem.phase;
    /** @type {boolean|undefined} */ this.retryable = problem.retryable;
    if (problem.cause !== undefined) Object.defineProperty(this, 'cause', { value: problem.cause, enumerable: false, writable: true, configurable: true });
  }

  /** RFC 9457 JSON representation (already redacted). */
  toJSON() {
    return {
      type: this.type, title: this.title, status: this.status,
      detail: this.detail, instance: this.instance, code: this.code,
      requestId: this.requestId, headers: this.headers, body: this.body,
      ...(this.phase !== undefined && { phase: this.phase }),
      ...(this.retryable !== undefined && { retryable: this.retryable }),
    };
  }
}

const BASE = 'https://docs.kaltura.com/agentic/errors/';

/** Map a known upstream error string to a stable SDK code.
 * @type {Array<[RegExp, string]>}
 */
const CODE_BY_PATTERN = [
  [/AGENT_PARTNER_CONFIG_GENIE_ID_MISMATCH/i, 'genie_id_mismatch'],
  [/AGENT_PARTNER_CONFIG_NOT_FOUND/i, 'intellect_not_found'],
  [/AGENT_NOT_FOUND/i, 'agent_not_found'],
  [/CATALOG_ITEM_NOT_FOUND/i, 'catalog_item_not_found'],
  [/INVALID_INSIGHT_SETTINGS/i, 'invalid_insight_settings'],
  [/VOICE_DOES_NOT_EXIST_ON_ELEVEN_LABS/i, 'voice_not_found_elevenlabs'],
  [/VOICE_DOES_NOT_EXIST_ON_CARTESIA/i, 'voice_not_found_cartesia'],
  [/Invalid filter type/i, 'invalid_filter'],
  [/union_tag_not_found/i, 'missing_discriminator'],
];

/** @param {number} status */
function codeForStatus(status) {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 405) return 'method_not_allowed';
  if (status === 409) return 'conflict';
  if (status === 422) return 'validation_error';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'error';
}

/**
 * Build a KalturaError from an HTTP response that failed.
 * @param {{status:number, path:string, body:unknown, requestId?:string, headers?:Record<string,string>}} ctx
 */
export function errorFromResponse({ status, path, body, requestId, headers }) {
  const upstreamMsg = extractMessage(body);
  let code = codeForStatus(status);
  for (const [re, c] of CODE_BY_PATTERN) if (upstreamMsg && re.test(upstreamMsg)) { code = c; break; }
  return new KalturaError({
    type: BASE + code,
    title: code.replace(/_/g, ' '),
    status,
    detail: upstreamMsg || `HTTP ${status} from ${path}`,
    instance: path,
    code,
    requestId,
    headers,
    body,
  });
}

/** Keys an error-only envelope may carry. A body with any other key is a real payload. */
const ERROR_ENVELOPE_KEYS = new Set(['error', 'message', 'detail', 'code', 'status', 'statusCode', 'success', 'ok', 'requestId', 'request_id']);

/** @param {unknown} v */
function errorText(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = /** @type {Record<string, unknown>} */ (v);
    if (typeof o.message === 'string') return o.message;
    if (typeof o.detail === 'string') return o.detail;
  }
  return undefined;
}

/**
 * Some endpoints return HTTP 200 with an error in the body instead of a
 * failing status. Detect that and raise it as a real error. Recognized shapes:
 * a `KalturaAPIException`, `{code, message, args}`, `{message, error:true}`,
 * and an error-ONLY envelope: `{error: string|{message}}`, `{success:false}`
 * or `{status|statusCode: >=400}` whose keys are all envelope keys
 * (error/message/detail/code/status/statusCode/success/ok/requestId). A body
 * that also carries any other key is treated as a real payload.
 * @param {unknown} body
 * @param {string} path
 * @returns {KalturaError|null}
 */
export function errorFromOkBody(body, path) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = /** @type {Record<string, unknown>} */ (body);
  const code = typeof b.code === 'string' ? b.code : undefined;
  const message = typeof b.message === 'string' ? b.message : undefined;
  // A KalturaAPIException shape: {code, message, objectType:"KalturaAPIException"} or {message} with no success payload.
  const looksLikeException =
    b.objectType === 'KalturaAPIException' ||
    (code && message && b.args !== undefined) ||
    (message && b.error === true);
  let detail = message;
  let wireStatus;
  if (!looksLikeException) {
    const keys = Object.keys(b);
    const envelopeOnly = keys.length > 0 && keys.every((k) => ERROR_ENVELOPE_KEYS.has(k));
    const numStatus = [b.status, b.statusCode].find((v) => typeof v === 'number' && v >= 400);
    const failed = (b.error && b.error !== true) || b.success === false || b.ok === false || numStatus !== undefined;
    if (!envelopeOnly || !failed) return null;
    detail = errorText(b.error) || message || errorText(b.detail) || (code ? String(code) : undefined);
    wireStatus = numStatus;
  }
  let sdkCode = 'api_exception';
  for (const [re, c] of CODE_BY_PATTERN) if (re.test(`${code || ''} ${detail || ''}`)) { sdkCode = c; break; }
  return new KalturaError({
    type: BASE + sdkCode,
    title: code || 'api exception',
    status: 200,
    detail: detail || `HTTP 200 from ${path} carried an error body`,
    instance: path,
    code: sdkCode,
    body: wireStatus === undefined ? body : { ...b, wireStatus },
  });
}

/**
 * Turn the `type:"error"` segments of a converse stream into one
 * {@link KalturaError}. The server reports some refusals IN-BAND: the HTTP
 * status is 200 and the refusal arrives as an `error` segment. Returns `null`
 * when the stream has none. `partial` rides in `body` so a caller can see what
 * the turn produced before it failed.
 * @param {Array<{type?:string, content?:unknown, threadId?:string, messageId?:string, [k:string]:unknown}>} segments
 * @param {{path?:string, requestId?:string, threadId?:string, partial?:object}} [ctx]
 * @returns {KalturaError|null}
 */
export function errorFromErrorSegments(segments, ctx = {}) {
  const errs = segments.filter((s) => s && s.type === 'error');
  if (!errs.length) return null;
  const text = errs.map((s) => (typeof s.content === 'string' && s.content ? s.content : JSON.stringify(s))).join('; ').slice(0, 500);
  const denied = /No permission for thread/i.test(text);
  const code = denied ? 'thread_access_denied' : 'stream_error';
  const hint = denied
    ? `${ctx.threadId ? `Thread ${ctx.threadId} ` : 'The thread '}belongs to a different user. Start the session without this threadId, or mint the token with the userId that created the thread.`
    : '';
  return new KalturaError({
    type: BASE + code,
    title: code.replace(/_/g, ' '),
    status: 200,
    detail: `The server refused the turn: ${text.replace(/[.\s]+$/, '')}.${hint ? ` ${hint}` : ''}`,
    instance: ctx.path,
    code,
    requestId: ctx.requestId,
    body: { errors: errs, ...(ctx.threadId ? { threadId: ctx.threadId } : {}), ...(ctx.partial ? { partial: ctx.partial } : {}) },
  });
}

/** @param {unknown} body */
function extractMessage(body) {
  if (typeof body === 'string') return body.slice(0, 500);
  if (body && typeof body === 'object') {
    const b = /** @type {Record<string, unknown>} */ (body);
    if (typeof b.message === 'string') return b.message;
    if (typeof b.detail === 'string') return b.detail;
    // 422 validation errors return detail as an array of {loc, msg, type}; join the msgs
    // so the actionable text (e.g. "Input should be 'markdown','flashcards'…") surfaces.
    if (Array.isArray(b.detail)) {
      const msgs = b.detail.map((d) => (d && typeof d === 'object' && d.msg) ? String(d.msg) : (typeof d === 'string' ? d : '')).filter(Boolean);
      if (msgs.length) return msgs.join('; ').slice(0, 500);
    }
    if (typeof b.error === 'string') return b.error;
  }
  return undefined;
}
