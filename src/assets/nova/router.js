/**
 * Minimal client-side content-swap router — keeps Nova's live WHEP/socket
 * session alive while the visitor moves between this static multi-page
 * site's 16 routes. A real `location.href` change would tear the session
 * down; this instead fetches the target page (rendered through the same
 * base.njk, so its <main> has the same shape as the current one), swaps
 * only <main>'s content, and updates history — Nova's widget markup lives
 * outside <main> (see base.njk) so it is never touched by a swap.
 *
 * Self-initializing on import: attaches its click/popstate listeners
 * immediately so plain site browsing gets soft navigation even before any
 * visitor talks to Nova.
 */
const PREFIX = window.__SITE_PATH_PREFIX__ || '';
const ROUTES = window.__SITE_ROUTES__ || [];

/** Prepend the GitHub Pages project-site subpath to a bare route (e.g. one
 * the brain supplies via navigate_to_page) — click-driven navigation never
 * needs this since `a.pathname` is already the browser-resolved value. */
export function withPrefix(bareRoute) {
  if (!PREFIX || bareRoute.startsWith(PREFIX)) return bareRoute;
  return `${PREFIX}${bareRoute}`;
}

export function knownRoutes() {
  return ROUTES;
}

function stripPrefix(pathname) {
  if (PREFIX && pathname.startsWith(PREFIX)) return pathname.slice(PREFIX.length) || '/';
  return pathname;
}

/** Exact match against the known route list, then a trailing-slash-normalized
 * one — no fuzzy/"closest guess" matching. Accepts either a bare or
 * prefixed path. Returns the bare route on match, null otherwise. */
export function resolveRoute(path) {
  if (typeof path !== 'string' || !path) return null;
  const bare = stripPrefix(path.trim());
  const normalized = bare.endsWith('/') || bare === '/' ? bare : `${bare}/`;
  const hit = ROUTES.find((r) => r.url === bare || r.url === normalized);
  return hit ? hit.url : null;
}

async function swapContent(pathname) {
  const res = await fetch(pathname);
  if (!res.ok) return false;
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const newMain = doc.querySelector('main.content-wrapper');
  const curMain = document.querySelector('main.content-wrapper');
  if (!newMain || !curMain) return false;

  curMain.innerHTML = newMain.innerHTML;
  document.title = doc.title;
  document.body.className = doc.body.className;

  // innerHTML= never executes <script> tags — re-create any embedded in the
  // new content so pages with inline scripts keep working.
  curMain.querySelectorAll('script').forEach((old) => {
    const fresh = document.createElement('script');
    for (const attr of old.attributes) fresh.setAttribute(attr.name, attr.value);
    fresh.textContent = old.textContent;
    old.replaceWith(fresh);
  });

  document.querySelectorAll('.sidebar a[aria-current]').forEach((a) => a.removeAttribute('aria-current'));
  const activeLink = Array.from(document.querySelectorAll('.sidebar a')).find((a) => a.pathname === pathname);
  if (activeLink) activeLink.setAttribute('aria-current', 'page');

  return true;
}

export async function navigateTo(pathname, { push = true } = {}) {
  const ok = await swapContent(pathname).catch(() => false);
  if (!ok) {
    window.location.href = pathname;
    return true;
  }
  if (push) history.pushState({ novaRouted: true }, document.title, pathname);
  window.scrollTo(0, 0);
  document.dispatchEvent(new CustomEvent('nova:pagechange', { detail: { path: pathname } }));
  return true;
}

function onClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a');
  if (!a) return;
  if (a.target === '_blank' || a.hasAttribute('download') || a.getAttribute('rel') === 'external' || a.hasAttribute('data-no-router')) return;
  if (a.origin !== location.origin) return;
  if (a.pathname === location.pathname) return; // same-page hash link — let the browser handle it
  e.preventDefault();
  navigateTo(a.pathname + a.search);
}

document.body.addEventListener('click', onClick);
window.addEventListener('popstate', () => navigateTo(location.pathname, { push: false }));
