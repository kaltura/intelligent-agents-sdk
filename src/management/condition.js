/**
 * Condition expressions — PURE helpers shared by every place a `condition`
 * can be set: a skill reference (`skill_ids[].condition`), a prompt block
 * (`prompts[].condition`) and a tool (`tools.*({condition})`).
 *
 * A `condition` is a BARE expression over thread variables, for example
 * `sys__avatar_enabled` or `not sys__avatar_enabled and plan == "pro"`. It is
 * not a template: `{{ ... }}` and `{% ... %}` are wrong here. The server
 * answers a template-style condition with an empty reply instead of an error,
 * so the SDK rejects it before the write. `undefined` and `null` mean "no
 * condition" (the server echoes `null` for an unset one); callers skip them.
 */
import { KalturaError } from '../core/errors.js';

const TEMPLATE_DELIMITER = /\{\{|\{%|\{#/;

/**
 * Why `value` is not a usable `condition`, or `null` when it is.
 * PURE, never throws.
 * @param {unknown} value
 * @returns {string|null} A short reason, ready to append to an error or lint message.
 */
export function conditionProblem(value) {
  if (typeof value !== 'string' || !value.trim()) return 'must be a non-empty expression string';
  if (TEMPLATE_DELIMITER.test(value)) {
    return `must be a bare expression such as "sys__avatar_enabled", without {{ }} or {% %} (got ${JSON.stringify(value)}); a template-style condition makes the server return an empty reply`;
  }
  return null;
}

/**
 * Throw a `bad_request` {@link KalturaError} when `value` is not a usable
 * `condition`. PURE.
 * @param {unknown} value
 * @param {string} where Prefix naming the field, for example `intellectConfig.setSkillIds entry.condition`.
 * @returns {string} The validated expression.
 */
export function assertCondition(value, where) {
  const problem = conditionProblem(value);
  if (problem) {
    throw new KalturaError({ type: 'about:blank', title: 'bad condition', code: 'bad_request', detail: `${where} ${problem}.` });
  }
  return /** @type {string} */ (value);
}
