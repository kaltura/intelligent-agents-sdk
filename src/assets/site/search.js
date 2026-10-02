/**
 * Cmd/Ctrl+K docs search. Loads /search-index.json (built by
 * scripts/lib/search-index.mjs) on first open and ranks it in the browser.
 * Results render with DOM nodes only. "Ask Nova" hands the query to her
 * through a `nova:ask` event that connect.js answers.
 */
const PREFIX = window.__SITE_PATH_PREFIX__ || '';
const MAX_RESULTS = 8;

const dialog = document.getElementById('searchDialog');
const input = document.getElementById('searchInput');
const list = document.getElementById('searchResults');
const ask = document.getElementById('searchAsk');
const trigger = document.getElementById('searchTrigger');

let index = null;
let loading = null;
let selected = -1;

function loadIndex() {
  loading ??= fetch(`${PREFIX}/search-index.json`)
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])
    .then((records) => { index = records; return records; });
  return loading;
}

/** Records matching every term, best first. */
export function rank(records, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored = [];
  for (const r of records) {
    const title = r.t.toLowerCase();
    const heading = r.h.toLowerCase();
    const text = `${r.x} ${r.k}`.toLowerCase();
    let score = 0;
    let all = true;
    for (const term of terms) {
      let s = 0;
      if (heading.includes(term)) s += heading.startsWith(term) ? 8 : 5;
      if (title.includes(term)) s += 3;
      if (text.includes(term)) s += 1;
      if (!s) { all = false; break; }
      score += s;
    }
    // A page intro outranks its own sections on a title match.
    if (all) scored.push({ r, score: score + (r.h ? 0 : 1) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS).map((s) => s.r);
}

/** Append `text` to `parent`, wrapping each query term in <mark>. */
function appendMarked(parent, text, terms) {
  const re = terms.length ? new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi') : null;
  if (!re) { parent.append(text); return; }
  text.split(re).forEach((part, i) => {
    if (i % 2) {
      const m = document.createElement('mark');
      m.textContent = part;
      parent.append(m);
    } else if (part) {
      parent.append(part);
    }
  });
}

function snippet(r, terms) {
  const { x: text, k } = r;
  const lower = text.toLowerCase();
  const found = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  // The match is only in the section's code identifiers: show the identifier.
  if (!found.length) {
    const token = k.split(' ').find((w) => terms.some((t) => w.toLowerCase().includes(t)));
    if (token) return `Mentions ${token}`;
  }
  const at = found.sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 50);
  const slice = text.slice(start, start + 150);
  return `${start > 0 ? '…' : ''}${slice}${start + 150 < text.length ? '…' : ''}`;
}

function select(i) {
  const items = [...list.querySelectorAll('a')];
  if (!items.length) { selected = -1; input.removeAttribute('aria-activedescendant'); return; }
  selected = (i + items.length) % items.length;
  items.forEach((a, n) => a.setAttribute('aria-selected', String(n === selected)));
  input.setAttribute('aria-activedescendant', items[selected].id);
  items[selected].scrollIntoView({ block: 'nearest' });
}

function render(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = index ? rank(index, query) : [];
  list.replaceChildren();
  selected = -1;
  input.removeAttribute('aria-activedescendant');

  if (!terms.length) {
    ask.hidden = true;
    return;
  }
  ask.textContent = `Ask Nova about “${query.trim()}”`;
  ask.hidden = false;

  if (!hits.length) {
    const li = document.createElement('li');
    li.className = 'search-empty';
    li.setAttribute('role', 'presentation');
    li.textContent = index ? `No pages match “${query.trim()}”.` : 'Loading…';
    list.append(li);
    return;
  }
  hits.forEach((r, n) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'presentation');
    const a = document.createElement('a');
    a.id = `search-hit-${n}`;
    a.setAttribute('role', 'option');
    a.setAttribute('aria-selected', 'false');
    a.href = `${PREFIX}${r.u}`;
    const title = document.createElement('span');
    title.className = 'search-hit-title';
    appendMarked(title, r.h || r.t, terms);
    const trail = document.createElement('span');
    trail.className = 'search-hit-trail';
    trail.textContent = [r.g, r.h ? r.t : ''].filter(Boolean).join(' / ');
    const snip = document.createElement('span');
    snip.className = 'search-hit-snippet';
    appendMarked(snip, snippet(r, terms), terms);
    a.append(title, trail, snip);
    li.append(a);
    list.append(li);
  });
  select(0);
}

function open() {
  if (dialog.open) return;
  dialog.showModal();
  input.select();
  loadIndex().then(() => { if (dialog.open) render(input.value); });
}

export function initSearch() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const kbd = document.getElementById('searchKbd');
  if (kbd) kbd.textContent = mac ? '⌘K' : 'Ctrl K';

  trigger.addEventListener('click', open);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (dialog.open) dialog.close();
      else open();
    }
  });

  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(selected + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(selected - 1); }
    // A search input would clear its text on Esc and swallow the dialog's cancel.
    else if (e.key === 'Escape') { e.preventDefault(); dialog.close(); }
    else if (e.key === 'Enter') {
      const a = list.querySelectorAll('a')[selected];
      if (a) { e.preventDefault(); a.click(); }
    }
  });
  // Any link click (the router handles the navigation itself) closes the dialog.
  list.addEventListener('click', (e) => { if (e.target.closest('a')) dialog.close(); });
  // A click on the backdrop lands on the <dialog> element itself.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { input.value = ''; render(''); });

  ask.addEventListener('click', () => {
    const prompt = `Tell me about ${input.value.trim()}`;
    dialog.close();
    document.dispatchEvent(new CustomEvent('nova:ask', { detail: { prompt } }));
  });
}
