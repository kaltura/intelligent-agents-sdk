/**
 * Wire helpers — pure functions that build the exact socket payloads and ICE
 * configs the live runtime expects (WIRE-PROTOCOL §2–§6; verified against
 * captures/session-evidence.json). No I/O, no state — unit-testable in isolation
 * and reused by the session machine.
 */
import { parseToolCall, UNISPHERE_RUNTIMES } from '../core/stream.js';
import { isPrivateOrLoopbackHost } from '../core/net-guard.js';

/** Default conversation-manager host (overridden by appInit's conversationManagerUrl). */
export const DEFAULT_CM_URL = 'https://conversation.avatar.us.kaltura.ai';

/**
 * The valid `force_experience` values (single source of truth). The brain rejects
 * anything else with HTTP 422, so the SDK validates against this list BEFORE the
 * network call. Used by both buildJoin (live) and conversations.stream (headless).
 */
export const EXPERIENCES = ['markdown', 'summarization', 'flashcards', 'avatar_only'];

/**
 * The `model_type` wire values (LOWERCASE — API-REFERENCE §4.1; the Genie bridge
 * hardcodes `model_type:'fast'`). There is NO verified `'DEFAULT'` literal: the
 * PRIMARY model is selected by OMITTING the field entirely. So the only explicit
 * value the SDK ever sends is `'fast'`; `primary` is a sentinel meaning "omit".
 *
 * HONESTY: the SDK can SEND `model_type:'fast'` but
 * cannot prove which model replied (`agent_fast_llm` is studio-only) — callers
 * assert acceptance, not model identity.
 * @type {{readonly fast:'fast', readonly primary:null}}
 */
export const MODEL_TYPES = Object.freeze({ fast: 'fast', primary: null });

/**
 * Normalize a caller-supplied model selector to its wire value, or `undefined`
 * (= OMIT the field, selecting the primary model). Accepts `'fast'` (any case),
 * `'primary'`/`'default'`/empty/null (→ omit). Anything else throws via the
 * caller's validator; here we only canonicalize the two documented choices.
 * Pure, never throws.
 * @param {unknown} sel
 * @returns {('fast'|undefined)}
 */
export function modelTypeWire(sel) {
  if (typeof sel !== 'string') return undefined;
  return sel.trim().toLowerCase() === 'fast' ? 'fast' : undefined;
}

/**
 * Map a streamed brain segment to the AGENT-initiated action it represents, for
 * the guardrail gate (`_gateAgentAction`; OWASP LLM06 Excessive Agency). Returns
 * `null` for spoken/control segments (text/avatar/think/turn) so the gate is
 * SKIPPED — the default-allow path keeps existing nav/GenUI flowing untouched.
 *
 * WIRE TRUTH (W14 must-fix, verified against the CM adapter + the earnings app's
 * `handleBrainSegment`): a real GenUI segment carries its runtime in
 * `seg.metadata.runtimeName` (NOT a top-level `seg.runtimeName`) and an
 * adapter-normalized `seg.type` ending in `-tool` (e.g. `followups-tool`). We
 * read BOTH and strip the trailing `-tool`. The synthetic `navigate` action has
 * NO real typed segment — real nav is a `type:"tool"` call (`navigate_to_slide`),
 * which already maps to `tool-call` above; Presenter never parses spoken text.
 * We classify `type:'navigate'` only so a SYNTHETIC test fixture can exercise
 * the veto; the docs label that demo synthetic.
 *
 * Mapping (→ `_gateAgentAction` action types):
 *   - `type:"tool"` native function call → `tool-call` (runtime = the tool name)
 *   - `user-properties-form`            → `structured-data-form`
 *   - any other genui runtime (the nine UNISPHERE tools)  → `render-genui`
 *   - `navigate` (synthetic only)       → `navigate`
 *   - spoken/control/empty              → `null` (not gated)
 *
 * `sources`/`followups` map to `render-genui` (NOT a distinct vetoable type) so
 * the default policy never blocks them — only an explicit `genui:false` would.
 * A `tool-call` carries the parsed `{name,args}` in `payload` (via
 * {@link import('../core/stream.js').parseToolCall}) so the guardrail hook can
 * veto a specific client command by name. Pure, never throws.
 * @param {unknown} seg A parsed brainSegment object.
 * @returns {{type:string, runtime:string, runtimeName:string, widgetName:string, payload:any}|null}
 */
export function classifyAgentAction(seg) {
  if (!seg || typeof seg !== 'object') return null;
  const s = /** @type {Record<string, any>} */ (seg);

  // Native function-calling tool call (the client-side-command channel). The
  // tool name doubles as the action `runtime` so a policy/hook can gate by name.
  if (s.type === 'tool') {
    const call = parseToolCall(s);
    if (!call) return null;
    return { type: 'tool-call', runtime: call.name, runtimeName: call.name, widgetName: '', payload: call };
  }

  const metadata = (s.metadata && typeof s.metadata === 'object') ? s.metadata : {};
  const runtimeName = pickStr(metadata.runtimeName, s.runtimeName, s.runtime_name);
  const widgetName = pickStr(metadata.widgetName, s.widgetName, s.widget_name);
  // Normalize the segment type / runtime by stripping the trailing `-tool`.
  const typeKey = stripTool(s.type);
  const runtime = stripTool(runtimeName) || (RUNTIME_KEYS.has(typeKey) ? typeKey : '');

  // Synthetic navigate (no real typed nav segment — see Presenter for real nav).
  if (typeKey === 'navigate' || runtime === 'navigate') {
    return { type: 'navigate', runtime: 'navigate', runtimeName, widgetName, payload: s.content ?? s.payload ?? null };
  }
  if (!runtime) return null;   // spoken/control/empty → not a gateable action
  const type = runtime === 'user-properties-form' ? 'structured-data-form' : 'render-genui';
  return { type, runtime, runtimeName, widgetName, payload: s.content ?? null };
}

/**
 * The adapter-normalized GenUI runtime keys (after `-tool` stripping). DERIVED
 * from `core/stream.js`'s `UNISPHERE_RUNTIMES` (the single source of truth) —
 * the same derivation `genui/parse.js`'s `RUNTIMES` uses — so the two lists can
 * never drift (previously hand-rolled here with a stray `'summarization'` that
 * doesn't match the wire's actual `'summary-tool'`).
 */
const RUNTIME_KEYS = new Set(UNISPHERE_RUNTIMES.map((r) => r.replace(/-tool$/, '')));

/** Strip a trailing `-tool` suffix from a wire type/runtime; '' for non-strings. @param {unknown} v */
function stripTool(v) { return typeof v === 'string' ? v.trim().replace(/-tool$/, '') : ''; }
/** First non-empty trimmed string among candidates, else ''. @param {...unknown} cands */
function pickStr(...cands) { for (const c of cands) if (typeof c === 'string' && c.trim()) return c.trim(); return ''; }

/**
 * Build the 4-URL TURN block. Explicit ports+transports are REQUIRED — a bare
 * `turn:host` yields no relay candidate and the uplink silently sends 0 packets
 * (WIRE-PROTOCOL §5). The shared static credential is `kaltura`/`avatar`.
 * @param {string} turnServerUrl Hostname (with or without `turn:`/trailing slash).
 * @param {{username?:string, credential?:string}} [creds]
 */
export function turnServers(turnServerUrl, creds = {}) {
  const host = String(turnServerUrl || '').replace(/\/$/, '').replace(/^turns?:/, '');
  if (!host) return null;
  return {
    urls: [
      `turn:${host}:80?transport=udp`,
      `turn:${host}:443?transport=udp`,
      `turn:${host}:80?transport=tcp`,
      `turns:${host}:443?transport=tcp`,
    ],
    username: creds.username || 'kaltura',
    credential: creds.credential || 'avatar',
  };
}

/**
 * RTCConfiguration per channel. ASR → `all`; STV → `relay` (both `all` on
 * Firefox). Either relays in practice (the ASR server offers only a private
 * candidate) — but the policy is set to match the production clients.
 * @param {'asr'|'stv'} channel @param {ReturnType<typeof turnServers>} turn @param {boolean} [isFirefox]
 */
export function iceConfig(channel, turn, isFirefox = false) {
  const policy = channel === 'stv' ? (isFirefox ? 'all' : 'relay') : 'all';
  return { iceServers: turn ? [turn] : [], iceTransportPolicy: policy, bundlePolicy: 'max-bundle' };
}

/**
 * The `join` payload (WIRE-PROTOCOL §4a; evidence `out join`). The server reads
 * `kaltura.{ks,entryId,threadId}` and routes by socket.id; the rest is sent for
 * parity with the production clients.
 *
 * IMPORTANT (verified live): `kaltura.ks` (the enriched conversation KS from
 * appInit) MUST be included — without it the conversation-manager accepts the
 * socket and emits `onServerConnected` but then never responds to `join`
 * (no `clientConfiguration`/`joinComplete`), and the connect stalls/drops.
 * @param {object} opts {room, ks, threadId?, entryId?, contextId?, capabilities?, userAgent?, isMobile?, client?, requestVars?}
 */
export function buildJoin(opts) {
  const kaltura = {
    context_id: opts.contextId,
    threadId: opts.threadId,
    force_experience: 'avatar_only',
    capabilities: opts.capabilities || { avatar: 'on', generate_followup_questions: 'on' },
  };
  if (opts.ks) kaltura.ks = opts.ks;          // required by the live runtime to advance past join
  if (opts.entryId) kaltura.entryId = opts.entryId;
  // Join-time `{{var}}` Jinja values (issue #31 gap 3) — already validated by the caller
  // (`assertRequestVars`) before this is built; passed through as-is on the wire.
  if (opts.requestVars) kaltura.request_vars = opts.requestVars;
  return {
    client: opts.client,
    room: opts.room,
    channel: opts.room,
    kaltura,
    userAgent: opts.userAgent || '',
    userAgentHints: null,
    isMobile: !!opts.isMobile,
    channel_password: null,
    peer_name: 'unknown',
    peer_video: false,
    peer_audio: true,
  };
}

/**
 * The `stvNewSession` create payload. `cast_mode` selects the egress: default/
 * omit ⇒ SRS WHEP (working). NEVER default to `'webrtc'` (leaks a private STV
 * address and fails); the SDK only ever omits it.
 * @param {string} roomId @param {string} [castMode]
 */
export function buildStvNewSession(roomId, castMode) {
  return castMode ? { room_id: roomId, cast_mode: castMode } : { room_id: roomId };
}

/**
 * The WHEP play URL. Prefer the server-returned `webrtc_url`; else build the SRS
 * form. (WIRE-PROTOCOL §6.)
 * @param {string|undefined} webrtcUrl @param {string} srsBaseUrl @param {string} sessionId
 */
export function whepUrl(webrtcUrl, srsBaseUrl, sessionId) {
  if (webrtcUrl) return webrtcUrl;
  return `${String(srsBaseUrl).replace(/\/$/, '')}/rtc/v1/whep/?app=app&stream=${sessionId}`;
}

/** True if a WHEP URL's host is a private/loopback/link-local address (the broken STV-direct egress). @param {string} url */
export function whepUrlHasPrivateIp(url) {
  return isPrivateOrLoopbackHost(String(url));
}

/** The text-injection payload for {@link speak}. @param {string} text @param {boolean} [isFinal] @param {boolean} [isSpeechStart] */
export function buildTextEntered(text, isFinal = true, isSpeechStart) {
  const p = { text, isFinal };
  if (isSpeechStart !== undefined) p.isSpeechStart = isSpeechStart;
  return p;
}

/** Detect the audio/phone-mode stvNewSession reply (no STV video). @param {any} payload */
export function isAudioMode(payload) {
  return !!(payload && payload.status && /no STV session/i.test(payload.status));
}

/** Capacity re-poll backoff schedule (seconds), wrap modulo (WIRE-PROTOCOL §4b). */
export const CAPACITY_BACKOFF = [30, 45, 60, 90, 120, 180, 240, 300, 360];
