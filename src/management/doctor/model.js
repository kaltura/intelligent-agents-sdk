/**
 * The data shapes the doctor reads into and its checks run over. Types only.
 * A check never reads the network: `gather.js` reads once, then every check
 * is a pure function of these views.
 */

/**
 * A voice or visual an avatar points at, looked up in the catalog.
 * `unread` means the lookup failed, so a check must not call it missing.
 * @typedef {object} CatalogRef
 * @property {string} id
 * @property {'found'|'missing'|'unread'} state
 * @property {Record<string, any>} [item] The catalog item, when `state` is `found`.
 */

/**
 * An avatar an agent lists in `avatarIds`.
 * @typedef {object} AvatarView
 * @property {string} id
 * @property {'found'|'missing'|'unread'} state
 * @property {Record<string, any>} [avatar] The avatar, when `state` is `found`.
 * @property {CatalogRef} [voice]
 * @property {CatalogRef} [visual]
 */

/**
 * One agent with what it points at.
 * @typedef {object} AgentView
 * @property {string} agentId
 * @property {Record<string, any>} agent
 * @property {number} [configId] The agent's intellect id.
 * @property {'found'|'missing'|'unread'|'none'} intellectState `none` for an agent with no intellect id.
 * @property {Record<string, any>} [intellect] The intellect, when `intellectState` is `found`.
 * @property {AvatarView[]} avatars Empty for an agent outside the selection: it is read for `avatar_shared` only.
 */

/**
 * One intellect and every selected agent that uses it.
 * @typedef {object} IntellectView
 * @property {number} configId
 * @property {Record<string, any>} config
 * @property {string[]} agentIds Sorted.
 * @property {AgentView[]} agents
 */

/**
 * Limits the checks compare against. Every one is a hint threshold, not a rule.
 * @typedef {object} DoctorThresholds
 * @property {number} [minConversationSeconds] `max_conversation_short` fires below this. Default 60.
 */

/**
 * @typedef {import('./../audit-report.js').AuditFinding} AuditFinding
 */

/**
 * One check. A check is pure: it returns findings and never reads or writes.
 * `scope` says what `run` receives: an {@link AgentView}, an {@link IntellectView}
 * or, for `partner`, `{ agents, selected }` (every agent, and the ids the run
 * is limited to).
 * @typedef {object} DoctorCheck
 * @property {string} id Unique name, used in `check_failed` and in `only`/`skip`.
 * @property {string} category Group name, for `only` and `skip`.
 * @property {readonly string[]} codes Every finding code `run` can return.
 * @property {'agent'|'intellect'|'partner'} scope
 * @property {ReadonlyArray<'intellect'|'avatars'|'catalog'>} needs What `gather.js` must read for this check. `catalog` includes `avatars`.
 * @property {(input: any, thresholds: Required<DoctorThresholds>) => AuditFinding[]} run
 */

/**
 * The thresholds the doctor uses when the caller sets none.
 * @type {Readonly<Required<DoctorThresholds>>}
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  minConversationSeconds: 60,
});
