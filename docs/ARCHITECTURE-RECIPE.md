# Minimal Reimplementation Recipe (No Kaltura Libs)

A from-scratch reimplementation of the live avatar runtime, using nothing but `socket.io-client` and the browser's native `RTCPeerConnection`. The steps below carry two channels: **ASR** (the microphone uplink) and **STV** (the avatar video downlink). Read [ARCHITECTURE.md](ARCHITECTURE.md) for the big picture and [ARCHITECTURE-REFERENCE.md](ARCHITECTURE-REFERENCE.md) for the exact wire shapes each step below relies on.

<!-- nova-target: architecture-recipe-steps | Minimal reimplementation recipe steps -->

```
1. Backend: POST /v1/application/appInit (widget KS or agent KS)
   → { ks, conversationManagerUrl, srsBaseUrl, turnServerUrl, avatars[] }

2. Browser: getUserMedia({audio:true})

3. socket = io(conversationManagerUrl, {path:'/socket.io', transports:['websocket'],
       auth:{token:ks}, query:{partnerId, level:'published', stickyId, billed_client:'', debugMode:true, sdk:'<version>'}})

4. Run the connect sequence: join → stvNewSession → showAgent → askPermissions
   → asr-webrtc handshake (publish mic pc via socket relay)

5. STV: WHEP POST {webrtc_url} from stvNewSession (fallback: {srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id}) with recvonly offer,
   setRemoteDescription(answer), pc.ontrack fires twice (video, audio; a different stream each time) → both
   tracks merged into one SDK-owned MediaStream → <video>.srcObject once → await <video> canplay

6. ONLY NOW → approvedPermissions  (gating on playable video avoids clipping the greeting)

7. Listen: agent_raw_text (agent text), generatingSpeech, stvStartedTalking/stvFinishedTalking (turn state)

8. User speaks → ASR pc carries audio → server transcribes → agent replies → avatar speaks (STV) + agent_raw_text
   (or inject text: emit onTextEntered {text, isFinal:true}, the same event speak() always emits.
   If the client was built with debug:true, it also emits debug_text_entered with the same payload,
   right after onTextEntered)
```
<!-- /nova-target -->

`onServerConnected` can carry `turn` (per-session relay credentials). How to use it: [audio-channels.md §5](wire-protocol/audio-channels.md#5-asr-uplink-pc1-microphone--server).

Step 4 follows the [full connect sequence](architecture-reference/connection-and-handshake.md#full-connect-sequence-state-machine-order).

Dependencies: `socket.io-client` + the browser's native `RTCPeerConnection`. Nothing else. `KalturaAvatarSession` is a wrapper around exactly these steps (ASR = the socket-relayed offer/answer; STV = the WHEP subscribe).

## Implications for a Custom (No-Kaltura-Lib) Client

If you reimplement the protocol per the recipe above, you MUST:

1. **Send the same `stickyId` on every socket connection.** Generate a random 16-character string once per session. Send it as the `stickyId` query param, also on a reconnect. Never rotate it mid-session ([Sticky routing](architecture-reference/scale-and-sticky-sessions.md#sticky-routing-stickyid)).
2. **Emit `stvNewSession` right away. Don't gate it on `checkAvailability` first.** Poll `checkAvailability` → `availabilityResult` *in parallel* on the same socket instead:
   - Don't wait for `availabilityResult` before `stvNewSession`. Waiting only adds dead time.
   - If a poll comes back `available:false`, back off and re-poll without touching `stvNewSession`. The delays are in [Capacity & the queue](architecture-reference/scale-and-sticky-sessions.md#capacity--the-queue-throwtonoagent--throwtoexceededtier).
   - `throwToNoAgent` is terminal on that socket. The socket closes right after it. Open a fresh socket with the same `stickyId` and retry `join`/`stvNewSession`.
3. **Treat `throwToExceededTier` as fatal.** Don't retry: it is a plan limit, not a capacity limit.
4. **Keep the socket alive during queue waits.** Open a fresh socket only after a permanent transport loss, and keep the same `stickyId`.
5. Let the **STV/WHEP** video channel reconnect independently. It carries no sticky state.

Details for each rule: [Scale & Sticky Sessions](architecture-reference/scale-and-sticky-sessions.md#scale--sticky-sessions).
