---
layout: base.njk
title: "Wire Protocol · Connection Basics"
description: "Provenance and components, channels at a glance, the Socket.IO connection, and the connect sequence state machine."
eyebrow: Reference
---

# Connection Basics

[← Back to Wire Protocol](/reference/wire-protocol/)

**On this page:** [1. Channels at a glance](#1-channels-at-a-glance) · [2. Socket.IO connection](#2-socketio-connection) · [3. Connect sequence (state-machine order)](#3-connect-sequence-state-machine-order) · [Related docs](#related-docs)


A committed fixture at `test/fixtures/golden-session.json` shows one full real session's events, redacted.

---

## 1. Channels at a glance

<div data-nova-target="wire-protocol-channels" data-nova-label="Channels at a glance">

| Channel | Transport | Direction | Carries | Source of truth |
|---|---|---|---|---|
| **Control plane** | Socket.IO (WebSocket) to `conversation.avatar.us.kaltura.ai` | duplex | handshake, session orchestration, brain text stream, turn/talking state, ASR signaling relay | [§2](#2-socketio-connection)–[§3](#3-connect-sequence-state-machine-order), [events catalog](/reference/wire-protocol/events-catalog/) |
| **ASR uplink** | WebRTC `RTCPeerConnection` (pc1) | client → server | your microphone (OPUS); SDP/ICE relayed **over the socket** | [§5](/reference/wire-protocol/audio-channels/#5-asr-uplink-pc1--microphone--server) |
| **STV downlink** | WebRTC `RTCPeerConnection` (pc2) via **WHEP** | server → client | avatar video (H264) + audio (OPUS); SDP over **plain HTTP** | [§6](/reference/wire-protocol/audio-channels/#6-stv-downlink-pc2--avatar-videoaudio--you) |

</div>

Two separate peer connections by design: WHEP is receive-only, ASR is send-only, and they use **different ICE policies** ([§5](/reference/wire-protocol/audio-channels/#5-asr-uplink-pc1--microphone--server)/[§6](/reference/wire-protocol/audio-channels/#6-stv-downlink-pc2--avatar-videoaudio--you)) — separating them gives independent negotiation and failure isolation.

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

Query params:

| Param | Value | Purpose |
|---|---|---|
| `partnerId` | your PID | identifies the Kaltura account (the embed client sends `client`/`flowId` instead — agent identity) |
| `stickyId` | 16 random chars, fresh per connect | **session affinity** — load balancer pins all of this session's requests (incl. the initial HTTP-polling handshake) to one server instance. Critical: without it the handshake can break across instances. |
| `level` | `published` | content level (`published` = production agent, `draft` = staging) |
| `debugMode` | `true` | enables the server's streaming text events (`debug_stvTaskGenerated`, `debug_vad_speech_detected`); despite the `debug_` prefix these are required for interim transcription + `timing:'before'` features |
| `billed_client` | `""` | reserved for future partner billing delegation (unused) |
| `auth.token` | enriched KS | the conversation KS from `application/appInit`; carries `partnerId` + agent scope. (The embed client uses anonymous `ks:''`.) |

Auth/tenant scope: the KS in `auth.token` is what scopes the session to a partner + agent; entitlement stays ON for end-user sessions.

---

## 3. Connect sequence (state-machine order)

Order from the built-in client's connecting-state machine (steps 0–9, 11) plus the SDK/embed client video-ready gate (step 10). `→` = client emits, `←` = client receives. **Each numbered step waits for its inbound event before advancing.**

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
| 9 | connect ASR mic uplink | `asr-webrtc-*` handshake ([§5](/reference/wire-protocol/audio-channels/#5-asr-uplink-pc1--microphone--server)) | — | 30s (`ASRConnectionFailed`) |
| 10 | subscribe STV video (WHEP) **and wait until playable, or give up waiting** | `→` WHEP POST (no timeout of its own) → wait `<video>` `canplay` + ~300ms settle, or a 6s hard cap if `canplay` never fires | first decoded frame, or the 6s cap elapsing | 6s (hard cap; settles either way) |
| 11 | **approve** (starts the spoken greeting) | `→ approvedPermissions {client, room}` | — | — |
| → | **CONNECTED** | listen for `agent_raw_text`, `generatingSpeech`, `stv*Talking`, VAD ([events catalog](/reference/wire-protocol/events-catalog/)) | — | — |

Top-level machine states (the built-in client's connection state machine): `preparing → connecting → connected → (disconnecting / disconnected / error)`. Overall connecting timeout 30s. Step timeouts are from the built-in client's connecting state (`30e3` overall, `10000` server-connect, `5e3` join-room, `10000` agent, ASR 30s).

> **Why `joinComplete` gets 20s, not 5s (deliberate deviation from the built-in client's single 5s join-room budget):** the server emits `clientConfiguration` immediately on join, but emits `joinComplete` only after an awaited context-update call that can exceed 5s under load. This SDK therefore budgets the two waits separately — `clientConfiguration` 5s, `joinComplete` 20s (`SDK:session.js` `TIMEOUTS.joinRoom` / `TIMEOUTS.joinComplete`). A client that reuses the built-in client's single 5s budget for both will see spurious `JoinRoomTimeout` failures on loaded rooms.

> **Steps 10–11 are a client-side refinement, not part of the built-in client's machine.** The bare built-in client connecting-state machine approves on `connectToASR` **onDone** (`sendApprovedPermissions` → `done` → `#connected`) — its STV video is subscribed later, in the player layer. The **SDK and embed client** instead gate `approvedPermissions` on STV video being playable first (`SDK:session.js _approve` gated on the same canplay/`HAVE_FUTURE_DATA` settle logic; the embed client's own permission-approval check requires `_micReady && _videoReady`). **Why it matters:** `approvedPermissions` is what makes the server speak the opening line, and ICE `connected` fires ~2s before the first frame decodes — so approving before `<video>` `canplay` (readyState ≥ `HAVE_FUTURE_DATA`, + ~300ms jitter settle) clips the greeting. This wait is not unconditional: a 6s hard cap settles the gate anyway if `canplay` never fires (stalled/dropped video track), so approval isn't blocked forever on a video that never decodes. This SDK does the gate, with the same 6s fallback; do the same in your client.

## Related docs

| Doc | Covers |
|---|---|
| [Wire Protocol · Events Catalog](/reference/wire-protocol/events-catalog/) | The full socket-event-by-event catalog referenced above |
| [Wire Protocol · Audio Channels](/reference/wire-protocol/audio-channels/) | ASR uplink + STV downlink wire mechanics |
| [Wire Protocol](/reference/wire-protocol/) | Back to the index |

