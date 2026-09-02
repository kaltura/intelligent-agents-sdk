# Architecture Reference

The exact field-by-field mechanics behind [ARCHITECTURE.md](ARCHITECTURE.md) — the connect sequence, wire shapes, scaling internals, SDK module routing, and failure-mode tables. Read ARCHITECTURE.md first for the big picture; consult this doc for an exact field, timeout, or module boundary. For a from-scratch reimplementation walkthrough, see [ARCHITECTURE-RECIPE.md](ARCHITECTURE-RECIPE.md). For the exhaustive socket-event-by-event capture, see [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

**Contents**

- [Endpoints & Credentials](#endpoints--credentials)
- [Socket.IO Connection](#socketio-connection)
- [Full Connect Sequence (state-machine order)](#full-connect-sequence-state-machine-order)
- [The `join` Payload — Agent/Brain Config](#the-join-payload-step-2--this-carries-the-agentbrain-config)
- [ASR Channel — Microphone Uplink](#asr-channel--microphone-uplink-step-9)
- [STV Channel — Avatar Video Downlink](#stv-channel--avatar-video-downlink-after-connected)
- [Conversation Phase — What Streams While Connected](#conversation-phase--what-streams-while-connected)
- [Sending User Input](#sending-user-input)
- [Complete Message Catalog](#complete-message-catalog)
- [Scale & Sticky Sessions](#scale--sticky-sessions)
- [SDK Module Map & Data Flow](#sdk-module-map--data-flow)
- [Resilience & Failure Handling](#resilience--failure-handling)

---

## Endpoints & Credentials

| Thing | Value |
|---|---|
| Control socket | `wss://conversation.avatar.us.kaltura.ai` path `/socket.io` |
| STV WHEP base | `https://srs.avatar.us.kaltura.ai` |
| STV play URL | `{srsBaseUrl}/rtc/v1/play/?app=app&stream={session_id}` (or `webrtc_url` from `stvNewSession`) |
| STV WHEP signaling | `POST {srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id}` (body: plain SDP, `Content-Type: application/sdp`) |
| TURN | `turn.avatar.us.kaltura.ai` (default username/credential in `wire.js`'s `turnServers()`, overridable via `creds`). **Address it with explicit ports + transports.** A bare `turn:host` yields no relay candidate (→ `packetsSent=0`, the avatar can't hear you). Use all four: `turn:HOST:80?transport=udp`, `turn:HOST:443?transport=udp`, `turn:HOST:80?transport=tcp`, `turns:HOST:443?transport=tcp`. **`iceTransportPolicy` resolves as `forceRelay && !isFirefox ? 'relay' : 'all'`** per leg (in the built-in client's media layer). STV uses `'relay'` in every client. ASR is `'relay'` in the production runtime (`forceAsrRelay:true`) but `'all'` in the embed SDK / debug-app. The two are **functionally identical**, because the ASR server advertises only a private host candidate, so the pair relays through TURN regardless. Firefox forces `'all'` on both. So the TURN URLs are what must be correct, not the policy. Full per-client matrix: [WIRE-PROTOCOL.md §5](WIRE-PROTOCOL.md). |
| Auth | Socket.IO `auth: { token: <enrichedKS> }` + `query.partnerId` |

All of `conversationManagerUrl`, `srsBaseUrl`, `turnServerUrl`, and the enriched `ks` come from **`POST https://api.avatar.us.kaltura.ai/v1/application/appInit`** (see [API-REFERENCE.md](../API-REFERENCE.md)). The agent is identified by `partnerId` (from the KS) + the KS itself — NOT `clientId`/`flowId` (those belong to a separate, unrelated demo integration and play no role in this system).

---

## Socket.IO Connection

```js
import { io } from 'socket.io-client';

const socket = io(conversationManagerUrl, {   // from appInit
  path: '/socket.io',
  transports: ['websocket'],
  auth: { token: enrichedKs },                // from appInit
  query: {
    partnerId: '<your_partner_id>',           // derived from the KS
    clientId: undefined,                       // optional; unused for Kaltura agents
    flowId: undefined,                         // optional; unused for Kaltura agents
    billed_client: '',
    stickyId: '<random-16>',
    level: 'published',
    debugMode: true
  }
});
```

---

## Full Connect Sequence (state-machine order)

Exact order from the platform's built-in client's connection state machine. Each step waits for the named inbound event before advancing; timeouts in parens.

| # | Client does | Emits (→) / Waits (←) | Inbound event | Timeout |
|---|-------------|----------------------|---------------|---------|
| 0 | Init WebRTC session (TURN config) + `getUserMedia(audio:true,video:false)` | — | (browser mic prompt) | — |
| 1 | Open socket | ← | `onServerConnected` `{finalUrl, loadingVideoURL, agentName, hostName}` | 10s |
| 2 | Join room | → `join` (see payload below) | — | — |
| 3 | Wait config + join ack | ← `clientConfiguration`, ← `joinComplete` | both required | `clientConfiguration` 5s, `joinComplete` **20s** (both `JoinRoomTimeout`) |
| 4 | Create STV session | → `stvNewSession` `{room_id, cast_mode}` | — | — |
| 5 | Wait session | ← `stvNewSession` `{session_id, status, webrtc_url?}` (or ← `throwToNoAgent`) | sets `sessionId` + `webrtcUrl` | — |
| 6 | Wait agent | ← `showAgent` `{}` | agent joined | 10s |
| 7 | Wait ready | ← `askPermissions` `{constraints:{audio,video}}` | server ready | — |
| 8 | (optional) wait player-ready, 1s delay | — | — | — |
| 9 | Connect ASR (mic uplink) | `asr-webrtc-*` handshake (below) | — | 30s |
| 10 | Subscribe STV video (WHEP) **and wait until it is *playable*** | → WHEP `POST` → wait `<video>` `canplay` + ~300ms settle | first decoded frame | 5s |
| 11 | Approve — this is what starts the spoken greeting | → `approvedPermissions` `{client, room}` | — | — |
| → | **CONNECTED** | listen for `agent_raw_text`, `generatingSpeech`, `stvStartedTalking` | — | — |

Overall connecting timeout: 30s.

**Why step 3 has two timeouts, not one:** the server emits `clientConfiguration` immediately on join, but emits `joinComplete` only after an awaited context-update call that can exceed 5s under load. The SDK budgets the two waits separately (`clientConfiguration` 5s, `joinComplete` 20s) — see [WIRE-PROTOCOL.md §3](WIRE-PROTOCOL.md) for the full rationale. Conflating them into one 5s budget causes spurious `JoinRoomTimeout` failures on loaded rooms.

> **Ordering matters — `approvedPermissions` triggers the opening line.** Subscribe to the STV video and wait until it is actually *decoding frames* (`<video>` `canplay`, readyState ≥ `HAVE_FUTURE_DATA`, plus a short jitter-buffer settle) **before** emitting `approvedPermissions`. ICE `connected` fires ~2s before the first frame decodes — approving on ICE alone means the first 1–2s of the greeting is spoken into a pipe the user can't see/hear yet and is clipped. The platform's built-in client gates approval on **both** mic-ready AND video-ready; the SDK reproduces this in `src/experience/session.js` (`_approve`, gated on the same canplay/`HAVE_FUTURE_DATA` settle logic).

---

## The `join` payload (step 2) — this carries the agent/brain config

```js
socket.emit('join', {
  client: clientId,            // optional
  room: roomId,                // a client-generated room id (also sent as 'channel')
  channel: roomId,
  kaltura: {
    entryId: <entryId>,            // only if context is a media entry
    context_id: <contextId>,       // category/entry the KB is scoped to
    threadId: <existingThreadId>,  // to resume a conversation thread
    force_experience: 'avatar_only',
    capabilities: {                // brain capabilities — same enum as intellect config
      avatar: 'on',
      generate_followup_questions: 'on',
      use_knowledge_base: 'off',   // forced off when an entryId is set
      // use_content_search, include_sources, etc.
    }
  },
  userAgent, userAgentHints, isMobile,
  channel_password: null, peer_name: 'unknown',
  peer_video: false, peer_audio: true
});
```

- **Which intellect loads.** The `geniegpcid:<configId>` in the KS tells the server which intellect (brain) to load.
- **Which `join` fields the server actually reads.** Of the `kaltura` sub-fields the client sends in `join`, the session server consumes `ks`, `entryId`, `threadId`, `contextId`, `contextType`, `capabilities`, and `request_vars` when present.
- **`force_experience` is hardcoded server-side, not read from the client.** `force_experience` alone is **not** read by the server; it is fixed server-side to `force_experience: 'avatar_only'` and `model_type: 'fast'` on every converse call — so the avatar runtime never requests `flashcards`/`summarization` experiences regardless of what the client sends.
- **`capabilities` and `request_vars` are genuinely client-controlled.** By contrast, these two are read at `join` time and can also be updated mid-session via the `updateGenieContext` socket event, then merged over defaults with no server-side allowlist before being forwarded to the brain.
- **The live socket carries the same brain protocol as the HTTP API.** The socket exchanges JSON frames `{event:'init'|'converse'|'abort', data:{…}}` and streams `agent_raw_text` back — the same envelope as HTTP `/assistant/converse`, documented in [API-REFERENCE.md](../API-REFERENCE.md), which is the path for headless/text integrations; the live avatar runtime uses the socket instead.

---

## ASR Channel — Microphone Uplink (step 9)

A WebRTC peer connection whose SDP/ICE are relayed **through the socket** (NOT WHEP). From the platform's built-in client's ASR connection handler:

```js
// 1. tell server to prepare
socket.emit('asr-webrtc-init', { sessionId: peerId });
// 2. wait
socket.once('asr-webrtc-ready', ...);          // (or 'asr-webrtc-error')   timeout 30s
// 3. create RTCPeerConnection with the mic track, generate offer, then:
socket.emit('asr-webrtc-offer', { offer, is_reconnect: false });
socket.once('asr-webrtc-answer', ({ answer }) => pc.setRemoteDescription(answer));  // 30s
// 4. trickle ICE both ways
socket.emit('asr-webrtc-ice-candidate', { candidate });
// (server may push its own candidates on the same event name)
```

PeerConnection config: TURN `turn.avatar.us.kaltura.ai` (default username/credential from `wire.js`'s `turnServers()`, four explicit port/transport URLs — see Endpoints table above), `iceTransportPolicy` per the leg's `forceRelay` flag (production runtime forces `'relay'` for ASR; the no-SDK debug-app uses `'all'` — both relay in practice since the server only offers a private candidate), audio constraints `{echoCancellation, autoGainControl, noiseReduction}`, no video. Once connected, the server transcribes your speech and routes it to the brain automatically — there is no separate "send transcript" call.

---

## STV Channel — Avatar Video Downlink (after CONNECTED)

Standard **SRS WHEP** — completely independent of the socket. From the platform's built-in client's SRS signaling adapter:

```js
const playUrl = stvNewSession.webrtc_url
  ?? `${srsBaseUrl}/rtc/v1/play/?app=app&stream=${session_id}`;

// create a recv-only RTCPeerConnection, addTransceiver('video'|'audio', {direction:'recvonly'})
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

const answerSdp = await fetch(`${srsBaseUrl}/rtc/v1/whep/?app=app&stream=${session_id}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/sdp' },
  body: offer.sdp                       // plain SDP text, NOT JSON
}).then(r => r.text());                 // answer is plain SDP text

await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
pc.ontrack = (e) => { videoEl.srcObject = e.streams[0]; };  // the avatar video
```

That's it — a vanilla WHEP subscribe. The avatar's face+voice stream into your `<video>`.

---

## Conversation Phase — What Streams While Connected

Three parallel listeners (the platform's built-in client's connected-state handler):

### 1. Brain output — `agent_raw_text` (the intelligence)

The server streams the brain's response as deltas. Envelope:

```js
socket.on('agent_raw_text', ({ speechId, turnId, delta }) => {
  const d = JSON.parse(delta);   // delta is a JSON string:
  // { messageId, threadId?, role?, type?, content?, segmentNumber?,
  //   segmentStart?, segmentEnd?, et?, metadata?, event?, status? }
});
```

`type` values: `think`, `text`, `unisphere-tool`, `tool`, `tool_response`, `avatar`, `error`, `share`, `thread` — the same set as `/assistant/converse` (the live runtime wraps the same brain stream). The first `agent_raw_text` on the live socket additionally carries an **`init_response`** delta (`openingPhrase`/`threadId`/`messageId`) — that one is a WebSocket-only frame from the brain's websocket handler, not an HTTP-converse segment. The `type` is the LLM's code-fence tag (open-ended) for content blocks, plus the fixed control types `think`/`tool`/`tool_response`/`error`; see [WIRE-PROTOCOL.md §4e](WIRE-PROTOCOL.md).

- Only `text`, `unisphere-tool`, `error` carry display content; the rest are agent-internal.
- A `share` chunk with `segmentStart && segmentEnd` marks **message complete**.
- `threadId` appears in deltas — capture it to resume the thread later.

This is the **same brain and same stream format** as the text-only brain `/assistant/converse` API — the avatar runtime just delivers it over the socket instead of HTTP.

### 2. Talking state — for UI/turn-taking

```js
socket.on('stvStartedTalking',  ()           => {/* avatar began speaking */});
socket.on('stvFinishedTalking', ({agentContent}) => {/* done; final text */});
socket.on('agent_start_speech', ({speechId, isNewTurn, turnId}) => {/* speech boundary */});
```

### 3. Lifecycle

```js
socket.on('conversationEnded', () => {/* server ended it → teardown */});
socket.on('conversationTimeWarning', ({remainingTime}) => {/* seconds left */});
```

---

## Sending User Input

Two ways the user drives the conversation:

1. **Voice (primary)** — just speak. The ASR channel publishes mic audio; the server transcribes and feeds the brain. No client call needed.

2. **Text injection** — drive the live avatar by text instead of voice. This is a *socket* event (the same channel ASR transcripts use), NOT an `/assistant/converse` HTTP call — HTTP converse is a separate stateless chat that never reaches the avatar's speech engine, so the avatar stays silent. Verified working via the SDK's own `session.speak()` (`src/experience/session.js`):

   ```js
   // the isSpeechStart marker interrupts a mid-sentence avatar (no-op if idle)
   socket.emit('debug_text_entered', { text: '', isFinal: false, isSpeechStart: true });
   socket.emit('debug_text_entered', { text, isFinal: true });   // captured client emit name
   ```
The server handler is `onTextEntered` (the session server's text-injection handler), which reads only `{ text, isFinal, isSpeechStart? }` and routes the text to the same pipeline as ASR transcripts (`vadSpeechDetected`), keyed by the socket's own room (`room: socket.id`). It does **not** read `room_id`/`session_id` — those are ignored server-side. (The client-side text-entry emitter only sends `{text,isFinal}` — despite that, the injected text is spoken.) For purely **typed** chat (no avatar), the production chat UI instead calls `/assistant/converse` directly with the `geniegpcid` KS. See [WIRE-PROTOCOL.md §4a](WIRE-PROTOCOL.md).

---

## Complete Message Catalog

The exhaustive, field-by-field event catalog — every client emit and server event with its payload shape and subscriber — lives in **[WIRE-PROTOCOL.md §4](WIRE-PROTOCOL.md)** (§4a client→server, §4b–§4d server→client, §4e the parsed `agent_raw_text.delta` types). The connect-sequence steps above name the key events in order; that doc is the reference for each one's exact shape.

---

## Scale & Sticky Sessions

The session server runs as a **horizontally-scaled pool of pods** behind a load balancer, with a fixed number of concurrent avatar "agent slots" per pod. Three mechanisms make this work: sticky routing, a capacity queue, and shared cross-pod state.

### Sticky routing — `stickyId`

The single most important scaling detail. A live avatar session is **stateful and pinned to one pod** (it owns the ASR peer connection, the speech pipeline, and the brain conversation). Socket.IO starts on HTTP long-**polling** and only later upgrades to WebSocket — those initial polling requests must all reach the *same* pod, or the handshake breaks.

- The client generates a fresh `stickyId` per `connect()` — `nanoid(16)` in the platform's built-in client, `generateId(8)+generateId(8)` in the embed SDK. Both are 16-char random tokens.
- It is sent as a **socket query param** (`query.stickyId`), so it's present on every polling request and the WebSocket upgrade.
- The load balancer hashes/affixes on it to route all of that session's requests to one session-server pod.
- Generated per-connection, not persisted: a brand-new `connect()` gets a new pod assignment. There is **no session migration** across pods — a pod loss ends the session (see recovery below).

The STV video channel does **not** need stickiness — it's stateless SRS WHEP (`srs.avatar.us.kaltura.ai`), scaled independently and frontable by CDN/anycast.

### Capacity & the queue (`throwToNoAgent` / `throwToExceededTier`)

Each pod has a bounded number of agent slots (the face-renderer + brain pipeline is expensive). Two distinct "full" signals:

| Signal | Meaning | Client behavior |
|---|---|---|
| `throwToNoAgent` | All agent slots currently busy (transient) | Enter **availability queue** (poll until a slot frees) |
| `throwToExceededTier` | Account plan/tier limit hit (hard) | Fail immediately — `TIER_EXCEEDED`, not recoverable |

**The queue (transient capacity):**

- Capacity is polled **out-of-band** via `checkAvailability` → `availabilityResult {available, …}`; that poll **never disconnects**, so the socket stays open during the wait. (Note: a `throwToNoAgent` returned from the `stvNewSession` path is *terminal* — the session server's join handler calls `socket.disconnect()` right after emitting it — so capacity handling is the proactive poll loop, not "react to `throwToNoAgent` on a live socket".)
- Poll delay cycle (embed SDK): `[30s, 45s, 1m, 1.5m, 2m, 3m, 4m, 5m, 6m]`, wrapping via modulo — effectively infinite backoff with a cap, bounded by `maxWaitMs`.
- The platform's built-in client mirrors this: an `availability` parallel state that loops `checkAgentsAvailability` (emit `checkAvailability`, await `availabilityResult`, 10s timeout) with a 5s retry delay while `unavailable`.
- When a positive `availabilityResult` arrives, the client emits **`join` (then `stvNewSession`) on the same socket** (same pod, sticky preserved) — no reconnect, state stays `CONNECTING`. The non-disconnecting `checkAvailability` poll is what preserves stickiness. The 15s connect timeout is cancelled once the queue activates; the queue runs its own `maxWaitMs`.

Session validity is checked separately via `isValidSession` → `validSession` / `throwToExceededTier` / `throwToBadRequest`.

### Connection recovery vs. session recovery

- **Transport blips** — Socket.IO's built-in `connectionStateRecovery`: if `socket.active` on disconnect, it auto-reconnects with exponential backoff + jitter and may restore the same socket (`socket.recovered === true`). A short blip doesn't tear down the avatar.
- **Recoverable transport drop** (within ~20s) — the **server preserves the session same-pod**: the session server's join handler enables Socket.IO `connectionStateRecovery` (`maxDisconnectionDuration = CONNECTION_STATE_RECOVERY_TIMEOUT`, default 20s, floor 5s, cap 10min); the live STV/ASR session + in-memory state survive and the `join` handler skips re-init (`session.hasJoined`). **This SDK's `KalturaAvatarSession` exploits this** — it rides recovery, emits `reconnecting`/`reconnected`, and does not re-`join`.
- **Permanent disconnect** (`socket.active === false`, or past the recovery window) — the session is gone; the avatar must reconnect fresh (new `stickyId`, likely a different pod, new agent slot). Same-pod resume exists (above); **cross-pod resume does not** — only the brain thread is resumable via `threadId`.
- Distinct timeouts pinpoint where it broke: `HANDSHAKE_TIMEOUT` (transport up, server silent → activate queue) vs `CONNECTION_TIMEOUT` (transport never came up).

### Cross-pod shared state (data plane)

Pods are stateless-enough to scale because shared state lives in managed backing services:

| Service category | Role in scaling |
|---|---|
| **Shared cache / state store** | Session cache, resource/slot accounting, and routing state — clustered and replicated |
| **Async work queue** | Hands off work between the renderer, brain, and pipeline stages |
| **Durable registry** | Session/agent registry & coordination that survives a pod restart |
| **STV renderer + media relay** | Video origin — renders the face and relays it to clients over **WHEP** (URL varies by `cast_mode`). Scaled independently of the control plane |
| **Edge (CDN + WAF)** | Fronts the public surface; enforces origin/CDN-header validation on public API endpoints |

So "agent availability" isn't per-pod guesswork — slot accounting is centralized in the shared state store, which is what `checkAvailability` consults. Concretely, a slot is available when **STV has free capacity** (unless the call is speech-only) **AND the ASR service is available AND `activeCalls < maxCalls`**; `maxCalls` comes from the `CALL_CAPACITY` env (default 20 in prod / 12 in non-prod). `availabilityResult.details` surfaces exactly these: `{stvAvailable, whisperAvailable, activeCalls, maxCalls, capacityAvailable}`. The brain conversation/thread state is also externalized (the same thread is resumable via `threadId` regardless of which pod handles a later turn over the text API).

For what a custom (no-Kaltura-lib) client must implement to work correctly with this scaling model, see [ARCHITECTURE-RECIPE.md's "Implications for a Custom Client"](ARCHITECTURE-RECIPE.md#implications-for-a-custom-no-kaltura-lib-client).

---

## SDK Module Map & Data Flow

This section is the **source-of-truth map** of the SDK's internals: how a call flows from a typed method to the right backend, and the routing/data-flow rules README doesn't cover.

### Two entry points, one shared core

- **`./management`** (`Management`, `src/management/client.js`) — the REST control plane. Holds the admin secret, mints tokens, routes to the two REST hosts (Agentic API + brain API) and OVP, and enforces the two-KS guard via `assertAdmin`/`assertConversation` (`assertKind` in `client.js`) **before any network call**. Resource namespaces hang off it: `sessions`, `agents`, `avatars`, `catalog`, `application`, `intellects`, `intellectConfig`, `tools`, `conversations`, `threads`, `messages`, `feedback`, `followups`, `knowledge`. `tools` is a standalone, partner-level entity — an intellect only references it via `tool_ids`. One sub-resource mounts on `intellects`: `intellects.secrets`.
- **`./experience`** (`KalturaAvatarSession`, `src/experience/session.js`) — the live socket+WHEP runtime from [ARCHITECTURE.md's "Video Runtime Protocol"](ARCHITECTURE.md#video-runtime-protocol--the-big-picture). Takes only a short-lived conversation token; socket.io is INJECTED (`socketFactory`), never bundled. Two optional plugin subpaths hang off this same live runtime without loading into apps that don't need them: `./experience/presenter` (the `Presenter` deck helper) and `./experience/genui` (the `ExperienceRenderer` GenUI layer).
- **`src/core/*`** — the shared leaf layer both fronts depend on: `http.js` (transport), `errors.js` (`KalturaError`, RFC 9457), `session.js` (`Sessions` token-minter + `makeAuditEmitter`), `stream.js` (converse NDJSON/SSE parser + `collectConverse`/`segmentKind`/`GENUI_RUNTIMES` — the closed enum of GenUI runtime names the brain's `unisphere-tool` segments can carry), `redact.js`, `safety.js`, `ids.js` (`meta()` receipts), `knowledge-enums.js` (`CHAPTER_TYPE`/`STRATEGY`/`EMBED`/`MODALITIES`/`normalizeModality`/`buildIndexerObjects`). Core never imports from `management/` or `experience/` (stays a leaf).

> **Branch security on the minted `Token`, never on `inspectKs(realKs).kind`.** The public `inspectKs` export (`@kaltura/intelligent-agents/management`, `src/management/ks-inspect.js`) decodes only a KSv2 token's **plaintext header**: it reliably returns `{partnerId}`, but a real encrypted KS's privileges are AES-encrypted, so it returns `kind:'opaque'`, `disableEntitlement:null`, `encrypted:true`. `kind`/`disableEntitlement` are populated **only** for unencrypted test tokens. To decide what a token may do, read the `.kind` of the minted `Token` object (it records what it was minted with: `admin`/`conversation`/`agent`/`widget`), not `inspectKs` of an opaque production KS.

### Management modules (what each does, where it writes)

| Module (`src/management/`) | Exposes | Backend the writes hit |
|---|---|---|
| `intellects.js` | `Intellects` — DTO CRUD (`add`/`get`/`update`/`delete`), `addExternal`/`listExternal`/`listInternal`, prompt authoring (`setPrompts`/`previewPrompt`/`snapshot`/`restore`/`diffSnapshots`), capabilities (`getCapabilities`/`setCapability`/`setCapabilities`/`resolveCapabilities`), `setClientVariablesEnabled`, brain config (`setBrainConfig`/`getBrainConfig`/`brainConfigAvailable`), `buildBrainConfigPatch`. Mounts `secrets` (tools are a separate top-level resource — see `tools.js`). | the brain `v1/intellect/*` for DTO fields; the brain `partner-config/update`/`get` for brain config (gated) |
| `intellect-config.js` | `IntellectConfig` (`mgmt.intellectConfig`) — the ONE shared `patch(configId, patch\|fn, ks)` primitive + typed field setters incl. `setToolIds` (the intellect-side `tool_ids` reference list) + `describe()` (an `editable`/`readOnly` map). `buildUserPropertiesForms`. | the brain `v1/intellect/update` (read-modify-write, full-replace dicts; `tool_ids` is a plain array write) |
| `capabilities.js` | `CAPABILITIES`/`CAPABILITY_STATE`/`CAPABILITY_DEFAULTS`/`CAPABILITY_INFO`, `assertCapability`/`assertCapabilityState`/`validateCapabilities`, `resolveCapabilities` (pure layered resolver), `mergeCapabilityWrite`. Re-exported from BOTH entry points. | pure — no network |
| `tools.js` | `tools.api`/`csv`/`code` builders + `tools.client` (authors a native, silent client-side command tool with NO server-side call — requires `kaltura_genie_experiences:'off'`; see [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md)) + `tools.clientToolReadiness` + `tools.validate`, `class Tools` (`mgmt.tools`: `add`/`get`/`list`/`update`/`remove` over the standalone Tool entity), `applyResponseMapping`. | the brain `v1/tool/*` (partner-level entity CRUD — NOT `intellect/update`; link via `intellectConfig.setToolIds`'s `tool_ids`) |
| `secrets.js` | `IntellectSecrets` (`mgmt.intellects.secrets`: `listNames`/`has`/`set`/`remove`/`replaceAll`/`validate`), `validateSecretRefs`. Write-only values; name-only read contract (no `redact()` reliance). | the brain `v1/intellect/update` `config.secrets` (mask-and-keep merge) |
| `prompt-lint.js` | pure: `lintPrompts`/`validatePromptVars`/`lintGlossary`/`assembleSystemPrompt`/`SYS_VARS`. Client-side prompt-preview replica (author layer only). | pure — no network |
| `conversations.js` | `Conversations` (`stream`/`send`, `assertRequestVars`), `Threads`/`Messages`/`Feedback`/`Followups`, `Knowledge` (`addRecord` + `knowledge_ids` linkage — Path A, ungated; `uploadDocument`, `createCategory`/`findOrCreateCategory`, `linkCategory`/`linkRecords`/`linkAvailable`, `corpusStatus`, `getLinkage`, `setEnabled`, `search`, `isIndexed`). | the brain's `assistant/converse` (converse); the brain's `v1/knowledge/add` + intellect `knowledge_ids` (Path A, ungated); OVP `category/*`+upload (containers); the brain's `partner-config/update` (Path B re-point, gated) |
| `provision.js` | `provision()` — the agent factory; optional `knowledge`/`tools`/`capabilities` blocks layer after the core create (`tools` creates each Tool entity via `mgmt.tools.add`, then links the successful ids in one `intellectConfig.setToolIds` write). | both hosts |

The top-level headless converse surface lives on the `Management` class itself: `converse(configId, message, opts?, ks?)` (AsyncGenerator over `conversations.stream`) and `converseOnce(...)` (delegates to `conversations.send`). Both auto-mint a conversation token from `configId` when `ks` is omitted, so the admin secret never leaves the server. `opts` carries `{threadId, sse, model_type, force_experience, request_vars, capabilities, recoverFromSpiral}`; `assertRequestVars` rejects reserved keys + non-scalar values before the wire. `opts.capabilities` is a per-message `{name:state}` override validated client-side, but the server-side **DISABLED veto still wins** — a stored/env-disabled capability cannot be turned on per message (e.g. `converse(cfg, msg, {capabilities:{use_web_search:'on'}})` is honored only if `use_web_search` is not disabled by a stored layer). `opts.recoverFromSpiral:true` on `conversations.send`/`converseOnce` sends one same-thread nudge retry (`SPIRAL_RECOVERY_PREFIX`) when the first attempt comes back `spiralStopped:true` with empty text — see `stream.js`'s `collectConverse` entry above for what it's recovering from.

> **Scope-guard timing on the streaming path.** `conversations.stream(...)` is an **async generator**, so its `assertConversation(ks)` scope check fires on the **first** `.next()`/iteration — NOT at call time. `const g = k.conversations.stream(opts, adminKs)` without iterating gets no guard yet (despite the client's "before any network call" framing, which holds for the non-generator methods). For **eager** scope validation, use `conversations.send(...)`/`converseOnce(...)` — they assert the token kind synchronously before returning. The non-generator reads (`conversations.status`, all `agents`/`avatars`/`catalog` calls) guard at call time as documented.

### `resolveCapabilities` return shape (the 15 names are nested, not top-level)

`resolveCapabilities(layers)` (`src/management/capabilities.js`) returns a **two-key** object — `{ capabilities, _meta }` — so `Object.keys(result).length === 2`. The 15 `AssistantCapability` states live **under `.capabilities`**, keyed by name, NOT at the top level:

```js
const { capabilities, _meta } = k.intellects.resolveCapabilities({
  partnerConfig: stored,                       // from intellects.getCapabilities
  request: { use_web_search: 'off' },          // per-turn override to model
});
capabilities.avatar.state;          // 'on' | 'off' | 'disabled'
capabilities.avatar.resolvedFrom;   // which layer won
capabilities.use_web_search.inferred; // true — see best-effort note below
```

Each per-name entry is `{ state, resolvedFrom, vetoed, inferred?, layers }`:

- `resolvedFrom` is one of `request | partner_config | env | default | disabled_veto | web_search_config`. **`default` only appears when you pass an explicit empty `env: {}`** — when `env` is **omitted**, the resolver supplies `CAPABILITY_DEFAULTS` *as the env layer*, so an unset capability resolves `resolvedFrom:'env'` (e.g. `resolveCapabilities({}).capabilities.avatar.resolvedFrom === 'env'`).
- `vetoed:true` (with `resolvedFrom:'disabled_veto'`, `state:'off'`) when `env` OR `partnerConfig` marks the capability `disabled` — a hard override no per-request `on` can lift.
- `use_web_search` always carries **`inferred:true`**: the resolver does not read `web_search_config`, and a present config force-sets it ON server-side — so treat its resolved state as best-effort.

A **freshly created** intellect returns an **empty `capabilities {}`** from `getCapabilities` (nothing stored yet), so every name then resolves from the env/default layer until you `setCapability`/`setCapabilities`.

### Experience GenUI layer

`src/experience/genui/` turns brain `unisphere-tool` segments into framework-agnostic render descriptors:

- `parse.js` — pure: `normalizeRuntime` (strips the wire `-tool` suffix), `RUNTIMES` (the nine first-class widgets), `parseWidget`/`parseContent` (forgiving JSON-then-line parser; unknown keys → `.raw`, never throws), `isKnownRuntime`.
- `segments.js` — `SegmentAssembler`: buffers deltas and flushes a complete widget on `runtimeName`/`speechId` change or turn end.
- `renderer.js` — `ExperienceRenderer`: **dual-mode**. LIVE `start()` subscribes to `session.on('brainSegment')`; HEADLESS `render(runtime, widget)` is fed from `Management.conversations.stream()` (the reliable widget path, since the live runtime hardcodes `force_experience:'avatar_only'`). Unknown runtimes yield a safe `{kind:'unknown'}` fallback + `onUnhandled` — never thrown, never faked.
- `renderers/*.js` — one default renderer per runtime, each routing untrusted LLM output through `core/safety.js` (`safeText`/`safeUrl`, no `innerHTML`).

`session.js` wires the **guardrail gate**: each `agent_raw_text` delta is classified by `classifyAgentAction` (`wire.js` — reads `seg.metadata.runtimeName`/`widgetName` + the adapter-normalized `seg.type` with `-tool` stripped) and, when a capability policy or `onAgentAction` hook is present, run through `_gateAgentAction` BEFORE `emit('brainSegment', d)` (default-allow so existing nav/GenUI flows are untouched; a veto emits `agentActionDenied` + an `agent.action.deny` audit event). `Presenter` exposes `covered`/`questions`/`lastNav` (`{target, reason, at}`); `session.micEnabled` is a read getter.

### Routing rule: partner-config DTO vs intellect DTO (where a field goes)

This is the load-bearing design rule for the management layer — **a write goes to exactly one of two doors, and they have different auth gates**:

- **Intellect DTO** → the brain's `v1/intellect/*`. Carries `prompts`, `base_directive`, `glossary`, `capabilities`, `tools`, `secrets`, `user_properties_forms`, `allow_client_variables`, `knowledge_ids`, `name`/`description`/`tags`/`status`. Writable with a **partner admin KS** today. **Knowledge linkage Path A rides this door**: first call `POST /v1/knowledge/add` on the brain host (returns an `{id,...}` record), then pass the returned id as `knowledge_ids` in the intellect create/update DTO — linkage + `use_knowledge_base:'on'` persist with no `partner-config/update` and no 403. It is a `model_fields_set` PATCH (omitted TOP-LEVEL fields are preserved) — but `capabilities`/`secrets` are **full-replace sub-dicts**, so the SDK read-merge-writes them (via `mergeCapabilityWrite` / the secrets mask-and-keep guard); `IntellectConfig.patch` is the one place that logic lives.
- **Partner-config DTO** → the brain's `partner-config/update`/`get`. Carries brain config (`agent_llm`/`agent_fast_llm`/rate limits + the best-effort `agent_avatar_llm`/`run_quota_check`/`web_search_config`), and the **Path B** knowledge `indexer` re-point (re-pointing an *existing* intellect at a category corpus). These are **deployment-gated** — `partner-config/update` 403s for a partner admin KS on the current deployment (see § Configure the Brain in API-REFERENCE.md). Every such write PROBES first (`brainConfigAvailable`/`linkAvailable`) and, when the door is closed, returns `{applied:false, code, reason}` WITHOUT throwing or faking success. (Note: this gate is Path B only — the ungated `knowledge_ids` Path A above does NOT touch this door.)

When designing a new field setter, decide its door by which DTO genuinely accepts it (the `IntellectConfig` `EDITABLE_FIELDS` vs `READ_ONLY_FIELDS` constants encode this), and route reads to the SAME door. `getBrainConfig` reads `partner-config/get`, NOT `intellects.get`, because the intellect read DTO does not expose those fields (reading them via `intellects.get` would falsely report persisted values as unset).

### Honest limits surfaced by the SDK

[README.md's "Honest limits"](../README.md#honest-limits) covers the partner-config 403 gate, no-verbatim-speech, and the `force_experience`/`model_type` hint caveats — read that first. The rest are architecture-level limits not covered there:

- **External intellects are stored but NOT wired** — `addExternal` persists `{url, protocol}` and lists them, but the brain does not delegate to them at converse time. The SDK stamps `_meta.runtimeWired:false`.
- **Secrets are write-only** — values never read back; the no-leak guarantee is the name-only response contract, not `redact()`. Client-side encryption / BYOK is server-managed (not buildable).
- **`previewPrompt`/`snapshot`/`restore` are client-side** — a replica of the author layer only (server-injected capability-conditional prompt blocks are not reproducible) and a browser-local history (the server has no versioning).
- **`agent/list` has no server-side filter today** — `agents.list(ks)` must send `filter:{}` (every guessed key — `{objectType:'AgentListFilter'}`, `{displayNameLike}`, `{adminTagsMultiLikeOr}` — returns an opaque `bad_request`). Filter **client-side**: `await k.agents.list(ks).all().then(l => l.filter(a => a.adminTags?.includes('my-tag')))`. Tag the **agent** with `adminTags` at create time to group; avatars carry no tag field (`avatar/create`/`update` reject `adminTags`).

The SDK's own `node:test` suite (`test/`) exercises every one of these surfaces against the real backend and against injected fakes — see `README.md` for the full command list.

---

## Resilience & Failure Handling

How the system behaves under network failures, disconnects, and device problems. There are **three reconnection tiers**, only loosely coordinated:

| Tier | Layer | Auto-recovers? | Scope |
|---|---|---|---|
| 1. Socket.IO transport | control socket | ✅ built-in (backoff + jitter + state recovery) | the websocket only |
| 2. WebRTC peer (ASR + STV) | the built-in client's media layer | ✅ 5 attempts × 2s, independent per channel | the media peer connections |
| 3. Avatar session | **this SDK** (`KalturaAvatarSession`) | ✅ socket-transport recovery: a recoverable drop → `reconnecting` → `reconnected` (same-pod, ≤~20s, no re-`join`); non-recoverable → clean `ended`. | the whole conversation |

The headline risk: **tiers 2 and 3 are not wired together for custom non-SDK clients** — the SDK wires them via `_recoverMedia` → `_coldReconnect`; when the WebRTC layer exhausts retries and emits `'failed'`, a custom client that does not use the SDK's `KalturaAvatarSession` must handle this itself.

### Device permissions (mic/camera)

`connecting → gettingUserMedia` calls `getUserMedia(audio:true, video:false)` on the built-in client's media layer — **audio only** by default; the avatar doesn't need your camera. On denial, the runtime client's device-media handler routes to `error` with `reason: DevicesPermissionDenied`, `skipDisconnect:true`, `suppressNotification:true` (and `shouldPurge=false`) — a clean, retryable abort with no scary toast. The SDK (`KalturaAvatarSession`) surfaces distinct `NotAllowed`/`NotFound`/`NotReadable` codes; the platform's built-in client's classification is coarse (no `NotAllowedError` vs `NotFoundError` vs `NotReadableError` distinction). No pre-flight `navigator.permissions.query`, no mid-call device-loss handling.

### WebRTC media peer (the built-in client's media layer)

- Config: `maxReconnectAttempts = 5`, `reconnectDelayMs = 2000` (fixed). ICE timers (`rtc-core` constants): connect-start 20s, no-SDP-answer 30s, disconnect-grace 60s.
- **ASR reconnection** (`handleAsrReconnection`): closes the peer, fully re-joins (new offer/answer via socket relay), **preserves mute state**. After 5 tries → emits `onConnectionState({type:'asr', status:'failed'})`.
- **STV reconnection** (`handleStvReconnection`): re-runs WHEP `joinSTV`. If WHEP returns **404 NO_ACTIVE_SESSION**, gives up immediately (server session gone — only the app can recreate it). After 5 tries → `'failed'`.

### Control socket & session machine (the platform's built-in client)

- Socket.IO built-in recovery: on `disconnect` with `socket.active`, auto-reconnects (may restore the same socket via `connectionStateRecovery`).
- But the runtime client's error handler converts every `disconnect`/`connect_error`/`error`/`removePeer`/`throwTo*` into a machine `Disconnect` → teardown. The session machine has **no auto-reconnect**; recovery is user-initiated.
- Connect-phase hang protection is strong: every sub-state has a timeout (5–30s). Teardown is reliable (routes through `disconnected` even on failure; resets the player-ready singleton). Disconnect reasons (the runtime client's notification layer) drive user-readable, severity-tagged messages.

### Failure-mode matrix

| Failure | Detected by | Handling today |
|---|---|---|
| User denies mic permission | `getUserMedia` throws | Clean abort, no toast, retry possible |
| No mic / mic busy | `getUserMedia` throws | Same generic path (not distinguished) |
| ASR/STV peer drops | the built-in client's media layer ICE state | 5× re-join @ 2s; SDK handles via `_onIceStateChange`; the platform's built-in client's wrapper leaves `failed` event unhandled |
| STV server session gone (404) | WHEP status | Give up; app must recreate session |
| Control socket transient drop | Socket.IO `disconnect` | Socket.IO auto-recovers… but the runtime client's error handler may also tear down |
| Control socket permanent drop | Socket.IO `disconnect` (`!active`) | Teardown + "reconnect" notification |
| All agent slots busy | `throwToNoAgent` | Availability queue + poll (see [Scale & Sticky Sessions](#scale--sticky-sessions) above) |
| Plan/tier exceeded | `throwToExceededTier` | Fatal, clear message |
| Connect hangs | SDK: `setTimeout` (`TIMEOUTS` constants); the platform's built-in client: internal state-machine timeouts | 5–30s timeouts → error (well covered) |
| Player/video element error | `onPlayerError` chain | → `Disconnect` (`PlayerConnectionFailed`) |
| Brain stalls mid-conversation | `KalturaAvatarSession` watchdog | `brainStalled` event, repeating every `brainStallMs` until output lands; the platform's built-in client has no liveness timeout |
| Tool-call spiral (same command retried with no narration) | `KalturaAvatarSession` two-tier circuit breaker | Soft signal (`toolSpiralDetected`) + hard cold-reconnect recovery — see [Tool-call spiral: what happened and how it's mitigated](#tool-call-spiral-what-happened-and-how-its-mitigated) below |
| Tab backgrounded / network change | `KalturaAvatarSession` | `online`/`offline`/`visibilitychange` handling in SDK; the platform's built-in client does not handle these events |

### Tool-call spiral: what happened and how it's mitigated

A tool-eager brain can loop the *same* client command many times in one turn instead of narrating — a worst case observed in production: `show_widget` retried 438× over 9 minutes with zero spoken output. `KalturaAvatarSession` defends against this with a two-tier circuit breaker.

**Soft tier — signal only.** Once a *turn* accumulates `toolSpiralLimit` (default 10) raw `type:"tool"` segments (counted before dedup, since a spiral IS the same call repeating), the SDK emits `toolSpiralDetected` once. This is signal only; it no longer calls `interrupt()`. An earlier version called `interrupt()` (`tapToTalkStart`/`tapToTalkEnd`) here to try to yield the runaway turn back to the client. Two live incidents killed that approach:

1. A repro proved `interrupt()` has no observable effect on a spiral already running server-side — the identical `show_widget` call kept repeating for 5+ minutes past the soft trip, including through a server-pushed idle "wake-up" turn whose `agent_start_speech` reset the *per-turn* counter and let the soft breaker "detect" and `interrupt()` again, while the spiral underneath never actually stopped, until the socket itself died (`transport close` → `JoinRoomTimeout`).
2. Worse, `interrupt()` was actively harmful: per `WIRE-PROTOCOL.md`'s documented barge-in semantics, a mid-turn `tapToTalkStart` forces an early `stvFinishedTalking` with **truncated** `agentContent` — so the soft trip was silently cutting the turn's own narration (`avatarStopTalking` fired with empty text), with no mechanism to reopen the talking channel once the brain went on to stream a complete, correct spoken answer for that same turn.

The default limit was also raised from 6 to 10, because a legitimate turn can double its raw tool-segment count when `speak()`'s barge-in branch (still-playing TTS audio from a prior turn) spawns a parallel tap-to-talk stream for the same question — a 3-tool turn duplicating into 6 raw segments this way previously tripped the breaker on an ordinary turn, not a real spiral.

**Hard tier — the actual fix.** A **session-scoped hard counter** (`hardToolSpiralLimit`, default `toolSpiralLimit * 3`) counts raw tool segments since the last perceivable output and is immune to turn-boundary resets — an idle wake-up nudge mid-spiral cannot hide it. Once it's crossed, the SDK emits `toolSpiralRecovering` (carrying `lastTurnText`, the abandoned turn) and forces `_coldReconnect()` — the same full media rebuild already used for a dead media channel, replaying `threadId` so brain memory continues. This turns the eventual uncontrolled `JoinRoomTimeout` into a deliberate, bounded, self-healing reconnect.

Because the control socket is still live at this point (unlike a genuine transport drop), `_coldReconnect()` opens a brand-new socket rather than re-`join`-ing the still-connected one — the server's `join` handler is idempotent-guarded per-connection and silently no-ops a re-join on a live socket (reproduced live as `JoinRoomTimeout`). `_coldReconnect()` detects this case (`this.state !== 'reconnecting'` at entry means the socket never actually dropped) and opens a genuinely new socket via the same factory `connect()` uses, before re-`join`-ing on it. The one path that safely reuses the existing socket is the genuine-transport-disconnect case, reached only after a real drop already set `state` to `'reconnecting'` — there the server has already discarded that session, so re-`join`-ing it is not a no-op.

The hard guard re-arms on a successful cold reconnect, not just on perceivable output — a spiral by definition never produces spoken/GenUI content, so that's the only reset path that can actually fire while one is running. Without this re-arm, a second spiral later in the same session would find the guard permanently latched from the first recovery and hang indefinitely, reproducing the original symptom just delayed to the second occurrence.

A cold reconnect restores connectivity and brain memory (`threadId`) but otherwise abandons the turn that triggered it. With `recoverFromSpiral` (default `true`), the SDK auto-resends that turn's tracked text once (from `speak()` or ASR's `userTranscription`), prefixed with `SPIRAL_RECOVERY_PREFIX` (the same nudge used on the headless `Conversations#send({recoverFromSpiral:true})` path), and emits `spiralRecovered {text}`. `recoverFromSpiral:false` suppresses the resend and leaves it to the app via `lastTurnText`. All three thresholds (`brainStallMs`, `toolSpiralLimit`, `hardToolSpiralLimit`) are configurable at construction; `0` disables any of them. The platform's built-in client has no such breaker. Author-side mitigation (a tool-call budget in the system prompt) and the headless-path equivalent are covered in [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md)'s "Tool spirals starve the voice" — this section documents only the SDK's own recovery mechanism.

`KalturaChatSession` (the HTTP text transport) ports the soft tier only: `cfg.toolSpiralLimit` (default 10, same counting rule) emits the same `toolSpiralDetected {count, limit}` once per turn. There's no hard tier here — a chat turn is one stateless HTTPS request with no socket to cold-reconnect, so a stuck turn is bounded by the caller's own `sendText({signal})` abort, not by a session-level recovery mechanism.

### Session-completion signal (`session_completed`) — telling the backend a conversation is truly over

Without this, the backend only learns a thread is done when its idle scanner sweeps (~10 min default), so end-of-conversation lifecycle rules (summaries, insights, CRM pushes) fire minutes late, and a closed tab looks identical to a user who just walked away. `KalturaAvatarSession`, `KalturaChatSession`, and `KalturaAgentSession` all POST `{genieUrl}/thread/session_completed` (`{"id":"<threadId>"}`, the same conversation KS as every other client call) the moment a conversation genuinely ends — including tab-close, backgrounding, and bfcache freeze — without ever firing on an internal transition like a mode switch, and without ending a thread another tab is still using. Full config surface: [README.md § Ending a conversation cleanly](../README.md#ending-a-conversation-cleanly-session_completed-signal). Wire shape: [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

| Trigger | Fires? | Why |
|---|---|---|
| App calls `disconnect()` / `stop()` | yes | Unambiguous hangup |
| Idle auto-logoff | yes | Real end of session |
| `pagehide` (tab/window closed, navigated away) | yes | The primary win over the idle-scanner fallback |
| `pagehide` with `persisted:true` (bfcache freeze) | yes, by default | The SDK can't survive the freeze anyway — media/socket are already torn down |
| Hidden longer than `hiddenGraceMs` (default 30s) | yes, by default | Catches iOS Safari / Chrome Android tab-kills where `pagehide` never fires |
| Server ends the conversation (`conversationEnded`) | no, by default | The backend already knows; re-signaling wastes a redundant lifecycle-rule evaluation |
| `KalturaAgentSession.switchMode()` tearing down the old transport | no | Thread continuity is the entire point of switching modes |
| Fatal/unrecoverable error (`_endWith()`) | no | An error isn't a clean end; the app may reconnect and continue the same thread |
| A second tab on the same thread is still alive (`crossTabPresence`, same-origin/same-device only via `BroadcastChannel`) | no — suppressed | Avoids ending a thread another tab is actively using; the last tab standing still fires |

The signal is idempotent (a repeat POST for the same thread is a server-side no-op) and never awaited on the unload path — `fetch(url, {keepalive:true})`, not `navigator.sendBeacon` (which can't carry the `Authorization` header). Cross-device duplicate tabs are out of scope by design (`BroadcastChannel` is same-origin/same-device only); the backend's own self-healing on the next real message covers that case.

### What's already solid (don't regress)

- Connect-phase hang protection (per-substate timeouts).
- Clean teardown (no stale connection state; player-ready reset).
- Permission-denied UX (silent, retryable).
- TURN relay for connectivity behind hostile NATs (STV forces relay; ASR relays in practice regardless of policy — see [Endpoints & Credentials](#endpoints--credentials) above).
- Mute-state preservation across ASR reconnects.
- Capacity queue (graceful waiting vs hard failure).
- Distinct, user-readable disconnect reasons.
- WHEP 404 short-circuit.
- **SDK (`KalturaAvatarSession`) implements**: ICE restart (`_recoverMedia`), socket-transport recovery, a repeating brain-stall watchdog + `brainStalled` event and a two-tier tool-call-spiral circuit breaker (`toolSpiralDetected` soft, `toolSpiralRecovering` + cold reconnect hard), granular device error codes — `NotAllowed`/`NotFound`/`NotReadable`, and `online`/`offline`/`visibilitychange` handling. These limitations apply only to custom clients that bypass the SDK.
