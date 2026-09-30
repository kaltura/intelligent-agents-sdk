---
layout: base.njk
title: "Wire Protocol · Connection Basics"
description: "Provenance and components, channels at a glance, the Socket.IO connection, and the connect sequence state machine."
eyebrow: Reference
---

# Connection Basics

[← Back to Wire Protocol](/reference/wire-protocol/)


The SDK's committed fixture at [`test/fixtures/golden-session.json`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/test/fixtures/golden-session.json) shows one full real session's events, redacted.

---

## 1. Channels at a glance

<div data-nova-target="wire-protocol-channels" data-nova-label="Channels at a glance">

| Channel | Transport | Direction | Carries | Details |
|---|---|---|---|---|
| **Control plane** | Socket.IO (WebSocket) to `conversationManagerUrl` (default `https://conversation.avatar.us.kaltura.ai`) | duplex | handshake, session setup, agent text stream, turn and talking state, ASR signaling | [§2](#2-socketio-connection)–[§3](#3-connect-sequence-state-machine-order), [events catalog](/reference/wire-protocol/events-catalog/) |
| **ASR uplink** | WebRTC `RTCPeerConnection` (pc1) | client → server | your microphone (Opus); SDP/ICE relayed **over the socket** | [§5](/reference/wire-protocol/audio-channels/#5-asr-uplink-pc1--microphone--server) |
| **STV downlink** | WebRTC `RTCPeerConnection` (pc2) via **WHEP** | server → client | avatar video (H264) and audio (Opus); SDP over **plain HTTP** | [§6](/reference/wire-protocol/audio-channels/#6-stv-downlink-pc2--avatar-videoaudio--you) |

</div>

The two peer connections are separate. WHEP is receive-only and the ASR uplink is send-only. They negotiate and fail independently.

---

## 2. Socket.IO connection

The SDK opens the socket like this:

```js
io(conversationManagerUrl, {          // from appInit
  path: "/socket.io",
  transports: ["websocket"],
  reconnection: true,
  auth:  { token: "<conversation KS from appInit>" },
  query: { partnerId: "<pid>", billed_client: "", stickyId: "<16 chars>",
           level: "published", debugMode: true }
})
```

| Param | Value | Purpose |
|---|---|---|
| `auth.token` | the conversation KS from `application/appInit` | Identifies the partner and the agent. |
| `partnerId` | your partner id | Identifies the Kaltura account. |
| `stickyId` | 16 random characters, fresh per session (override with the `stickyId` option, read with `getStickyId()`) | Sent as a socket query param on the WebSocket connection. The SDK keeps the same value for the whole session, including a cold reconnect. Do not rotate it mid-session. |
| `level` | always `published` | The SDK does not expose an option for it. |
| `debugMode` | always `true` | Turns on the `debug_*` events. The SDK's caption and transcript features read `stvSpeechChunk` and `generatingSpeech`, not the `debug_*` events ([§4d](/reference/wire-protocol/events-catalog/#4d-server--client-on--conversation-phase)). |
| `billed_client` | always `""` | No effect. |

---

## 3. Connect sequence (state-machine order)

The connect sequence, with every step, event and timeout, lives in one place: [Full connect sequence](/reference/architecture-reference/connection-and-handshake/#full-connect-sequence-state-machine-order).

Short version:

```
open socket → join → clientConfiguration + joinComplete → stvNewSession
  → lane A: showAgent → askPermissions → ASR uplink
  → lane B: WHEP subscribe → video playable
  → approvedPermissions → CONNECTED
```

## Related docs

| Doc | Covers |
|---|---|
| [Wire Protocol · Events Catalog](/reference/wire-protocol/events-catalog/) | The full socket-event-by-event catalog |
| [Wire Protocol · Audio Channels](/reference/wire-protocol/audio-channels/) | ASR uplink and STV downlink wire mechanics |
| [Start the Conversation](/guides/start-the-conversation/) | Scripted Jinja2 opening or silent opening plus `kickoff`: how to choose, and what fires on the wire |
| [Wire Protocol](/reference/wire-protocol/) | Back to the index |

