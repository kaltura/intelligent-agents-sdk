/**
 * Default renderer for the `summary` runtime (backend tool key "summarization"
 * → `summary-tool`). A markdown/text summary block. Framework-agnostic
 * `{kind:'summary', data}`. The summary text stays UNTRUSTED (LLM output) — by
 * default the SDK renders it as flat escaped text; `mountWidget(descriptor, el,
 * {markdown:true})` (issue #27) opts into rendering markdown-in-plain-text
 * (tables, bold, links, etc.) as safe DOM instead. The SDK never emits raw HTML.
 * `summary` is run through `safeSource` (not `safeText`) so line breaks survive
 * for that opt-in markdown path — flat-text rendering already collapses
 * whitespace visually via CSS, so preserving `\n` here doesn't change the
 * default look.
 */
import { safeText, safeSource } from '../../../core/safety.js';

/**
 * @param {Record<string, unknown>} model
 * @returns {{kind:'summary', data:{title:string, summary:string, bullets:string[]}}}
 */
export function renderSummary(model = {}) {
  if (!model || typeof model !== 'object') model = {};   // total over null/scalars
  // A caller may mis-nest the whole {title,summary,bullets} shape one level deep inside
  // `summary` itself (seen live from the brain) — string-coercing that object renders the
  // literal "[object Object]", so unwrap it here rather than trusting the caller's shape.
  let { title, summary, bullets: rawBullets } = model;
  if (summary && typeof summary === 'object') {
    const nested = /** @type {any} */ (summary);
    title = title ?? nested.title;
    rawBullets = rawBullets ?? nested.bullets ?? nested.points ?? nested.items;
    summary = nested.summary ?? nested.text ?? nested.content ?? nested.raw ?? '';
  }
  const summaryText = safeSource(summary ?? model.text ?? model.content ?? model.raw ?? '', 8000);
  const src = Array.isArray(rawBullets) ? rawBullets
    : Array.isArray(model.points) ? model.points
      : Array.isArray(model.items) ? model.items
        : [];
  // A bullet may arrive as an object row ({summary}/{text}/{label}) — string-coercing
  // one renders the literal "[object Object]", so extract its text field instead
  // (same total handling as followups/flashcards).
  const bullets = src
    .map((b) => safeText((b && typeof b === 'object') ? (/** @type {any} */ (b).summary ?? /** @type {any} */ (b).text ?? /** @type {any} */ (b).label ?? /** @type {any} */ (b).content ?? '') : b, 1000))
    .filter(Boolean);
  return { kind: 'summary', data: { title: safeText(title ?? '', 300), summary: summaryText, bullets } };
}
