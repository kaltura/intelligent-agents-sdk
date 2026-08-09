/**
 * Default renderer for the `followups` runtime (UNISPHERE_TOOLS["followups"] →
 * `followups-tool`). Suggested next-question chips. `add_to_history:false`
 * server-side (not replayed). Framework-agnostic `{kind:'followups', data}`.
 */
import { safeText } from '../../../core/safety.js';

/**
 * @param {Record<string, unknown>} model
 * @returns {{kind:'followups', data:{questions:string[]}}}
 */
export function renderFollowups(model = {}) {
  if (!model || typeof model !== 'object') model = {};   // total over null/scalars
  const src = Array.isArray(model.questions) ? model.questions
    : Array.isArray(model.followups) ? model.followups
      : Array.isArray(model.items) ? model.items
        : [];
  const questions = src
    .map((q) => safeText((q && typeof q === 'object') ? (/** @type {any} */ (q).text ?? /** @type {any} */ (q).question ?? '') : q, 500))
    .filter(Boolean);
  return { kind: 'followups', data: { questions } };
}
