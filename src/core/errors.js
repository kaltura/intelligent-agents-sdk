/**
 * Error model — every error the SDK throws is a {@link KalturaError} shaped as
 * an RFC 9457 "problem detail" ({type,title,status,detail,instance,...}), even
 * though the upstream APIs return errors inconsistently (sometimes HTTP 200
 * with a `{message}` body). The SDK normalizes all of them into one stable
 * contract, so callers branch on a machine-readable `code`, never on prose.
 *
 * All error fields are passed through {@link redact} so a token embedded in an
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
 * @property {unknown} [body]         The (redacted) upstream response body.
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
    /** @type {unknown} */ this.body = redact(problem.body);
  }

  /** RFC 9457 JSON representation (already redacted). */
  toJSON() {
    return {
      type: this.type, title: this.title, status: this.status,
      detail: this.detail, instance: this.instance, code: this.code,
      requestId: this.requestId, body: this.body,
    };
  }
}

const BASE = 'https://docs.kaltura.com/agentic/errors/';

/** Map a known upstream error string to a stable SDK code. */
const CODE_BY_PATTERN = [
  [/AGENT_PARTNER_CONFIG_GENIE_ID_MISMATCH/i, 'genie_id_mismatch'],
  [/AGENT_PARTNER_CONFIG_NOT_FOUND/i, 'intellect_not_found'],
  [/AGENT_NOT_FOUND/i, 'agent_not_found'],
  [/CATALOG_ITEM_NOT_FOUND/i, 'catalog_item_not_found'],
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
 * @param {{status:number, path:string, body:unknown, requestId?:string}} ctx
 */
export function errorFromResponse({ status, path, body, requestId }) {
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
    body,
  });
}

/**
 * Some endpoints return HTTP 200 with a KalturaAPIException body instead of a
 * failing status. Detect that and raise it as a real error.
 * @param {unknown} body
 * @param {string} path
 * @returns {KalturaError|null}
 */
export function errorFromOkBody(body, path) {
  if (!body || typeof body !== 'object') return null;
  const b = /** @type {Record<string, unknown>} */ (body);
  const code = typeof b.code === 'string' ? b.code : undefined;
  const message = typeof b.message === 'string' ? b.message : undefined;
  // A KalturaAPIException shape: {code, message, objectType:"KalturaAPIException"} or {message} with no success payload.
  const looksLikeException =
    b.objectType === 'KalturaAPIException' ||
    (code && message && b.args !== undefined) ||
    (message && b.error === true);
  if (!looksLikeException) return null;
  let sdkCode = 'api_exception';
  for (const [re, c] of CODE_BY_PATTERN) if (re.test(`${code || ''} ${message || ''}`)) { sdkCode = c; break; }
  return new KalturaError({
    type: BASE + sdkCode,
    title: code || 'api exception',
    status: 200,
    detail: message,
    instance: path,
    code: sdkCode,
    body,
  });
}

/** @param {unknown} body */
function extractMessage(body) {
  if (typeof body === 'string') return body.slice(0, 500);
  if (body && typeof body === 'object') {
    const b = /** @type {Record<string, unknown>} */ (body);
    if (typeof b.message === 'string') return b.message;
    if (typeof b.detail === 'string') return b.detail;
    // FastAPI validation errors return detail as an array of {loc, msg, type} — join the msgs
    // so the actionable text (e.g. "Input should be 'markdown','flashcards'…") surfaces.
    if (Array.isArray(b.detail)) {
      const msgs = b.detail.map((d) => (d && typeof d === 'object' && d.msg) ? String(d.msg) : (typeof d === 'string' ? d : '')).filter(Boolean);
      if (msgs.length) return msgs.join('; ').slice(0, 500);
    }
    if (typeof b.error === 'string') return b.error;
  }
  return undefined;
}
