[← Back to Wire Protocol](../WIRE-PROTOCOL.md)

# Audio Channels

What the SDK does on the two peer connections. For a client-side code walkthrough, see [Audio & Video Wiring](../architecture-reference/channels.md).

## 5. ASR uplink (pc1) — microphone → server

A WebRTC peer connection that publishes the mic. SDP and ICE travel **over the Socket.IO socket** (the `asr-webrtc-*` events in [§4a](events-catalog.md#4a-client--server-emit) and [§4c](events-catalog.md#4c-server--client-on--asr-signaling-relayed-over-the-socket)), not over HTTP. There is no separate signaling channel to manage.

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
- The SDK sets `is_reconnect: true` when it renegotiates this peer after an ICE failure ([resilience](../architecture-reference/resilience-and-failure-handling.md#resilience--failure-handling)).
- **Healthy stats:** `outbound-rtp audio` `packetsSent` climbs steadily, and the selected `candidate-pair` is `nominated: true, state: succeeded`.
- Once connected, the server transcribes this audio and feeds the agent. There is no "send transcript" call.

### 5b. Audio-mode WebRTC (separate from the ASR uplink)

Some agents run in **audio/phone mode**. Their `stvNewSession` reply carries `status: "audio/phone mode - no STV session"` and no `session_id` or `webrtc_url` ([§4b](events-catalog.md#4b-server--client-on--handshakesession-phase)).

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

**Timeout and retry:** each POST gets 5 s, and reading the answer body counts toward it. A try that times out or fails on the network is retried after 1 s, up to 3 tries in all, inside the connect deadline. An HTTP status is never retried, because each status has its own meaning (below). If every try fails, `connect()` rejects with `whep_timeout` (all tries timed out) or `whep_failed` (the last try failed on the network). Both carry `phase: 'whep'` and `retryable: true`. Tune with `timeouts.whepTry`, `whepTries` and `whepBackoff`.

**Teardown:** the SDK sends `DELETE` to the WHEP resource named by the 201's `Location` header. That header is path-absolute from the media server's root (`/…/viewer/{viewer_id}`) and lacks the path prefix of the subscribe URL. The SDK builds the release URL as the POSTed subscribe URL plus the header's `/viewer/…` suffix (`whepResourceUrl()` in `wire.js`). An absolute `Location` is used as-is. Any other relative one resolves against the subscribe URL. If you resolve a `/viewer/…` header against the origin instead, the `DELETE` misses and the viewer slot stays held. The `DELETE` has a 3 s deadline (`timeouts.whepRelease`) and never throws. A teardown `DELETE` is sent with `keepalive`, so it outlives a page that closes right after ([Resilience: page exit](../architecture-reference/resilience-and-failure-handling.md#page-exit)). A `DELETE` can only name a resource whose answer arrived, so a POST aborted in flight leaves nothing to release.

**WHEP status codes:** `404` and `409` mean the avatar session cannot take this subscribe (it is gone, or a viewer is already attached, for example after a timed-out try whose answer was lost). The SDK asks for a new avatar session once on the live socket and POSTs again, both at connect and during media recovery. A second `404` or `409` rejects with `stv_session_gone`. Any other non-2xx rejects `connect()` with `whep_failed`, the HTTP status, and a hint in `detail` for `415`. If the re-subscribe during media recovery still fails, the SDK does a cold reconnect.

- **Codec:** the video stream is H264. If you set `preferredVideoCodec` to another codec, the request still returns 201 with a valid answer, but the video `m=` line comes back `a=inactive`. No frame is decoded and no error surfaces. Audio is unaffected. Leave the option unset.
- **Healthy stats:** `inbound-rtp video` frame dimensions stay stable, `framesDecoded` and `bytesReceived` climb steadily, and the selected pair is `nominated: true, state: succeeded` with both candidates `relay`.
- **Greeting gate:** wait for `<video>` `canplay` (plus about 300 ms) before `approvedPermissions` ([connect sequence](../architecture-reference/connection-and-handshake.md#full-connect-sequence-state-machine-order), steps 10 and 11).

## Related docs

| Doc | Covers |
|---|---|
| [connection-basics.md](connection-basics.md) | Channels at a glance and the socket connection |
| [events-catalog.md](events-catalog.md) | The `asr-webrtc-*` signaling events referenced above |
| [../WIRE-PROTOCOL.md](../WIRE-PROTOCOL.md) | Back to the index |
