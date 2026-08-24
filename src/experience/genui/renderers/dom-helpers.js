/**
 * Tiny zero-dep DOM builders shared by `mountWidget` and the markdown renderer
 * (issue #27) — kept in their own leaf module so `markdown.js` can reuse
 * `tableEl` (a markdown table renders through the SAME safe `<table>` builder
 * the structured `showVisualTable`/chart-fallback widgets use) without a
 * circular import back into `mount.js`. NEVER `innerHTML`.
 * @module
 */
import { safeText } from '../../../core/safety.js';

/**
 * Build an element with an optional class + textContent (never innerHTML).
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [className]
 * @param {unknown} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null && text !== '') node.textContent = String(text);
  return node;
}

/** Slugify a string into a safe CSS class/token fragment (never empty). @param {unknown} s */
export function cssToken(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x'; }

/** A safe `<table>` from `{title?, headers, rows}` — also the `showChart`/chart-fallback data table. @param {Element} root @param {{title?:string, headers?:unknown[], rows?:unknown[][]}} data @param {boolean} [noHead] */
export function tableEl(root, data, noHead) {
  const title = safeText(data && data.title, 300);
  if (title) root.appendChild(el('h3', 'kgenui__title', title));
  const table = el('table', 'kgenui__table');
  const headers = Array.isArray(data && data.headers) ? data.headers : [];
  if (!noHead && headers.length) {
    const thead = el('thead'); const tr = el('tr');
    for (const h of headers) tr.appendChild(el('th', '', safeText(h, 300)));
    thead.appendChild(tr); table.appendChild(thead);
  }
  const tbody = el('tbody');
  for (const row of Array.isArray(data && data.rows) ? data.rows : []) {
    const tr = el('tr');
    for (const cell of Array.isArray(row) ? row : []) tr.appendChild(el('td', '', safeText(cell, 1000)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  root.appendChild(table);
}
