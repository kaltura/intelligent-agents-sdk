/**
 * Default renderer registry — one framework-agnostic renderer per built-in GenUI
 * runtime. Each `fn(model, ctx) -> {kind, data}` returns a plain descriptor the
 * host maps to DOM; none depend on a UI framework or touch the DOM directly. The
 * keys are the NORMALIZED runtime names (post `-tool` strip) from `parse.js`
 * RUNTIMES. `ExperienceRenderer` seeds its registry from this map.
 */
import { renderFlashcards } from './flashcards.js';
import { renderFollowups } from './followups.js';
import { renderSources } from './sources.js';
import { renderSummary } from './summary.js';
import { renderVideoGallery } from './video-gallery.js';
import { renderShowLink } from './show-link.js';
import { renderExternalVideo } from './external-video.js';
import { renderUserPropertiesForm } from './user-properties-form.js';
import { renderContentGallery } from './content-gallery.js';
import { renderGradedQuestion } from './graded-question.js';

// renderGradedQuestion (issue #39) is NOT one of the nine backend runtimes exported
// below — it's a host-registered "10th runtime" widget, deliberately excluded from
// DEFAULT_RENDERERS/WIDGET_KINDS. Wire it in via
// `new ExperienceRenderer({ renderers: { 'graded-question': renderGradedQuestion } })`.
export {
  renderFlashcards, renderFollowups, renderSources, renderSummary,
  renderVideoGallery, renderShowLink, renderExternalVideo,
  renderUserPropertiesForm, renderContentGallery,
  renderGradedQuestion,
};

/**
 * Frozen map of normalized runtime → default renderer, one per genie
 * `unisphere-tool` runtime (kebab keys, post `-tool` strip).
 * @type {Readonly<Record<string, (model:Record<string,unknown>, ctx?:object)=>{kind:string,data:object}>>}
 */
export const DEFAULT_RENDERERS = Object.freeze({
  'flashcards': renderFlashcards,
  'followups': renderFollowups,
  'sources': renderSources,
  'summary': renderSummary,
  'video-gallery': renderVideoGallery,
  'show-link': renderShowLink,
  'external-video': renderExternalVideo,
  'user-properties-form': renderUserPropertiesForm,
  'content-gallery': renderContentGallery,
});

/**
 * Every descriptor `kind` `mountWidget` and the registry can produce: the nine genie
 * runtimes + the two synthetic kinds the dispatcher emits (`unknown` for an
 * unregistered runtime, `error` for a throwing custom renderer). Importable so a
 * host switch / a parity test references one frozen list.
 * @type {readonly string[]}
 */
export const WIDGET_KINDS = Object.freeze([...Object.keys(DEFAULT_RENDERERS), 'unknown', 'error']);
