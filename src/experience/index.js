/**
 * @kaltura/intelligent-agents/experience — the Experience front.
 *
 * The live interactive avatar runtime (socket.io control plane + WebRTC ASR
 * uplink + WHEP STV video downlink) behind one typed-event class. Client-side
 * surface: takes only a short-lived, entitlement-ON conversation token (from
 * your server's appInit) — the admin secret never reaches it. socket.io is
 * INJECTED, never bundled, so the SDK has zero runtime dependencies.
 *
 * Presenter (deck walkthrough), GenUI (widget rendering), the AudioWorklet
 * noise-suppressor (Tier-2 BYO-DSP), and KAVA analytics (client-only
 * Application Events) are separate optional subpaths —
 * `@kaltura/intelligent-agents/experience/presenter`,
 * `@kaltura/intelligent-agents/experience/genui`,
 * `@kaltura/intelligent-agents/experience/noise-suppressor`, and
 * `@kaltura/intelligent-agents/experience/analytics` — so importing this
 * base front never pulls in any of their module graphs.
 *
 * @example
 * import { KalturaAvatarSession } from '@kaltura/intelligent-agents/experience';
 * import { io } from 'socket.io-client';            // YOUR dependency, injected
 * const session = new KalturaAvatarSession({
 *   token, conversationManagerUrl, srsBaseUrl, turnServerUrl,   // all from appInit
 *   videoEl: document.getElementById('avatar'),
 *   socketFactory: (url, opts) => io(url, opts),
 * });
 * session.on('transcript', ({ text, type }) => render(text, type));
 * session.on('disclosure', ({ disclosureText }) => banner(disclosureText));
 * await session.connect();
 * session.speak('Hello! How can I help you today?');
 */
export { KalturaAvatarSession } from './session.js';
export { CaptionService } from './captions.js';
// Kaltura media-URL helpers (real thumbnail / player-embed from an entryId; external embeds).
export { thumbnailUrl, playerEmbedUrl, externalEmbedUrl, EMBED_HOSTS } from '../core/kaltura-media.js';
export { TranscriptTracker, apportion } from './transcript.js';
// Client-side-command parser (the headless/standalone peer of session.onToolCall).
export { parseToolCall, parseToolResponseName, segmentKind, validateToolArgs } from '../core/stream.js';
export {
  turnServers, iceConfig, buildJoin, buildStvNewSession, whepUrl, whepUrlHasPrivateIp,
  buildTextEntered, isAudioMode, CAPACITY_BACKOFF, DEFAULT_CM_URL,
  EXPERIENCES, MODEL_TYPES, modelTypeWire, classifyAgentAction,
} from './wire.js';
export { Emitter } from './emitter.js';
export { KalturaError } from '../core/errors.js';
export { redact } from '../core/redact.js';
// Output-handling safety helpers (OWASP LLM05) — make the safe render path the easy one.
export { safeText, safeUrl, renderSafeLink, sanitizeJson, clampInbound } from '../core/safety.js';
// Capability consts/validators/resolver — same surface on both entry points
// so per-message `toggleCapabilities` can be authored client-side.
export {
  CAPABILITIES, CAPABILITY_STATE, CAPABILITY_DEFAULTS, CAPABILITY_INFO,
  assertCapability, assertCapabilityState, validateCapabilities,
  mergeCapabilityWrite, resolveCapabilities,
} from '../management/capabilities.js';
