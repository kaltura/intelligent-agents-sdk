/**
 * Shared predicates for lifecycle rule conditions. {@link Lifecycle} uses them
 * to refuse risky rules on create and update. The lifecycle audit uses the same
 * definitions to flag rules that already exist.
 */

/** @param {unknown} v */
const isId = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * True for an `object.agent_id` condition that names real agent ids:
 * `eq` with a non-empty string, or `in` with a non-empty array of them.
 * @param {any} c
 * @returns {boolean}
 */
export function isAgentCondition(c) {
  if (!c || typeof c !== 'object' || c.field !== 'object.agent_id') return false;
  if (c.operator === 'eq') return isId(c.value);
  if (c.operator === 'in') return Array.isArray(c.value) && c.value.length > 0 && c.value.every(isId);
  return false;
}

/**
 * True when `eventConditions` holds an agent condition (see {@link isAgentCondition}).
 * A rule without one runs for every agent on the partner.
 * @param {unknown} eventConditions
 * @returns {boolean}
 */
export function hasAgentScope(eventConditions) {
  return Array.isArray(eventConditions) && eventConditions.some(isAgentCondition);
}

/**
 * The agent ids a rule names: the `eq` value or the `in` list of its first
 * agent condition. Empty when the rule is unscoped.
 * @param {unknown} eventConditions
 * @returns {string[]}
 */
export function scopedAgentIds(eventConditions) {
  if (!Array.isArray(eventConditions)) return [];
  const c = eventConditions.find(isAgentCondition);
  if (!c) return [];
  return c.operator === 'eq' ? [c.value] : [...c.value];
}

/**
 * The `changed_keys` condition a `sendInsightEmail` rule waits on:
 * operator `has_all` or `has_any` with a non-empty array of keys.
 * @param {unknown} eventConditions
 * @returns {{field:'changed_keys', operator:'has_all'|'has_any', value:string[]}|undefined}
 */
export function changedKeysFilter(eventConditions) {
  if (!Array.isArray(eventConditions)) return undefined;
  return eventConditions.find(
    (c) => c && typeof c === 'object' && c.field === 'changed_keys' && (c.operator === 'has_all' || c.operator === 'has_any')
      && Array.isArray(c.value) && c.value.length > 0 && c.value.every(isId),
  );
}

/**
 * True when `eventConditions` holds a usable `changed_keys` filter (see {@link changedKeysFilter}).
 * @param {unknown} eventConditions
 * @returns {boolean}
 */
export function hasEmailTrigger(eventConditions) {
  return changedKeysFilter(eventConditions) !== undefined;
}
