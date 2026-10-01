/**
 * Base URLs per Kaltura region. One frozen table is the single source of truth
 * for every host the SDK picks on its own. `Management` and the Experience
 * sessions resolve their base URLs through {@link resolveEndpoints}: an explicit
 * `*Url` option wins, then the `region` entry, then `nvp1` (US). A service the
 * region does not run is `null`, never a fallback to another region's host.
 */
import { KalturaError } from './errors.js';
import { assertSecureTransport } from './transport-guard.js';

/**
 * Kaltura deployment code. `nvp1` = US (the default), `frp2` = EU (Frankfurt).
 * @typedef {'nvp1'|'frp2'} KalturaRegion
 */

/**
 * Base URLs for one region. `null` = that service is not available in the region.
 * @typedef {object} KalturaEndpoints
 * @property {string}      agenticUrl
 * @property {string}      genieUrl
 * @property {string}      ovpUrl
 * @property {string|null} messagingUrl
 */

/**
 * Verified base URLs per region. Deep-frozen. `Object.keys(REGIONS)` lists the
 * supported codes. Pass `region` to `Management` or an Experience session
 * instead of spreading an entry yourself.
 * @type {Readonly<Record<KalturaRegion, Readonly<KalturaEndpoints>>>}
 */
export const REGIONS = Object.freeze({
  nvp1: Object.freeze({
    agenticUrl: 'https://api.avatar.us.kaltura.ai/v1',
    genieUrl: 'https://genie.nvp1.ovp.kaltura.com',
    ovpUrl: 'https://www.kaltura.com/api_v3',
    messagingUrl: 'https://messaging.nvp1.ovp.kaltura.com/api/v1',
  }),
  frp2: Object.freeze({
    agenticUrl: 'https://api.avatar.eu.kaltura.ai/v1',
    genieUrl: 'https://genie.frp2.ovp.kaltura.com',
    ovpUrl: 'https://api.frp2.ovp.kaltura.com/api_v3',
    messagingUrl: null,
  }),
});

const REGION_LABELS = Object.freeze({ nvp1: 'US', frp2: 'EU' });

/** @param {string} detail */
const badRequest = (detail) => new KalturaError({ type: 'about:blank', title: 'bad endpoint config', code: 'bad_request', detail });

/**
 * Resolve base URLs: explicit `*Url` > `REGIONS[region]` > `REGIONS.nvp1`.
 * Strips one trailing slash. Enforces HTTPS: http to a localhost or private host
 * only warns, http to any other host throws unless `cfg.allowInsecureTransport`.
 * Reads only `cfg`.
 * @param {{ region?: KalturaRegion, allowInsecureTransport?: boolean } & Partial<KalturaEndpoints>} cfg
 * @param {ReadonlyArray<keyof KalturaEndpoints>} keys Services this caller needs.
 * @param {(msg: string) => void} [warn] Sink for insecure-transport warnings.
 * @returns {Readonly<Partial<KalturaEndpoints>>} Frozen. A key is `null` when the region does not run that service and no override was passed.
 * @throws {KalturaError} `bad_request` for an unknown region, a URL that does not parse, or a URL with credentials. `insecure_transport` for http to a public host.
 */
export function resolveEndpoints(cfg, keys, warn = () => {}) {
  const region = cfg.region ?? 'nvp1';
  if (typeof region !== 'string' || !Object.hasOwn(REGIONS, region)) {
    const supported = Object.keys(REGIONS).map((r) => `${r} (${REGION_LABELS[r]})`).join(', ');
    throw badRequest(`Unknown region '${String(region)}'. Supported: ${supported}. For other deployments pass agenticUrl, genieUrl, ovpUrl and messagingUrl.`);
  }
  /** @type {Partial<KalturaEndpoints>} */
  const out = {};
  for (const key of keys) {
    const url = cfg[key] || REGIONS[region][key];
    if (!url) { out[key] = null; continue; }
    let u;
    try { u = new URL(url); } catch { throw badRequest(`${key} is not a valid URL.`); }
    if (u.username || u.password) throw badRequest(`${key} must not contain credentials.`);
    assertSecureTransport(url, key, !!cfg.allowInsecureTransport, warn);
    out[key] = url.replace(/\/$/, '');
  }
  return Object.freeze(out);
}
