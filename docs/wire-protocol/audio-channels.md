[← Back to Wire Protocol](../WIRE-PROTOCOL.md)

# Audio Channels

What the SDK does on the two peer connections.

## 5. ASR uplink (pc1): microphone → server

A WebRTC peer connection that publishes the mic. SDP and ICE travel **over the Socket.IO socket** (the `asr-webrtc-*` events in [§4a](events-catalog.md#4a-client--server-emit) and [§4c](events-catalog.md#4c-server--client-on-asr-signaling-relayed-over-the-socket)), not over HTTP. There is no separate signaling channel to manage.

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

| Source | Meaning |
|---|---|
| Server `turn` | Short-lived TURN credentials for this session, sent with `onServerConnected` ([§4b](events-catalog.md#4b-server--client-on-handshakesession-phase)). Listed first, so they win when both entries work. |
| `turnServerUrl` | TURN host from `appInit`. The SDK expands it into the four URLs above and lists it after the server entry. |
| `turnCredentials` | Optional `{ username, credential }` for `turnServerUrl`. `appInit` returns none, so the SDK's default TURN credentials apply unless you pass your own. Own credentials for a host the server entry doesn't name are used alone, and the server entry is not sent there. |

- The STV downlink uses `iceTransportPolicy: "relay"`, except on Firefox (`isFirefox` option), where it is `"all"`.
- Keep explicit ports and transports on every TURN URL. A bare `turn:host` yields no relay candidate and the uplink sends no packets silently. The SDK expands a TURN host or a `turn:`/`turns:` URL with no port into the four URLs above.
- WebKit rejects `?transport=` query strings. The SDK retries once without them, which drops the plain-TCP port 80 URL on that engine only.

**Server TURN credentials.** No app code is needed. The SDK reads them, checks them and keeps them out of logs, events and errors.

- Both entries are gathered in parallel, so a session connects on whichever one the relay accepts, with no added wait.
- When both entries name the same UDP relay address, each address goes to one entry only: the server entry keeps UDP 443, the configured entry keeps UDP 80. Browsers share one socket per UDP relay address, so a refused entry would block the other one's UDP relay and push media to TCP. TCP and TLS URLs stay in both entries.
- Credentials that arrive while the peers already exist are applied to them in place.
- When a peer is about to need a new relay allocation (`resume()` after a long pause, a media recovery, `connect()` after `prepare()`) and the credentials expire within a minute, the SDK first opens a fresh socket to get new ones.
- If the browser refuses the server entry, or the relay rejects it on a URL only that entry uses, later peers use the configured entry alone. The logger gets one `[turn]` warning.
- With no `turnServerUrl` and no server entry, the logger gets one `[turn]` warning: most networks need a relay for the avatar video.

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

- Each wait (`asr-webrtc-ready`, `asr-webrtc-answer`) has a 30 s timeout. During `connect()` both are also bounded by the 30 s overall connect deadline. A timeout rejects `connect()` with `timeout` (`error.phase` names the step).
- The offer carries the mic track as Opus. With `micStartMode: 'deferred'` the offer carries an empty send-only audio slot, and `startMic()` attaches the track later without renegotiation.
- The SDK sets `is_reconnect: true` when it renegotiates this peer after an ICE failure ([resilience](../architecture-reference/resilience-and-failure-handling.md#resilience--failure-handling)).
- **Healthy stats:** `outbound-rtp audio` `packetsSent` climbs steadily, and the selected `candidate-pair` is `nominated: true, state: succeeded`.
- Once connected, the server transcribes this audio and feeds the agent. There is no "send transcript" call.

### 5b. Audio-mode WebRTC (separate from the ASR uplink)

Some agents run in **audio/phone mode**. Their `stvNewSession` reply carries `status: "audio/phone mode - no STV session"` and no `session_id` or `webrtc_url` ([§4b](events-catalog.md#4b-server--client-on-handshakesession-phase)).

`KalturaAvatarSession` handles that reply as follows:

- It sets `session.mode` to `'audio'`.
- It skips the WHEP downlink ([§6](#6-stv-downlink-pc2-avatar-videoaudio--you)), so no `videoMetadata` fires.
- It emits `mediaReady { mode: 'audio' }` at once, so a loading UI can stop.
- It still runs the ASR uplink ([§5](#5-asr-uplink-pc1-microphone--server)).

**This SDK does not implement an audio-mode WebRTC downlink.** The mic uplink connects, but the agent's spoken reply does not reach you through this SDK. Audio/phone mode is not a supported feature. For video agents, use the §5 and §6 paths.

## 6. STV downlink (pc2): avatar video+audio → you

A receive-only WebRTC peer connection fed by **WHEP** (WebRTC-HTTP Egress Protocol). Signaling is **plain SDP over HTTP**, independent of the socket.

**URL:** the SDK POSTs to the `webrtc_url` from the `stvNewSession` reply, verbatim. If the reply has no `webrtc_url`, the SDK builds `{srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id}` from the `srsBaseUrl` session option (`whepUrl()` in `wire.js`). The SDK never sends `cast_mode` in `stvNewSession`.

**ICE config:**

```js
iceTransportPolicy: "relay"     // 'all' on Firefox
bundlePolicy: "max-bundle"
```

It uses the same TURN URL block and options as [§5](#5-asr-uplink-pc1-microphone--server).

- **Transceivers:** `addTransceiver('video', {direction:'recvonly'})` and `addTransceiver('audio', {direction:'recvonly'})`.
- **Private address guard:** the SDK rejects `connect()` with `whep_private_ip` if the WHEP URL (or the `Location` header of the answer) points at a private, loopback or link-local host. A browser cannot reach one.

**WHEP request:**

```
POST {webrtc_url}
Content-Type: application/sdp
body: <client offer SDP>          → response body: <answer SDP>  (HTTP 201)
```

**Timeout and retry:** each POST gets 5 s, and reading the answer body counts toward it. A try that times out or fails on the network is retried after 1 s, up to 3 tries in all, inside the connect deadline. An HTTP status is never retried, because each status has its own meaning (below). If every try fails, `connect()` rejects with `whep_timeout` (the last try timed out) or `whep_failed` (the last try failed on the network). Both carry `phase: 'whep'` and `retryable: true`. Tune with `timeouts.whepTry`, `whepTries` and `whepBackoff`.

**Teardown:** the SDK sends `DELETE` to the WHEP resource named by the 201's `Location` header. The SDK builds the release URL as the POSTed subscribe URL plus the header's `/viewer/…` suffix (`whepResourceUrl()` in `wire.js`). An absolute `Location` is used as-is. Any other relative one resolves against the subscribe URL. A custom client must build the URL the same way, or the `DELETE` misses and the viewer slot stays held. The `DELETE` has a 3 s deadline (`timeouts.whepRelease`) and never throws. A teardown `DELETE` is sent with `keepalive`, so it outlives a page that closes right after ([Resilience: page exit](../architecture-reference/resilience-and-failure-handling.md#page-exit)). A `DELETE` can only name a resource whose answer arrived, so a POST aborted in flight leaves nothing to release.

**WHEP status codes:** `404` and `409` mean the avatar session cannot take this subscribe (it is gone, or a viewer is already attached, for example after a timed-out try whose answer was lost). The SDK asks for a new avatar session once on the live socket and POSTs again, both at connect and during media recovery. A second `404` or `409` rejects with `stv_session_gone`. Any other non-2xx rejects `connect()` with `whep_failed`, the HTTP status, and a hint in `detail` for `415`. If the re-subscribe during media recovery still fails, the SDK does a cold reconnect.

- **Codec:** the video stream is H264. If you set `preferredVideoCodec` to another codec, the request still returns 201 with a valid answer, but the video `m=` line comes back `a=inactive`. No frame is decoded and no error surfaces. Audio is unaffected. Leave the option unset.
- **Healthy stats:** `inbound-rtp video` frame dimensions stay stable, `framesDecoded` and `bytesReceived` climb steadily, and the selected pair is `nominated: true, state: succeeded` with both candidates `relay`.
- **Greeting gate:** send `approvedPermissions` only after the video is playable: the first painted frame, or `<video>` `canplay` plus 100 ms when no frame callback exists (a 300 ms settle when there is no `videoEl`). See [the playable-video gate](../architecture-reference/connection-and-handshake.md#step-10-the-playable-video-gate) and steps 10 and 11 of the [connect sequence](../architecture-reference/connection-and-handshake.md#full-connect-sequence-state-machine-order).

## Related docs

| Doc | Covers |
|---|---|
| [connection-basics.md](connection-basics.md) | Channels at a glance and the socket connection |
| [events-catalog.md](events-catalog.md) | The `asr-webrtc-*` signaling events referenced above |
| [../WIRE-PROTOCOL.md](../WIRE-PROTOCOL.md) | Back to the index |
