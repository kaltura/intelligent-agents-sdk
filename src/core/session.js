/**
 * Kaltura Session (KS) minting + lifecycle + the two-KS-type security invariant.
 *
 * THE INVARIANT (CLAUDE.md "Two KS types, never mix"):
 *   - `disableentitlement` bypasses access control → ADMIN/MANAGEMENT ONLY.
 *     Reachable solely via {@link Sessions.createAdminToken} (server-side).
 *   - `geniegpcid:<configId>` keeps entitlement ON → the conversation/end-user
 *     token. {@link Sessions.createConversationToken} forbids any privilege
 *     that would disable entitlement, so a client/end-user surface can never
 *     mint an admin-scoped token even by mistake.
 *
 * SECURITY POSTURE (grounded in RFC 9700 OAuth 2.0 Security BCP + NIST 800-53):
 *   - Least privilege (AC-6): a structured `restrictions` builder compiles to
 *     Kaltura KS privileges (setrole/actionslimit/iprestrict/urirestrict) so
 *     callers tighten scope without learning the KS DSL.
 *   - Short-lived by default (RFC 9700 §6.1): browser-bound tokens default to
 *     30 min TTL; a short TTL is the primary revocation lever
 *     for a stateless KS. Absurd lifetimes on browser-bound kinds are rejected.
 *   - Active revocation (RFC 9700 §5.2.1.1, SOC 2 CC6.2/CC6.3): {@link
 *     Sessions.revoke} ends a leaked token now; an optional `sessionGroupId`
 *     bakes `sessionid:<id>` so a whole family is DESIGNED to die in one
 *     `revoke` — asserted by design, and checked here only at the
 *     KS-privilege-string level, not the actual revocation-cascade behavior
 *     (see {@link Sessions.revoke}).
 *   - Auditability (NIST AU-2/AU-3): every mint/revoke fires a redacted audit
 *     event and returns a `scope` receipt; the admin secret is NEVER returned,
 *     logged, enumerable, or attached to a token. When a caller binds a real
 *     end-user identity via `userId`, it rides the mint call as a
 *     per-call parameter ONLY (never cached on `this` or module state) and
 *     populates the audit event's `actor.subjectId` — the first attributable
 *     actor this SDK's audit trail has ever had.
 *
 * Token-mint hits the OVP session service (`session/start`,
 * `startWidgetSession`, `session/end`). The admin secret is read once at
 * construction, stored non-enumerable, and is NEVER returned or serialized.
 */
// eslint-disable-next-line no-unused-vars -- referenced only in the @param {Http} JSDoc type below
import { Http } from './http.js';
import { meta } from './ids.js';
import { KalturaError } from './errors.js';
import { redact } from './redact.js';

/** @typedef {'admin'|'conversation'|'agent'|'widget'} TokenKind */

/**
 * @typedef {object} Token
 * @property {string} ks                The KS string (treat as a secret).
 * @property {TokenKind} kind
 * @property {boolean} entitlementEnforced  true for conversation/widget; false only for admin.
 * @property {string} privileges        The privilege string baked in.
 * @property {number} expiresAt         Unix epoch seconds (best-effort; 0 if unknown).
 * @property {object} scope             Audit receipt: {generatedAt, partnerId, kind, privileges, entitlementEnforced, userId?}.
 * @property {() => boolean} isExpired   true once past expiresAt (false if unknown). Non-enumerable.
 * @property {() => number} secondsRemaining  Seconds until expiry (Infinity if unknown, 0 if past). Non-enumerable.
 */

/**
 * @typedef {object} Restrictions  Structured least-privilege options (compiled to KS privileges).
 * @property {string|number} [role]         setrole:<id> — run as a specific (narrower) Kaltura role.
 * @property {number} [actionsLimit]        actionslimit:<n> — cap the number of API actions this token may perform.
 * @property {string} [ipRestrict]          iprestrict:<ip> — bind the token to a single client IP.
 * @property {string} [uriRestrict]         urirestrict:<prefix> — bind the token to a URI prefix.
 * @property {string} [sessionGroupId]      sessionid:<id> — group tokens so one revoke() kills the whole family.
 */

const DISABLE_ENTITLEMENT = 'disableentitlement';

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
   */
  constructor(cfg) {
    this._partnerId = String(cfg.partnerId);
    // Store the secret NON-ENUMERABLE so it can't be JSON.stringify'd / console.logged /
    // enumerated off the instance by accident (defense in depth atop the redaction layer).
    Object.defineProperty(this, '_adminSecret', { value: cfg.adminSecret, writable: false, enumerable: false, configurable: false });
    Object.defineProperty(this, '_getAdminSecret', { value: cfg.getAdminSecret, writable: false, enumerable: false, configurable: false });
    this._ovp = (cfg.ovpUrl || 'https://www.kaltura.com/api_v3').replace(/\/$/, '');
    this._http = cfg.http;
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
   * @param {{ttlSeconds?:number, userId?:string|number}} [opts]  ttlSeconds default
   *   3600, max 604800. `userId` binds the minted KS to a real end-user identity
   *   (passed straight through to `session/start`'s `userId` field) — omit it for
   *   the pre-existing anonymous behavior (zero behavior change for callers that
   *   don't pass it). Per-call only: never cached on the `Sessions` instance or
   *   any module-level state (SDK_CONSTITUTION.md "no shared mutable state").
   *   This is what makes the `sys__user_id` reserved template variable resolve
   *   to something other than `''` in prompts/converse.
   * @returns {Promise<Token>}  expiresAt is authoritative (= now + ttlSeconds), so
   *   isExpired()/secondsRemaining() are reliable for this kind.
   * @example
   * // Server-side only — never expose this token or its secret to a browser.
   * const k = new Management({ partnerId, adminSecret });
   * const admin = await k.sessions.createAdminToken({ ttlSeconds: 600 });
   * const list = await k.agents.list(admin.ks).all();
   * if (admin.secondsRemaining() < 60) {
   *   // re-mint proactively rather than risk a mid-flight expiry
   * }
   * @example
   * // Bind the admin token itself to a real actor for audit attribution.
   * const admin = await k.sessions.createAdminToken({ userId: 'ops-console-42' });
   */
  async createAdminToken(opts = {}) {
    const userId = normalizeUserId(opts.userId, 'createAdminToken');
    return this._start(DISABLE_ENTITLEMENT, 'admin', false, opts.ttlSeconds, userId);
  }

  /**
   * Conversation token (`geniegpcid:<configId>`). Entitlement stays ON — this is
   * the token a server hands to a browser/end-user. Short-lived by default.
   * Refuses any attempt to also disable entitlement. Tighten scope with
   * `restrictions` (least privilege) instead of hand-crafting `extraPrivileges`.
   * @param {{configId:string|number, ttlSeconds?:number, restrictions?:Restrictions, extraPrivileges?:string, userId?:string|number}} opts
   *   `userId` binds this end-user-facing KS to a real end-user identity (passed
   *   straight through to `session/start`'s `userId` field) — omit it for the
   *   pre-existing anonymous behavior (zero behavior change for callers that
   *   don't pass it). Per-call only: never cached on the `Sessions` instance or
   *   any module-level state (SDK_CONSTITUTION.md "no shared mutable state").
   *   This is what makes the `sys__user_id` reserved template variable resolve
   *   to something other than `''` in prompts/converse.
   * @returns {Promise<Token>}
   * @example
   * // Bind a per-user conversation so `{{ sys__user_id }}` resolves server-side
   * // and per-user memory/analytics can attribute this turn correctly.
   * const conv = await k.sessions.createConversationToken({ configId, userId: 'learner-123' });
   * const reply = await k.converseOnce(configId, 'What have we covered so far?', {}, conv);
   */
  async createConversationToken(opts) {
    if (opts.configId === undefined || opts.configId === null || opts.configId === '') {
      throw new KalturaError({ type: 'about:blank', title: 'configId required', code: 'bad_request', detail: 'createConversationToken needs a configId.' });
    }
    const userId = normalizeUserId(opts.userId, 'createConversationToken');
    let priv = `geniegpcid:${opts.configId}`;
    priv += compileRestrictions(opts.restrictions);
    if (opts.extraPrivileges) priv += `,${opts.extraPrivileges}`;
    assertEntitlementOn(priv, 'createConversationToken');
    return this._start(priv, 'conversation', true, opts.ttlSeconds, userId);
  }

  /**
   * Agent-scoped token (`agentid:<agentId>`) — binds the token to a single
   * agent rather than an intellect config (contrast {@link createConversationToken}'s
   * `geniegpcid:<configId>`). This is what sets a converse-created thread's
   * `agent_id` to the real agent uuid instead of `"default"` — required for
   * any lifecycle rule filtering on `object.agent_id` to ever match a thread
   * created via `conversations.send()`/`.stream()`. Entitlement stays ON;
   * refuses any attempt to also disable entitlement (same guard as
   * `createConversationToken`). Tighten scope with `restrictions` (least
   * privilege) instead of hand-crafting `extraPrivileges`. TTL follows the
   * same short-lived-by-default/max-TTL rules as `conversation` (default
   * 1800s, capped at 86400s — see {@link DEFAULT_TTL}/{@link MAX_TTL}).
   *
   * `userId` is intentionally NOT supported here (scoped to
   * {@link createAdminToken} and {@link createConversationToken} only — this
   * method mints a token scoped to a single agent, not to an end-user
   * identity). Passing `userId` throws rather than silently dropping it — use
   * `createConversationToken` if you need `{{ sys__user_id }}` to resolve.
   * @param {{agentId:string, ttlSeconds?:number, restrictions?:Restrictions, extraPrivileges?:string, userId?:unknown}} opts
   *   `userId` is accepted in the type only so the fail-fast check below can read it — see the note above; passing it always throws.
   * @returns {Promise<Token>}
   * @example
   * // Server-side mint for an agent-scoped conversation surface.
   * const k = new Management({ partnerId, adminSecret });
   * const t = await k.sessions.createAgentToken({ agentId: '1_abc123' });
   */
  async createAgentToken(opts) {
    if (opts.userId !== undefined && opts.userId !== null && opts.userId !== '') {
      throw new KalturaError({
        type: 'about:blank',
        title: 'unsupported option',
        code: 'bad_request',
        detail: 'createAgentToken does not support userId — use createConversationToken (or createAdminToken) to bind a session to an end-user identity.',
      });
    }
    let priv = `agentid:${opts.agentId}`;
    priv += compileRestrictions(opts.restrictions);
    if (opts.extraPrivileges) priv += `,${opts.extraPrivileges}`;
    assertEntitlementOn(priv, 'createAgentToken');
    return this._start(priv, 'agent', true, opts.ttlSeconds);
  }

  /**
   * Anonymous widget token from a widgetId alone — no secret, no user identity.
   * This is the intended public end-user path; carries entitlement automatically.
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
   * `_meta` revocation receipt.
   *
   * SESSION-GROUP CLAIM (asserted by design, not independently confirmed): if
   * the token was minted with `restrictions.sessionGroupId` (→ `sessionid:<id>`),
   * the intent is that ending any one member ends the whole family. This SDK
   * only checks that the KS carries the `sessionid:<id>` privilege string
   * correctly; the actual revocation-cascade behavior (that `session/end`
   * on one member of the group really does invalidate every other KS sharing
   * that `sessionid`) is server-side and outside this SDK's control. Treat it
   * as the documented design intent, not a proven guarantee.
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
   * Internal: OVP `session/start` (type=2). Requires the admin secret (or vault callback).
   * @param {string} privileges @param {TokenKind} kind @param {boolean} entitlementEnforced @param {number} [ttl]
   * @param {string} [userId]  Pre-normalized (via {@link normalizeUserId}) end-user identity to
   *   bind on the KS. Per-call parameter only — never stored on `this`.
   */
  async _start(privileges, kind, entitlementEnforced, ttl, userId) {
    const secret = await this._resolveSecret();
    if (!secret) {
      throw new KalturaError({ type: 'about:blank', title: 'admin secret required', code: 'no_secret', detail: `${kind} token mint needs adminSecret or getAdminSecret (server-side only).` });
    }
    const ttlSeconds = clampTtl(ttl, kind);
    const url = `${this._ovp}/service/session/action/start`;
    const form = new URLSearchParams({
      format: '1', secret, partnerId: this._partnerId,
      type: '2', expiry: String(ttlSeconds), privileges,
    });
    if (userId !== undefined) form.set('userId', userId);
    let data, requestId;
    try {
      ({ data, requestId } = await this._http.request({ method: 'POST', url, body: form, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
    } catch (err) {
      this._audit('token.mint', 'fail', { kind, privileges, entitlementEnforced, reason: err && err.code, subjectId: userId });
      throw err;
    }
    const ks = typeof data === 'string' ? data : (data && data.ks);
    if (!ks || typeof ks !== 'string' || !ks.startsWith('djJ8')) {
      this._audit('token.mint', 'fail', { kind, privileges, entitlementEnforced, reason: 'no_ks', subjectId: userId });
      throw new KalturaError({ type: 'about:blank', title: 'session start failed', code: 'session_failed', detail: 'session/start did not return a KS', body: data });
    }
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    this._audit('token.mint', 'success', { kind, privileges, entitlementEnforced, expiresAt, requestId, subjectId: userId });
    return this._receipt(ks, kind, entitlementEnforced, privileges, expiresAt, userId);
  }

  /** Resolve the admin secret: vault callback first (ephemeral), else the stored secret. */
  async _resolveSecret() {
    if (typeof this._getAdminSecret === 'function') return this._getAdminSecret();
    return this._adminSecret;
  }

  /** @param {string} [userId] Present only when the caller bound a real end-user identity. @returns {Token} */
  _receipt(ks, kind, entitlementEnforced, privileges, expiresAt, userId) {
    const token = {
      ks, kind, entitlementEnforced, privileges, expiresAt,
      scope: meta({ partnerId: this._partnerId, source: 'ovp/session', scope: kind, kind, privileges, entitlementEnforced, ...(userId !== undefined ? { userId } : {}) }),
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
 * Returns '' or ',priv1,priv2,…'. @param {Restrictions} [r]
 */
function compileRestrictions(r) {
  if (!r) return '';
  const parts = [];
  if (r.role !== undefined && r.role !== null && r.role !== '') parts.push(`setrole:${r.role}`);
  if (typeof r.actionsLimit === 'number' && r.actionsLimit > 0) parts.push(`actionslimit:${r.actionsLimit}`);
  if (r.ipRestrict) parts.push(`iprestrict:${r.ipRestrict}`);
  if (r.uriRestrict) parts.push(`urirestrict:${r.uriRestrict}`);
  if (r.sessionGroupId) parts.push(`sessionid:${r.sessionGroupId}`);
  return parts.length ? `,${parts.join(',')}` : '';
}

/**
 * Validate + normalize a caller-supplied `userId` to a string, or `undefined`
 * if none was given (⇒ the pre-existing anonymous mint, byte-for-byte). Throws
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
      detail: `${where} refuses 'disableentitlement' — end-user/conversation tokens must keep entitlement ON. Use createAdminToken() for management (server-side only).`,
    });
  }
}

// ─────────────────────────── audit event schema (NIST AU-3 / OWASP) ───────────────────────────

/**
 * @typedef {object} AuditEventInput
 * @property {string} type          Required. Event category: `token.mint` | `token.revoke` | `auth.fail` | `guard.reject` | `privileged.call` | `session.connect` | `session.disconnect`.
 * @property {string} outcome       Required. `'success'` or `'fail'`.
 * @property {string|number} [partnerId]         Tenant scope.
 * @property {string} [source]      Originating subsystem (e.g. `'ovp/session'`).
 * @property {string} [subjectId]   Opaque subject identifier (sanitized via oneLine).
 * @property {TokenKind} [kind]     Token kind involved in this event.
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
    type: e.type,                         // token.mint | token.revoke | auth.fail | guard.reject | privileged.call | session.connect | session.disconnect
    severity: e.severity || sev,
    outcome: e.outcome || 'success',      // success | fail
    requestId: e.requestId || null,       // correlation id (reuses the per-call requestId)
    actor: { partnerId: e.partnerId != null ? String(e.partnerId) : null, subjectId: e.subjectId != null ? oneLine(String(e.subjectId)) : null, kind: e.kind || null, entitlementEnforced: e.entitlementEnforced },
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
