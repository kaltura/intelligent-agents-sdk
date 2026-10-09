[← Back to Wire Protocol](../WIRE-PROTOCOL.md)

# 4. Socket.IO events — developer-facing catalog

Direction: `→` the client emits, `←` the server emits. This catalog covers the events `KalturaAvatarSession` sends and handles. The [golden fixture](https://github.com/kaltura/intelligent-agents-sdk/blob/main/test/fixtures/golden-session.json) holds one real capture.

### 4a. Client → Server (emit)

| Event | Payload | Meaning |
|---|---|---|
| `join` | `{ room, channel, kaltura:{ ks, entryId?, contextId?, contextType?, threadId?, request_vars?, force_experience:"avatar_only", capabilities:{ avatar:"on", generate_followup_questions:"on", … } }, userAgent, userAgentHints, isMobile, channel_password:null, peer_name:"unknown", peer_video:false, peer_audio:true, client? }` | Join the room. Carries the agent config. `channel` identifies the room. `entryId`, `contextId` and `contextType` come from the `KalturaAvatarSession` constructor options of the same names. `force_experience` is always `avatar_only` ([§7](client-configuration.md#structured-experiences-force_experience--unisphere-tool)). Full field list: [connection-and-handshake.md § The `join` payload](../architecture-reference/connection-and-handshake.md#the-join-payload-step-2-carries-the-agentbrain-config). |
| `stvNewSession` | `{ room_id }` | Ask for the avatar video (STV) session. The SDK never sends `cast_mode`. |
| `checkAvailability` | `{}` | Capacity query. The reply is `availabilityResult`. The SDK sends it in parallel with `stvNewSession` during `connect()`, from `waitForCapacity()`, and from `keepAlive()`. |
| `asr-webrtc-init` | `{ sessionId }` (the client's socket id) | Start ASR signaling for the mic uplink. |
| `asr-webrtc-offer` | `{ offer:{type,sdp}, is_reconnect }` | SDP offer for the mic uplink. `is_reconnect` is `true` when the SDK renegotiates after an ICE failure. Awaits `asr-webrtc-answer`. |
| `asr-webrtc-ice-candidate` | `{ candidate:{candidate,sdpMLineIndex} }` | Trickle a local ICE candidate for the ASR peer. |
| `approvedPermissions` | `{ room }` | Mic and video are ready. **Starts the opening greeting.** |
| `onTextEntered` | `{ text, isFinal, isSpeechStart? }` | **Drive the avatar by text** instead of voice. The text is treated like a spoken transcript. `isFinal:false` marks a partial. `isSpeechStart:true` with `text:''` is the barge-in marker: it interrupts the avatar mid-sentence, and does nothing if the avatar is idle. `speak()` sends the marker first and then the real text. `interrupt()` sends the marker alone. |
| `debug_text_entered` | `{ text, isFinal }` | A mirror of the final `onTextEntered`, sent by `speak()` only when the session was constructed with debug mode on. |
| `tapToTalkStart` / `tapToTalkEnd` | `{}` | Push-to-talk capture window, sent by `startTapToTalk()` / `endTapToTalk()`. See below. |
| `muteUser` / `unmuteUser` | `{}` | The `micEnabled` setter notifies the server of a mic mute or unmute. The mute itself is client-side (`track.enabled`). The payload has no data. |
| `pauseConversation` / `resumeConversation` | `{}` | `pause()` / `resume()`. |
| `updateGenieContext` | `{ capabilities, request_vars, contextId?, contextType? }` | Mid-session context update, sent by `updateRequestVars()` and `setDynamicPrompt()`. Each emit replaces the stored context, so an omitted field is a clear. The SDK always sends the full shape: its own capabilities, the full `request_vars` map, and `contextId` / `contextType` when set. `setDynamicPrompt(data)` is the same emit, with the payload serialized into the `page_context` variable. |
| `userScreenShareShot` | `{ data }` (ArrayBuffer) | A screen-share still for vision analysis, sent by `sendScreenShot()`. Needs `isScreenShareEnabled` in [`clientConfiguration`](client-configuration.md#7-clientconfiguration-fields-per-session-agent-config). |
| `onHtmlElementClick` / `setFormLeadInfo` | `{ htmlText }` / `{ …fields }` | GenUI and structured-data-form callbacks, sent by `notifyHtmlElementClick(info)` and `submitStructuredDataForm(values)`. |

#### `tapToTalkStart`/`tapToTalkEnd` in detail

`endTapToTalk()` ends the capture window, and the resulting turn arrives through `agentTurnToTalk` like any open-mic turn.

**Do not use this pair for typed-text barge-in.** Wrapping `onTextEntered` in it creates a duplicate turn.

**Use it only on an agent configured with `isTapToTalk: true`.** Mixing tap-to-talk with an open-mic agent gives unreliable turn-taking. The SDK enforces this: `startTapToTalk()` throws `capability_disabled` unless `capabilities.tapToTalk` is set.

For the app-level decision of when to use this mode and how to design its UI, see [VOICE-INPUT-MODES.md](../VOICE-INPUT-MODES.md).

### 4b. Server → Client (on) — handshake/session phase

| Event | Payload | Meaning |
|---|---|---|
| `onServerConnected` | `{ finalUrl, agentName?, hostName?, loadingVideoURL? }` | Handshake done. The SDK emits `streamReady` with `finalUrl`, `agentName` and `hostName`. |
| `clientConfiguration` | `{ clientConfiguration:{ configuration, nluFeatures, languageCode, isTapToTalk, interruptionsEnabled, pauseConversationEnabled, showTranscription, isWebSearchEnabled, isScreenShareEnabled, isCameraAnalysisEnabled, audioMode, phoneMode, shouldAggregateCurrentTurn, youtubeUrl, initialHtml, visualPhotos:[], visualVideos:[], agentPersonaName, userName } }` | Per-session agent config. Field meanings: [§7](client-configuration.md#7-clientconfiguration-fields-per-session-agent-config). |
| `joinComplete` | `{}` | Room join acknowledged. |
| `stvNewSession` | normal: `{ session_id, status:"session started", webrtc_url? }`; **audio/phone mode**: `{ status:"audio/phone mode - no STV session" }` (no `session_id` or `webrtc_url`) | The STV session is created. `webrtc_url` is the WHEP play URL. The audio/phone variant skips STV ([§5b](audio-channels.md#5b-audio-mode-webrtc-separate-from-the-asr-uplink)). |
| `showAgent` | `{}` | The agent has joined. |
| `askPermissions` | `{ constraints:{ audio: boolean \| {echoCancellation}, video: boolean } }` | The server is ready for the mic. |
| `throwToNoAgent` | `{}` | All agent slots are busy. The socket closes after it. `connect()` rejects with `KalturaError` `code:'capacity_unavailable'`, `status:6001`. To wait for a free slot, call `waitForCapacity()` before `connect()`. |
| `throwToExceededTier` | `{}` | Account plan limit reached. `KalturaError` `code:'tier_exceeded'`, `status:6002`. No reconnect. |
| `unsupportedClient` | `{ code }` | Fatal setup failure. The socket closes. `KalturaError` `code:'unsupported_client'`; the `code` value rides in the error's `detail`. |
| `throwToBadRequest` / `removePeer` | `{}` | Fatal disconnect reasons. `KalturaError` `code:'bad_request'` (`status:400`) / `code:'peer_removed'` (`status:401`). |
| `availabilityResult` | `{ available, details? }` (or `{ error, available:false }`) | Reply to `checkAvailability`. The socket stays open. The SDK re-emits it as `capacityChanged { available, details }`. During `connect()`, an `available:false` reply schedules the next poll on the backoff `[30,45,60,90,120,180,240,300,360]s` (±15% jitter). |

### 4c. Server → Client (on) — ASR signaling (relayed over the socket)

| Event | Payload | Meaning |
|---|---|---|
| `asr-webrtc-ready` | `{}` | ASR signaling is ready. Send the offer. |
| `asr-webrtc-answer` | `{ answer:{type:"answer", sdp} }` | SDP answer for the mic uplink. |
| `asr-ice-candidate` | `{ uid, type:"ice_candidate", candidate, sdpMLineIndex }` | A remote ICE candidate for the ASR peer. The SDK passes it to `addIceCandidate`. |
| `asr-webrtc-error` | `{ error? }` | ASR signaling error. |

### 4d. Server → Client (on) — conversation phase

These fire once `approvedPermissions` is sent. Many payloads carry a `speechId`, the per-utterance identifier ([§4f](#4f-speechid--the-per-utterance-key-and-the-barge-in-mechanism)).

| Event | Payload | Meaning |
|---|---|---|
| `agent_raw_text` | `{ speechId, turnId, delta:"<JSON string>" }` | The agent's streaming output. `delta` is a JSON string. Parse it ([§4e](#4e-agent_raw_textdelta--the-brain-stream-parsed)). |
| `agent_start_speech` | `{ speechId, turnId, isNewTurn }` | A new speech segment begins. `isNewTurn` is `false` when new ASR or typed text continues the turn in flight (a correction or extension of what the user just said), and `true` for a fresh turn. The SDK only reads this field. |
| `agent_end_turn` | `{ speechId, turnId }` | The agent's turn is complete. |
| `generatingSpeech` | `{ text, speechId }` | **Clean sentence text** the avatar will speak, with authoritative word spacing. Arrives before audio. |
| `stvSpeechChunk` | `{ text, speechId, durationMs }` | **Server-timed caption chunk** with its exact duration. Arrives about 400 ms before the audio plays, so add a display delay of about 400 ms to sync. Empty sentinels (`text:""`, `durationMs:1`) are filtered. |
| `stvStartedTalking` | `{}` | Audio generation begins (`isAgentTalking = true`). Playback follows about 400 ms later. Do not use it to trigger captions. |
| `stvFinishedTalking` | `{ agentContent:"<full spoken text>" }` | The avatar finished a turn. Reset caption buffers on **this** event, not on `stvStartedTalking`. |
| `stvFinishedGenerating` | `{ speechId }` | Speech generation for `speechId` finished (generation is not playback end). |
| `agentTurnToTalk` | `{ userTranscription? }` | The user's turn finished and the agent takes over. `userTranscription` is present only when the turn came from user speech. |
| `agentInterrupted` | `{}` | Barge-in. The user spoke, or sent the `onTextEntered { isSpeechStart:true }` marker, and cut the avatar off mid-sentence. |
| `userStartedTalking` | `{}` | The user started speaking. Fires without debug mode. |
| `hideTapToTalkButton` / `showTapToTalkButton` | `{}` | UI hint: hide or show the tap-to-talk affordance for this agent config. The SDK does not act on them. |
| `conversationTimeWarning` | `{ remainingTime }` (seconds) | Time-limit warning. The SDK emits `timeWarning`. |
| `conversationTimeExpired` | `{}` | The session time expired. Sent right before `conversationEnded`. The SDK emits `timeExpired`. |
| `conversationEnded` | `{}` | The conversation ended. The SDK emits `ended` and disconnects. |
| `stvTaskFail` | `{}` | Avatar video rendering failed. The SDK emits an `error` with `code:'stv_task_fail'`. |
| `smartTurnStatus` | `{ status, timeout_ms?, probability? }` | End-of-turn indicator for the user's speech. The SDK re-emits it as `smartTurnStatus { status, timeoutMs, probability }` and does not act on it. |
| `sessionReadyForResume` | `{}` | The session can be resumed on the same instance. The SDK emits `resumeReady`. |
| `pauseSessionExpired` | `{}` | The pause window ended before `resumeConversation` arrived. The session can't be resumed as it was. The SDK emits `timeExpired` with `{type:'pause_expiry'}`, distinct from a hard `conversationEnded`. |
| `resumingSession` | `{}` | The server accepted `resumeConversation` and is rebuilding the media pipeline. It precedes `conversationResumed`. The SDK moves to the `resuming` state. |
| `conversationResumed` | `{}` | The paused turn loop has resumed. The SDK emits `resumed`. |
| `debug_vad_speech_detected` | `{ transcript, isFinal, segmentType, isSpeechStartEvent }` | Interim and final speech recognition. Only `isFinal:true` commits. Diagnostic. |
| `debug_llm_input` | `{ userInput, finalSegment, pendingSegment, speechId, segmentType, isFinal }` | The text handed to the agent for this turn. Diagnostic. |
| `debug_stvTaskGenerated` | `{ text, speechId, duration }` | Raw text chunks before audio. Diagnostic. |
| `debug_conversationStateChange` | `{ state, preparingAnswerState }` | Turn-state diagnostic. Treat the values as opaque strings. |

The four `debug_*` events arrive because the SDK connects with `debugMode: true` ([§2](connection-basics.md#2-socketio-connection)). The SDK's captions and transcripts do not read them.

### 4e. `agent_raw_text.delta` — the brain stream (parsed)

`delta` is a JSON string. Parsed shape:

```js
{ role:"assistant", type, content, segmentNumber, et,            // always present
  threadId?, messageId?, segmentStart?, segmentEnd?, isFinal?,    // conditional
  metadata?:{widgetName?,runtimeName?} }                          // unisphere-tool segments
```

Every segment has `role` (always `"assistant"`), `type`, `content`, `segmentNumber` and `et` (elapsed seconds). The rest are conditional. For example, `threadId` and `messageId` ride the first `think` segment, and `metadata` rides `unisphere-tool`.

The set of `type` values is open-ended. Ignore types you don't handle.

| `type` | Meaning |
|---|---|
| `text` | Agent prose. What a typed-chat UI renders. |
| `think` | "Preparing to answer…". Start and end bracket the thinking phase. The final `think` carries `isFinal:true`. |
| `tool` / `tool_response` | A tool call and its result. `content` of a `tool` segment is `"<toolName> <json-args>"` (for example `navigate_to_slide {"slide_num": 4}`). See [below](#three-kinds-of-tool-segments). |
| `unisphere-tool` | A structured-experience block. The first segment carries `metadata:{widgetName, runtimeName}`. Known runtimes include `followups-tool` and `flashcards-tool`. See [§7](client-configuration.md#structured-experiences-force_experience--unisphere-tool). |
| `error` | Agent or runtime error (`isFinal:true`). |
| `interruption` / `user-interruption` | `interruption` carries an OAuth consent redirect (`metadata.subtype:"oauth_required"`, see [below](#oauth-consent-redirect-interruption--subtypeoauth_required)). `user-interruption` is an unrelated user barge-in, never an OAuth event, even if it carries a matching `subtype`. |
| `avatar`, `avatar-filler` | Spoken text for the avatar. |
| `share` | `{canShare:bool}`. `segmentStart` and `segmentEnd` together mean the message is complete. |
| `thread` | For example an auto-title. |

On the avatar socket, the SDK resolves a `unisphere-tool` segment to its `metadata.runtimeName` without the `-tool` suffix, so runtime clients work with the normalized name. Every segment type is delivered. The avatar session joins with `force_experience: 'avatar_only'`, so the spoken content arrives mainly as `avatar` and `avatar-filler` segments, and `think`, `tool`, `unisphere-tool`, `share`, `thread` and `error` stream alongside for the transcript and UI. The `avatar-filler` phrasing can't be reliably steered with `base_directive`. See the `avatar_filler` note in [genui/authoring-and-consuming.md](../genui/authoring-and-consuming.md#authoring--which-capability-turns-each-widget-on).

#### Three kinds of `tool` segments

| Kind | When it fires | Notes |
|---|---|---|
| Built-in | Always, regardless of config | For example GenUI formatting. |
| External web search | Only when `isWebSearchEnabled` is on | When off, the agent may *narrate* a search but emits **no** `tool` segment. |
| Partner-configured tool (`tool_ids`) | The client-side-command channel | A `tool` segment is not spoken, so its name and args ride silently for the host app to act on (`navigate_to_slide`, `call_page_function`, realtime content). |

Parse a tool call with `parseToolCall(seg)`, `session.onToolCall(name)`, or `collectConverse().toolCalls`. Author the tool with `tools.client(...)`. See [EXTERNAL-API-INTEGRATIONS.md § Don't skip `kaltura_genie_experiences: 'off'`](../EXTERNAL-API-INTEGRATIONS.md#dont-skip-kaltura_genie_experiences-off) for why a command-driven intellect (the agent's brain configuration: its prompts, tools, and capabilities) must turn that capability off, and only at creation time.

#### Fused multi-tool `tool` segments

When a turn calls two or more tools, one `type:"tool"` segment can carry all the JSON args back to back but name only the **last** tool. Example: `open_filing {"quarters": [...], "metric": "total_revenue"}{"quarter": "q1_2026", "docType": "press_release"}`. The earlier call rides in the same string, unnamed.

The `tool_response` segments that follow name **every** called tool, in call order (`highlight_chart responded with size 113`, then `open_filing responded with size 104`).

What the SDK does:

- `parseToolCall(seg)` returns the last JSON object as the named tool's args. Earlier objects appear as `call.fusedArgs` (an array, in arrival order).
- `parseToolResponseName(seg)` extracts the name a `tool_response` names.
- `KalturaAvatarSession` pairs the two and dispatches, so each `onToolCall(name)` handler fires with the right args. No app change is needed. It keeps the pairing state per ASR sub-turn and resets it on every `agent_start_speech`.
- Headless `collectConverse()` returns the named tool's args but does not pair. Reach the earlier blob through `fusedArgs` on that one `ToolCall`.

#### OAuth consent redirect (`interruption` / `subtype:"oauth_required"`)

When a tool call needs the end user to authorize access (an MCP server or an `api` tool wired to OAuth2), the turn doesn't fail. It pauses. The stream carries a `type:"interruption"` segment with a consent-redirect URL instead of a normal `tool_response`:

```js
{ role: "assistant", type: "interruption", segmentNumber, et,
  content: { auth_url: "https://…/authorize?…" },   // an object, not a plain string
  metadata: { tool_name: "jira_search", tool_display_name: "Jira", subtype: "oauth_required" } }
```

`content` is `{auth_url}` here, unlike every other segment type where `content` is a plain string. The segment rides `agent_raw_text` deltas on the live socket and NDJSON/SSE lines on the HTTP `/assistant/converse` stream, with no dedicated event. It reaches text and avatar sessions identically.

Parse it with `parseOAuthRequired(seg)` (`src/core/stream.js`). It returns `null` for anything else, including a `user-interruption`, and never throws:

```js
import { parseOAuthRequired } from '@kaltura/intelligent-agents/experience';

const oauth = parseOAuthRequired(seg);
// { authUrl: "https://…/authorize?…", toolName: "jira_search", toolDisplayName: "Jira" } | null
```

Or register a handler on the session. `session.onOAuthRequired(handler)` exists on `KalturaAvatarSession`, `KalturaChatSession`, and the mode-switching `KalturaAgentSession` facade (same signature on all three, re-registered automatically on a mode switch):

```js
const unsubscribe = session.onOAuthRequired(({ authUrl, toolName, toolDisplayName }) => {
  // send the end user to authUrl to complete the OAuth consent flow
});
```

Unlike `onToolCall(name, handler)`, `onOAuthRequired` takes no `name`: there is one OAuth event shape, not one per tool. Each handler runs isolated (a throw in one doesn't block the others) and fires once per distinct `authUrl` per turn. The session also re-emits a plain `oauthRequired` event, and an `oauthRequiredResult` event carrying each handler's return value, for callers who prefer `.on(...)`. Headless callers get the same data from `collectConverse().oauthRequired`, an array in arrival order.

**Rendering.** Feed the parsed `authUrl` and `toolDisplayName` into the [`show-link` GenUI widget](../genui/widgets.md#6-show-link-rendershowlink--links) shape (`{kind:'show-link', data:{url, label, description, safe}}`) for a "sign in to `<toolDisplayName>`" prompt. You build that card client-side from the `onOAuthRequired` result.

#### The `wait_for_response` ACK — one wire contract, two transports

A `tools.client` tool built with `waitForResponse:true` blocks the agent's turn until the host app supplies a result. The wait lasts up to the tool's `timeout` seconds (default 30). The ACK is **not a socket event**. On both transports it is the same plain HTTPS POST, authorized by the session's own conversation KS. The agent speaks the acked value in the *same* turn:

```
POST {genieUrl}/assistant/tool_response
Content-Type: application/json
Authorization: KS <conversation ks>

{ "tool_name": "<toolName>", "tool_id": "<toolMetadata.id>", "tool_invocation_id": "<toolMetadata.id>", "response": { …your JSON result… } }

→ 200 {}
```

`tool_id` and `tool_invocation_id` both carry the `toolMetadata.id` from the parsed `tool` segment. `KalturaAvatarSession#respondToTool` and `KalturaChatSession#respondToTool` send exactly this. The `tool` segment may arrive over the socket (`agent_raw_text`) or over the HTTP `/assistant/converse` stream, but the ACK path is identical. One `waitForResponse:true` tool definition works unchanged on both transports.

`respondToTool(id, response)` returns a result object:

| Result | Meaning |
|---|---|
| `{ ok: true }` | The POST returned a 2xx status. |
| `{ ok: false, reason: 'unknown_or_stale' }` | No pending ACK for `id`: unknown, already acked, or too old. |
| `{ ok: false, reason: 'session_rebuilt' }` | A cold reconnect landed while the POST was in flight. |
| `{ ok: false, reason: 'http_error', status }` | The POST returned 4xx or 5xx. The call stays pending, so you can retry with the same `id`. |
| `{ ok: false, reason: 'timeout' }` | The POST got no answer in 15 s. The call stays pending, so you can retry with the same `id`. |

It throws `invalid_state` when the session is not connected, on a network failure, and `bad_request` for an empty `id` or a `response` that is not a plain object. See [CLIENT-COMMANDS.md](../CLIENT-COMMANDS.md) for the app-level contract (`onToolCall` → `respondToTool`).

> `init_response` is a WebSocket-only event. It arrives as the `delta` of the first `agent_raw_text` event (carrying `openingPhrase`, `threadId` and `messageId`). It never appears in an `/assistant/converse` HTTP stream. `openingPhrase` is the intellect's `opening_phrase`, rendered for this session (Jinja2 over `request_vars` and `sys__*`). With a silent opening phrase (`SILENT_OPENING`) the opening turn still fires `stvStartedTalking` and `stvFinishedTalking` (about 0.5 s apart) but no audible speech, and the SDK surfaces that turn as `SILENT_OPENING_LABEL` (`[silence]`) on `transcript`, `speechChunk` and `avatarStopTalking`. A configured `kickoff` is sent on that `stvFinishedTalking`, and its first `think` delta fires `responsePending`. See [START-THE-CONVERSATION.md](../START-THE-CONVERSATION.md).

> **Stored-only message types.** Two message types never stream. They appear only when you read a thread back (`mgmt.messages` / `mgmt.threads`, and the thread `transcript` as `opening: ...`). `opening` is the rendered `opening_phrase`, the thread's first assistant message: `{ type: 'opening', content: [{ type: 'avatar', content: '<rendered phrase>', metadata: {} }] }`. `summary` is the rendered `avatar_summary_config` template, present after an avatar session ends: `{ type: 'summary', content: [{ type: 'text', content: '<rendered template>', metadata: {} }] }`.

#### Session-completion signal — tell the backend a conversation is truly over

The request shape and auth are in [operate.md § Session-Completion Signal](../api/operate.md#session-completion-signal). The response has no payload to parse. See [ARCHITECTURE-REFERENCE.md § Session-completion signal](../architecture-reference/resilience-and-failure-handling.md#session-completion-signal-session_completed-telling-the-backend-a-conversation-is-truly-over) for the trigger table, and [README.md § Ending a conversation cleanly](../../README.md#ending-a-conversation-cleanly-session_completed-signal) for the config surface.

### 4f. `speechId` — the per-utterance key (and the barge-in mechanism)

`speechId` appears on `agent_raw_text`, `agent_start_speech`, `agent_end_turn`, `generatingSpeech`, `stvSpeechChunk`, `debug_stvTaskGenerated` and `stvFinishedGenerating`. It identifies one agent utterance. Group a turn's events by `speechId`, never by timestamp, because barge-ins interleave turns.

- `stvStartedTalking` and `stvFinishedTalking` carry **no** `speechId`. Attribute them to the `speechId` of the surrounding `stvSpeechChunk` events.
- **Barge-in.** When the user interrupts, `agentInterrupted` fires and the following events carry a new `speechId`. The SDK tracks the latest `speechId` and drops captions for older ones, so it never shows stale captions after an interruption. Do the same in a custom client.
- **Uninterruptible turns.** Some turns can't be interrupted: the opening greeting, the replay after `resume()`, and the server's own status lines. `speak()` holds text sent during them and sends it as one turn when they end. If the session ends first, the held call resolves `false`.

## Related docs

| Doc | Covers |
|---|---|
| [connection-basics.md](connection-basics.md) | The socket connection that leads into this catalog |
| [audio-channels.md](audio-channels.md) | The ASR/STV events referenced above (§5/§6) |
| [../WIRE-PROTOCOL.md](../WIRE-PROTOCOL.md) | Back to the index |
