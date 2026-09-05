---
layout: base.njk
title: "Wire Protocol · Events Catalog"
description: "The full Socket.IO events catalog: client→server emits, server→client events, the agent_raw_text.delta brain stream, and speechId/barge-in."
eyebrow: Reference
---

# Socket.IO events — developer-facing catalog

[← Back to Wire Protocol](/reference/wire-protocol/)


Direction: `→` client emits, `←` server emits. "Captured" = seen in a live session. This covers the events a client integration uses; the server defines additional internal/binary-relay events (e.g. `userVideoBinaryData`/`agentVideoBinaryData`, `contactCollector`) that aren't part of the developer-facing surface.

### 4a. Client → Server (emit)

| Event | Payload (captured) | Source | Meaning |
|---|---|---|---|
| `join` | `{ room, channel, kaltura:{ entryId?, context_id?, threadId?, request_vars?, force_experience:"avatar_only", capabilities:{ avatar:"on", generate_followup_questions:"on", use_knowledge_base?:"off" } }, userAgent, userAgentHints, isMobile, channel_password:null, peer_name:"unknown", peer_video:false, peer_audio:true, client? }` | built-in client | Join the room; carries the agent/brain config. The server binds the room from **`channel`** (`session.roomId = channel`) and reads `peer_*` + `kaltura.{ks,entryId,threadId,contextId,contextType,capabilities,request_vars}` (see [Architecture Reference · Connection and Handshake § The `join` payload](/reference/architecture-reference/connection-and-handshake/#the-join-payload-step-2--this-carries-the-agentbrain-config)); the top-level `room` field and the `force_experience` key are **not** consumed server-side (`force_experience` is pinned in the session server's brain bridge — see [§7](/reference/wire-protocol/client-configuration/#clientconfiguration-fields-per-session-agent-config)). `use_knowledge_base:"off"` only when `context.type==='entry'`. |
| `stvNewSession` | `{ room_id, cast_mode? }` — `cast_mode` is the `StvCastMode` enum `"webrtc"\|"rtmp"`, **optional**; the built-in client sends `"rtmp"` explicitly, this SDK always omits it entirely | built-in client; `cast_mode` from built-in client; server | Ask server to create the STV (avatar video) session. `cast_mode` selects the STV egress; this SDK only ever takes the fully-omitted default path, which returns real working video in the current deployment; see [§6](/reference/wire-protocol/audio-channels/#6-stv-downlink-pc2--avatar-videoaudio--you). |
| `asr-webrtc-init` | `{ sessionId }` (client sends its socket id) | built-in client; server | Ask backend to prepare the ASR WebRTC endpoint. The `sessionId` is **advisory/ignored server-side** — the handler keys everything off `socket.id`. |
| `asr-webrtc-offer` | `{ offer:{type,sdp}, is_reconnect:false }` | built-in client | SDP offer for the mic uplink; awaits `asr-webrtc-answer`. |
| `asr-webrtc-ice-candidate` | `{ candidate:{candidate,sdpMLineIndex} }` | built-in client (media layer) | Trickle a local ICE candidate for the ASR pc (the SDK extracts only these two fields). |
| `approvedPermissions` | clients emit `{ client, room }` — **server consumes nothing from it** | server; built-in client | Mic+video ready → sets `userReadyForConversation=true` and **starts the conversation/greeting**. |
| `onTextEntered` (server handler) / `debug_text_entered` (captured client emit) | server reads `{ text, isFinal, isSpeechStart? }` | server; client emit implemented as `SDK:session.js speak()`/`interrupt()`, debug mirror captured as `debug_text_entered` (embed client) | **Drive the avatar by text** instead of voice — routed to the same path as ASR transcripts, NOT `/assistant/converse` HTTP (that never reaches the speech engine). `isFinal:false` for a partial; `isSpeechStart:true` (with `text:''`) is the correct barge-in marker — it interrupts a mid-sentence avatar (no-op if idle) and is sent BEFORE the real text on every `speak()` call, plus alone from `interrupt()`. The server routes by the socket's own room (`room: socket.id`) and **does not read `room_id`/`session_id`** — those fields seen in captures are ignored server-side. |
| `tapToTalkStart` / `tapToTalkEnd` | `{}` | the server's tap-to-talk handlers (registered unconditionally, regardless of `isTapToTalk`) | Push-to-talk voice-capture mode (a button tap, not typed text) — flips the server's internal conversation state into tap-mode and resets its buffered speech. **Only safe when the agent is configured `isTapToTalk:true`** — see below for why, and for the SDK's client-side guard. |
| `isValidSession` | `{ client, clickId, hashClickId, userAgent }` | server | Ask the server to validate the entry/session before joining → replies `validSession` (or `throwToBadRequest`/`throwToExceededTier`). |
| `checkAvailability` | `{}` (server reads mode/language from `clientConfiguration`, not the arg) | server | Poll for a free agent slot without queuing — platform has no server-side queue; client-side polling only. Replies `availabilityResult`. |
| `pauseConversation` / `resumeConversation` | `{}` | server | Pause/resume the live turn loop. |
| `muteUser` / `unmuteUser` | `{}` | `SDK:session.js micEnabled` setter; server | Notify the server of mic mute/unmute. Muting is client-side (`track.enabled`); the server reads nothing from the payload and uses it only for logging/analytics/turn-taking. |
| `setDebugMode` | `{ debugMode }` | server | Toggle the `debug_*` event stream at runtime (complements the `?debugMode` query param). |
| `userCameraShot` / `userScreenShareShot` | `{ data }` (ArrayBuffer) | server | Push a camera / screen-share still for vision analysis (gated by the camera/screen-share capabilities). |
| `updateGenieContext` | `{ capabilities:{…}, request_vars:{…} }` | `SDK:session.js updateRequestVars()`/`setDynamicPrompt()`; server | Mid-session context update. The server **replaces** its stored context with exactly what arrives — an omitted field is an explicit clear — so the SDK always sends the full shape: the join-time capabilities plus its full canonical `request_vars` map (client-side merge; `setDynamicPrompt(data)` is the same emit with the payload serialized into the `page_context` variable). |
| `onHtmlElementClick` / `iframeComplete` / `codeBlockComplete` / `setFormLeadInfo` | per handler (e.g. `{ htmlText }`, `{ message }`, `{ data }`) | server | GenUI / structured-data-form interaction callbacks. |

#### `tapToTalkStart`/`tapToTalkEnd` in detail

`tapToTalkEnd` schedules a 300ms timer that mints the turn from whatever was buffered during the tap window. The SDK emits this pair from `KalturaAvatarSession#startTapToTalk()`/`#endTapToTalk()`; the resulting turn arrives via the existing `agentTurnToTalk` handler like any open-mic turn.

**Do not use for typed-text barge-in.** Bracketing `onTextEntered` inside this pair mints a duplicate turn, since neither `tapToTalkStart` nor `tapToTalkEnd` invalidates a turn already in flight.

**Why `isTapToTalk:true` is required, not optional.** The server registers its tap-to-talk handlers unconditionally, regardless of how the agent is configured — the server accepts these events either way. Safety comes from a different branch: the transcript handler decides whether to buffer transcripts for the tap window or auto-cut a turn immediately by checking the *config* flag `isTapToTalk`, not the live tap-mode conversation state. On an open-mic (`isTapToTalk:false`) agent, VAD keeps minting turns unconditionally through a tap window, racing the same internal conversation state with no mutual exclusion server-side. The SDK closes this gap client-side instead: `startTapToTalk()` throws `capability_disabled` unless `capabilities.tapToTalk` is set.

For the app-level decision of when to use this mode and how to design its UI, see [Voice Input Modes](/guides/voice-input-modes/).

### 4b. Server → Client (on) — handshake/session phase

| Event | Payload (captured) | Schema / source | Meaning |
|---|---|---|---|
| `onServerConnected` | `{ finalUrl, agentName?, hostName?, loadingVideoURL? }` | built-in client | Server handshake done. `finalUrl` = STV video origin; `hostName` = the server instance (sticky). |
| `clientConfiguration` | `{ clientConfiguration:{ configuration, nluFeatures, languageCode, isTapToTalk, interruptionsEnabled, pauseConversationEnabled, showTranscription, isWebSearchEnabled, isScreenShareEnabled, isCameraAnalysisEnabled, audioMode, phoneMode, shouldAggregateCurrentTurn, youtubeUrl, initialHtml, visualPhotos:[], visualVideos:[], agentPersonaName, userName } }` | built-in client | Per-session agent config (see [§7](/reference/wire-protocol/client-configuration/#clientconfiguration-fields-per-session-agent-config) for field meanings). |
| `validSession` | `{}` | server | Entry/session validated OK (reply to client `isValidSession`); failure instead yields `throwToBadRequest`/`throwToExceededTier`. |
| `joinComplete` | `{}` | built-in client | Room join acknowledged. |
| `stvNewSession` | normal STV: `{ session_id, status:"session started", webrtc_url? }`; **audio/phone mode**: `{ status:"audio/phone mode - no STV session" }` (no `session_id`/`webrtc_url`) | server; built-in client | STV session created; `webrtc_url` = the WHEP play URL. The audio/phone variant skips STV entirely. |
| `showAgent` | `{}` | server; built-in client | Agent has joined / is ready. |
| `askPermissions` | `{ constraints:{ audio: boolean \| {echoCancellation}, video: boolean } }` | server; built-in client | Server requests mic/cam; drives `getUserMedia`. **Conditional/deferred:** when the flow's initial turn sets `ask_permissions_after_initial_turn` (and the pause-session isn't released), the server runs the agent's opening turn first and emits `askPermissions` only afterward. |
| `throwToNoAgent` | `{}` | server | All agent slots busy → `NoAgentsAvailable`. **Terminal for the socket** — the server calls `socket.disconnect()` immediately after emitting it. To wait for capacity, open a **new** socket and poll `checkAvailability` on it; the `[30,45,60,90,120,180,240,300,360]s` schedule is the **client** poll cadence. Else fatal `CAPACITY_UNAVAILABLE (6001)`. |
| `throwToExceededTier` | `{}` | server; built-in client | Account plan limit → `ExceededTierLimits`; fatal `TIER_EXCEEDED (6002)`, no reconnect. |
| `unsupportedClient` | `{ code }` — `'USAGE_LIMIT_EXCEEDED'` or `'INTERNAL_ERROR'` | server (emitted directly during session setup, before `join` completes) | Fatal connection-setup failure, then the socket is torn down. |
| `throwToBadRequest` / `removePeer` | `{}` | built-in client | Fatal disconnect reasons: `BadRequest` / `PeerRemoved`. |
| `availabilityResult` | `{ available, reason?, details?:{ stvAvailable, whisperAvailable, activeCalls, maxCalls, capacityAvailable } }` (or `{ error, available:false }`) | server; capacity from server | Reply to the client `checkAvailability` poll; the socket stays open (never disconnects). Emit `stvNewSession`/proceed only when `available===true`. |

### 4c. Server → Client (on) — ASR signaling (relayed over the socket)

| Event | Payload (captured) | Source | Meaning |
|---|---|---|---|
| `asr-webrtc-ready` | `{}` | server; subscribed by built-in client | Backend ready for ASR WebRTC signaling. |
| `asr-webrtc-answer` | `{ answer:{type:"answer", sdp} }` | server; subscribed by built-in client | SDP answer for the mic uplink (server is `setup:active`). |
| `asr-ice-candidate` | `{ uid, type:"ice_candidate", candidate, sdpMLineIndex }` | server (relayed from the ASR server); subscribed by built-in client | A remote ICE candidate for the ASR pc. Captured value is a private `10.x typ host` — why ASR still relays through TURN ([§5](/reference/wire-protocol/audio-channels/#5-asr-uplink-pc1--microphone--server)). |
| `asr-webrtc-error` | `{ error? }` | server; subscribed by built-in client | ASR signaling error. |

### 4d. Server → Client (on) — conversation phase

These fire once `approvedPermissions` is sent. Several are **server-emitted but only the built-in client OR the embed client OR a debug panel subscribes** — noted per row.

| Event | Payload (captured) | Subscribed by | Meaning |
|---|---|---|---|
| `agent_raw_text` | `{ speechId, turnId, delta:"<JSON string>" }` | built-in client; `SDK:session.js` | The brain's streaming output. `delta` is a JSON string — parse it ([§4e](#4e-agent_raw_textdelta--the-brain-stream-parsed)). |
| `agent_start_speech` | `{ speechId, turnId, isNewTurn }` | built-in client; `SDK:session.js` | A new speech segment begins. |
| `agent_end_turn` | `{ speechId, turnId }` | captured; `SDK:session.js` | The agent's turn is complete. |
| `generatingSpeech` | `{ text, speechId }` | embed client; `SDK:session.js` | **Clean sentence text** the avatar will speak — authoritative word spacing. Arrives before audio. |
| `debug_stvTaskGenerated` | `{ text, speechId, duration }` | embed client; debug panel; captured | Raw token chunks, arrive **before** `stvStartedTalking`. Heuristic caption path (needs `debugMode`). |
| `stvSpeechChunk` | `{ text, speechId, durationMs }` | embed client; `SDK:session.js` | **Server-timed, authoritative** caption chunk + exact duration; supersedes the heuristic path. Empty sentinels (`text:""`, `durationMs:1`) are filtered. Arrives ~400 ms before audio plays. For sync, add ~400 ms display delay. |
| `stvStartedTalking` | `{}` | built-in client; `SDK:session.js` | Audio generation begins → `isAgentTalking=true`. Playback arrives ~400ms later. Do not use to trigger captions. |
| `stvFinishedTalking` | `{ agentContent:"<full spoken text>" }` | built-in client; `SDK:session.js` | Avatar finished a turn. Reset caption buffers on THIS, not on `stvStartedTalking`. |
| `stvFinishedGenerating` | `{ speechId }` | embed client; `SDK:session.js` | Server finished generating the speech for `speechId` (generation ≠ playback end). |
| `agentTurnToTalk` | `{ userTranscription? }` | debug panel; embed client; `SDK:session.js` | User's turn finished; hand-off to the agent. `userTranscription` is present only on the user-speech hand-off (`onAgentTurnToTalk`, `withUserSpeech===true`); the payload is `{}` on the final-turn callback and non-user-speech calls. |
| `debug_vad_speech_detected` | `{ transcript, isFinal, segmentType, isSpeechStartEvent }` | debug panel; embed client; captured | Interim/final ASR from server VAD. `segmentType:"correction"` = speculative (revised each interim); only `isFinal:true` commits. Requires `debugMode`. |
| `debug_llm_input` | `{ userInput, finalSegment, pendingSegment, speechId, segmentType, isFinal }` | captured | The exact text handed to the LLM for this turn. |
| `debug_conversationStateChange` | `{ state, preparingAnswerState }` | debug panel; captured | Server conversation FSM. Known `state` values: `Started`, `PreparingAudio`, `ArrivedFinalSubSegment`, `AgentTalking`, `Idle`. `preparingAnswerState`: `Idle`, `PreparingAnswer`, `PreparingAudio`. (Enum is server-side; values rendered as opaque strings client-side.) |
| `agentInterrupted` | `{}` | captured; `SDK:session.js` | Barge-in: the user spoke, or sent the `onTextEntered {isSpeechStart:true}` marker, and cut off the avatar mid-sentence. |
| `userStartedTalking` | `{}` | embed client | Server-side VAD onset (non-debug; fires without `debugMode`). |
| `hideTapToTalkButton` | `{}` | captured | UI hint from server (tap-to-talk affordance off for this config). |
| `conversationTimeWarning` | `{ remainingTime }` (seconds) | built-in client; `SDK:session.js` | Time-limit warning. |
| `conversationEnded` | `{}` | built-in client; `SDK:session.js` | Server ended the conversation → tear down. |
| `showTapToTalkButton` | `{}` | server | Counterpart to `hideTapToTalkButton` — show the tap-to-talk affordance. |
| `stvTaskFail` | `{}` | server | STV send failed → the server hangs up the session. |
| `smartTurnStatus` | `{ status, timeout_ms?, probability? }` | server | Forwarded smart-turn VAD end-of-turn indicator — the server's assessment of whether the user has finished their turn (`probability`) and how long it will wait before deciding (`timeout_ms`). Passthrough only: the SDK re-emits it as its own `smartTurnStatus` event (`session.js`) but doesn't act on `status`'s value itself — see the event's JSDoc for the exact re-emitted shape. |
| `conversationTimeExpired` | `{}` | server | Active-session time expired — sent immediately before `conversationEnded`. |
| `sessionReadyForResume` | `{}` | server; `SDK:session.js` | Server-side session is recoverable for a same-instance reconnect (see [Platform Architecture](/explanation/architecture/) → resilience / connectionStateRecovery). SDK emits `resumeReady`. |
| `pauseSessionExpired` | `{}` | server; `SDK:session.js` | The pause window (started by a client `pauseConversation`) expired server-side before a `resumeConversation` arrived — the session is no longer recoverable. SDK emits `timeExpired` with `{type:'pause_expiry'}`, distinct from a hard `conversationEnded`. |
| `resumingSession` | `{}` | `SDK:session.js` | Server has accepted a client `resumeConversation` and is rebuilding the STV/ASR pipeline; precedes `conversationResumed`. SDK transitions to the `resuming` connection state. |
| `conversationResumed` | `{}` (captured: `[{}, "<ackId>"]` — a socket.io ack callback id may trail) | server; `SDK:session.js` | Reply to a client `resumeConversation` — the paused turn loop has resumed. |

### 4e. `agent_raw_text.delta` — the brain stream (parsed)

`delta` is a JSON string. Parsed shape:

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
| `tool` / `tool_response` | control (brain backend's response-formatter, tool-call/tool-result emission) | a tool call + result. `content` is the wire form `"<toolName> <json-args>"` (e.g. `navigate_to_slide {"slide_num": 4}`); the `tool` segment fires BEFORE server execution, `tool_response` after. **Three kinds:** internal (e.g. `get_experience_instructions` for GenUI formatting) fire on the text path regardless of config; external web-search is gated by `isWebSearchEnabled` (when off, the agent may *narrate* a search but emit **no** `tool` segment); and **a partner-configured tool referenced via `tool_ids`** — the **client-side-command channel**: a `tool` segment is NOT in the TTS gate, so its name+args ride silently (clean audio) for the host app to act on (`navigate_to_slide`, `call_page_function`, realtime content). Parse it with the SDK's `parseToolCall(seg)` / `session.onToolCall(name)` / `collectConverse().toolCalls`; author the tool with `tools.client(...)`. See [External API Integrations § Don't skip `kaltura_genie_experiences: 'off'`](/guides/external-api-integrations/#dont-skip-kaltura_genie_experiences-off) for why a command-driven intellect must turn that capability off, and at creation time. |
| `unisphere-tool` | control (brain backend's response-formatter, structured-experience emission) | structured-experience block. First segment carries `metadata:{widgetName, runtimeName}`; known runtimes `followups-tool`, `flashcards-tool`. See [§7](/reference/wire-protocol/client-configuration/#clientconfiguration-fields-per-session-agent-config). |
| `error` | control (brain backend's response-formatter, error emission) | brain/runtime error (`isFinal:true`) |
| `interruption` / `user-interruption` | control (brain backend's response-formatter, interruption/abort emission) | OAuth interruption / user-abort |
| `avatar`, `share`, `thread`, … | fence tag (LLM-chosen) | fenced blocks the model emits: `avatar` (spoken-runtime text), `share` (`{canShare:bool}`; `segmentStart&&segmentEnd` ⇒ message complete), `thread` (e.g. auto-title), and any other tag the prompt defines. `avatar` is in the parser's set of block types that stream chunk-by-chunk rather than all-at-once. |

#### Fused multi-tool `tool` segments

When a turn calls 2+ tools, the server can emit **one** `type:"tool"` segment whose `content` concatenates every called tool's JSON args back-to-back, but names only the **last** one — e.g. `open_filing {"quarters": [...], "metric": "total_revenue"}{"quarter": "q1_2026", "docType": "press_release"}` (the `highlight_chart` call that preceded `open_filing` rides in the same string, unnamed).

##### How the response echoes the missing name

The `tool_response` segments that follow still echo **every** called tool by name, in call order (`highlight_chart responded with size 113` then `open_filing responded with size 104`), which is the only reliable client-side signal for attributing the earlier, unnamed blob to its real tool.

##### How the SDK recovers it

The SDK's `parseToolCall(seg)` recovers the named tool's own args correctly (the last JSON object) and surfaces earlier blobs as `call.fusedArgs` (array, arrival order); `parseToolResponseName(seg)` extracts a `tool_response`'s echoed name. `KalturaAvatarSession` pairs the two automatically — an ASR-sub-turn-scoped queue of un-attributed `fusedArgs` blobs, drained by the next `tool_response` name not already dispatched this sub-turn — so every `onToolCall(name)` handler fires with correct args even on a fused turn; no app-level change is needed.

##### Queue reset boundary

The queue and its dispatched-names guard reset on **every** `agent_start_speech`, `isNewTurn` or not: a name dispatched directly in one ASR sub-turn must not block that same name's fused recovery in the next sub-turn of the same `turnId` — it's a distinct call with distinct args, not a repeat. This is narrower than the cross-turn `_firedToolCalls` dedup below, which stays keyed to a real `isNewTurn` boundary.

##### Headless caveat

Headless `collectConverse()` gets the corrected named-tool args for free but does **not** run this pairing recovery, so an earlier fused blob is only reachable via `fusedArgs` on that one `ToolCall`, not as its own `toolCalls` entry.

#### The `wait_for_response` ACK — one wire contract, two transports

A `tools.client` tool built `waitForResponse:true` blocks the model's turn until the host app supplies a result: the brain backend polls up to `timeout` seconds (default 30) for an ACK. The ACK is **not a socket event** — on both transports it is the same plain HTTPS POST, authorized by the session's own conversation KS (the model speaks the acked value in the *same* turn):

```
POST {genieUrl}/assistant/tool_response
Content-Type: application/json
Authorization: KS <conversation ks>

{ "tool_name": "<toolName>", "tool_id": "<toolMetadata.id>",
  "tool_invocation_id": "<toolMetadata.id>", "response": { …your JSON result… } }

→ 200 {}
```

`tool_id` and `tool_invocation_id` are both the `toolMetadata.id` from the parsed `tool` segment. This is exactly what `KalturaAvatarSession#respondToTool` (`SDK:session.js`) and `KalturaChatSession#respondToTool` (`SDK:chat-session.js`) send — the `tool` segment may arrive over the socket (`agent_raw_text`, above) or over the HTTP `/assistant/converse` chat stream, but the ACK path is identical, so one `waitForResponse:true` tool definition works unmodified on both transports. See [Client-Side Commands](/guides/client-commands/) for the app-level contract (`onToolCall` → `respondToTool`).

> `init_response` is **NOT** an HTTP-converse segment — it's a **WebSocket** event type defined in the brain backend's websocket layer. In the live runtime it arrives as the `delta` of the first `agent_raw_text` socket event (carrying `openingPhrase`/`threadId`/`messageId`); it never appears in an `/assistant/converse` HTTP stream.

> **Avatar-runtime segment handling.** The `type` values above are the brain's raw types. The session server's brain-bridge adapter **rewrites** a `type === 'unisphere-tool'` segment to its `metadata.runtimeName` (minus the `-tool` suffix) before yielding downstream, so a runtime client sees the adapter-normalized type, not the raw `unisphere-tool` name. The adapter yields **all** segment types (it doesn't drop non-spoken ones) along with `start`/`end`/`final`/`delta`. Because the bridge pins `force_experience: 'avatar_only'`, the brain's spoken content arrives primarily as `avatar` (streamed) / `avatar-filler` segments while control/structured types (`think`/`tool`/`unisphere-tool`/`share`/`thread`/`error`) stream alongside for the transcript/UI. **Note:** grouping `avatar-filler` under "spoken" here describes wire mechanics only. Unlike `avatar`/`text`, its phrasing is server-generated per turn and NOT reliably steerable via `base_directive` (see the `avatar_filler` capability note in [GenUI · Authoring and Consuming Widgets](/reference/genui/authoring-and-consuming/#authoring--which-capability-turns-each-widget-on)).

The built-in client's text-assembly logic only *assembles* `text | unisphere-tool | error` into the transcript and treats a start+end `share` as message-complete; it ignores `avatar | think | tool | tool_response` (those drive the live runtime).

#### Session-completion signal — tell the backend a conversation is truly over

Same auth model as the ACK above (conversation KS, no elevation), but fire-and-forget in the opposite direction — client tells server, no response payload to parse:

```
POST {genieUrl}/thread/session_completed
Content-Type: application/json
Authorization: KS <conversation ks>

{ "id": "<threadId>" }

→ 200 {}
```

Idempotent (a repeat POST for the same thread is a server-side no-op); no rate limit; can block up to ~10s on a backend publish-ack, so a client must never `await` it on a page-unload path — send with `fetch(url, {keepalive:true})`, never `navigator.sendBeacon` (can't carry `Authorization`). `KalturaAvatarSession`/`KalturaChatSession`/`KalturaAgentSession` send this automatically on `disconnect()` and on tab-close/backgrounding/bfcache-freeze; see [Architecture Reference § Session-completion signal](/reference/architecture-reference/resilience-and-failure-handling/#session-completion-signal-session_completed--telling-the-backend-a-conversation-is-truly-over) for the full trigger table and [README.md § Ending a conversation cleanly](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md#ending-a-conversation-cleanly-session_completed-signal) for the config surface.

### 4f. `speechId` — the per-utterance key (and the barge-in mechanism)

`speechId` appears on `agent_raw_text`, `agent_start_speech`, `agent_end_turn`, `generatingSpeech`, `stvSpeechChunk`, `debug_stvTaskGenerated`, `stvFinishedGenerating` — it is the **session server's identifier for one agent utterance**, and it is how you group a turn's events (do **not** group by timestamp — barge-ins interleave turns).

- **Format:** `` `${generateId(4)}-<trigger>-<payload>` `` — a 4-char nonce + the trigger + its content. Known triggers: `transcript` (a user speech/text turn — the same path `onTextEntered` feeds), `approved-permissions` (the opening greeting), plus `tap-to-talk`, `resume-replay`, `wake-up`, `begin-agent-conversation`, `contact-info-received`/`-rejected`, `html-element-click`, `iframe-completed`, `code-block-completed`, `hangup-message`. e.g. `4nkM-transcript-Hey, what's up?`, `1Yev-approved-permissions`.
- **Minted per utterance**, and it maps 1:1 to the brain's request `uuid`. `stvStartedTalking`/`stvFinishedTalking` carry **no** `speechId` in their payload — attribute them to the `speechId` of the surrounding `stvSpeechChunk`s.
- **The staleness guard = barge-in.** The server tracks a single active `speechId` per session; every TTS/STV event whose `speechId` doesn't match the currently active one is **dropped** (server-side). When a new user turn arrives, the server mints a new `transcript` `speechId` and makes it the active one — instantly invalidating the prior utterance's in-flight audio. That is exactly what `agentInterrupted` reflects. The `stvSpeechChunk` `speechId` switches at each `agentInterrupted` (e.g. `4nkM-transcript-…` → `agentInterrupted` → `d1qD-transcript-…`).

## Related docs

| Doc | Covers |
|---|---|
| [Wire Protocol · Connection Basics](/reference/wire-protocol/connection-basics/) | The connect sequence that leads into this catalog |
| [Wire Protocol · Audio Channels](/reference/wire-protocol/audio-channels/) | The ASR/STV events referenced above (§5/§6) |
| [Wire Protocol](/reference/wire-protocol/) | Back to the index |

