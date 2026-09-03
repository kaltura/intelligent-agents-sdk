[← Back to Architecture Reference](../ARCHITECTURE-REFERENCE.md)

# Conversation Flow

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

`type` values: `think`, `text`, `unisphere-tool`, `tool`, `tool_response`, `avatar`, `error`, `share`, `thread` — the same set as `/assistant/converse` (the live runtime wraps the same brain stream). The first `agent_raw_text` on the live socket additionally carries an **`init_response`** delta (`openingPhrase`/`threadId`/`messageId`) — that one is a WebSocket-only frame from the brain's websocket handler, not an HTTP-converse segment. The `type` is the LLM's code-fence tag (open-ended) for content blocks, plus the fixed control types `think`/`tool`/`tool_response`/`error`; see [wire-protocol/events-catalog.md §4e](../wire-protocol/events-catalog.md#4e-agent_raw_textdelta--the-brain-stream-parsed).

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
The server handler is `onTextEntered` (the session server's text-injection handler), which reads only `{ text, isFinal, isSpeechStart? }` and routes the text to the same pipeline as ASR transcripts (`vadSpeechDetected`), keyed by the socket's own room (`room: socket.id`). It does **not** read `room_id`/`session_id` — those are ignored server-side. (The client-side text-entry emitter only sends `{text,isFinal}` — despite that, the injected text is spoken.) For purely **typed** chat (no avatar), the production chat UI instead calls `/assistant/converse` directly with the `geniegpcid` KS. See [wire-protocol/events-catalog.md §4a](../wire-protocol/events-catalog.md#4a-client--server-emit).

---

## Complete Message Catalog

The exhaustive, field-by-field event catalog — every client emit and server event with its payload shape and subscriber — lives in **[wire-protocol/events-catalog.md §4](../wire-protocol/events-catalog.md#4-socketio-events--developer-facing-catalog)** (§4a client→server, §4b–§4d server→client, §4e the parsed `agent_raw_text.delta` types). The connect-sequence steps in [connection-and-handshake.md](connection-and-handshake.md) name the key events in order; that doc is the reference for each one's exact shape.

## Related docs

| Doc | Covers |
|---|---|
| [connection-and-handshake.md](connection-and-handshake.md) | The connect sequence that precedes this phase |
| [channels.md](channels.md) | The ASR/STV media channels running alongside this |
| [../ARCHITECTURE-REFERENCE.md](../ARCHITECTURE-REFERENCE.md) | Back to the index |
