[← Back to Wire Protocol](../WIRE-PROTOCOL.md)

# 4. Socket.IO events — developer-facing catalog

Direction: `→` client emits, `←` server emits. "Captured" = seen in a live session. This covers the events a client integration uses. The server also defines internal, binary-relay events (e.g. `userVideoBinaryData`/`agentVideoBinaryData`, `contactCollector`) that aren't part of the developer-facing surface.

### 4a. Client → Server (emit)

| Event | Payload (captured) | Source | Meaning |
|---|---|---|---|
| `join` | `{ room, channel, kaltura:{ entryId?, contextId?, contextType?, threadId?, request_vars?, force_experience:"avatar_only", capabilities:{ avatar:"on", generate_followup_questions:"on", use_knowledge_base?:"off" } }, userAgent, userAgentHints, isMobile, channel_password:null, peer_name:"unknown", peer_video:false, peer_audio:true, client? }` | built-in client | Join the room. Carries the agent/brain config. The server binds the room from **`channel`** (`session.roomId = channel`) and reads `peer_*` + `kaltura.{ks,entryId,threadId,contextId,contextType,capabilities,request_vars}` (see [connection-and-handshake.md § The `join` payload](../architecture-reference/connection-and-handshake.md#the-join-payload-step-2-carries-the-agentbrain-config)). The top-level `room` field and the `force_experience` key are **not** consumed server-side. An avatar session always behaves as `force_experience: 'avatar_only'` regardless of what's sent (see [§7](client-configuration.md#7-clientconfiguration-fields-per-session-agent-config)). `use_knowledge_base:"off"` only when `context.type==='entry'`. `entryId`/`contextId`/`contextType` are set via `KalturaAvatarSession`'s `entryId`/`contextId`/`contextType` constructor options. |
| `stvNewSession` | `{ room_id, cast_mode? }` — `cast_mode` is the `StvCastMode` enum `"webrtc"\|"rtmp"`, **optional**; the built-in client sends `"rtmp"` explicitly, this SDK always omits it entirely | built-in client; `cast_mode` from built-in client; server | Ask server to create the STV (avatar video) session. `cast_mode` selects the STV egress. This SDK only ever takes the fully-omitted default path, which returns real working video in the current deployment — see [§6](audio-channels.md#6-stv-downlink-pc2--avatar-videoaudio--you). |
| `asr-webrtc-init` | `{ sessionId }` (client sends its socket id) | built-in client; server | Ask backend to prepare the ASR WebRTC endpoint. The `sessionId` is **advisory/ignored server-side** — the handler keys everything off `socket.id`. |
| `asr-webrtc-offer` | `{ offer:{type,sdp}, is_reconnect:false }` | built-in client | SDP offer for the mic uplink; awaits `asr-webrtc-answer`. |
| `asr-webrtc-ice-candidate` | `{ candidate:{candidate,sdpMLineIndex} }` | built-in client (media layer) | Trickle a local ICE candidate for the ASR pc (the SDK extracts only these two fields). |
| `approvedPermissions` | `SDK:session.js` sends `{ room }`; the built-in client sends `{ client, room }` — **server consumes nothing from it either way** | server; built-in client; `SDK:session.js _approve()` | Mic+video ready → sets `userReadyForConversation=true` and **starts the conversation/greeting**. |
| `onTextEntered` (server handler) / `debug_text_entered` (captured client emit) | server reads `{ text, isFinal, isSpeechStart? }` | server; client emit implemented as `SDK:session.js speak()`/`interrupt()`, which also emits the `debug_text_entered` mirror itself when the session was constructed with debug mode on (the embed client emits the same mirror independently) | **Drive the avatar by text** instead of voice. It's routed to the same path as ASR transcripts, NOT `/assistant/converse` HTTP (that never reaches the speech engine). `isFinal:false` marks a partial. `isSpeechStart:true` (with `text:''`) is the correct barge-in marker — the signal that interrupts the avatar mid-sentence (no-op if it's already idle). It's sent BEFORE the real text on every `speak()` call, and alone from `interrupt()`. The server routes by the socket's own room (`room: socket.id`) and **does not read `room_id`/`session_id`** — those fields seen in captures are ignored server-side. |
| `tapToTalkStart` / `tapToTalkEnd` | `{}` | server | Push-to-talk voice-capture mode (a button tap, not typed text) — switches the session into tap-mode and resets its buffered speech. **Only use this on an agent configured `isTapToTalk:true`** — see below for the SDK's client-side guard. |
| `isValidSession` | `{ client, clickId, hashClickId, userAgent }` | server | Ask the server to validate the entry/session before joining → replies `validSession` (or `throwToBadRequest`/`throwToExceededTier`). |
| `checkAvailability` | `{}` (server reads mode/language from `clientConfiguration`, not the arg) | server | Poll for a free agent slot without queuing — platform has no server-side queue; client-side polling only. Replies `availabilityResult`. |
| `pauseConversation` / `resumeConversation` | `{}` | server | Pause/resume the live turn loop. |
| `muteUser` / `unmuteUser` | `{}` | `SDK:session.js micEnabled` setter; server | Notify the server of mic mute/unmute. Muting is client-side (`track.enabled`). The server reads nothing from the payload — it uses the event only for logging, analytics, and turn-taking. |
| `setDebugMode` | `{ debugMode }` | server | Toggle the `debug_*` event stream at runtime (complements the `?debugMode` query param). |
| `userCameraShot` / `userScreenShareShot` | `{ data }` (ArrayBuffer) | server | Push a camera / screen-share still for vision analysis (gated by the camera/screen-share capabilities). |
| `updateGenieContext` | `{ capabilities:{…}, request_vars:{…} }` | `SDK:session.js updateRequestVars()`/`setDynamicPrompt()`; server | Mid-session context update. The server **replaces** its stored context with exactly what arrives — an omitted field is an explicit clear. So the SDK always sends the full shape: the join-time capabilities plus its full canonical `request_vars` map. (This merge happens client-side. `setDynamicPrompt(data)` is the same emit, with the payload serialized into the `page_context` variable.) |
| `onHtmlElementClick` / `iframeComplete` / `codeBlockComplete` / `setFormLeadInfo` | per handler (e.g. `{ htmlText }`, `{ message }`, `{ data }`) | server | GenUI / structured-data-form interaction callbacks. |

#### `tapToTalkStart`/`tapToTalkEnd` in detail

`tapToTalkEnd` schedules a 300ms timer that mints the turn from whatever was buffered during the tap window. The SDK emits this pair from `KalturaAvatarSession#startTapToTalk()`/`#endTapToTalk()`. The resulting turn arrives via the existing `agentTurnToTalk` handler like any open-mic turn.

**Do not use for typed-text barge-in.** Bracketing `onTextEntered` inside this pair mints a duplicate turn, since neither `tapToTalkStart` nor `tapToTalkEnd` invalidates a turn already in flight.

**Why `isTapToTalk:true` is required, not optional.** Mixing tap-to-talk with an open-mic (`isTapToTalk:false`) agent produces unreliable turn-taking — the two capture modes aren't meant to run together. The SDK enforces this client-side: `startTapToTalk()` throws `capability_disabled` unless `capabilities.tapToTalk` is set.

For the app-level decision of when to use this mode and how to design its UI, see [VOICE-INPUT-MODES.md](../VOICE-INPUT-MODES.md).

### 4b. Server → Client (on) — handshake/session phase

| Event | Payload (captured) | Schema / source | Meaning |
|---|---|---|---|
| `onServerConnected` | `{ finalUrl, agentName?, hostName?, loadingVideoURL? }` | built-in client | Server handshake done. `finalUrl` = STV video origin; `hostName` = the server instance (sticky). |
| `clientConfiguration` | `{ clientConfiguration:{ configuration, nluFeatures, languageCode, isTapToTalk, interruptionsEnabled, pauseConversationEnabled, showTranscription, isWebSearchEnabled, isScreenShareEnabled, isCameraAnalysisEnabled, audioMode, phoneMode, shouldAggregateCurrentTurn, youtubeUrl, initialHtml, visualPhotos:[], visualVideos:[], agentPersonaName, userName } }` | built-in client | Per-session agent config (see [§7](client-configuration.md#7-clientconfiguration-fields-per-session-agent-config) for field meanings). |
| `validSession` | `{}` | server | Entry/session validated OK (reply to client `isValidSession`); failure instead yields `throwToBadRequest`/`throwToExceededTier`. |
| `joinComplete` | `{}` | built-in client | Room join acknowledged. |
| `stvNewSession` | normal STV: `{ session_id, status:"session started", webrtc_url? }`; **audio/phone mode**: `{ status:"audio/phone mode - no STV session" }` (no `session_id`/`webrtc_url`) | server; built-in client | STV session created; `webrtc_url` = the WHEP play URL. The audio/phone variant skips STV entirely. |
| `showAgent` | `{}` | server; built-in client | Agent has joined / is ready. |
| `askPermissions` | `{ constraints:{ audio: boolean \| {echoCancellation}, video: boolean } }` | server; built-in client | Server requests mic/cam; drives `getUserMedia`. **Conditional/deferred:** when the flow's initial turn sets `ask_permissions_after_initial_turn` (and the pause-session isn't released), the server runs the agent's opening turn first and emits `askPermissions` only afterward. |
| `throwToNoAgent` | `{}` | server | All agent slots busy. **Terminal for the socket** — the server calls `socket.disconnect()` immediately after emitting it. To wait for capacity, open a **new** socket and poll `checkAvailability` on it. The `[30,45,60,90,120,180,240,300,360]s` schedule is the **client** poll cadence. `SDK:session.js` surfaces this as a `KalturaError` with `code:'capacity_unavailable'`, `status:6001`. |
| `throwToExceededTier` | `{}` | server; built-in client | Account plan limit reached. `SDK:session.js` surfaces this as a `KalturaError` with `code:'tier_exceeded'`, `status:6002`; no reconnect. |
| `unsupportedClient` | `{ code }` — `'USAGE_LIMIT_EXCEEDED'` or `'INTERNAL_ERROR'` | server (emitted directly during session setup, before `join` completes) | Fatal connection-setup failure, then the socket is torn down. `SDK:session.js` surfaces this as a `KalturaError` with `code:'unsupported_client'`; the server's own `code` value rides in the error's `detail`. |
| `throwToBadRequest` / `removePeer` | `{}` | built-in client | Fatal disconnect reasons. `SDK:session.js` surfaces these as a `KalturaError` with `code:'bad_request'` (`status:400`) / `code:'peer_removed'` (`status:401`). |
| `availabilityResult` | `{ available, reason?, details?:{ stvAvailable, whisperAvailable, activeCalls, maxCalls, capacityAvailable } }` (or `{ error, available:false }`) | server; capacity from server | Reply to the client `checkAvailability` poll; the socket stays open (never disconnects). Emit `stvNewSession`/proceed only when `available===true`. |

### 4c. Server → Client (on) — ASR signaling (relayed over the socket)

| Event | Payload (captured) | Source | Meaning |
|---|---|---|---|
| `asr-webrtc-ready` | `{}` | server; subscribed by built-in client | Backend ready for ASR WebRTC signaling. |
| `asr-webrtc-answer` | `{ answer:{type:"answer", sdp} }` | server; subscribed by built-in client | SDP answer for the mic uplink (server is `setup:active`). |
| `asr-ice-candidate` | `{ uid, type:"ice_candidate", candidate, sdpMLineIndex }` | server; subscribed by built-in client | A remote ICE candidate for the ASR pc. Captured value is a private `10.x typ host` — why ASR still relays through TURN ([§5](audio-channels.md#5-asr-uplink-pc1--microphone--server)). |
| `asr-webrtc-error` | `{ error? }` | server; subscribed by built-in client | ASR signaling error. |

### 4d. Server → Client (on) — conversation phase

These fire once `approvedPermissions` is sent. Several are **server-emitted but only the built-in client OR the embed client OR a debug panel subscribes** — noted per row. Many of these payloads carry a `speechId`, the per-utterance identifier explained in [§4f](#4f-speechid--the-per-utterance-key-and-the-barge-in-mechanism) below.

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
| `smartTurnStatus` | `{ status, timeout_ms?, probability? }` | server | Forwarded smart-turn VAD end-of-turn indicator — the server's assessment of whether the user has finished their turn (`probability`) and how long it will wait before deciding (`timeout_ms`). Passthrough only. The SDK re-emits it as its own `smartTurnStatus` event (`session.js`) but doesn't act on `status`'s value itself — see the event's JSDoc for the exact re-emitted shape. |
| `conversationTimeExpired` | `{}` | server | Active-session time expired — sent immediately before `conversationEnded`. |
| `sessionReadyForResume` | `{}` | server; `SDK:session.js` | Server-side session is recoverable for a same-instance reconnect (see [ARCHITECTURE.md](../ARCHITECTURE.md) → resilience / connectionStateRecovery). SDK emits `resumeReady`. |
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

Always-present fields are `role` (always `"assistant"`), `type`, `content`, `segmentNumber`, and `et` (elapsed seconds) — set by the server on every segment it sends. The rest are conditional `extra` keys. For example, `threadId`/`messageId` ride the first `think` segment, and `metadata` rides `unisphere-tool`.

**How `type` is determined.** The brain emits markdown. The server sets each segment's `type` from the **code-fence language tag** the LLM writes, and defaults to `text` for un-fenced prose. So the fence-driven types are **open-ended** — the LLM chooses them. On top of that, a fixed set of **control** types is emitted by hardcoded response-formatting calls.

| `type` | Source | Meaning |
|---|---|---|
| `text` | parser default (un-fenced) | brain prose; what the typed-chat UI renders |
| `think` | control | "preparing to answer…"; start/end bracket the thinking phase; final `think` carries `isFinal:true` |
| `tool` / `tool_response` | control (server-emitted: tool call / tool result) | A tool call and its result. `content` is the wire form `"<toolName> <json-args>"` (e.g. `navigate_to_slide {"slide_num": 4}`). The `tool` segment fires before server execution; `tool_response` fires after. There are three kinds of `tool` segments — see [below](#three-kinds-of-tool-segments). |
| `unisphere-tool` | control (server-emitted: structured experience) | structured-experience block. First segment carries `metadata:{widgetName, runtimeName}`; known runtimes `followups-tool`, `flashcards-tool`. See [§7](client-configuration.md#7-clientconfiguration-fields-per-session-agent-config). |
| `error` | control (server-emitted: error) | brain/runtime error (`isFinal:true`) |
| `interruption` / `user-interruption` | control (server-emitted: interruption / abort) | OAuth interruption / user-abort |
| `avatar`, `share`, `thread`, … | fence tag (LLM-chosen) | fenced blocks the model emits: `avatar` (spoken-runtime text), `share` (`{canShare:bool}`; `segmentStart&&segmentEnd` ⇒ message complete), `thread` (e.g. auto-title), and any other tag the prompt defines. `avatar` is in the parser's set of block types that stream chunk-by-chunk rather than all-at-once. |

#### Three kinds of `tool` segments

| Kind | When it fires | Notes |
|---|---|---|
| Internal | Always, regardless of config | E.g. `get_experience_instructions`, used for GenUI formatting |
| External web search | Only when `isWebSearchEnabled` is on | When off, the agent may *narrate* a search but emits **no** `tool` segment |
| Partner-configured tool (`tool_ids`) | The client-side-command channel | A `tool` segment is not in the text-to-speech (TTS) gate, so its name and args ride silently (clean audio) for the host app to act on (`navigate_to_slide`, `call_page_function`, realtime content) |

Parse a tool call with the SDK's `parseToolCall(seg)`, `session.onToolCall(name)`, or `collectConverse().toolCalls`. Author the tool with `tools.client(...)`. See [EXTERNAL-API-INTEGRATIONS.md § Don't skip `kaltura_genie_experiences: 'off'`](../EXTERNAL-API-INTEGRATIONS.md#dont-skip-kaltura_genie_experiences-off) for why a command-driven intellect (the agent's brain configuration — its prompts, tools, and capabilities) must turn that capability off, and only at creation time.

#### Fused multi-tool `tool` segments

When a turn calls two or more tools, the server can emit **one** `type:"tool"` segment. Its `content` concatenates every called tool's JSON args back-to-back, but names only the **last** one — e.g. `open_filing {"quarters": [...], "metric": "total_revenue"}{"quarter": "q1_2026", "docType": "press_release"}`. The `highlight_chart` call that preceded `open_filing` rides in the same string, unnamed.

##### How the response echoes the missing name

The `tool_response` segments that follow still echo **every** called tool by name, in call order (`highlight_chart responded with size 113` then `open_filing responded with size 104`). This is the only reliable client-side signal for attributing the earlier, unnamed blob to its real tool.

##### How the SDK recovers it

The SDK's `parseToolCall(seg)` recovers the named tool's own args correctly (the last JSON object), and surfaces earlier blobs as `call.fusedArgs` (an array, in arrival order). `parseToolResponseName(seg)` extracts a `tool_response`'s echoed name. `KalturaAvatarSession` pairs the two automatically, using an ASR-sub-turn-scoped queue of un-attributed `fusedArgs` blobs. The queue drains on the next `tool_response` name not already dispatched in this sub-turn, so every `onToolCall(name)` handler fires with correct args even on a fused turn. No app-level change is needed.

##### Queue reset boundary

The queue and its dispatched-names guard reset on **every** `agent_start_speech`, whether `isNewTurn` is true or not. A name dispatched directly in one ASR sub-turn must not block that same name's fused recovery in the next sub-turn of the same `turnId` — it's a distinct call with distinct args, not a repeat. This is narrower than the SDK's own cross-turn `_firedToolCalls` dedup, which drops an exact repeat (same name, same args) and only clears on a real `isNewTurn` boundary — a separate mechanism from this turn-scoped fused-recovery queue.

##### Headless caveat

Headless `collectConverse()` gets the corrected named-tool args for free, but it does **not** run this pairing recovery. An earlier fused blob is only reachable via `fusedArgs` on that one `ToolCall`, not as its own `toolCalls` entry.

#### The `wait_for_response` ACK — one wire contract, two transports

A `tools.client` tool built with `waitForResponse:true` blocks the model's turn until the host app supplies a result. The brain backend polls up to `timeout` seconds (default 30) for an ACK. The ACK is **not a socket event**. On both transports it is the same plain HTTPS POST, authorized by the session's own conversation KS — the model speaks the acked value in the *same* turn:

```
POST {genieUrl}/assistant/tool_response
Content-Type: application/json
Authorization: KS <conversation ks>

{ "tool_name": "<toolName>", "tool_id": "<toolMetadata.id>",
  "tool_invocation_id": "<toolMetadata.id>", "response": { …your JSON result… } }

→ 200 {}
```

`tool_id` and `tool_invocation_id` are both the `toolMetadata.id` from the parsed `tool` segment. This is exactly what `KalturaAvatarSession#respondToTool` (`SDK:session.js`) and `KalturaChatSession#respondToTool` (`SDK:chat-session.js`) send. The `tool` segment may arrive over the socket (`agent_raw_text`, above) or over the HTTP `/assistant/converse` chat stream, but the ACK path is identical. So one `waitForResponse:true` tool definition works unmodified on both transports. See [CLIENT-COMMANDS.md](../CLIENT-COMMANDS.md) for the app-level contract (`onToolCall` → `respondToTool`).

> `init_response` is **NOT** an HTTP-converse segment. It's a **WebSocket** event type defined in the brain backend's websocket layer. In the live runtime it arrives as the `delta` of the first `agent_raw_text` socket event (carrying `openingPhrase`/`threadId`/`messageId`). It never appears in an `/assistant/converse` HTTP stream. When the intellect has an `opening_phrase`, the backend renders it (Jinja2 over `request_vars`) and its `openingPhrase` value replaces the phrase the client sent.

> **Stored-only message types.** Two message types never stream. They only appear when you read the thread back (`mgmt.messages`/`mgmt.threads`, and the thread `transcript` as `opening: ...`). `opening` is the rendered `opening_phrase`, stored as the thread's first assistant message: `{ type: 'opening', content: [{ type: 'avatar', content: '<rendered phrase>', metadata: {} }] }`. `summary` is written once when an avatar session ends and the intellect has an `avatar_summary_config` (or the default). Its stored shape is `{ type: 'summary', content: [{ type: 'text', content: '<rendered template>', metadata: {} }] }`, alongside `session_duration` on the stored row. It is skipped when the thread has no human messages.

> **Avatar-runtime segment handling.** The `type` values above are the brain's raw types. On the avatar runtime, a `type === 'unisphere-tool'` segment already arrives rewritten to its `metadata.runtimeName` (minus the `-tool` suffix). So a runtime client sees that normalized type, not the raw `unisphere-tool` name. Every segment type is delivered (none are dropped) along with `start`/`end`/`final`/`delta`. Because an avatar session always runs as `force_experience: 'avatar_only'`, the brain's spoken content arrives primarily as `avatar` (streamed) / `avatar-filler` segments. Control/structured types (`think`/`tool`/`unisphere-tool`/`share`/`thread`/`error`) stream alongside for the transcript/UI. **Note:** grouping `avatar-filler` under "spoken" here describes wire mechanics only. Unlike `avatar`/`text`, its phrasing is server-generated per turn and NOT reliably steerable via `base_directive` (see the `avatar_filler` capability note in [genui/authoring-and-consuming.md](../genui/authoring-and-consuming.md#authoring--which-capability-turns-each-widget-on)).

The built-in client's text-assembly logic only *assembles* `text | unisphere-tool | error` into the transcript, and treats a start+end `share` as message-complete. It ignores `avatar | think | tool | tool_response` (those drive the live runtime).

#### Session-completion signal — tell the backend a conversation is truly over

Same auth model as the ACK above (conversation KS, no elevation), but fire-and-forget in the opposite direction — client tells server, no response payload to parse:

```
POST {genieUrl}/thread/session_completed
Content-Type: application/json
Authorization: KS <conversation ks>

{ "id": "<threadId>" }

→ 200 {}
```

The SDK itself is idempotent about sending it. A `sent` flag means a repeat call for the same session is a client-side no-op. On a page-unload path (`pagehide`, hidden-grace) the SDK never applies a timeout and never awaits the response. It fires with `fetch(url, {keepalive:true})`, never `navigator.sendBeacon` (which can't carry `Authorization`).

On other paths (`disconnect()`, idle auto-logoff) the SDK aborts the request after `sessionCompleteTimeoutMs` (default `5000`). `KalturaAvatarSession`/`KalturaChatSession`/`KalturaAgentSession` send this automatically on `disconnect()` and on tab-close/backgrounding/bfcache-freeze. See [ARCHITECTURE-REFERENCE.md § Session-completion signal](../architecture-reference/resilience-and-failure-handling.md#session-completion-signal-session_completed-telling-the-backend-a-conversation-is-truly-over) for the full trigger table, and [README.md § Ending a conversation cleanly](../../README.md#ending-a-conversation-cleanly-session_completed-signal) for the config surface.

### 4f. `speechId` — the per-utterance key (and the barge-in mechanism)

`speechId` appears on `agent_raw_text`, `agent_start_speech`, `agent_end_turn`, `generatingSpeech`, `stvSpeechChunk`, `debug_stvTaskGenerated`, and `stvFinishedGenerating`. It is the **session server's identifier for one agent utterance**, and it's how you group a turn's events. Do **not** group by timestamp — barge-ins interleave turns.

- **Format:** `` `${generateId(4)}-<trigger>-<payload>` `` — a 4-char nonce, then the trigger, then its content. For example: `4nkM-transcript-Hey, what's up?`, `1Yev-approved-permissions`.

  Known triggers:

  | Trigger | Meaning |
  |---|---|
  | `transcript` | A user speech/text turn — the same path `onTextEntered` feeds |
  | `approved-permissions` | The opening greeting. Typed text cannot interrupt it; `speak()` holds text until it ends |
  | `tap-to-talk` | — |
  | `resume-replay` | The replayed last line after a `resume()`. Same hold as the greeting |
  | `wake-up` | The server's own "are you still there?" check-in after a silence. Typed text cannot interrupt it; `speak()` holds text until it ends |
  | `begin-agent-conversation` | — |
  | `contact-info-received` / `contact-info-rejected` | — |
  | `html-element-click` | — |
  | `iframe-completed` | — |
  | `code-block-completed` | — |
  | `hangup-message` | The server's goodbye line before it ends the session. Typed text cannot interrupt it; `speak()` holds, then resolves `false` when the session ends |

- **Minted per utterance**, and it maps 1:1 to the brain's request `uuid`. `stvStartedTalking`/`stvFinishedTalking` carry **no** `speechId` in their payload. Attribute them to the `speechId` of the surrounding `stvSpeechChunk`s.
- **The staleness guard is what makes barge-in work.** The server tracks a single active `speechId` per session. Any TTS/STV event whose `speechId` doesn't match the current one is **dropped** server-side. When a new user turn arrives, the server mints a new `transcript` `speechId` and makes it the active one, instantly invalidating the prior utterance's in-flight audio. That is exactly what `agentInterrupted` reflects. The `stvSpeechChunk` `speechId` switches at each `agentInterrupted` (e.g. `4nkM-transcript-…` → `agentInterrupted` → `d1qD-transcript-…`).

## Related docs

| Doc | Covers |
|---|---|
| [connection-basics.md](connection-basics.md) | The connect sequence that leads into this catalog |
| [audio-channels.md](audio-channels.md) | The ASR/STV events referenced above (§5/§6) |
| [../WIRE-PROTOCOL.md](../WIRE-PROTOCOL.md) | Back to the index |
