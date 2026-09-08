/**
 * @kaltura/intelligent-agents/experience/site-nav — the browser half of the
 * fire-and-forget `go_to` site navigation contract. Its own subpath so apps
 * that don't navigate a site never load it.
 *
 * The brain emits `go_to({ path, section? })` against a SITE MAP that was
 * rendered from a `sections.json` manifest (see `management/site-nav`). This
 * plugin resolves that pair against the same manifest, moves the visitor
 * there through YOUR `navigate()` function, scrolls to the section once the
 * page is in the DOM, and optionally highlights it. It never answers the
 * tool call: `go_to` is provisioned with `wait_for_response: false`, so the
 * backend synthesizes the result itself and there is nothing to ACK, time out
 * on, or retry.
 *
 * Framework-agnostic on purpose. `navigate(url)` is the only required hook; it
 * can be a SPA router push, `location.assign(url)`, or anything else. When it
 * does a full page load the URL already carries `#<section-id>`, so the
 * browser lands on the anchor natively and this instance simply dies with
 * the page.
 *
 * Safety (constitution S-3, S-4, P-1): only manifest paths are ever navigated
 * to (an invented path is dropped, never guessed; a section glued onto a page
 * path is split back apart by `resolveTarget`), every URL passes `safeUrl`,
 * a fetched manifest is size-guarded and validated, elements are looked up by
 * id (no selector building, no `innerHTML`).
 *
 * @example
 * import { SiteNavigator } from '@kaltura/intelligent-agents/experience/site-nav';
 *
 * const nav = new SiteNavigator({
 *   session,
 *   manifestUrl: '/nova/sections.json',
 *   navigate: (url) => router.push(url),   // or (url) => location.assign(url)
 *   point: (el) => el.classList.add('is-pointed'),
 * });
 * // later
 * nav.destroy();
 */

import { Teardown } from './teardown.js';
import { safeUrl } from '../core/safety.js';
import { normalizePath, resolveTarget, validateSectionsManifest } from '../core/site-keys.js';

/** Live SiteNavigator count per session, for the forgotten-destroy warning. Dev-time only, never affects behavior. @type {WeakMap<object, number>} */
const liveNavigators = new WeakMap();

/** Default size guard for a fetched manifest (P-1). */
const DEFAULT_MANIFEST_MAX_BYTES = 512 * 1024;

/** Linear-time `/\/+$/` strip: `pathPrefix` is host-supplied, so no backtracking regex on it. */
function trimTrailingSlashes(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end -= 1;
  return s.slice(0, end);
}

/**
 * Passed to `navigate`, `scrollTo`, `point` and `onNavigate` for a call that resolved to a manifest page.
 * @typedef {object} SiteNavInfo
 * @property {string} path Manifest path that matched (`/guides/pause-resume/`).
 * @property {string} url Same-origin URL handed to `navigate` (prefix + path, plus `#id` when a section resolved and `updateHash` is on).
 * @property {string|null} section Resolved section key, or `null` for the page top.
 * @property {string|null} sectionId DOM id of the resolved section, or `null`.
 * @property {import('../core/site-keys.js').SectionMatch|null} resolvedBy How the section matched, or `null`.
 * @property {boolean} fellBackToTop `true` when the brain sent a section that matched nothing (page top used instead).
 * @property {boolean} splitPath `true` when the path was not a page and its last segment resolved as a section of the parent page (`resolveTarget`).
 * @property {boolean} samePage `true` when the visitor was already on that page (`navigate` skipped).
 * @property {boolean} [sectionFound] Set after the scroll step: whether the section element was in the DOM.
 * @property {{path?:unknown, section?:unknown}} args Raw tool args as the brain sent them.
 */

/**
 * Passed to `onNavigate` for a call that did nothing.
 * @typedef {object} SiteNavDropped
 * @property {true} dropped
 * @property {'unknown_path'|'once_per_turn'|'no_manifest'|'unsafe_url'|'destroyed'} reason
 * @property {{path?:unknown, section?:unknown}} args Raw tool args as the brain sent them.
 */

/**
 * Browser-side handler for the `go_to` client tool. Construct once per
 * session, right after the session, and call {@link SiteNavigator#destroy}
 * when the session ends (idempotent).
 */
export class SiteNavigator {
  /**
   * @param {object} cfg
   * @param {object} cfg.session          A `KalturaAvatarSession` (or anything with `onToolCall(name, handler)` and `on('turnStart', handler)` returning unsubscribes).
   * @param {(url:string, info:SiteNavInfo)=>unknown} cfg.navigate  Moves the visitor to `url` (same origin, already safe). Return a promise to delay section scrolling until the new page is in the DOM. Called only for a different page.
   * @param {import('../core/site-keys.js').SectionsManifest|{pages:Array}} [cfg.manifest]  Inline manifest. Required unless `manifestUrl` is set; when both are set, this one serves until the fetch resolves.
   * @param {string} [cfg.manifestUrl]    Same-origin URL of `sections.json`. Fetched once at construction, size-guarded, validated.
   * @param {number} [cfg.manifestMaxBytes=524288]  Reject a fetched manifest larger than this.
   * @param {string} [cfg.pathPrefix='']  Deployment prefix the manifest paths are relative to (e.g. `/docs` on a project Pages site). Also stripped from `location.pathname` when detecting the current page.
   * @param {(el:Element, info:SiteNavInfo)=>void} [cfg.scrollTo]  Replaces the default `el.scrollIntoView({ behavior: 'smooth', block: 'start' })`.
   * @param {(el:Element, info:SiteNavInfo)=>void} [cfg.point]  Highlight hook, called after the scroll with the section element.
   * @param {(info:SiteNavInfo|SiteNavDropped)=>void} [cfg.onNavigate]  Fires once per tool call with what happened. Use it for analytics and tests.
   * @param {()=>string} [cfg.currentPath]  Returns the visitor's current site path (prefix-free). Defaults to `location.pathname` minus `pathPrefix`. Same-page calls skip `navigate`.
   * @param {string} [cfg.toolCallName='go_to']  Client-command name to listen for.
   * @param {boolean} [cfg.oncePerTurn=true]  Execute only the first resolving call per brain turn; later ones are dropped with `reason: 'once_per_turn'`. Invalid calls never use up the slot. Resets on `turnStart` with `isNewTurn: true`.
   * @param {boolean} [cfg.updateHash=true]  Write `#<section-id>` to the address bar via `history.replaceState` (and append it to the URL given to `navigate`).
   * @param {number} [cfg.settleMs=250]  After `navigate` resolves, wait one frame, then this long before the single retry when the section element is not yet in the DOM.
   * @param {(msg:string)=>void} [cfg.warn]  Warning sink (default `console.warn`).
   * @param {object} [cfg.window]         Window-like object (`document`, `history`, `location`, `fetch`, `requestAnimationFrame`). Defaults to `globalThis`. Inject for tests.
   */
  constructor(cfg) {
    if (!cfg?.session) throw new Error('SiteNavigator needs { session }');
    if (typeof cfg.navigate !== 'function') throw new Error('SiteNavigator needs { navigate }');
    if (!cfg.manifest && !cfg.manifestUrl) throw new Error('SiteNavigator needs { manifest } or { manifestUrl }');
    this.session = cfg.session;
    this._win = cfg.window || globalThis;
    this._navigate = cfg.navigate;
    this._scrollTo = cfg.scrollTo || null;
    this._point = cfg.point || null;
    this._onNavigate = cfg.onNavigate || (() => {});
    this._currentPath = cfg.currentPath || null;
    this._prefix = trimTrailingSlashes(String(cfg.pathPrefix || ''));
    this._toolCallName = cfg.toolCallName || 'go_to';
    this._oncePerTurn = cfg.oncePerTurn !== false;
    this._updateHash = cfg.updateHash !== false;
    this._settleMs = cfg.settleMs ?? 250;
    this._warn = cfg.warn || ((m) => console.warn(m));
    this._manifest = cfg.manifest || null;
    this._turnUsed = false;
    this._destroyed = false;
    this._teardown = new Teardown();

    /**
     * Resolves once the manifest is usable (inline, or fetched from `manifestUrl`).
     * Resolves to the manifest, or `null` when the fetch failed and there was no inline copy.
     * @type {Promise<object|null>}
     */
    this.ready = cfg.manifestUrl ? this._load(cfg.manifestUrl, cfg.manifestMaxBytes ?? DEFAULT_MANIFEST_MAX_BYTES) : Promise.resolve(this._manifest);

    const live = liveNavigators.get(this.session) || 0;
    if (live > 0) this._warn('[SiteNavigator] a SiteNavigator is already live on this session. Call destroy() on the previous one first, or both will navigate on every go_to call.');
    liveNavigators.set(this.session, live + 1);
    this._wire();
  }

  /** The manifest currently in use (`null` until `ready` resolves when only `manifestUrl` was given). @returns {object|null} */
  get manifest() { return this._manifest; }

  /**
   * Fetch, size-guard and validate `sections.json`. Never throws: a failure is
   * warned and leaves the inline manifest (or `null`) in place.
   * @param {string} url @param {number} maxBytes @returns {Promise<object|null>}
   */
  async _load(url, maxBytes) {
    const f = typeof this._win.fetch === 'function' ? this._win.fetch.bind(this._win) : (typeof fetch === 'function' ? fetch : null);
    try {
      const href = safeUrl(url);
      if (!href) throw new Error('unsafe manifest URL');
      if (!f) throw new Error('fetch is not available');
      const res = await f(href, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers?.get?.('content-length'));
      if (declared > maxBytes) throw new Error(`${declared} bytes exceeds the ${maxBytes} byte limit`);
      const text = await res.text();
      if (text.length > maxBytes) throw new Error(`${text.length} bytes exceeds the ${maxBytes} byte limit`);
      const m = validateSectionsManifest(JSON.parse(text));
      if (!this._destroyed) this._manifest = m;
    } catch (e) {
      this._warn(`[SiteNavigator] sections manifest not loaded from ${url}: ${e?.detail || e?.message || e}`);
    }
    return this._manifest;
  }

  /** Subscribe to the session; every unsubscribe is tracked for `destroy()` (I-4). */
  _wire() {
    const s = this.session;
    this._teardown.track(s.onToolCall(this._toolCallName, (args) => this._handle(args && typeof args === 'object' ? args : {})));
    if (typeof s.on === 'function') {
      this._teardown.track(s.on('turnStart', (p) => { if (p?.isNewTurn) this._turnUsed = false; }));
    }
  }

  /**
   * One tool call, start to finish. Resolves after the section step so tests
   * (and `toolCallResult` listeners) can await the whole effect.
   * @param {{path?:unknown, section?:unknown}} args
   * @returns {Promise<void>}
   */
  async _handle(args) {
    if (this._destroyed) return;
    if (!this._manifest) await this.ready;
    if (this._destroyed) return;
    const manifest = this._manifest;
    if (!manifest) { this._onNavigate({ dropped: true, reason: 'no_manifest', args }); return; }

    const target = resolveTarget(manifest, args.path, args.section);
    if (!target) { this._onNavigate({ dropped: true, reason: 'unknown_path', args }); return; }
    const { page, match, split } = target;
    if (this._oncePerTurn && this._turnUsed) { this._onNavigate({ dropped: true, reason: 'once_per_turn', args }); return; }

    const base = safeUrl(this._prefix + page.path);
    if (!base || !base.startsWith('/') || base.startsWith('//')) { this._onNavigate({ dropped: true, reason: 'unsafe_url', args }); return; }
    this._turnUsed = true;

    const sectionId = match ? match.section.id : null;
    const samePage = this._isCurrent(page.path);
    /** @type {SiteNavInfo} */
    const info = {
      path: page.path,
      url: sectionId && this._updateHash ? `${base}#${sectionId}` : base,
      section: match ? match.section.key : null,
      sectionId,
      resolvedBy: match ? match.by : null,
      fellBackToTop: args.section != null && String(args.section).trim() !== '' && !match,
      splitPath: !!split,
      samePage,
      args,
    };

    if (!samePage) await this._navigate(info.url, info);
    if (this._destroyed) return;

    if (sectionId) {
      const el = await this._findSection(sectionId, samePage);
      info.sectionFound = !!el;
      if (el) {
        if (this._scrollTo) this._scrollTo(el, info);
        else if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (this._updateHash) this._writeHash(sectionId);
        if (this._point) this._point(el, info);
      }
    }
    this._onNavigate(info);
  }

  /** Whether `path` is the page the visitor is on now. @param {string} path @returns {boolean} */
  _isCurrent(path) {
    let current;
    if (this._currentPath) current = this._currentPath();
    else {
      const loc = this._win.location;
      if (!loc || typeof loc.pathname !== 'string') return false;
      current = loc.pathname;
      if (this._prefix && current.startsWith(this._prefix)) current = current.slice(this._prefix.length) || '/';
    }
    return normalizePath(current).toLowerCase() === normalizePath(path).toLowerCase();
  }

  /**
   * Look the section element up by id: immediately for a same-page call, else
   * after one animation frame, with one retry after `settleMs`.
   * @param {string} id @param {boolean} samePage @returns {Promise<Element|null>}
   */
  async _findSection(id, samePage) {
    const doc = this._win.document;
    if (!doc || typeof doc.getElementById !== 'function') return null;
    let el = doc.getElementById(id);
    if (el || samePage) return el;
    await this._nextFrame();
    el = doc.getElementById(id);
    if (el) return el;
    await new Promise((r) => setTimeout(r, this._settleMs));
    return doc.getElementById(id);
  }

  /** One animation frame (or a macrotask when rAF is unavailable). @returns {Promise<void>} */
  _nextFrame() {
    const raf = this._win.requestAnimationFrame;
    return new Promise((r) => (typeof raf === 'function' ? raf.call(this._win, () => r()) : setTimeout(r, 0)));
  }

  /** `history.replaceState` to `#id` without triggering a scroll or a navigation. @param {string} id */
  _writeHash(id) {
    const h = this._win.history;
    if (!h || typeof h.replaceState !== 'function') return;
    try { h.replaceState(h.state ?? null, '', `#${id}`); } catch { /* sandboxed or cross-origin document: the hash is cosmetic */ }
  }

  /**
   * Remove every session listener this instance added. Idempotent (D-4); after
   * it, tool calls are ignored and an in-flight one stops before touching the DOM.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    const live = (liveNavigators.get(this.session) || 1) - 1;
    if (live > 0) liveNavigators.set(this.session, live);
    else liveNavigators.delete(this.session);
    this._teardown.run();
  }

  /** Alias for {@link SiteNavigator#destroy}, matching `Presenter#stop()`. */
  stop() { this.destroy(); }
}
