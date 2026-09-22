---
layout: base.njk
title: "System Internals Reference · Conversation Flow"
description: "What streams while connected: brain output, talking state, lifecycle events, sending user input, and the complete message catalog."
eyebrow: Reference
---

# Conversation Flow

[← Back to System Internals Reference](/reference/architecture-reference/)


## Conversation Phase: What Streams While Connected

Three parallel listeners (the platform's built-in client's connected-state handler):

### 1. Brain output: `agent_raw_text` (the intelligence)

The server streams the brain's response as deltas. Envelope:

```js
socket.on('agent_raw_text', ({ speechId, turnId, delta }) => {
  const d = JSON.parse(delta);   // delta is a JSON string:
  // { messageId, threadId?, role?, type?, content?, segmentNumber?,
  //   segmentStart?, segmentEnd?, et?, metadata?, event?, status? }
});
```

`type` values: `think`, `text`, `unisphere-tool`, `tool`, `tool_response`, `avatar`, `error`, `share`, `thread`. This is the same set used by `/assistant/converse`, since the live runtime wraps the same brain stream.

The first `agent_raw_text` on the live socket also carries an **`init_response`** delta (`openingPhrase`/`threadId`/`messageId`). That delta is WebSocket-only, with no equivalent in an HTTP-converse stream.

The `type` value is the LLM's code-fence tag (open-ended) for content blocks, plus the fixed control types `think`/`tool`/`tool_response`/`error`. See [Wire Protocol · Events Catalog §4e](/reference/wire-protocol/events-catalog/#4e-agent_raw_textdelta--the-brain-stream-parsed).

- Only `text`, `unisphere-tool`, `error` carry display content; the rest are agent-internal.
- A `share` chunk with `segmentStart && segmentEnd` marks **message complete**.
- `threadId` appears in deltas. Capture it to resume the thread later.

This is the **same brain and same stream format** as the text-only brain `/assistant/converse` API. The avatar runtime just delivers it over the socket instead of HTTP.

### 2. Talking state: for UI/turn-taking

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

Three ways the conversation gets its turns:

1. **Voice (primary)**: just speak. The ASR channel publishes mic audio; the server transcribes and feeds the brain. No client call needed.

2. **Kickoff (the SDK's first turn)**: the `kickoff` session option is typed text the SDK sends for the app, once per session object, through the same text-injection path as item 3. It goes out the moment the server accepts input: after the opening turn ends (`stvFinishedTalking`), or after `acknowledgeDisclosure()` when the disclosure gate is on. Pair it with a silent opening phrase (`SILENT_OPENING`) for the fastest interruptible first reply. See [Start the Conversation](/guides/start-the-conversation/).

3. **Text injection**: drive the live avatar by text instead of voice. This is a *socket* event (the same channel ASR transcripts use), not an `/assistant/converse` HTTP call. HTTP converse is a separate stateless chat that never reaches the avatar's speech engine, so the avatar stays silent if you use it instead. Verified working via the SDK's own `session.speak()` (`src/experience/session.js`):

   ```js
   // the isSpeechStart marker interrupts a mid-sentence avatar (no-op if idle)
   socket.emit('onTextEntered', { text: '', isFinal: false, isSpeechStart: true });
   socket.emit('onTextEntered', { text, isFinal: true });
   ```
`onTextEntered` is the text-input event. The payload is `{ text, isFinal, isSpeechStart? }`; `room_id` and `session_id` are not needed and are ignored. The text is treated exactly like a spoken transcript. If the session was built with `debug:true`, `speak()` also emits a `debug_text_entered` mirror with the final `{text, isFinal:true}` right after `onTextEntered`, for observability only. The reply follows from `onTextEntered` either way. For purely **typed** chat (no avatar), the production chat UI instead calls `/assistant/converse` directly with the `geniegpcid` KS. See [Wire Protocol · Events Catalog §4a](/reference/wire-protocol/events-catalog/#4a-client--server-emit).

---

## Complete Message Catalog

The exhaustive, field-by-field event catalog lives in **[Wire Protocol · Events Catalog §4](/reference/wire-protocol/events-catalog/#socketio-events--developer-facing-catalog)**. It has every client emit and server event with its payload shape and subscriber (§4a client→server, §4b–§4d server→client, §4e the parsed `agent_raw_text.delta` types). The connect-sequence steps in [System Internals Reference · Connection and Handshake](/reference/architecture-reference/connection-and-handshake/) name the key events in order. That doc is the reference for each one's exact shape.

## Related docs

| Doc | Covers |
|---|---|
| [System Internals Reference · Connection and Handshake](/reference/architecture-reference/connection-and-handshake/) | The connect sequence that precedes this phase |
| [System Internals Reference · Audio & Video Wiring](/reference/architecture-reference/channels/) | The ASR/STV media channels running alongside this |
| [System Internals Reference](/reference/architecture-reference/) | Back to the index |

