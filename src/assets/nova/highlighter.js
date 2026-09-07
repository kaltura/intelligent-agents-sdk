/**
 * Page-context feed: pushes the current page's identity and go_to section
 * keys to the brain in ONE session.setDynamicPrompt call, on every
 * nova:pagechange (and once at initial connect) — mirroring how the SDK's own
 * Presenter plugin feeds per-slide context via the same page_context request
 * variable. setDynamicPrompt has no server-side merge across calls (it's a
 * whole-blob replace), so this is the only call site that may ever push
 * page-scoped context; a future caller must add its key HERE rather than
 * firing a second setDynamicPrompt that would silently clobber this one.
 * The page identity matters because a visitor can navigate by clicking a
 * sidebar link directly (router.js's own click handler) with no tool call in
 * between — without it, Nova's only signal that the page changed is gone.
 * The section-key list lets a same-page "show me X" request resolve to an
 * exact go_to key instead of a guess.
 */
import { currentRoute } from './router.js';

/**
 * @param {object} session
 * @param {object} [siteNav] The SiteNavigator from site-nav.js. When given, the
 *   page context also carries `sections`: the current page's go_to section keys
 *   from the same manifest the brain's SITE MAP was rendered from.
 */
export function initHighlighter(session, siteNav) {
  async function pushTargets() {
    // The manifest load is a one-time fetch that resolves before or shortly
    // after connect; awaiting it here means the first push already has keys.
    // `ready` never rejects (a failed load just leaves the manifest null).
    if (siteNav) await siteNav.ready;
    if (session.state !== 'connected') return;
    const route = currentRoute();
    const page = siteNav?.manifest?.pages.find((p) => p.path === route);
    session.setDynamicPrompt({
      page: { title: document.title, url: route },
      sections: page ? page.sections.map((s) => s.key) : [],
    });
  }

  session.on('stateChange', ({ state }) => {
    if (state === 'connected') pushTargets();
  });
  document.addEventListener('nova:pagechange', pushTargets);
}
