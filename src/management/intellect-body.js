/**
 * Shared leaf module for tiny primitives that `intellects.js` and its
 * satellites (`secrets.js`, `intellect-config.js`) both need. Kept
 * dependency-free (only `core/errors.js`) so none of those files ever form
 * an import cycle through here.
 */
import { KalturaError } from '../core/errors.js';

/**
 * THE shared read-merge-write body primitive. Given a fetched intellect DTO,
 * drop the server-managed read-only keys and re-assert the required
 * `{id, type, status}` discriminators, returning the full body to re-send to
 * `v1/intellect/update`. Used by `Intellects#_rmwBody`/`IntellectConfig.patch`
 * (intellect-config.js) and `Knowledge#setEnabled` (conversations.js) so the
 * merge discipline lives in this one shared helper rather than being
 * reimplemented per call site.
 *
 * Lives in its own leaf file (not intellects.js) so conversations.js can
 * import it without pulling in intellects.js's own import graph, which
 * transitively reaches back into conversations.js (prompt-lint.js's
 * `RESERVED_VARS`) and would otherwise form an import cycle.
 * (Tools are a separate entity, see `tools.js`.)
 * @param {Record<string,any>} cur  The current intellect DTO (from intellect/get).
 * @param {number} configId
 * @returns {Record<string,unknown>}
 */
export function stripServerManaged(cur, configId) {
  const src = cur && typeof cur === 'object' ? cur : {};
  const { id: _id, partner_id: _pid, user_id: _uid, created_at: _ca, updated_at: _ua, ...keep } = src;
  return { ...keep, id: configId, type: src.type || 'internal', status: src.status ?? 2 };
}

/**
 * Assert `v` is a non-negative integer (the shape the API expects for a
 * configId/id path segment). Shared by `intellects.js`, `secrets.js`, and
 * `intellect-config.js` — lives here rather than in `intellects.js` so
 * `secrets.js` importing it doesn't form a cycle back through
 * `intellects.js`'s own import of `IntellectSecrets` from `secrets.js`.
 * @param {unknown} v
 * @param {string} name
 * @returns {void}
 */
export function requireInt(v, name) {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new KalturaError({ type: 'about:blank', title: 'integer required', code: 'bad_request', detail: `${name} must be a non-negative integer (the API expects a JSON number), got ${JSON.stringify(v)}.` });
  }
}
