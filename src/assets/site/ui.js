/**
 * Site chrome behavior: theme toggle, mobile nav, and the per-page
 * enhancements (code copy buttons, heading anchors, table wrappers, "On this
 * page" scrollspy). Page content is swapped by nova/router.js without a
 * reload, so everything page-specific re-runs on `nova:pagechange`.
 */
import { initSearch } from './search.js';

const root = document.documentElement;

const THEME_COLOR = { dark: '#333333', light: '#eff4ff' };
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');
const lightLogo = document.querySelector('[data-logo="light"]');
const darkLogo = document.querySelector('[data-logo="dark"]');

function syncTheme() {
  const theme = root.getAttribute('data-theme');
  themeIcon.textContent = theme === 'dark' ? 'dark_mode' : 'light_mode';
  if (lightLogo && darkLogo) {
    lightLogo.style.display = theme === 'dark' ? 'none' : 'block';
    darkLogo.style.display = theme === 'dark' ? 'block' : 'none';
  }
  document.querySelector('meta[name="theme-color"]').content = THEME_COLOR[theme];
}
syncTheme();

themeToggle.addEventListener('click', () => {
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch { /* storage disabled: the choice lasts this page view */ }
  syncTheme();
});

// Mobile navigation: the sidebar slides in over a backdrop. Closes on backdrop
// tap, Escape, a link tap, a page change, or growing past the mobile breakpoint.
const menuToggle = document.getElementById('menuToggle');
const sidebar = document.getElementById('sidebar');
const backdrop = document.getElementById('navBackdrop');

function setNav(open) {
  sidebar.classList.toggle('open', open);
  backdrop.classList.toggle('open', open);
  document.body.classList.toggle('nav-open', open);
  menuToggle.setAttribute('aria-expanded', String(open));
}

menuToggle.addEventListener('click', () => setNav(!sidebar.classList.contains('open')));
backdrop.addEventListener('click', () => setNav(false));
sidebar.addEventListener('click', (e) => { if (e.target.closest('a')) setNav(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sidebar.classList.contains('open')) {
    setNav(false);
    menuToggle.focus();
  }
});
window.matchMedia('(min-width: 901px)').addEventListener('change', (e) => { if (e.matches) setNav(false); });
document.addEventListener('nova:pagechange', () => setNav(false));

// Per-page enhancements.

/** Give a horizontally scrolling box a tab stop so keyboard users can scroll it. */
function makeScrollable(el) {
  if (el.scrollWidth > el.clientWidth && !el.hasAttribute('tabindex')) el.tabIndex = 0;
}

function addCopyButton(block, pre) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-copy';
  btn.setAttribute('aria-label', 'Copy code');
  const icon = document.createElement('span');
  icon.className = 'material-symbols-outlined';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'content_copy';
  const label = document.createElement('span');
  label.textContent = 'Copy';
  btn.append(icon, label);

  let timer;
  btn.addEventListener('click', async () => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(pre.textContent.replace(/\n$/, ''));
    } catch {
      ok = false;
    }
    clearTimeout(timer);
    btn.dataset.state = ok ? 'copied' : 'failed';
    icon.textContent = ok ? 'check' : 'error';
    label.textContent = ok ? 'Copied' : 'Copy failed';
    btn.setAttribute('aria-label', label.textContent);
    timer = setTimeout(() => {
      delete btn.dataset.state;
      icon.textContent = 'content_copy';
      label.textContent = 'Copy';
      btn.setAttribute('aria-label', 'Copy code');
    }, 1800);
  });
  block.append(btn);
}

function enhanceContent(main) {
  for (const pre of main.querySelectorAll('pre')) {
    if (pre.parentElement.classList.contains('code-block')) continue;
    const block = document.createElement('div');
    block.className = 'code-block';
    pre.replaceWith(block);
    block.append(pre);
    addCopyButton(block, pre);
    makeScrollable(pre);
  }

  for (const table of main.querySelectorAll('table')) {
    if (table.parentElement.classList.contains('table-wrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.append(table);
    makeScrollable(wrap);
  }

  for (const h of main.querySelectorAll('h2[id], h3[id], h4[id]')) {
    if (h.closest('.nova-hero') || h.querySelector('.heading-anchor')) continue;
    const a = document.createElement('a');
    a.className = 'heading-anchor';
    a.href = `#${h.id}`;
    a.setAttribute('aria-label', `Link to section: ${h.textContent}`);
    a.textContent = '#';
    h.append(a);
  }
}

// "On this page": marks the heading nearest the top of the viewport.
let spy = null;
let spyScroll = null;

function initScrollspy(main) {
  spy?.disconnect();
  spy = null;
  spyScroll?.abort();
  spyScroll = null;
  const links = [...document.querySelectorAll('.page-toc a[href^="#"]')];
  if (!links.length) return;
  const byId = new Map(links.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
  const targets = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean);
  const visible = new Set();

  const mark = (id) => {
    for (const [key, a] of byId) {
      if (key === id) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    }
  };

  spy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.add(e.target);
      else visible.delete(e.target);
    }
    // Topmost visible heading wins; when none is visible, keep the last mark.
    const top = targets.find((t) => visible.has(t));
    if (top) mark(top.id);
  }, { rootMargin: '-80px 0px -70% 0px' });
  targets.forEach((t) => spy.observe(t));
  if (targets[0]) mark(targets[0].id);

  // Short last sections can never reach the observer's band: at the bottom of
  // the page, the last heading is the one being read.
  const atBottom = () => {
    if (!targets.length) return;
    const el = document.documentElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 4 && el.scrollTop > 0) mark(targets[targets.length - 1].id);
  };
  spyScroll = new AbortController();
  window.addEventListener('scroll', atBottom, { passive: true, signal: spyScroll.signal });
}

function initPage() {
  const main = document.querySelector('main.content-wrapper');
  if (!main) return;
  enhanceContent(main);
  initScrollspy(main);
}

initPage();
document.addEventListener('nova:pagechange', initPage);
initSearch();
