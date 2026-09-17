---
layout: base.njk
title: "System Internals Reference · Audio & Video Wiring"
description: "Client-side code for the ASR uplink (microphone) and the STV downlink (avatar video) — the wire-level spec lives on Audio Channels instead."
eyebrow: Reference
---

# Audio & Video Wiring

[← Back to System Internals Reference](/reference/architecture-reference/)


Client-side code for the two peer connections below. For the wire-level SDP/ICE spec instead, see [Audio Channels](/reference/wire-protocol/audio-channels/) in the Wire Protocol reference.

## ASR Channel: Microphone Uplink (step 9)

A WebRTC peer connection whose SDP/ICE are relayed **through the socket** (NOT WHEP). From the platform's built-in client's ASR connection handler:

```js
// 1. tell server to prepare
socket.emit('asr-webrtc-init', { sessionId: peerId });
// 2. wait
socket.once('asr-webrtc-ready', ...);          // (or 'asr-webrtc-error')   timeout 30s
// 3. create RTCPeerConnection with the mic track, generate offer, then:
socket.emit('asr-webrtc-offer', { offer, is_reconnect: false });
socket.once('asr-webrtc-answer', ({ answer }) => pc.setRemoteDescription(answer));  // 30s
// 4. trickle ICE both ways
socket.emit('asr-webrtc-ice-candidate', { candidate });
// (server may push its own candidates on the same event name)
```

PeerConnection configuration:

- **TURN**: `turn.avatar.us.kaltura.ai` (default username/credential from `wire.js`'s `turnServers()`, four explicit port/transport URLs). See the [Endpoints & Credentials table](/reference/architecture-reference/connection-and-handshake/#endpoints--credentials).
- **`iceTransportPolicy`**: set per the leg's `forceRelay` flag. The production runtime forces `'relay'` for ASR. The no-SDK debug app uses `'all'`. Both relay in practice, because the server only offers a private candidate.
- **Audio constraints**: `{echoCancellation, autoGainControl, noiseReduction}`.
- **Video**: none.

Once connected, the server transcribes your speech and routes it to the brain automatically. There is no separate "send transcript" call.

---

## STV Channel: Avatar Video Downlink (after CONNECTED)

Standard **SRS WHEP**, completely independent of the socket. From the platform's built-in client's SRS signaling adapter:

```js
const playUrl = stvNewSession.webrtc_url
  ?? `${srsBaseUrl}/rtc/v1/play/?app=app&stream=${session_id}`;

// create a recv-only RTCPeerConnection, addTransceiver('video'|'audio', {direction:'recvonly'})
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

const answerSdp = await fetch(`${srsBaseUrl}/rtc/v1/whep/?app=app&stream=${session_id}`, {
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
| [System Internals Reference · Connection and Handshake](/reference/architecture-reference/connection-and-handshake/) | Endpoints, the connect sequence, the `join` payload |
| [System Internals Reference · Conversation Flow](/reference/architecture-reference/conversation-flow/) | What streams while connected |
| [System Internals Reference](/reference/architecture-reference/) | Back to the index |

