/**
 * DOM builders. No `innerHTML`: text always goes through text nodes, so a
 * product name or a model-supplied string can never become markup.
 */
const HTML_NS = 'http://www.w3.org/1999/xhtml';
export const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Apply attributes. `class`, `style` (object), `on<event>` (function), `data-*`
 * and `aria-*` are handled. `null`, `undefined` and `false` skip the attribute.
 * @param {Element} el
 * @param {Record<string,any>|null|undefined} attrs
 */
function apply(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'style' && typeof v === 'object') { for (const [p, val] of Object.entries(v)) el.style.setProperty(p, String(val)); }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

/** @param {Element} el @param {any[]} kids */
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(typeof k === 'object' ? k : document.createTextNode(String(k)));
  }
  return el;
}

/**
 * Build an HTML element.
 * @param {string} tag
 * @param {Record<string,any>|null} [attrs]
 * @param {...any} kids
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...kids) {
  const el = document.createElementNS(HTML_NS, tag);
  apply(el, attrs);
  return /** @type {HTMLElement} */ (append(el, kids));
}

/**
 * Build an SVG element.
 * @param {string} tag
 * @param {Record<string,any>|null} [attrs]
 * @param {...any} kids
 * @returns {SVGElement}
 */
export function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  return /** @type {SVGElement} */ (append(el, kids));
}

/** Remove all children. @param {Element} el */
export function clear(el) { while (el.firstChild) el.firstChild.remove(); }

/** Money text, no cents. @param {number} n */
export const usd = (n) => `$${n.toLocaleString('en-US')}`;
