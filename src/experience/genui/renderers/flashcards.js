/**
 * Default renderer for the `flashcards` runtime
 * (`flashcards-tool`). Framework-agnostic: returns a plain descriptor
 * `{kind:'flashcards', data}` the host maps to DOM. Never touches the DOM, never
 * depends on a UI framework.
 *
 * Cards come from `cards`, `items`, `flashcards`, or `keypoints` (a keypoint's
 * `title` is the front and its `summary` the back). A card's `citation.clips` or
 * `clips` become `clips` (see `renderClips`), omitted when empty.
 *
 * All text is passed through `safeText` (untrusted LLM output, OWASP LLM05).
 */
import { safeText } from '../../../core/safety.js';
import { renderClips } from './video-gallery.js';

/**
 * @param {Record<string, unknown>} model Parsed widget model (`parseWidget(...).model`).
 * @param {import('./video-gallery.js').GenUIRenderCtx} [ctx] Used only for clip thumbnails and embed URLs.
 * @returns {{kind:'flashcards', data:{title:string, cards:Array<{front:string,back:string,label:string,clips?:import('./video-gallery.js').GenUIClip[]}>}}}
 */
export function renderFlashcards(model = {}, ctx = {}) {
  if (!model || typeof model !== 'object') model = {};   // total over null/scalars
  const src = Array.isArray(model.cards) ? model.cards
    : Array.isArray(model.items) ? model.items
      : Array.isArray(model.flashcards) ? model.flashcards
        : Array.isArray(model.keypoints) ? model.keypoints
          : [];
  const cards = src.map((c) => {
    const card = /** @type {Record<string,unknown>} */ ((c && typeof c === 'object') ? c : { front: c });
    const front = safeText(card.front ?? card.question ?? card.term ?? card.title ?? '', 1000);
    const citation = (card.citation && typeof card.citation === 'object') ? /** @type {Record<string, unknown>} */ (card.citation) : {};
    const clips = renderClips(Array.isArray(citation.clips) ? citation.clips : card.clips, ctx);
    return {
      front,
      back: safeText(card.back ?? card.answer ?? card.definition ?? card.summary ?? '', 4000),
      label: safeText(card.label ?? front, 120),   // accessible name for the flip toggle
      ...(clips.length ? { clips } : {}),
    };
  });
  return { kind: 'flashcards', data: { title: safeText(model.title ?? '', 300), cards } };
}
