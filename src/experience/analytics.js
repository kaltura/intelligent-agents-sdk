/**
 * KAVA (Kaltura Video Analytics) reporting — client-only Application Events.
 *
 * Deliberately implements ONLY the 10000-range "Application Event" family —
 * `pageLoad` (10003) and `buttonClicked` (10002) — for interactions the
 * server has zero visibility into (a page/view landing, a UI-only click the
 * backend never learns about). This is a STANDALONE reporter: it never reads
 * from or subscribes to a `KalturaAvatarSession`.
 *
 * The 80000-range "Immersive Agents" events (`callStarted`/`callEnded`/
 * `messageResponse`/`messageFeedbackSent`) are intentionally NOT implemented
 * here, and there is no code path in this module that can send them.
 * The backend already reports all four server-side for
 * every session `KalturaAvatarSession` connects to (same socket, matching
 * event names) — a client-side copy would double-count
 * on the live analytics dashboards. If a real gap in that server-side
 * reporting is ever found, file it as a GitHub issue rather than adding a
 * client resend.
 *
 * Fire-and-forget by design (no retry contract, no batching — one HTTP call
 * per event): prefers `navigator.sendBeacon` (survives page-unload) and
 * falls back to an injectable `fetch` with `keepalive:true`. Never reads a
 * response body, so there is no size cap to enforce.
 */
import { KalturaError } from '../core/errors.js';

/** The KAVA ingestion endpoint (query/body target for `service=analytics&action=trackEvent`). */
export const DEFAULT_ANALYTICS_URL = 'https://analytics.kaltura.com/api_v3/index.php';

/** The only two valid client-side event codes. Never add an 80000-range entry here. */
export const EVENT_TYPES = Object.freeze({ pageLoad: 10003, buttonClicked: 10002 });

/**
 * `hostingKalturaApplication` values (not strictly validated server-side —
 * closest match is acceptable). Exported so callers don't have to guess.
 */
export const HOSTING_APPLICATIONS = Object.freeze({
  genieChat: 23, agents: 25, modelsSdk: 26, conversationManager: 27,
  avatarVideos: 28, agenticAvatarsStudio: 29, kaiVendor: 31,
});

/** Closed enum for `pageType` (the field is validated; `buttonType` is not — the guide leaves it open-ended). */
export const PAGE_TYPES = Object.freeze([
  'View', 'Create', 'Edit', 'Participate', 'List', 'Analytics', 'Admin', 'Error', 'Login', 'Registration', 'Custom',
]);

/** Drop undefined/null values so they never serialize as the literal string "undefined". @param {object} obj */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}

/**
 * The common params shared by every KAVA Application Event.
 * @param {{partnerId?:string|number, ks?:string, entryId?:string, sessionId?:string, referrer?:string, userId?:string, hostingKalturaApplication?:number, hostingKalturaApplicationVer?:string, customId1?:string, customId2?:string}} common
 */
function commonParams(common = {}) {
  return compact({
    partnerId: common.partnerId, ks: common.ks, entryId: common.entryId, sessionId: common.sessionId,
    referrer: common.referrer, userId: common.userId,
    hostingKalturaApplication: common.hostingKalturaApplication, hostingKalturaApplicationVer: common.hostingKalturaApplicationVer,
    customId1: common.customId1, customId2: common.customId2,
  });
}

/**
 * Build the exact wire params for a `pageLoad` (10003) event. Pure, never throws on missing
 * optional fields — throws only if `pageType` is set to a value outside {@link PAGE_TYPES}.
 * @param {object} common see {@link commonParams}
 * @param {{pageType?:string, pageName?:string, pageValue?:string, pageInfo?:string}} fields
 */
export function buildPageLoadParams(common, fields = {}) {
  if (fields.pageType !== undefined && !PAGE_TYPES.includes(fields.pageType)) {
    throw new KalturaError({ type: 'about:blank', title: 'bad pageType', code: 'bad_request', detail: `invalid pageType "${fields.pageType}" — must be one of ${PAGE_TYPES.join(', ')}` });
  }
  return {
    service: 'analytics', action: 'trackEvent', eventType: String(EVENT_TYPES.pageLoad),
    ...commonParams(common),
    ...compact({ pageType: fields.pageType, pageName: fields.pageName, pageValue: fields.pageValue, pageInfo: fields.pageInfo }),
  };
}

/**
 * Build the exact wire params for a `buttonClicked` (10002) event. Pure. `buttonType` is
 * intentionally NOT validated against a closed enum — the spec leaves it open-ended.
 * @param {object} common see {@link commonParams}
 * @param {{buttonType?:string, buttonName?:string, buttonValue?:string, buttonInfo?:string}} fields
 */
export function buildButtonClickedParams(common, fields = {}) {
  return {
    service: 'analytics', action: 'trackEvent', eventType: String(EVENT_TYPES.buttonClicked),
    ...commonParams(common),
    ...compact({ buttonType: fields.buttonType, buttonName: fields.buttonName, buttonValue: fields.buttonValue, buttonInfo: fields.buttonInfo }),
  };
}

/**
 * Fire-and-forget KAVA reporter for the 10000-range Application Events. Construct once per
 * page/app instance with the common params that don't change per event; pass event-specific
 * fields to {@link KavaAnalytics#pageLoad}/{@link KavaAnalytics#buttonClicked}.
 *
 * WRITE, best-effort, NOT idempotent (each call records a new analytics row; the backend has
 * no dedup contract) — never awaited for correctness, since KAVA has no retry/ack contract.
 */
export class KavaAnalytics {
  /**
   * @param {object} [opts]
   * @param {string} [opts.endpoint] Override the KAVA URL (testing).
   * @param {boolean} [opts.enabled] Set `false` to no-op every call without touching the network (e.g. offline/mock mode).
   * @param {typeof fetch} [opts.fetch] Injectable fetch fallback (defaults to `globalThis.fetch`, bound).
   * @param {(url:string, data?:BodyInit) => boolean} [opts.sendBeacon] Injectable beacon sender (defaults to `navigator.sendBeacon`, bound).
   * @param {string|number} [opts.partnerId]
   * @param {string} [opts.ks]
   * @param {string} [opts.entryId]
   * @param {string} [opts.sessionId]
   * @param {string} [opts.referrer]
   * @param {string} [opts.userId]
   * @param {number} [opts.hostingKalturaApplication] see {@link HOSTING_APPLICATIONS}
   * @param {string} [opts.hostingKalturaApplicationVer]
   * @param {string} [opts.customId1]
   * @param {string} [opts.customId2]
   */
  constructor(opts = {}) {
    this._endpoint = opts.endpoint || DEFAULT_ANALYTICS_URL;
    this._enabled = opts.enabled !== false;
    this._fetch = 'fetch' in opts ? opts.fetch : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
    this._sendBeacon = 'sendBeacon' in opts ? opts.sendBeacon
      : (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' ? navigator.sendBeacon.bind(navigator) : undefined);
    this._common = {
      partnerId: opts.partnerId, ks: opts.ks, entryId: opts.entryId, sessionId: opts.sessionId,
      referrer: opts.referrer, userId: opts.userId,
      hostingKalturaApplication: opts.hostingKalturaApplication, hostingKalturaApplicationVer: opts.hostingKalturaApplicationVer,
      customId1: opts.customId1, customId2: opts.customId2,
    };
  }

  /**
   * Report a page/view landing (10003) — once per page the user lands on.
   * @param {{pageType?:string, pageName?:string, pageValue?:string, pageInfo?:string}} [fields]
   * @returns {Promise<{ok:boolean, transport:'beacon'|'fetch'|'disabled'|'none'}>}
   */
  pageLoad(fields = {}) {
    return this._send(buildPageLoadParams(this._common, fields));
  }

  /**
   * Report a UI-only interaction the server can't see (10002) — a click, a contact-form
   * submit/skip, a widget dismiss, etc.
   * @param {{buttonType?:string, buttonName?:string, buttonValue?:string, buttonInfo?:string}} [fields]
   * @returns {Promise<{ok:boolean, transport:'beacon'|'fetch'|'disabled'|'none'}>}
   */
  buttonClicked(fields = {}) {
    return this._send(buildButtonClickedParams(this._common, fields));
  }

  /** @param {Record<string,string>} params @returns {Promise<{ok:boolean, transport:'beacon'|'fetch'|'disabled'|'none'}>} */
  _send(params) {
    if (!this._enabled) return Promise.resolve({ ok: false, transport: 'disabled' });
    const body = new URLSearchParams(params).toString();
    if (this._sendBeacon) {
      const queued = this._sendBeacon(this._endpoint, body);
      if (queued) return Promise.resolve({ ok: true, transport: 'beacon' });
    }
    if (!this._fetch) return Promise.resolve({ ok: false, transport: 'none' });
    return this._fetch(this._endpoint, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }).then(() => ({ ok: true, transport: 'fetch' })).catch(() => ({ ok: false, transport: 'fetch' }));
  }
}
