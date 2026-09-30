[← Back to System Internals Reference](../ARCHITECTURE-REFERENCE.md)

# Audio & Video Wiring

Client-side code for the two peer connections below. For the wire-level SDP/ICE spec, see [Audio Channels](../wire-protocol/audio-channels.md) in the Wire Protocol reference.

## ASR Channel: Microphone Uplink (step 9)

A WebRTC peer connection whose SDP/ICE travel **through the socket** (not WHEP). This is what `_connectAsr` in `src/experience/session.js` does:

```js
// 1. start signaling
socket.emit('asr-webrtc-init', { sessionId: socket.id });
// 2. wait
socket.once('asr-webrtc-ready', ...);          // 30s, also bounded by the 30s connect deadline
// 3. create RTCPeerConnection with the mic track, generate offer, then:
socket.emit('asr-webrtc-offer', { offer, is_reconnect: false });
socket.once('asr-webrtc-answer', ({ answer }) => pc.setRemoteDescription(answer));  // 30s
// 4. trickle ICE both ways
socket.emit('asr-webrtc-ice-candidate', { candidate });
socket.on('asr-ice-candidate', (c) => pc.addIceCandidate(c));
```

PeerConnection configuration:

- **TURN**: `turnServerUrl` and `turnCredentials` from `appInit`, See [TURN configuration](connection-and-handshake.md#turn-configuration).
- **Audio constraints**: `micConstraints` session option, default `{echoCancellation, noiseSuppression, autoGainControl}` all `true`. Pass `false` for bare `audio:true`.
- **Video**: none.

Once connected, the server transcribes your speech and routes it to the agent. There is no separate "send transcript" call.

---

## STV Channel: Avatar Video Downlink (after CONNECTED)

Standard **WHEP**, independent of the socket.

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
// ontrack fires twice (video, then audio) with a different stream each time, so
// e.streams[0] differs per event. Assigning it directly would drop the first track.
// Collect both into one stream and bind that once.
const avatar = new MediaStream();
pc.ontrack = (e) => { avatar.addTrack(e.track); if (!videoEl.srcObject) videoEl.srcObject = avatar; };
```

That is a plain WHEP subscribe. The avatar's face and voice stream into your `<video>`. `KalturaAvatarSession` does the same and also gates the greeting on the video being playable ([connect sequence](connection-and-handshake.md#full-connect-sequence-state-machine-order), step 10).

## Related docs

| Doc | Covers |
|---|---|
| [connection-and-handshake.md](connection-and-handshake.md) | Endpoints, the connect sequence, the `join` payload |
| [conversation-flow.md](conversation-flow.md) | What streams while connected |
| [../ARCHITECTURE-REFERENCE.md](../ARCHITECTURE-REFERENCE.md) | Back to the index |
