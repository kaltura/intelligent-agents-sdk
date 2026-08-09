/**
 * Default renderer for the `flashcards` runtime (UNISPHERE_TOOLS["flashcards"]
 * → `flashcards-tool`). Framework-agnostic: returns a plain descriptor
 * `{kind:'flashcards', data}` the host maps to DOM. Never touches the DOM, never
 * depends on a UI framework.
 *
 * All text is passed through `safeText` (untrusted LLM output, OWASP LLM05).
 */
import { safeText } from '../../../core/safety.js';

/**
 * @param {Record<string, unknown>} model Parsed widget model (`parseWidget(...).model`).
 * @returns {{kind:'flashcards', data:{title:string, cards:Array<{front:string,back:string,label:string}>}}}
 */
export function renderFlashcards(model = {}) {
  if (!model || typeof model !== 'object') model = {};   // total over null/scalars
  const src = Array.isArray(model.cards) ? model.cards
    : Array.isArray(model.items) ? model.items
      : Array.isArray(model.flashcards) ? model.flashcards
        : [];
  const cards = src.map((c) => {
    const card = (c && typeof c === 'object') ? /** @type {Record<string,unknown>} */ (c) : { front: c };
    const front = safeText(card.front ?? card.question ?? card.term ?? '', 1000);
    return {
      front,
      back: safeText(card.back ?? card.answer ?? card.definition ?? '', 4000),
      label: safeText(card.label ?? front, 120),   // accessible name for the flip toggle
    };
  });
  return { kind: 'flashcards', data: { title: safeText(model.title ?? '', 300), cards } };
}
