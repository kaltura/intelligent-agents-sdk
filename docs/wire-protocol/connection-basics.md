[← Back to Wire Protocol](../WIRE-PROTOCOL.md)

# Connection Basics

**How this was built.** Every event/payload in this doc set was captured live from real human voice + text sessions against `conversation.avatar.us.kaltura.ai`. Each entry notes which client(s) rely on it — some events are only subscribed to by the platform's built-in client, others only by the embed client or a debug panel.

**Evidence.** A redacted snapshot of a real session (27 inbound + 15 outbound socket events, both WebRTC legs, ICE policies for every client) is committed at `test/fixtures/golden-session.json` — a hand-curated fixture derived from the original live capture (see the fixture's own `_source`/`_note` fields for provenance). There is no automated re-capture tool in this repo today; update the fixture by hand against fresh observations (e.g. a `debugMode`-gated log panel wired to `session.on(...)`, or `socket.onAny` in a scratch client) when the wire protocol changes.

## Provenance / components

| Symbol | Component | What it is |
|---|---|---|
| `CG` | The platform's built-in client | The connection state machine used by the platform's own built-in avatar client. Authoritative for payload **schemas** and connect order. |
| `RTC` | The built-in client's media layer | The client-side WebRTC session/signaling layer the built-in client and this SDK both build on. Authoritative for **WebRTC** behavior: session setup, WHEP signaling, peer-connection management. |
| `EMBED` | A first-party embeddable client | A second first-party client used for anonymous/embedded widgets. Authoritative for **event semantics & ordering** and the server contract. |
| `SDK` | `src/experience/session.js` | This repo's `KalturaAvatarSession` — the buildable client implementation. |
| `CAP` | `test/fixtures/golden-session.json` | The redacted live-capture evidence (see the Evidence note above). |
| `CM` | The session server | The **server** runtime — the emitter of every server→client event. Owns session orchestration, ASR signaling relay, and the brain output stream. |

> Server-emitted events cite `CM` (above) where the payload is confirmed against server-side behavior. Items still derived only from the live capture or client contract are marked **(server-side; inferred from contract)**.

> **One more term recurs in the body without its own table row.** **"Debug panel"** is a generic `debugMode`-gated developer log UI that recurs across clients rather than a single component with its own source citation — a row citing it means "also visible in a debug UI," not a distinct client contract.

---

## 1. Channels at a glance

| Channel | Transport | Direction | Carries | Source of truth |
|---|---|---|---|---|
| **Control plane** | Socket.IO (WebSocket) to `conversation.avatar.us.kaltura.ai` | duplex | handshake, session orchestration, brain text stream, turn/talking state, ASR signaling relay | [§2](#2-socketio-connection)–[§3](#3-connect-sequence-state-machine-order), [events catalog](events-catalog.md) |
| **ASR uplink** | WebRTC `RTCPeerConnection` (pc1) | client → server | your microphone (OPUS); SDP/ICE relayed **over the socket** | [§5](audio-channels.md#5-asr-uplink-pc1--microphone--server) |
| **STV downlink** | WebRTC `RTCPeerConnection` (pc2) via **WHEP** | server → client | avatar video (H264) + audio (OPUS); SDP over **plain HTTP** | [§6](audio-channels.md#6-stv-downlink-pc2--avatar-videoaudio--you) |

Two separate peer connections by design (per `EMBED`'s own architecture notes): WHEP is receive-only, ASR is send-only, and they use **different ICE policies** ([§5](audio-channels.md#5-asr-uplink-pc1--microphone--server)/[§6](audio-channels.md#6-stv-downlink-pc2--avatar-videoaudio--you)) — separating them gives independent negotiation and failure isolation.

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

Query params (per `EMBED`'s socket-init routine and `CG`'s connecting-state inputs):

| Param | Value | Purpose |
|---|---|---|
| `partnerId` | your PID | identifies the Kaltura account (the embed client sends `client`/`flowId` instead — agent identity) |
| `stickyId` | 16 random chars, fresh per connect | **session affinity** — load balancer pins all of this session's requests (incl. the initial HTTP-polling handshake) to one session-server pod. Critical: without it the handshake can break across pods. |
| `level` | `published` | content level (`published` = production agent, `draft` = staging) |
| `debugMode` | `true` | enables the server's streaming text events (`debug_stvTaskGenerated`, `debug_vad_speech_detected`); despite the `debug_` prefix these are required for interim transcription + `timing:'before'` features |
| `billed_client` | `""` | reserved for future partner billing delegation (unused) |
| `auth.token` | enriched KS | the conversation KS from `application/appInit`; carries `partnerId` + agent scope. (The embed client uses anonymous `ks:''`.) |

Auth/tenant scope: the KS in `auth.token` is what scopes the session to a partner + agent; entitlement stays ON for end-user sessions.

---

## 3. Connect sequence (state-machine order)

Order from `CG`'s connecting-state machine (steps 0–9, 11) plus the `SDK`/`EMBED` video-ready gate (step 10), cross-checked against live capture. `→` = client emits, `←` = client receives. **Each numbered step waits for its inbound event before advancing.**

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
| 9 | connect ASR mic uplink | `asr-webrtc-*` handshake ([§5](audio-channels.md#5-asr-uplink-pc1--microphone--server)) | — | 30s (`ASRConnectionFailed`) |
| 10 | subscribe STV video (WHEP) **and wait until playable** | `→` WHEP POST → wait `<video>` `canplay` + ~300ms settle | first decoded frame | — |
| 11 | **approve** (starts the spoken greeting) | `→ approvedPermissions {client, room}` | — | — |
| → | **CONNECTED** | listen for `agent_raw_text`, `generatingSpeech`, `stv*Talking`, VAD ([events catalog](events-catalog.md)) | — | — |

Top-level machine states (`CG`'s connection state machine): `preparing → connecting → connected → (disconnecting / disconnected / error)`. Overall connecting timeout 30s. Step timeouts are from `CG`'s connecting state (`30e3` overall, `10000` server-connect, `5e3` join-room, `10000` agent, ASR 30s).

> **Why `joinComplete` gets 20s, not 5s (deliberate deviation from `CG`'s single 5s join-room budget):** the server (`CM`) emits `clientConfiguration` immediately on join, but emits `joinComplete` only after an awaited context-update call that can exceed 5s under load. This SDK therefore budgets the two waits separately — `clientConfiguration` 5s, `joinComplete` 20s (`SDK:session.js` `TIMEOUTS.joinRoom` / `TIMEOUTS.joinComplete`). A client that reuses `CG`'s single 5s budget for both will see spurious `JoinRoomTimeout` failures on loaded rooms.

> **Steps 10–11 are a client-side refinement, not part of the `CG` machine.** The bare `CG` connecting-state machine approves on `connectToASR` **onDone** (`sendApprovedPermissions` → `done` → `#connected`) — its STV video is subscribed later, in the player layer. The **`SDK` and `EMBED` clients** instead gate `approvedPermissions` on STV video being playable first (`SDK:session.js _approve` gated on the same canplay/`HAVE_FUTURE_DATA` settle logic; `EMBED`'s own permission-approval check requires `_micReady && _videoReady`). **Why it matters:** `approvedPermissions` is what makes the server speak the opening line, and ICE `connected` fires ~2s before the first frame decodes — so approving before `<video>` `canplay` (readyState ≥ `HAVE_FUTURE_DATA`, + ~300ms jitter settle) clips the greeting. This SDK does the gate; do the same in your client.

## Related docs

| Doc | Covers |
|---|---|
| [events-catalog.md](events-catalog.md) | The full socket-event-by-event catalog referenced above |
| [audio-channels.md](audio-channels.md) | ASR uplink + STV downlink wire mechanics |
| [../WIRE-PROTOCOL.md](../WIRE-PROTOCOL.md) | Back to the index |
