/**
 * highlight_element client-tool handler + per-page context feed. Scans the
 * live <main> for [data-nova-target] elements PLUS every heading (h2/h3 have
 * a stable slug `id` from markdown-it-anchor, see the site's eleventy.config.js)
 * on every nova:pagechange (and once at initial connect), and pushes the
 * current page's identity + {id,label} target list to the brain in ONE
 * session.setDynamicPrompt call — mirroring how the SDK's own Presenter
 * plugin feeds per-slide context via the same page_context request variable.
 * setDynamicPrompt has no server-side merge across calls (it's a whole-blob
 * replace), so this is the only call site that may ever push page-scoped
 * context; a future caller must add its
 * key HERE rather than firing a second setDynamicPrompt that would silently
 * clobber this one. The page identity matters because a visitor can navigate
 * by clicking a sidebar link directly (router.js's own click handler) with
 * no tool call in between — without it, Nova's only signal that the page
 * changed is a relabeled target list, with nothing telling her WHICH page
 * she's now grounded on. Headings give full section-level highlight coverage
 * on every doc page for free, with no hand-authored data-nova-target needed;
 * data-nova-target stays available for pointing at something narrower than a
 * whole section (a specific example, a table). Like navigate_to_page this
 * tool is `waitForResponse:true`: a found/not-found ack is what lets the
 * brain tell the truth about whether it actually pointed at something,
 * rather than a silently-swallowed miss it could still narrate as a success.
 */
import { pointAt } from './dock.js';
import { currentRoute } from './router.js';

// Exported so navigator.js's navigate_to_page ack can carry the SAME list — a combined "go
// there and highlight X" request needs it in the ack (synchronously visible within the current
// turn) because setDynamicPrompt only merges on the brain's NEXT turn (pushing
// it via nova:pagechange right after the nav ack still isn't there yet for a highlight_element
// decision made in that same turn).
export function currentTargets() {
  const main = document.querySelector('main.content-wrapper');
  if (!main) return [];
  const seen = new Set();
  const targets = [];
  for (const el of main.querySelectorAll('[data-nova-target]')) {
    const id = el.getAttribute('data-nova-target');
    if (seen.has(id)) continue;
    seen.add(id);
    targets.push({ id, label: el.getAttribute('data-nova-label') || '' });
  }
  for (const el of main.querySelectorAll('h2[id], h3[id]')) {
    if (seen.has(el.id)) continue;
    seen.add(el.id);
    targets.push({ id: el.id, label: el.textContent.trim() });
  }
  return targets;
}

export function initHighlighter(session) {
  function pushTargets() {
    if (session.state !== 'connected') return;
    session.setDynamicPrompt({
      page: { title: document.title, url: currentRoute() },
      highlightable_elements: currentTargets(),
    });
  }

  session.on('stateChange', ({ state }) => {
    if (state === 'connected') pushTargets();
  });
  document.addEventListener('nova:pagechange', pushTargets);

  session.onToolCall('highlight_element', async (args, call) => {
    const id = call?.toolMetadata?.id;
    const ack = (response) => (id ? session.respondToTool(id, response) : Promise.resolve());

    const target = typeof args?.target === 'string' ? args.target : '';
    if (!target) {
      await ack({ ok: false, error: 'not_found' });
      return;
    }
    const el =
      document.querySelector(`main.content-wrapper [data-nova-target="${CSS.escape(target)}"]`) ||
      document.querySelector(`main.content-wrapper #${CSS.escape(target)}`);
    if (!el) {
      await ack({ ok: false, error: 'not_found' });
      return;
    }
    await ack({ ok: true, target });
    // Headings can sit anywhere down a long reference page — jump there first
    // (instant, not smooth: pointAt reads getBoundingClientRect() right after,
    // so an in-flight smooth-scroll would leave the ring pointing at a stale rect).
    el.scrollIntoView({ behavior: 'auto', block: 'center' });
    pointAt(el);
  });
}
