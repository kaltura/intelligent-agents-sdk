# Architecture Recipe — Minimal Reimplementation (No Kaltura Libs)

A from-scratch reimplementation of the live avatar runtime, using nothing but `socket.io-client` and the browser's native `RTCPeerConnection`. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the big picture and [ARCHITECTURE-REFERENCE.md](ARCHITECTURE-REFERENCE.md) for the exact wire shapes each step below relies on.

```
1. Backend: POST /v1/application/appInit (widget KS)
   → { ks, conversationManagerUrl, srsBaseUrl, turnServerUrl, avatars[] }

2. Browser: getUserMedia({audio:true})

3. socket = io(conversationManagerUrl, {path:'/socket.io', transports:['websocket'],
       auth:{token:ks}, query:{partnerId, level:'published', stickyId, billed_client:''}})

4. Run the connect sequence ([full state-machine order](ARCHITECTURE-REFERENCE.md#full-connect-sequence-state-machine-order)): join → stvNewSession → showAgent → askPermissions
   → asr-webrtc handshake (publish mic pc via socket relay)

5. STV: WHEP POST {srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id} with recvonly offer,
   setRemoteDescription(answer), pc.ontrack → <video>.srcObject → await <video> canplay

6. ONLY NOW → approvedPermissions  (gating on playable video avoids clipping the greeting)

7. Listen: agent_raw_text (brain text), generatingSpeech, stvStarted/FinishedTalking (turn state)

8. User speaks → ASR pc carries audio → server transcribes → brain → avatar speaks (STV) + agent_raw_text
   (or inject text: emit debug_text_entered {text, isFinal:true} → server handler onTextEntered)
```

Dependencies: `socket.io-client` + the browser's native `RTCPeerConnection`. Nothing else. The WebRTC avatar engine's client package is just a convenience wrapper around exactly these steps (`joinASR` = the socket-relayed offer/answer; `joinSTV` = the WHEP subscribe).

## Implications for a Custom (No-Kaltura-Lib) Client

If you reimplement the protocol per the recipe above, you MUST:

1. **Send a stable `stickyId` query param** on the socket (random 16-char, once per connect) — without it, polling requests scatter across pods and the handshake fails intermittently under load.
2. **Handle `throwToNoAgent`** by queueing/polling `checkAvailability` and re-emitting `join` on the same socket — not by reconnecting (a reconnect would land on a different pod and re-queue).
3. **Treat `throwToExceededTier` as fatal** (don't retry — it's a plan limit, not capacity).
4. **Keep the socket alive during queue waits**; only do a fresh `connect()` (new `stickyId`) on a permanent transport loss.
5. Let the **STV/WHEP** video channel reconnect independently — it carries no sticky state.

See [ARCHITECTURE-REFERENCE.md's "Scale & Sticky Sessions"](ARCHITECTURE-REFERENCE.md#scale--sticky-sessions) for why each of these matters.
