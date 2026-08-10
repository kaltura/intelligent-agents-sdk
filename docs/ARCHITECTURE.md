# Platform Architecture — Agentic Avatar System

For **platform developers**: how the whole system works end to end — the backend services, the text-conversation flow, the live-video runtime wire protocol, how it scales, and how it handles failure. Enough detail to reimplement any layer with **zero dependency** on Kaltura's apps, widgets, or libraries (just a Socket.IO client + standard WebRTC).

**Source of truth.** Reverse-engineered and verified against the running system: the avatar management backend (management plane — organized internally into agent / avatar / catalog / intellect / application modules), the Genie brain backend (organized internally into assistant / thread / message / feedback / followup / intellect / knowledge modules), the avatar runtime client (the browser-side connection state machine + XState connect machine), the WebRTC avatar engine (the client-side session object driving the ASR/STV peer connections), the scripted-video control service (the scripted-video control API at `/v1/avatar-session/*`), and the avatar infrastructure module. Symbol names below are the stable contracts to navigate by; exact details live in [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

**Companion docs.** New here? [GETTING-STARTED.md](../GETTING-STARTED.md). Building an app? [API-REFERENCE.md](../API-REFERENCE.md). Driving your UI from the avatar? [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md).

---

## The Three Planes

The system is three planes. An app uses only the planes it needs.

| Plane | What it does | Backend host | Where documented |
|-------|-------------|-------------|------------------|
| **Management** | Create/configure agents, avatars, intellects, catalog, sessions | `api.avatar.us.kaltura.ai` | [API-REFERENCE.md](../API-REFERENCE.md) |
| **Conversation (text)** | The AI brain — chat, memory, structured output | `genie.nvp1.ovp.kaltura.com` | "Text Conversation Flow" below |
| **Runtime (video)** | Live photorealistic talking avatar over WebRTC | conversation-manager + SRS + brain | "Video Runtime Protocol" below |

---

## Backend Services Map

| Service | Public host | Responsibility |
|---|---|---|
| avatar management backend | `api.avatar.us.kaltura.ai/v1` | Agents, avatars, catalog (incl. ElevenLabs voice cloning), `studio-intellect` proxy, `application/*` utilities. Organized internally into agent/avatar/catalog/intellect/application modules; routes follow a `<prefix>/<action>` convention (e.g. catalog prefix is `catalog-item`). |
| scripted-video control service | `api.avatar.us.kaltura.ai/v1/avatar-session/*` (nginx-proxied) | The **scripted-video** control API: `avatar-session/create` (KS) → `init-client` → `keep-alive` (10s) → `end`. Served by the scripted-video control service, NOT the avatar management backend — only the host/path prefix is shared via proxy. |
| Genie brain backend | `genie.nvp1.ovp.kaltura.com` | The brain: `assistant/converse`, intellect CRUD, threads, messages, feedback, followups |
| conversation-manager | `conversation.avatar.us.kaltura.ai` | Live-avatar control plane (Socket.IO): session orchestration, ASR signaling relay, brain output stream |
| STV + media server | `srs.avatar.us.kaltura.ai` (egress host) | Video origin. The **STV controller** renders the talking face and pushes it via **RTMP into OvenMediaEngine (OME)**; clients always receive it via **WHEP** (never RTMP). Two egress modes via `cast_mode`: **SRS WHEP** (wire `cast_mode:'rtmp'`, the working default) → `{srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id}`; **STV-direct** (wire `cast_mode:'webrtc'`) → the STV server's own `/whep/session/{session_id}` (fails when encryptAddress key is not configured server-side — leaks a private IP; default SRS path unaffected). Played with **OvenPlayer**. |
| TURN | `turn.avatar.us.kaltura.ai` | WebRTC relay for both media legs (user `kaltura` / cred `avatar`). Addressed with explicit ports+transports (see Endpoints table). STV uses `iceTransportPolicy:'relay'`; ASR's policy is client-dependent but **relays via TURN either way** (the ASR server only advertises a private candidate). See [WIRE-PROTOCOL.md §5](WIRE-PROTOCOL.md) for the per-client matrix. |
| ML services | internal | Machine-learning services behind `application/generateAgentProfile` |

---

## Text Conversation Flow

The simplest intelligent path — no video, fully headless. Client → `POST https://genie.nvp1.ovp.kaltura.com/assistant/converse` with a `geniegpcid:<configId>` KS. The response is an NDJSON (or SSE) stream of segments; the brain runs server-side. Segment `type` values and parsing rules are identical to the avatar's `agent_raw_text` stream (see "Conversation Phase" below). Full endpoint details: [API-REFERENCE.md](../API-REFERENCE.md).

---

## Video Runtime Protocol

The live talking avatar — the full bidirectional protocol.

### The Big Picture

A full interactive agentic avatar is **three concurrent channels** over one Socket.IO connection plus two WebRTC peer connections:

```
                          ┌───────────────────────────────────────────────┐
                          │   conversation.avatar.us.kaltura.ai           │
                          │   (Socket.IO control plane + agent brain)     │
   ┌──────────┐  socket   │                                               │
   │          │◄─────────►│  • handshake / join / session                 │
   │  YOUR    │           │  • agent_raw_text  (brain output, NDJSON)     │
   │  BROWSER │           │  • stvStartedTalking / stvFinishedTalking     │
   │  CLIENT  │           │  • ASR WebRTC signaling relay                 │
   │          │           └───────────────────────────────────────────────┘
   │          │  WebRTC (ASR, mic→server)   via socket-relayed SDP/ICE
   │          │═════════════════════════════════════════►  speech-to-text + brain
   │          │
   │          │  WebRTC (STV, server→video) via SRS WHEP (HTTP SDP)
   │  <video> │◄═════════════════════════════════════════  srs.avatar.us.kaltura.ai
   └──────────┘
```

- **Control plane** — one Socket.IO connection. Carries the handshake, the agent's streaming text, talking state, and ASR signaling.
- **ASR channel (uplink)** — a WebRTC peer connection that publishes your **microphone** to the server. SDP offer/answer + ICE are relayed **through the Socket.IO connection** (custom `asr-webrtc-*` events). The server runs speech-to-text → feeds the Genie brain.
- **STV channel (downlink)** — a WebRTC peer connection that receives the **avatar video+audio**. Uses standard **SRS WHEP** (plain-SDP-over-HTTP), independent of the socket.

The brain (Genie) runs entirely server-side. The client never calls an LLM — it publishes audio, receives video, and receives the brain's text as `agent_raw_text` deltas (identical format to the `/assistant/converse` NDJSON).

> For the **exhaustive** map — every socket event with its captured payload + repo source, the exact ICE/SDP/WHEP config, the parsed `agent_raw_text` delta types, and a turn-by-turn event trace — see **[WIRE-PROTOCOL.md](WIRE-PROTOCOL.md)** (built from a live capture cross-referenced to the private repos). This section is the orientation; that doc is the reference.

---

### Endpoints & Credentials

| Thing | Value |
|---|---|
| Control socket | `wss://conversation.avatar.us.kaltura.ai` path `/socket.io` |
| STV WHEP base | `https://srs.avatar.us.kaltura.ai` |
| STV play URL | `{srsBaseUrl}/rtc/v1/play/?app=app&stream={session_id}` (or `webrtc_url` from `stvNewSession`) |
| STV WHEP signaling | `POST {srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id}` (body: plain SDP, `Content-Type: application/sdp`) |
| TURN | `turn.avatar.us.kaltura.ai`, username `kaltura`, credential `avatar`. **Address it with explicit ports + transports** — a bare `turn:host` yields no relay candidate (→ `packetsSent=0`, the avatar can't hear you). Use all four: `turn:HOST:80?transport=udp`, `turn:HOST:443?transport=udp`, `turn:HOST:80?transport=tcp`, `turns:HOST:443?transport=tcp`. **`iceTransportPolicy` resolves as `forceRelay && !isFirefox ? 'relay' : 'all'`** per leg (in the WebRTC avatar engine's session client). STV → `'relay'` in every client; ASR is `'relay'` in the production runtime (`forceAsrRelay:true`) but `'all'` in the embed SDK / debug-app — **functionally identical**, because the ASR server advertises only a private host candidate so the pair relays through TURN regardless. Firefox forces `'all'` on both. So the TURN URLs are what must be correct, not the policy. Full per-client matrix + source lines: [WIRE-PROTOCOL.md §5](WIRE-PROTOCOL.md). |
| Auth | Socket.IO `auth: { token: <enrichedKS> }` + `query.partnerId` |

All of `conversationManagerUrl`, `srsBaseUrl`, `turnServerUrl`, and the enriched `ks` come from **`POST https://api.avatar.us.kaltura.ai/v1/application/appInit`** (see [API-REFERENCE.md](../API-REFERENCE.md)). The agent is identified by `partnerId` (from the KS) + the KS itself — NOT `clientId`/`flowId` (those are the unrelated eself demo path).

---

### Socket.IO Connection

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

### Full Connect Sequence (state-machine order)

Exact order from the avatar runtime client's connection state machine. Each step waits for the named inbound event before advancing; timeouts in parens.

| # | Client does | Emits (→) / Waits (←) | Inbound event | Timeout |
|---|-------------|----------------------|---------------|---------|
| 0 | Init WebRTC session (TURN config) + `getUserMedia(audio:true,video:false)` | — | (browser mic prompt) | — |
| 1 | Open socket | ← | `onServerConnected` `{finalUrl, loadingVideoURL, agentName, hostName}` | 10s |
| 2 | Join room | → `join` (see payload below) | — | — |
| 3 | Wait config + join ack | ← `clientConfiguration`, ← `joinComplete` | both required | 5s |
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

> **Ordering matters — `approvedPermissions` triggers the opening line.** Subscribe to the STV video and wait until it is actually *decoding frames* (`<video>` `canplay`, readyState ≥ `HAVE_FUTURE_DATA`, plus a short jitter-buffer settle) **before** emitting `approvedPermissions`. ICE `connected` fires ~2s before the first frame decodes — approving on ICE alone means the first 1–2s of the greeting is spoken into a pipe the user can't see/hear yet and is clipped. The reference client gates approval on **both** mic-ready AND video-ready (the WebRTC avatar engine's permission-approval check); the SDK reproduces this in `src/experience/session.js` (`_approve`, gated on the same canplay/`HAVE_FUTURE_DATA` settle logic).

### The `join` payload (step 2) — this carries the agent/brain config

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
    capabilities: {                // Genie capabilities — same enum as intellect config
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

The `geniegpcid:<configId>` in the KS tells the server **which intellect (brain)** to load. Of the `kaltura` sub-fields the client sends in `join`, the conversation-manager server's join handler consumes `ks`, `entryId`, `threadId`, `contextId`, `contextType`, `capabilities`, and `request_vars` when present. `force_experience` alone is **not** read by the server; it is set instead in the conversation-manager-to-Genie bridge, which **hardcodes** `force_experience: 'avatar_only'` and `model_type: 'fast'` (per its in-source TODO) on every converse call, so the avatar runtime never requests `flashcards`/`summarization` experiences regardless of what the client sends. `capabilities` and `request_vars`, by contrast, genuinely are client-controlled. They are read at `join` time, and can also be updated mid-session via the `updateGenieContext` socket event, then merged over defaults with no server-side allowlist before being forwarded to Genie. The bridge itself is a **WebSocket** client to Genie at `/assistant/ws`, not HTTP `/assistant/converse`: it exchanges JSON frames `{event:'init'|'converse'|'abort', data:{…}}` and streams `agent_raw_text` back. HTTP `/assistant/converse`, documented in [API-REFERENCE.md](../API-REFERENCE.md), is the path for headless/text integrations; the live runtime uses the socket.

---

### ASR Channel — Microphone Uplink (step 9)

A WebRTC peer connection whose SDP/ICE are relayed **through the socket** (NOT WHEP). From the avatar runtime client's ASR connection handler:

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

PeerConnection config: TURN `turn.avatar.us.kaltura.ai` (user `kaltura`, cred `avatar`, four explicit port/transport URLs — see Endpoints table), `iceTransportPolicy` per the leg's `forceRelay` flag (production runtime forces `'relay'` for ASR; the no-SDK debug-app uses `'all'` — both relay in practice since the server only offers a private candidate), audio constraints `{echoCancellation, autoGainControl, noiseReduction}`, no video. Once connected, the server transcribes your speech and routes it to the brain automatically — there is no separate "send transcript" call.

---

### STV Channel — Avatar Video Downlink (after CONNECTED)

Standard **SRS WHEP** — completely independent of the socket. From the avatar runtime client's SRS signaling adapter:

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

### Conversation Phase — What Streams While Connected

Three parallel listeners (the avatar runtime client's connected-state handler):

### 1. Brain output — `agent_raw_text` (the intelligence)

The server streams the brain's response as deltas. Envelope (`agentRawTextSchema`):

```js
socket.on('agent_raw_text', ({ speechId, turnId, delta }) => {
  const d = JSON.parse(delta);   // delta is a JSON string (agentRawTextDeltaSchema):
  // { messageId, threadId?, role?, type?, content?, segmentNumber?,
  //   segmentStart?, segmentEnd?, et?, metadata?, event?, status? }
});
```
`type` values: `think`, `text`, `unisphere-tool`, `tool`, `tool_response`, `avatar`, `error`, `share`, `thread` — the same set as `/assistant/converse` (the live runtime wraps the same brain stream). The first `agent_raw_text` on the live socket additionally carries an **`init_response`** delta (`openingPhrase`/`threadId`/`messageId`) — that one is a WebSocket-only frame from the Genie brain backend's websocket handler, not an HTTP-converse segment. The `type` is the LLM's code-fence tag (open-ended) for content blocks, plus the fixed control types `think`/`tool`/`tool_response`/`error`; see [WIRE-PROTOCOL.md §4e](WIRE-PROTOCOL.md).

- Only `text`, `unisphere-tool`, `error` carry display content; the rest are agent-internal.
- A `share` chunk with `segmentStart && segmentEnd` marks **message complete**.
- `threadId` appears in deltas — capture it to resume the thread later.

This is the **same brain and same stream format** as the text-only Genie `/assistant/converse` API — the avatar runtime just delivers it over the socket instead of HTTP.

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

### Sending User Input

Two ways the user drives the conversation:

1. **Voice (primary)** — just speak. The ASR channel publishes mic audio; the server transcribes and feeds the brain. No client call needed.

2. **Text injection** — drive the live avatar by text instead of voice. This is a *socket* event
   (the same channel ASR transcripts use), NOT an `/assistant/converse` HTTP call — HTTP converse is
   a separate stateless chat that never reaches the avatar's speech engine, so the avatar stays
   silent. Verified working via the SDK's own `session.speak()` (`src/experience/session.js`):

   ```js
   // the isSpeechStart marker interrupts a mid-sentence avatar (no-op if idle) — issue #39
   socket.emit('debug_text_entered', { text: '', isFinal: false, isSpeechStart: true });
   socket.emit('debug_text_entered', { text, isFinal: true });   // captured client emit name
   ```
   The server handler is `onTextEntered` (the conversation-manager's text-injection handler), which reads only `{ text, isFinal, isSpeechStart? }` and routes the text to the same pipeline as ASR transcripts (`vadSpeechDetected`), keyed by the socket's own room (`room: socket.id`). It does **not** read `room_id`/`session_id` — those appear in captures but are ignored server-side. (The avatar runtime client's own text-entry emitter sends only `{text,isFinal}` and its TODO says "this event does nothing," but the live capture confirms the injected text **is** spoken.) For purely **typed** chat (no avatar), the production chat UI instead calls Genie `/assistant/converse` directly with the `geniegpcid` KS. See [WIRE-PROTOCOL.md §4a](WIRE-PROTOCOL.md).

---

### Complete Message Catalog

The exhaustive, field-by-field event catalog — every client emit and server event with its captured payload, source cite, and subscriber — lives in **[WIRE-PROTOCOL.md §4](WIRE-PROTOCOL.md)** (§4a client→server, §4b–§4d server→client, §4e the parsed `agent_raw_text.delta` types). The connect-sequence steps above name the key events in order; that doc is the reference for each one's exact shape.

---

### Minimal Reimplementation Recipe (no Kaltura libs)

```
1. Backend: POST /v1/application/appInit (widget KS)
   → { ks, conversationManagerUrl, srsBaseUrl, turnServerUrl, avatars[] }

2. Browser: getUserMedia({audio:true})

3. socket = io(conversationManagerUrl, {path:'/socket.io', transports:['websocket'],
       auth:{token:ks}, query:{partnerId, level:'published', stickyId, billed_client:''}})

4. Run the connect sequence (table above): join → stvNewSession → showAgent → askPermissions
   → asr-webrtc handshake (publish mic pc via socket relay)

5. STV: WHEP POST {srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id} with recvonly offer,
   setRemoteDescription(answer), pc.ontrack → <video>.srcObject → await <video> canplay

6. ONLY NOW → approvedPermissions  (gating on playable video avoids clipping the greeting)

7. Listen: agent_raw_text (brain text), generatingSpeech, stvStarted/FinishedTalking (turn state)

8. User speaks → ASR pc carries audio → server transcribes → brain → avatar speaks (STV) + agent_raw_text
   (or inject text: emit debug_text_entered {text, isFinal:true} → server handler onTextEntered)
```

Dependencies: `socket.io-client` + the browser's native `RTCPeerConnection`. Nothing else. The WebRTC avatar engine's client package is just a convenience wrapper around exactly these steps (`joinASR` = the socket-relayed offer/answer; `joinSTV` = the WHEP subscribe).

---

## Scale & Sticky Sessions

The conversation manager is a **horizontally-scaled pool of pods** behind a load balancer, with a fixed number of concurrent avatar "agent slots" per pod. Three mechanisms make this work: sticky routing, a capacity queue, and shared cross-pod state.

### Sticky routing — `stickyId`

The single most important scaling detail. A live avatar session is **stateful and pinned to one pod** (it owns the ASR peer connection, the speech pipeline, and the brain conversation). Socket.IO starts on HTTP long-**polling** and only later upgrades to WebSocket — those initial polling requests must all reach the *same* pod, or the handshake breaks.

- The client generates a fresh `stickyId` per `connect()` — `nanoid(16)` in the avatar runtime client, `generateId(8)+generateId(8)` in the embed SDK. Both are 16-char random tokens.
- It is sent as a **socket query param** (`query.stickyId`), so it's present on every polling request and the WebSocket upgrade.
- The load balancer hashes/affixes on it to route all of that session's requests to one conversation-manager pod.
- Generated per-connection, not persisted: a brand-new `connect()` gets a new pod assignment. There is **no session migration** across pods — a pod loss ends the session (see recovery below).

The STV video channel does **not** need stickiness — it's stateless SRS WHEP (`srs.avatar.us.kaltura.ai`), scaled independently and frontable by CDN/anycast.

### Capacity & the queue (`throwToNoAgent` / `throwToExceededTier`)

Each pod has a bounded number of agent slots (the face-renderer + brain pipeline is expensive). Two distinct "full" signals:

| Signal | Meaning | Client behavior |
|---|---|---|
| `throwToNoAgent` | All agent slots currently busy (transient) | Enter **availability queue** (poll until a slot frees) |
| `throwToExceededTier` | Account plan/tier limit hit (hard) | Fail immediately — `TIER_EXCEEDED`, not recoverable |

**The queue (transient capacity):**

- Capacity is polled **out-of-band** via `checkAvailability` → `availabilityResult {available, …}`; that poll **never disconnects**, so the socket stays open during the wait. (Note: a `throwToNoAgent` returned from the `stvNewSession` path is *terminal* — the conversation-manager's join handler calls `socket.disconnect()` right after emitting it — so capacity handling is the proactive poll loop, not "react to `throwToNoAgent` on a live socket".)
- Poll delay cycle (embed SDK): `[30s, 45s, 1m, 1.5m, 2m, 3m, 4m, 5m, 6m]`, wrapping via modulo — effectively infinite backoff with a cap, bounded by `maxWaitMs`.
- The avatar runtime client's top-level machine mirrors this: an `availability` parallel state that loops `checkAgentsAvailability` (emit `checkAvailability`, await `availabilityResult`, 10s timeout) with a 5s retry delay while `unavailable`.
- When a positive `availabilityResult` arrives, the client emits **`join` (then `stvNewSession`) on the same socket** (same pod, sticky preserved) — no reconnect, state stays `CONNECTING`. The non-disconnecting `checkAvailability` poll is what preserves stickiness. The 15s connect timeout is cancelled once the queue activates; the queue runs its own `maxWaitMs`.

Session validity is checked separately via `isValidSession` → `validSession` / `throwToExceededTier` / `throwToBadRequest`.

### Connection recovery vs. session recovery

- **Transport blips** — Socket.IO's built-in `connectionStateRecovery`: if `socket.active` on disconnect, it auto-reconnects with exponential backoff + jitter and may restore the same socket (`socket.recovered === true`). A short blip doesn't tear down the avatar.
- **Recoverable transport drop** (within ~20s) — the **server preserves the session same-pod**: the conversation-manager's join handler enables Socket.IO `connectionStateRecovery` (`maxDisconnectionDuration = CONNECTION_STATE_RECOVERY_TIMEOUT`, default 20s, floor 5s, cap 10min); the live STV/ASR session + in-memory state survive and the `join` handler skips re-init (`session.hasJoined`). **This SDK's `KalturaAvatarSession` exploits this** — it rides recovery, emits `reconnecting`/`reconnected`, and does not re-`join` (verified live).
- **Permanent disconnect** (`socket.active === false`, or past the recovery window) — the session is gone; the avatar must reconnect fresh (new `stickyId`, likely a different pod, new agent slot). Same-pod resume exists (above); **cross-pod resume does not** — only the brain thread is resumable via `threadId`.
- Distinct timeouts pinpoint where it broke: `HANDSHAKE_TIMEOUT` (transport up, server silent → activate queue) vs `CONNECTION_TIMEOUT` (transport never came up).

### Cross-pod shared state (data plane)

Pods are stateless-enough to scale because shared state lives in managed backing services (provisioned via the avatar infrastructure module):

| Service | Role in scaling |
|---|---|
| **Valkey/Redis** (`avatar-cm-cache`, `resource-manager-avatar`, `front-proxy`, `cnc`, `cnc-polls`) | Conversation-manager cache, resource/slot accounting, front-proxy routing state, command-and-control — cluster-mode, multi-node-group, replicated |
| **SQS** (+ DLQ) | Async work between renderer / brain / pipeline stages; 30s visibility timeout, 24h retention |
| **DynamoDB** | Durable session/agent registry & coordination |
| **STV renderer + media server** (`c7i.xlarge`) | Video origin — the STV controller renders the face and pushes it via **RTMP into OvenMediaEngine (OME)**, egressed to clients via **WHEP** (URL varies by `cast_mode`; played with OvenPlayer). Scaled independently of the control plane |
| **CloudFront + WAF** | Edge for the public surface; the WAF enforces origin/CDN-header validation on public API endpoints |

So "agent availability" isn't per-pod guesswork — slot accounting is centralized in Redis/Valkey, which is what `checkAvailability` consults. Concretely (the conversation-manager's agent-availability service), a slot is available when **STV has free capacity** (unless the call is speech-only) **AND Whisper/ASR is available AND `activeCalls < maxCalls`**; `maxCalls` comes from the `CALL_CAPACITY` env via the conversation-manager's call-capacity config (default 20 in prod / 12 in non-prod). `availabilityResult.details` surfaces exactly these: `{stvAvailable, whisperAvailable, activeCalls, maxCalls, capacityAvailable}`. The brain conversation/thread state is also externalized (the same thread is resumable via `threadId` regardless of which pod handles a later turn over the text API).

### Implications for a custom (no-Kaltura-lib) client

If you reimplement the protocol per the recipe above, you MUST:

1. **Send a stable `stickyId` query param** on the socket (random 16-char, once per connect) — without it, polling requests scatter across pods and the handshake fails intermittently under load.
2. **Handle `throwToNoAgent`** by queueing/polling `checkAvailability` and re-emitting `join` on the same socket — not by reconnecting (a reconnect would land on a different pod and re-queue).
3. **Treat `throwToExceededTier` as fatal** (don't retry — it's a plan limit, not capacity).
4. **Keep the socket alive during queue waits**; only do a fresh `connect()` (new `stickyId`) on a permanent transport loss.
5. Let the **STV/WHEP** video channel reconnect independently — it carries no sticky state.

---

## Two Runtime SDK Paths (choose the right one)

There are two avatar runtimes. They are NOT interchangeable.

| | scripted-video control service client (`/v1/avatar-session`) | avatar runtime client (`conversation.avatar` socket) |
|---|---|---|
| Avatar video (STV/WHEP) | ✅ | ✅ |
| Mic / ASR uplink | ❌ | ✅ (`asr-webrtc-*`) |
| Genie brain | ❌ (you supply every line of text) | ✅ (server-side, streams `agent_raw_text`) |
| You call | `sayText()` / `sayAudio()` | nothing — the user speaks, the brain answers |
| Use for | **scripted / puppet** avatars (you drive the words) | **interactive agentic** avatars (autonomous conversation) |

The protocol above describes the **interactive** path. The scripted path is documented in [API-REFERENCE.md](../API-REFERENCE.md) → "Show the Avatar on a Web Page".

---

## SDK Module Map & Data Flow

The zero-dependency `@kaltura/intelligent-agents` SDK is the reference implementation of everything above, wrapped behind two entry points. This is the **source-of-truth map** of its internals — how a call flows from a typed method to the right backend. Use it to navigate the source; for the public surface + how-tos read [README.md](../README.md).

### Two entry points, one shared core

- **`./management`** (`Management`, `src/management/client.js`) — the REST control plane. Holds the admin secret, mints tokens, routes to the two REST hosts (Agentic + Genie) and OVP, and enforces the two-KS guard via `assertAdmin`/`assertConversation` (`assertKind` in `client.js`) **before any network call**. Resource namespaces hang off it: `sessions`, `agents`, `avatars`, `catalog`, `application`, `intellects`, `intellectConfig`, `tools`, `conversations`, `threads`, `messages`, `feedback`, `followups`, `knowledge`. `tools` is a standalone, partner-level entity — an intellect only references it via `tool_ids`. One sub-resource mounts on `intellects`: `intellects.secrets`.
- **`./experience`** (`KalturaAvatarSession`, `src/experience/session.js`) — the live socket+WHEP runtime from "Video Runtime Protocol" above. Takes only a short-lived conversation token; socket.io is INJECTED (`socketFactory`), never bundled. Two optional plugin subpaths hang off this same live runtime without loading into apps that don't need them: `./experience/presenter` (the `Presenter` deck helper) and `./experience/genui` (the `ExperienceRenderer` GenUI layer).
- **`src/core/*`** — the shared leaf layer both fronts depend on: `http.js` (transport), `errors.js` (`KalturaError`, RFC 9457), `session.js` (`Sessions` token-minter + `makeAuditEmitter`), `stream.js` (converse NDJSON/SSE parser + `collectConverse`/`segmentKind`/`UNISPHERE_RUNTIMES`), `redact.js`, `safety.js`, `ids.js` (`meta()` receipts), `knowledge-enums.js` (`CHAPTER_TYPE`/`STRATEGY`/`EMBED`/`buildIndexerObjects`). Core never imports from `management/` or `experience/` (stays a leaf).

> **Branch security on the minted `Token`, never on `inspectKs(realKs).kind`.** The public `inspectKs` export (`@kaltura/intelligent-agents/management`, `src/management/ks-inspect.js`) decodes only a KSv2 token's **plaintext header**: it reliably returns `{partnerId}`, but a real encrypted KS's privileges are AES-encrypted, so it returns `kind:'opaque'`, `disableEntitlement:null`, `encrypted:true`. `kind`/`disableEntitlement` are populated **only** for unencrypted test tokens. To decide what a token may do, read the `.kind` of the minted `Token` object (it records what it was minted with: `admin`/`conversation`/`agent`/`widget`), not `inspectKs` of an opaque production KS.

### Management modules (what each does, where it writes)

| Module (`src/management/`) | Exposes | Backend the writes hit |
|---|---|---|
| `intellects.js` | `Intellects` — DTO CRUD (`add`/`get`/`update`/`delete`), `addExternal`/`listExternal`/`listInternal`, prompt authoring (`setPrompts`/`previewPrompt`/`snapshot`/`restore`/`diffSnapshots`), capabilities (`getCapabilities`/`setCapability`/`setCapabilities`/`resolveCapabilities`), `setClientVariablesEnabled`, brain config (`setBrainConfig`/`getBrainConfig`/`brainConfigAvailable`), `buildBrainConfigPatch`. Mounts `secrets` (tools are a separate top-level resource — see `tools.js`). | Genie `v1/intellect/*` for DTO fields; Genie `partner-config/update`/`get` for brain config (gated) |
| `intellect-config.js` | `IntellectConfig` (`mgmt.intellectConfig`) — the ONE shared `patch(configId, patch\|fn, ks)` primitive + typed field setters incl. `setToolIds` (the intellect-side `tool_ids` reference list) + `describe()` (an `editable`/`readOnly` map). `buildUserPropertiesForms`. | Genie `v1/intellect/update` (read-modify-write, full-replace dicts; `tool_ids` is a plain array write) |
| `capabilities.js` | `CAPABILITIES`/`CAPABILITY_STATE`/`CAPABILITY_DEFAULTS`/`CAPABILITY_INFO`, `assertCapability`/`validateCapabilities`, `resolveCapabilities` (pure layered resolver), `mergeCapabilityWrite`. Re-exported from BOTH entry points. | pure — no network |
| `tools.js` | `tools.api`/`csv`/`code` builders + `tools.client` (authors a native, silent client-side command tool with NO server-side call — requires `kaltura_genie_experiences:'off'`; see [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md)) + `tools.clientToolReadiness` + `tools.validate`, `class Tools` (`mgmt.tools`: `add`/`get`/`list`/`update`/`remove` over the standalone Tool entity), `applyResponseMapping`. | Genie `v1/tool/*` (partner-level entity CRUD — NOT `intellect/update`; link via `intellectConfig.setToolIds`'s `tool_ids`) |
| `secrets.js` | `IntellectSecrets` (`mgmt.intellects.secrets`: `listNames`/`has`/`set`/`remove`/`replaceAll`/`validate`), `validateSecretRefs`. Write-only values; name-only read contract (no `redact()` reliance). | Genie `v1/intellect/update` `config.secrets` (mask-and-keep merge) |
| `prompt-lint.js` | pure: `lintPrompts`/`validatePromptVars`/`lintGlossary`/`assembleSystemPrompt`/`SYS_VARS`. Client-side prompt-preview replica (author layer only). | pure — no network |
| `conversations.js` | `Conversations` (`stream`/`send`, `assertRequestVars`), `Threads`/`Messages`/`Feedback`/`Followups`, `Knowledge` (`addRecord` + `knowledge_ids` linkage — Path A, ungated; `uploadDocument`, `createCategory`/`findOrCreateCategory`, `linkCategory`/`linkRecords`/`linkAvailable`, `corpusStatus`, `getLinkage`, `setEnabled`, `search`). | Genie `assistant/converse` (converse); Genie `v1/knowledge/add` + intellect `knowledge_ids` (Path A, ungated); OVP `category/*`+upload (containers); Genie `partner-config/update` (Path B re-point, gated) |
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

- **Intellect DTO** → Genie `v1/intellect/*`. Carries `prompts`, `base_directive`, `glossary`, `capabilities`, `tools`, `secrets`, `user_properties_forms`, `allow_client_variables`, `knowledge_ids`, `name`/`description`/`tags`/`status`. Writable with a **partner admin KS** today. **Knowledge linkage Path A rides this door**: first call `POST /v1/knowledge/add` on Genie (LIVE — returns an `{id,...}` record), then pass the returned id as `knowledge_ids` in the intellect create/update DTO — linkage + `use_knowledge_base:'on'` persist with no `partner-config/update` and no 403. It is a `model_fields_set` PATCH (omitted TOP-LEVEL fields are preserved) — but `capabilities`/`secrets` are **full-replace sub-dicts**, so the SDK read-merge-writes them (via `mergeCapabilityWrite` / the secrets mask-and-keep guard); `IntellectConfig.patch` is the one place that logic lives.
- **Partner-config DTO** → Genie `partner-config/update`/`get`. Carries brain config (`agent_llm`/`agent_fast_llm`/rate limits + the best-effort `agent_avatar_llm`/`run_quota_check`/`web_search_config`), and the **Path B** knowledge `indexer` re-point (re-pointing an *existing* intellect at a category corpus). These are **deployment-gated** — `partner-config/update` 403s for a partner admin KS on the current deployment (see § Configure the Brain in API-REFERENCE.md). Every such write PROBES first (`brainConfigAvailable`/`linkAvailable`) and, when the door is closed, returns `{applied:false, code, reason}` WITHOUT throwing or faking success. (Note: this gate is Path B only — the ungated `knowledge_ids` Path A above does NOT touch this door.)

When designing a new field setter, decide its door by which DTO genuinely accepts it (the `IntellectConfig` `EDITABLE_FIELDS` vs `READ_ONLY_FIELDS` constants encode this), and route reads to the SAME door — `getBrainConfig` reads `partner-config/get`, NOT `intellects.get`, because the intellect read DTO does not expose those fields (reading them via `intellects.get` would falsely report persisted values as unset).

### Honest limits surfaced by the SDK (plan §6)

These are genuine public-API limits, surfaced via typed probes/receipts, never overstated:

- **Partner-config writes are deployment-gated** (brain config, the Path B knowledge re-point → 403 today). The `*Available()` probes report the gate; gated writes return `{applied:false, reason}`. (The Path A `knowledge_ids` linkage via the intellect DTO is ungated and works — only re-pointing an existing intellect via `partner-config/update` is gated.)
- **External intellects are stored but NOT wired** — `addExternal` persists `{url, protocol}` and lists them, but the Genie brain backend does not delegate to them at converse time. The SDK stamps `_meta.runtimeWired:false`.
- **`model_type` cannot be proven** — the SDK can SEND `model_type:'fast'` (lowercase wire value; `MODEL_TYPES.primary` is `null` = omit) but cannot assert which model replied; there is no `'DEFAULT'` literal.
- **`force_experience` is a hint, not a contract** — the live runtime hardcodes `avatar_only`; structured widgets arrive reliably only on the HTTP converse path. The renderer renders whatever `runtimeName` arrives.
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
| 2. WebRTC peer (ASR + STV) | the WebRTC avatar engine's session client | ✅ 5 attempts × 2s, independent per channel | the media peer connections |
| 3. Avatar session | **this SDK** (`KalturaAvatarSession`) | ✅ socket-transport recovery: a recoverable drop → `reconnecting` → `reconnected` (same-pod, ≤~20s, no re-`join`); non-recoverable → clean `ended`. | the whole conversation |

The headline risk: **tiers 2 and 3 are not wired together for custom non-SDK clients** — the SDK wires them via `_recoverMedia` → `_coldReconnect`; when the WebRTC layer exhausts retries and emits `'failed'`, a custom client that does not use the SDK's `KalturaAvatarSession` must handle this itself.

### Device permissions (mic/camera)

`connecting → gettingUserMedia` calls `getUserMedia(audio:true, video:false)` on the WebRTC avatar engine's session client — **audio only** by default; the avatar doesn't need your camera. On denial, the runtime client's device-media handler routes to `error` with `reason: DevicesPermissionDenied`, `skipDisconnect:true`, `suppressNotification:true` (and `shouldPurge=false`) — a clean, retryable abort with no scary toast. The SDK (`KalturaAvatarSession`) surfaces distinct `NotAllowed`/`NotFound`/`NotReadable` codes; the avatar runtime client's classification is coarse (no `NotAllowedError` vs `NotFoundError` vs `NotReadableError` distinction). No pre-flight `navigator.permissions.query`, no mid-call device-loss handling.

### WebRTC media peer (the WebRTC avatar engine's session client)

- Config: `maxReconnectAttempts = 5`, `reconnectDelayMs = 2000` (fixed). ICE timers (`rtc-core` constants): connect-start 20s, no-SDP-answer 30s, disconnect-grace 60s.
- **ASR reconnection** (`handleAsrReconnection`): closes the peer, fully re-joins (new offer/answer via socket relay), **preserves mute state**. After 5 tries → emits `onConnectionState({type:'asr', status:'failed'})`.
- **STV reconnection** (`handleStvReconnection`): re-runs WHEP `joinSTV`. If WHEP returns **404 NO_ACTIVE_SESSION**, gives up immediately (server session gone — only the app can recreate it). After 5 tries → `'failed'`.

### Control socket & session machine (avatar runtime client)

- Socket.IO built-in recovery: on `disconnect` with `socket.active`, auto-reconnects (may restore the same socket via `connectionStateRecovery`).
- But the runtime client's error handler converts every `disconnect`/`connect_error`/`error`/`removePeer`/`throwTo*` into a machine `Disconnect` → teardown. The session machine has **no auto-reconnect**; recovery is user-initiated.
- Connect-phase hang protection is strong: every sub-state has a timeout (5–30s). Teardown is reliable (routes through `disconnected` even on failure; resets the player-ready singleton). Disconnect reasons (the runtime client's notification layer) drive user-readable, severity-tagged messages.

### Failure-mode matrix

| Failure | Detected by | Handling today |
|---|---|---|
| User denies mic permission | `getUserMedia` throws | Clean abort, no toast, retry possible |
| No mic / mic busy | `getUserMedia` throws | Same generic path (not distinguished) |
| ASR/STV peer drops | WebRTC avatar engine's ICE state | 5× re-join @ 2s; SDK handles via `_onIceStateChange`; the avatar runtime client's wrapper leaves `failed` event unhandled |
| STV server session gone (404) | WHEP status | Give up; app must recreate session |
| Control socket transient drop | Socket.IO `disconnect` | Socket.IO auto-recovers… but the runtime client's error handler may also tear down |
| Control socket permanent drop | Socket.IO `disconnect` (`!active`) | Teardown + "reconnect" notification |
| All agent slots busy | `throwToNoAgent` | Availability queue + poll (see Scale section) |
| Plan/tier exceeded | `throwToExceededTier` | Fatal, clear message |
| Connect hangs | SDK: `setTimeout` (`TIMEOUTS` constants); avatar runtime client: xstate `after` timeouts | 5–30s timeouts → error (well covered) |
| Player/video element error | `onPlayerError` chain | → `Disconnect` (`PlayerConnectionFailed`) |
| Brain stalls mid-conversation | `KalturaAvatarSession` watchdog | `brainStalled` event, repeating every `brainStallMs` until output lands; the avatar runtime client has no liveness timeout |
| Tool-call spiral (same command retried with no narration) | `KalturaAvatarSession` two-tier circuit breaker | Soft: `toolSpiralDetected` per turn (`toolSpiralLimit`) — signal only, does not call `interrupt()`. An earlier version called `interrupt()` here; removed after live evidence showed it both failed to stop a spiral already running server-side AND actively truncated the turn's own narration via documented barge-in semantics (a mid-turn `tapToTalkStart` forces an early, truncated `stvFinishedTalking` — see `CLIENT-COMMANDS.md`'s "Tool spirals starve the voice"). Hard: a session-scoped counter immune to turn-boundary resets forces `toolSpiralRecovering` (now carrying `lastTurnText`, the abandoned turn) + `_coldReconnect()` once `hardToolSpiralLimit` is crossed; because the control socket is still live at this point (unlike a genuine transport drop), `_coldReconnect()` opens a brand-new socket rather than re-`join`-ing the still-connected one — the server's `join` handler is idempotent-guarded per-connection and silently no-ops a re-join on a live socket. The hard guard re-arms on a successful cold reconnect (not just on perceivable output, which a spiral by definition never produces) so a second spiral later in the same session is caught too, not just the first. A cold reconnect restores connectivity + brain memory (`threadId`) but otherwise abandons the turn that triggered it — with `recoverFromSpiral` (default `true`), the SDK auto-resends that turn's tracked text once (from `speak()` or ASR's `userTranscription`), prefixed with `SPIRAL_RECOVERY_PREFIX` (the same nudge proven live on the headless `Conversations#send({recoverFromSpiral:true})` path), and emits `spiralRecovered {text}`; `recoverFromSpiral:false` suppresses the resend and leaves it to the app via `lastTurnText`. The avatar runtime client has no such breaker |
| Tab backgrounded / network change | `KalturaAvatarSession` | `online`/`offline`/`visibilitychange` handling in SDK; the avatar runtime client does not handle these events |

### What's already solid (don't regress)

- Connect-phase hang protection (per-substate timeouts).
- Clean teardown (no stale connection state; player-ready reset).
- Permission-denied UX (silent, retryable).
- TURN relay for connectivity behind hostile NATs (STV forces relay; ASR relays in practice regardless of policy — see Endpoints table).
- Mute-state preservation across ASR reconnects.
- Capacity queue (graceful waiting vs hard failure).
- Distinct, user-readable disconnect reasons.
- WHEP 404 short-circuit.
- **SDK (`KalturaAvatarSession`) implements**: ICE restart (`_recoverMedia`), socket-transport recovery, a repeating brain-stall watchdog + `brainStalled` event and a two-tier tool-call-spiral circuit breaker (`toolSpiralDetected` soft, `toolSpiralRecovering` + cold reconnect hard), granular device error codes — `NotAllowed`/`NotFound`/`NotReadable`, and `online`/`offline`/`visibilitychange` handling. These limitations apply only to custom clients that bypass the SDK.

