/**
 * KalturaAvatarSession — the live interactive avatar runtime as one class.
 *
 * Wraps the conversation-manager Socket.IO control plane + the two WebRTC peer
 * connections (ASR mic uplink, STV WHEP video downlink) behind a typed event
 * surface and a small method set. Implements the documented connect machine
 * (WIRE-PROTOCOL §3, steps 0–11), the `speechId` barge-in guard (§4f), the
 * caption-follows-audio rule (§4d), capacity polling (§4b), and the
 * greeting-clip fix (approve only after STV video is playable, §3 step 10–11).
 *
 * ZERO runtime deps. Everything platform-specific is INJECTED:
 *   - socketFactory(url, opts) → a socket.io-compatible client ({on,emit,disconnect,id})
 *   - rtcConstructor (default globalThis.RTCPeerConnection)
 *   - fetch (default globalThis.fetch) — for the WHEP POST
 *   - getUserMedia (default navigator.mediaDevices.getUserMedia) — for the mic
 *   - videoEl — an HTMLVideoElement (or playable-shim in tests) for the downlink
 * So the whole machine is unit-testable in plain Node with fakes — no browser.
 *
 * The constructor REFUSES a token carrying `disableentitlement`: an end-user
 * runtime must keep entitlement ON (the two-KS-type invariant).
 */
import { Emitter } from './emitter.js';
import { TranscriptTracker } from './transcript.js';
import {
  turnServers, iceConfig, buildJoin, buildStvNewSession, whepUrl, whepUrlHasPrivateIp,
  buildTextEntered, isAudioMode, CAPACITY_BACKOFF, DEFAULT_CM_URL, classifyAgentAction,
} from './wire.js';
import { inspectKs } from '../management/ks-inspect.js';
import { assertRequestVars } from '../management/conversations.js';
import { KalturaError } from '../core/errors.js';
import { redact } from '../core/redact.js';
import { randId } from '../core/ids.js';
import { makeAuditEmitter } from '../core/session.js';
import { sanitizeJson, clampInbound } from '../core/safety.js';
import { SPOKEN_TYPES, canonicalJson, SPIRAL_RECOVERY_PREFIX, validateToolArgs, parseToolResponseName } from '../core/stream.js';
import { isPrivateOrLoopbackHost } from '../core/net-guard.js';

const DEFAULT_GENIE_URL = 'https://genie.nvp1.ovp.kaltura.com';

// Backstop for a pending tool-ACK entry the app never acknowledges:
// `_dispatchToolCall`/`respondToTool` clear entries on ACK/disconnect/cold-reconnect,
// but a session that stays connected indefinitely with a caller that simply never calls
// `respondToTool()` for some id would otherwise retain that entry forever. Well above the
// largest `client({timeout})` bound (120s, `tools.js`) the server itself could still be
// waiting on, so this only ever sweeps entries the backend has certainly already given up on.
const PENDING_TOOL_ACK_MAX_AGE_MS = 10 * 60_000;

// `joinRoom` covers `clientConfiguration` (fast — the CM has it in hand). `joinComplete`
// gets its OWN, longer budget (`joinComplete`) because the CM only emits it AFTER an
// awaited context-update call (a Genie thread-init round-trip for analytics), which can
// exceed 5s under load — a 5s cap here surfaced a confusing JoinRoomTimeout while join was
// about to complete. Still bounded by `overall`.
const TIMEOUTS = { overall: 30000, serverConnect: 10000, joinRoom: 5000, joinComplete: 20000, agent: 10000, asr: 30000 };

// How long to wait in 'reconnecting' for Socket.IO connection-state recovery before
// giving up. The server's recovery window is ~20s (CONNECTION_STATE_RECOVERY_TIMEOUT);
// we wait a touch longer so a genuine same-pod recovery isn't cut off, then end cleanly
// (never a silent hang). Overridable via cfg.reconnectWindowMs.
const RECONNECT_WINDOW_MS = 22000;

// Media (WebRTC) ICE states that mean the peer is in trouble. 'disconnected' is often
// transient (ICE may self-heal); 'failed' is terminal for that connection and needs an
// ICE restart / re-negotiation. We act on both, escalating from restart → rebuild.
const ICE_DOWN = new Set(['failed', 'disconnected']);

// Socket.IO disconnect reasons the server treats as RECOVERABLE (connection-state recovery,
// same-pod, ≤20s) — verified in conversation-manager socket-constants.ts. Any other reason
// (io server/client disconnect, namespace disconnect) is a real end, no recovery.
const RECOVERABLE_DISCONNECT = new Set(['transport error', 'transport close', 'forced close', 'ping timeout']);

// Default WebRTC mic constraints (the standard browser-native Tier-1 baseline for
// suppressing echo, background noise, and gain issues ahead of any enhanced DSP
// stage). See cfg.micConstraints.
const DEFAULT_MIC_CONSTRAINTS = Object.freeze({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });

/** Socket error events → stable SDK codes (WIRE-PROTOCOL §4b). */
const FATAL_CODE = {
  throwToNoAgent: { code: 'capacity_unavailable', num: 6001, retry: true },
  throwToExceededTier: { code: 'tier_exceeded', num: 6002, retry: false },
  throwToBadRequest: { code: 'bad_request', num: 400, retry: false },
  removePeer: { code: 'peer_removed', num: 401, retry: false },
  unsupportedClient: { code: 'unsupported_client', num: 0, retry: false },
};

export class KalturaAvatarSession extends Emitter {
  /**
   * @param {object} cfg
   * @param {string} cfg.token              Enriched conversation KS from appInit (entitlement ON). THROWS if it carries disableentitlement.
   * @param {string} [cfg.conversationManagerUrl] From appInit (default the US prod host).
   * @param {string} [cfg.genieUrl]         Genie host for `respondToTool()`'s direct ACK POST (default `https://genie.nvp1.ovp.kaltura.com`, matching `Management`'s own default).
   * @param {string} cfg.srsBaseUrl         From appInit (WHEP egress host).
   * @param {string} cfg.turnServerUrl      From appInit (TURN host).
   * @param {(url:string,opts:object)=>any} cfg.socketFactory  socket.io-compatible factory (INJECTED; never bundled).
   * @param {any} [cfg.videoEl]             HTMLVideoElement for the downlink (omit ⇒ audio/headless).
   * @param {typeof RTCPeerConnection} [cfg.rtcConstructor]
   * @param {typeof fetch} [cfg.fetch]
   * @param {()=>Promise<any>} [cfg.getUserMedia]
   * @param {object|false} [cfg.micConstraints]  Browser-native `MediaTrackConstraints` merged into every `getUserMedia({audio})` call this session makes (`connect()`, `switchMic()`). Default `{echoCancellation:true, noiseSuppression:true, autoGainControl:true}` — the standard Tier-1 browser-native baseline. Pass `false` to send bare `audio:true` (e.g. when `cfg.noiseProcessor` expects RAW, unprocessed audio — stacking browser-native suppression under a second DSP stage double-processes the signal and can degrade quality). Pass a partial object to override individual fields.
   * @param {(stream:any)=>Promise<any>} [cfg.noiseProcessor]  Pluggable, externally-supplied DSP hook (BYO — a third-party lib's processor or a bespoke one; the SDK core bundles none). Called with the raw `MediaStream` from `getUserMedia` at `connect()` and every `switchMic()`; must return a `MediaStream` (or the same one, unmodified) whose audio track is what actually reaches the ASR uplink. Errors propagate as a `noise_processor_failed` KalturaError (mic acquisition fails closed, same as a `getUserMedia` rejection) — a processor must not silently swallow its own setup failure. See `./experience/noise-suppressor` for a ready-made `AudioWorklet`-based implementation of this interface.
   * @param {string} [cfg.threadId]         Resume a prior conversation's memory.
   * @param {string} [cfg.partnerId]
   * @param {boolean} [cfg.isFirefox]       Forces ICE policy 'all' on both channels.
   * @param {string} [cfg.disclosureText]   AI-disclosure text emitted before any avatar speech (EU AI Act Art. 50).
   * @param {boolean} [cfg.requireDisclosureAck]  Gate the first turn on acknowledgeDisclosure() (regulated deployments).
   * @param {{username:string,credential:string,expiry?:number}} [cfg.turnCredentials]  Server-minted EPHEMERAL TURN creds (RFC 7635). Preferred over the static fallback.
   * @param {boolean} [cfg.allowInsecureTransport]  Permit ws/http transport (localhost/dev ONLY — emits a loud warning; never in production).
   * @param {(event:object)=>void} [cfg.onAuditEvent]  Redacted structured security events (session.connect/disconnect/auth.fail/protocol.violation). NIST AU-2/AU-3.
   * @param {string} [cfg.preferredVideoCodec]  Force a specific codec for the STV downlink via `setCodecPreferences` (e.g. `'VP8'`, `'H264'`, `'VP9'`, `'AV1'`). Falls back silently to the browser default if the codec isn't in `RTCRtpReceiver.getCapabilities('video')`.
   * @param {number} [cfg.maxAsrBitrateKbps]  Cap the ASR mic uplink's bitrate via `setParameters()` (applied to the audio sender). Adjustable mid-session via `setAsrBandwidth()`.
   * @param {typeof RTCRtpReceiver} [cfg.rtcRtpReceiverConstructor]
   * @param {number} [cfg.statsIntervalMs]  Poll `RTCPeerConnection.getStats()` on both channels at this interval and emit `connectionQuality` (RTT/packet-loss/jitter/bitrate) — a portable connectivity beacon reporting the raw `getStats()` numbers only, no scoring/telemetry-backend wiring. Unset (default) disables it; a session that never opts in pays zero `getStats()` cost.
   * @param {(level:string,msg:string,data?:unknown)=>void} [cfg.logger]
   * @param {boolean} [cfg.recoverFromSpiral]  After a `tool_spiral_hard_limit` cold reconnect succeeds, auto-resend the abandoned turn (nudged to answer in words only) so the user's question isn't silently dropped — see `_checkHardToolSpiral`/`_coldReconnect`. Default true; set false to only get `toolSpiralRecovering`'s `lastTurnText` and handle the resend yourself.
   * @param {number} [cfg.maxReconnectAttempts]  Passed through as socket.io's own `reconnectionAttempts` (caps its native reconnection engine) AND surfaced as `attempt`/`maxAttempts` on `reconnecting`/`connectivityChanged`. Default 5.
   * @param {number} [cfg.reconnectWindowMs]  Bounds the 'reconnecting' state independent of socket.io's own attempt count — if no recovery lands within this window, the session ends cleanly rather than hanging. Default 22000.
   * @param {Record<string, string|number|boolean|null>} [cfg.requestVars]  Join-time `{{var}}` Jinja values — sent on every `join`/reconnect `buildJoin()` call; validated with the same `assertRequestVars` as {@link updateRequestVars}.
   */
  constructor(cfg) {
    super();
    if (!cfg || !cfg.token) throw new KalturaError({ type: 'about:blank', title: 'token required', code: 'bad_request', detail: 'KalturaAvatarSession needs an enriched conversation token from appInit.' });
    const info = inspectKs(cfg.token);
    if (info.ok && info.disableEntitlement) {
      throw new KalturaError({
        type: 'https://docs.kaltura.com/agentic/errors/entitlement_violation', title: 'entitlement violation', code: 'entitlement_violation',
        detail: 'KalturaAvatarSession refuses a disableentitlement token — the live runtime must keep entitlement ON. Pass the geniegpcid token from appInit.',
      });
    }
    if (typeof cfg.socketFactory !== 'function') throw new KalturaError({ type: 'about:blank', title: 'socketFactory required', code: 'bad_request', detail: 'Inject a socket.io-compatible socketFactory(url, opts) — the SDK never bundles socket.io.' });

    // Diagnostics first (the transport-security checks below warn through these).
    this._log = cfg.logger || (() => {});
    this._warned = new Set();
    // Token is a secret: store it non-enumerable so it can't be JSON.stringify'd /
    // console.logged off the instance by accident (defense in depth + redaction layer).
    Object.defineProperty(this, '_token', { value: cfg.token, writable: true, enumerable: false, configurable: true });
    this._cmUrl = (cfg.conversationManagerUrl || DEFAULT_CM_URL).replace(/\/$/, '');
    this._srsBaseUrl = (cfg.srsBaseUrl || '').replace(/\/$/, '');
    this._genieUrl = (cfg.genieUrl || DEFAULT_GENIE_URL).replace(/\/$/, '');
    // Join-time request_vars — validated up front so a bad value
    // fails at construction, not silently at the first join/reconnect.
    this._requestVars = assertRequestVars(cfg.requestVars, 'KalturaAvatarSession requestVars');
    // Transport-security enforcement (OWASP WSS/TLS; NIST SC-8). Production must use
    // https/wss; localhost/dev may opt out with allowInsecureTransport (loud warning).
    this._allowInsecure = !!cfg.allowInsecureTransport;
    assertSecureTransport(this._cmUrl, 'conversationManagerUrl', this._allowInsecure, (m) => this._warnOnce('insecure-cm', m));
    assertSecureTransport(this._srsBaseUrl, 'srsBaseUrl', this._allowInsecure, (m) => this._warnOnce('insecure-srs', m));
    assertSecureTransport(this._genieUrl, 'genieUrl', this._allowInsecure, (m) => this._warnOnce('insecure-genie', m));
    // Prefer server-minted EPHEMERAL TURN creds (RFC 7635); the static pair is a flagged fallback.
    this._turn = turnServers(cfg.turnServerUrl, cfg.turnCredentials || {});
    if (cfg.turnServerUrl && !cfg.turnCredentials) this._warnOnce('static-turn', 'Using STATIC fallback TURN credentials — pass server-minted ephemeral turnCredentials (from appInit) for production (RFC 7635).');
    this._socketFactory = cfg.socketFactory;
    this._videoEl = cfg.videoEl || null;
    this._RTC = cfg.rtcConstructor || globalThis.RTCPeerConnection;
    this._RTCRtpReceiver = cfg.rtcRtpReceiverConstructor || globalThis.RTCRtpReceiver;
    this._preferredVideoCodec = cfg.preferredVideoCodec || null;
    this._maxAsrBitrateKbps = cfg.maxAsrBitrateKbps ?? null;
    this._statsIntervalMs = cfg.statsIntervalMs ?? null;
    this._statsTimer = null;
    this._prevStats = { asr: null, stv: null };   // {bytes, ts} per channel, for bitrate deltas
    // Bind to globalThis so the native browser `fetch` keeps its receiver — calling
    // an unbound `this._fetch(...)` for the WHEP POST throws "Illegal invocation"
    // (same fix as core/http.js). A user-injected fetch is bound harmlessly.
    { const f = cfg.fetch || globalThis.fetch; this._fetch = typeof f === 'function' ? f.bind(globalThis) : f; }
    this._getUserMedia = cfg.getUserMedia || defaultGetUserMedia;
    // Tier-1 WebRTC constraints baseline (standard browser-native defaults — see cfg.micConstraints doc).
    // `false` opts all the way out (bare audio:true); an object merges over the default.
    this._micConstraints = cfg.micConstraints === false ? false : { ...DEFAULT_MIC_CONSTRAINTS, ...(cfg.micConstraints || {}) };
    // Pluggable Tier-2 DSP hook — BYO processor, never bundled (see cfg.noiseProcessor doc).
    this._noiseProcessor = typeof cfg.noiseProcessor === 'function' ? cfg.noiseProcessor : null;
    this._noiseProcessorStop = null;   // set by _acquireMic() when the processor returns {stream,stop}
    // Client-side VAD (localSpeakingChanged) — lazily activated only while a listener is
    // registered (see on()/off() overrides below), so sessions that never ask for it pay
    // zero AnalyserNode/Web-Audio cost.
    this._vadThreshold = cfg.localVadThreshold ?? 300;
    this._getAudioContext = cfg.getAudioContext || (() => new AudioContext());
    this._MediaStreamCtor = cfg.mediaStreamConstructor || globalThis.MediaStream;
    this._vadCtx = null; this._vadAnalyser = null; this._vadSource = null; this._vadData = null;
    this._vadTimer = null; this._vadTrack = null; this._vadSpeaking = false;
    this._threadId = cfg.threadId;
    this._partnerId = cfg.partnerId !== undefined ? String(cfg.partnerId) : (info.partnerId || '');
    this._isFirefox = !!cfg.isFirefox;
    this._disclosureText = cfg.disclosureText || 'You are speaking with an AI-generated avatar.';
    this._requireDisclosureAck = !!cfg.requireDisclosureAck;
    this._disclosureAcked = false;
    this._pendingApprove = null;
    this._disclosure = null;   // populated at connect; queryable via getDisclosure()
    this._disclosurePending = false;   // set true at connect when requireDisclosureAck blocks speak()
    // Opaque, operator-assigned subject id (HIPAA 164.312(a)(2)(i) unique user id) — stamped
    // onto every audit event so a PHI-channel access ties to an authenticated identity. NEVER
    // the patient's name/PHI (document "opaque id only").
    this._subjectId = cfg.subjectId != null ? String(cfg.subjectId) : null;
    // Crash-safe, redaction-clean structured audit emitter (no-op if no hook). NIST AU-2/AU-3.
    this._audit = makeAuditEmitter(cfg.onAuditEvent, this._partnerId, 'experience', this._subjectId);

    // ── Guardrail / agentic hooks (OWASP LLM01/LLM05/LLM06; Agentic ASI 01/02) ──
    // onBeforeSend(text,ctx): inspect/transform/BLOCK outbound user text before it reaches the
    // brain. Return string→send that, undefined→send unchanged, false/throw→block the turn.
    this._onBeforeSend = typeof cfg.onBeforeSend === 'function' ? cfg.onBeforeSend : null;
    // onAgentAction(action): gate AGENT-initiated actions (navigate/render-genui/lead/vision)
    // before they take effect. Return false/throw→veto. May be sync or async — a returned
    // Promise is awaited before deciding (H4), so `async (action) => false` works correctly.
    this._onAgentAction = typeof cfg.onAgentAction === 'function' ? cfg.onAgentAction : null;
    // Declarative least-privilege policy for what the agent may do (Excessive Agency, LLM06).
    this._agentActions = cfg.agentActions || null;
    // Unbounded-consumption valve (LLM10): cap outbound turns/min. 0/undefined = no cap.
    this._maxTurnsPerMin = cfg.maxTurnsPerMinute ?? 0;
    this._turnTimes = [];
    this._now = cfg.now || (() => Date.now());   // injectable clock (deterministic tests)
    this._debug = cfg.debug || false;            // enable debug-only socket emissions
    // HIPAA 164.312(a)(2)(iii) automatic logoff: tear down after idle. Default ON, generous.
    this._idleTimeoutMs = cfg.idleTimeoutMs ?? 900000;   // 15 min; 0 disables (documented escape hatch)
    this._idleTimer = null; this._idleWarnTimer = null;

    // stickyId pins the session to one conversation-manager pod; persisting it across a
    // reconnect lets Socket.IO connection-state-recovery resume the SAME session (same-pod,
    // ≤20s window — verified in conversation-manager video-calls.ts). Embedders may pass
    // their own (e.g. from sessionStorage) to survive a tab reload.
    this._stickyId = cfg.stickyId || randId(16);
    this._maxReconnect = cfg.maxReconnectAttempts ?? 5;
    this._reconnectWindowMs = cfg.reconnectWindowMs ?? RECONNECT_WINDOW_MS;
    // Brain-liveness watchdog: after the user's turn, if no brain/avatar activity within
    // this window, surface a 'brainStalled' warning (R5). 0 disables. Default 12s.
    this._brainStallMs = cfg.brainStallMs ?? 12000;
    // Tool-call spiral circuit breaker: a tool-eager brain can re-emit the SAME (or
    // key-order-shuffled) client-command call every ~1-2s with zero spoken output —
    // observed live for 9-10+ minutes straight, eventually destabilizing the STV media
    // channel into a session-ending JoinRoomTimeout (docs/CLIENT-COMMANDS.md "Tool
    // spirals starve the voice"). `brainStalled` alone only warns once per turn and
    // never stops the spiral. After this many RAW `type:"tool"` segments in one turn
    // (counted before dedup — a spiral's repeats are exactly what this counts), emit
    // `toolSpiralDetected` (signal only — see `_checkToolSpiral`'s doc comment for why
    // it no longer calls interrupt()). 0 disables. Default 10: a legitimate turn can
    // double to 2x its real tool count when speak()'s barge-in branch (still-playing
    // TTS audio from a prior turn) spawns a parallel tap-to-talk stream for the same
    // question (live-verified — a 3-tool turn duplicated into 6 raw segments this
    // way), so the limit must clear a doubled ordinary turn while still catching a
    // genuine spiral (observed live running into the hundreds).
    this._toolSpiralLimit = cfg.toolSpiralLimit ?? 10;
    // Hard recovery threshold (session-scoped, NOT per-turn): live evidence showed a
    // server "wake-up" idle nudge fires its own agent_start_speech mid-spiral, which
    // resets the per-turn counter above and lets _checkToolSpiral() "detect" + soft
    // interrupt() again — while the underlying show_widget spiral kept running
    // UNINTERRUPTED underneath those resets (interrupt() is a client-side barge-in
    // signal; it cannot stop server-side generation — see interrupt() doc comment).
    // This counter tracks RAW tool segments since the last genuinely PERCEIVABLE
    // output (same clear condition as the brain-liveness watchdog) and is immune to
    // turn-boundary resets. Once it crosses this ceiling, soft interrupt() has
    // demonstrably failed and we force a real recovery (_coldReconnect — the same
    // socket-rebuild mechanism already proven live to end a runaway spiral, since
    // that is exactly how the incident this guards against actually terminated:
    // a `transport close` → `JoinRoomTimeout`). Default 3x the soft limit. 0 disables.
    this._hardToolSpiralLimit = cfg.hardToolSpiralLimit ?? (this._toolSpiralLimit ? this._toolSpiralLimit * 3 : 0);
    // A hard-spiral cold reconnect restores connectivity + replays threadId (brain memory)
    // but otherwise abandons the turn that triggered it — the user's original question is
    // simply dropped, which IS the "hang" symptom the whole circuit breaker exists to fix.
    // The headless path (`Conversations#send({recoverFromSpiral:true})`) proved live that a
    // single same-thread follow-up, prefixed with SPIRAL_RECOVERY_PREFIX, reliably breaks the
    // loop and gets a real spoken answer. `recoverFromSpiral` (default true) ports that same
    // fix here: once `_coldReconnect('tool_spiral_hard_limit')` succeeds, resend the last
    // user turn (tracked below) wrapped in the same prefix, via onTextEntered — bypassing
    // enforceTurnRate (this is the runtime recovering its own dropped turn, not a new user
    // turn) but still passed through onBeforeSend (LLM01 guardrail still applies to what
    // reaches the brain). Set false to only ever get the existing toolSpiralRecovering signal
    // (now carrying the tracked text as `lastTurnText`) and handle resend yourself.
    this._recoverSpiralTurn = cfg.recoverFromSpiral ?? true;
    // Last user turn's text, for the resend above. Tracked from BOTH entry points a turn can
    // start from: speak()'s argument (typed/app-driven text) and agentTurnToTalk's
    // userTranscription (ASR — the live incident this guards against started from voice, not
    // speak()). Cleared after a successful resend so a later spiral doesn't replay stale text.
    this._lastTurnText = null;
    // Optional network/visibility awareness (browser only). On by default in a browser.
    this._networkAware = cfg.networkAware ?? (typeof globalThis.addEventListener === 'function');

    /** @type {'idle'|'preparing'|'connecting'|'connected'|'reconnecting'|'resuming'|'disconnecting'|'disconnected'|'error'} */
    this.state = 'idle';
    this.mode = 'video';          // 'video' | 'audio' (set from stvNewSession)
    this.speaking = false;
    this.responsePending = false; // true from prompting the brain until its first meaningful output (dead-air gap)
    this.paused = false;
    this._sessionReleased = false;   // true after a pause expires server-side (resume needs a fresh STV)
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;     // bounds the 'reconnecting' state (RECONNECT_WINDOW_MS)
    this._brainStallTimer = null;    // R5 brain-liveness watchdog
    this._brainStallFireCount = 0;   // how many times it has fired since the last clear (repeats, doesn't go stale)
    this._iceGraceTimer = null;      // M8: cancellable ICE-disconnected grace window
    this._iceNewTimers = { asr: null, stv: null };  // stuck-in-'new'/'checking' watchdogs (never reach 'failed')
    this._mediaRecovering = { asr: false, stv: false };  // in-flight per-channel media recovery
    this._netHandlers = null;        // online/offline/visibilitychange unsubscribers
    this._coldReconnecting = false;  // a full session rebuild is in flight
    this._sessionGen = 0;            // bumped on every cold reconnect — lets an in-flight respondToTool detect it's now stale
    this._socket = null;
    this._pcAsr = null;
    this._pcStv = null;
    this._micStream = null;
    this._roomId = null;
    this._sessionId = null;
    this._webrtcUrl = null;
    this._whepLocation = null;
    this._micEnabled = true;
    this._tapToTalkActive = false;
    this._hwMuteTimers = [];   // pending 5s debounce timers for OS/hardware mic mute (see _initHardwareMuteWatch)
    this._tracker = new TranscriptTracker();
    this._capacityTimer = null;
    this._optimistic = null;
    this._capacityPolls = 0;
    this._clientConfig = null;
    // Client-side-command dispatch (W15): name → handler registered via onToolCall().
    // `_firedToolCalls` dedups within a turn (the same tool segment can re-arrive on
    // the live socket) and is CLEARED on turnStart so the same command can fire again
    // next turn. Keyed by name + sorted-key JSON of args (semantic, not the verbatim
    // wire string) — see `_dispatchToolCall`.
    /** @type {Map<string, Array<(args:object, call:object)=>void>>} */
    this._toolCallHandlers = new Map();
    this._firedToolCalls = new Set();
    this._toolCallSchemas = new Map();   // name -> argsSchema, set by onToolCall's optional 3rd param
    // Fused-tool-segment recovery (live-verified server behavior: a multi-tool turn can
    // arrive as ONE type:"tool" segment naming only its LAST tool, with earlier tools'
    // args concatenated into the same content string — see core/stream.js parseToolCall's
    // `fusedArgs`). `_pendingFusedBlobs` holds those un-attributed arg objects in arrival
    // order; `_turnDispatchedToolNames` tracks which tool names already fired this SUB-TURN
    // (the printed name, or a prior recovery) so `_recoverFusedToolResponse` can pair the
    // next un-attributed blob with the next tool_response name that isn't already spoken
    // for. Both are ASR-sub-turn-scoped — cleared on EVERY agent_start_speech, unlike
    // `_firedToolCalls` which only clears on a real isNewTurn boundary (see issue #41: a
    // name dispatched directly in sub-turn 1 must not block that same name's fused
    // recovery in sub-turn 2 of the same turnId — a distinct call with distinct args).
    /** @type {object[]} */
    this._pendingFusedBlobs = [];
    /** @type {Set<string>} */
    this._turnDispatchedToolNames = new Set();
    // Pending `wait_for_response:true` ACKs (issue #31 gap 2/rule 4.2): id -> {name}. Unlike
    // `_firedToolCalls`, this is NOT cleared on agent_start_speech/turnStart — an ACK's blocking
    // window can legitimately span past a single turn boundary. Entries are removed only on a
    // successful respondToTool(), or wholesale on disconnect()/cold-reconnect (below) so this
    // never grows unbounded across a long-lived session.
    /** @type {Map<string, {name:string}>} */
    this._pendingToolAcks = new Map();
    // Tool-call spiral circuit breaker state (see `_toolSpiralLimit` above). Counts RAW
    // `type:"tool"` segments per turn (before dedup — a spiral's repeats are exactly
    // what this counts); `_toolSpiralSignaled` guards `toolSpiralDetected` to fire at
    // most once per turn. Both reset on `agent_start_speech` (top of every turn).
    this._turnToolSegCount = 0;
    this._toolSpiralSignaled = false;
    // Session-scoped hard-spiral counter (see `_hardToolSpiralLimit` above). Cleared
    // only by perceivable output — NOT by agent_start_speech/turnStart — so an idle
    // wake-up nudge mid-spiral can't hide a spiral that survives across it.
    this._sessionToolSegCount = 0;
    this._hardSpiralRecovering = false;
  }

  // ─────────────────────────── connect ───────────────────────────

  /**
   * Run the full connect machine (steps 0–11) and resolve when the session is
   * live (greeting will play). Rejects with a {@link KalturaError} on any step
   * failure/timeout. Emits `disclosure` before any user turn.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.state !== 'idle' && this.state !== 'disconnected') {
      throw new KalturaError({ type: 'about:blank', title: 'already connecting', code: 'invalid_state', detail: `connect() called in state "${this.state}".` });
    }
    this._setState('preparing');
    // Step 0 — mic (no camera).
    try {
      this._micStream = await this._acquireMic();
    } catch (err) {
      this._setState('error');
      throw err.code ? err : micError(err);   // R6: map NotAllowed/NotFound/NotReadable/Overconstrained to distinct codes + guidance
    }
    this._initHardwareMuteWatch(this._micStream);
    this._syncVad();

    this._roomId = randId(12);
    const overall = deadline(TIMEOUTS.overall);

    this._setState('connecting');
    const socket = this._socketFactory(this._cmUrl, {
      path: '/socket.io', transports: ['websocket'],
      reconnection: true, reconnectionAttempts: this._maxReconnect,
      auth: { token: this._token },
      query: { partnerId: this._partnerId, billed_client: '', stickyId: this._stickyId, level: 'published', debugMode: true },
    });
    this._socket = socket;
    this._wireSocket(socket);

    try {
      // Step 1 — server handshake.
      const onConn = await this._await(socket, 'onServerConnected', TIMEOUTS.serverConnect, 'ConnectionTimeout', overall);
      this.emit('streamReady', { finalUrl: onConn?.finalUrl, agentName: onConn?.agentName, hostName: onConn?.hostName });

      // Step 2 — join.
      socket.emit('join', buildJoin({ room: this._roomId, ks: this._token, threadId: this._threadId, userAgent: ua(), isMobile: false, requestVars: this._requestVars }));

      // Step 3 — clientConfiguration AND joinComplete (both required).
      const [cc] = await Promise.all([
        this._await(socket, 'clientConfiguration', TIMEOUTS.joinRoom, 'JoinRoomTimeout', overall),
        this._await(socket, 'joinComplete', TIMEOUTS.joinComplete, 'JoinRoomTimeout', overall),
      ]);
      this._clientConfig = cc?.clientConfiguration || cc;

      // Step 4/5 — capacity-aware session create.
      await this._createSessionWithCapacity(socket, overall);
      // Steps 6/7/9/10 — agent + permissions + ASR + STV (mode-aware).
      await this._runConnectSequence(socket, overall);
      // EU AI Act Art. 50: inform the user they're talking to an AI BEFORE any avatar
      // speech. Disclosure fires here, ahead of approve() (which starts the greeting).
      // Synthetic-media provenance (EU AI Act Art. 50(2)/50(4), CA SB 1001 bot disclosure,
      // FTC impersonation): the disclosure is queryable any time via getDisclosure(), not just
      // at this one-shot event, and marks the output as AI-generated + the voice as synthetic.
      this._disclosure = {
        type: 'disclosure', disclosureText: this._disclosureText, firedAt: new Date().toISOString(),
        synthetic: true, provenance: { generatedBy: 'ai-avatar', voice: 'synthetic', sessionId: this._sessionId || null },
        scope: 'conversation (geniegpcid, entitlement ON)',
      };
      this.emit('disclosure', this._disclosure);
      // Step 11 — approve (starts the greeting). If an ack is required (regulated
      // deployments / biometric-consent jurisdictions), hold it until acknowledgeDisclosure().
      if (this._requireDisclosureAck && !this._disclosureAcked) { this._pendingApprove = socket; this._disclosurePending = true; }
      else this._approve(socket);
      this._setState('connected');
      this._wireNetwork();
      this._touchActivity();   // HIPAA auto-logoff: start the idle clock
      this._startStatsBeacon();
      this._audit('session.connect', 'success', { kind: 'conversation', entitlementEnforced: true, action: this.mode });
    } catch (err) {
      this._setState('error');
      this._teardownTransports();
      throw err instanceof KalturaError ? err : new KalturaError({ type: 'about:blank', title: 'connect failed', code: 'connect_failed', detail: String(err && err.message || err) });
    }
  }

  // ─────────────────────────── capacity (step 4/5) ───────────────────────────

  /**
   * Steps 4–5 with capacity awareness: poll `checkAvailability` and emit
   * `stvNewSession` only when `available===true`; never reconnect (stickiness).
   * Falls back to an optimistic create if no `availabilityResult` arrives in 3s
   * (matches app.js). On `throwToNoAgent`/`throwToExceededTier` the server drops
   * the socket — surfaced as a retryable/fatal error.
   * @param {any} socket @param {{expired:()=>boolean}} overall
   */
  async _createSessionWithCapacity(socket, overall) {
    return new Promise((resolve, reject) => {
      let requested = false, settled = false;
      /** @type {ReturnType<typeof setInterval>} */ let guard;
      const cleanup = () => {
        clearInterval(guard);
        if (this._optimistic) { clearTimeout(this._optimistic); this._optimistic = null; }
        socket.off?.('stvNewSession', onSession); socket.off?.('availabilityResult', onAvail);
        socket.off?.('throwToNoAgent', onNoAgent); socket.off?.('throwToExceededTier', onTier);
        if (this._capacityTimer) { clearTimeout(this._capacityTimer); this._capacityTimer = null; }
      };
      const finish = (fn, arg) => { if (!settled) { settled = true; cleanup(); fn(arg); } };
      const create = () => { if (requested) return; requested = true; socket.emit('stvNewSession', buildStvNewSession(this._roomId)); };
      const poll = () => { if (!settled) socket.emit('checkAvailability', {}); };   // capacity query, independent of create()
      const onSession = (p) => {
        if (isAudioMode(p)) { this.mode = 'audio'; this._sessionId = null; this._webrtcUrl = null; return finish(resolve); }
        this._sessionId = p.session_id;
        this._webrtcUrl = whepUrl(p.webrtc_url, this._srsBaseUrl, p.session_id);
        finish(resolve);
      };
      const onAvail = (p) => {
        this.emit('capacityChanged', { available: !!p?.available, details: p?.details });
        if (p && p.available) create();
        else {
          // ±15% jitter at consumption (schedule itself stays exact — see wire.test.js) so
          // concurrently-waiting clients don't all re-poll in lockstep.
          const base = CAPACITY_BACKOFF[Math.min(this._capacityPolls++, CAPACITY_BACKOFF.length - 1)];
          const wait = base * (0.85 + Math.random() * 0.3);
          this._capacityTimer = setTimeout(poll, wait * 1000);
        }
      };
      const onNoAgent = () => finish(reject, fatal('throwToNoAgent'));
      const onTier = () => finish(reject, fatal('throwToExceededTier'));
      socket.on('stvNewSession', onSession);
      socket.on('availabilityResult', onAvail);
      socket.on('throwToNoAgent', onNoAgent);
      socket.on('throwToExceededTier', onTier);
      // Emit stvNewSession right away (the server answers it directly; many agents
      // never send availabilityResult, so capacity-poll-FIRST just adds dead time
      // and risks the overall deadline). `throwToNoAgent` still handles real
      // capacity exhaustion below. Also poll checkAvailability in parallel so a
      // capacity-aware server can still gate via availabilityResult if it chooses.
      create();
      poll();
      guard = setInterval(() => { if (overall.expired()) finish(reject, timeoutErr('ConnectTimeout')); }, 250);
      guard.unref?.();
    });
  }

  /** Steps 6 & 7. @param {any} socket @param {{expired:()=>boolean}} overall */
  async _waitAgentAndPermissions(socket, overall) {
    await this._await(socket, 'showAgent', TIMEOUTS.agent, 'AgentResponseTimeout', overall);
    await this._await(socket, 'askPermissions', TIMEOUTS.agent, 'AgentResponseTimeout', overall);
  }

  /**
   * Steps 6/7/9/10: agent + permissions → ASR uplink → STV WHEP (mode-aware).
   * Shared by connect(), _coldReconnect(), and resume() to avoid tripling the
   * connect ordering logic. @param {any} socket @param {{expired:()=>boolean}} overall @param {{skipAgentWait?:boolean}} [opts]
   */
  async _runConnectSequence(socket, overall, opts = {}) {
    if (!opts.skipAgentWait) {
      await this._waitAgentAndPermissions(socket, overall);
    }
    await this._connectAsr(socket);
    if (this.mode !== 'audio') await this._connectStv();
  }

  // ─────────────────────────── ASR uplink (step 9) ───────────────────────────

  /** @param {any} socket */
  async _connectAsr(socket) {
    socket.emit('asr-webrtc-init', { sessionId: socket.id });
    await this._await(socket, 'asr-webrtc-ready', TIMEOUTS.asr, 'ASRConnectionFailed');
    const pc = new this._RTC(iceConfig('asr', this._turn, this._isFirefox));
    this._pcAsr = pc;
    pc.oniceconnectionstatechange = () => { this.emit('connectivityChanged', { channel: 'asr', state: pc.iceConnectionState }); this._onIceStateChange('asr', pc); };
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('asr-webrtc-ice-candidate', { candidate: e.candidate }); };
    this._armIceNewWatchdog('asr', pc);
    socket.on('asr-ice-candidate', (c) => { try { pc.addIceCandidate(c); } catch { /* non-fatal */ } });
    for (const track of this._micStream.getAudioTracks()) pc.addTrack(track, this._micStream);
    if (this._maxAsrBitrateKbps != null) await this._applyAsrBitrate(this._maxAsrBitrateKbps);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('asr-webrtc-offer', { offer, is_reconnect: false });
    const ans = await this._await(socket, 'asr-webrtc-answer', TIMEOUTS.asr, 'ASRConnectionFailed');
    await pc.setRemoteDescription(ans.answer);
  }

  // ─────────────────────────── STV downlink (step 10) ───────────────────────────

  /** WHEP subscribe, then resolve only when the video is playable (greeting-clip fix). */
  async _connectStv() {
    const pc = new this._RTC(iceConfig('stv', this._turn, this._isFirefox));
    this._pcStv = pc;
    const videoTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    this._applyVideoCodecPreference(videoTransceiver);
    pc.oniceconnectionstatechange = () => { this.emit('connectivityChanged', { channel: 'stv', state: pc.iceConnectionState }); this._onIceStateChange('stv', pc); };
    this._armIceNewWatchdog('stv', pc);

    const playable = new Promise((resolve) => {
      let done = false;
      /** @type {Set<any>} */ const timers = new Set();
      const arm = (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); id.unref?.(); return id; };
      const finish = () => { for (const id of timers) clearTimeout(id); timers.clear(); resolve(); };
      const settle = () => { if (!done) { done = true; arm(finish, 300); } }; // +300ms jitter settle
      pc.ontrack = (e) => {
        const v = this._videoEl;
        if (v) {
          v.srcObject = e.streams && e.streams[0];
          // play() returns a promise that rejects (AbortError) when srcObject swaps mid-play
          // — e.g. during STV re-subscribe recovery. Swallow it; it's not an SDK failure.
          if (typeof v.play === 'function') { try { const pr = v.play(); if (pr && typeof pr.catch === 'function') pr.catch(() => {}); } catch { /* */ } }
          if (v.readyState >= 3) settle();
          else if (typeof v.addEventListener === 'function') { v.addEventListener('canplay', settle, { once: true }); arm(() => { if (!done) settle(); }, 2000); }
          else settle();
        } else settle(); // audio-only / headless: nothing to gate on
      };
      arm(() => { if (!done) settle(); }, 6000); // hard cap
    });

    const url = this._webrtcUrl;
    if (whepUrlHasPrivateIp(url)) {
      throw new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/whep_private_ip', title: 'WHEP private IP', code: 'whep_private_ip', detail: 'STV egress returned a private IP (the broken cast_mode:webrtc path). The SDK only uses SRS WHEP.' });
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await this._fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: offer.sdp });
    const answerSdp = await res.text();
    if (!res.ok) throw new KalturaError({ type: 'about:blank', title: 'WHEP failed', status: res.status, code: 'whep_failed', detail: whepStatusHint(res.status), body: redact(answerSdp).slice?.(0, 200) });
    // The WHEP server's Location is often RELATIVE (e.g. "/rtc/v1/whip/?action=delete&…").
    // Resolve it against the WHEP request URL NOW, so disconnect()'s DELETE hits SRS — not the
    // page origin (which 404s and silently leaks the server-side STV session). [verified]
    const loc = res.headers?.get?.('Location');
    this._whepLocation = loc ? resolveUrl(loc, url) : null;
    // The resolved Location can ALSO resolve to a private IP (the server rewrote the
    // egress host after the initial request-URL check above passed) — checked separately
    // since it's only known post-response (additive to the pre-request check).
    if (this._whepLocation && whepUrlHasPrivateIp(this._whepLocation)) {
      throw new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/whep_private_ip', title: 'WHEP private IP', code: 'whep_private_ip', detail: 'STV WHEP Location resolved to a private IP (the broken cast_mode:webrtc path). The SDK only uses SRS WHEP.' });
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    await playable;
  }

  /** @param {any} socket */
  _approve(socket) { socket.emit('approvedPermissions', { room: this._roomId }); }

  // ─────────────────────────── runtime methods ───────────────────────────

  /**
   * Drive the avatar by text — BRAIN-REASONED (routed to the same pipeline as
   * ASR). Sends the CM's `isSpeechStart` marker first, which interrupts a
   * mid-sentence avatar (no-op if idle) — see issue #39; `tapToTalkStart`/
   * `tapToTalkEnd` are reserved for tap-to-talk button-hold mode and must NOT
   * bracket typed text (they flip InTappedMode and mint a duplicate turn).
   * Never HTTP converse.
   *
   * Passes through the optional `onBeforeSend` guardrail (OWASP LLM01 input
   * filtering): the hook may transform the text, leave it unchanged, or BLOCK the
   * turn (throw / return false) — a blocked turn emits a `guardrailBlocked` audit
   * event and does not reach the brain. Honors the `maxTurnsPerMinute` valve
   * (LLM10). Returns a Promise (resolves once sent; rejects if blocked/limited).
   * @param {string} text
   * @returns {Promise<void>}
   */
  async speak(text) {
    this._requireConnected('speak');
    if (this._tapToTalkActive) {
      throw new KalturaError({ type: 'about:blank', title: 'tap-to-talk active', code: 'invalid_state', detail: 'speak() cannot run while a tap-to-talk capture is open — call endTapToTalk() first (see issue #40).' });
    }
    if (this._disclosurePending) {
      throw new KalturaError({
        type: 'https://docs.kaltura.com/agentic/errors/disclosure_required', title: 'disclosure not acknowledged', code: 'disclosure_required',
        detail: 'speak() is blocked until acknowledgeDisclosure() is called (this session was constructed with requireDisclosureAck:true — EU AI Act Art. 50).',
      });
    }
    this._enforceTurnRate('speak');
    const finalText = await this._applyBeforeSend(text, { kind: 'speak', threadId: this._threadId });
    this._touchActivity();
    this._socket.emit('onTextEntered', buildTextEntered('', false, true));
    this._socket.emit('onTextEntered', buildTextEntered(finalText, true));
    if (this._debug) this._socket.emit('debug_text_entered', buildTextEntered(finalText, true)); // debug only
    this._armBrainWatchdog();      // R5: expect a brain response; warn if it stalls
    this._armResponsePending();    // positive "awaiting the brain" signal so the app can mask the gap
    this._lastTurnText = text;     // for a possible spiral-recovery resend — see `recoverFromSpiral`
  }

  /** Barge in on the avatar (yield the turn) — see issue #39. */
  interrupt() {
    this._requireConnected('interrupt');
    if (this._tapToTalkActive) {
      throw new KalturaError({ type: 'about:blank', title: 'tap-to-talk active', code: 'invalid_state', detail: 'interrupt() cannot run while a tap-to-talk capture is open — call endTapToTalk() first (see issue #40).' });
    }
    this._socket.emit('onTextEntered', buildTextEntered('', false, true));
  }

  /**
   * Start a tap-to-talk voice capture — the CM's push-to-talk mode, DISTINCT from
   * typed-text `speak()`/`interrupt()` (see issue #39/#40). The always-on ASR uplink
   * keeps streaming audio the whole session; this just tells the CM (`tapToTalkStart`
   * → `onTapToTalkStart`) to flip into `InTappedMode` and start a fresh capture window.
   * Call `endTapToTalk()` to close the window and let the CM mint the turn from
   * whatever it captured.
   *
   * Gated on `clientConfiguration.isTapToTalk` — verified against the live CM source
   * (`conversation-manager.ts`'s `vadSpeechDetected`) that this is NOT optional: an
   * agent configured for open-mic (`isTapToTalk:false`) keeps its own VAD turn-cutting
   * running unconditionally, with no suppression while `InTappedMode` — the two
   * mechanisms race the same `conversationStatus`/`latestSpeech` state with no mutual
   * exclusion. The server accepts `tapToTalkStart`/`tapToTalkEnd` regardless of the
   * flag, so this client-side gate is the only thing preventing that race — see
   * `capabilities.tapToTalk` to check before offering tap-to-talk UI at all.
   */
  startTapToTalk() {
    this._requireConnected('startTapToTalk');
    if (!this._clientConfig?.isTapToTalk) {
      throw new KalturaError({ type: 'about:blank', title: 'tap-to-talk disabled', code: 'capability_disabled', detail: 'startTapToTalk() requires clientConfiguration.isTapToTalk=true on this agent — mixing it with an open-mic agent races the CM\'s VAD turn-cutting (unverified/unsafe server-side).' });
    }
    if (this._tapToTalkActive) {
      throw new KalturaError({ type: 'about:blank', title: 'already tapped', code: 'invalid_state', detail: 'startTapToTalk() called while already active — call endTapToTalk() first.' });
    }
    if (this._disclosurePending) {
      throw new KalturaError({
        type: 'https://docs.kaltura.com/agentic/errors/disclosure_required', title: 'disclosure not acknowledged', code: 'disclosure_required',
        detail: 'startTapToTalk() is blocked until acknowledgeDisclosure() is called (this session was constructed with requireDisclosureAck:true — EU AI Act Art. 50).',
      });
    }
    this._tapToTalkActive = true;
    this._touchActivity();
    this._socket.emit('tapToTalkStart', {});
    this.emit('tapToTalkStarted', {});
  }

  /**
   * End a tap-to-talk capture started with `startTapToTalk()`. Emits `tapToTalkEnd`
   * (→ CM's `onTapToTalkEnd`), which schedules the CM's own ~300ms
   * `processTapToTalkInput` timer to mint the turn from the captured audio — the
   * resulting user turn arrives via the existing `agentTurnToTalk` handler exactly
   * like an open-mic turn (transcript, `_lastTurnText`, spiral-recovery all just work).
   * Arms the brain watchdog immediately (rather than waiting for that turn to land) so
   * a "thinking…" affordance can show right on release, matching `speak()`'s pattern.
   */
  endTapToTalk() {
    this._requireConnected('endTapToTalk');
    if (!this._tapToTalkActive) {
      throw new KalturaError({ type: 'about:blank', title: 'not tapped', code: 'invalid_state', detail: 'endTapToTalk() called without a preceding startTapToTalk().' });
    }
    this._tapToTalkActive = false;
    this._touchActivity();
    this._socket.emit('tapToTalkEnd', {});
    this._armBrainWatchdog();
    this._armResponsePending();
    this.emit('tapToTalkEnded', {});
  }

  /**
   * Whether a `startTapToTalk()` capture is currently open (read-only).
   * @returns {boolean}
   */
  get tapToTalkActive() { return this._tapToTalkActive; }

  /**
   * Acknowledge the AI disclosure (EU AI Act Art. 50). Only needed when the session
   * was constructed with `requireDisclosureAck:true` — it releases the held greeting.
   * No-op otherwise.
   */
  acknowledgeDisclosure() {
    this._disclosureAcked = true;
    this._disclosurePending = false;
    if (this._pendingApprove) { const s = this._pendingApprove; this._pendingApprove = null; this._approve(s); }
  }

  /**
   * The AI-disclosure / synthetic-media provenance descriptor for this session,
   * queryable any time (EU AI Act Art. 50, Utah on-request disclosure, CA SB 1001).
   * `{ disclosureText, synthetic:true, provenance:{generatedBy,voice,sessionId}, firedAt }`
   * or null before connect. Render it persistently + accessibly (ARIA live region).
   * @returns {object|null}
   */
  getDisclosure() { return this._disclosure; }

  /**
   * Poll for a free agent slot WITHOUT joining/consuming one (the platform
   * has no server-side wait queue, so this is client-side polling only, per
   * the documented `checkAvailability`/`availabilityResult` loop —
   * WIRE-PROTOCOL §`checkAvailability`). Opens its own lightweight socket
   * (independent of any live session) and resolves as soon as
   * `availabilityResult.available===true`, or rejects with a `capacity_timeout`
   * {@link KalturaError} after `maxWaitMs`. Call this BEFORE `connect()` to
   * avoid running the mic-prompt + full connect machine while agents are
   * known to be busy; also emits `capacityChanged` on every poll reply.
   * @param {{maxWaitMs?:number, pollIntervalMs?:number}} [opts]
   * @returns {Promise<{available:true, details?:object}>}
   */
  async waitForCapacity(opts = {}) {
    const maxWaitMs = opts.maxWaitMs ?? 300000;
    const pollIntervalMs = opts.pollIntervalMs ?? 5000;
    const socket = this._socketFactory(this._cmUrl, {
      path: '/socket.io', transports: ['websocket'],
      reconnection: true, reconnectionAttempts: this._maxReconnect,
      auth: { token: this._token },
      query: { partnerId: this._partnerId, billed_client: '', stickyId: this._stickyId, level: 'published', debugMode: true },
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      /** @type {ReturnType<typeof setTimeout>} */ let pollTimer;
      const timedOut = () => new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/capacity_timeout', title: 'capacity wait timeout', code: 'capacity_timeout', detail: `waitForCapacity: no agent slot became available within ${maxWaitMs}ms.` });
      const overallTimer = setTimeout(() => finish(reject, timedOut()), maxWaitMs);
      const cleanup = () => { clearTimeout(pollTimer); clearTimeout(overallTimer); socket.off?.('availabilityResult', onAvail); socket.disconnect?.(); };
      const finish = (fn, arg) => { if (!settled) { settled = true; cleanup(); fn(arg); } };
      const poll = () => { if (!settled) socket.emit('checkAvailability', {}); };
      const onAvail = (p) => {
        this.emit('capacityChanged', { available: !!p?.available, details: p?.details });
        if (p && p.available) finish(resolve, { available: true, details: p.details });
        else pollTimer = setTimeout(poll, pollIntervalMs);
      };
      socket.on('availabilityResult', onAvail);
      socket.on('connect', poll);   // real socket.io: also poll once the handshake completes
      poll();                        // fake/test sockets (and already-open real ones) get an immediate poll
    });
  }

  /** Human-in-the-loop kill switch (HITRUST AI.NI.a "humans can intervene"): alias of disconnect(). */
  stop() { this.disconnect(); }

  /**
   * Rotate the conversation token mid-session WITHOUT a full reconnect (OWASP
   * WebSocket session-management; RFC 9700 short-TTL refresh). Pass a fresh KS your
   * server re-minted (same configId). Updates the auth used for subsequent emits.
   * @param {string|{ks:string}} token
   */
  setToken(token) {
    const ks = token && typeof token === 'object' ? token.ks : token;
    if (!ks || typeof ks !== 'string') throw new KalturaError({ type: 'about:blank', title: 'token required', code: 'bad_request', detail: 'setToken needs a fresh conversation KS (string or Token).' });
    const info = inspectKs(ks);
    if (info.ok && info.disableEntitlement) throw new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/entitlement_violation', title: 'entitlement violation', code: 'entitlement_violation', detail: 'setToken refuses a disableentitlement token — the live runtime must keep entitlement ON.' });
    this._token = ks;
    if (this._socket?.auth) this._socket.auth.token = ks;
    this._audit('token.refresh', 'success', { kind: 'conversation', entitlementEnforced: true });
  }

  /** Mute the user's mic (stop sending audio) + tell the server. */
  mute() { this._setMic(false); }
  /** Unmute the user's mic (resume sending audio) + tell the server. */
  unmute() { this._setMic(true); }

  /**
   * Overridden so a local VAD (client-side `localSpeakingChanged`/`localMicLevel`,
   * AnalyserNode-based) is lazily started the moment a first listener is registered for
   * either event, and stopped once the last one across both unsubscribes — a session that
   * never listens for either pays zero Web Audio cost.
   * `on()`'s returned unsubscribe closure calls `this.off(...)`, which dispatches to this
   * override, so overriding `off()` alone is sufficient to catch unsubscription too.
   * @param {string} event @param {Function} fn
   */
  on(event, fn) {
    const unsub = super.on(event, fn);
    if (event === 'localSpeakingChanged' || event === 'localMicLevel') this._syncVad();
    return unsub;
  }

  /** @param {string} event @param {Function} fn */
  off(event, fn) {
    super.off(event, fn);
    if (event === 'localSpeakingChanged' || event === 'localMicLevel') this._syncVad();
  }

  _syncVad() {
    const wanted = ((this._listeners.get('localSpeakingChanged')?.size ?? 0)
      + (this._listeners.get('localMicLevel')?.size ?? 0)) > 0;
    if (wanted && this._micStream && !this._vadTimer) this._startVad();
    else if (!wanted && this._vadTimer) this._stopVad();
  }

  _startVad() {
    this._vadCtx = this._getAudioContext();
    // Clone the mic track: the VAD tap must never touch the send track (mute/replaceTrack
    // on the original must not affect it, and vice versa).
    const track = this._micStream.getAudioTracks()[0].clone
      ? this._micStream.getAudioTracks()[0].clone() : this._micStream.getAudioTracks()[0];
    this._vadTrack = track;
    this._vadSource = this._vadCtx.createMediaStreamSource(new this._MediaStreamCtor([track]));
    this._vadAnalyser = this._vadCtx.createAnalyser();
    this._vadAnalyser.fftSize = 32;
    this._vadSource.connect(this._vadAnalyser);
    this._vadData = new Uint8Array(this._vadAnalyser.frequencyBinCount);
    this._vadSpeaking = false;
    // Max possible sum: 255 per bin (byte frequency data) × frequencyBinCount bins.
    const vadMax = 255 * this._vadAnalyser.frequencyBinCount;
    this._vadTimer = setInterval(() => {
      this._vadAnalyser.getByteFrequencyData(this._vadData);
      let vol = 0; for (const v of this._vadData) vol += v;
      const now = vol >= this._vadThreshold;
      if (now !== this._vadSpeaking) { this._vadSpeaking = now; this.emit('localSpeakingChanged', { speaking: now }); }
      // Continuous 0-1 level on every tick (not just on threshold transitions) — drives
      // real-time UI meters (e.g. a mic button that fills with live input volume).
      this.emit('localMicLevel', { level: Math.min(1, vol / vadMax) });
    }, 50);
    this._vadTimer.unref?.();
  }

  _stopVad() {
    if (this._vadTimer) { clearInterval(this._vadTimer); this._vadTimer = null; }
    try { this._vadSource?.disconnect(); } catch { /* */ }
    try { this._vadTrack?.stop?.(); } catch { /* */ }
    this._vadSource = this._vadAnalyser = this._vadData = this._vadTrack = null;
  }

  /**
   * Shared by connect() and switchMic(): apply the Tier-1 constraints baseline, then pipe
   * the resulting stream through the Tier-2 BYO-DSP hook (if any). @param {object} [extraAudio]
   * @returns {Promise<any>}
   */
  async _acquireMic(extraAudio) {
    const audio = this._micConstraints === false ? (extraAudio || true) : { ...this._micConstraints, ...extraAudio };
    const raw = await this._getUserMedia({ audio, video: false });
    if (!this._noiseProcessor) return raw;
    try {
      const result = await this._noiseProcessor(raw);
      if (!result) { this._noiseProcessorStop = null; return raw; }
      // A processor MAY return {stream, stop} to own a resource the SDK must release on
      // teardown/switchMic (e.g. an AudioWorkletNode graph feeding a MediaStreamDestination
      // — the graph must be torn down even though the SDK never sees its internals).
      // Returning a bare MediaStream (no lifecycle to manage) is equally valid.
      if (result.stream && typeof result.stop === 'function') { this._noiseProcessorStop = result.stop; return result.stream; }
      this._noiseProcessorStop = null;
      return result;
    } catch (err) {
      try { raw.getTracks().forEach((t) => t.stop()); } catch { /* */ }
      throw new KalturaError({
        type: 'https://docs.kaltura.com/agentic/errors/noise_processor_failed', title: 'noise processor failed', code: 'noise_processor_failed',
        detail: 'cfg.noiseProcessor threw while processing the mic stream — mic acquisition failed closed (same as a getUserMedia rejection).',
        body: redact(String(err && err.message || err)),
      });
    }
  }

  /** Release the current noiseProcessor's owned resources (if it returned a `stop`), then clear it. */
  _releaseNoiseProcessor() {
    try { this._noiseProcessorStop?.(); } catch { /* */ }
    this._noiseProcessorStop = null;
  }

  /**
   * List available mic/speaker devices. An avatar session has no local camera, so video
   * input devices are intentionally omitted.
   * @returns {Promise<{mics: MediaDeviceInfo[], speakers: MediaDeviceInfo[]}>}
   */
  async listDevices() {
    if (!globalThis.navigator?.mediaDevices?.enumerateDevices) return { mics: [], speakers: [] };
    const devs = await globalThis.navigator.mediaDevices.enumerateDevices();
    return { mics: devs.filter((d) => d.kind === 'audioinput'), speakers: devs.filter((d) => d.kind === 'audiooutput') };
  }

  /**
   * Switch the active mic mid-session via `replaceTrack` on the existing ASR sender — no
   * renegotiation, no reconnect.
   * @param {string} deviceId
   */
  async switchMic(deviceId) {
    this._requireConnected('switchMic');
    const oldStop = this._noiseProcessorStop;
    const stream = await this._acquireMic({ deviceId: { exact: deviceId } });
    try { oldStop?.(); } catch { /* */ }
    const [newTrack] = stream.getAudioTracks();
    const sender = this._pcAsr?.getSenders?.().find((s) => s.track?.kind === 'audio');
    if (sender) await sender.replaceTrack(newTrack);
    const oldStream = this._micStream;
    this._micStream = stream;
    this._initHardwareMuteWatch(stream);
    this._syncVad();
    try { oldStream?.getAudioTracks().forEach((t) => { t.onmute = t.onunmute = null; t.stop(); }); } catch { /* */ }
  }

  /**
   * Route playback to a speaker device via `HTMLMediaElement.setSinkId`, retrying up to 5
   * times at 500ms. Returns false (never throws) if the platform has no `setSinkId` or
   * every retry is exhausted.
   * @param {string} deviceId @param {number} [attempt]
   * @returns {Promise<boolean>}
   */
  async setAudioOutput(deviceId, attempt = 0) {
    if (!this._videoEl || typeof this._videoEl.setSinkId !== 'function') return false;
    try {
      await this._videoEl.setSinkId(deviceId);
      return true;
    } catch (err) {
      if (attempt < 5) {
        await new Promise((r) => setTimeout(r, 500));
        return this.setAudioOutput(deviceId, attempt + 1);
      }
      this._log('warn', 'setAudioOutput failed after 5 attempts', err);
      return false;
    }
  }

  /**
   * Filter the STV video transceiver to a single codec — a hard filter, so the browser
   * excludes every other codec from the generated SDP. Silently skipped (browser default
   * codec negotiation applies) if `preferredVideoCodec` isn't set, `setCodecPreferences`
   * isn't supported, or the codec isn't in this browser's video capabilities.
   * @param {any} transceiver
   */
  _applyVideoCodecPreference(transceiver) {
    if (!this._preferredVideoCodec || typeof transceiver.setCodecPreferences !== 'function') return;
    const caps = this._RTCRtpReceiver?.getCapabilities?.('video');
    if (!caps) return;
    const targetMime = `video/${this._preferredVideoCodec.toUpperCase()}`;
    const codecs = caps.codecs.filter((c) => c.mimeType.toLowerCase() === targetMime.toLowerCase());
    if (!codecs.length) { this._log('warn', `preferredVideoCodec "${this._preferredVideoCodec}" not in this browser's video capabilities — skipping`); return; }
    try { transceiver.setCodecPreferences(codecs); } catch (err) { this._log('warn', 'setCodecPreferences failed', err); }
  }

  /**
   * Cap the ASR mic uplink's bitrate via `RTCRtpSender.setParameters()`. Callable
   * mid-session to adapt to bandwidth conditions; no renegotiation.
   * @param {number} kbps
   */
  async setAsrBandwidth(kbps) {
    this._requireConnected('setAsrBandwidth');
    this._maxAsrBitrateKbps = kbps;
    await this._applyAsrBitrate(kbps);
  }

  /** @param {number} kbps */
  async _applyAsrBitrate(kbps) {
    const sender = this._pcAsr?.getSenders?.().find((s) => s.track?.kind === 'audio');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = kbps * 1000;
    try { await sender.setParameters(params); } catch (err) { this._log('warn', 'setAsrBandwidth setParameters failed', err); }
  }

  /**
   * Start the opt-in connectivity beacon, reporting the raw `getStats()` numbers only —
   * no scoring/telemetry-backend wiring. No-op unless `statsIntervalMs` was passed to the
   * constructor, so a session that never opts in pays zero `getStats()` cost. Reads
   * `this._pcAsr`/`this._pcStv` fresh on every tick, so it keeps working across a cold
   * reconnect or resume without needing to be restarted.
   */
  _startStatsBeacon() {
    if (!this._statsIntervalMs) return;
    this._statsTimer = setInterval(() => {
      this._pollStats('asr', this._pcAsr);
      this._pollStats('stv', this._pcStv);
    }, this._statsIntervalMs);
    this._statsTimer.unref?.();
  }

  _stopStatsBeacon() {
    if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
    this._prevStats = { asr: null, stv: null };
  }

  /**
   * Poll one channel's `RTCPeerConnection.getStats()` and emit `connectionQuality`
   * (RTT from the active candidate-pair, packet-loss/jitter from the RTP stream stats,
   * bitrate from a byte-count delta against the previous poll). ASR only sends
   * (reads `outbound-rtp`); STV only receives (reads `inbound-rtp`).
   * @param {'asr'|'stv'} channel @param {any} pc
   */
  async _pollStats(channel, pc) {
    if (!pc || typeof pc.getStats !== 'function') return;
    let report;
    try { report = await pc.getStats(); } catch (err) { this._log('warn', `getStats(${channel}) failed`, err); return; }
    let rttMs = null, packetLossPct = null, jitterMs = null, bytes = 0;
    const rtpKind = channel === 'asr' ? 'outbound-rtp' : 'inbound-rtp';
    for (const s of report.values()) {
      if (s.type === 'candidate-pair' && (s.state === 'succeeded' || s.nominated) && typeof s.currentRoundTripTime === 'number') {
        rttMs = s.currentRoundTripTime * 1000;
      }
      if (s.type === rtpKind) {
        bytes += (channel === 'asr' ? s.bytesSent : s.bytesReceived) || 0;
        if (jitterMs == null && typeof s.jitter === 'number') jitterMs = s.jitter * 1000;
        if (packetLossPct == null && typeof s.packetsLost === 'number' && typeof s.packetsReceived === 'number') {
          const total = s.packetsLost + s.packetsReceived;
          packetLossPct = total > 0 ? (s.packetsLost / total) * 100 : 0;
        }
      }
    }
    const now = this._now();
    const prev = this._prevStats[channel];
    const bitrateKbps = prev && now > prev.ts ? ((bytes - prev.bytes) * 8) / (now - prev.ts) : null;
    this._prevStats[channel] = { bytes, ts: now };
    this.emit('connectionQuality', { channel, rttMs, packetLossPct, jitterMs, bitrateKbps });
  }

  /** Pause the live turn loop. */
  pause() { this._requireConnected('pause'); this.paused = true; this._socket.emit('pauseConversation', {}); }
  /**
   * Resume the live turn loop. If the pause expired server-side (the session was
   * released — `sessionReadyForResume`/`pauseSessionExpired`), the old STV/ASR
   * transports are dead, so resume() rebuilds them against the FRESH stvNewSession
   * the server emits on resume (conversation-manager onResumeConversation). Within
   * the pause window it's a no-op resume (server just sends conversationResumed).
   * @returns {Promise<void>}
   */
  async resume() {
    this._requireConnected('resume');
    this.paused = false;
    if (!this._sessionReleased) { this._socket.emit('resumeConversation', {}); return; }
    // released → expect a fresh stvNewSession; rebuild transports on it.
    this._sessionReleased = false;
    const overall = deadline(TIMEOUTS.overall);
    this._socket.emit('resumeConversation', {});
    await this._createSessionWithCapacity(this._socket, overall);
    if (this.mode !== 'audio') { try { this._pcStv?.close?.(); } catch { /* */ } this._pcStv = null; }
    try { this._pcAsr?.close?.(); } catch { /* */ } this._pcAsr = null;
    await this._runConnectSequence(this._socket, overall, { skipAgentWait: true });
    this._approve(this._socket);
  }

  /** The sticky id pinning this session to its pod — persist it to resume the SAME session across a tab reload. */
  getStickyId() { return this._stickyId; }

  /** Keep the session/stickiness alive by re-polling capacity on the live socket. */
  keepAlive() { if (this._socket && this._socket.connected !== false) this._socket.emit('checkAvailability', {}); }

  /**
   * Push a screen-share still for vision analysis. Only valid when the agent has
   * screen-share analysis enabled (clientConfiguration.isScreenShareEnabled);
   * otherwise throws. @param {ArrayBuffer|Uint8Array} data
   */
  sendScreenShot(data) { this._requireVision('isScreenShareEnabled', 'sendScreenShot'); this._socket.emit('userScreenShareShot', { data }); }

  /**
   * Inject a structured "dynamic prompt" the brain reads as live context for the
   * next turns — e.g. the data behind the slide currently on screen (a presenter
   * pattern). Routed to the server's `setDynamicPrompt` handler (WIRE-PROTOCOL
   * §4a). This is CONTEXT, not speech: it does not make the avatar talk (use
   * {@link speak} for that). The object is sent verbatim; keep it JSON-clean.
   * APP-initiated (correctly UNGATED — the `_gateAgentAction` guardrail is for
   * AGENT-pushed actions, not your own calls).
   * @param {object} data Arbitrary JSON context (the app's "DPP" payload).
   */
  setDynamicPrompt(data) {
    this._requireConnected('setDynamicPrompt');
    this._touchActivity();
    // Sent verbatim to the brain — scrub prototype-pollution keys so an app passing
    // a server-derived object can't inject __proto__/constructor (OWASP deserialization).
    // NOTE: this is object-injection defense, NOT prompt-injection defense — don't put
    // unsanitized end-user free text (or secrets/authz) in the DPP (LLM01/LLM07; see SECURITY.md).
    this._socket.emit('setDynamicPrompt', { data: sanitizeJson(data) });
  }

  /**
   * Notify the brain that the user clicked a GenUI element (link/button/card) it
   * rendered — so it can react ("html-element-click" trigger). APP-initiated
   * (correctly UNGATED — `_gateAgentAction` gates AGENT-pushed actions, not this).
   * @param {object} info e.g. `{ htmlText }`
   */
  notifyHtmlElementClick(info) {
    this._requireConnected('notifyHtmlElementClick');
    this._touchActivity();
    this._socket.emit('onHtmlElementClick', sanitizeJson(info || {}));
  }

  /**
   * Submit the structured-data-form values the brain asked for (via
   * `user_properties_forms`) → the server's `setFormLeadInfo` handler. Routes
   * the value back into the conversation. APP-initiated (correctly UNGATED —
   * the `_gateAgentAction` guardrail is for AGENT-pushed actions, not your own
   * calls).
   * @param {object} values e.g. `{ email, phone }` or any other configured fields
   */
  submitStructuredDataForm(values) {
    this._requireConnected('submitStructuredDataForm');
    this._touchActivity();
    this._socket.emit('setFormLeadInfo', sanitizeJson(values || {}));
  }

  /**
   * Update the `{{var}}` Jinja `request_vars` map for the rest of this live
   * session (issue #31 gap 3) — the mid-session peer of the join-time
   * `cfg.requestVars` constructor option, routed to conversation-manager's
   * `updateGenieContext` handler (already fully wired server-side). Use for
   * slow-changing personalization (viewer name, account tier) — for a full
   * per-turn context blob the brain reads fresh every turn, use
   * {@link setDynamicPrompt} instead — the two mechanisms are distinct.
   *
   * conversation-manager RESETS `request_vars` to exactly what's sent here (no
   * merge with the join-time or a previously-sent map) — always send the FULL
   * current map, not a delta.
   *
   * Reuses {@link import('../management/conversations.js').assertRequestVars}
   * (rule 2.2) — rejects a `sys__*`/`secrets` key or a non-scalar value BEFORE
   * the socket emit. Never accepts/forwards a `capabilities` key (rule 2.3) —
   * the emitted payload is always exactly `{request_vars: vars}`, so this
   * cannot become a second client-side path into the
   * `kaltura_genie_experiences` gate (see docs/CLIENT-COMMANDS.md Gotcha 1 —
   * it's a capability, not a request_var).
   * @param {Record<string, string|number|boolean|null>} vars
   * @example
   * session.updateRequestVars({ user_name: 'Ada', account_tier: 'enterprise' });
   */
  updateRequestVars(vars) {
    this._requireConnected('updateRequestVars');
    const checked = assertRequestVars(vars, 'updateRequestVars');
    this._touchActivity();
    this._socket.emit('updateGenieContext', { request_vars: sanitizeJson(checked || {}) });
  }

  /**
   * Register a handler for an AGENT-initiated client-side command — a native
   * function-calling tool the brain invokes (an intellect `tools` entry, e.g. a
   * {@link import('../management/tools.js').client} tool). When the LLM calls
   * `name`, its parsed `{args}` arrive here; run whatever JS you like (navigate a
   * deck, call a page function, inject content). The tool call rides a SILENT
   * `type:"tool"` segment — it never reaches the voice track — so the audio stays
   * clean while the structured command drives your UI.
   *
   * Fires AFTER the `onAgentAction` guardrail (a vetoed/allow-listed-out command
   * never dispatches) and AT MOST ONCE PER TURN per identical call (the same
   * segment can re-arrive on the live socket; dedup resets each turn). Multiple
   * handlers for one name all run, in registration order; a throwing handler is
   * isolated (logged, others still run). Returns an unsubscribe function.
   *
   * A handler's return value (or thrown/rejected error) is captured and re-emitted
   * as `'toolCallResult'` — `{call, ok:true, value}` for a non-`undefined`
   * return/resolve, `{call, ok:false, error}` for a throw/reject. A handler
   * returning `undefined` (the common case — most handlers just act, nothing to
   * report) emits no result event; this is LOCAL only (app-observable) — it does
   * NOT change what Genie's brain sees UNLESS the tool was built with
   * `waitForResponse:true`, in which case the handler must call
   * `session.respondToTool(call.toolMetadata.id, ...)` to give the brain a real
   * result (see {@link respondToTool}). Async (Promise-returning) handlers are
   * supported; their result arrives once settled, after this call already returned.
   *
   * For the headless / SSE path use `collectConverse(...).toolCalls` or
   * {@link import('../core/stream.js').parseToolCall} — this is the live-socket peer.
   *
   * An optional third `argsSchema` — the SAME `args` object already declared in
   * {@link import('../management/tools.js').client}'s `args` — enables a
   * dispatch-time check of `call.args` (type/required/enum on top-level keys, via
   * {@link import('../core/stream.js').validateToolArgs}, issue #24) BEFORE any
   * handler for `name` runs. A mismatch never reaches a handler: it's dropped and
   * re-emitted as `'toolCallInvalid'` (`{call, errors}`) instead of `'toolCall'`.
   * The root-cause motivation is a real incident where a malformed call surfaced
   * only as a repeated-retry spiral, not a typed error at the point of failure.
   * Registering more than once for the same `name` with different schemas is
   * last-write-wins (one check runs per call, not per handler); omit it (or pass
   * nothing) for no behavior change.
   *
   * @param {string} name The tool name the brain calls (e.g. `navigate_to_slide`).
   * @param {(args:object, call:{name:string,args:object,raw:string})=>unknown} handler
   * @param {Record<string, import('../core/stream.js').ToolArgSchema>} [argsSchema]
   * @returns {() => void} unsubscribe
   * @example
   * session.onToolCall('navigate_to_slide', ({ slide_num }) => deck.goTo(slide_num));
   * session.onToolCall('create_slide', (slide) => deck.append(slide));
   * // with a dispatch-time arg check:
   * session.onToolCall('navigate_to_slide', ({ slide_num }) => deck.goTo(slide_num),
   *   { slide_num: { type: 'int', required: true } });
   * session.on('toolCallInvalid', ({ call, errors }) => console.warn(call.name, errors));
   * // or listen broadly:
   * session.on('toolCall', ({ name, args }) => console.log(name, args));
   * session.on('toolCallResult', ({ call, ok, value, error }) => console.log(call.name, ok, value ?? error));
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
   * Dispatch a parsed tool call to the `'toolCall'` event + any onToolCall(name)
   * handlers, deduped within the turn. Dedup is SEMANTIC (name + sorted-key JSON of
   * args), not on the raw wire string — an LLM retry of the identical logical call can
   * arrive with non-deterministic JSON key order (e.g. `{"reason":..,"slide_num":..}`
   * vs `{"slide_num":..,"reason":..}`), which byte-string dedup would fail to catch
   * (issue #18). Returns `true` if this was a NEW call (handlers ran) or `false` if it
   * was a duplicate retry (dropped). The spiral counter itself (`_checkToolSpiral`)
   * counts raw segments independent of this return value — see its own doc comment.
   *
   * Each handler's return value/throw is captured and re-emitted as `'toolCallResult'`
   * (see `onToolCall`'s doc comment for the shape and its local-only scope — issue #25).
   *
   * If a schema was registered for `call.name` (via `onToolCall`'s 3rd param), `call.args`
   * is checked BEFORE any handler runs (issue #24) — a mismatch is dropped (no handler
   * invoked, no 'toolCall' emitted) and re-emitted as `'toolCallInvalid'` instead. Still
   * counted into the per-turn dedup set first, so a repeated invalid call doesn't re-fire
   * the event every retry.
   * @param {{name:string,args:object,raw:string}} call
   * @returns {boolean}
   */
  /**
   * Drop pending tool-ACK entries older than {@link PENDING_TOOL_ACK_MAX_AGE_MS}
   * (issue #31 rule 4.2) — called on every new `waitForResponse:true` dispatch so
   * the Map self-bounds even in a long-lived session whose app never calls
   * `respondToTool()` for some call. Cheap (one Map scan) and only ever runs when
   * a fresh entry is about to be added, so it costs nothing on sessions that never
   * use `waitForResponse:true`.
   */
  _sweepStalePendingToolAcks() {
    const now = this._now();
    for (const [id, pending] of this._pendingToolAcks) {
      if (now - pending.at > PENDING_TOOL_ACK_MAX_AGE_MS) this._pendingToolAcks.delete(id);
    }
  }

  _dispatchToolCall(call) {
    if (!call || typeof call.name !== 'string') return false;
    const key = `${call.name}:${canonicalJson(call.args || {})}`;
    if (this._firedToolCalls.has(key)) return false;   // already handled this turn
    this._firedToolCalls.add(key);
    this._turnDispatchedToolNames.add(call.name);
    // Fused multi-tool segment (parseToolCall's `fusedArgs`, live-verified): earlier
    // tools' arg blobs concatenated into this segment under a name that isn't theirs.
    // Queue them for `_recoverFusedToolResponse` to attribute + dispatch as the
    // matching `type:"tool_response"` names stream in right after this segment.
    if (Array.isArray(call.fusedArgs) && call.fusedArgs.length) this._pendingFusedBlobs.push(...call.fusedArgs);
    this._touchActivity();
    // A wait_for_response:true call blocks the brain until respondToTool(id, ...) POSTs an
    // ACK — track it so respondToTool can validate the id (rule 3.1) and so it's provably
    // bounded (rule 4.2: cleared on ACK, wholesale on disconnect()/cold-reconnect, and swept
    // by age here + in respondToTool so a caller that never ACKs can't grow the Map unbounded).
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
      if (result && typeof result.then === 'function') {
        result.then(
          (value) => { if (value !== undefined) this.emit('toolCallResult', { call, ok: true, value }); },
          (error) => { this._log('error', `onToolCall("${call.name}") handler rejected`, error); this.emit('toolCallResult', { call, ok: false, error }); },
        );
      } else if (result !== undefined) {
        this.emit('toolCallResult', { call, ok: true, value: result });
      }
    }
    return true;
  }

  /**
   * Recover a fused-segment blob (see `_dispatchToolCall`'s `_pendingFusedBlobs`)
   * using a `type:"tool_response"` segment's tool name as the attribution signal.
   * Server-side, each tool called this turn echoes its own `tool_response` in the
   * SAME order it was called (live-verified) — so the first pending blob belongs
   * to the first `tool_response` name that hasn't already been dispatched this
   * turn. A name already in `_turnDispatchedToolNames` (the printed name from the
   * `type:"tool"` segment itself, or a prior recovery) is skipped rather than
   * double-dispatched. No-op when there's nothing pending (the common, non-fused
   * case) — zero cost for every app that never hits this bug.
   * @param {string|null} name
   */
  _recoverFusedToolResponse(name) {
    if (!name || !this._pendingFusedBlobs.length || this._turnDispatchedToolNames.has(name)) return;
    const args = this._pendingFusedBlobs.shift();
    this._dispatchToolCall({ name, args, raw: `${name} ${canonicalJson(args)}` });
  }

  /**
   * ACK a `wait_for_response:true` client tool call (issue #31 gap 2) — POSTs
   * to conversation-manager's `/assistant/tool_response` so the brain, which is
   * BLOCKED waiting for this, can resume the turn with a real result instead of
   * silently timing out. **If you set `waitForResponse:true` on a
   * {@link import('../management/tools.js').client} tool, you MUST call this** —
   * live-verified: an unacknowledged `wait_for_response:true` call still gets a
   * confident, narrated "success" from the brain (it treats the timeout string
   * as a real result), so skipping this produces silently-wrong output, not a
   * visible failure.
   *
   * Takes the id from `call.toolMetadata.id` (the `onToolCall`/`toolCall`-event
   * call object), not a separate lookup — mirrors how the call arrived.
   *
   * Degrades gracefully (rule 3.1) for an id that is unknown, already ACK'd, arrived
   * after this session cold-reconnected (its pending-ACK Map is cleared on
   * disconnect/cold-reconnect — rule 4.2), or is simply too old ({@link
   * PENDING_TOOL_ACK_MAX_AGE_MS} — a call the app never acknowledges must not pin
   * that entry in memory forever on a session that stays connected): returns a
   * typed `{ok:false, reason:'unknown_or_stale'}` rather than throwing or hanging,
   * since by the time an app calls this the brain may already have timed out and
   * moved on server-side — a thrown error here would just be a second failure on
   * top of the first.
   * @param {string} id `call.toolMetadata.id` from the tool call being acknowledged.
   * @param {object} response JSON-serializable result the brain should see (must be a plain object).
   * @returns {Promise<{ok:boolean, reason?:string}>}
   * @example
   * session.onToolCall('save_progress_note', (args, call) => {
   *   const saved = db.save(args.note);
   *   if (call.toolMetadata?.waitForResponse) {
   *     session.respondToTool(call.toolMetadata.id, { status: saved ? 'ok' : 'failed' });
   *   }
   * });
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
    this._touchActivity();
    const gen = this._sessionGen;
    await this._fetch(`${this._genieUrl}/assistant/tool_response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `KS ${this._token}` },
      body: JSON.stringify({ tool_name: pending.name, tool_id: id, response: sanitizeJson(response) }),
    });
    this._pendingToolAcks.delete(id);
    // A cold reconnect mid-flight already discarded the server-side session this POST
    // targeted — the request above can only have failed or been ignored server-side.
    if (gen !== this._sessionGen) { this._audit('tool.ack', 'fail', { reason: 'session_rebuilt' }); return { ok: false, reason: 'session_rebuilt' }; }
    this._audit('tool.ack', 'success', { action: pending.name });
    return { ok: true };
  }

  /**
   * Circuit breaker for a runaway tool-call spiral (see `_toolSpiralLimit` — the
   * live incident this guards against ran `show_widget` 438x over 9 minutes with
   * zero narration, eventually crashing the STV media channel). Counts every RAW
   * `type:"tool"` segment in the turn (dedup-INDEPENDENT — a spiral IS repeats of
   * the same call, which `_dispatchToolCall` already drops before handlers run,
   * so counting only new dispatches would never trip). Once the per-turn limit is
   * crossed, fires `toolSpiralDetected` exactly once for the turn — SIGNAL ONLY,
   * the app decides how to react. This method used to also call `interrupt()`
   * (`tapToTalkStart`/`tapToTalkEnd`) here; removed after a second live incident
   * showed it was actively harmful, not just ineffective: per WIRE-PROTOCOL.md's
   * documented barge-in semantics, a mid-turn `tapToTalkStart` forces an early
   * `stvFinishedTalking` with TRUNCATED `agentContent` — so the soft trip silently
   * cut the turn's own narration (`avatarStopTalking` fired with empty text) with
   * no mechanism to reopen the talking channel once the brain went on to stream a
   * complete, correct spoken answer for the same turn. It also never stopped the
   * spiral itself: a follow-up live test showed the brain kept re-emitting the
   * identical tool call for 5+ minutes past the interrupt(), through a
   * server-pushed idle "wake-up" turn (which resets this per-turn counter,
   * letting this method re-signal without the underlying spiral ever having
   * stopped), until the socket itself died. The counter that actually forces
   * recovery is the session-scoped one in `_checkHardToolSpiral` — see there for
   * the real fix.
   */
  _checkToolSpiral() {
    if (!this._toolSpiralLimit) return;
    this._turnToolSegCount++;
    this._sessionToolSegCount++;
    if (!this._toolSpiralSignaled && this._turnToolSegCount >= this._toolSpiralLimit) {
      this._toolSpiralSignaled = true;
      this._audit('tool.spiral_detected', 'fail', { count: this._turnToolSegCount });
      this.emit('toolSpiralDetected', { count: this._turnToolSegCount, limit: this._toolSpiralLimit });
    }
    this._checkHardToolSpiral();
  }

  /**
   * Hard-recovery escalation (see `_hardToolSpiralLimit`). Fires once per spiral —
   * `_hardSpiralRecovering` guards re-entry until perceivable output clears the
   * counter — and forces `_coldReconnect()` rather than relying on `interrupt()`
   * again, since the live incident this guards against proved the soft signal has
   * no effect on a server-side spiral already past the soft threshold. Also
   * force-settles the app-visible "waiting on the brain" state immediately, since
   * a rebuilt socket abandons the stuck turn rather than ever resolving it.
   * `toolSpiralRecovering` carries `lastTurnText` (the tracked stuck turn, if any) so an
   * app can react even with `recoverFromSpiral:false`; `_coldReconnect` reads the same
   * field off `this` to actually resend it when the option is on (default).
   */
  _checkHardToolSpiral() {
    if (!this._hardToolSpiralLimit || this._hardSpiralRecovering) return;
    if (this._sessionToolSegCount < this._hardToolSpiralLimit) return;
    this._hardSpiralRecovering = true;
    this._audit('tool.spiral_hard_recovery', 'fail', { count: this._sessionToolSegCount, limit: this._hardToolSpiralLimit });
    this.emit('toolSpiralRecovering', { count: this._sessionToolSegCount, limit: this._hardToolSpiralLimit, lastTurnText: this._lastTurnText });
    this._clearBrainWatchdog();
    this._settleResponsePending();
    if (this.state === 'connected') this._coldReconnect('tool_spiral_hard_limit').catch((e) => this._log('error', 'toolSpiralRecovering cold reconnect failed', e));
  }

  /**
   * Read-only capability surface derived from the agent's clientConfiguration
   * (least-privilege visibility — LLM06). e.g. `{ screenShare, cameraAnalysis,
   * webSearch, interruptions, tapToTalk }`. Available after connect. `tapToTalk`
   * reflects the agent's configured input mode (push-to-talk vs open-mic) — apps
   * can use it to decide whether `startTapToTalk()`/`endTapToTalk()` should be the
   * primary voice control or an optional secondary one (see issue #40).
   */
  get capabilities() {
    const c = this._clientConfig || {};
    return {
      screenShare: !!c.isScreenShareEnabled,
      cameraAnalysis: !!c.isCameraAnalysisEnabled,
      webSearch: !!c.isWebSearchEnabled,
      interruptions: c.interruptionsEnabled !== false,
      tapToTalk: !!c.isTapToTalk,
    };
  }

  /** Tear down the WHEP resource, peer connections, mic, socket, and drop the token. Always call when done. */
  disconnect() {
    if (this.state === 'disconnected') return;
    this._setState('disconnecting');
    // DELETE the WHEP resource (release the server-side STV session) if we have a Location.
    // Best-effort + observable: a non-2xx means a leaked egress resource, so we audit it.
    if (this._whepLocation && this._fetch) {
      const loc = this._whepLocation;
      Promise.resolve().then(() => this._fetch(loc, { method: 'DELETE' }))
        .then((r) => { if (r && r.ok === false) this._audit('whep.release', 'fail', { action: 'DELETE', reason: `HTTP ${r.status}` }); })
        .catch((e) => this._audit('whep.release', 'fail', { action: 'DELETE', reason: String(e && e.message || e) }));
    }
    this._teardownTransports();
    this._token = null;   // don't hold the secret past the session (NIST AC-6/SC-4; bounded blast radius)
    this._audit('session.disconnect', 'success', {});
    this._setState('disconnected');
  }

  /** Emit a one-time warning through the logger (insecure transport / static TURN). @param {string} key @param {string} msg */
  _warnOnce(key, msg) { if (this._warned && !this._warned.has(key)) { this._warned.add(key); this._log('warn', '[security] ' + msg); } }

  /** The per-session agent config received at step 3 (read-only). */
  get clientConfig() { return this._clientConfig; }

  /**
   * Whether the user's mic is currently sending audio (read-only). Reflects
   * unmute() (true) vs mute() (false). Starts true.
   * @returns {boolean}
   */
  get micEnabled() { return this._micEnabled; }

  // ─────────────────────────── internals ───────────────────────────

  /** @param {any} socket */
  _wireSocket(socket) {
    socket.on('connect', () => {
      this.emit('connectivityChanged', { channel: 'socket', state: 'connected' });
      // A `connect` while we were 'reconnecting' is a Socket.IO reconnection. Whether the
      // SESSION survived depends on `socket.recovered`:
      //   recovered === true  → connection-state recovery succeeded: the server replayed
      //     buffered packets and SKIPPED join re-init (keys off hasJoined). The live STV/ASR
      //     session + state are intact — do NOT re-join, just return to 'connected'.
      //   recovered !== true  → a brand-new socket on a (possibly different) pod: the old
      //     server session is gone. We must COLD-reconnect (re-join → new session → rebuild
      //     transports, replaying threadId). Silently treating this as recovered leaves a
      //     "connected" session that is actually dead (no media, no brain). [verified gap]
      if (this.state === 'reconnecting') {
        this._clearReconnectTimer();
        if (socket.recovered === true) {
          this._reconnectAttempt = 0;
          this._setState('connected');
          this.emit('reconnected', { recovered: true });
          // Connection-state recovery only proves the SOCKET survived — the separate STV/ASR
          // WebRTC peers can independently have gone 'failed'/'disconnected' during the same
          // outage (their own ICE, not multiplexed over the socket). Mirrors the online-event
          // nudge in _wireNetwork: without this, a channel silently stuck in ICE_DOWN never
          // recovers until some LATER unrelated trigger stumbles onto it — e.g. the avatar
          // video staying frozen with the session otherwise reporting 'connected'. [issue #53b]
          for (const ch of ['asr', 'stv']) { const pc = ch === 'asr' ? this._pcAsr : this._pcStv; if (pc && ICE_DOWN.has(pc.iceConnectionState)) this._recoverMedia(ch, pc); }
        } else {
          this._coldReconnect('socket recovery not available').catch((err) => this._endWith(err));
        }
      }
    });
    // socket.io exhausted its reconnection attempts — terminal, never a silent hang.
    socket.on('reconnect_failed', () => { if (this.state === 'reconnecting') this._endWith(new KalturaError({ type: 'about:blank', title: 'reconnect failed', code: 'reconnect_failed', detail: 'Socket.IO exhausted its reconnection attempts; the session could not be restored.' }), 'reconnect_failed'); });
    socket.on('disconnect', (r) => {
      const recoverable = RECOVERABLE_DISCONNECT.has(r);
      this.emit('connectivityChanged', { channel: 'socket', state: 'disconnected', reason: r, recoverable, attempt: this._reconnectAttempt, maxAttempts: this._maxReconnect });
      if (this.state !== 'connected' && this.state !== 'reconnecting') return;
      if (recoverable) {
        // Let socket.io's reconnection + the server's connection-state-recovery do its thing
        // (same-pod, ≤20s). We stay alive in 'reconnecting' and wait for a `connect` (above)
        // or the bounded window to expire — then end cleanly. NEVER hang here. [verified gap]
        this._reconnectAttempt++;
        this._setState('reconnecting');
        this.emit('reconnecting', { reason: r, attempt: this._reconnectAttempt, maxAttempts: this._maxReconnect });
        this._armReconnectTimer();
      } else {
        // Non-recoverable (io server/client disconnect, namespace) → a clean terminal end,
        // not an error. Surface `ended {reason}` only (no spurious `error`).
        this._endWith(null, r);
      }
    });
    socket.on('connect_error', (e) => this.emit('error', new KalturaError({ type: 'about:blank', title: 'socket connect error', code: 'socket_error', detail: String(e && e.message || e) })));

    // Pause/resume lifecycle (server-verified, conversation-manager). A pause that EXPIRES
    // server-side releases TTV+ASR but persists the session — it is NOT an 'ended'. resume()
    // then needs a fresh stvNewSession (handled in resume()).
    socket.on('pauseSessionExpired', () => { this._sessionReleased = true; this.emit('timeExpired', { type: 'pause_expiry' }); });
    socket.on('sessionReadyForResume', () => { this._sessionReleased = true; this.emit('resumeReady', { ready: true }); });
    socket.on('resumingSession', () => this._setState('resuming'));

    // Brain stream. Genuine visible/audible output proves the pipeline is alive → clear the
    // watchdog. EXCEPTION: `type:"tool"`/`"tool_response"` (and `"think"`) segments are SILENT
    // to the viewer by themselves — a tool-only turn produces no speech or visible content, so
    // it must not count as progress that clears the watchdog. A tool-eager brain can spiral on
    // the identical call for minutes with zero narration
    // (docs/CLIENT-COMMANDS.md "Tool spirals starve the voice"), so treating a tool segment
    // as proof of progress — even the FIRST one, not just a retry — would suppress
    // `brainStalled` for the entire spiral, leaving the viewer staring at a silently frozen
    // avatar with no warning. Only spoken/avatar/GenUI content settles the watchdog.
    // Server-pushed strings are untrusted LLM output → clamp length + strip control chars (LLM05).
    socket.on('agent_raw_text', async (p) => {
      let d; try { d = JSON.parse(p.delta); } catch { d = { type: 'text', content: p.delta }; }
      if (d && typeof d.content === 'string') d.content = clampInbound(d.content);
      if (d && d.threadId && !this._threadId) this._threadId = d.threadId;
      // The parsed delta never carries speechId (WIRE-PROTOCOL §4e's extra keys are
      // threadId/messageId/segmentStart/segmentEnd/isFinal, not speechId) — it lives only
      // on the outer agent_raw_text envelope (`p`). Attach it here so every emitted
      // brainSegment carries the same speechId as the turnStart/turnEnd bracketing it;
      // otherwise a SegmentAssembler consumer can never match a buffered widget's speechId
      // against onTurnEnd's real one (issue #53), and every widget gets silently dropped.
      if (d && d.speechId === undefined) d.speechId = p?.speechId ?? null;
      // OWASP LLM06 Excessive Agency: gate AGENT-pushed actions (GenUI/structured-data/nav) before
      // they reach the app. Only engages when this segment classifies AS an action AND a
      // policy/hook is configured — otherwise default-allow keeps spoken/nav/GenUI flowing
      // untouched (the earnings app et al never see a behavior change). A vetoed action is
      // dropped: no brainSegment, so the app can't act on it.
      const action = classifyAgentAction(d);
      if (action && (this._agentActions || this._onAgentAction)) {
        if (!await this._gateAgentAction(action)) return;
        // Allowed GenUI/tool surfacing → observability-by-proxy audit (NOT a server tool-exec
        // log; use Genie report/report-summary for authoritative analytics — plan §6/W13).
        if (action.type === 'render-genui' || action.type === 'structured-data-form') {
          this._audit('tool.invoke', 'success', { action: action.runtime || action.type });
        }
      }
      // Client-side command dispatch (W15): a `type:"tool"` segment is a native
      // function call the host app handles in JS (navigate a deck, call a page fn,
      // inject content). Fire AFTER the gate (a vetoed action already returned), once
      // per turn, to onToolCall(name) handlers + the 'toolCall' event. This is the
      // ergonomic peer of the headless collectConverse().toolCalls.
      if (action && action.type === 'tool-call') {
        this._dispatchToolCall(action.payload);
        this._checkToolSpiral();
      }
      // Fused-segment recovery (see `_dispatchToolCall`/`_recoverFusedToolResponse`):
      // each `tool_response` the server streams right after a fused `type:"tool"`
      // segment names one of the OTHER tools that call actually invoked — the only
      // signal that lets us attribute a queued blob to its real tool. No-op when
      // `_pendingFusedBlobs` is empty (every non-fused turn).
      if (d && d.type === 'tool_response') this._recoverFusedToolResponse(parseToolResponseName(d));
      // Watchdog clears ONLY on segments a viewer can actually perceive — spoken/avatar
      // content or a rendered GenUI widget. `tool`/`tool_response`/`think` never clear it,
      // so a tool-only spiral (first call included) still surfaces `brainStalled`. The
      // session-scoped hard-spiral counter (`_sessionToolSegCount`) rides the SAME
      // condition — it must NOT reset on agent_start_speech/turnStart (an idle wake-up
      // nudge fires that mid-spiral) but SHOULD reset once the brain genuinely recovers.
      if (d && (SPOKEN_TYPES.has(d.type) || (action && action.type === 'render-genui'))) { this._clearBrainWatchdog(); this._sessionToolSegCount = 0; this._hardSpiralRecovering = false; }
      // First real OUTPUT segment settles the dead-air signal — an avatar/text/tool/genui
      // segment is the brain actually producing something. A `think` segment is still the
      // gap (it's the "preparing…" phase), so it does NOT settle.
      if (d && d.type && d.type !== 'think') this._settleResponsePending();
      this.emit('brainSegment', d);
    });
    // NOTE: agent_start_speech (with its "preparing…"/think control) marks the START of the
    // thinking phase, NOT output — so it does NOT settle responsePending (that would clear the
    // signal during the very dead air it's meant to cover). It RE-ARMS the brain watchdog
    // (fresh full window) rather than clearing it outright: it fires once at the top of EVERY
    // turn, well before any tool spiral, so an outright clear here would disarm the watchdog
    // for the rest of the turn and mask the exact spiral it exists to catch (the live incident
    // this guards against — see docs/CLIENT-COMMANDS.md "Tool spirals starve the voice"). A
    // fresh window still gives the brain reasonable ack-to-first-token grace without granting
    // it a free pass for the remainder of a long, silent turn. We settle responsePending, and
    // finally clear the watchdog, only on real output below: an avatar/text/GenUI content
    // segment, the avatar talking, turn end, or an interruption.
    // isNewTurn:false marks the CM's documented duplicate — a second speechId (observed
    // trigger `tap-to-talk`) for a turnId already in flight, born from speak()'s barge-in
    // branch racing `this.speaking` (see the constructor comment on `_hardToolSpiralLimit`).
    // Every other isNewTurn consumer in this codebase (presenter.js, avatar-session.js)
    // already gates on it; clearing/promoting state here unconditionally was the one gap —
    // it wiped the tool dedup set out from under the FIRST turn's already-fired calls (so
    // they replay as if new, feeding the spiral) and promoted the duplicate speechId as the
    // tracker's "current" utterance, so its captions/audio played interleaved with the first.
    // `_pendingFusedBlobs`/`_turnDispatchedToolNames` are the one exception (issue #41):
    // they reset on EVERY agent_start_speech, isNewTurn or not. A fused-segment recovery is
    // scoped to its own ASR sub-turn, not the whole turnId — a name dispatched directly in
    // sub-turn 1 is a distinct call from that same name arriving fused in sub-turn 2's
    // segment, and the stale entry was silently skipping the sub-turn-2 recovery.
    socket.on('agent_start_speech', (p) => {
      this._armBrainWatchdog();
      this._pendingFusedBlobs = []; this._turnDispatchedToolNames.clear();
      if (p?.isNewTurn) {
        this._firedToolCalls.clear();
        this._turnToolSegCount = 0; this._toolSpiralSignaled = false;
        if (p?.speechId) this._tracker.beginUtterance(p.speechId);
      }
      this.emit('turnStart', { speechId: p?.speechId, turnId: p?.turnId, isNewTurn: p?.isNewTurn });
    });
    socket.on('agent_end_turn', (p) => { this._settleResponsePending(); this.emit('turnEnd', { speechId: p?.speechId, turnId: p?.turnId }); });
    socket.on('stvFinishedGenerating', (p) => { this._settleResponsePending(); this.emit('turnEnd', { speechId: p?.speechId }); });
    socket.on('generatingSpeech', (p) => { if (p?.speechId) this._tracker.beginUtterance(p.speechId); this.emit('transcript', { text: clampInbound(p?.text || ''), type: 'final', speechId: p?.speechId, words: [] }); });

    // Captions (authoritative).
    socket.on('stvSpeechChunk', (p) => {
      const text = clampInbound(p?.text);
      this.emit('speechChunk', { text, durationMs: p?.durationMs, speechId: p?.speechId });
      const tr = this._tracker.ingestChunk({ ...p, text });
      if (tr) this.emit('transcript', tr);
    });

    // Talking state. Content-free turn audit events (HIPAA 164.312(b) — record that a
    // PHI-bearing exchange occurred, NEVER its content) + activity touch (auto-logoff reset).
    socket.on('stvStartedTalking', () => { this._clearBrainWatchdog(); this._settleResponsePending(); this._touchActivity(); this.speaking = true; this._audit('turn.avatar_spoke', 'success', {}); this.emit('avatarStartTalking', {}); });
    socket.on('stvFinishedTalking', (p) => { this.speaking = false; this._tracker.finishUtterance(); this.emit('avatarStopTalking', { text: clampInbound(p?.agentContent) }); });
    socket.on('agentInterrupted', () => { this.speaking = false; this._settleResponsePending(); this.emit('interrupted', {}); });
    socket.on('userStartedTalking', () => { this._clearBrainWatchdog(); this._touchActivity(); this.emit('userStartedTalking', {}); });
    // The user's turn produced a transcription → the brain should now respond; watch for a stall (R5)
    // and flip the response-pending signal so the app can mask the dead-air gap until output lands.
    socket.on('agentTurnToTalk', (p) => { this._armBrainWatchdog(); this._armResponsePending(); this._touchActivity(); if (p && p.userTranscription) { this._audit('turn.user_captured', 'success', {}); this._lastTurnText = clampInbound(p.userTranscription); this.emit('transcript', { text: this._lastTurnText, type: 'user', speechId: null, words: [] }); } });
    // Forwarded smart-turn VAD end-of-turn indicator (WIRE-PROTOCOL §4b) — passthrough, no SDK-side logic depends on it yet.
    socket.on('smartTurnStatus', (p) => this.emit('smartTurnStatus', { status: p?.status, timeoutMs: p?.timeout_ms, probability: p?.probability }));

    // Lifecycle.
    socket.on('conversationTimeWarning', (p) => this.emit('timeWarning', { remainingTime: p?.remainingTime }));
    socket.on('conversationTimeExpired', () => this.emit('timeExpired', {}));
    socket.on('conversationEnded', () => { this.emit('ended', {}); this.disconnect(); });
    socket.on('conversationResumed', () => { this.paused = false; this.emit('resumed', {}); });
    socket.on('stvTaskFail', () => this.emit('error', new KalturaError({ type: 'about:blank', title: 'STV task failed', code: 'stv_task_fail', detail: 'The server failed to render/send the avatar video.' })));

    // Fatal error events.
    for (const [ev, info] of Object.entries(FATAL_CODE)) {
      socket.on(ev, (p) => this.emit('error', new KalturaError({ type: `https://docs.kaltura.com/agentic/errors/${info.code}`, title: info.code.replace(/_/g, ' '), code: info.code, detail: `${ev}${info.num ? ` (${info.num})` : ''}${p?.code ? ` ${p.code}` : ''}`, status: info.num || undefined })));
    }
  }

  /**
   * Await a single inbound socket event with a timeout (and optional overall
   * deadline). Cleans up its listener. @returns {Promise<any>}
   * @param {any} socket @param {string} event @param {number} ms @param {string} label @param {{expired:()=>boolean}} [overall]
   */
  _await(socket, event, ms, label, overall) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { socket.off?.(event, ok); reject(timeoutErr(label)); }, ms);
      t.unref?.();
      const ok = (payload) => { clearTimeout(t); socket.off?.(event, ok); if (overall && overall.expired()) return reject(timeoutErr('ConnectTimeout')); resolve(payload); };
      socket.once ? socket.once(event, ok) : socket.on(event, ok);
    });
  }

  _setMic(enabled) {
    this._micEnabled = enabled;
    if (this._micStream) for (const t of this._micStream.getAudioTracks()) t.enabled = enabled;
    if (this._socket) this._socket.emit(enabled ? 'unmuteUser' : 'muteUser', {});
  }

  /**
   * Watch for the OS/hardware muting the mic OUTSIDE our own `mute()`/`unmute()` calls (e.g. a
   * laptop's hardware mic-mute key, or the OS privacy toggle) — `track.muted` flips on its own
   * and neither `_setMic` nor `track.enabled` observes it. Debounce the MUTED direction by
   * 5s (a track can flicker `onmute` briefly during device handoffs) but fire UNMUTED
   * immediately, since a false "still muted" reading is worse than a false-cleared one.
   * @param {any} stream
   */
  _initHardwareMuteWatch(stream) {
    for (const track of stream.getAudioTracks()) {
      let timer = null;
      track.onmute = () => {
        timer = setTimeout(() => { this.emit('hardwareMuteChanged', { muted: true, track }); }, 5000);
        timer.unref?.();
        this._hwMuteTimers.push(timer);
      };
      track.onunmute = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        this.emit('hardwareMuteChanged', { muted: false, track });
      };
    }
  }

  _requireConnected(where) {
    if (this.state !== 'connected' || !this._socket) {
      throw new KalturaError({ type: 'about:blank', title: 'not connected', code: 'invalid_state', detail: `${where}() requires a connected session (state="${this.state}").` });
    }
  }

  _requireVision(flag, where) {
    this._requireConnected(where);
    if (!this._clientConfig || !this._clientConfig[flag]) {
      throw new KalturaError({ type: 'about:blank', title: 'vision disabled', code: 'capability_disabled', detail: `${where}() requires clientConfiguration.${flag}=true on this agent.` });
    }
  }

  // ─────────────────────────── media (WebRTC) recovery — R1 media half + R7 ICE restart ───────────────────────────

  /**
   * A `pc` stuck in 'new'/'checking' (gathering never starts, or every candidate fails to
   * connect) never reaches 'failed' — `oniceconnectionstatechange` simply never fires again,
   * so `_onIceStateChange` alone can't detect it. Watch for it directly: if still stuck after
   * 10s, treat it the same as a failed connection.
   *
   * Additionally fail fast if gathering completes with ZERO candidates ever produced —
   * that's a dead network path (e.g. TURN unreachable),
   * not a slow one, so there's no reason to wait out the full 10s. A 3s floor guards against
   * false positives on a genuinely slow TURN-only network that just hasn't gathered its first
   * relay candidate yet.
   * @param {'asr'|'stv'} channel @param {any} pc
   */
  _armIceNewWatchdog(channel, pc) {
    if (this._iceNewTimers[channel]) clearTimeout(this._iceNewTimers[channel]);
    const armedAt = this._now();
    let candCount = 0;
    const origOnCandidate = pc.onicecandidate;
    pc.onicecandidate = (e) => { if (e.candidate) candCount++; origOnCandidate?.(e); };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete' && candCount === 0 && this._iceNewTimers[channel]
          && this.state === 'connected' && this._now() - armedAt >= 3000) {
        clearTimeout(this._iceNewTimers[channel]);
        this._iceNewTimers[channel] = null;
        this._recoverMedia(channel, pc);
      }
    };
    const timer = setTimeout(() => {
      this._iceNewTimers[channel] = null;
      const st = pc.iceConnectionState;
      if ((st === 'new' || st === 'checking') && this.state === 'connected') this._recoverMedia(channel, pc);
    }, 10000);
    timer.unref?.();
    this._iceNewTimers[channel] = timer;
  }

  /**
   * React to an ASR/STV peer's ICE state. 'failed'/'disconnected' means the media path is
   * down while the control socket may still be healthy — without this the avatar silently
   * freezes. Escalate: 'disconnected' is often transient, so we give it a short grace to
   * self-heal; a 'failed' (or a grace that doesn't recover) triggers an ICE restart first
   * (fast for wifi↔cellular handoffs), and if that can't be applied or the session is gone,
   * a full cold rebuild.
   * @param {'asr'|'stv'} channel @param {any} pc
   */
  _onIceStateChange(channel, pc) {
    const st = pc.iceConnectionState;
    if (st !== 'new' && st !== 'checking' && this._iceNewTimers[channel]) {
      clearTimeout(this._iceNewTimers[channel]); this._iceNewTimers[channel] = null;
    }
    if (this.state !== 'connected') return;          // only react on a live session
    if (st === 'connected' || st === 'completed') { this._mediaRecovering[channel] = false; return; }
    if (!ICE_DOWN.has(st) || this._mediaRecovering[channel]) return;
    if (st === 'disconnected') {
      // Grace: ICE frequently returns to 'connected' on its own. Recover only if it doesn't.
      this._iceGraceTimer = setTimeout(() => { if (this.state === 'connected' && ICE_DOWN.has(pc.iceConnectionState)) this._recoverMedia(channel, pc); }, 1500);
      this._iceGraceTimer.unref?.();
      return;
    }
    this._recoverMedia(channel, pc);                 // 'failed' → act now
  }

  /** Recover one media channel: ICE restart first, then escalate to a full cold rebuild. @param {'asr'|'stv'} channel @param {any} pc */
  async _recoverMedia(channel, pc) {
    if (this._mediaRecovering[channel] || this.state !== 'connected') return;
    this._mediaRecovering[channel] = true;
    this.emit('mediaRecovering', { channel, state: pc?.iceConnectionState });
    try {
      // R7: try an ICE restart on the existing peer (fast path) when the platform supports it.
      if (channel === 'asr' && typeof pc?.restartIce === 'function' && this._socket?.connected !== false) {
        pc.restartIce();
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        this._socket.emit('asr-webrtc-offer', { offer, is_reconnect: true });
        const ans = await this._await(this._socket, 'asr-webrtc-answer', TIMEOUTS.asr, 'ASRConnectionFailed');
        await pc.setRemoteDescription(ans.answer);
        this._mediaRecovering[channel] = false;
        this.emit('mediaRecovered', { channel, method: 'ice-restart' });
        return;
      }
      // STV is a WHEP subscription: re-subscribe to the same session (new offer → new answer).
      if (channel === 'stv' && this._webrtcUrl) {
        try { this._pcStv?.close?.(); } catch { /* */ } this._pcStv = null;
        await this._connectStv();
        this._mediaRecovering[channel] = false;
        this.emit('mediaRecovered', { channel, method: 're-subscribe' });
        return;
      }
      throw new KalturaError({ type: 'about:blank', title: 'media restart unavailable', code: 'media_recover_failed', detail: `no in-place restart for ${channel}` });
    } catch (err) {
      // Fast path failed → the server session is likely gone; escalate to a full rebuild.
      // A WHEP 404 (session truly gone server-side) gets a distinct, greppable reason from
      // any other in-place-restart failure — both still cold-reconnect the same way today.
      this._mediaRecovering[channel] = false;
      const stvSessionGone = channel === 'stv' && err?.status === 404;
      this.emit('connectivityChanged', { channel, state: 'recover_failed', detail: String(err && err.message || err) });
      this._coldReconnect(stvSessionGone ? 'stv session gone (404)' : `media ${channel} ${pc?.iceConnectionState || 'failed'}`).catch((e) => this._endWith(e));
    }
  }

  // ─────────────────────────── brain-liveness watchdog — R5 ───────────────────────────

  /**
   * Arm the watchdog after the user finishes a turn; fires `brainStalled` if the
   * brain goes quiet. REPEATS every `_brainStallMs` (not single-fire) as long as
   * nothing perceivable follows — a multi-minute tool-call spiral (the live
   * incident this guards against ran 9+ minutes) must not go stale after one
   * warning at the 12s mark and then fall silent for the rest of the turn.
   * `afterMs` stays constant across repeats (the per-fire window); `count`
   * increments each time so a listener can escalate its own UI (e.g. switch from
   * a soft "taking longer…" toast to a harder "still working, hang tight" one).
   */
  _armBrainWatchdog() {
    if (!this._brainStallMs) return;
    this._clearBrainWatchdog();
    this._brainStallFireCount = 0;
    const fire = () => {
      if (this.state !== 'connected') return;
      this._brainStallFireCount++;
      this.emit('brainStalled', { afterMs: this._brainStallMs, count: this._brainStallFireCount });
      const t = setTimeout(fire, this._brainStallMs);
      t.unref?.();
      this._brainStallTimer = t;
    };
    const t = setTimeout(fire, this._brainStallMs);
    t.unref?.();
    this._brainStallTimer = t;
  }
  _clearBrainWatchdog() { if (this._brainStallTimer) { clearTimeout(this._brainStallTimer); this._brainStallTimer = null; } this._brainStallFireCount = 0; }

  // Response-pending signal: the positive peer of the brainStalled WARNING. Armed the moment
  // we prompt the brain (speak / a captured user turn), cleared on its FIRST meaningful output
  // (turn start, the avatar speaking, a tool call, turn end, or an interruption). Lets an app
  // mask the dead-air gap with a "thinking…" affordance instead of a frozen face. Idempotent.
  _armResponsePending() {
    if (this.responsePending) return;
    this.responsePending = true;
    this.emit('responsePending', {});
  }
  _settleResponsePending() {
    if (!this.responsePending) return;
    this.responsePending = false;
    this.emit('responseSettled', {});
  }

  // ─────────── guardrails: input filtering (LLM01), rate valve (LLM10), agent-action gate (LLM06/ASI) ───────────

  /** Run the optional onBeforeSend guardrail. Returns the (possibly transformed) text, or throws to block. @param {string} text @param {object} ctx */
  async _applyBeforeSend(text, ctx) {
    if (!this._onBeforeSend) return text;
    let out;
    try { out = await this._onBeforeSend(text, ctx); }
    catch (err) {
      this._audit('guardrail.block', 'fail', { action: ctx.kind, reason: err && err.message });
      throw new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/guardrail_blocked', title: 'blocked by guardrail', code: 'guardrail_blocked', detail: `onBeforeSend blocked this ${ctx.kind}.` });
    }
    if (out === false) {
      this._audit('guardrail.block', 'fail', { action: ctx.kind, reason: 'returned false' });
      throw new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/guardrail_blocked', title: 'blocked by guardrail', code: 'guardrail_blocked', detail: `onBeforeSend blocked this ${ctx.kind}.` });
    }
    return typeof out === 'string' ? out : text;
  }

  /** Unbounded-consumption valve (LLM10): throttle outbound turns. Throws rate_limited when exceeded. @param {string} where */
  _enforceTurnRate(where) {
    if (!this._maxTurnsPerMin) return;
    const now = this._now();
    this._turnTimes = this._turnTimes.filter((t) => now - t < 60000);
    if (this._turnTimes.length >= this._maxTurnsPerMin) {
      this._audit('rate.limit', 'fail', { action: where, reason: `> ${this._maxTurnsPerMin}/min` });
      throw new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/rate_limited', title: 'rate limited', code: 'rate_limited', detail: `${where}: client turn rate exceeded ${this._maxTurnsPerMin}/min. (Server-side quota is authoritative; this is a client safety valve — LLM10.)` });
    }
    this._turnTimes.push(now);
  }

  /**
   * Gate an AGENT-initiated action through the capability policy + onAgentAction hook
   * (OWASP LLM06 Excessive Agency; Agentic ASI 01/02). Returns true to proceed, false to
   * veto. Emits agent.action.allow/deny audit. The action is `{type, payload, source:'agent'}`.
   * The onAgentAction callback may be sync or async — a returned Promise is awaited before
   * deciding; `async (action) => false` correctly vetoes the action (H4).
   * @param {{type:string, payload?:any}} action @returns {Promise<boolean>}
   */
  async _gateAgentAction(action) {
    const a = { ...action, source: 'agent' };
    // 1) declarative capability policy (sync, fast).
    const policy = this._agentActions;
    if (policy) {
      if (a.type === 'navigate' && policy.navigate === 'off') return this._denyAction(a, 'navigate disabled by policy');
      if (a.type === 'render-genui' && policy.genui === false) return this._denyAction(a, 'genui disabled by policy');
      if (a.type === 'structured-data-form' && policy.structuredDataForm === false) return this._denyAction(a, 'structuredDataForm disabled by policy');
      // toolCall policy: `false` blocks ALL client commands; an array allow-lists names.
      if (a.type === 'tool-call' && policy.toolCall !== undefined) {
        const name = a.payload?.name;
        if (policy.toolCall === false) return this._denyAction(a, 'toolCall disabled by policy');
        if (Array.isArray(policy.toolCall) && !policy.toolCall.includes(name)) return this._denyAction(a, `tool "${name}" not in toolCall allow-list`);
      }
    }
    // 2) integrator hook (may veto). Sync or async: a returned Promise is awaited so that
    //    `async (action) => false` correctly vetoes (H4). A throw also vetoes.
    if (this._onAgentAction) {
      let res;
      try { res = this._onAgentAction(a); } catch { return this._denyAction(a, 'onAgentAction threw'); }
      if (res && typeof res.then === 'function') {
        try { res = await res; } catch { return this._denyAction(a, 'onAgentAction threw'); }
      }
      if (res === false) return this._denyAction(a, 'onAgentAction returned false');
    }
    this._audit('agent.action.allow', 'success', { action: a.type });
    return true;
  }
  _denyAction(a, reason) { this._audit('agent.action.deny', 'fail', { action: a.type, reason }); this.emit('agentActionDenied', { type: a.type, reason }); return false; }

  // ─────────────────────────── idle auto-logoff — HIPAA 164.312(a)(2)(iii) ───────────────────────────

  /** Record activity + (re)arm the idle auto-logoff timer. Called on connect, every user/agent action, and each turn. */
  _touchActivity() {
    if (!this._idleTimeoutMs || this.state === 'disconnected' || this.state === 'disconnecting') return;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (this._idleWarnTimer) clearTimeout(this._idleWarnTimer);
    const warnAt = Math.max(0, this._idleTimeoutMs - 60000);
    this._idleWarnTimer = setTimeout(() => { if (this.state === 'connected') this.emit('idleWarning', { inMs: Math.min(60000, this._idleTimeoutMs) }); }, warnAt);
    this._idleWarnTimer.unref?.();
    this._idleTimer = setTimeout(() => {
      if (this.state === 'disconnected' || this.state === 'disconnecting') return;
      this._audit('session.timeout', 'success', { action: 'idle auto-logoff', reason: `idle > ${this._idleTimeoutMs}ms` });
      this.emit('timeExpired', { type: 'idle_timeout' });
      this.disconnect();
    }, this._idleTimeoutMs);
    this._idleTimer.unref?.();
  }
  _clearIdleTimers() { if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; } if (this._idleWarnTimer) { clearTimeout(this._idleWarnTimer); this._idleWarnTimer = null; } }

  // ─────────────────────────── network/visibility awareness — R7 ───────────────────────────

  /** Wire browser online/offline/visibility so we react proactively instead of waiting for timeouts. */
  _wireNetwork() {
    if (!this._networkAware || typeof globalThis.addEventListener !== 'function' || this._netHandlers) return;
    const onOffline = () => { this.emit('connectivityChanged', { channel: 'network', state: 'offline' }); };
    const onOnline = () => {
      this.emit('connectivityChanged', { channel: 'network', state: 'online' });
      // Returning from offline: nudge a stalled media channel to recover promptly.
      if (this.state === 'connected') { for (const ch of ['asr', 'stv']) { const pc = ch === 'asr' ? this._pcAsr : this._pcStv; if (pc && ICE_DOWN.has(pc.iceConnectionState)) this._recoverMedia(ch, pc); } }
    };
    globalThis.addEventListener('online', onOnline);
    globalThis.addEventListener('offline', onOffline);
    this._netHandlers = () => { try { globalThis.removeEventListener('online', onOnline); globalThis.removeEventListener('offline', onOffline); } catch { /* */ } };
  }
  _unwireNetwork() { if (this._netHandlers) { this._netHandlers(); this._netHandlers = null; } }

  /** Bound the 'reconnecting' state — if recovery doesn't land in the window, end cleanly (no hang). */
  _armReconnectTimer() {
    this._clearReconnectTimer();
    const t = setTimeout(() => {
      if (this.state === 'reconnecting') this._endWith(new KalturaError({ type: 'about:blank', title: 'reconnect timed out', code: 'reconnect_timeout', detail: `No recovery within ${this._reconnectWindowMs}ms; the session could not be restored.` }), 'reconnect_timeout');
    }, this._reconnectWindowMs);
    t.unref?.();
    this._reconnectTimer = t;
  }
  _clearReconnectTimer() { if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; } }

  /** Terminal end: surface an error (once), emit `ended`, tear down. The single end path. */
  _endWith(err, reason) {
    if (this.state === 'disconnected' || this.state === 'disconnecting') return;
    this._clearReconnectTimer();
    if (err) this.emit('error', err instanceof KalturaError ? err : new KalturaError({ type: 'about:blank', title: 'ended', code: 'ended', detail: String(err && err.message || err) }));
    this._setState('disconnected');
    this.emit('ended', { reason: reason || (err && err.code) || 'ended' });
    this._teardownTransports();
  }

  /**
   * Cold reconnect (R3 horizon 2): the server session is gone (recovery unavailable, a
   * media peer failed beyond ICE restart, or a tool-spiral hard limit forced a rebuild).
   * Discards whatever control socket exists and opens a genuinely NEW one (mirroring
   * connect()'s own bootstrap), then re-joins (replaying threadId so the brain thread
   * continues), re-creates the STV session, and rebuilds both WebRTC peers. Emits
   * `reconnecting`→`reconnected{recovered:false}`.
   *
   * MUST open a brand-new socket when the control socket never actually dropped: the
   * server's `join` handler is idempotent-guarded per-connection (WIRE-PROTOCOL.md
   * `join` — "the `join` handler skips re-init" keyed on `session.hasJoined`), so
   * re-emitting `join` on a still-live socket is a silent no-op server-side —
   * `clientConfiguration`/`joinComplete` never arrive and this times out
   * (`JoinRoomTimeout`, verified live 3x, including a direct bypassing call proving
   * it's independent of the tool-spiral trigger). A brand-new socket.io connection has
   * no `hasJoined` history and joins clean (verified live). `this.state === 'reconnecting'`
   * at entry is the exact discriminator: it means we got here via `_wireSocket`'s own
   * `connect` handler AFTER a genuine transport disconnect + `recovered:false` — the
   * server already discarded that session (a real new server-side connection), so the
   * existing socket is safe to reuse as-is. The media-recovery-escalation and
   * tool-spiral-hard-limit call sites invoke this directly from `state === 'connected'`
   * — the control socket never dropped, so it must be replaced.
   * @param {string} why
   */
  async _coldReconnect(why) {
    if (this._coldReconnecting) return;
    this._coldReconnecting = true;
    this._clearReconnectTimer();
    // A cold reconnect gets a brand-new server-side session — any ACK the old session was
    // waiting on can never arrive now. Drop them (rule 4.2) rather than let respondToTool()
    // later resolve against a dead session. Bump the generation too, so a respondToTool()
    // already past the pending-check and mid-fetch when this fires skips its POST instead
    // of sending it against a session the server has already discarded.
    this._pendingToolAcks.clear();
    this._sessionGen++;
    const reuseSocket = this.state === 'reconnecting';   // see doc comment above
    if (!reuseSocket) { this._setState('reconnecting'); this.emit('reconnecting', { reason: why, attempt: ++this._reconnectAttempt, maxAttempts: this._maxReconnect, cold: true }); }
    const overall = deadline(TIMEOUTS.overall);
    try {
      // Drop the dead media peers before rebuilding.
      try { this._pcAsr?.close?.(); } catch { /* */ } this._pcAsr = null;
      try { this._pcStv?.close?.(); } catch { /* */ } this._pcStv = null;
      let socket = this._socket;
      if (!reuseSocket) {
        // The control socket never dropped — discard it and open a genuinely fresh
        // connection (see doc comment above; reusing a still-joined socket is the
        // exact bug this guards against).
        const old = this._socket;
        try { old?.removeAllListeners?.(); } catch { /* */ }
        socket = this._socketFactory(this._cmUrl, {
          path: '/socket.io', transports: ['websocket'],
          reconnection: true, reconnectionAttempts: this._maxReconnect,
          auth: { token: this._token },
          query: { partnerId: this._partnerId, billed_client: '', stickyId: this._stickyId, level: 'published', debugMode: true },
        });
        if (socket !== old) { try { old?.disconnect?.(); } catch { /* */ } }
        this._socket = socket;
        this._wireSocket(socket);
        // A genuinely new connection starts unconnected — wait for its own handshake
        // (mirrors connect()'s step 1) before joining. Skip only if the factory handed
        // back an already-live socket (e.g. test doubles that reuse one instance).
        if (socket.connected === false) await this._await(socket, 'onServerConnected', TIMEOUTS.serverConnect, 'ConnectionTimeout', overall);
      } else if (!socket || socket.connected === false) {
        throw new KalturaError({ type: 'about:blank', title: 'no socket', code: 'reconnect_failed', detail: 'cold reconnect needs a live socket.' });
      }
      // Re-join the room (threadId carries brain memory forward), then re-run the session create.
      this._roomId = randId(12);
      socket.emit('join', buildJoin({ room: this._roomId, ks: this._token, threadId: this._threadId, userAgent: ua(), isMobile: false, requestVars: this._requestVars }));
      await Promise.all([
        this._await(socket, 'clientConfiguration', TIMEOUTS.joinRoom, 'JoinRoomTimeout', overall),
        this._await(socket, 'joinComplete', TIMEOUTS.joinComplete, 'JoinRoomTimeout', overall),
      ]);
      await this._createSessionWithCapacity(socket, overall);
      await this._runConnectSequence(socket, overall);
      this._approve(socket);
      this._reconnectAttempt = 0;
      this._setState('connected');
      // Re-arm the hard-spiral breaker: a spiral never emits a spoken/genui segment, so
      // _wireSocket's own reset (line ~967) structurally can't fire while one is active,
      // and this success path is the only other place the session recovers cleanly. Without
      // this, `_hardSpiralRecovering` stays a one-shot latch for the rest of the session —
      // a second spiral later in the same conversation would be completely unguarded and
      // hang indefinitely (verified live: reproduces the original bug's symptom, just
      // delayed to the 2nd occurrence).
      this._hardSpiralRecovering = false;
      this._sessionToolSegCount = 0;
      this.emit('reconnected', { recovered: false });
      // Spiral recovery (see `recoverFromSpiral` doc comment in the constructor): the cold
      // reconnect above restored connectivity but abandoned the turn that triggered it — the
      // user's question would otherwise just be dropped. Resend it once, nudged to answer in
      // words only (the exact instruction the headless `Conversations#send({recoverFromSpiral})`
      // path already proved live breaks the loop). Only for THIS why — a media-recovery or
      // transport-disconnect cold reconnect never abandoned a turn, so resending there would
      // inject an unrelated, unsolicited message.
      if (why === 'tool_spiral_hard_limit' && this._recoverSpiralTurn && this._lastTurnText) {
        const resendText = this._lastTurnText;
        this._lastTurnText = null;   // consume — a later spiral must not replay stale text
        this._applyBeforeSend(`${SPIRAL_RECOVERY_PREFIX}${resendText}`, { kind: 'spiralRecovery', threadId: this._threadId })
          .then((finalText) => {
            if (this.state !== 'connected') return;
            socket.emit('onTextEntered', buildTextEntered(finalText, true));
            this._armBrainWatchdog();
            this._armResponsePending();
            this.emit('spiralRecovered', { text: resendText });
          })
          .catch((e) => this._log('error', 'spiral recovery resend blocked/failed', e));
      }
    } catch (err) {
      this._endWith(err instanceof KalturaError ? err : new KalturaError({ type: 'about:blank', title: 'cold reconnect failed', code: 'reconnect_failed', detail: String(err && err.message || err) }), 'reconnect_failed');
    } finally {
      this._coldReconnecting = false;
    }
  }

  _teardownTransports() {
    this._clearReconnectTimer();
    // Shared by disconnect() and _endWith() — any ACK still pending when the session ends
    // can never be delivered (rule 4.2: cleared on disconnect, not left to grow unbounded).
    this._pendingToolAcks.clear();
    this._clearBrainWatchdog();
    this._settleResponsePending();   // never leave the pending signal stuck across teardown
    this._clearIdleTimers();
    if (this._iceGraceTimer) { clearTimeout(this._iceGraceTimer); this._iceGraceTimer = null; }
    for (const ch of /** @type {const} */ (['asr', 'stv'])) {
      if (this._iceNewTimers[ch]) { clearTimeout(this._iceNewTimers[ch]); this._iceNewTimers[ch] = null; }
    }
    this._unwireNetwork();
    try { this._pcAsr?.close?.(); } catch { /* */ }
    try { this._pcStv?.close?.(); } catch { /* */ }
    try { this._hwMuteTimers.forEach(clearTimeout); this._hwMuteTimers = []; } catch { /* */ }
    this._stopVad();
    this._stopStatsBeacon();
    this._releaseNoiseProcessor();
    try { this._micStream?.getTracks?.().forEach((t) => { t.onmute = t.onunmute = null; t.stop?.(); }); } catch { /* */ }
    try { this._socket?.removeAllListeners?.(); this._socket?.disconnect?.(); } catch { /* */ }
    if (this._capacityTimer) { clearTimeout(this._capacityTimer); this._capacityTimer = null; }
    this._pcAsr = this._pcStv = this._micStream = this._socket = null;
  }

  _setState(s) { this.state = s; this.emit('stateChange', { state: s }); }
}

// ─────────────────────────── helpers ───────────────────────────

function fatal(event) {
  const info = FATAL_CODE[event] || { code: 'connect_failed', num: 0 };
  return new KalturaError({ type: `https://docs.kaltura.com/agentic/errors/${info.code}`, title: info.code.replace(/_/g, ' '), code: info.code, status: info.num || undefined, detail: `${event}${info.num ? ` (${info.num})` : ''}` });
}
/** Map a getUserMedia rejection to a distinct SDK code + actionable guidance (R6). */
/**
 * Enforce TLS on a transport URL (OWASP WSS/TLS; NIST SC-8). https/wss pass.
 * http/ws fail UNLESS allowInsecure (localhost/dev) — then warn loudly, once.
 * An empty URL is left to the connect-time default. @param {string} url @param {string} field @param {boolean} allowInsecure @param {(m:string)=>void} warn
 */
function assertSecureTransport(url, field, allowInsecure, warn) {
  if (!url) return;
  let u;
  try { u = new URL(url); } catch { return; }   // malformed → leave to downstream
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  if (secure) return;
  const insecure = u.protocol === 'http:' || u.protocol === 'ws:';
  if (!insecure) return;                          // unknown scheme → don't block
  const isLocal = isPrivateOrLoopbackHost(u.hostname);
  if (allowInsecure || isLocal) {
    warn(`${field} uses an insecure (${u.protocol}) transport${isLocal ? ' on localhost' : ''}. NEVER ship cleartext to production — use https/wss (NIST SC-8).`);
    return;
  }
  throw new KalturaError({
    type: 'https://docs.kaltura.com/agentic/errors/insecure_transport', title: 'insecure transport', code: 'insecure_transport',
    detail: `${field} must use https/wss (got ${u.protocol}//). Tokens and media must not travel in cleartext (OWASP/NIST SC-8). For localhost dev only, pass allowInsecureTransport:true.`,
  });
}

/** Resolve a possibly-relative URL against a base (so a relative WHEP Location → absolute). @param {string} maybeRelative @param {string} base */
function resolveUrl(maybeRelative, base) {
  try { return new URL(maybeRelative, base).href; } catch { return maybeRelative; }
}

function micError(err) {
  const name = (err && (err.name || err.constructor?.name)) || '';
  const M = {
    NotAllowedError: ['mic_permission_denied', 'Microphone permission was denied. Allow mic access in the browser/site settings and retry.'],
    SecurityError: ['mic_permission_denied', 'Microphone blocked by browser security policy (HTTPS/permissions). Allow mic access and retry.'],
    NotFoundError: ['mic_not_found', 'No microphone was found. Connect a mic (or input device) and retry.'],
    OverconstrainedError: ['mic_not_found', 'No microphone matched the requested constraints.'],
    NotReadableError: ['mic_in_use', 'The microphone is in use or unreadable (another app/tab may hold it). Close it and retry.'],
    AbortError: ['mic_in_use', 'Microphone access was aborted by the system. Retry.'],
  };
  const [code, detail] = M[name] || ['devices_permission_denied', 'getUserMedia({audio:true}) was denied or unavailable.'];
  return new KalturaError({ type: `https://docs.kaltura.com/agentic/errors/${code}`, title: code.replace(/_/g, ' '), code, detail, body: redact(String(err && err.message || err)) });
}
function timeoutErr(label) {
  return new KalturaError({ type: 'https://docs.kaltura.com/agentic/errors/timeout', title: 'timeout', code: 'timeout', detail: `${label}: timed out waiting for the server.` });
}
function deadline(ms) { const end = Date.now() + ms; return { expired: () => Date.now() > end }; }
function whepStatusHint(status) {
  if (status === 404) return 'WHEP 404 — no active STV session (recreate the session).';
  if (status === 409) return 'WHEP 409 — the stream already has a viewer.';
  if (status === 415) return 'WHEP 415 — wrong content-type (must be application/sdp).';
  return `WHEP HTTP ${status}.`;
}
function ua() { return (typeof navigator !== 'undefined' && navigator.userAgent) || 'kaltura-intelligent-agents-sdk'; }
async function defaultGetUserMedia(constraints) {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) throw new Error('getUserMedia unavailable — inject one for non-browser use.');
  return navigator.mediaDevices.getUserMedia(constraints);
}
