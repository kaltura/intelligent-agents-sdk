[← Back to Wire Protocol](../WIRE-PROTOCOL.md)

# Connection Basics

The SDK's committed fixture at [`test/fixtures/golden-session.json`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/test/fixtures/golden-session.json) shows one full real session's events, redacted.

---

## 1. Channels at a glance

<!-- nova-target: wire-protocol-channels | Channels at a glance -->

| Channel | Transport | Direction | Carries | Details |
|---|---|---|---|---|
| **Control plane** | Socket.IO (WebSocket) to `conversationManagerUrl` (default `https://conversation.avatar.us.kaltura.ai`) | duplex | handshake, session setup, agent text stream, turn and talking state, ASR signaling | [§2](#2-socketio-connection)–[§3](#3-connect-sequence-state-machine-order), [events catalog](events-catalog.md) |
| **ASR uplink** | WebRTC `RTCPeerConnection` (pc1) | client → server | your microphone (Opus); SDP/ICE relayed **over the socket** | [§5](audio-channels.md#5-asr-uplink-pc1--microphone--server) |
| **STV downlink** | WebRTC `RTCPeerConnection` (pc2) via **WHEP** | server → client | avatar video (H264) and audio (Opus); SDP over **plain HTTP** | [§6](audio-channels.md#6-stv-downlink-pc2--avatar-videoaudio--you) |
<!-- /nova-target -->

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
| `stickyId` | 16 random characters, fresh per session (override with the `stickyId` option, read with `getStickyId()`) | Send the same value on every polling request, including the initial handshake. Do not rotate it mid-session. |
| `level` | always `published` | The SDK does not expose an option for it. |
| `debugMode` | always `true` | Turns on the `debug_*` events. The SDK's caption and transcript features read `stvSpeechChunk` and `generatingSpeech`, not the `debug_*` events ([§4d](events-catalog.md#4d-server--client-on--conversation-phase)). |
| `billed_client` | always `""` | No effect. |

---

## 3. Connect sequence (state-machine order)

The connect sequence, with every step, event and timeout, lives in one place: [Full connect sequence](../architecture-reference/connection-and-handshake.md#full-connect-sequence-state-machine-order).

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
| [events-catalog.md](events-catalog.md) | The full socket-event-by-event catalog |
| [audio-channels.md](audio-channels.md) | ASR uplink and STV downlink wire mechanics |
| [../START-THE-CONVERSATION.md](../START-THE-CONVERSATION.md) | Scripted Jinja2 opening or silent opening plus `kickoff`: how to choose, and what fires on the wire |
| [../WIRE-PROTOCOL.md](../WIRE-PROTOCOL.md) | Back to the index |
