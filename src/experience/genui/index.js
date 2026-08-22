/**
 * @kaltura/intelligent-agents/experience/genui — the GenUI segment→widget layer.
 *
 * Optional subpath: pull this in only if you render agent-driven widgets
 * (boards, flashcards, galleries, forms, …). Apps that only need the live
 * runtime (`KalturaAvatarSession`) never pay for this module graph.
 *
 * @example
 * import { ExperienceRenderer, mountWidget } from '@kaltura/intelligent-agents/experience/genui';
 */
export { ExperienceRenderer } from './renderer.js';
export { SegmentAssembler } from './segments.js';
export {
  normalizeRuntime, isKnownRuntime, parseContent, parseWidget,
  RUNTIMES, GENUI_WIDGET_NAME,
} from './parse.js';
export { DEFAULT_RENDERERS, WIDGET_KINDS } from './renderers/index.js';
export { mountWidget } from './renderers/mount.js';
// A host-registered "10th runtime" widget (issue #39) — not one of the nine
// backend DEFAULT_RENDERERS. Wire it in explicitly, see docs/GENUI-REFERENCE.md.
export { renderGradedQuestion } from './renderers/graded-question.js';
