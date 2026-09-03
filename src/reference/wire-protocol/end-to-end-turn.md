---
layout: base.njk
title: "Wire Protocol · End-to-End Turn"
description: "What fires, in order, across one full user turn."
eyebrow: Reference
---

# End-to-End Turn

[← Back to Wire Protocol](/reference/wire-protocol/)

**On this page:** [8. End-to-end turn (what fires, in order)](#8-end-to-end-turn-what-fires-in-order) · [9. Reproduce / re-capture](#9-reproduce--re-capture) · [Related docs](#related-docs)


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

## 9. Reproduce / re-capture

See the Evidence note in [Wire Protocol · Connection Basics](/reference/wire-protocol/connection-basics/) for the committed fixture (`test/fixtures/golden-session.json`). To observe live traffic against a real session, wire a `debugMode`-gated log panel to print every socket event via `session.on(...)` handlers, or attach a scratch `socket.onAny` listener in a browser console — there is no dedicated capture tool in this repo today. The original snapshot the golden fixture derives from was taken against the reference account's `1_v1mj1kxb` widget + `configId 1222` (see the sample values documented in this repo's tests).

## Related docs

| Doc | Covers |
|---|---|
| [Wire Protocol · Connection Basics](/reference/wire-protocol/connection-basics/) | Provenance + the committed fixture this section reproduces |
| [Wire Protocol · Events Catalog](/reference/wire-protocol/events-catalog/) | Every event named in the trace above |
| [Wire Protocol](/reference/wire-protocol/) | Back to the index |

