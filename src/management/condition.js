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
 *
 * What the server accepts is written down in docs/api/build/intellect.md
 * (Condition grammar). {@link conditionWarnings} flags the forms that are
 * known to blank the turn.
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

/**
 * Throw a `bad_request` {@link KalturaError} when a `prompts[]` block carries
 * a `condition` that {@link assertCondition} refuses. Blocks without a
 * condition (`undefined` or `null`) and non-array input are left alone. PURE.
 * @param {unknown} prompts
 * @param {string} where Prefix naming the call, for example `intellects.update`.
 */
export function assertPromptConditions(prompts, where) {
  if (!Array.isArray(prompts)) return;
  prompts.forEach((block, i) => {
    if (block && typeof block === 'object' && block.condition != null) assertCondition(block.condition, `${where}: prompts[${i}].condition`);
  });
}

const QUOTED = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;

/** Rows: [pattern over the expression with quoted text removed, message]. @type {Array<[RegExp, string]>} */
const SUSPECT_FORMS = [
  [/\b(?:AND|OR|NOT)\b/, 'uses an uppercase operator. Write and, or, not in lowercase'],
  [/&&|\|\|/, 'uses && or ||. Write and, or'],
  [/!(?!=)/, 'uses "!". Write not'],
  [/(?<![=!<>])=(?!=)/, 'uses a single "=". Compare with =='],
  [/\bis\s+(?:not\s+)?['"]/, 'compares with "is" and a string. Use == or !='],
  [/\b(?:len|int)\s*\(/, 'calls len() or int(), which the server does not offer'],
  [/\b(?:true|false)\b/, 'uses true or false, which are read as unknown names. Test the name itself, or use not'],
];

/**
 * Short messages for forms that pass {@link conditionProblem} but blank the
 * whole turn on the server (or never match): uppercase `AND`/`OR`/`NOT`, `&&`,
 * `||`, `!`, a single `=`, `is` with a string, `len()` and `int()`, lowercase
 * `true`/`false`, and an ordering compare against a number with no
 * `is defined` guard. Text inside quotes is ignored. A list of messages, never
 * an error, so a false positive cannot block a write. PURE, never throws.
 * @param {unknown} value
 * @returns {string[]} Empty when nothing looks wrong.
 */
export function conditionWarnings(value) {
  if (conditionProblem(value) !== null) return [];
  const bare = /** @type {string} */ (value).replace(QUOTED, "''");
  const out = SUSPECT_FORMS.filter(([re]) => re.test(bare)).map(([, message]) => message);
  if (/[A-Za-z_]\w*\s*[<>]=?\s*-?\d/.test(bare) && !/\bis\s+defined\b/.test(bare)) {
    out.push('compares with < or > against a number. This blanks the turn while the name is unset or holds text. Guard it, for example "visits is defined and visits > 2"');
  }
  return out;
}
