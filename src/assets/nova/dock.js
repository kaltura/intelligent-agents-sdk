/**
 * Hero <-> dock positioning for the persistent #nova-widget. The widget is
 * always `position: fixed` and never re-parented (see base.njk) — this
 * module only ever writes inline top/left/width/height, so the hero-to-dock
 * transition is a single continuous CSS animation (FLIP), never a DOM move
 * that would risk disrupting the live WHEP video element or socket session.
 */
const widget = document.getElementById('nova-widget');

const DOCK_MARGIN = 24;
const DOCK_SIZE = window.matchMedia('(max-width: 600px)').matches ? 72 : 96;
const HIGHLIGHT_MS = 4000;

let mode = 'none'; // 'hero' | 'dock'
let rafPending = false;
let dockRect = null;
let revertTimer = null;

function heroSlot() {
  return document.getElementById('nova-hero-slot');
}

function applyRect(rect) {
  widget.style.top = `${rect.top}px`;
  widget.style.left = `${rect.left}px`;
  widget.style.width = `${rect.width}px`;
  widget.style.height = `${rect.height}px`;
}

function currentDockSize() {
  return window.matchMedia('(max-width: 600px)').matches ? 72 : 96;
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

/** Called once on load. If a hero slot exists on this page, track it live;
 * otherwise (any page other than home, before a session/nav has happened)
 * snap straight into a static dock rect with no transition. */
export function initDock() {
  const slot = heroSlot();
  if (slot) {
    mode = 'hero';
    trackHero();
    window.addEventListener('resize', () => onRafThrottled(trackHero));
    window.addEventListener('scroll', () => onRafThrottled(trackHero), { passive: true });
  } else {
    mode = 'dock';
    widget.classList.add('dock-mode');
    dockRect = computeDockRect();
    applyRect(dockRect);
    window.addEventListener('resize', redockOnResize);
  }
}

/** One-directional per session: once docked, hero mode never returns. */
export function enterDockMode() {
  if (mode === 'dock') return;
  mode = 'dock';
  widget.classList.add('dock-mode');
  widget.style.transition = 'top 420ms cubic-bezier(0.22, 1, 0.36, 1), left 420ms cubic-bezier(0.22, 1, 0.36, 1), width 420ms cubic-bezier(0.22, 1, 0.36, 1), height 420ms cubic-bezier(0.22, 1, 0.36, 1)';
  dockRect = computeDockRect();
  applyRect(dockRect);
  window.addEventListener('resize', redockOnResize);
}

/** Briefly FLIPs the docked widget toward targetEl and rings it, then
 * reverts to the standing dock position. Cosmetic/best-effort — never
 * called before enterDockMode(). */
export function pointAt(targetEl) {
  if (mode !== 'dock' || !targetEl) return;
  clearTimeout(revertTimer);
  const size = currentDockSize();
  const targetRect = targetEl.getBoundingClientRect();
  const margin = 16;
  let left = targetRect.right + margin;
  if (left + size > window.innerWidth - DOCK_MARGIN) left = targetRect.left - size - margin;
  left = Math.max(DOCK_MARGIN, Math.min(left, window.innerWidth - size - DOCK_MARGIN));
  let top = targetRect.top;
  top = Math.max(DOCK_MARGIN, Math.min(top, window.innerHeight - size - DOCK_MARGIN));

  widget.classList.add('pointing');
  applyRect({ top, left, width: size, height: size });

  const ring = document.createElement('div');
  ring.className = 'nova-highlight-ring';
  const ringRect = targetRect;
  ring.style.top = `${ringRect.top - 6}px`;
  ring.style.left = `${ringRect.left - 6}px`;
  ring.style.width = `${ringRect.width + 12}px`;
  ring.style.height = `${ringRect.height + 12}px`;
  document.body.appendChild(ring);

  revertTimer = setTimeout(() => {
    widget.classList.remove('pointing');
    dockRect = computeDockRect();
    applyRect(dockRect);
    ring.remove();
  }, HIGHLIGHT_MS);
}

export function dockActive() {
  return mode === 'dock';
}

// Router-driven "page changes" never reload the document, so a hero slot
// that disappears (navigating away from home) needs its own check here —
// resize/scroll alone would never catch it. Runs even before any Nova
// session exists: with no slot to track, docking is the only sane state.
document.addEventListener('nova:pagechange', () => {
  if (mode === 'hero') trackHero();
});
