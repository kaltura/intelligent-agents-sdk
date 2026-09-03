# Architecture Recipe — Minimal Reimplementation (No Kaltura Libs)

A from-scratch reimplementation of the live avatar runtime, using nothing but `socket.io-client` and the browser's native `RTCPeerConnection`. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the big picture and [ARCHITECTURE-REFERENCE.md](ARCHITECTURE-REFERENCE.md) for the exact wire shapes each step below relies on.

```
1. Backend: POST /v1/application/appInit (widget KS)
   → { ks, conversationManagerUrl, srsBaseUrl, turnServerUrl, avatars[] }

2. Browser: getUserMedia({audio:true})

3. socket = io(conversationManagerUrl, {path:'/socket.io', transports:['websocket'],
       auth:{token:ks}, query:{partnerId, level:'published', stickyId, billed_client:'', debugMode:true}})

4. Run the connect sequence ([full state-machine order](architecture-reference/connection-and-handshake.md#full-connect-sequence-state-machine-order)): join → stvNewSession → showAgent → askPermissions
   → asr-webrtc handshake (publish mic pc via socket relay)

5. STV: WHEP POST {srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id} with recvonly offer,
   setRemoteDescription(answer), pc.ontrack → <video>.srcObject → await <video> canplay

6. ONLY NOW → approvedPermissions  (gating on playable video avoids clipping the greeting)

7. Listen: agent_raw_text (brain text), generatingSpeech, stvStartedTalking/stvFinishedTalking (turn state)

8. User speaks → ASR pc carries audio → server transcribes → brain → avatar speaks (STV) + agent_raw_text
   (or inject text: emit onTextEntered {text, isFinal:true} — the same event speak() always emits;
   debug_text_entered is a secondary mirror the server sends only when the session was created with debug:true)
```

Dependencies: `socket.io-client` + the browser's native `RTCPeerConnection`. Nothing else. The WebRTC avatar engine's client package is just a convenience wrapper around exactly these steps (`joinASR` = the socket-relayed offer/answer; `joinSTV` = the WHEP subscribe).

## Implications for a Custom (No-Kaltura-Lib) Client

If you reimplement the protocol per the recipe above, you MUST:

1. **Send a stable `stickyId` query param** on the socket (random 16-char, once per connect) — without it, polling requests scatter across pods and the handshake fails intermittently under load.
2. **Poll `checkAvailability` → `availabilityResult` BEFORE ever emitting `join`/`stvNewSession`**, and only proceed once `available:true`. `throwToNoAgent` is terminal, not something to recover from on the same socket: the server disconnects the socket right after emitting it. If it arrives anyway, treat the socket as dead — open a fresh socket (new `stickyId`) and go back to availability polling.
3. **Treat `throwToExceededTier` as fatal** (don't retry — it's a plan limit, not capacity).
4. **Keep the socket alive during queue waits**; only do a fresh `connect()` (new `stickyId`) on a permanent transport loss.
5. Let the **STV/WHEP** video channel reconnect independently — it carries no sticky state.

See [ARCHITECTURE-REFERENCE.md's "Scale & Sticky Sessions"](architecture-reference/scale-and-sticky-sessions.md#scale--sticky-sessions) for why each of these matters.
