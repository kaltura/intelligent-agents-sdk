# Wire Protocol — Socket.IO + WebRTC Reference

The complete, verified map of **every event, payload, config, and flow** on the two channels that power the interactive live avatar: the **Socket.IO control plane** and the **two WebRTC peer connections** (ASR mic-uplink + STV video-downlink).

This is the deep reference behind [ARCHITECTURE.md](ARCHITECTURE.md) → "Video Runtime Protocol". Read ARCHITECTURE.md first for the big picture; read this when you need the exact field of an exact event, the exact ICE config, or the exact order things fire.

**How this was built.** Every event/payload below was captured live from real human voice + text sessions against `conversation.avatar.us.kaltura.ai`. Each entry notes which client(s) rely on it — some events are only subscribed to by the platform's built-in client, others only by the embed client or a debug panel.

**Evidence.** A redacted snapshot of a real session (27 inbound + 15 outbound socket events, both WebRTC legs, ICE policies for every client) is committed at `test/fixtures/golden-session.json` — a hand-curated fixture derived from the original live capture (see the fixture's own `_source`/`_note` fields for provenance). There is no automated re-capture tool in this repo today; update the fixture by hand against fresh observations (e.g. a `debugMode`-gated log panel wired to `session.on(...)`, or `socket.onAny` in a scratch client) when the wire protocol changes.

## Provenance / components

| Symbol | Component | What it is |
|---|---|---|
| `CG` | The platform's built-in client | The connection state machine used by the platform's own built-in avatar client. Authoritative for payload **schemas** and connect order. |
| `RTC` | The built-in client's media layer | The client-side WebRTC session/signaling layer the built-in client and this SDK both build on. Authoritative for **WebRTC** behavior: session setup, WHEP signaling, peer-connection management. |
| `EMBED` | A first-party embeddable client | A second first-party client used for anonymous/embedded widgets. Authoritative for **event semantics & ordering** and the server contract. |
| `SDK` | `src/experience/session.js` | This repo's `KalturaAvatarSession` — the buildable client implementation. |
| `CAP` | `test/fixtures/golden-session.json` | The redacted live-capture evidence (see §Evidence above). |
| `CM` | The session server | The **server** runtime — the emitter of every server→client event. Owns session orchestration, ASR signaling relay, and the brain output stream. |

> Server-emitted events cite `CM` (above) where the payload is confirmed against server-side behavior. Items still derived only from the live capture or client contract are marked **(server-side; inferred from contract)**.

> **One more term recurs in the body without its own table row.** **"Debug panel"** is a generic `debugMode`-gated developer log UI that recurs across clients rather than a single component with its own source citation — a row citing it means "also visible in a debug UI," not a distinct client contract.

---

## 1. Channels at a glance

| Channel | Transport | Direction | Carries | Source of truth |
|---|---|---|---|---|
| **Control plane** | Socket.IO (WebSocket) to `conversation.avatar.us.kaltura.ai` | duplex | handshake, session orchestration, brain text stream, turn/talking state, ASR signaling relay | §2–§4 |
| **ASR uplink** | WebRTC `RTCPeerConnection` (pc1) | client → server | your microphone (OPUS); SDP/ICE relayed **over the socket** | §5 |
| **STV downlink** | WebRTC `RTCPeerConnection` (pc2) via **WHEP** | server → client | avatar video (H264) + audio (OPUS); SDP over **plain HTTP** | §6 |

Two separate peer connections by design (per `EMBED`'s own architecture notes): WHEP is receive-only, ASR is send-only, and they use **different ICE policies** (§5/§6) — separating them gives independent negotiation and failure isolation.

---

## 2. Socket.IO connection

`SDK` opens the socket exactly as the other clients do. **Captured connection args:**

```js
io("https://conversation.avatar.us.kaltura.ai", {
  path: "/socket.io",
  transports: ["websocket"],
  auth:  { token: "<enriched KS from appInit>" },          // KSv2 string
  query: { partnerId: "<pid>", billed_client: "", stickyId: "<16 chars>",
           level: "published", debugMode: true }
})
```

Query params (per `EMBED`'s socket-init routine and `CG`'s connecting-state inputs):

| Param | Value | Purpose |
|---|---|---|
| `partnerId` | your PID | identifies the Kaltura account (the embed client sends `client`/`flowId` instead — agent identity) |
| `stickyId` | 16 random chars, fresh per connect | **session affinity** — load balancer pins all of this session's requests (incl. the initial HTTP-polling handshake) to one session-server pod. Critical: without it the handshake can break across pods. |
| `level` | `published` | content level (`published` = production agent, `draft` = staging) |
| `debugMode` | `true` | enables the server's streaming text events (`debug_stvTaskGenerated`, `debug_vad_speech_detected`); despite the `debug_` prefix these are required for interim transcription + `timing:'before'` features |
| `billed_client` | `""` | reserved for future partner billing delegation (unused) |
| `auth.token` | enriched KS | the conversation KS from `application/appInit`; carries `partnerId` + agent scope. (The embed client uses anonymous `ks:''`.) |

Auth/tenant scope: the KS in `auth.token` is what scopes the session to a partner + agent; entitlement stays ON for end-user sessions.

---

## 3. Connect sequence (state-machine order)

Order from `CG`'s connecting-state machine (steps 0–9, 11) plus the `SDK`/`EMBED` video-ready gate (step 10), cross-checked against live capture. `→` = client emits, `←` = client receives. **Each numbered step waits for its inbound event before advancing.**

| # | Client | Emits `→` / Waits `←` | Inbound (server) | Timeout |
|---|---|---|---|---|
| 0 | init RTC session + `getUserMedia({audio:true,video:false})` | — | (mic prompt) | — |
| 1 | open socket | `←` | `onServerConnected` | 10s (`ConnectionTimeout`) |
| 2 | join room | `→ join` | — | — |
| 3 | wait config + ack (parallel) | `← clientConfiguration`, `← joinComplete` | both required | `clientConfiguration` 5s, `joinComplete` **20s** (both `JoinRoomTimeout`) |
| 4 | create STV session | `→ stvNewSession {room_id, cast_mode}` | — | — |
| 5 | wait session | `← stvNewSession {session_id, webrtc_url?}` (or `← throwToNoAgent`) | sets `sessionId` + `webrtcUrl` | — |
| 6 | wait agent | `← showAgent` | agent joined | 10s (`AgentResponseTimeout`) |
| 7 | wait ready | `← askPermissions {constraints}` | server ready (machine event `ServerReadyReceived`) | — |
| 8 | (optional) wait player-ready, then 1000ms delay | — | — | — |
| 9 | connect ASR mic uplink | `asr-webrtc-*` handshake (§5) | — | 30s (`ASRConnectionFailed`) |
| 10 | subscribe STV video (WHEP) **and wait until playable** | `→` WHEP POST → wait `<video>` `canplay` + ~300ms settle | first decoded frame | — |
| 11 | **approve** (starts the spoken greeting) | `→ approvedPermissions {client, room}` | — | — |
| → | **CONNECTED** | listen for `agent_raw_text`, `generatingSpeech`, `stv*Talking`, VAD (§4) | — | — |

Top-level machine states (`CG`'s connection state machine): `preparing → connecting → connected → (disconnecting / disconnected / error)`. Overall connecting timeout 30s. Step timeouts are from `CG`'s connecting state (`30e3` overall, `10000` server-connect, `5e3` join-room, `10000` agent, ASR 30s).

> **Why `joinComplete` gets 20s, not 5s (deliberate deviation from `CG`'s single 5s join-room budget):** the server (`CM`) emits `clientConfiguration` immediately on join, but emits `joinComplete` only after an awaited context-update call that can exceed 5s under load. This SDK therefore budgets the two waits separately — `clientConfiguration` 5s, `joinComplete` 20s (`SDK:session.js` `TIMEOUTS.joinRoom` / `TIMEOUTS.joinComplete`). A client that reuses `CG`'s single 5s budget for both will see spurious `JoinRoomTimeout` failures on loaded rooms.

> **Steps 10–11 are a client-side refinement, not part of the `CG` machine.** The bare `CG` connecting-state machine approves on `connectToASR` **onDone** (`sendApprovedPermissions` → `done` → `#connected`) — its STV video is subscribed later, in the player layer. The **`SDK` and `EMBED` clients** instead gate `approvedPermissions` on STV video being playable first (`SDK:session.js _approve` gated on the same canplay/`HAVE_FUTURE_DATA` settle logic; `EMBED`'s own permission-approval check requires `_micReady && _videoReady`). **Why it matters:** `approvedPermissions` is what makes the server speak the opening line, and ICE `connected` fires ~2s before the first frame decodes — so approving before `<video>` `canplay` (readyState ≥ `HAVE_FUTURE_DATA`, + ~300ms jitter settle) clips the greeting. This SDK does the gate; do the same in your client.

---

## 4. Socket.IO events — developer-facing catalog

Direction: `→` client emits, `←` server emits. "Captured" = seen in the live session; `CM` cites the server as the emit/handler source. Schema cites `CG` where `CG` validates it. This covers the events a client integration uses; the server defines additional internal/binary-relay events (e.g. `userVideoBinaryData`/`agentVideoBinaryData`, `contactCollector`) that aren't part of the developer-facing surface.

### 4a. Client → Server (emit)

| Event | Payload (captured) | Source | Meaning |
|---|---|---|---|
| `join` | `{ room, channel, kaltura:{ entryId?, context_id?, threadId?, request_vars?, force_experience:"avatar_only", capabilities:{ avatar:"on", generate_followup_questions:"on", use_knowledge_base?:"off" } }, userAgent, userAgentHints, isMobile, channel_password:null, peer_name:"unknown", peer_video:false, peer_audio:true, client? }` | `CG` | Join the room; carries the agent/brain config. The server binds the room from **`channel`** (`session.roomId = channel`) and reads `peer_*` + `kaltura.{ks,entryId,threadId,contextId,contextType,capabilities,request_vars}` (see [ARCHITECTURE-REFERENCE.md §join](ARCHITECTURE-REFERENCE.md)); the top-level `room` field and the `force_experience` key are **not** consumed server-side (`force_experience` is pinned in the session server's brain bridge — see §7). `use_knowledge_base:"off"` only when `context.type==='entry'`. |
| `stvNewSession` | `{ room_id, cast_mode? }` — `cast_mode` is the `StvCastMode` enum `"webrtc"\|"rtmp"`, **optional** (client default `"rtmp"` = the **relay WHEP** egress) | `CG`; `cast_mode` from `CG`; server `CM` | Ask server to create the STV (avatar video) session. `cast_mode` selects the WHEP egress URL shape — **relay WHEP** (`rtmp`/omit, works) vs **STV-direct** (`webrtc`, broken here); see §6. |
| `asr-webrtc-init` | `{ sessionId }` (client sends its socket id) | `CG`; server `CM` | Ask backend to prepare the ASR WebRTC endpoint. The `sessionId` is **advisory/ignored server-side** — the handler keys everything off `socket.id`. |
| `asr-webrtc-offer` | `{ offer:{type,sdp}, is_reconnect:false }` | `CG` | SDP offer for the mic uplink; awaits `asr-webrtc-answer`. |
| `asr-webrtc-ice-candidate` | `{ candidate:{candidate,sdpMLineIndex} }` | `CG` (`RTC`) | Trickle a local ICE candidate for the ASR pc (the SDK extracts only these two fields). |
| `approvedPermissions` | clients emit `{ client, room }` — **server consumes nothing from it** | `CM`; `CG` | Mic+video ready → sets `userReadyForConversation=true` and **starts the conversation/greeting**. |
| `onTextEntered` (server handler) / `debug_text_entered` (captured client emit) | server reads `{ text, isFinal, isSpeechStart? }` | server: `CM`; client emit implemented as `SDK:session.js speak()`/`interrupt()`, debug mirror captured as `debug_text_entered` (`EMBED`) | **Drive the avatar by text** instead of voice — routed to the same path as ASR transcripts, NOT `/assistant/converse` HTTP (that never reaches the speech engine). `isFinal:false` for a partial; `isSpeechStart:true` (with `text:''`) is the correct barge-in marker — it interrupts a mid-sentence avatar (no-op if idle) and is sent BEFORE the real text on every `speak()` call, plus alone from `interrupt()`. The server routes by the socket's own room (`room: socket.id`) and **does not read `room_id`/`session_id`** — those fields seen in captures are ignored server-side. |
| `tapToTalkStart` / `tapToTalkEnd` | `{}` | `CM`'s tap-to-talk handlers (registered unconditionally, regardless of `isTapToTalk`) | Push-to-talk voice-capture mode (a button tap, not typed text) — flips the server's internal conversation state into tap-mode and resets its buffered speech. **Only safe when the agent is configured `isTapToTalk:true`** — see below for why, and for the SDK's client-side guard. |
| `isValidSession` | `{ client, clickId, hashClickId, userAgent }` | `CM` | Ask the server to validate the entry/session before joining → replies `validSession` (or `throwToBadRequest`/`throwToExceededTier`). |
| `checkAvailability` | `{}` (server reads mode/language from `clientConfiguration`, not the arg) | `CM` | Poll for a free agent slot without queuing — platform has no server-side queue; client-side polling only. Replies `availabilityResult`. |
| `pauseConversation` / `resumeConversation` | `{}` | `CM` | Pause/resume the live turn loop. |
| `muteUser` / `unmuteUser` | `{}` | `SDK:session.js micEnabled` setter; `CM` | Notify the server of mic mute/unmute. Muting is client-side (`track.enabled`); the server reads nothing from the payload and uses it only for logging/analytics/turn-taking. |
| `setDebugMode` | `{ debugMode }` | `CM` | Toggle the `debug_*` event stream at runtime (complements the `?debugMode` query param). |
| `userCameraShot` / `userScreenShareShot` | `{ data }` (ArrayBuffer) | `CM` | Push a camera / screen-share still for vision analysis (gated by the camera/screen-share capabilities). |
| `updateGenieContext` | `{ capabilities:{…}, request_vars:{…} }` | `SDK:session.js updateRequestVars()`/`setDynamicPrompt()`; `CM` | Mid-session context update. The server **replaces** its stored context with exactly what arrives — an omitted field is an explicit clear — so the SDK always sends the full shape: the join-time capabilities plus its full canonical `request_vars` map (client-side merge; `setDynamicPrompt(data)` is the same emit with the payload serialized into the `page_context` variable). |
| `onHtmlElementClick` / `iframeComplete` / `codeBlockComplete` / `setFormLeadInfo` | per handler (e.g. `{ htmlText }`, `{ message }`, `{ data }`) | `CM` | GenUI / structured-data-form interaction callbacks. |

#### `tapToTalkStart`/`tapToTalkEnd` in detail

`tapToTalkEnd` schedules a 300ms timer that mints the turn from whatever was buffered during the
tap window. The SDK emits this pair from `KalturaAvatarSession#startTapToTalk()`/`#endTapToTalk()`;
the resulting turn arrives via the existing `agentTurnToTalk` handler like any open-mic turn.

**Do not use for typed-text barge-in.** Bracketing `onTextEntered` inside this pair mints a
duplicate turn, since neither `tapToTalkStart` nor `tapToTalkEnd` invalidates a turn already in
flight.

**Why `isTapToTalk:true` is required, not optional.** `CM` registers its tap-to-talk handlers
unconditionally, regardless of how the agent is configured — the server accepts these events
either way. Safety comes from a different branch: the transcript handler decides whether to
buffer transcripts for the tap window or auto-cut a turn immediately by checking the *config* flag
`isTapToTalk`, not the live tap-mode conversation state. On an open-mic (`isTapToTalk:false`)
agent, VAD keeps minting turns unconditionally through a tap window, racing the same
internal conversation state with no mutual exclusion server-side. The SDK closes this
gap client-side instead: `startTapToTalk()` throws `capability_disabled` unless
`capabilities.tapToTalk` is set.

For the app-level decision of when to use this mode and how to design its UI, see
[VOICE-INPUT-MODES.md](VOICE-INPUT-MODES.md).

### 4b. Server → Client (on) — handshake/session phase

| Event | Payload (captured) | Schema / source | Meaning |
|---|---|---|---|
| `onServerConnected` | `{ finalUrl, agentName?, hostName?, loadingVideoURL? }` | `CG` | Server handshake done. `finalUrl` = STV video origin; `hostName` = the pod (sticky). |
| `clientConfiguration` | `{ clientConfiguration:{ configuration, nluFeatures, languageCode, isTapToTalk, interruptionsEnabled, pauseConversationEnabled, showTranscription, isWebSearchEnabled, isScreenShareEnabled, isCameraAnalysisEnabled, audioMode, phoneMode, shouldAggregateCurrentTurn, youtubeUrl, initialHtml, visualPhotos:[], visualVideos:[], agentPersonaName, userName } }` | `CG` | Per-session agent config (see §7 for field meanings). |
| `validSession` | `{}` | `CM` | Entry/session validated OK (reply to client `isValidSession`); failure instead yields `throwToBadRequest`/`throwToExceededTier`. |
| `joinComplete` | `{}` | `CG` | Room join acknowledged. |
| `stvNewSession` | normal STV: `{ session_id, status:"session started", webrtc_url? }`; **audio/phone mode**: `{ status:"audio/phone mode - no STV session" }` (no `session_id`/`webrtc_url`) | `CM`; `CG` | STV session created; `webrtc_url` = the WHEP play URL. The audio/phone variant skips STV entirely. |
| `showAgent` | `{}` | `CM`; `CG` | Agent has joined / is ready. |
| `askPermissions` | `{ constraints:{ audio: boolean \| {echoCancellation}, video: boolean } }` | `CM`; `CG` | Server requests mic/cam; drives `getUserMedia`. **Conditional/deferred:** when the flow's initial turn sets `ask_permissions_after_initial_turn` (and the pause-session isn't released), the server runs the agent's opening turn first and emits `askPermissions` only afterward. |
| `throwToNoAgent` | `{}` | `CM` | All agent slots busy → `NoAgentsAvailable`. **Terminal for the socket** — the server calls `socket.disconnect()` immediately after emitting it. To wait for capacity, open a **new** socket and poll `checkAvailability` on it; the `[30,45,60,90,120,180,240,300,360]s` schedule is the **client** poll cadence. Else fatal `CAPACITY_UNAVAILABLE (6001)`. |
| `throwToExceededTier` | `{}` | `CM`; `CG` | Account plan limit → `ExceededTierLimits`; fatal `TIER_EXCEEDED (6002)`, no reconnect. |
| `unsupportedClient` | `{ code }` — `'USAGE_LIMIT_EXCEEDED'` or `'INTERNAL_ERROR'` | `CM` (emitted directly during session setup, before `join` completes) | Fatal connection-setup failure, then the socket is torn down. |
| `throwToBadRequest` / `removePeer` | `{}` | `CG` | Fatal disconnect reasons: `BadRequest` / `PeerRemoved`. |
| `availabilityResult` | `{ available, reason?, details?:{ stvAvailable, whisperAvailable, activeCalls, maxCalls, capacityAvailable } }` (or `{ error, available:false }`) | `CM`; capacity from `CM` | Reply to the client `checkAvailability` poll; the socket stays open (never disconnects). Emit `stvNewSession`/proceed only when `available===true`. |

### 4c. Server → Client (on) — ASR signaling (relayed over the socket)

| Event | Payload (captured) | Source | Meaning |
|---|---|---|---|
| `asr-webrtc-ready` | `{}` | `CG` | Backend ready for ASR WebRTC signaling. |
| `asr-webrtc-answer` | `{ answer:{type:"answer", sdp} }` | `CG` | SDP answer for the mic uplink (server is `setup:active`). |
| `asr-ice-candidate` | `{ uid, type:"ice_candidate", candidate, sdpMLineIndex }` | server: `CM` (relayed from the ASR server); subscribed by `CG` | A remote ICE candidate for the ASR pc. Captured value is a private `10.x typ host` — why ASR still relays through TURN (§5). |
| `asr-webrtc-error` | `{ error? }` | `CG` | ASR signaling error. |

### 4d. Server → Client (on) — conversation phase

These fire once `approvedPermissions` is sent. All **captured live**. Several are **server-emitted but only `CG` OR the embed client OR a debug panel subscribes** — noted per row.

| Event | Payload (captured) | Subscribed by | Meaning |
|---|---|---|---|
| `agent_raw_text` | `{ speechId, turnId, delta:"<JSON string>" }` | `CG`; `SDK:session.js` | The brain's streaming output. `delta` is a JSON string — parse it (§4e). |
| `agent_start_speech` | `{ speechId, turnId, isNewTurn }` | `CG`; `SDK:session.js` | A new speech segment begins. |
| `agent_end_turn` | `{ speechId, turnId }` | captured live (`CAP`); `SDK:session.js` | The agent's turn is complete. |
| `generatingSpeech` | `{ text, speechId }` | `EMBED`; `SDK:session.js` | **Clean sentence text** the avatar will speak — authoritative word spacing. Arrives before audio. |
| `debug_stvTaskGenerated` | `{ text, speechId, duration }` | `EMBED`; debug panel; `CAP` | Raw token chunks, arrive **before** `stvStartedTalking`. Heuristic caption path (needs `debugMode`). |
| `stvSpeechChunk` | `{ text, speechId, durationMs }` | `EMBED`; `SDK:session.js` | **Server-timed, authoritative** caption chunk + exact duration; supersedes the heuristic path. Empty sentinels (`text:""`, `durationMs:1`) are filtered. Arrives ~400 ms before audio plays. For sync, add ~400 ms display delay. |
| `stvStartedTalking` | `{}` | `CG`; `SDK:session.js` | Audio generation begins → `isAgentTalking=true`. Playback arrives ~400ms later. Do not use to trigger captions. |
| `stvFinishedTalking` | `{ agentContent:"<full spoken text>" }` | `CG`; `SDK:session.js` | Avatar finished a turn. Reset caption buffers on THIS, not on `stvStartedTalking`. |
| `stvFinishedGenerating` | `{ speechId }` | `EMBED`; `SDK:session.js` | Server finished generating the speech for `speechId` (generation ≠ playback end). |
| `agentTurnToTalk` | `{ userTranscription? }` | debug panel; `EMBED`; `SDK:session.js` | User's turn finished; hand-off to the agent. `userTranscription` is present only on the user-speech hand-off (`onAgentTurnToTalk`, `withUserSpeech===true`); the payload is `{}` on the final-turn callback and non-user-speech calls. |
| `debug_vad_speech_detected` | `{ transcript, isFinal, segmentType, isSpeechStartEvent }` | debug panel; `EMBED`; `CAP` | Interim/final ASR from server VAD. `segmentType:"correction"` = speculative (revised each interim); only `isFinal:true` commits. Requires `debugMode`. |
| `debug_llm_input` | `{ userInput, finalSegment, pendingSegment, speechId, segmentType, isFinal }` | `CAP` | The exact text handed to the LLM for this turn. |
| `debug_conversationStateChange` | `{ state, preparingAnswerState }` | debug panel; `CAP` | Server conversation FSM. Observed `state`: `Started`, `PreparingAudio`, `ArrivedFinalSubSegment`, `AgentTalking`, `Idle`. `preparingAnswerState`: `Idle`, `PreparingAnswer`, `PreparingAudio`. (Enum is server-side; values rendered as opaque strings client-side.) |
| `agentInterrupted` | `{}` | captured live (`CAP`); `SDK:session.js` | Barge-in: the user spoke, or sent the `onTextEntered {isSpeechStart:true}` marker, and cut off the avatar mid-sentence. |
| `userStartedTalking` | `{}` | `EMBED` | Server-side VAD onset (non-debug; fires without `debugMode`). |
| `hideTapToTalkButton` | `{}` | `CAP` | UI hint from server (tap-to-talk affordance off for this config). |
| `conversationTimeWarning` | `{ remainingTime }` (seconds) | `CG`; `SDK:session.js` | Time-limit warning. |
| `conversationEnded` | `{}` | `CG`; `SDK:session.js` | Server ended the conversation → tear down. |
| `showTapToTalkButton` | `{}` | `CM` | Counterpart to `hideTapToTalkButton` — show the tap-to-talk affordance. |
| `stvTaskFail` | `{}` | `CM` | STV send failed → the server hangs up the session. |
| `smartTurnStatus` | `{ status, timeout_ms?, probability? }` | `CM` | Forwarded smart-turn VAD end-of-turn indicator. |
| `conversationTimeExpired` | `{}` | `CM` | Active-session time expired — sent immediately before `conversationEnded`. |
| `sessionReadyForResume` | `{}` | `CM`; `SDK:session.js` | Server-side session is recoverable for a same-pod reconnect (see [ARCHITECTURE.md](ARCHITECTURE.md) → resilience / connectionStateRecovery). SDK emits `resumeReady`. |
| `pauseSessionExpired` | `{}` | `CM`; `SDK:session.js` | The pause window (started by a client `pauseConversation`) expired server-side before a `resumeConversation` arrived — the session is no longer recoverable. SDK emits `timeExpired` with `{type:'pause_expiry'}`, distinct from a hard `conversationEnded`. |
| `resumingSession` | `{}` | `SDK:session.js` | Server has accepted a client `resumeConversation` and is rebuilding the STV/ASR pipeline; precedes `conversationResumed`. SDK transitions to the `resuming` connection state. |
| `conversationResumed` | `{}` (captured: `[{}, "<ackId>"]` — a socket.io ack callback id may trail) | `CM`; `SDK:session.js` | Reply to a client `resumeConversation` — the paused turn loop has resumed. |

### 4e. `agent_raw_text.delta` — the brain stream (parsed)

`delta` is a JSON string. Parsed shape (`CG`):

```js
{ role:"assistant", type, content, segmentNumber, et,            // always present
  threadId?, messageId?, segmentStart?, segmentEnd?, isFinal?,    // conditional (in `extra`)
  metadata?:{widgetName?,runtimeName?} }                          // unisphere-tool segments
```

Always-present fields are `role` (always `"assistant"`), `type`, `content`, `segmentNumber`, `et` (elapsed seconds) — built by the brain's response-formatting step in the brain backend. The rest are conditional `extra` keys (e.g. `threadId`/`messageId` ride the first `think` segment; `metadata` rides `unisphere-tool`).

**How `type` is determined.** The brain emits markdown; the brain backend's streaming parser sets a segment's `type` to the **code-fence language tag** the LLM writes, defaulting to `text` for un-fenced prose. So the fence-driven types are **open-ended** — the LLM chooses them. On top of that, a fixed set of **control** types is emitted by hardcoded response-formatting calls.

| `type` | Source | Meaning |
|---|---|---|
| `text` | parser default (un-fenced) | brain prose; what the typed-chat UI renders |
| `think` | control | "preparing to answer…"; start/end bracket the thinking phase; final `think` carries `isFinal:true` |
| `tool` / `tool_response` | control (brain backend's response-formatter, tool-call/tool-result emission) | a tool call + result. `content` is the wire form `"<toolName> <json-args>"` (e.g. `navigate_to_slide {"slide_num": 4}`); the `tool` segment fires BEFORE server execution, `tool_response` after. **Three kinds:** internal (e.g. `get_experience_instructions` for GenUI formatting) fire on the text path regardless of config; external web-search is gated by `isWebSearchEnabled` (when off, the agent may *narrate* a search but emit **no** `tool` segment); and **a partner-configured tool referenced via `tool_ids`** — the **client-side-command channel**: a `tool` segment is NOT in the TTS gate, so its name+args ride silently (clean audio) for the host app to act on (`navigate_to_slide`, `call_page_function`, realtime content). Parse it with the SDK's `parseToolCall(seg)` / `session.onToolCall(name)` / `collectConverse().toolCalls`; author the tool with `tools.client(...)`. See [EXTERNAL-API-INTEGRATIONS.md § Don't skip `kaltura_genie_experiences: 'off'`](EXTERNAL-API-INTEGRATIONS.md#dont-skip-kaltura_genie_experiences-off) for why a command-driven intellect must turn that capability off, and at creation time. |
| `unisphere-tool` | control (brain backend's response-formatter, structured-experience emission) | structured-experience block. First segment carries `metadata:{widgetName, runtimeName}`; observed runtimes `followups-tool`, `flashcards-tool`. See §7. |
| `error` | control (brain backend's response-formatter, error emission) | brain/runtime error (`isFinal:true`) |
| `interruption` / `user-interruption` | control (brain backend's response-formatter, interruption/abort emission) | OAuth interruption / user-abort |
| `avatar`, `share`, `thread`, … | fence tag (LLM-chosen) | fenced blocks the model emits: `avatar` (spoken-runtime text), `share` (`{canShare:bool}`; `segmentStart&&segmentEnd` ⇒ message complete), `thread` (e.g. auto-title), and any other tag the prompt defines. `avatar` is in the parser's set of block types that stream chunk-by-chunk rather than all-at-once. |

#### Fused multi-tool `tool` segments

When a turn calls 2+ tools, the server can emit **one** `type:"tool"` segment whose `content`
concatenates every called tool's JSON args back-to-back, but names only the **last** one — e.g.
captured live: `open_filing {"quarters": [...], "metric": "total_revenue"}{"quarter": "q1_2026",
"docType": "press_release"}` (the `highlight_chart` call that preceded `open_filing` rides in the
same string, unnamed).

##### How the response echoes the missing name

The `tool_response` segments that follow still echo **every** called tool by name, in call order
(`highlight_chart responded with size 113` then `open_filing responded with size 104`), which is
the only reliable client-side signal for attributing the earlier, unnamed blob to its real tool.

##### How the SDK recovers it

The SDK's `parseToolCall(seg)` recovers the named tool's own args correctly (the last JSON object)
and surfaces earlier blobs as `call.fusedArgs` (array, arrival order); `parseToolResponseName(seg)`
extracts a `tool_response`'s echoed name. `KalturaAvatarSession` pairs the two automatically — an
ASR-sub-turn-scoped queue of un-attributed `fusedArgs` blobs, drained by the next `tool_response`
name not already dispatched this sub-turn — so every `onToolCall(name)` handler fires with correct
args even on a fused turn; no app-level change is needed.

##### Queue reset boundary

The queue and its dispatched-names guard reset on **every** `agent_start_speech`, `isNewTurn` or
not: a name dispatched directly in one ASR sub-turn must not block that same name's fused recovery
in the next sub-turn of the same `turnId` — it's a distinct call with distinct args, not a repeat.
This is narrower than the cross-turn `_firedToolCalls` dedup below, which stays keyed to a real
`isNewTurn` boundary.

##### Headless caveat

Headless `collectConverse()` gets the corrected named-tool args for free but does **not** run this
pairing recovery, so an earlier fused blob is only reachable via `fusedArgs` on that one `ToolCall`,
not as its own `toolCalls` entry.

#### The `wait_for_response` ACK — one wire contract, two transports

A `tools.client` tool built `waitForResponse:true` blocks the model's turn until the host app
supplies a result: the brain backend polls up to `timeout` seconds (default 30) for an ACK. The ACK
is **not a socket event** — on both transports it is the same plain HTTPS POST, authorized by the
session's own conversation KS (the model speaks the acked value in the *same* turn):

```
POST {genieUrl}/assistant/tool_response
Content-Type: application/json
Authorization: KS <conversation ks>

{ "tool_name": "<toolName>", "tool_id": "<toolMetadata.id>",
  "tool_invocation_id": "<toolMetadata.id>", "response": { …your JSON result… } }

→ 200 {}
```

`tool_id` and `tool_invocation_id` are both the `toolMetadata.id` from the parsed `tool` segment.
This is exactly what `KalturaAvatarSession#respondToTool` (`SDK:session.js`) and
`KalturaChatSession#respondToTool` (`SDK:chat-session.js`) send — the `tool` segment may arrive over
the socket (`agent_raw_text`, above) or over the HTTP `/assistant/converse` chat stream, but the ACK
path is identical, so one `waitForResponse:true` tool definition works unmodified on both
transports. See [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md) for the app-level contract
(`onToolCall` → `respondToTool`).

> `init_response` is **NOT** an HTTP-converse segment — it's a **WebSocket** event type defined in the brain backend's websocket layer. In the live runtime it arrives as the `delta` of the first `agent_raw_text` socket event (carrying `openingPhrase`/`threadId`/`messageId`); it never appears in an `/assistant/converse` HTTP stream.

> **Avatar-runtime segment handling.** The `type` values above are the brain's raw types; the session server's brain-bridge adapter **rewrites** a `type === 'unisphere-tool'` segment to its `metadata.runtimeName` (minus the `-tool` suffix) before yielding downstream, so a runtime client sees the adapter-normalized type, not the raw `unisphere-tool` name. The adapter yields **all** segment types (it doesn't drop non-spoken ones) along with `start`/`end`/`final`/`delta`. Because the bridge pins `force_experience: 'avatar_only'`, the brain's spoken content arrives primarily as `avatar` (streamed) / `avatar-filler` segments while control/structured types (`think`/`tool`/`unisphere-tool`/`share`/`thread`/`error`) stream alongside for the transcript/UI. **Note:** grouping `avatar-filler` under "spoken" here describes wire mechanics only — unlike `avatar`/`text`, its phrasing is server-generated per turn and NOT reliably steerable via `base_directive` (see the `avatar_filler` capability note in [GENUI-REFERENCE.md](GENUI-REFERENCE.md#authoring--which-capability-turns-each-widget-on)).

The built-in client's text-assembly logic (`CG`) only *assembles* `text | unisphere-tool | error` into the transcript and treats a start+end `share` as message-complete; it ignores `avatar | think | tool | tool_response` (those drive the live runtime). Frame counts from one captured text session: `text`×159, `think`×13, `share`×6, `unisphere-tool`×6, `thread`×5.

### 4f. `speechId` — the per-utterance key (and the barge-in mechanism)

`speechId` appears on `agent_raw_text`, `agent_start_speech`, `agent_end_turn`, `generatingSpeech`, `stvSpeechChunk`, `debug_stvTaskGenerated`, `stvFinishedGenerating` — it is the **session server's identifier for one agent utterance**, and it is how you group a turn's events (do **not** group by timestamp — barge-ins interleave turns).

- **Format:** `` `${generateId(4)}-<trigger>-<payload>` `` — a 4-char nonce + the trigger + its content. Observed triggers: `transcript` (a user speech/text turn — the same path `onTextEntered` feeds), `approved-permissions` (the opening greeting), plus `tap-to-talk`, `resume-replay`, `wake-up`, `begin-agent-conversation`, `contact-info-received`/`-rejected`, `html-element-click`, `iframe-completed`, `code-block-completed`, `hangup-message`. e.g. `4nkM-transcript-Hey, what's up?`, `1Yev-approved-permissions`.
- **Minted per utterance**, and it maps 1:1 to the brain's request `uuid`. `stvStartedTalking`/`stvFinishedTalking` carry **no** `speechId` in their payload — attribute them to the `speechId` of the surrounding `stvSpeechChunk`s.
- **The staleness guard = barge-in.** The server tracks a single active `speechId` per session; every TTS/STV event whose `speechId` doesn't match the currently active one is **dropped** (server-side). When a new user turn arrives, the server mints a new `transcript` `speechId` and makes it the active one — instantly invalidating the prior utterance's in-flight audio. That is exactly what `agentInterrupted` reflects. The `stvSpeechChunk` `speechId` switches at each `agentInterrupted` (e.g. `4nkM-transcript-…` → `agentInterrupted` → `d1qD-transcript-…`); in that session 16 of 24 utterances ended in a barge-in.

---

## 5. ASR uplink (pc1) — microphone → server

A WebRTC peer connection that publishes the mic. SDP/ICE are relayed **over the Socket.IO socket** (the `asr-webrtc-*` events in §4a/§4c), not over HTTP.

> **ASR signaling is a three-hop relay.** (1) The browser emits `asr-webrtc-*` over the browser↔session-server Socket.IO socket. (2) The session server's WebRTC signaling proxy re-emits these as JSON `{type:'webrtc_offer'|'ice_candidate', …}` over a **separate `ws://` WebSocket** to the ASR service. (3) The ASR service terminates the WebRTC peer and runs speech-to-text. Note the ASR service's WebRTC endpoint is configured with **no STUN/TURN** — the browser-side relay (TURN, below) is what carries the media; the browser↔ASR ICE works because the server offers a reachable candidate via the proxy.

**ICE config (implemented in `SDK:wire.js iceConfig()`; TURN URL list from `RTC` `buildIceConfiguration`). `username`/`credential` default to the values in `wire.js`'s `turnServers()` and can be overridden via `creds`:**

```js
new RTCPeerConnection({
  iceServers: [{
    urls: [ "turn:turn.avatar.us.kaltura.ai:80?transport=udp",
            "turn:turn.avatar.us.kaltura.ai:443?transport=udp",
            "turn:turn.avatar.us.kaltura.ai:80?transport=tcp",
            "turns:turn.avatar.us.kaltura.ai:443?transport=tcp" ],
    username: "<default-username>", credential: "<default-credential>" }],
  iceTransportPolicy: <see matrix below>,
  bundlePolicy: "max-bundle"
})
```

- **ASR `iceTransportPolicy` differs by client — and it doesn't matter functionally.** The resolved value is `forceAsrRelay && !isFirefox ? 'relay' : 'all'` (`RTC`; `forceAsrRelay` defaults to `false` in `RTC`'s `buildIceConfiguration`). What each client passes:

  | Client | passes | ASR policy (non-Firefox) | Source |
  |---|---|---|---|
  | `CG` (the platform's built-in client) | `forceAsrRelay: true` | **`relay`** | `CG` |
  | `EMBED` (a first-party embeddable client) | hardcoded | **`all`** | `EMBED` |
  | `SDK` (this repo) | hardcoded | **`all`** | `SDK:wire.js iceConfig()` |

  Either resolves to the same media path: the server's only ICE candidate is a **private `10.x typ host`** (captured), unreachable directly, so the selected pair is **`relay`↔`host` through TURN** regardless. `'relay'` forces that; `'all'` also gathers host/srflx but still ends up on the relay pair. On **Firefox both clients force `'all'`** (relay-only candidate handling differs in `RTC`).
- **TURN URLs must carry explicit ports+transports** (the four-URL list above) — a bare `turn:host` yields no relay candidate and the uplink silently sends 0 packets. This is the field that actually matters, not the policy string.
- **SDP:** offer `m=audio … OPUS/48000/2` (+ red, G722, PCMU/A, CN, telephone-event), `a=sendrecv`, `a=setup:actpass`; server answers `m=audio … 111` OPUS only, `a=setup:active`, `a=recvonly`.
- **Captured stats (healthy):** `outbound-rtp audio` `packetsSent` climbing (637 → 2200 over the session), selected `candidate-pair` `nominated:true state:succeeded`, local `relay`/udp ↔ remote `host`/udp.
- **Handshake:** `→ asr-webrtc-init {sessionId}` → `← asr-webrtc-ready` → create offer → `→ asr-webrtc-offer {offer,is_reconnect}` → `← asr-webrtc-answer {answer}` → `setRemoteDescription`; ICE trickles both ways (`→ asr-webrtc-ice-candidate`, `← asr-ice-candidate`). 30s timeout each wait.
- After connect, the server runs STT on this audio → feeds the brain. There is no "send transcript" call.

### 5b. Audio-mode WebRTC (separate from the ASR uplink)

When an agent runs in **audio/phone mode** (no STV video — see §6), the runtime negotiates a single bidirectional audio peer over a *different* event family than the `asr-webrtc-*` mic uplink. Source: `CM`. Here the **server** creates the offer:

| Direction | Event | Payload | Meaning |
|---|---|---|---|
| `→` | `webrtc-create-offer` | `{}` | Ask the server to start audio-mode WebRTC (server replies with `webrtc-offer`). |
| `←` | `webrtc-offer` | `{ offer }` | Server-generated SDP offer (`createWebRTCOffer`). |
| `→` | `webrtc-answer` | `{ answer }` | Client SDP answer. |
| `→` / `←` | `webrtc-ice-candidate` | `{ candidate }` | ICE trickle, both directions. |
| `←` | `webrtc-connected` / `webrtc-disconnected` | `{}` | Audio peer state. |
| `←` | `webrtc-error` | `{ error }` | Audio-mode negotiation error. |

This is distinct from §5 (where the *client* offers the mic uplink and STT runs server-side). `SDK` implements the §5 path (video agents); audio-mode is documented here for completeness.

**The session server terminates this peer connection itself — it is not a relay here.** For every other socket-signaled path in this document (e.g. §4a/§5's `asr-webrtc-*` proxy to the ASR service), the session server forwards SDP/ICE to some other backend. Audio mode is the one exception: `CM` builds a real `RTCPeerConnection`/`RTCAudioSource` using native WebRTC, and streams synthesized TTS speech to the browser directly over that connection — the session server is the far end of the peer connection, not a signaling pass-through.

---

## 6. STV downlink (pc2) — avatar video+audio → you

A receive-only WebRTC peer connection fed via **WHEP** (WebRTC-HTTP Egress Protocol). Signaling is **plain SDP over HTTP**, independent of the socket. (Server-side, the STV controller renders the face and streams it into a media relay that provides the WHEP egress; see ARCHITECTURE.md.)

**`cast_mode` selects the egress URL shape** (`StvCastMode` enum, optional in the `stvNewSession` body; the production client sends `'rtmp'` by default, `'webrtc'` only for the `unistv` player). Think of the two modes by their egress, not the wire word:

- **Relay WHEP** (wire `cast_mode:'rtmp'`, *or* omit it, *or* any non-`webrtc` value) → `{srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id}` (the captured form below). The server renders the face and re-serves it over this relay's WHEP endpoint; **this is the working path.**
- **STV-direct** (wire `cast_mode:'webrtc'`) → the STV server's own `/whep/session/{session_id}` (direct when `STV_URL` is set, else via the session-server proxy `{basePublicProxyUrl}/rtc/v1/stv/{…}/whep/session/{session_id}`). Currently broken in this deployment.

The client POSTs whichever `webrtc_url` the server returns, verbatim. **The browser always plays via WebRTC/WHEP regardless of mode** — "rtmp" is only the server-side ingest the renderer uses, never a browser transport.

**ICE config:** same TURN URL block as §5. STV resolves `forceStvRelay && !isFirefox ? 'relay' : 'all'` (`RTC`). **All three clients agree here** — `CG` (`forceStvRelay:true`), `EMBED` (default `'relay'`), and `SDK` (`SDK:wire.js iceConfig()`) — so:

```js
iceTransportPolicy: "relay"     // STV → 'relay' (non-Firefox); 'all' on Firefox
bundlePolicy: "max-bundle"
```

- **Transceivers:** `addTransceiver('video',{direction:'recvonly'})` + `addTransceiver('audio',{direction:'recvonly'})` (`RTC`).
- **WHEP request** — the URL is the server-provided `webrtc_url` from `stvNewSession` (captured form below); `RTC` POSTs to it verbatim, and `EMBED` / `SDK:wire.js whepUrl()` build the same shape from `srsBaseUrl`:

  ```
  POST {srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id}
  Content-Type: application/sdp
  body: <client offer SDP>          → response body: <answer SDP>  (HTTP 201)
  ```
  Teardown = `DELETE` to the `Location` header from the 201. WHEP status codes (`RTC`): `201` created, `404` no active session (must re-create), `409` already has a viewer, `415` wrong content-type.
- **SDP:** offer carries full video codec list + audio; server answer selects `m=video … 109 H264/90000` + `m=audio … 111 OPUS/48000/2`, both `a=sendonly` / `a=setup:passive`.
- **Captured stats (healthy):** `inbound-rtp video` `frameWidth/Height: 512`, `framesDecoded` 256 → 1036, `bytesReceived` ~2.6 MB; selected pair `nominated:true state:succeeded`, **both candidates `relay`**.
- **Greeting gate:** wait for `<video>` `canplay` (+~300ms) before `approvedPermissions` (§3 step 10–11).
- `cast_mode:"rtmp"` (sent in `stvNewSession`) = the server renders the face and ingests it into the relay via **RTMP**; the client only ever does WHEP egress. The client never touches RTMP.

---

## 7. `clientConfiguration` fields (per-session agent config)

Captured + confirmed by `CG`. These flags shape runtime behavior:

| Field | Captured | Meaning |
|---|---|---|
| `languageCode` | `"en"` | conversation language |
| `interruptionsEnabled` | `true` | barge-in allowed (user can talk over the avatar) |
| `isTapToTalk` | `false` | push-to-talk vs open-mic — a fixed, per-agent config choice (not a live per-session toggle); exposed read-only via `KalturaAvatarSession#capabilities.tapToTalk` and gates `startTapToTalk()`/`endTapToTalk()` client-side (see the `tapToTalkStart`/`tapToTalkEnd` row above for why mixing modes is unsafe) |
| `showTranscription` | `false` | surface live captions in UI |
| `isWebSearchEnabled` | `false` | gates real web-search tools (→ `tool`/`tool_response` deltas). **When `false`, the agent can still *say* it will "look that up" but no `tool` segment fires** — the search doesn't happen (captured). |
| `isScreenShareEnabled` / `isCameraAnalysisEnabled` | `false` | screen-share / camera-vision features |
| `audioMode` / `phoneMode` | `false` | audio-only / telephony modes |
| `pauseConversationEnabled` | `false` | can pause the conversation |
| `shouldAggregateCurrentTurn` | `false` | turn-aggregation behavior |
| `forwardLoopMode` / `imaginativeAiMode` | `false` | (captured; server-side conversation modes) |
| `initialHtml`, `youtubeUrl`, `visualPhotos[]`, `visualVideos[]` | empty | initial GenUI content the agent ships with |
| `agentPersonaName`, `userName` | `null` | display names |
| `configuration`, `nluFeatures` | `{}` | extension buckets |

### Structured experiences (`force_experience` + `unisphere-tool`)

> **Scope:** the structured-experience behavior below applies to the **HTTP `/assistant/converse`** path (headless/text integrations). The **avatar runtime does not use it** — the session server's brain-bridge hardcodes `force_experience: 'avatar_only'` and `model_type: 'fast'`, so a live avatar session never emits flashcards/summarization widgets. Use the HTTP converse path (or a custom client) to drive structured experiences.

`force_experience` on `converse` (e.g. `"flashcards"`) is a **hint, not a guarantee** — the brain decides which structured widget(s) to emit based on the prompt + intellect. Each comes back as `unisphere-tool` segments: the first carries `metadata:{ widgetName, runtimeName }`, then the content streams (a YAML-ish block, e.g. `title:` / `questions:`). Captured/verified:

- `force_experience:"flashcards"` + a teachable prompt ("Teach me about video codecs") → **both** `flashcards-tool` and `followups-tool` runtimes in one turn (`widgetName:"unisphere.widget.genie"`).
- The same `force_experience` + a vague prompt ("show me something interesting") → **only** `followups-tool`.
- So: render whatever `runtimeName` arrives; don't assume `force_experience` maps 1:1 to a widget. `capabilities.generate_followup_questions:"on"` independently yields the `followups-tool`.

---

## 8. End-to-end turn (what fires, in order)

A user turn, as captured:

```
(user speaks / or → onTextEntered, captured client emit `debug_text_entered`)
← debug_vad_speech_detected {isFinal:false, segmentType:"new"|"correction"}   (interim, repeats)
← debug_vad_speech_detected {isFinal:true,  segmentType:"final"}              (commit)
← debug_conversationStateChange {state:"PreparingAudio", preparingAnswerState:"PreparingAnswer"}
← debug_llm_input {userInput}
← agent_start_speech {speechId, turnId}
← agent_raw_text delta type=think → (then) type=avatar (streamed)             (brain output)
← generatingSpeech {text}                                                     (clean sentences)
← debug_stvTaskGenerated {text, duration}                                     (raw chunks, pre-audio)
← agentTurnToTalk {userTranscription?}
← stvSpeechChunk {text, durationMs}                                           (authoritative captions)
← stvStartedTalking {}                                                        (lips move → video speaks)
← agent_raw_text delta type=share {canShare} ; type=think isFinal:true
← agent_end_turn ; stvFinishedGenerating
← stvFinishedTalking {agentContent}                                           (turn done)
← debug_conversationStateChange {state:"Idle"}
```

Barge-in: a new `debug_vad_speech_detected` (voice) or `→ onTextEntered {text:'', isFinal:false, isSpeechStart:true}` (typed, via `speak()`/`interrupt()`) mid-turn produces `← agentInterrupted {}` and an early `stvFinishedTalking` with the truncated `agentContent`.

**Live-runtime brain-bridge internals (`CM`, for integrators reasoning about turns):**

- **Turn segmentation** (server-side) — `agent_start_speech.isNewTurn` is `false` while incoming ASR text stays *similar* to the prior input: similar = the normalized new text is a prefix of the prior, OR Levenshtein similarity `(maxLen − distance)/maxLen ≥ 0.6`; normalization lowercases, strips `?.!,`, and collapses whitespace. Divergence below that threshold starts a new turn.
- **Abort on interruption** (server-side) — the bridge sends a WebSocket `abort` frame to the brain `{ threadId, messageId, deleteFromHistory: !isUserInterruption }`: a **user** interruption keeps the partial answer in thread history; a **system** invalidation deletes it. The in-flight request and any late segments are then rejected.
- **Audio/phone mode allocates no STV** — `CM` short-circuits to `{status:"audio/phone mode - no STV session"}` (no `webrtc_url`, no WHEP downlink). TTS `output_format` is `pcm_16000` (audio mode) / `ulaw_8000` (phone) / MP3 (video mode, the only mode that POSTs audio to STV).

---

## 9. Reproduce / re-capture

See the "Evidence" note at the top of this doc for the committed fixture (`test/fixtures/golden-session.json`). To observe live traffic against a real session, wire a `debugMode`-gated log panel to print every socket event via `session.on(...)` handlers, or attach a scratch `socket.onAny` listener in a browser console — there is no dedicated capture tool in this repo today. The original snapshot the golden fixture derives from was taken against the reference account's `1_v1mj1kxb` widget + `configId 1222` (see the sample values documented in this repo's tests).
