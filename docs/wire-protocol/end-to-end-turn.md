[← Back to Wire Protocol](../WIRE-PROTOCOL.md)

# End-to-End Turn

## 8. End-to-end turn (what fires, in order)

A user turn, as captured:

```
(user speaks / or → onTextEntered {text, isFinal})
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

**Barge-in** is when the user interrupts the avatar mid-turn. It's triggered by a new `debug_vad_speech_detected` (voice) or by `→ onTextEntered {text:'', isFinal:false, isSpeechStart:true}` (typed, via `speak()`/`interrupt()`). Either one produces `← agentInterrupted {}` and an early `stvFinishedTalking` with the truncated `agentContent`.

**Runtime behavior for integrators reasoning about turns:**

- **Turn segmentation** — `agent_start_speech.isNewTurn` is `false` when the server treats new ASR/typed text as a continuation of the turn already in flight (e.g. a correction or extension of what the user just said). It's `true` when the server starts a fresh turn. The SDK only reads this field. It doesn't compute continuation itself.
- **Audio/phone mode allocates no STV** — the server short-circuits `stvNewSession` to `{status:"audio/phone mode - no STV session"}` (no `webrtc_url`, no WHEP downlink); see [events-catalog.md](events-catalog.md#4b-server--client-on--handshakesession-phase).

## 9. Reproduce / re-capture

See the SDK's committed fixture at [`test/fixtures/golden-session.json`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/test/fixtures/golden-session.json). To observe live traffic against a real session, wire a `debugMode`-gated log panel to print every socket event via `session.on(...)` handlers, or attach a scratch `socket.onAny` listener in a browser console. There is no dedicated capture tool in this repo.

## Related docs

| Doc | Covers |
|---|---|
| [connection-basics.md](connection-basics.md) | The connect sequence and committed fixture this section walks through |
| [events-catalog.md](events-catalog.md) | Every event named in the trace above |
| [../WIRE-PROTOCOL.md](../WIRE-PROTOCOL.md) | Back to the index |
