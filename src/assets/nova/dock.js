/**
 * Hero <-> dock positioning for the persistent #nova-widget. The widget is
 * always `position: fixed` and never re-parented (see base.njk) — this
 * module only ever writes inline top/left/width/height, so the hero-to-dock
 * transition is a single continuous CSS animation (FLIP), never a DOM move
 * that would risk disrupting the live WHEP video element or socket session.
 */
const widget = document.getElementById('nova-widget');

const DOCK_MARGIN = 24;
const DOCK_SIZE = window.matchMedia('(max-width: 600px)').matches ? 180 : 240;
const HIGHLIGHT_MS = 5000;
const RING_FADE_MS = 300;

let mode = 'none'; // 'hero' | 'dock'
let rafPending = false;
let dockRect = null;
let revertTimer = null;
let activeRing = null;
let detachRingInterrupts = null;

function heroSlot() {
  return document.getElementById('nova-hero-slot');
}

function applyRect(rect) {
  widget.style.top = `${rect.top}px`;
  widget.style.left = `${rect.left}px`;
  widget.style.width = `${rect.width}px`;
  widget.style.height = `${rect.height}px`;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function currentDockSize() {
  return window.matchMedia('(max-width: 600px)').matches ? 180 : 240;
}

function computeDockRect() {
  const size = currentDockSize();
  return {
    top: window.innerHeight - size - DOCK_MARGIN,
    left: window.innerWidth - size - DOCK_MARGIN,
    width: size,
    height: size,
  };
}

function redockOnResize() {
  if (mode !== 'dock' || widget.classList.contains('pointing')) return;
  dockRect = computeDockRect();
  applyRect(dockRect);
}

/** Wide viewport = the two-column hero layout (copy left, visual right,
 * see styles.css's 900px breakpoint) — the slot sits within the initial
 * viewport there, so continuously zooming the widget toward the corner as
 * the visitor scrolls (see updateHeroScrollProgress) keeps her out of the
 * way of the copy without ever blocking it at full size. On a stacked
 * mobile layout the slot can start below the fold, so instead we keep the
 * simpler original behavior: track the slot live on scroll, same as its
 * position in the document flow (see trackHero). */
function wideViewport() {
  return window.matchMedia('(min-width: 901px)').matches;
}

/** Narrow/mobile-only path: the widget mirrors #nova-hero-slot's live rect
 * exactly, since the stacked layout leaves no room for a separate zoom
 * treatment — the slot already moves out of the way in the document flow. */
function trackHero() {
  if (mode !== 'hero') return;
  const slot = heroSlot();
  if (!slot) {
    enterDockMode();
    return;
  }
  applyRect(slot.getBoundingClientRect());
}

function onRafThrottled(fn) {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    fn();
  });
}

let scrollAttached = false;

/** True only while the current dock state was caused by scrolling (see
 * updateHeroScrollProgress) — as opposed to a real in-site nav or a tool
 * call. Only a scroll-caused dock is reversible by scrolling back up; once
 * the visitor has actually navigated or Nova has acted, docking is
 * one-directional per session, same as before. */
let dockedByScroll = false;

// easeOutCubic — most of the shrink happens early in the scroll, then eases
// off, matching how a real "zoom into the corner" feels rather than a linear
// slide.
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Continuous hero<->dock "zoom with scroll" for wide viewports. Instead of
 * staying pinned at full size until the hero has scrolled entirely past the
 * header and then snapping into the corner dock — which blocks the page's
 * own copy at full size for the whole scroll in between — the widget
 * shrinks and slides toward the dock rect in direct proportion to scroll
 * distance, starting at the very first scrolled pixel. Fully reversible:
 * scrolling back up runs the same interpolation backward. distance is tied
 * to the hero slot's own height so the zoom speed scales naturally with the
 * breakpoint's card size. Only ever drives mode/dockedByScroll while scroll
 * is the active cause — a nav- or tool-triggered dock (enterDockMode) stays
 * one-directional because onScroll stops calling this once dockedByScroll
 * is false. */
function updateHeroScrollProgress() {
  const slot = heroSlot();
  if (!slot) {
    dockedByScroll = false;
    enterDockMode();
    return;
  }
  const slotRect = slot.getBoundingClientRect();
  const distance = slotRect.height || 1;
  const raw = Math.min(1, Math.max(0, window.scrollY / distance));
  const eased = easeOutCubic(raw);
  dockRect = computeDockRect();

  widget.style.transition = 'none';
  applyRect({
    top: lerp(slotRect.top, dockRect.top, eased),
    left: lerp(slotRect.left, dockRect.left, eased),
    width: lerp(slotRect.width, dockRect.width, eased),
    height: lerp(slotRect.height, dockRect.height, eased),
  });

  // Border-radius crossfades over the first half of the transition — by the
  // point the chrome swaps (mic icon, hard circle mask) below, the shape has
  // already finished rounding into a circle, so the swap doesn't pop.
  const wrap = widget.querySelector('.nova-video-wrap');
  if (wrap) wrap.style.borderRadius = `${Math.min(raw / 0.5, 1) * 50}%`;

  const shouldDock = raw >= 0.5;
  widget.classList.toggle('dock-mode', shouldDock);
  if (!shouldDock) widget.classList.remove('expanded');

  mode = raw >= 1 ? 'dock' : 'hero';
  dockedByScroll = raw >= 1;
}

/** Dispatches to the right per-viewport tracking behavior for whichever
 * state is currently "live" (in hero mode, or docked purely because of
 * scroll) — used by scroll, resize, and page-change handlers alike so they
 * never fall out of sync with each other. */
function refreshHero() {
  if (!wideViewport()) {
    if (mode === 'hero') trackHero();
    return;
  }
  if (mode === 'hero' || (mode === 'dock' && dockedByScroll)) {
    updateHeroScrollProgress();
  }
}

function onScroll() {
  onRafThrottled(() => {
    const trackingActive = mode === 'hero' || (mode === 'dock' && dockedByScroll);
    if (!trackingActive) {
      // Docked for a real reason (nav/tool) — one-directional, stop listening.
      if (scrollAttached) {
        window.removeEventListener('scroll', onScroll);
        scrollAttached = false;
      }
      return;
    }
    refreshHero();
  });
}

/** Attaches the scroll listener whenever we're in hero mode, on every
 * viewport width — narrow viewports use it to live-track the slot (see
 * trackHero); wide viewports use it to drive the continuous zoom (see
 * updateHeroScrollProgress), and keep listening afterward only to detect
 * scrolling back up. Self-detaches inside onScroll once docked for a
 * non-scroll reason, so no separate teardown call is needed. Called on init
 * and on every resize, so resizing across the 901px breakpoint keeps
 * exactly one listener attached. */
function syncScrollTracking() {
  if (mode !== 'hero' || scrollAttached) return;
  window.addEventListener('scroll', onScroll, { passive: true });
  scrollAttached = true;
}

/** Called once on load. If a hero slot exists on this page, position the
 * widget over it — continuously zoomed toward the dock corner as the
 * visitor scrolls on wide viewports (see updateHeroScrollProgress),
 * live-tracked on narrow/stacked ones (see trackHero). Otherwise (any page
 * other than home, before a session/nav has happened) snap straight into a
 * static dock rect with no transition. */
export function initDock() {
  const slot = heroSlot();
  if (slot) {
    mode = 'hero';
    refreshHero();
    syncScrollTracking();
    window.addEventListener('resize', () => {
      onRafThrottled(refreshHero);
      syncScrollTracking();
    });
  } else {
    mode = 'dock';
    widget.classList.add('dock-mode');
    dockRect = computeDockRect();
    applyRect(dockRect);
    window.addEventListener('resize', redockOnResize);
  }
}

/** One-directional per session for a nav/tool trigger: once docked this way,
 * hero mode never returns (see dockedByScroll for the scroll-caused case,
 * which is reversible). */
export function enterDockMode() {
  if (mode === 'dock') return;
  mode = 'dock';
  widget.classList.add('dock-mode');
  widget.style.transition = 'top 420ms cubic-bezier(0.22, 1, 0.36, 1), left 420ms cubic-bezier(0.22, 1, 0.36, 1), width 420ms cubic-bezier(0.22, 1, 0.36, 1), height 420ms cubic-bezier(0.22, 1, 0.36, 1)';
  const wrap = widget.querySelector('.nova-video-wrap');
  if (wrap) wrap.style.borderRadius = '';
  dockRect = computeDockRect();
  applyRect(dockRect);
  window.addEventListener('resize', redockOnResize);
}

/** Ends whatever pointAt() is currently doing — the natural HIGHLIGHT_MS expiry fades the
 * ring out smoothly, but a scroll or a real nav (nova:pagechange) invalidates the ring's
 * position/target instantly (it's `position: fixed` at a rect captured once, so it visually
 * drifts off the target the moment the page scrolls, and a nav can swap it out from under
 * `<main>` entirely) — those interrupts remove it immediately, no fade. */
function clearPointing(immediate) {
  clearTimeout(revertTimer);
  revertTimer = null;
  if (detachRingInterrupts) {
    detachRingInterrupts();
    detachRingInterrupts = null;
  }

  if (mode === 'dock' && widget.classList.contains('pointing')) {
    widget.classList.remove('pointing');
    dockRect = computeDockRect();
    applyRect(dockRect);
  }

  const ring = activeRing;
  activeRing = null;
  if (!ring) return;
  if (immediate) {
    ring.remove();
    return;
  }
  ring.classList.add('is-leaving');
  setTimeout(() => ring.remove(), RING_FADE_MS);
}

/** Rings targetEl for HIGHLIGHT_MS; in dock mode also briefly FLIPs the
 * widget itself toward it first. In hero mode the widget stays put (it's
 * already large and on-page) and only the ring renders. Cosmetic/best-effort. */
export function pointAt(targetEl) {
  if (!targetEl) return;
  clearPointing(true); // drop any still-showing previous ring before starting a new one
  const targetRect = targetEl.getBoundingClientRect();

  const ring = document.createElement('div');
  ring.className = 'nova-highlight-ring';
  ring.style.top = `${targetRect.top - 6}px`;
  ring.style.left = `${targetRect.left - 6}px`;
  ring.style.width = `${targetRect.width + 12}px`;
  ring.style.height = `${targetRect.height + 12}px`;
  document.body.appendChild(ring);
  activeRing = ring;

  if (mode === 'dock') {
    const size = currentDockSize();
    const margin = 16;
    let left = targetRect.right + margin;
    if (left + size > window.innerWidth - DOCK_MARGIN) left = targetRect.left - size - margin;
    left = Math.max(DOCK_MARGIN, Math.min(left, window.innerWidth - size - DOCK_MARGIN));
    let top = targetRect.top;
    top = Math.max(DOCK_MARGIN, Math.min(top, window.innerHeight - size - DOCK_MARGIN));

    widget.classList.add('pointing');
    applyRect({ top, left, width: size, height: size });
  }

  const onInterrupt = () => clearPointing(true);
  window.addEventListener('scroll', onInterrupt, { passive: true, once: true });
  document.addEventListener('nova:pagechange', onInterrupt, { once: true });
  detachRingInterrupts = () => {
    window.removeEventListener('scroll', onInterrupt);
    document.removeEventListener('nova:pagechange', onInterrupt);
  };

  revertTimer = setTimeout(() => clearPointing(false), HIGHLIGHT_MS);
}

export function dockActive() {
  return mode === 'dock';
}

// Router-driven "page changes" never reload the document, so a hero slot
// that disappears (navigating away from home) needs its own check here —
// resize/scroll alone would never catch it. Runs even before any Nova
// session exists: with no slot to track, docking is the only sane state.
document.addEventListener('nova:pagechange', () => {
  refreshHero();
});
