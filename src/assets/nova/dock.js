/**
 * Hero <-> dock positioning for the persistent #nova-widget. The widget is
 * always `position: fixed` and never re-parented (see base.njk) — this
 * module only ever writes inline top/left/width/height, so the hero-to-dock
 * transition is a single continuous CSS animation (FLIP), never a DOM move
 * that would risk disrupting the live WHEP video element or socket session.
 */
const widget = document.getElementById('nova-widget');

const DOCK_MARGIN = 24;
const STAGE_HEADER = 64;
const DOCK_SIZE_MOBILE = 112;
const DOCK_SIZE_DESKTOP = 240;
const HIGHLIGHT_MS = 5000;
const RING_FADE_MS = 300;

let mode = 'none'; // 'hero' | 'dock'
/** Chat sessions render the widget as a full-height side drawer, positioned
 * purely by the .drawer-mode CSS class — while this flag is set, every
 * rect-writing path in this module (scroll tracking, resize redock, nav
 * docking, pointAt's FLIP) must stay hands-off so inline styles never
 * override the drawer layout. Same no-reparenting rule as hero<->dock: the
 * drawer is still the one fixed #nova-widget, so the live session survives. */
let drawerActive = false;
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
  return window.matchMedia('(max-width: 600px)').matches ? DOCK_SIZE_MOBILE : DOCK_SIZE_DESKTOP;
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
  if (drawerActive || mode !== 'dock' || widget.classList.contains('pointing')) return;
  dockRect = computeDockRect();
  applyRect(dockRect);
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

/** Continuous hero<->dock "zoom with scroll" at every viewport width. Instead of
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
  // On wide screens the slot is the whole hero stage and it scrolls away like
  // any page content. Only her box (.nova-avatar) flies to the dock; the rest
  // of the stage fades out (--hero-p, see styles.css). The stage stays put
  // until a quarter of it has scrolled under the header.
  const stage = window.matchMedia('(min-width: 901px)').matches;
  const travelled = stage ? STAGE_HEADER - slotRect.top - distance * 0.25 : window.scrollY;
  const raw = Math.min(1, Math.max(0, travelled / (stage ? distance * 0.6 : distance)));
  const eased = easeOutCubic(raw);
  dockRect = computeDockRect();

  widget.style.transition = 'none';
  const root = document.documentElement;
  const wrap = widget.querySelector('.nova-video-wrap');
  const avatar = widget.querySelector('.nova-avatar');

  if (stage) {
    applyRect(slotRect);
    // Her box leaves the widget rect on its way down, so the clip must stay
    // open on three sides. It only trims the part under the header.
    const hidden = Math.max(0, STAGE_HEADER - slotRect.top);
    widget.style.clipPath = hidden ? `inset(${hidden}px -100vmax -100vmax -100vmax)` : '';
    if (wrap) wrap.style.borderRadius = '';
    root.style.setProperty('--hero-p', eased.toFixed(4));
    root.classList.toggle('hero-leaving', raw > 0);
    widget.classList.toggle('hero-leaving', raw > 0);
    if (avatar) {
      const base = wrap.getBoundingClientRect();
      const w = avatar.offsetWidth || 1;
      const dx = dockRect.left - (base.left + avatar.offsetLeft);
      const dy = dockRect.top - (base.top + avatar.offsetTop);
      const scale = lerp(1, dockRect.width / w, eased);
      avatar.style.transform = raw > 0 ? `translate(${dx * eased}px, ${dy * eased}px) scale(${scale})` : '';
      avatar.style.borderRadius = `${eased * 50}%`;
    }
    const docked = raw >= 1;
    widget.classList.toggle('dock-mode', docked);
    if (docked) {
      // Hand over to the dock: same rect, same circle, no jump.
      applyRect(dockRect);
      widget.style.clipPath = '';
      if (avatar) {
        avatar.style.transform = '';
        avatar.style.borderRadius = '';
      }
      widget.classList.remove('hero-leaving');
    } else {
      widget.classList.remove('expanded');
    }
    mode = docked ? 'dock' : 'hero';
    dockedByScroll = docked;
    return;
  }

  clearStage(root, avatar);
  const rect = {
    top: lerp(slotRect.top, dockRect.top, eased),
    left: lerp(slotRect.left, dockRect.left, eased),
    width: lerp(slotRect.width, dockRect.width, eased),
    height: lerp(slotRect.height, dockRect.height, eased),
  };
  applyRect(rect);
  widget.style.clipPath = '';

  // Border-radius crossfades over the first half of the transition — by the
  // point the chrome swaps (mic icon, hard circle mask) below, the shape has
  // already finished rounding into a circle, so the swap doesn't pop.
  if (wrap) wrap.style.borderRadius = `${Math.min(raw / 0.5, 1) * 50}%`;

  const shouldDock = raw >= 0.5;
  widget.classList.toggle('dock-mode', shouldDock);
  if (!shouldDock) widget.classList.remove('expanded');

  mode = raw >= 1 ? 'dock' : 'hero';
  dockedByScroll = raw >= 1;
}

/** Drops everything the wide-screen flight wrote, e.g. after a resize to a narrow window. */
function clearStage(root, avatar) {
  root.style.removeProperty('--hero-p');
  root.classList.remove('hero-leaving');
  widget.classList.remove('hero-leaving');
  if (avatar) {
    avatar.style.transform = '';
    avatar.style.borderRadius = '';
  }
}

/** Re-applies the zoom for whichever state is currently "live" (in hero mode,
 * or docked purely because of scroll) — used by scroll, resize, slot-resize
 * and page-change handlers alike so they never fall out of sync. */
function refreshHero() {
  if (drawerActive) return;
  if (mode === 'hero' || (mode === 'dock' && dockedByScroll)) {
    updateHeroScrollProgress();
  }
}

/** The slot grows when a session goes live (styles.css gives the live card
 * more room for the controls and transcript), and that is not a scroll or
 * window resize, so watch the slot itself. */
let slotObserver = null;
function watchSlot() {
  slotObserver?.disconnect();
  const slot = heroSlot();
  if (!slot) return;
  slotObserver ??= new ResizeObserver(() => onRafThrottled(refreshHero));
  slotObserver.observe(slot);
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
 * viewport width to drive the continuous zoom (see
 * updateHeroScrollProgress), and keeps listening afterward only to detect
 * scrolling back up. Self-detaches inside onScroll once docked for a
 * non-scroll reason, so no separate teardown call is needed. Called on init
 * and on every resize, so exactly one listener stays attached. */
function syncScrollTracking() {
  if (mode !== 'hero' || scrollAttached) return;
  window.addEventListener('scroll', onScroll, { passive: true });
  scrollAttached = true;
}

/** Called once on load. If a hero slot exists on this page, position the
 * widget over it, continuously zoomed toward the dock corner as the
 * visitor scrolls (see updateHeroScrollProgress). Otherwise (any page
 * other than home, before a session/nav has happened) snap straight into a
 * static dock rect with no transition. */
export function initDock() {
  const slot = heroSlot();
  if (slot) {
    mode = 'hero';
    refreshHero();
    syncScrollTracking();
    watchSlot();
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
  if (drawerActive || mode === 'dock') return;
  mode = 'dock';
  widget.classList.add('dock-mode');
  widget.style.clipPath = '';
  clearStage(document.documentElement, widget.querySelector('.nova-avatar'));
  widget.style.transition = 'top 420ms cubic-bezier(0.22, 1, 0.36, 1), left 420ms cubic-bezier(0.22, 1, 0.36, 1), width 420ms cubic-bezier(0.22, 1, 0.36, 1), height 420ms cubic-bezier(0.22, 1, 0.36, 1)';
  const wrap = widget.querySelector('.nova-video-wrap');
  if (wrap) wrap.style.borderRadius = '';
  dockRect = computeDockRect();
  applyRect(dockRect);
  window.addEventListener('resize', redockOnResize);
}

/** Chat mode: hand the widget's geometry over to the .drawer-mode CSS class
 * (full-height side drawer / mobile sheet). Clears the inline rect this
 * module wrote so the stylesheet wins; every tracking path above is gated on
 * drawerActive until exitDrawerMode(). */
export function enterDrawerMode() {
  if (drawerActive) return;
  drawerActive = true;
  clearPointing(true);
  widget.classList.remove('dock-mode', 'expanded', 'pointing');
  widget.classList.add('drawer-mode');
  widget.style.clipPath = '';
  clearStage(document.documentElement, widget.querySelector('.nova-avatar'));
  widget.style.transition = 'none';
  widget.style.top = '';
  widget.style.left = '';
  widget.style.width = '';
  widget.style.height = '';
  const wrap = widget.querySelector('.nova-video-wrap');
  if (wrap) wrap.style.borderRadius = '';
}

/** Back to video (or session over): resume normal geometry — hero if this
 * page still has the slot (so switching to video on the unscrolled homepage
 * puts the live video back in the hero card), the corner dock otherwise. */
export function exitDrawerMode() {
  if (!drawerActive) return;
  drawerActive = false;
  widget.classList.remove('drawer-mode');
  widget.style.transition = 'none';
  if (heroSlot()) {
    mode = 'hero';
    widget.classList.remove('dock-mode');
    refreshHero();
    syncScrollTracking();
    watchSlot();
  } else {
    mode = 'dock';
    dockedByScroll = false;
    widget.classList.add('dock-mode');
    dockRect = computeDockRect();
    applyRect(dockRect);
    window.addEventListener('resize', redockOnResize);
  }
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

  if (mode === 'dock' && !drawerActive) {
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

  // The caller almost always just did its own scrollIntoView() to bring targetEl into view
  // before calling pointAt() — that scroll's `scroll` event always fires async (next tick),
  // landing here after the ring is already drawn. Without this guard that echo is
  // indistinguishable from a genuine user scroll and instantly kills the ring before it's
  // ever visible. Comparing against the position captured at ring-creation time filters the
  // echo out while still treating any further, real scroll as an immediate interrupt.
  const scrollXAtPoint = window.scrollX;
  const scrollYAtPoint = window.scrollY;
  const onScroll = () => {
    if (window.scrollX === scrollXAtPoint && window.scrollY === scrollYAtPoint) return;
    clearPointing(true);
  };
  const onInterrupt = () => clearPointing(true);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onInterrupt);
  document.addEventListener('nova:pagechange', onInterrupt, { once: true });
  detachRingInterrupts = () => {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onInterrupt);
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
  watchSlot();
});
