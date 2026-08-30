/**
 * KalturaChatSession — the text-only conversation transport.
 *
 * Talks to the SAME brain and the SAME thread as `KalturaAvatarSession`,
 * over plain HTTPS instead of a socket + WebRTC: each `sendText()` turn is one
 * `POST /assistant/converse` NDJSON stream, authenticated with the same
 * conversation KS. No mic, no camera, no video element, no socket.io — this
 * module never imports getUserMedia, WHEP, or a socket factory, so a chat-only
 * page ships none of that and never triggers a permission prompt.
 *
 * Feature parity with the avatar transport where the wire allows it:
 *   - `request_vars` / `setDynamicPrompt` — same canonical-map merge semantics;
 *     the full map rides EVERY turn (HTTP has no join to persist it).
 *   - client-side commands — `onToolCall` with the same per-turn semantic dedup,
 *     schema check, and fused-segment recovery as the live socket.
 *   - `waitForResponse:true` tools — `respondToTool()` POSTs the same
 *     `/assistant/tool_response` ACK with the same KS; because segments are
 *     parsed MID-STREAM, the brain unblocks and finishes the SAME turn.
 *   - thread continuity — seed `cfg.threadId` with another session's
 *     `threadId` getter to continue that conversation here (works both
 *     directions, avatar ⇄ chat).
 *
 * Emits the transport-agnostic event subset (`transcript`, `turnStart`,
 * `turnEnd`, `toolCall`, `toolCallResult`, `toolCallInvalid`, `stateChange`,
 * `responsePending`, `responseSettled`, `brainStalled`, `warning`, `error`,
 * `ended`) with the same payload shapes as `KalturaAvatarSession`, so app code
 * written against the events works unchanged when `KalturaAgentSession` swaps
 * transports.
 *
 * ZERO runtime deps; `fetch` is injectable for tests (default global fetch).
 */
import { Emitter } from './emitter.js';
import { assertRequestVars, remapConverseError } from '../management/conversations.js';
import { validateCapabilities } from '../management/capabilities.js';
import { inspectKs } from '../management/ks-inspect.js';
import { KalturaError, errorFromResponse } from '../core/errors.js';
import { makeAuditEmitter } from '../core/session.js';
import { sanitizeJson } from '../core/safety.js';
import { assertSecureTransport } from '../core/transport-guard.js';
import { randId } from '../core/ids.js';
import {
  parseConverseStream, parseToolCall, parseToolResponseName, canonicalJson,
  validateToolArgs, SPOKEN_TYPES,
} from '../core/stream.js';

// A bare `keepalive` segment (Genie pinging a still-open-but-otherwise-quiet stream)
// is not perceivable output — it must not settle the "thinking" signal or the
// brain-stall watchdog below, the exact peer of KalturaAvatarSession excluding
// `think` from the same two gates. Without this, the FIRST keepalive ping (which
// can repeat forever if the backend call it's waiting on is stuck) silently
// turns off "thinking" and never signals anything else — dead air with no warning.
const NON_PERCEIVABLE_TYPES = new Set(['think', 'keepalive']);

const DEFAULT_GENIE_URL = 'https://genie.nvp1.ovp.kaltura.com';

// Same backstop as KalturaAvatarSession (see its PENDING_TOOL_ACK_MAX_AGE_MS
// doc): well above the largest client({timeout}) bound the server could still
// be waiting on, so sweeping an entry never races a live server-side wait.
const PENDING_TOOL_ACK_MAX_AGE_MS = 10 * 60_000;

export class KalturaChatSession extends Emitter {
  /**
   * @param {object} cfg
   * @param {string|{ks:string}} cfg.token CONVERSATION KS (raw string or a minted Token object) — same token kind the avatar transport uses.
   * @param {string} [cfg.genieUrl] Genie base URL (default production).
   * @param {string} [cfg.threadId] Seed thread id — pass another session's `threadId` to continue that conversation.
   * @param {Record<string, string|number|boolean|null>} [cfg.requestVars] Initial `{{var}}` request_vars map (validated now; rides every turn).
   * @param {Record<string, 'on'|'off'>} [cfg.capabilities] Per-request capability overrides (validated now; sent verbatim on every turn). Omit to use the intellect's configured defaults.
   * @param {typeof fetch} [cfg.fetch] Injectable fetch (default global) — for tests/instrumentation.
   * @param {(level:string, msg:string, ...rest:any[])=>void} [cfg.logger]
   * @param {(e:object)=>void} [cfg.onAuditEvent] Structured audit hook (same event stream as the avatar transport).
   * @param {string} [cfg.subjectId] Opaque operator-assigned subject id stamped onto audit events (never a name/PHI).
   * @param {string|number} [cfg.partnerId] Override for the audit partner id (else read from a plaintext token, if possible).
   * @param {boolean} [cfg.allowInsecureTransport] Localhost/dev only — allow an http:// genieUrl (loud warning).
   * @param {() => number} [cfg.now] Injectable clock (deterministic tests).
   * @param {number} [cfg.brainStallMs] How long to wait for perceivable output before emitting a
   *   repeating `brainStalled` warning — the exact peer of `KalturaAvatarSession`'s watchdog (same
   *   event shape `{afterMs, count}`, same default, same "warn forever, never cancel the turn"
   *   behavior — a tool-call turn or a stuck backend call can legitimately run long). Default 12000.
   */
  constructor(cfg) {
    super();
    if (!cfg || !cfg.token) throw new KalturaError({ type: 'about:blank', title: 'token required', code: 'bad_request', detail: 'new KalturaChatSession({ token }) needs a conversation KS.' });
    this._log = cfg.logger || (() => {});
    this._warned = new Set();
    const raw = typeof cfg.token === 'object' && typeof cfg.token.ks === 'string' ? cfg.token.ks : cfg.token;
    if (typeof raw !== 'string' || !raw) throw new KalturaError({ type: 'about:blank', title: 'token required', code: 'bad_request', detail: 'token must be a KS string or a { ks } object.' });
    // Token is a secret: store it non-enumerable so it can't be JSON.stringify'd /
    // console.logged off the instance by accident (same posture as KalturaAvatarSession).
    Object.defineProperty(this, '_token', { value: raw, writable: true, enumerable: false, configurable: true });
    this._genieUrl = (cfg.genieUrl || DEFAULT_GENIE_URL).replace(/\/$/, '');
    assertSecureTransport(this._genieUrl, 'genieUrl', !!cfg.allowInsecureTransport, (m) => this._warnOnce('insecure-genie', m));
    // Canonical request_vars map for the whole session — validated up front so a
    // bad value fails at construction, not silently at the first turn.
    this._requestVars = assertRequestVars(cfg.requestVars, 'KalturaChatSession requestVars');
    if (cfg.capabilities !== undefined) validateCapabilities(cfg.capabilities, 'KalturaChatSession capabilities');
    this._capabilities = cfg.capabilities;
    { const f = cfg.fetch || globalThis.fetch; this._fetch = typeof f === 'function' ? f.bind(globalThis) : f; }
    this._threadId = cfg.threadId;
    this._lastMessageId = undefined;
    const info = inspectKs(raw);
    this._partnerId = cfg.partnerId !== undefined ? String(cfg.partnerId) : (info.partnerId || '');
    this._subjectId = cfg.subjectId != null ? String(cfg.subjectId) : null;
    this._audit = makeAuditEmitter(cfg.onAuditEvent, this._partnerId, 'ovp/chat-session', this._subjectId);
    this._now = cfg.now || (() => Date.now());
    // Tool-dispatch state — same semantics as KalturaAvatarSession (per-turn
    // semantic dedup, schema map, fused-blob recovery, bounded pending-ACK map).
    this._toolCallHandlers = new Map();
    this._toolCallSchemas = new Map();
    this._firedToolCalls = new Set();
    this._turnDispatchedToolNames = new Set();
    this._pendingFusedBlobs = [];
    this._pendingToolAcks = new Map();
    this._sessionGen = 0;
    this._turnChain = Promise.resolve();   // serializes sendText turns (one converse at a time)
    this._activeTurnAbort = null;
    this._brainStallMs = cfg.brainStallMs ?? 12000;
    this._brainStallTimer = null;
    this._brainStallFireCount = 0;
    /** @type {'idle'|'connected'|'closed'} */
    this.state = 'idle';
  }

  /**
   * Mark the session live. No network happens here — a chat turn is a plain
   * HTTPS request, so there is nothing to pre-establish; this exists for
   * transport-interface parity (KalturaAgentSession drives every transport
   * through the same connect → send → disconnect lifecycle). Throws typed
   * `invalid_state` if the session is already connected or closed — construct
   * a new KalturaChatSession to start over.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.state !== 'idle') {
      throw new KalturaError({ type: 'about:blank', title: 'already started', code: 'invalid_state', detail: `connect() is only valid once, from state "idle" (state="${this.state}") — construct a new KalturaChatSession to reconnect.` });
    }
    this._setState('connected');
  }

  /**
   * Send one user text turn and stream the reply. Turns are serialized: a
   * second sendText() awaits the previous turn's stream end. Segments are
   * processed MID-STREAM, so an `onToolCall` handler that calls
   * {@link respondToTool} unblocks a `waitForResponse:true` brain within the
   * same turn.
   *
   * Events fired during the turn: `transcript` (`{text, type:'user'}`) for the
   * sent text, `turnStart`/`responsePending` at dispatch, `transcript`
   * (`{text, type:'final'}`) per spoken segment, `toolCall`/`toolCallResult`/
   * `toolCallInvalid` per client command, then `responseSettled`/`turnEnd`.
   *
   * The intellect's `allow_client_variables` gate being OFF is a SILENT
   * failure on this path too: the turn resolves with empty
   * `text` and zero segments — no error reaches the wire. Like the live
   * socket, the session detects it and emits a once-per-session `warning`
   * (`code: 'empty_turn_with_request_vars'`, var KEYS only, never values).
   * @param {string} text
   * @param {{signal?: AbortSignal}} [opts] Abort cancels the in-flight turn.
   * @returns {Promise<{text:string, threadId:string|undefined, messageId:string|undefined, segments:object[]}>}
   *   The collected turn — `text` is the concatenated spoken/visible prose.
   */
  async sendText(text, opts = {}) {
    this._requireConnected('sendText');
    if (typeof text !== 'string' || !text.trim()) throw new KalturaError({ type: 'about:blank', title: 'bad sendText', code: 'bad_request', detail: 'sendText(text) needs a non-empty string.' });
    const run = () => this._converseTurn(text, opts);
    const turn = this._turnChain.then(run, run);
    // Keep the chain alive after a failed turn (the failure still rejects `turn` for the caller).
    this._turnChain = turn.then(() => {}, () => {});
    return turn;
  }

  /** @param {string} text @param {{signal?: AbortSignal}} opts */
  async _converseTurn(text, opts) {
    this._requireConnected('sendText');   // re-check: state may have changed while queued
    const gen = this._sessionGen;
    const turnId = randId(12);
    const ac = new AbortController();
    this._activeTurnAbort = ac;
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    // New turn: reset the per-turn dedup state (same reset points as the live socket).
    this._firedToolCalls.clear();
    this._turnDispatchedToolNames.clear();
    this._pendingFusedBlobs = [];
    this.emit('transcript', { text, type: 'user', speechId: null, words: [] });
    this.emit('turnStart', { speechId: null, turnId, isNewTurn: true });
    this.emit('responsePending', {});
    this._armBrainWatchdog();
    const body = { userMessage: text, sse: false };
    if (this._threadId) body.threadId = this._threadId;
    if (this._requestVars && Object.keys(this._requestVars).length) body.request_vars = this._requestVars;
    if (this._capabilities !== undefined) body.capabilities = this._capabilities;
    let collectedText = '';
    const segments = [];
    let settled = false;
    const settle = () => { if (!settled) { settled = true; this.emit('responseSettled', {}); } };
    try {
      const stream = await this._converseFetch(body, ac.signal);
      for await (const seg of parseConverseStream(stream)) {
        if (!(seg.type && NON_PERCEIVABLE_TYPES.has(seg.type))) settle();
        // Watchdog clears ONLY on segments a caller can actually perceive — spoken content or a
        // GenUI widget. `tool`/`tool_response`/`think`/`keepalive` never clear it, so a tool-only
        // spiral (or a stuck backend call pinging bare keepalives) still surfaces `brainStalled`.
        if (seg.type && (SPOKEN_TYPES.has(seg.type) || seg.type === 'unisphere-tool')) this._clearBrainWatchdog();
        segments.push(seg);
        if (seg.threadId && !this._threadId) this._threadId = seg.threadId;
        if (seg.messageId && !this._lastMessageId) this._lastMessageId = seg.messageId;
        const call = parseToolCall(seg);
        if (call) this._dispatchToolCall(call);
        else this._recoverFusedToolResponse(parseToolResponseName(seg));
        if (seg.type && SPOKEN_TYPES.has(seg.type) && typeof seg.content === 'string' && seg.content) {
          collectedText += seg.content;
          this.emit('transcript', { text: seg.content, type: 'final', speechId: null, words: [] });
        }
      }
      this._audit('turn.converse', 'success', { action: 'sendText' });
      if (!segments.length) this._checkEmptyTurn();
      return { text: collectedText, threadId: this._threadId, messageId: this._lastMessageId, segments };
    } catch (e) {
      const err = remapConverseError(e instanceof KalturaError ? e : new KalturaError({ type: 'about:blank', title: 'converse failed', code: ac.signal.aborted ? 'aborted' : 'network_error', detail: String(e && e.message || e) }));
      this._audit('turn.converse', 'fail', { action: 'sendText', reason: err.code });
      // A disconnect() mid-turn already emitted 'ended'; don't double-report through 'error'.
      if (gen === this._sessionGen) this.emit('error', err);
      throw err;
    } finally {
      settle();
      this._clearBrainWatchdog();
      this._activeTurnAbort = null;
      this.emit('turnEnd', { speechId: null, turnId });
    }
  }

  /** POST /assistant/converse and return the raw NDJSON body stream (typed error on non-2xx). @param {object} body @param {AbortSignal} signal */
  async _converseFetch(body, signal) {
    const res = await this._fetch(`${this._genieUrl}/assistant/converse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `KS ${this._token}` },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const t = await res.text();
      let parsed = t; try { parsed = JSON.parse(t); } catch { /* keep text */ }
      throw errorFromResponse({ status: res.status, path: '/assistant/converse', body: parsed, requestId: res.headers?.get?.('x-request-id') || '' });
    }
    if (!res.body) throw new KalturaError({ type: 'about:blank', title: 'no stream body', code: 'server_error', detail: 'converse response had no readable body.' });
    return res.body;
  }

  /**
   * Register a handler for an AGENT-initiated client-side command — the exact
   * peer of `KalturaAvatarSession.onToolCall` (same dedup, same optional
   * dispatch-time `argsSchema` check, same `toolCallResult`/`toolCallInvalid`
   * re-emits; see that method's doc for the full contract). Returns unsubscribe.
   * @param {string} name
   * @param {(args:object, call:{name:string,args:object,raw:string})=>unknown} handler
   * @param {Record<string, import('../core/stream.js').ToolArgSchema>} [argsSchema]
   * @returns {() => void}
   */
  onToolCall(name, handler, argsSchema) {
    if (typeof name !== 'string' || !name.trim()) throw new KalturaError({ type: 'about:blank', title: 'bad onToolCall', code: 'bad_request', detail: 'onToolCall(name, handler) needs a non-empty tool name.' });
    if (typeof handler !== 'function') throw new KalturaError({ type: 'about:blank', title: 'bad onToolCall', code: 'bad_request', detail: 'onToolCall(name, handler) needs a handler function.' });
    const key = name.trim();
    const list = this._toolCallHandlers.get(key) || [];
    list.push(handler);
    this._toolCallHandlers.set(key, list);
    if (argsSchema && typeof argsSchema === 'object') this._toolCallSchemas.set(key, argsSchema);
    return () => { const l = this._toolCallHandlers.get(key); if (!l) return; const i = l.indexOf(handler); if (i >= 0) l.splice(i, 1); if (!l.length) { this._toolCallHandlers.delete(key); this._toolCallSchemas.delete(key); } };
  }

  /**
   * ACK a `wait_for_response:true` client tool call — the exact peer of
   * `KalturaAvatarSession.respondToTool` (same `/assistant/tool_response`
   * POST, same KS auth, same graceful `{ok:false, reason:'unknown_or_stale'}`
   * degradation; see that method's doc for the full contract). Because chat
   * segments are parsed mid-stream, calling this from an `onToolCall` handler
   * unblocks the brain within the SAME turn.
   * @param {string} id `call.toolMetadata.id` from the tool call being acknowledged.
   * @param {object} response JSON-serializable result (plain object).
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async respondToTool(id, response) {
    this._requireConnected('respondToTool');
    if (typeof id !== 'string' || !id) throw new KalturaError({ type: 'about:blank', title: 'bad respondToTool', code: 'bad_request', detail: 'respondToTool(id, response) needs a non-empty id — pass call.toolMetadata.id from the tool call being acknowledged.' });
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new KalturaError({ type: 'about:blank', title: 'bad respondToTool', code: 'bad_request', detail: 'respondToTool response must be a plain JSON object (the backend 422s on a non-dict body).' });
    const pending = this._pendingToolAcks.get(id);
    if (!pending || this._now() - pending.at > PENDING_TOOL_ACK_MAX_AGE_MS) {
      this._pendingToolAcks.delete(id);
      this._audit('tool.ack', 'fail', { reason: 'unknown_or_stale' });
      return { ok: false, reason: 'unknown_or_stale' };
    }
    const gen = this._sessionGen;
    // tool_invocation_id: second required field, same id echoed under both keys (the backend 422s without it).
    await this._fetch(`${this._genieUrl}/assistant/tool_response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `KS ${this._token}` },
      body: JSON.stringify({ tool_name: pending.name, tool_id: id, tool_invocation_id: id, response: sanitizeJson(response) }),
    });
    this._pendingToolAcks.delete(id);
    if (gen !== this._sessionGen) { this._audit('tool.ack', 'fail', { reason: 'session_rebuilt' }); return { ok: false, reason: 'session_rebuilt' }; }
    this._audit('tool.ack', 'success', { action: pending.name });
    return { ok: true };
  }

  /**
   * Inject a structured context payload as the `page_context` request var —
   * the exact peer of `KalturaAvatarSession.setDynamicPrompt` (sugar over
   * {@link updateRequestVars}; pair with the `PAGE_CONTEXT_PROMPT` preset).
   * Takes effect on the NEXT sendText() turn (HTTP has no mid-turn push).
   * @param {object} data JSON-serializable context object.
   */
  setDynamicPrompt(data) {
    this._requireConnected('setDynamicPrompt');
    // Object-injection scrub, NOT prompt-injection defense — same caveat as the avatar peer.
    this._requestVars = { ...(this._requestVars || {}), page_context: JSON.stringify(sanitizeJson(data) ?? null) };
  }

  /**
   * MERGE new `{{var}}` request_vars into the session's canonical map — the
   * exact peer of `KalturaAvatarSession.updateRequestVars` (same validation,
   * same merge semantics; see that method's doc). The full merged map rides
   * every subsequent sendText() turn.
   * @param {Record<string, string|number|boolean|null>} vars
   */
  updateRequestVars(vars) {
    this._requireConnected('updateRequestVars');
    const checked = assertRequestVars(vars, 'updateRequestVars');
    this._requestVars = { ...(this._requestVars || {}), ...(checked || {}) };
  }

  /**
   * End the session. Idempotent: safe to call from any state, repeat calls
   * no-op. Aborts an in-flight turn, clears pending tool ACKs, and drops the
   * token. Terminal — construct a new KalturaChatSession to talk again.
   */
  disconnect() {
    if (this.state === 'closed') return;
    this._sessionGen++;
    this._clearBrainWatchdog();
    this._activeTurnAbort?.abort();
    this._pendingToolAcks.clear();
    this._token = null;   // don't hold the secret past the session
    this._audit('session.disconnect', 'success', {});
    this._setState('closed');
    this.emit('ended', { reason: 'disconnected' });
  }

  /**
   * The conversation thread id (read-only). `undefined` until the server
   * assigns one on the first turn, unless seeded via `cfg.threadId`. Hand this
   * to another transport (e.g. a `KalturaAvatarSession`) to continue the same
   * conversation there.
   * @returns {string|undefined}
   */
  get threadId() { return this._threadId; }

  /** The partner id this session was constructed with/inferred (read-only). @returns {string} */
  get partnerId() { return this._partnerId; }

  // ─────────────────────────── internals ───────────────────────────

  /** Same per-turn dispatch semantics as KalturaAvatarSession._dispatchToolCall (semantic dedup, schema gate, fused-blob queue, pending-ACK tracking). @param {{name:string,args:object,raw:string,fusedArgs?:object[],toolMetadata?:{id:string,waitForResponse?:boolean}}} call @returns {boolean} */
  _dispatchToolCall(call) {
    if (!call || typeof call.name !== 'string') return false;
    const key = `${call.name}:${canonicalJson(call.args || {})}`;
    if (this._firedToolCalls.has(key)) return false;   // already handled this turn
    this._firedToolCalls.add(key);
    this._turnDispatchedToolNames.add(call.name);
    if (Array.isArray(call.fusedArgs) && call.fusedArgs.length) this._pendingFusedBlobs.push(...call.fusedArgs);
    if (call.toolMetadata?.waitForResponse && call.toolMetadata.id) {
      this._sweepStalePendingToolAcks();
      this._pendingToolAcks.set(call.toolMetadata.id, { name: call.name, at: this._now() });
    }
    const schema = this._toolCallSchemas.get(call.name);
    if (schema) {
      const check = validateToolArgs(call.args, schema);
      if (!check.ok) {
        this._audit('tool.invoke', 'fail', { action: call.name, client: true, reason: 'invalid_args' });
        this.emit('toolCallInvalid', { call, errors: check.errors });
        return true;
      }
    }
    this._audit('tool.invoke', 'success', { action: call.name, client: true });
    this.emit('toolCall', call);
    const handlers = this._toolCallHandlers.get(call.name);
    if (handlers) for (const h of handlers.slice()) {
      let result;
      try { result = h(call.args, call); }
      catch (e) { this._log('error', `onToolCall("${call.name}") handler threw`, e); this.emit('toolCallResult', { call, ok: false, error: e }); continue; }
      if (result && typeof (/** @type {any} */ (result)).then === 'function') {
        /** @type {Promise<unknown>} */ (result).then(
          (value) => { if (value !== undefined) this.emit('toolCallResult', { call, ok: true, value }); },
          (error) => { this._log('error', `onToolCall("${call.name}") handler rejected`, error); this.emit('toolCallResult', { call, ok: false, error }); },
        );
      } else if (result !== undefined) {
        this.emit('toolCallResult', { call, ok: true, value: result });
      }
    }
    return true;
  }

  /** Fused-segment blob recovery — same order-based attribution as the avatar peer. @param {string|null} name */
  _recoverFusedToolResponse(name) {
    if (!name || !this._pendingFusedBlobs.length || this._turnDispatchedToolNames.has(name)) return;
    const args = this._pendingFusedBlobs.shift();
    this._dispatchToolCall({ name, args, raw: `${name} ${canonicalJson(args)}` });
  }

  /** Age-sweep the pending-ACK map so it self-bounds (same rule as the avatar peer). */
  _sweepStalePendingToolAcks() {
    const now = this._now();
    for (const [id, pending] of this._pendingToolAcks) {
      if (now - pending.at > PENDING_TOOL_ACK_MAX_AGE_MS) this._pendingToolAcks.delete(id);
    }
  }

  /** @param {string} where */
  _requireConnected(where) {
    if (this.state !== 'connected') throw new KalturaError({ type: 'about:blank', title: 'not connected', code: 'invalid_state', detail: `${where}() requires a connected session (state="${this.state}").` });
  }

  /** @param {string} key @param {string} msg */
  _warnOnce(key, msg) { if (!this._warned.has(key)) { this._warned.add(key); this._log('warn', '[security] ' + msg); } }

  /**
   * Diagnose the silent-empty-turn failure mode — the exact peer of
   * `KalturaAvatarSession._checkEmptyTurn`, confirmed on THIS path too:
   * with the intellect's `allow_client_variables` gate OFF, a converse turn
   * that sends request variables resolves with zero segments and NO error —
   * the 403 is raised server-side after the response stream has already
   * opened, so it never reaches the wire. Emits a typed `warning`
   * (`code: 'empty_turn_with_request_vars'`, var KEYS only — never values)
   * at most once per session. A single empty turn can be benign, so this is
   * a diagnostic, never an error.
   */
  _checkEmptyTurn() {
    const keys = Object.keys(this._requestVars || {});
    if (!keys.length || this._warned.has('empty-turn-request-vars')) return;
    this._warned.add('empty-turn-request-vars');
    this._log('warn', `turn ended with no output while request variables were sent (keys: ${keys.join(', ')}) — if this repeats, the intellect's allow_client_variables gate is likely OFF (this failure is silent; no error is returned). Enable it via intellects.setClientVariablesEnabled(id, true).`);
    this.emit('warning', {
      code: 'empty_turn_with_request_vars',
      message: 'Turn produced no output while request variables were sent — likely allow_client_variables is off on the intellect (a silent failure; the server returns no error).',
      requestVarKeys: keys,
    });
  }

  /** @param {'idle'|'connected'|'closed'} s */
  _setState(s) { this.state = s; this.emit('stateChange', { state: s }); }

  // ─────────────────────────── brain-liveness watchdog ───────────────────────────
  // The exact peer of KalturaAvatarSession's `_armBrainWatchdog`/`_clearBrainWatchdog`
  // (same event shape, same "warn forever, never cancel" behavior — a long tool-call
  // turn or a slow backend call can legitimately outlast several fire cycles).

  /** Arm the watchdog at turn start; fires `brainStalled` repeatedly (every `_brainStallMs`) until cleared by perceivable output. */
  _armBrainWatchdog() {
    if (!this._brainStallMs) return;
    this._clearBrainWatchdog();
    const fire = () => {
      if (this.state !== 'connected') return;
      this._brainStallFireCount++;
      this.emit('brainStalled', { afterMs: this._brainStallMs, count: this._brainStallFireCount });
      this._brainStallTimer = setTimeout(fire, this._brainStallMs);
    };
    this._brainStallTimer = setTimeout(fire, this._brainStallMs);
  }
  /** Stop the watchdog (real output arrived, or the turn/session ended). */
  _clearBrainWatchdog() { if (this._brainStallTimer) { clearTimeout(this._brainStallTimer); this._brainStallTimer = null; } this._brainStallFireCount = 0; }
}
