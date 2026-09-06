/**
 * go_to client-tool handler: the SDK's SiteNavigator plugin wired to this
 * site's SPA router, dock highlighter and build-time sections manifest.
 *
 * The brain calls go_to({ path, section? }) against the SITE MAP rendered from
 * /nova/sections.json at Nova's provisioning time; this instance resolves the
 * same pair against the same manifest, routes there, scrolls to the section
 * and draws the highlight ring. The tool is fire-and-forget on the backend
 * (wait_for_response: false), so nothing here acks, times out or retries.
 */
import { SDK_BASE } from './sdk.js';
import { withPrefix, navigateTo } from './router.js';
import { pointAt } from './dock.js';

const { SiteNavigator } = await import(`${SDK_BASE}/src/experience/site-nav.js`);

/** Same-origin URL of the manifest the build wrote next to the pages. */
export const MANIFEST_URL = withPrefix('/nova/sections.json');

/**
 * @param {object} session A connected-or-connecting KalturaAgentSession.
 * @param {{ onNavigate?: (info: object) => void }} [opts] `onNavigate` receives the SDK's SiteNavInfo per call (tests, analytics).
 * @returns {import('https://cdn.jsdelivr.net/gh/kaltura/intelligent-agents-sdk@v1.16.1/src/experience/site-nav.js').SiteNavigator}
 */
export function initSiteNav(session, { onNavigate } = {}) {
  return new SiteNavigator({
    session,
    manifestUrl: MANIFEST_URL,
    pathPrefix: window.__SITE_PATH_PREFIX__ || '',
    // SiteNavigator hands over a prefixed same-origin URL that may carry
    // `#section-id`; the router wants a bare prefixed pathname, and the
    // navigator writes the hash itself (replaceState) once the section is found.
    navigate: (url) => navigateTo(new URL(url, location.origin).pathname),
    // Instant, not smooth: pointAt reads getBoundingClientRect() right after,
    // and an in-flight smooth scroll would leave the ring on a stale rect.
    scrollTo: (el) => el.scrollIntoView({ behavior: 'auto', block: 'center' }),
    point: (el) => pointAt(el),
    onNavigate,
  });
}
