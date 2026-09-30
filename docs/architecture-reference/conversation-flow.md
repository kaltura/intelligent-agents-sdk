[← Back to System Internals Reference](../ARCHITECTURE-REFERENCE.md)

# Conversation Flow

## Conversation Phase: What Streams While Connected

Three parallel listeners, all handled by `KalturaAvatarSession`:

### 1. Brain output: `agent_raw_text` (the intelligence)

The socket streams the brain's response as deltas. Envelope:

```js
socket.on('agent_raw_text', ({ speechId, turnId, delta }) => {
  const d = JSON.parse(delta);   // delta is a JSON string:
  // { messageId, threadId?, role?, type?, content?, segmentNumber?,
  //   segmentStart?, segmentEnd?, et?, metadata?, event?, status? }
});
```

The first `agent_raw_text` on the live socket also carries an **`init_response`** delta (`openingPhrase`/`threadId`/`messageId`). That delta is WebSocket-only, with no equivalent in an HTTP-converse stream.

The `type` set is open-ended: content blocks use the LLM's code-fence tag, plus fixed control types such as `think`, `tool`, `tool_response` and `error`. Ignore types you don't handle. See [wire-protocol/events-catalog.md §4e](../wire-protocol/events-catalog.md#4e-agent_raw_textdelta--the-brain-stream-parsed).

- `text`, `unisphere-tool` and `error` carry display content. `think`, `tool` and `tool_response` are progress and diagnostics. `avatar` and `avatar-filler` carry the spoken text.
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
socket.on('conversationEnded', () => {/* ended → the SDK emits `ended` and disconnects */});
socket.on('conversationTimeWarning', ({remainingTime}) => {/* seconds left */});
```

---

## Sending User Input

Three ways the conversation gets its turns:

1. **Voice (primary)**: just speak. The ASR channel publishes mic audio; the server transcribes and feeds the brain. No client call needed.

2. **Kickoff (the SDK's first turn)**: the `kickoff` session option is typed text the SDK sends for the app, once per session object, through the same text-injection path as item 3. It goes out the moment the server accepts input: after the opening turn ends (`stvFinishedTalking`), or after `acknowledgeDisclosure()` when the disclosure gate is on. Pair it with a silent opening phrase (`SILENT_OPENING`) for the fastest interruptible first reply. See [START-THE-CONVERSATION.md](../START-THE-CONVERSATION.md).

3. **Text injection**: drive the live avatar by text instead of voice. This is a *socket* event (the same channel ASR transcripts use), not an `/assistant/converse` HTTP call. HTTP converse is a separate stateless chat that never reaches the avatar's speech engine, so the avatar stays silent if you use it instead. Verified working via the SDK's own `session.speak()` (`src/experience/session.js`):

   ```js
   // the isSpeechStart marker interrupts a mid-sentence avatar (no-op if idle)
   socket.emit('onTextEntered', { text: '', isFinal: false, isSpeechStart: true });
   socket.emit('onTextEntered', { text, isFinal: true });
   ```
`onTextEntered` is the text-input event. The payload is `{ text, isFinal, isSpeechStart? }`; `room_id` and `session_id` are not needed and are ignored. The text is treated exactly like a spoken transcript. If the session was built with `debug:true`, `speak()` also emits a `debug_text_entered` mirror with the final `{text, isFinal:true}` right after `onTextEntered`, for observability only. The reply follows from `onTextEntered` either way. For purely **typed** chat (no avatar), the production chat UI instead calls `/assistant/converse` directly with a conversation or agent token. See [wire-protocol/events-catalog.md §4a](../wire-protocol/events-catalog.md#4a-client--server-emit).

---

## Complete Message Catalog

The exhaustive, field-by-field event catalog lives in **[wire-protocol/events-catalog.md §4](../wire-protocol/events-catalog.md#4-socketio-events--developer-facing-catalog)**. It has every client emit and server event with its payload shape (§4a client→server, §4b–§4d server→client, §4e the parsed `agent_raw_text.delta` types). The connect-sequence steps in [connection-and-handshake.md](connection-and-handshake.md) name the key events in order. That doc is the reference for each one's exact shape.

## Related docs

| Doc | Covers |
|---|---|
| [connection-and-handshake.md](connection-and-handshake.md) | The connect sequence that precedes this phase |
| [channels.md](channels.md) | The ASR/STV media channels running alongside this |
| [../ARCHITECTURE-REFERENCE.md](../ARCHITECTURE-REFERENCE.md) | Back to the index |
