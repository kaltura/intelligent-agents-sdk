---
layout: base.njk
title: "Wire Protocol · Audio Channels"
description: "The ASR uplink and STV downlink WebRTC peer connections, ICE config, and WHEP signaling."
eyebrow: Reference
---

# Audio Channels

[← Back to Wire Protocol](/reference/wire-protocol/)


What the SDK does on the two peer connections. For a client-side code walkthrough, see [Audio & Video Wiring](/reference/architecture-reference/channels/).

## 5. ASR uplink (pc1) — microphone → server

A WebRTC peer connection that publishes the mic. SDP and ICE travel **over the Socket.IO socket** (the `asr-webrtc-*` events in [§4a](/reference/wire-protocol/events-catalog/#4a-client--server-emit) and [§4c](/reference/wire-protocol/events-catalog/#4c-server--client-on--asr-signaling-relayed-over-the-socket)), not over HTTP. There is no separate signaling channel to manage.

**ICE config** (`iceConfig()` in `src/experience/wire.js`):

```js
new RTCPeerConnection({
  iceServers: [{
    urls: [ "turn:<turnServerUrl>:80?transport=udp",
            "turn:<turnServerUrl>:443?transport=udp",
            "turn:<turnServerUrl>:80?transport=tcp",
            "turns:<turnServerUrl>:443?transport=tcp" ],
    username, credential }],
  iceTransportPolicy: "all",
  bundlePolicy: "max-bundle"
})
```

**TURN servers**

| Session option | Meaning |
|---|---|
| `turnServerUrl` | TURN host from `appInit`. The SDK expands it into the four URLs above. |
| `turnCredentials` | `{ username, credential, expiry? }`, the ephemeral credentials from `appInit`. |

- If you pass `turnServerUrl` without `turnCredentials`, the SDK uses built-in fallback credentials and logs a security warning. Always pass `turnCredentials` in production.
- The STV downlink uses `iceTransportPolicy: "relay"`, except on Firefox (`isFirefox` option), where it is `"all"`.
- Keep explicit ports and transports on every TURN URL. A bare `turn:host` yields no relay candidate and the uplink sends no packets silently.
- WebKit rejects `?transport=` query strings. The SDK retries once without them, which drops the plain-TCP port 80 URL on that engine only.

**Signaling sequence:**

```
→ asr-webrtc-init {sessionId}
← asr-webrtc-ready
  create offer
→ asr-webrtc-offer {offer, is_reconnect}
← asr-webrtc-answer {answer}
  setRemoteDescription
ICE trickles both ways: → asr-webrtc-ice-candidate, ← asr-ice-candidate
```

- Each wait (`asr-webrtc-ready`, `asr-webrtc-answer`) has a 30 s timeout. During `connect()` both are also bounded by the 30 s overall connect deadline. A timeout fails with `ASRConnectionFailed`.
- The offer carries the mic track as Opus. With `micStartMode: 'deferred'` the offer carries an empty send-only audio slot, and `startMic()` attaches the track later without renegotiation.
- The SDK sets `is_reconnect: true` when it renegotiates this peer after an ICE failure ([resilience](/reference/architecture-reference/resilience-and-failure-handling/#resilience--failure-handling)).
- **Healthy stats:** `outbound-rtp audio` `packetsSent` climbs steadily, and the selected `candidate-pair` is `nominated: true, state: succeeded`.
- Once connected, the server transcribes this audio and feeds the agent. There is no "send transcript" call.

### 5b. Audio-mode WebRTC (separate from the ASR uplink)

Some agents run in **audio/phone mode**. Their `stvNewSession` reply carries `status: "audio/phone mode - no STV session"` and no `session_id` or `webrtc_url` ([§4b](/reference/wire-protocol/events-catalog/#4b-server--client-on--handshakesession-phase)).

`KalturaAvatarSession` handles that reply as follows:

- It sets `session.mode` to `'audio'`.
- It skips the WHEP downlink ([§6](#6-stv-downlink-pc2--avatar-videoaudio--you)), so no `videoMetadata` fires.
- It emits `mediaReady { mode: 'audio' }` at once, so a loading UI can stop.
- It still runs the ASR uplink ([§5](#5-asr-uplink-pc1--microphone--server)).

**This SDK does not implement an audio-mode WebRTC downlink.** For video agents, use the §5 and §6 paths.

## 6. STV downlink (pc2) — avatar video+audio → you

A receive-only WebRTC peer connection fed by **WHEP** (WebRTC-HTTP Egress Protocol). Signaling is **plain SDP over HTTP**, independent of the socket.

**URL:** the SDK POSTs to the `webrtc_url` from the `stvNewSession` reply, verbatim. If the reply has no `webrtc_url`, the SDK builds `{srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id}` from the `srsBaseUrl` session option (`whepUrl()` in `wire.js`). The SDK never sends `cast_mode` in `stvNewSession`.

**ICE config:**

```js
iceTransportPolicy: "relay"     // 'all' on Firefox
bundlePolicy: "max-bundle"
```

It uses the same TURN URL block and options as [§5](#5-asr-uplink-pc1--microphone--server).

- **Transceivers:** `addTransceiver('video', {direction:'recvonly'})` and `addTransceiver('audio', {direction:'recvonly'})`.
- **Private address guard:** the SDK rejects `connect()` with `whep_private_ip` if the WHEP URL (or the `Location` header of the answer) points at a private, loopback or link-local host. A browser cannot reach one.

**WHEP request:**

```
POST {webrtc_url}
Content-Type: application/sdp
body: <client offer SDP>          → response body: <answer SDP>  (HTTP 201)
```

**Teardown:** the SDK sends `DELETE` to the WHEP resource named by the 201's `Location` header. That header is path-absolute from the media server's root (`/…/viewer/{viewer_id}`) and lacks the path prefix of the subscribe URL. The SDK builds the release URL as the POSTed subscribe URL plus the header's `/viewer/…` suffix (`whepResourceUrl()` in `wire.js`). An absolute `Location` is used as-is. Any other relative one resolves against the subscribe URL. If you resolve a `/viewer/…` header against the origin instead, the `DELETE` misses and the viewer slot stays held.

**WHEP status codes:** any non-2xx rejects `connect()` with `whep_failed`, the HTTP status, and a hint in `detail` for `404`, `409` and `415`. When the STV re-subscribe during media recovery fails (including with a `404`), the SDK does a cold reconnect.

- **Codec:** the video stream is H264. If you set `preferredVideoCodec` to another codec, the request still returns 201 with a valid answer, but the video `m=` line comes back `a=inactive`. No frame is decoded and no error surfaces. Audio is unaffected. Leave the option unset.
- **Healthy stats:** `inbound-rtp video` frame dimensions stay stable, `framesDecoded` and `bytesReceived` climb steadily, and the selected pair is `nominated: true, state: succeeded` with both candidates `relay`.
- **Greeting gate:** wait for `<video>` `canplay` (plus about 300 ms) before `approvedPermissions` ([connect sequence](/reference/architecture-reference/connection-and-handshake/#full-connect-sequence-state-machine-order), steps 10 and 11).

## Related docs

| Doc | Covers |
|---|---|
| [Wire Protocol · Connection Basics](/reference/wire-protocol/connection-basics/) | Channels at a glance and the socket connection |
| [Wire Protocol · Events Catalog](/reference/wire-protocol/events-catalog/) | The `asr-webrtc-*` signaling events referenced above |
| [Wire Protocol](/reference/wire-protocol/) | Back to the index |

