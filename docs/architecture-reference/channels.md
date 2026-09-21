[← Back to System Internals Reference](../ARCHITECTURE-REFERENCE.md)

# Audio & Video Wiring

Client-side code for the two peer connections below. For the wire-level SDP/ICE spec instead, see [Audio Channels](../wire-protocol/audio-channels.md) in the Wire Protocol reference.

## ASR Channel: Microphone Uplink (step 9)

A WebRTC peer connection whose SDP/ICE are relayed **through the socket** (NOT WHEP). From the platform's built-in client's ASR connection handler:

```js
// 1. tell server to prepare
socket.emit('asr-webrtc-init', { sessionId: peerId });
// 2. wait
socket.once('asr-webrtc-ready', ...);          // (or 'asr-webrtc-error')   timeout 30s, also bounded by the 30s connect deadline
// 3. create RTCPeerConnection with the mic track, generate offer, then:
socket.emit('asr-webrtc-offer', { offer, is_reconnect: false });
socket.once('asr-webrtc-answer', ({ answer }) => pc.setRemoteDescription(answer));  // 30s
// 4. trickle ICE both ways
socket.emit('asr-webrtc-ice-candidate', { candidate });
// (server may push its own candidates on the same event name)
```

PeerConnection configuration:

- **TURN**: the `turnServerUrl` value returned by `appInit` (default username/credential from `wire.js`'s `turnServers()`, four explicit port/transport URLs). See the [Endpoints & Credentials table](connection-and-handshake.md#endpoints--credentials).
- **`iceTransportPolicy`**: `'all'` for ASR, always (`SDK:wire.js iceConfig()`). Relays in practice anyway, because the server only offers a private candidate.
- **Audio constraints**: `{echoCancellation, noiseSuppression, autoGainControl}`.
- **Video**: none.

Once connected, the server transcribes your speech and routes it to the brain automatically. There is no separate "send transcript" call.

---

## STV Channel: Avatar Video Downlink (after CONNECTED)

Standard **SRS WHEP**, completely independent of the socket. From the platform's built-in client's SRS signaling adapter:

```js
const whepUrl = stvNewSession.webrtc_url
  ?? `${srsBaseUrl}/rtc/v1/whep/?app=app&stream=${session_id}`;

// create a recv-only RTCPeerConnection, addTransceiver('video'|'audio', {direction:'recvonly'})
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

const answerSdp = await fetch(whepUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/sdp' },
  body: offer.sdp                       // plain SDP text, NOT JSON
}).then(r => r.text());                 // answer is plain SDP text

await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
// ontrack fires twice (video, then audio). The server puts each track in its own
// msid, so e.streams[0] differs per event. Assigning it directly would drop the
// first track. Collect both into one stream and bind that once.
const avatar = new MediaStream();
pc.ontrack = (e) => { avatar.addTrack(e.track); if (!videoEl.srcObject) videoEl.srcObject = avatar; };
```

That's it: a vanilla WHEP subscribe. The avatar's face+voice stream into your `<video>`.

## Related docs

| Doc | Covers |
|---|---|
| [connection-and-handshake.md](connection-and-handshake.md) | Endpoints, the connect sequence, the `join` payload |
| [conversation-flow.md](conversation-flow.md) | What streams while connected |
| [../ARCHITECTURE-REFERENCE.md](../ARCHITECTURE-REFERENCE.md) | Back to the index |
