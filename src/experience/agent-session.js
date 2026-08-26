/**
 * KalturaAgentSession — one conversation, switchable transports.
 *
 * A thin facade that runs a single agent conversation over either transport —
 * `KalturaAvatarSession` (live video + voice) or `KalturaChatSession`
 * (text-only HTTPS) — and can switch between them MID-CONVERSATION without
 * losing the thread: `switchMode()` tears down the current transport,
 * constructs the other one seeded with the same `threadId` and the same
 * canonical `request_vars` map, and reconnects. The brain sees one continuous
 * conversation (thread continuity is live-verified in both directions).
 *
 * What the facade owns:
 *   - one state machine: `idle → connecting → connected ⇄ switching → closed | failed`
 *     (transport-level `stateChange` events are NOT forwarded raw — subscribe
 *     to the facade's own `stateChange {state, reason?}`).
 *   - the canonical `request_vars` map — `updateRequestVars` / `setDynamicPrompt`
 *     merge here first, then delegate, so a mid-conversation switch always
 *     rebuilds the next transport with the full current context.
 *   - the `onToolCall` handler registry — handlers registered once on the
 *     facade are re-registered on every transport it attaches.
 *   - forwarding of the transport-agnostic event subset: `transcript`,
 *     `turnStart`, `turnEnd`, `toolCall`, `toolCallResult`, `toolCallInvalid`,
 *     `error`, `warning`, `responsePending`, `responseSettled`,
 *     `agentActionDenied`, `ended` — same payload shapes on both transports.
 *
 * Mode-specific APIs (mic control, `interrupt()`, tap-to-talk, disclosure,
 * `videoEl` …) are NOT mirrored here: use the `transport` getter, and rewire
 * such listeners on each `transportChanged {mode, transport}` event.
 *
 * Switching is tear-down-and-reconstruct by design (v1): no live mutation of
 * a running transport, so each transport keeps its own verified lifecycle.
 * A `sendText()` that arrives while a switch is in flight is buffered (up to
 * {@link SWITCH_SEND_BUFFER_MAX}) and dispatched on the new transport; if the
 * switch fails, buffered sends reject with the switch error.
 */
import { Emitter } from './emitter.js';
import { KalturaAvatarSession } from './session.js';
import { KalturaChatSession } from './chat-session.js';
import { KalturaError } from '../core/errors.js';
import { assertRequestVars } from '../management/conversations.js';
import { sanitizeJson } from '../core/safety.js';

/** Events forwarded 1:1 from whichever transport is attached. */
const FORWARDED_EVENTS = [
  'transcript', 'turnStart', 'turnEnd',
  'toolCall', 'toolCallResult', 'toolCallInvalid',
  'error', 'warning', 'responsePending', 'responseSettled',
  'agentActionDenied',
];

/** Max sendText() calls buffered while a switchMode() is in flight. */
const SWITCH_SEND_BUFFER_MAX = 8;

export class KalturaAgentSession extends Emitter {
  /**
   * @param {object} cfg
   * @param {'avatar'|'chat'} [cfg.mode] Starting transport (default `'avatar'`).
   * @param {string|{ks:string}} cfg.token CONVERSATION KS — shared by both transports.
   * @param {Record<string, string|number|boolean|null>} [cfg.requestVars] Initial `{{var}}` request_vars map (canonical copy lives on the facade).
   * @param {string} [cfg.threadId] Seed thread id to continue an existing conversation.
   * @param {(level:string, msg:string, ...rest:any[])=>void} [cfg.logger]
   * @param {(e:object)=>void} [cfg.onAuditEvent] Structured audit hook, passed to every transport.
   * @param {string} [cfg.subjectId] Opaque subject id for audit events.
   * @param {string|number} [cfg.partnerId] Audit partner-id override.
   * @param {boolean} [cfg.allowInsecureTransport] Localhost/dev only.
   * @param {object} [cfg.avatar] KalturaAvatarSession-specific cfg (`videoEl`, `conversationManagerUrl`, `srsBaseUrl`, `turnServerUrl`, `socketFactory`, mic options, `capabilities`, …) — required before the first avatar connect/switch.
   * @param {object} [cfg.chat] KalturaChatSession-specific cfg (`genieUrl`, `fetch`, `capabilities`).
   * @param {{avatar?:(cfg:object)=>object, chat?:(cfg:object)=>object}} [cfg.transportFactories] Test/advanced hook: override how a transport is constructed (receives the merged per-transport cfg, must return a transport-shaped object).
   */
  constructor(cfg) {
    super();
    if (!cfg || !cfg.token) throw new KalturaError({ type: 'about:blank', title: 'token required', code: 'bad_request', detail: 'new KalturaAgentSession({ token }) needs a conversation KS.' });
    const mode = cfg.mode || 'avatar';
    if (mode !== 'avatar' && mode !== 'chat') throw new KalturaError({ type: 'about:blank', title: 'bad mode', code: 'bad_request', detail: `cfg.mode must be "avatar" or "chat" (got "${mode}").` });
    // Same secret posture as the transports: the token never sits on an
    // enumerable property — not directly, and not via the retained cfg.
    const { token, ...rest } = cfg;
    this._cfg = rest;
    Object.defineProperty(this, '_token', { value: token, writable: true, enumerable: false, configurable: true });
    this._mode = mode;
    // Canonical request_vars for the whole conversation — every transport this
    // facade constructs (including after a switch) is seeded from this map.
    this._requestVars = assertRequestVars(cfg.requestVars, 'KalturaAgentSession requestVars');
    this._threadId = cfg.threadId;
    /** @type {Map<string, Array<{handler: Function, schema?: object, rebind?: (t: object|null) => void}>>} */
    this._toolRegistry = new Map();
    this._transport = null;
    this._detachFns = [];
    this._switchBuffer = [];
    this._switching = null;
    /** @type {'idle'|'connecting'|'connected'|'switching'|'closed'|'failed'} */
    this.state = 'idle';
  }

  /**
   * Connect the starting transport. Resolves when the transport is live.
   * On failure the facade lands in `failed` (`stateChange` reason
   * `permission_denied` for a mic/camera rejection, else `transport_failed`)
   * and the transport's typed error is re-thrown — construct a new
   * KalturaAgentSession to retry.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.state !== 'idle') throw new KalturaError({ type: 'about:blank', title: 'already started', code: 'invalid_state', detail: `connect() is only valid once, from state "idle" (state="${this.state}") — construct a new KalturaAgentSession to reconnect.` });
    this._setState('connecting');
    try {
      const t = this._buildTransport(this._mode);
      this._attach(t);
      await t.connect();
      this._setState('connected');
    } catch (e) {
      this._teardownTransport();
      this._setState('failed', e && e.code === 'permission_denied' ? 'permission_denied' : 'transport_failed');
      throw e;
    }
  }

  /**
   * Switch the live conversation to the other transport, keeping the thread.
   *
   * Same-target calls are idempotent no-ops. Requires a connected session;
   * a call while another switch is in flight throws typed `invalid_state`.
   * Sequence: capture the current `threadId` → tear down the old transport →
   * construct the target transport seeded with that thread and the canonical
   * request_vars → connect it → emit `transportChanged` then
   * `modeChanged {mode, threadContinuity}`. `threadContinuity` is `false` only
   * when no turn had happened yet (no thread existed to carry over).
   *
   * On failure the facade lands in `failed` (no automatic rollback — the old
   * transport is already gone) and the error is re-thrown.
   * @param {'avatar'|'chat'} target
   * @returns {Promise<void>}
   */
  async switchMode(target) {
    if (target !== 'avatar' && target !== 'chat') throw new KalturaError({ type: 'about:blank', title: 'bad mode', code: 'bad_request', detail: `switchMode(target) must be "avatar" or "chat" (got "${target}").` });
    if (this.state === 'switching') throw new KalturaError({ type: 'about:blank', title: 'switch in flight', code: 'invalid_state', detail: 'switchMode() called while another switch is in flight — await the first switch.' });
    this._requireConnected('switchMode');
    if (target === this._mode) return;   // idempotent no-op
    const run = (async () => {
      this._setState('switching', 'user_requested');
      this._threadId = this._transport.threadId ?? this._threadId;
      const hadThread = this._threadId !== undefined && this._threadId !== null;
      this._teardownTransport();
      const t = this._buildTransport(target);
      this._mode = target;   // before _attach so transportChanged carries the new mode
      this._attach(t);
      await t.connect();
      this._setState('connected');
      this.emit('modeChanged', { mode: target, threadContinuity: hadThread });
    })();
    this._switching = run;
    try {
      await run;
      const buffered = this._switchBuffer.splice(0);
      for (const b of buffered) b.resolve(this._deliver(b.text, b.opts));
    } catch (e) {
      this._teardownTransport();
      this._setState('failed', 'transport_failed');
      const buffered = this._switchBuffer.splice(0);
      for (const b of buffered) b.reject(e);
      throw e;
    } finally {
      this._switching = null;
    }
  }

  /**
   * Send one user text turn on the current transport. In chat mode this
   * resolves with the collected turn (see `KalturaChatSession.sendText`); in
   * avatar mode it resolves `undefined` once dispatched — the reply arrives
   * via `transcript` events, as always. While a switch is in flight the send
   * is buffered and dispatched on the new transport (rejects if the switch
   * fails, or if more than {@link SWITCH_SEND_BUFFER_MAX} sends pile up).
   * @param {string} text
   * @param {{signal?: AbortSignal}} [opts] Chat mode only — abort the in-flight turn.
   * @returns {Promise<object|undefined>}
   */
  async sendText(text, opts = {}) {
    if (this.state === 'switching') {
      if (this._switchBuffer.length >= SWITCH_SEND_BUFFER_MAX) throw new KalturaError({ type: 'about:blank', title: 'switch buffer full', code: 'invalid_state', detail: `more than ${SWITCH_SEND_BUFFER_MAX} sendText() calls buffered during a mode switch — await switchMode() before sending more.` });
      return new Promise((resolve, reject) => this._switchBuffer.push({ text, opts, resolve, reject }));
    }
    this._requireConnected('sendText');
    return this._deliver(text, opts);
  }

  /** @param {string} text @param {object} opts */
  _deliver(text, opts) {
    return this._mode === 'chat' ? this._transport.sendText(text, opts) : this._transport.speak(text);
  }

  /**
   * Register a client-command handler for the whole conversation — the facade
   * re-registers it on every transport it attaches (including after a
   * switch), so tool handling survives mode changes. Same contract as
   * `KalturaAvatarSession.onToolCall`. Returns unsubscribe.
   * @param {string} name
   * @param {(args:object, call:object)=>unknown} handler
   * @param {object} [argsSchema]
   * @returns {() => void}
   */
  onToolCall(name, handler, argsSchema) {
    if (typeof name !== 'string' || !name.trim()) throw new KalturaError({ type: 'about:blank', title: 'bad onToolCall', code: 'bad_request', detail: 'onToolCall(name, handler) needs a non-empty tool name.' });
    if (typeof handler !== 'function') throw new KalturaError({ type: 'about:blank', title: 'bad onToolCall', code: 'bad_request', detail: 'onToolCall(name, handler) needs a handler function.' });
    const key = name.trim();
    const entry = { handler, schema: argsSchema };
    const list = this._toolRegistry.get(key) || [];
    list.push(entry);
    this._toolRegistry.set(key, list);
    let liveUnsub = this._transport ? this._transport.onToolCall(key, handler, argsSchema) : null;
    entry.rebind = (t) => { liveUnsub = t ? t.onToolCall(key, handler, argsSchema) : null; };
    return () => {
      const l = this._toolRegistry.get(key);
      if (l) { const i = l.indexOf(entry); if (i >= 0) l.splice(i, 1); if (!l.length) this._toolRegistry.delete(key); }
      if (liveUnsub) { liveUnsub(); liveUnsub = null; }
      entry.rebind = () => {};
    };
  }

  /**
   * ACK a `wait_for_response:true` tool call on the current transport (same
   * contract on both — one wire ACK, two transports).
   * @param {string} id @param {object} response
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async respondToTool(id, response) {
    this._requireConnected('respondToTool');
    return this._transport.respondToTool(id, response);
  }

  /**
   * Inject a context payload as the `page_context` request var (sugar over
   * {@link updateRequestVars}). Merged into the facade's canonical map first,
   * so it survives a transport switch, then delegated to the live transport.
   * @param {object} data JSON-serializable context object.
   */
  setDynamicPrompt(data) {
    this._requireConnected('setDynamicPrompt');
    this._requestVars = { ...(this._requestVars || {}), page_context: JSON.stringify(sanitizeJson(data) ?? null) };
    this._transport.setDynamicPrompt(data);
  }

  /**
   * MERGE new `{{var}}` request_vars into the conversation's canonical map,
   * then delegate to the live transport. The merged map seeds every transport
   * this facade constructs from now on.
   * @param {Record<string, string|number|boolean|null>} vars
   */
  updateRequestVars(vars) {
    this._requireConnected('updateRequestVars');
    const checked = assertRequestVars(vars, 'updateRequestVars');
    this._requestVars = { ...(this._requestVars || {}), ...(checked || {}) };
    this._transport.updateRequestVars(vars);
  }

  /**
   * End the conversation. Idempotent; safe from any state. Tears down the
   * live transport (if any), drops the token, and emits a single
   * `ended {reason:'disconnected'}`. Terminal — construct a new
   * KalturaAgentSession to talk again.
   */
  disconnect() {
    if (this.state === 'closed') return;
    this._teardownTransport();
    this._token = null;
    const buffered = this._switchBuffer.splice(0);
    const err = new KalturaError({ type: 'about:blank', title: 'disconnected', code: 'invalid_state', detail: 'session was disconnected while a sendText() was buffered.' });
    for (const b of buffered) b.reject(err);
    this._setState('closed');
    this.emit('ended', { reason: 'disconnected' });
  }

  /** Current transport mode (read-only). @returns {'avatar'|'chat'} */
  get mode() { return this._mode; }

  /**
   * The conversation thread id (read-only) — live transport's if attached,
   * else the last captured value. `undefined` before the first turn.
   * @returns {string|undefined}
   */
  get threadId() { return this._transport ? (this._transport.threadId ?? this._threadId) : this._threadId; }

  /**
   * The live transport instance (read-only) — `KalturaAvatarSession` or
   * `KalturaChatSession`, `null` when none is attached. Use it for
   * mode-specific APIs (mic, `interrupt()`, disclosure, `videoEl`, …) and
   * rewire such listeners on each `transportChanged` event.
   * @returns {object|null}
   */
  get transport() { return this._transport; }

  // ─────────────────────────── internals ───────────────────────────

  /** @param {'avatar'|'chat'} mode */
  _buildTransport(mode) {
    const shared = {
      token: this._token,
      requestVars: this._requestVars,
      threadId: this._threadId,
      logger: this._cfg.logger,
      onAuditEvent: this._cfg.onAuditEvent,
      subjectId: this._cfg.subjectId,
      partnerId: this._cfg.partnerId,
      allowInsecureTransport: this._cfg.allowInsecureTransport,
    };
    const factory = this._cfg.transportFactories?.[mode];
    if (mode === 'avatar') {
      const merged = { ...shared, ...(this._cfg.avatar || {}) };
      return factory ? factory(merged) : new KalturaAvatarSession(merged);
    }
    const merged = { ...shared, ...(this._cfg.chat || {}) };
    return factory ? factory(merged) : new KalturaChatSession(merged);
  }

  /** Wire the forwarding bridge + tool registry onto a fresh transport. @param {object} t */
  _attach(t) {
    this._transport = t;
    for (const ev of FORWARDED_EVENTS) {
      const fwd = (payload) => this.emit(ev, payload);
      t.on(ev, fwd);
      this._detachFns.push(() => t.off(ev, fwd));
    }
    // Transport death (socket drop, server end) while we think we're live is a
    // facade-level failure; a teardown WE initiated never reaches this handler
    // (the bridge is detached first).
    const onEnded = (payload) => {
      if (this.state === 'connected') this._setState('failed', 'transport_failed');
      this.emit('ended', payload || {});
    };
    t.on('ended', onEnded);
    this._detachFns.push(() => t.off('ended', onEnded));
    for (const list of this._toolRegistry.values()) for (const entry of list) entry.rebind(t);
    this.emit('transportChanged', { mode: this._mode, transport: t });
  }

  /** Detach the bridge, unbind tool handlers, disconnect and drop the transport. */
  _teardownTransport() {
    for (const fn of this._detachFns.splice(0)) { try { fn(); } catch { /* listener already gone */ } }
    for (const list of this._toolRegistry.values()) for (const entry of list) entry.rebind(null);
    const t = this._transport;
    this._transport = null;
    if (t) { try { t.disconnect(); } catch (e) { this._cfg.logger?.('warn', 'transport disconnect threw', e); } }
  }

  /** @param {string} where */
  _requireConnected(where) {
    if (this.state !== 'connected') throw new KalturaError({ type: 'about:blank', title: 'not connected', code: 'invalid_state', detail: `${where}() requires a connected session (state="${this.state}").` });
  }

  /** @param {'idle'|'connecting'|'connected'|'switching'|'closed'|'failed'} s @param {string} [reason] */
  _setState(s, reason) { this.state = s; this.emit('stateChange', reason ? { state: s, reason } : { state: s }); }
}
