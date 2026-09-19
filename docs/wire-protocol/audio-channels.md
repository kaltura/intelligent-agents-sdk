[← Back to Wire Protocol](../WIRE-PROTOCOL.md)

# Audio Channels

Wire-level SDP/ICE spec for the two peer connections below. For a client-side code walkthrough instead, see [Audio & Video Wiring](../architecture-reference/channels.md) in the System Internals Reference.

## 5. ASR uplink (pc1) — microphone → server

A WebRTC peer connection that publishes the mic. SDP/ICE are relayed **over the Socket.IO socket** (the `asr-webrtc-*` events in [§4a](events-catalog.md#4a-client--server-emit)/[§4c](events-catalog.md#4c-server--client-on--asr-signaling-relayed-over-the-socket)), not over HTTP.

> **All SDP/ICE for this peer connection travels over the Socket.IO socket** — there's no separate signaling channel to manage client-side. See below for why the server's remote candidate still forces TURN.

**ICE config (implemented in `SDK:wire.js iceConfig()`; TURN URL list from the built-in client's media layer `buildIceConfiguration`). `username`/`credential` default to `"kaltura"`/`"avatar"` (`SDK:wire.js turnServers()`) and can be overridden via its `creds` param:**

```js
new RTCPeerConnection({
  iceServers: [{
    urls: [ "turn:turn.avatar.us.kaltura.ai:80?transport=udp",
            "turn:turn.avatar.us.kaltura.ai:443?transport=udp",
            "turn:turn.avatar.us.kaltura.ai:80?transport=tcp",
            "turns:turn.avatar.us.kaltura.ai:443?transport=tcp" ],
    username: "kaltura", credential: "avatar" }],
  iceTransportPolicy: <see matrix below>,
  bundlePolicy: "max-bundle"
})
```

- **ASR `iceTransportPolicy` differs by client — and it doesn't matter functionally.** The resolved value is `forceAsrRelay && !isFirefox ? 'relay' : 'all'` (`forceAsrRelay` defaults to `false` in the built-in client's media layer's `buildIceConfiguration`). What each client passes:

  | Client | passes | ASR policy (non-Firefox) | Source |
  |---|---|---|---|
  | The platform's built-in client | `forceAsrRelay: true` | **`relay`** | built-in client |
  | The embed client | hardcoded | **`all`** | embed client |
  | `SDK` (this repo) | hardcoded | **`all`** | `SDK:wire.js iceConfig()` |

Either resolves to the same media path. The server's only ICE candidate is a **private `10.x typ host`**, unreachable directly, so the selected pair is **`relay`↔`host` through TURN** regardless. `'relay'` forces that. `'all'` also gathers host/srflx but still ends up on the relay pair. On **Firefox both clients force `'all'`** (relay-only candidate handling differs in the built-in client's media layer).
- **TURN URLs must carry explicit ports+transports** (the four-URL list above) — a bare `turn:host` yields no relay candidate and the uplink silently sends 0 packets. This is the field that actually matters, not the policy string.
- **SDP:** offer `m=audio … OPUS/48000/2` (+ red, G722, PCMU/A, CN, telephone-event), `a=sendrecv`, `a=setup:actpass`; server answers `m=audio … 111` OPUS only, `a=setup:active`, `a=recvonly`.
- **Healthy stats:** `outbound-rtp audio` `packetsSent` climbs steadily, selected `candidate-pair` `nominated:true state:succeeded`, local `relay`/udp ↔ remote `host`/udp.
- **Handshake:** `→ asr-webrtc-init {sessionId}` → `← asr-webrtc-ready` → create offer → `→ asr-webrtc-offer {offer,is_reconnect}` → `← asr-webrtc-answer {answer}` → `setRemoteDescription`; ICE trickles both ways (`→ asr-webrtc-ice-candidate`, `← asr-ice-candidate`). 30s timeout each wait, and during `connect()` both waits are also bounded by the 30s overall connect deadline.
- After connect, the server runs STT on this audio → feeds the brain. There is no "send transcript" call.

### 5b. Audio-mode WebRTC (separate from the ASR uplink)

When an agent runs in **audio/phone mode** (no STV video — see [§6](#6-stv-downlink-pc2--avatar-videoaudio--you)), the runtime negotiates a single bidirectional audio peer. This uses a *different* event family than the `asr-webrtc-*` mic uplink. Here the **server** creates the offer:

| Direction | Event | Payload | Meaning |
|---|---|---|---|
| `→` | `webrtc-create-offer` | `{}` | Ask the server to start audio-mode WebRTC (server replies with `webrtc-offer`). |
| `←` | `webrtc-offer` | `{ offer }` | Server-generated SDP offer (`createWebRTCOffer`). |
| `→` | `webrtc-answer` | `{ answer }` | Client SDP answer. |
| `→` / `←` | `webrtc-ice-candidate` | `{ candidate }` | ICE trickle, both directions. |
| `←` | `webrtc-connected` / `webrtc-disconnected` | `{}` | Audio peer state. |
| `←` | `webrtc-error` | `{ error }` | Audio-mode negotiation error. |

This is distinct from [§5](#5-asr-uplink-pc1--microphone--server) (where the *client* offers the mic uplink and STT runs server-side). `SDK` implements the §5 path (video agents). Audio-mode is documented here for completeness.

**The session server terminates this peer connection itself — it is not a relay here.** For every other socket-signaled path in this document (e.g. [§4a](events-catalog.md#4a-client--server-emit)/[§5](#5-asr-uplink-pc1--microphone--server)'s `asr-webrtc-*` proxy to the ASR service), the session server forwards SDP/ICE to some other backend. Audio mode is the one exception. The server builds a real `RTCPeerConnection`/`RTCAudioSource` using native WebRTC, and streams synthesized TTS speech to the browser directly over that connection. The session server is the far end of the peer connection here, not a signaling pass-through.

## 6. STV downlink (pc2) — avatar video+audio → you

A receive-only WebRTC peer connection fed via **WHEP** (WebRTC-HTTP Egress Protocol). Signaling is **plain SDP over HTTP**, independent of the socket. (Server-side, the STV controller renders the face and streams it into a media relay that provides the WHEP egress. See [ARCHITECTURE.md](../ARCHITECTURE.md).)

**`cast_mode` selects the STV egress** (`StvCastMode` enum `"webrtc"\|"rtmp"`, optional in the `stvNewSession` body). This SDK never sends it. `buildStvNewSession()` (`SDK:wire.js`) accepts an optional `castMode` argument, but `session.js`'s one call site never passes one. So this SDK only ever takes the server's fully-omitted-default path, not either named value:

- **Default (cast_mode omitted)** — the only path this SDK uses. The server returns a `webrtc_url`. In the current deployment that's shaped `{basePublicProxyUrl}/rtc/v1/stv/{room_id}/whep/session/{session_id}` (the session-server's STV proxy). This path returns a working `webrtc_url` on Chromium, Firefox, and WebKit. If the server ever omits `webrtc_url` too, the client falls back to building `{srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id}` itself (`SDK:wire.js whepUrl()`).
- **Explicit `cast_mode:'webrtc'`** (sent only by the runtime client, never by this SDK) — can resolve to an unreachable private IP, so the browser's `fetch` never connects. This is why the SDK never sends it. `whepUrlHasPrivateIp()` (`SDK:wire.js`) guards this regardless of which cast_mode produced the URL.

The URL *shape* alone doesn't tell you which path is safe — the guard above checks the resolved host, not the shape. The client POSTs whichever `webrtc_url` the server returns, verbatim. **The browser always plays via WebRTC/WHEP regardless of mode** — "rtmp" is only the server-side ingest the renderer uses, never a browser transport.

**ICE config:** same TURN URL block as [§5](#5-asr-uplink-pc1--microphone--server). STV resolves `forceStvRelay && !isFirefox ? 'relay' : 'all'`. **All three clients agree here** — the platform's built-in client (`forceStvRelay:true`), the embed client (default `'relay'`), and `SDK` (`SDK:wire.js iceConfig()`) — so:

```js
iceTransportPolicy: "relay"     // STV → 'relay' (non-Firefox); 'all' on Firefox
bundlePolicy: "max-bundle"
```

- **Transceivers:** `addTransceiver('video',{direction:'recvonly'})` + `addTransceiver('audio',{direction:'recvonly'})`.
- **WHEP request** — the URL is the server-provided `webrtc_url` from `stvNewSession`, POSTed verbatim (`SDK:wire.js whepUrl()`). It's shaped `{basePublicProxyUrl}/rtc/v1/stv/{room_id}/whep/session/{session_id}` (this section). If the server ever omits `webrtc_url`, the embed client / `SDK:wire.js whepUrl()` build this fallback shape from `srsBaseUrl` instead:

  ```
  POST {srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id}
  Content-Type: application/sdp
  body: <client offer SDP>          → response body: <answer SDP>  (HTTP 201)
  ```
Teardown = `DELETE` to the `Location` header from the 201.

WHEP status codes:

| Code | Meaning |
|---|---|
| `201` | Created |
| `404` | No active session (must re-create) |
| `409` | Already has a viewer |
| `415` | Wrong content-type |
- **SDP:** offer carries full video codec list + audio; server answer selects `m=video … 109 H264/90000` + `m=audio … 111 OPUS/48000/2`, both `a=sendonly` / `a=setup:passive`. The server only ever encodes H264 video. If the client restricts the offer to a different codec (e.g. via `preferredVideoCodec`), the request still returns 201 with a syntactically valid answer. But the video `m=` line comes back `a=inactive` — no frame is ever decoded, and no error is surfaced anywhere in the negotiation. The audio `m=` line is unaffected either way.
- **Healthy stats:** `inbound-rtp video` frame dimensions stay stable and `framesDecoded`/`bytesReceived` climb steadily; selected pair `nominated:true state:succeeded`, **both candidates `relay`**.
- **Greeting gate:** wait for `<video>` `canplay` (+~300ms) before `approvedPermissions` ([§3](connection-basics.md#3-connect-sequence-state-machine-order) step 10–11).
- `cast_mode:"rtmp"` (sent in `stvNewSession`) means the server renders the face and ingests it into the relay via **RTMP**. The client only ever does WHEP egress. The client never touches RTMP.

## Related docs

| Doc | Covers |
|---|---|
| [connection-basics.md](connection-basics.md) | The connect sequence these two channels plug into |
| [events-catalog.md](events-catalog.md) | The `asr-webrtc-*` signaling events referenced above |
| [../WIRE-PROTOCOL.md](../WIRE-PROTOCOL.md) | Back to the index |
