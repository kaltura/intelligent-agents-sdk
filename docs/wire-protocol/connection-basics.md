[← Back to Wire Protocol](../WIRE-PROTOCOL.md)

# Connection Basics

The SDK's committed fixture at [`test/fixtures/golden-session.json`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/test/fixtures/golden-session.json) shows one full real session's events, redacted.

---

## 1. Channels at a glance

<!-- nova-target: wire-protocol-channels | Channels at a glance -->

| Channel | Transport | Direction | Carries | Source of truth |
|---|---|---|---|---|
| **Control plane** | Socket.IO (WebSocket) to `conversation.avatar.us.kaltura.ai` | duplex | handshake, session orchestration, brain text stream, turn/talking state, ASR signaling relay | [§2](#2-socketio-connection)–[§3](#3-connect-sequence-state-machine-order), [events catalog](events-catalog.md) |
| **ASR uplink** | WebRTC `RTCPeerConnection` (pc1) | client → server | your microphone (OPUS); SDP/ICE relayed **over the socket** | [§5](audio-channels.md#5-asr-uplink-pc1--microphone--server) |
| **STV downlink** | WebRTC `RTCPeerConnection` (pc2) via **WHEP** | server → client | avatar video (H264) + audio (OPUS); SDP over **plain HTTP** | [§6](audio-channels.md#6-stv-downlink-pc2--avatar-videoaudio--you) |
<!-- /nova-target -->

These are two separate peer connections by design. WHEP is receive-only and ASR is send-only, and they use **different ICE policies** ([§5](audio-channels.md#5-asr-uplink-pc1--microphone--server)/[§6](audio-channels.md#6-stv-downlink-pc2--avatar-videoaudio--you)). Separating them gives independent negotiation and failure isolation.

---

## 2. Socket.IO connection

This package (referred to as `SDK` throughout this reference) opens the socket the same way Kaltura's other clients do — its built-in player client and its embed widget client, both used here for comparison. **Captured connection args:**

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
| `debugMode` | `true` | this SDK always sends `true`, with no config option to turn it off. The SDK's own caption/transcript features (`session.on('speechChunk'/'transcript', …)`) read the non-`debug_`-prefixed `stvSpeechChunk`/`generatingSpeech` events, not the `debug_*` ones — see [events-catalog.md §4d](events-catalog.md#4d-server--client-on--conversation-phase) |
| `billed_client` | `""` | always sent empty by this SDK; no effect on this SDK's behavior |
| `auth.token` | enriched KS | the conversation KS from `application/appInit`; carries `partnerId` + agent scope. (The embed client uses anonymous `ks:''`.) |

Auth/tenant scope: the KS in `auth.token` scopes the session to a partner and agent. Entitlement stays on for end-user sessions.

---

## 3. Connect sequence (state-machine order)

Order from the built-in client's connecting-state machine (steps 0–9, 11) plus the SDK/embed client video-ready gate (step 10). `→` = client emits, `←` = client receives. Steps 1–5 are serial: each waits for its inbound event before advancing. After step 5 the SDK runs two lanes in parallel: steps 6→7→9 (agent, ready, ASR uplink) and step 10 (WHEP), which needs only the step 5 result. Step 11 runs once both lanes are done. The first lane to fail rejects `connect()` at once. Step 0 is never awaited: the mic prompt runs alongside the whole sequence and a denied mic emits a `warning`, never a failure.

| # | Client | Emits `→` / Waits `←` | Inbound (server) | Timeout |
|---|---|---|---|---|
| 0 | init RTC session + start `getUserMedia({audio:true,video:false})` in the background | — | (mic prompt) | — (not awaited) |
| 1 | open socket | `←` | `onServerConnected` | 10s (`ConnectionTimeout`) |
| 2 | join room | `→ join` | — | — |
| 3 | wait config + ack (parallel) | `← clientConfiguration`, `← joinComplete` | both required | `clientConfiguration` 5s, `joinComplete` **20s** (both `JoinRoomTimeout`) |
| 4 | create STV session | `→ stvNewSession {room_id, cast_mode}` | — | — |
| 5 | wait session | `← stvNewSession {session_id, webrtc_url?}` (or `← throwToNoAgent`) | sets `sessionId` + `webrtcUrl` | — |
| 6 | wait agent | `← showAgent` | agent joined | 10s (`AgentResponseTimeout`) |
| 7 | wait ready | `← askPermissions {constraints}` | server ready (machine event `ServerReadyReceived`) | — |
| 8 | (optional) wait player-ready, then 1000ms delay | — | — | — |
| 9 | connect ASR mic uplink (lane A, after 6→7) | `asr-webrtc-*` handshake ([§5](audio-channels.md#5-asr-uplink-pc1--microphone--server)) | — | 30s per wait (`ASRConnectionFailed`) |
| 10 | subscribe STV video (WHEP) **and wait until playable, or give up waiting** (lane B, starts right after step 5) | `→` WHEP POST (no timeout of its own) → wait `<video>` `canplay` + ~300ms settle, or a 6s hard cap if `canplay` never fires | first decoded frame, or the 6s cap elapsing | 6s (hard cap; settles either way) |
| 11 | **approve** (starts the spoken greeting), once lanes A and B are both done | `→ approvedPermissions {room}` | — | — |
| 12 | opening turn runs. With a silent opening phrase (`SILENT_OPENING`, `<blank>`) it produces no speech and ends in ~0.5 s. The SDK sends a configured `kickoff` on its `stvFinishedTalking` ([guide](../START-THE-CONVERSATION.md)) | `← stvStartedTalking` … `← stvFinishedTalking` then `→ onTextEntered {text}` | `stvFinishedTalking` | — |
| → | **CONNECTED** | listen for `agent_raw_text`, `generatingSpeech`, `stv*Talking`, VAD ([events catalog](events-catalog.md)) | — | — |

Top-level machine states (the built-in client's connection state machine): `preparing → connecting → connected → (disconnecting / disconnected / error)`. Overall connecting timeout 30s. Step timeouts are from the built-in client's connecting state (`30e3` overall, `10000` server-connect, `5e3` join-room, `10000` agent, ASR 30s). Every wait in the table, including the two ASR waits and the WHEP answer, is also bounded by the 30s overall deadline: an event or WHEP answer that lands after it rejects `connect()` with `ConnectTimeout`.

> **Why `joinComplete` gets 20s, not 5s (deliberate deviation from the built-in client's single 5s join-room budget):** the server emits `clientConfiguration` immediately on join, but emits `joinComplete` only after an awaited context-update call that can exceed 5s under load. This SDK therefore budgets the two waits separately — `clientConfiguration` 5s, `joinComplete` 20s (`SDK:session.js` `TIMEOUTS.joinRoom` / `TIMEOUTS.joinComplete`). A client that reuses the built-in client's single 5s budget for both will see spurious `JoinRoomTimeout` failures on loaded rooms.

> **Steps 10–11 are a client-side refinement, not part of the built-in client's machine.** The bare built-in client connecting-state machine approves on `connectToASR` **onDone** (`sendApprovedPermissions` → `done` → `#connected`). Its STV video is subscribed later, in the player layer.  
>  
> The **SDK and embed client** instead gate `approvedPermissions` on STV video being playable first. (`SDK:session.js _approve` gates on the same canplay/`HAVE_FUTURE_DATA` settle logic; the embed client's own permission-approval check requires `_micReady && _videoReady`.)  
>  
> **Why it matters:** `approvedPermissions` is what makes the server speak the opening line. ICE `connected` fires ~2s before the first frame decodes, so approving before `<video>` `canplay` (readyState ≥ `HAVE_FUTURE_DATA`, plus a ~300ms jitter settle) clips the greeting.  
>  
> This wait is not unconditional. A 6s hard cap settles the gate anyway if `canplay` never fires (a stalled or dropped video track), so approval isn't blocked forever on a video that never decodes. This SDK applies the same 6s fallback; do the same in your client.

## Related docs

| Doc | Covers |
|---|---|
| [events-catalog.md](events-catalog.md) | The full socket-event-by-event catalog referenced above |
| [audio-channels.md](audio-channels.md) | ASR uplink + STV downlink wire mechanics |
| [../START-THE-CONVERSATION.md](../START-THE-CONVERSATION.md) | Silent opening + `kickoff`: the fastest interruptible first turn and what fires on the wire |
| [../WIRE-PROTOCOL.md](../WIRE-PROTOCOL.md) | Back to the index |
