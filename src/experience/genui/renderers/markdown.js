/**
 * Minimal, allow-listed markdown-to-DOM renderer for GenUI `text`/`summary`
 * content — an OPT-IN alternate `mountWidget` path
 * (`mountWidget(descriptor, el, {markdown:true})`) so the default flat-text
 * behavior never regresses for an app that doesn't ask for it. Supports
 * headings, bold/italic, links, tables, lists, inline code, and fenced code
 * blocks — the common subset an LLM summary/answer actually uses. NEVER
 * `innerHTML`: every text run is built via `textContent`/`createTextNode`
 * (so a raw `<script>` tag in LLM output is inert text, not markup) and every
 * extracted URL goes through `safeUrl` (blocks `javascript:`/`data:`/etc, the
 * same allow-list the rest of GenUI's renderers use). A markdown table reuses
 * `tableEl` (`dom-helpers.js`) rather than duplicating table-building logic —
 * the same safe `<table>` builder `showVisualTable`/the chart fallback use.
 * @module
 */
import { safeText, safeUrl, safeSource } from '../../../core/safety.js';
import { el, cssToken, tableEl } from './dom-helpers.js';

// `code`, **bold**/__bold__, *italic*/_italic_, [label](url) — checked in this
// order so a bold match is tried before the narrower single-delimiter italic one.
const INLINE_RE = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\*([^*]+)\*|_([^_]+)_|\[([^\]]*)\]\(([^)\s]+)\)/g;

/** Append safe inline-formatted (bold/italic/code/link) child nodes of `text` onto `parent`. @param {Element} parent @param {string} text */
function renderInline(parent, text) {
  const s = safeSource(text, 4000);
  let last = 0;
  let m;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(s))) {
    if (m.index > last) parent.appendChild(document.createTextNode(safeText(s.slice(last, m.index), 4000)));
    if (m[1] !== undefined) parent.appendChild(el('code', 'kgenui__md-code', safeText(m[1], 1000)));
    else if (m[2] !== undefined || m[3] !== undefined) parent.appendChild(el('strong', '', safeText(m[2] ?? m[3], 1000)));
    else if (m[4] !== undefined || m[5] !== undefined) parent.appendChild(el('em', '', safeText(m[4] ?? m[5], 1000)));
    else {
      // link: drop to plain (safe) text when the URL scheme isn't allow-listed — never a dead/unsafe href.
      const href = safeUrl(m[7]);
      if (href) {
        const a = el('a', 'kgenui__md-link', safeText(m[6] || m[7], 500));
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        parent.appendChild(a);
      } else {
        parent.appendChild(document.createTextNode(safeText(m[6] || '', 500)));
      }
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) parent.appendChild(document.createTextNode(safeText(s.slice(last), 4000)));
}

/** True if `line` is a GFM table header separator (`---|:--:|--:`). @param {string} line */
function isTableSeparator(line) {
  const t = line.trim();
  return t.includes('-') && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(t);
}

/** Split a `| a | b |` row into trimmed cells. @param {string} line */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/**
 * Parse `source` as markdown and return a `<div class="kgenui__markdown">`
 * containing safe DOM for it (never throws — an unrecognized line renders as
 * a plain paragraph). Isomorphic-gated by the caller (`mountWidget`).
 * @param {unknown} source
 * @returns {Element}
 */
export function renderMarkdown(source) {
  const root = el('div', 'kgenui__markdown');
  const lines = safeSource(source, 100000).replace(/\r\n/g, '\n').split('\n');
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = el('p', 'kgenui__md-p');
    renderInline(p, para.join(' '));
    root.appendChild(p);
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = /^```(\S*)\s*$/.exec(line.trim());
    if (fence) {
      flushPara();
      const lang = fence[1] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '```') { codeLines.push(lines[i]); i++; }
      i++;   // skip the closing fence (or EOF — an unterminated fence still renders what it has)
      const pre = el('pre', 'kgenui__md-pre');
      const code = el('code', lang ? 'language-' + cssToken(lang) : '', safeSource(codeLines.join('\n'), 100000));
      pre.appendChild(code);
      root.appendChild(pre);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      const h = el(/** @type {keyof HTMLElementTagNameMap} */ ('h' + heading[1].length), 'kgenui__md-h');
      renderInline(h, heading[2]);
      root.appendChild(h);
      i++;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara();
      const headers = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      tableEl(root, { headers, rows });
      continue;
    }

    const ul = /^[-*+]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ol ? 'ol' : 'ul';
      const listNode = el(tag, 'kgenui__md-list');
      while (i < lines.length) {
        const item = tag === 'ol' ? /^\d+[.)]\s+(.*)$/.exec(lines[i]) : /^[-*+]\s+(.*)$/.exec(lines[i]);
        if (!item) break;
        const li = el('li');
        renderInline(li, item[1]);
        listNode.appendChild(li);
        i++;
      }
      root.appendChild(listNode);
      continue;
    }

    if (!line.trim()) { flushPara(); i++; continue; }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return root;
}
