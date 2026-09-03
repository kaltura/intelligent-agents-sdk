---
layout: base.njk
title: "Architecture Reference · Channels"
description: "The ASR channel (microphone uplink) and the STV channel (avatar video downlink), field by field."
eyebrow: Reference
---

# Channels

[← Back to Architecture Reference](/reference/architecture-reference/)

**On this page:** [ASR Channel — Microphone Uplink (step 9)](#asr-channel--microphone-uplink-step-9) · [STV Channel — Avatar Video Downlink (after CONNECTED)](#stv-channel--avatar-video-downlink-after-connected) · [Related docs](#related-docs)


## ASR Channel — Microphone Uplink (step 9)

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

PeerConnection config: TURN `turn.avatar.us.kaltura.ai` (default username/credential from `wire.js`'s `turnServers()`, four explicit port/transport URLs — see [Endpoints & Credentials table](/reference/architecture-reference/connection-and-handshake/#endpoints--credentials)), `iceTransportPolicy` per the leg's `forceRelay` flag (production runtime forces `'relay'` for ASR; the no-SDK debug-app uses `'all'` — both relay in practice since the server only offers a private candidate), audio constraints `{echoCancellation, autoGainControl, noiseReduction}`, no video. Once connected, the server transcribes your speech and routes it to the brain automatically — there is no separate "send transcript" call.

---

## STV Channel — Avatar Video Downlink (after CONNECTED)

Standard **SRS WHEP** — completely independent of the socket. From the platform's built-in client's SRS signaling adapter:

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
pc.ontrack = (e) => { videoEl.srcObject = e.streams[0]; };  // the avatar video
```

That's it — a vanilla WHEP subscribe. The avatar's face+voice stream into your `<video>`.

## Related docs

| Doc | Covers |
|---|---|
| [Architecture Reference · Connection and Handshake](/reference/architecture-reference/connection-and-handshake/) | Endpoints, the connect sequence, the `join` payload |
| [Architecture Reference · Conversation Flow](/reference/architecture-reference/conversation-flow/) | What streams while connected |
| [Architecture Reference](/reference/architecture-reference/) | Back to the index |

