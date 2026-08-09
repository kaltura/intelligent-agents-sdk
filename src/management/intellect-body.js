/**
 * THE shared read-merge-write body primitive (pure, zero-dependency leaf
 * module). Given a fetched intellect DTO, drop the server-managed read-only
 * keys and re-assert the required `{id, type, status}` discriminators,
 * returning the full body to re-send to `v1/intellect/update`. Used by
 * `Intellects#_rmwBody`/`IntellectConfig.patch` (intellect-config.js) and
 * `Knowledge#setEnabled` (conversations.js) so the merge discipline lives in
 * this one shared helper rather than being reimplemented per call site.
 *
 * Lives in its own leaf file (not intellects.js) so conversations.js can
 * import it without pulling in intellects.js's own import graph, which
 * transitively reaches back into conversations.js (prompt-lint.js's
 * `RESERVED_VARS`) and would otherwise form an import cycle.
 * (Tools no longer ride along here — they are a separate entity, see `tools.js`.)
 * @param {Record<string,any>} cur  The current intellect DTO (from intellect/get).
 * @param {number} configId
 * @returns {Record<string,unknown>}
 */
export function stripServerManaged(cur, configId) {
  const src = cur && typeof cur === 'object' ? cur : {};
  const { id: _id, partner_id: _pid, user_id: _uid, created_at: _ca, updated_at: _ua, ...keep } = src;
  return { ...keep, id: configId, type: src.type || 'internal', status: src.status ?? 2 };
}
