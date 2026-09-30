/**
 * Kaltura Session (KS) minting + lifecycle + the two-KS-type security invariant.
 *
 * THE INVARIANT — two KS types, never mix:
 *   - `disableentitlement` bypasses access control → ADMIN/MANAGEMENT ONLY.
 *     Reachable solely via {@link Sessions.createAdminToken} (server-side).
 *   - Conversation and agent tokens keep entitlement ON → the end-user token.
 *     {@link Sessions.createConversationToken} and {@link Sessions.createAgentToken}
 *     forbid any privilege that would disable entitlement, so a client/end-user
 *     surface can never mint an admin-scoped token even by mistake.
 *
 * SESSION TYPE: conversation and agent tokens are USER sessions (`type=0`) by
 * default and always run as `setrole:PLAYBACK_BASE_ROLE`. A user session sees
 * only its own `userId`'s threads. With no `userId`, every holder of such a
 * token shares one identity. `sessionType: 'admin'` (`type=2`) mints an
 * admin-level session, limited only by the `role` and privileges you set.
 * {@link Sessions.createAdminToken} is always `type=2`. Every admin-type mint
 * needs a `userId`: the server makes it the owner of anything the token
 * creates, so a missing one would leave that content with an empty owner.
 *
 * SECURITY POSTURE (grounded in RFC 9700 OAuth 2.0 Security BCP + NIST 800-53):
 *   - Least privilege (AC-6): a structured `restrictions` builder compiles to
 *     Kaltura KS privileges (setrole/actionslimit/iprestrict/urirestrict) so
 *     callers tighten scope without learning the KS DSL.
 *   - Short-lived by default (RFC 9700 §6.1): browser-bound tokens default to
 *     30 min TTL; a short TTL is the primary revocation lever
 *     for a stateless KS. Absurd lifetimes on browser-bound kinds are rejected.
 *   - Active revocation (RFC 9700 §5.2.1.1, SOC 2 CC6.2/CC6.3): {@link
 *     Sessions.revoke} ends a leaked token within seconds; an optional `sessionGroupId`
 *     bakes `sessionid:<id>`, so one `revoke` on any member ends the whole family.
 *   - Auditability (NIST AU-2/AU-3): every mint/revoke fires a redacted audit
 *     event and returns a `scope` receipt; the admin secret is NEVER returned,
 *     logged, enumerable, or attached to a token. When a caller binds a real
 *     end-user identity via `userId`, it rides the mint call as a
 *     per-call parameter ONLY (never cached on `this` or module state) and
 *     populates the audit event's `actor.subjectId`.
 *
 * Token-mint hits the OVP session service (`session/start`,
 * `startWidgetSession`, `session/end`). The admin secret is stored
 * non-enumerable and is NEVER returned or serialized. With `getAdminSecret`,
 * it is fetched for each mint and not retained.
 */
// eslint-disable-next-line no-unused-vars -- referenced only in the @param {Http} JSDoc type below
import { Http } from './http.js';
import { meta } from './ids.js';
import { KalturaError } from './errors.js';
import { redact } from './redact.js';

/** @typedef {'admin'|'conversation'|'agent'|'widget'} TokenKind */
/** @typedef {'user'|'admin'} SessionType  OVP session type: `'user'` = type 0, `'admin'` = type 2. */

/**
 * @typedef {object} Token
 * @property {string} ks                The KS string (treat as a secret).
 * @property {TokenKind} kind
 * @property {SessionType} [sessionType]  `'user'` (type 0) or `'admin'` (type 2). Absent on widget tokens (the server picks it).
 * @property {boolean} entitlementEnforced  true for every kind except admin.
 * @property {string} privileges        The privilege string baked in.
 * @property {number} expiresAt         Unix epoch seconds (best-effort; 0 if unknown).
 * @property {object} scope             Audit receipt: {generatedAt, partnerId, kind, sessionType?, privileges, entitlementEnforced, userId?}.
 * @property {() => boolean} isExpired   true once past expiresAt (false if unknown). Non-enumerable.
 * @property {() => number} secondsRemaining  Seconds until expiry (Infinity if unknown, 0 if past). Non-enumerable.
 */

/**
 * @typedef {object} Restrictions  Structured least-privilege options (compiled to KS privileges).
 * @property {string|number} [role]         setrole:<id>: run as a specific (narrower) Kaltura role. Only with `sessionType: 'admin'`; a user session always runs as `PLAYBACK_BASE_ROLE`.
 * @property {number} [actionsLimit]        actionslimit:<n>, a positive integer: for sessions that run a known, fixed number of API actions.
 * @property {string} [ipRestrict]          iprestrict:<ip>: bind the token to a single client IP.
 * @property {string} [uriRestrict]         urirestrict:<prefix>: bind the token to a URI prefix. Values pass through as is (no comma or whitespace).
 * @property {string} [sessionGroupId]      sessionid:<id>: group tokens so one revoke() kills the whole family.
 */

const DISABLE_ENTITLEMENT = 'disableentitlement';
// OVP session/start `type` per SessionType.
const KS_TYPE = { user: '0', admin: '2' };
// Every user-type mint runs as this role, whatever role (if any) the userId has in the account.
const USER_ROLE = 'PLAYBACK_BASE_ROLE';
// Privilege keys that pick identity or persona. Each may appear at most once in a mint.
const SINGLE_KEYS = ['setrole', 'agentid', 'geniegpcid'];

// RFC 9700 §6.1 — short-lived by default. Browser-bound tokens get a short life;
// the server re-mints just-in-time (KS has no native refresh). Overridable per call.
const DEFAULT_TTL = { admin: 3600, conversation: 1800, agent: 1800 };
// Reject absurd lifetimes on browser-bound kinds (a multi-year conversation token is a
// multi-year leak window). Admin is server-side and may legitimately run longer flows.
const MAX_TTL = { conversation: 86400, agent: 86400, admin: 7 * 86400 };

/** Mints, tracks, and revokes Kaltura Session (KS) tokens — see the module docstring above for the two-KS-type security invariant. */
export class Sessions {
  // Declared as bare class fields (typed via JSDoc) so tsc's checkJs sees the shape —
  // the constructor overwrites both as non-enumerable via Object.defineProperty (below),
  // which is a legal re-definition of an already-configurable field.
  /** @type {string|undefined} */
  _adminSecret;
  /** @type {(() => (string|Promise<string>))|undefined} */
  _getAdminSecret;

  /**
   * @param {object} cfg
   * @param {string|number} cfg.partnerId
   * @param {string} [cfg.adminSecret]      Required for admin/conversation/agent mints; omit on pure client use.
   * @param {() => (string|Promise<string>)} [cfg.getAdminSecret]  Vault/KMS callback — fetched per-mint, never retained. Takes precedence over adminSecret.
   * @param {string} [cfg.ovpUrl]           OVP session host (default www.kaltura.com/api_v3).
   * @param {Http} cfg.http
   * @param {(event:object)=>void} [cfg.onAuditEvent]  Redacted structured security events (token.mint/token.revoke/...).
   * @param {(agentId:string) => Promise<string|number|undefined>} [cfg.resolveConfigId]  Looks up an agent's
   *   intellect config id for {@link Sessions.createAgentToken}. `Management` wires this for you.
   */
  constructor(cfg) {
    this._partnerId = String(cfg.partnerId);
    // Store the secret NON-ENUMERABLE so it can't be JSON.stringify'd / console.logged /
    // enumerated off the instance by accident (defense in depth atop the redaction layer).
    Object.defineProperty(this, '_adminSecret', { value: cfg.adminSecret, writable: false, enumerable: false, configurable: false });
    Object.defineProperty(this, '_getAdminSecret', { value: cfg.getAdminSecret, writable: false, enumerable: false, configurable: false });
    this._ovp = (cfg.ovpUrl || 'https://www.kaltura.com/api_v3').replace(/\/$/, '');
    this._http = cfg.http;
    this._resolveConfigId = cfg.resolveConfigId;
    this._audit = makeAuditEmitter(cfg.onAuditEvent, this._partnerId, 'ovp/session');
  }

  /**
   * Admin token (`disableentitlement`). SERVER-SIDE ONLY — bypasses entitlement.
   *
   * TTL: defaults to 3600s (1h) and is the ONLY kind allowed to outlive the
   * 30-min browser default — conversation/agent cap at 86400s, but admin caps at
   * 7 days (604800s). Pass anything above that and the mint throws
   * `ttl_too_long` BEFORE any network call (see {@link clampTtl}); re-mint from
   * your server instead of issuing a multi-day admin token.
   * @param {{userId:string|number, ttlSeconds?:number}} opts  `userId` is required:
   *   the person or service acting. The server makes it the owner of anything
   *   this token creates, and it becomes the audit event's `actor.subjectId`.
   *   A blank or missing `userId` throws `bad_request` before any network call.
   *   Per-call only: never cached on the `Sessions` instance or any module-level
   *   state (SDK Constitution Rule I-3: no cross-instance state leakage).
   *   ttlSeconds default 3600, max 604800.
   * @returns {Promise<Token>}  expiresAt is authoritative (= now + ttlSeconds), so
   *   isExpired()/secondsRemaining() are reliable for this kind.
   * @example
   * // Server-side only — never expose this token or its secret to a browser.
   * const k = new Management({ partnerId, adminSecret });
   * const admin = await k.sessions.createAdminToken({ userId: 'admin@example.com', ttlSeconds: 600 });
   * const list = await k.agents.list(admin.ks).all();
   * if (admin.secondsRemaining() < 60) {
   *   // re-mint proactively rather than risk a mid-flight expiry
   * }
   */
  async createAdminToken(opts) {
    const userId = requireAdminUserId(normalizeUserId(opts?.userId, 'createAdminToken'), 'createAdminToken');
    return this._start(DISABLE_ENTITLEMENT, 'admin', false, opts.ttlSeconds, userId, 'admin');
  }

  /**
   * Conversation token (`geniegpcid:<configId>`). Entitlement stays ON — this is
   * the token a server hands to a browser/end-user. Short-lived by default.
   * Use this when you start from a `configId`; when you start from an `agentId`,
   * see {@link Sessions.createAgentToken}.
   * Refuses any attempt to also disable entitlement. Tighten scope with
   * `restrictions` (least privilege) instead of hand-crafting `extraPrivileges`.
   *
   * A USER session (`type=0`, `setrole:PLAYBACK_BASE_ROLE`) unless you pass
   * `sessionType: 'admin'` (see the module docstring), which also requires a
   * `userId`. Pass `userId` to give
   * each end user their own threads.
   * @param {{configId:string|number, agentId?:string, userId?:string|number, sessionType?:SessionType, ttlSeconds?:number, restrictions?:Restrictions, extraPrivileges?:string}} opts
   *   `agentId` adds `agentid:<agentId>`, so threads carry the real agent id
   *   (not `"default"`) and lifecycle rules filtering on it match.
   *   `userId` binds this end-user-facing KS to a real end-user identity (passed
   *   straight through to `session/start`'s `userId` field). Per-call only: never
   *   cached on the `Sessions` instance or any module-level state (SDK
   *   Constitution Rule I-3: no cross-instance state leakage). This is what
   *   makes the `sys__user_id` reserved template variable resolve to something
   *   other than `''` in prompts/converse.
   * @returns {Promise<Token>}
   * @example
   * // Per-user conversation: own threads only, and `{{ sys__user_id }}` resolves.
   * const conv = await k.sessions.createConversationToken({ configId, agentId, userId: 'learner-123' });
   * const reply = await k.converseOnce(configId, 'What have we covered so far?', {}, conv);
   */
  async createConversationToken(opts) {
    if (isBlank(opts.configId)) {
      throw new KalturaError({ type: 'about:blank', title: 'configId required', code: 'bad_request', detail: 'createConversationToken needs a configId.' });
    }
    const userId = normalizeUserId(opts.userId, 'createConversationToken');
    if (opts.sessionType === 'admin') requireAdminUserId(userId, 'createConversationToken');
    const base = [`geniegpcid:${opts.configId}`];
    if (!isBlank(opts.agentId)) base.push(`agentid:${opts.agentId}`);
    const { privileges, sessionType } = endUserPrivileges(base, opts, 'createConversationToken');
    return this._start(privileges, 'conversation', true, opts.ttlSeconds, userId, sessionType);
  }

  /**
   * Agent token (`agentid:<agentId>` + `geniegpcid:<configId>`). Use this when
   * you start from an `agentId`; when you only have a `configId`, see
   * {@link Sessions.createConversationToken}. `geniegpcid`
   * picks the agent's intellect config, so replies come from that agent's
   * persona. `agentid` sets a converse-created thread's `agent_id` to the real
   * agent id instead of `"default"`, which lifecycle rules filtering on
   * `object.agent_id` need. It is also what `application.appInit` needs.
   *
   * `configId` is optional. When omitted, the SDK reads it from the agent
   * (a 60s admin token with `userId: 'intelligent-agents-sdk'` plus
   * `agents.get` per mint, and the admin mint emits its own audit event). Pass it to skip both calls. A
   * standalone `Sessions` (not built by `Management`) can't look it up: it then
   * mints `agentid` only, which answers with the default assistant persona,
   * not the agent's.
   *
   * Session type, `userId`, entitlement, `restrictions` and TTL follow the same
   * rules as {@link createConversationToken} (default 1800s, capped at 86400s,
   * see {@link DEFAULT_TTL}/{@link MAX_TTL}).
   * @param {{agentId:string, configId?:string|number, userId?:string|number, sessionType?:SessionType, ttlSeconds?:number, restrictions?:Restrictions, extraPrivileges?:string}} opts
   * @returns {Promise<Token>}
   * @throws {import('./errors.js').KalturaError} `code:'intellect_not_found'` when `configId`
   *   is omitted and the agent has no numeric intellect id.
   * @example
   * // Server-side mint for one end user of one agent.
   * const k = new Management({ partnerId, adminSecret });
   * const t = await k.sessions.createAgentToken({ agentId: '1_abc123', userId: 'learner-123' });
   */
  async createAgentToken(opts) {
    if (isBlank(opts.agentId)) {
      throw new KalturaError({ type: 'about:blank', title: 'agentId required', code: 'bad_request', detail: 'createAgentToken needs an agentId.' });
    }
    const userId = normalizeUserId(opts.userId, 'createAgentToken');
    if (opts.sessionType === 'admin') requireAdminUserId(userId, 'createAgentToken');
    const base = [`agentid:${opts.agentId}`];
    let configId = opts.configId;
    if (isBlank(configId) && typeof this._resolveConfigId === 'function') {
      // Validate first, so a bad call throws before the lookup's network calls.
      endUserPrivileges([...base, 'geniegpcid:0'], opts, 'createAgentToken');
      configId = await this._resolveConfigId(opts.agentId);
      if (isBlank(configId)) {
        throw new KalturaError({
          type: 'about:blank', title: 'agent has no intellect', code: 'intellect_not_found',
          detail: `createAgentToken: agent ${opts.agentId} has no intellect config id. Pass configId explicitly.`,
        });
      }
    }
    if (!isBlank(configId)) base.push(`geniegpcid:${configId}`);
    const { privileges, sessionType } = endUserPrivileges(base, opts, 'createAgentToken');
    return this._start(privileges, 'agent', true, opts.ttlSeconds, userId, sessionType);
  }

  /**
   * Anonymous widget token from a widgetId alone — no secret, no user identity.
   * This is the intended public end-user path; carries entitlement automatically.
   *
   * The KS is the same for every visitor of the widget. For per-user threads,
   * mint a per-user {@link createAgentToken} on your server and pass it to
   * `application.appInit` instead.
   *
   * EXPIRY IS NOT KNOWN CLIENT-SIDE: `startWidgetSession` returns only the KS,
   * not its lifetime — the server sets the widget TTL. So the returned Token has
   * `expiresAt:0`, which makes `isExpired()` return false and `secondsRemaining()`
   * return Infinity for this kind. Those helpers are NON-AUTHORITATIVE here: do
   * NOT gate re-minting on them. Instead re-mint proactively on a fixed interval,
   * or detect expiry reactively when a call fails with 401 (`unauthorized`) and
   * mint a fresh widget token then.
   * @param {{widgetId:string}} opts
   * @returns {Promise<Token>}  kind:'widget', entitlementEnforced:true, expiresAt:0
   *   (unknown — see above).
   * @example
   * // Public, secret-free path — safe to run in a browser.
   * const k = new Management({ partnerId });  // no adminSecret needed
   * let token = await k.sessions.createWidgetToken({ widgetId });
   * try {
   *   await k.application.appInit(token.ks);
   * } catch (err) {
   *   if (err.status === 401 || err.code === 'unauthorized') {
   *     token = await k.sessions.createWidgetToken({ widgetId });  // re-mint, retry
   *   } else { throw err; }
   * }
   */
  async createWidgetToken(opts) {
    const url = `${this._ovp}/service/session/action/startWidgetSession`;
    const form = new URLSearchParams({ format: '1', widgetId: opts.widgetId });
    const { data, requestId } = await this._http.request({ method: 'POST', url, body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const ks = data && typeof data === 'object' ? data.ks : data;
    if (!ks || typeof ks !== 'string') {
      throw new KalturaError({ type: 'about:blank', title: 'widget session failed', code: 'session_failed', detail: 'startWidgetSession returned no ks', body: data });
    }
    this._audit('token.mint', 'success', { kind: 'widget', privileges: `widget:${opts.widgetId}`, entitlementEnforced: true, requestId });
    return this._receipt(ks, 'widget', true, `widget:${opts.widgetId}`, 0);
  }

  /**
   * REVOKE a token now (Kaltura `session/end`) — the active revocation lever for a
   * leaked/abused token (RFC 9700 §5.2.1.1; SOC 2 CC6.2/CC6.3). Returns a redacted
   * `_meta` revocation receipt. If the token was minted with
   * `restrictions.sessionGroupId` (→ `sessionid:<id>`), every token sharing that
   * id is revoked with it.
   * @param {string|Token} tokenOrKs
   * @returns {Promise<{revokedAt:string, partnerId:string, _meta:object}>}
   */
  async revoke(tokenOrKs) {
    const ks = tokenOrKs && typeof tokenOrKs === 'object' ? tokenOrKs.ks : tokenOrKs;
    const kind = tokenOrKs && typeof tokenOrKs === 'object' ? tokenOrKs.kind : undefined;
    if (!ks || typeof ks !== 'string') {
      throw new KalturaError({ type: 'about:blank', title: 'ks required', code: 'bad_request', detail: 'revoke() needs a KS string or a minted Token.' });
    }
    const url = `${this._ovp}/service/session/action/end`;
    const form = new URLSearchParams({ format: '1', ks });
    try {
      const { requestId } = await this._http.request({ method: 'POST', url, body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      this._audit('token.revoke', 'success', { kind, requestId });
    } catch (err) {
      this._audit('token.revoke', 'fail', { kind, reason: err && err.code });
      throw err;
    }
    const m = meta({ partnerId: this._partnerId, source: 'ovp/session/end', scope: kind || 'unknown', kind });
    return { revokedAt: m.generatedAt, partnerId: this._partnerId, _meta: m };
  }

  /**
   * Internal: OVP `session/start`. Requires the admin secret (or vault callback).
   * @param {string} privileges @param {TokenKind} kind @param {boolean} entitlementEnforced @param {number|undefined} ttl
   * @param {string|undefined} userId  Pre-normalized (via {@link normalizeUserId}) end-user identity to
   *   bind on the KS. Per-call parameter only — never stored on `this`.
   * @param {SessionType} sessionType  `'user'` → type 0, `'admin'` → type 2.
   */
  async _start(privileges, kind, entitlementEnforced, ttl, userId, sessionType) {
    const secret = await this._resolveSecret();
    if (!secret) {
      throw new KalturaError({ type: 'about:blank', title: 'admin secret required', code: 'no_secret', detail: `${kind} token mint needs adminSecret or getAdminSecret (server-side only).` });
    }
    const ttlSeconds = clampTtl(ttl, kind);
    const url = `${this._ovp}/service/session/action/start`;
    const form = new URLSearchParams({
      format: '1', secret, partnerId: this._partnerId,
      type: KS_TYPE[sessionType], expiry: String(ttlSeconds), privileges,
    });
    if (userId !== undefined) form.set('userId', userId);
    let data, requestId;
    try {
      ({ data, requestId } = await this._http.request({ method: 'POST', url, body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
    } catch (err) {
      this._audit('token.mint', 'fail', { kind, sessionType, privileges, entitlementEnforced, reason: err && err.code, subjectId: userId });
      throw err;
    }
    const ks = typeof data === 'string' ? data : (data && data.ks);
    if (!ks || typeof ks !== 'string' || !ks.startsWith('djJ8')) {
      this._audit('token.mint', 'fail', { kind, sessionType, privileges, entitlementEnforced, reason: 'no_ks', subjectId: userId });
      throw new KalturaError({ type: 'about:blank', title: 'session start failed', code: 'session_failed', detail: 'session/start did not return a KS', body: data });
    }
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    this._audit('token.mint', 'success', { kind, sessionType, privileges, entitlementEnforced, expiresAt, requestId, subjectId: userId });
    return this._receipt(ks, kind, entitlementEnforced, privileges, expiresAt, userId, sessionType);
  }

  /** Resolve the admin secret: vault callback first (ephemeral), else the stored secret. */
  async _resolveSecret() {
    if (typeof this._getAdminSecret === 'function') return this._getAdminSecret();
    return this._adminSecret;
  }

  /**
   * @param {string} [userId] Present only when the caller bound a real end-user identity.
   * @param {SessionType} [sessionType] Absent for widget tokens.
   * @returns {Token}
   */
  _receipt(ks, kind, entitlementEnforced, privileges, expiresAt, userId, sessionType) {
    const st = sessionType !== undefined ? { sessionType } : {};
    const token = {
      ks, kind, ...st, entitlementEnforced, privileges, expiresAt,
      scope: meta({ partnerId: this._partnerId, source: 'ovp/session', scope: kind, kind, ...st, privileges, entitlementEnforced, ...(userId !== undefined ? { userId } : {}) }),
    };
    // Ergonomic, non-enumerable helpers (don't pollute JSON.stringify / logs).
    Object.defineProperty(token, 'isExpired', { value: () => expiresAt > 0 && Math.floor(Date.now() / 1000) >= expiresAt, enumerable: false });
    Object.defineProperty(token, 'secondsRemaining', { value: () => (expiresAt > 0 ? Math.max(0, expiresAt - Math.floor(Date.now() / 1000)) : Infinity), enumerable: false });
    // isExpired/secondsRemaining are added above via defineProperty (kept non-enumerable
    // on purpose, so they don't pollute JSON.stringify/logs) rather than in the object
    // literal, so the static type can't see them on `token` itself.
    return /** @type {Token} */ (token);
  }
}

/**
 * Compile structured least-privilege options into a KS privilege suffix
 * (RFC 9700 §2.3 minimum scope / §4.10 binding, realized via Kaltura privileges).
 * Returns '' or ',priv1,priv2,…'. Each value stays inside one `key:value` pair: a value
 * with ',' or whitespace, or a non-integer `actionsLimit`, is rejected (bad_request).
 * @param {Restrictions|undefined} r @param {string} where
 */
function compileRestrictions(r, where) {
  if (!r) return '';
  const bad = (/** @type {string} */ detail) => new KalturaError({
    type: 'about:blank', title: 'invalid restrictions', code: 'bad_request', detail: `${where}: ${detail}`,
  });
  // A privilege is `key:value`. Pairs are joined by ',' with no spaces, so a value with ',' or
  // whitespace would split into extra privileges. ':' (IPv6, URIs), '/' (several params in one
  // value) and '*' (wildcard) are valid inside a value.
  const value = (/** @type {'role'|'ipRestrict'|'uriRestrict'|'sessionGroupId'} */ key) => {
    const v = r[key];
    if (isBlank(v)) return undefined;
    const str = String(v);
    if (/[,\s]/.test(str)) throw bad(`restrictions.${key} must not contain a comma or whitespace.`);
    return str;
  };
  const parts = [];
  const role = value('role');
  if (role) parts.push(`setrole:${role}`);
  if (!isBlank(r.actionsLimit)) {
    if (!Number.isInteger(r.actionsLimit) || /** @type {number} */ (r.actionsLimit) < 1) {
      throw bad('restrictions.actionsLimit must be a positive integer.');
    }
    parts.push(`actionslimit:${r.actionsLimit}`);
  }
  const ip = value('ipRestrict');
  if (ip) parts.push(`iprestrict:${ip}`);
  const uri = value('uriRestrict');
  if (uri) parts.push(`urirestrict:${uri}`);
  const group = value('sessionGroupId');
  if (group) parts.push(`sessionid:${group}`);
  return parts.length ? `,${parts.join(',')}` : '';
}

/** @param {unknown} v @returns {boolean} */
function isBlank(v) { return v === undefined || v === null || v === ''; }

/**
 * Default an end-user token's session type to `'user'`. Throws on anything but
 * `'user'` or `'admin'`. @param {unknown} t @param {string} where @returns {SessionType}
 */
function normalizeSessionType(t, where) {
  if (t === undefined || t === null) return 'user';
  if (t === 'user' || t === 'admin') return t;
  throw new KalturaError({
    type: 'about:blank', title: 'invalid sessionType', code: 'bad_request',
    detail: `${where}: sessionType must be 'user' or 'admin', got ${JSON.stringify(t)}.`,
  });
}

/**
 * Build the privilege string for a conversation/agent token. A user session
 * always carries `setrole:${USER_ROLE}`, so a caller role can't replace it.
 * Throws before any network call.
 * @param {string[]} base @param {{sessionType?:unknown, restrictions?:Restrictions, extraPrivileges?:string}} opts @param {string} where
 * @returns {{privileges:string, sessionType:SessionType}}
 */
function endUserPrivileges(base, opts, where) {
  const sessionType = normalizeSessionType(opts.sessionType, where);
  if (sessionType === 'user' && opts.restrictions && !isBlank(opts.restrictions.role)) {
    throw new KalturaError({
      type: 'about:blank', title: 'role not allowed', code: 'bad_request',
      detail: `${where}: restrictions.role is not allowed on a user session, which always runs as ${USER_ROLE}. Pass sessionType: 'admin' to set a role.`,
    });
  }
  let privileges = base.join(',');
  if (sessionType === 'user') privileges += `,setrole:${USER_ROLE}`;
  privileges += compileRestrictions(opts.restrictions, where);
  if (opts.extraPrivileges) privileges += `,${opts.extraPrivileges}`;
  assertEntitlementOn(privileges, where);
  assertSingleKeys(privileges, where);
  return { privileges, sessionType };
}

/** Guard: each of {@link SINGLE_KEYS} may appear at most once. @param {string} privileges @param {string} where */
function assertSingleKeys(privileges, where) {
  const keys = privileges.split(',').map((p) => p.split(':')[0].trim().toLowerCase());
  for (const k of SINGLE_KEYS) {
    if (keys.filter((x) => x === k).length > 1) {
      throw new KalturaError({
        type: 'about:blank', title: 'duplicate privilege', code: 'bad_request',
        detail: `${where}: '${k}' may appear only once in the privileges. Remove it from extraPrivileges.`,
      });
    }
  }
}

/**
 * Validate + normalize a caller-supplied `userId` to a string, or `undefined`
 * if none was given. Throws
 * BEFORE any network call if a non-scalar (object/array) was passed — the same
 * pre-flight-reject shape as the `configId` guard above.
 * Sanitized via `oneLine` (strips CR/LF/TAB, caps at 512 chars) — the returned
 * value rides into `Token.scope` (a caller-facing, commonly-logged receipt) as
 * well as the audit event, so it gets the same log-injection defense both places.
 * @param {unknown} userId @param {string} where @returns {string|undefined}
 */
function normalizeUserId(userId, where) {
  if (userId === undefined || userId === null || userId === '') return undefined;
  if (typeof userId !== 'string' && typeof userId !== 'number') {
    throw new KalturaError({
      type: 'about:blank', title: 'invalid userId', code: 'bad_request',
      detail: `${where}: userId must be a string or number, got ${Array.isArray(userId) ? 'array' : typeof userId}.`,
    });
  }
  if (typeof userId === 'number' && !isFinite(userId)) {
    throw new KalturaError({
      type: 'about:blank', title: 'invalid userId', code: 'bad_request',
      detail: `${where}: userId must be a finite number, got ${userId}.`,
    });
  }
  const normalized = oneLine(String(userId));
  return normalized === '' ? undefined : normalized;
}

/** An admin-type KS must name who is acting. @param {string|undefined} userId @param {string} where */
function requireAdminUserId(userId, where) {
  if (userId !== undefined) return userId;
  throw new KalturaError({
    type: 'about:blank', title: 'userId required', code: 'bad_request',
    detail: `${where}: an admin session needs a userId. The server makes it the owner of anything this token creates.`,
  });
}

/** Clamp/default a TTL per kind. @param {number|undefined} ttl @param {TokenKind} kind */
function clampTtl(ttl, kind) {
  const def = DEFAULT_TTL[kind] ?? 1800;
  if (ttl === undefined || ttl === null) return def;
  if (typeof ttl !== 'number' || !isFinite(ttl) || ttl <= 0) {
    throw new KalturaError({ type: 'about:blank', title: 'invalid ttlSeconds', code: 'bad_request', detail: `ttlSeconds must be a positive number of seconds (got ${ttl}).` });
  }
  const max = MAX_TTL[kind];
  if (max && ttl > max) {
    throw new KalturaError({
      type: 'https://docs.kaltura.com/agentic/errors/ttl_too_long', title: 'ttlSeconds too long', code: 'ttl_too_long',
      detail: `A ${kind} token must not live longer than ${max}s (got ${ttl}). Short-lived browser tokens are the primary revocation lever (RFC 9700 §6.1); re-mint from your server instead of issuing a long-lived token.`,
    });
  }
  return Math.floor(ttl);
}

/**
 * Build a crash-safe, redaction-clean audit emitter. Returns a no-op if no hook
 * is set (zero cost). A throwing consumer hook never breaks a mint/revoke.
 * @param {((e:object)=>void)|undefined} hook @param {string} partnerId @param {string} source @param {string|null} [subjectId]
 */
function makeAuditEmitter(hook, partnerId, source, subjectId) {
  if (typeof hook !== 'function') return () => {};
  return (type, outcome, fields = {}) => {
    try { hook(buildAuditEvent({ type, outcome, partnerId, source, subjectId, ...fields })); } catch { /* a bad SIEM sink must never break the SDK */ }
  };
}

/**
 * Guard: a conversation/agent/widget token must NEVER carry a privilege that
 * disables entitlement. Throws before any network call.
 * @param {string} privileges @param {string} where
 */
function assertEntitlementOn(privileges, where) {
  if (/\bdisableentitlement\b/i.test(privileges)) {
    throw new KalturaError({
      type: 'https://docs.kaltura.com/agentic/errors/entitlement_violation',
      title: 'entitlement violation',
      code: 'entitlement_violation',
      detail: `${where} refuses 'disableentitlement'. End-user/conversation tokens must keep entitlement ON. Use createAdminToken({ userId }) for management (server-side only).`,
    });
  }
}

// ─────────────────────────── audit event schema (NIST AU-3 / OWASP) ───────────────────────────

/**
 * @typedef {object} AuditEventInput
 * @property {string} type          Required. Event category, free-form (not a closed enum — other
 * SDK subsystems emit their own categories). Examples from this module: `token.mint` | `token.revoke`
 * | `auth.fail`. Examples from elsewhere in the SDK: `guard.reject` | `session.connect` | `session.disconnect`.
 * @property {string} outcome       Required. `'success'` or `'fail'`.
 * @property {string|number} [partnerId]         Tenant scope.
 * @property {string} [source]      Originating subsystem (e.g. `'ovp/session'`).
 * @property {string} [subjectId]   Opaque subject identifier (sanitized via oneLine).
 * @property {TokenKind} [kind]     Token kind involved in this event.
 * @property {SessionType} [sessionType]  Session type of a minted token.
 * @property {boolean} [entitlementEnforced]  Whether entitlement was ON for the token.
 * @property {string} [privileges]  KS privilege string (sanitized, never raw KS).
 * @property {string} [reason]      Short failure reason code (sanitized via oneLine).
 * @property {string} [requestId]   Per-call correlation id.
 * @property {string} [target]      Resource acted on.
 * @property {string} [action]      Specific action taken.
 * @property {number} [expiresAt]   Unix epoch seconds for minted tokens.
 * @property {string} [severity]    Override computed severity (`'info'`|`'warning'`|`'error'`).
 */

/**
 * Build a stable, redacted, JSON-serializable AuditEvent (NIST AU-3 what/when/
 * where/who/outcome; OWASP logging). The raw KS is NEVER included — only its
 * kind + scope. Free-text fields are stripped of CR/LF to prevent log injection
 * (CWE-117). Used by the Sessions emitter and re-exported for the other fronts.
 * @param {AuditEventInput} e
 * @returns {object}
 */
export function buildAuditEvent(e) {
  const sev = e.outcome === 'fail' ? (e.type && /auth|guard|denied/.test(e.type) ? 'warning' : 'error') : 'info';
  const event = {
    ts: new Date().toISOString(),
    type: e.type,                         // free-form category, e.g. token.mint | token.revoke | auth.fail (see the AuditEventInput typedef above)
    severity: e.severity || sev,
    outcome: e.outcome || 'success',      // success | fail
    requestId: e.requestId || null,       // correlation id (reuses the per-call requestId)
    actor: { partnerId: e.partnerId != null ? String(e.partnerId) : null, subjectId: e.subjectId != null ? oneLine(String(e.subjectId)) : null, kind: e.kind || null, sessionType: e.sessionType || null, entitlementEnforced: e.entitlementEnforced },
    target: e.target || null,
    action: e.action || null,
    scope: e.privileges ? oneLine(e.privileges) : null,
    reason: e.reason ? oneLine(String(e.reason)) : null,
    source: e.source || null,
    expiresAt: e.expiresAt || undefined,
    _meta: meta({ partnerId: e.partnerId, source: e.source || 'sdk', scope: 'audit' }),
  };
  return redact(event);   // single chokepoint — a KS/secret/private-IP can never ride an audit event
}

/** Strip CR/LF/TAB from free text (CWE-117 log-injection guard). @param {string} s */
function oneLine(s) { return String(s).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 512); }

export { makeAuditEmitter };
