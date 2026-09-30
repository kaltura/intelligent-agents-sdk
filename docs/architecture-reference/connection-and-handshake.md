[← Back to System Internals Reference](../ARCHITECTURE-REFERENCE.md)

# Connection and Handshake

## Endpoints & Credentials

| Thing | Value |
|---|---|
| Control socket | `wss://conversation.avatar.us.kaltura.ai` path `/socket.io` (session option `conversationManagerUrl`) |
| STV WHEP base | `srsBaseUrl` from `appInit` |
| STV WHEP signaling | `POST {webrtc_url}` if `stvNewSession` returned one, else `POST {srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id}` (body: plain SDP, `Content-Type: application/sdp`). `whepUrl()` in `src/experience/wire.js` |
| TURN | `turnServerUrl` and `turnCredentials` from `appInit`. See [TURN configuration](#turn-configuration) below. |
| Auth | Socket.IO `auth: { token: <conversation KS> }` and `query.partnerId` |

`conversationManagerUrl`, `srsBaseUrl`, `turnServerUrl`, `turnCredentials` and the conversation `ks` come from **`POST https://api.avatar.us.kaltura.ai/v1/application/appInit`** (see [API-REFERENCE.md](../../API-REFERENCE.md)). The agent is identified by `partnerId` (from the KS) and the KS itself.

### TURN configuration

Pass `turnServerUrl` and `turnCredentials` from `appInit` to the session. The TURN URLs, credentials and ICE policy are in [wire-protocol/audio-channels.md](../wire-protocol/audio-channels.md#5-asr-uplink-pc1--microphone--server).

---

## Socket.IO Connection

```js
import { io } from 'socket.io-client';

const socket = io(conversationManagerUrl, {   // from appInit
  path: '/socket.io',
  transports: ['websocket'],
  auth: { token: conversationKs },            // from appInit
  query: {
    partnerId: '<your_partner_id>',           // derived from the KS
    billed_client: '',
    stickyId: '<random-16>',
    level: 'published',
    debugMode: true
  }
});
```

The `KalturaAvatarSession` sends exactly these query params ([param table](../wire-protocol/connection-basics.md#2-socketio-connection)).

---

## Full Connect Sequence (state-machine order)

`connect()` runs these steps in order (the step numbers match the comments in `src/experience/session.js`). Steps 1-5 are serial: each waits for the named inbound event. After step 5 the SDK runs two lanes in parallel:

- Lane A: steps 6→7→9 (agent, ready, ASR uplink).
- Lane B: step 10 (WHEP), which needs only the step 5 result.

Step 11 runs once both lanes are done. The first lane to fail rejects `connect()` at once. Step 0 is never awaited: the mic prompt runs alongside the whole sequence, and a denied mic emits a `warning`, never a failure. Timeouts appear in the last column.

<!-- nova-target: full-connect-sequence-table | Full connect sequence (state-machine order) -->

| # | Client does | Emits (→) / Waits (←) | Inbound event | Timeout |
|---|-------------|----------------------|---------------|---------|
| 0 | Start `getUserMedia(audio:true,video:false)` in the background | - | (browser mic prompt) | - (not awaited) |
| 1 | Open socket | ← | `onServerConnected` `{finalUrl, agentName, hostName}`; the SDK emits `streamReady` | 10s (`ConnectionTimeout`) |
| 2 | Join room | → `join` (see payload below) | - | - |
| 3 | Wait config + join ack | ← `clientConfiguration`, ← `joinComplete` | both required | `clientConfiguration` 5s, `joinComplete` **20s** (both `JoinRoomTimeout`) |
| 4 | Create STV session | → `stvNewSession` `{room_id}`, and → `checkAvailability` in parallel | - | - |
| 5 | Wait session | ← `stvNewSession` `{session_id, status, webrtc_url?}` (or ← `throwToNoAgent`) | sets `sessionId` + `webrtcUrl` | - |
| 6 | Wait agent | ← `showAgent` | agent joined | 10s (`AgentResponseTimeout`) |
| 7 | Wait ready | ← `askPermissions` `{constraints:{audio,video}}` | ready for the mic | 10s (`AgentResponseTimeout`) |
| 9 | Connect ASR (mic uplink), lane A, after 6→7 | `asr-webrtc-*` handshake ([§5](../wire-protocol/audio-channels.md#5-asr-uplink-pc1--microphone--server)) | - | 30s per wait (`ASRConnectionFailed`) |
| 10 | Subscribe STV video (WHEP) **and wait until it is *playable*, or give up waiting**, lane B, starts right after step 5 | → WHEP `POST` (no timeout of its own) → wait for the video track, then `<video>` `canplay` + ~300ms settle. Without `canplay` within 2s of the track, or without any track within 6s of the subscribe start, the gate settles anyway | first decoded frame, or a fallback timer elapsing | 6s cap from subscribe start (2s after the track if `canplay` is missing); settles either way |
| 11 | Emit `disclosure`, then approve (this starts the spoken greeting), once lanes A and B are both done | → `approvedPermissions` `{room}` | - | - |
| 12 | Opening turn runs. With a silent opening phrase (`SILENT_OPENING`) it produces no speech and ends in about 0.5 s. A configured `kickoff` is sent on its `stvFinishedTalking` ([guide](../START-THE-CONVERSATION.md)) | ← `stvStartedTalking` … ← `stvFinishedTalking`, then → `onTextEntered {text}` | `stvFinishedTalking` | - |
| → | **CONNECTED** | listen for `agent_raw_text`, `generatingSpeech`, `stvStartedTalking` | — | — |
<!-- /nova-target -->

Step 8 is unused. In audio/phone mode there is no STV session, so lane B is skipped ([wire-protocol/audio-channels.md §5b](../wire-protocol/audio-channels.md#5b-audio-mode-webrtc-separate-from-the-asr-uplink)).

Overall connecting timeout: 30s. It bounds every wait in the table, including the two ASR waits and the WHEP answer. An event or WHEP answer that lands after the deadline rejects `connect()` with `ConnectTimeout`.

**Why step 3 has two timeouts.** `joinComplete` can arrive later than `clientConfiguration` under load. The SDK budgets the two waits separately: `clientConfiguration` gets 5s (`TIMEOUTS.joinRoom`), `joinComplete` gets 20s (`TIMEOUTS.joinComplete`). A single 5s budget for both causes spurious `JoinRoomTimeout` failures on loaded rooms.

The 30s deadline is set once, at the start of `connect()`. It keeps running through every later step, including the capacity queue, and is **not** paused or extended when the queue activates. If no slot frees up before it runs out, `connect()` rejects with `ConnectTimeout`. To wait longer for a slot, call `waitForCapacity({maxWaitMs, pollIntervalMs})` **before** `connect()`. It is a separate, opt-in poll with its own bound: `maxWaitMs` defaults to 300000ms. See [Capacity & the queue](scale-and-sticky-sessions.md#capacity--the-queue-throwtonoagent--throwtoexceededtier).

**Why `approvedPermissions` waits for playable video.** `approvedPermissions` is what makes the agent start speaking. ICE `connected` fires about 2s before the first frame decodes, so approving early clips the greeting. `_approve` (`src/experience/session.js`) waits for `<video>` to reach `canplay` (`HAVE_FUTURE_DATA`). The fallback timers (2s after the track, 6s after the subscribe starts) mean a stalled video track can't block approval forever. Do the same in a custom client.

The opening line itself can't be interrupted. Typed text sent during it is held (`speak()`) until `stvFinishedTalking`. For the fastest interruptible start, give the avatar a silent opening phrase (`SILENT_OPENING`) and let the session's `kickoff` option send the first turn on that event. See [START-THE-CONVERSATION.md](../START-THE-CONVERSATION.md).

---

## The `join` payload (step 2): carries the agent/brain config

```js
socket.emit('join', {
  client: clientId,            // optional
  room: roomId,                // a client-generated room id (also sent as 'channel')
  channel: roomId,
  kaltura: {
    ks: <conversationKs>,
    entryId: <entryId>,            // only if the session has an entry
    contextId: <contextId>,        // category/entry the knowledge base is scoped to
    contextType: <contextType>,    // the type of contextId (e.g. 'entry' vs 'category')
    threadId: <existingThreadId>,  // to resume a conversation thread
    request_vars: { … },           // join-time {{var}} values, if any
    force_experience: 'avatar_only',
    capabilities: {                // same enum as intellect config
      avatar: 'on',
      generate_followup_questions: 'on',
      // use_content_search, include_sources, etc.
    }
  },
  userAgent, userAgentHints: null, isMobile,
  channel_password: null, peer_name: 'unknown',
  peer_video: false, peer_audio: true
});
```

- **Which intellect loads.** The `geniegpcid:<configId>` in the KS selects the intellect (the agent's brain configuration). An agent token also carries `agentid:<agentId>`.
- **Always send `kaltura.ks`.** A `join` without it never gets `clientConfiguration` or `joinComplete`, and the connect stalls until the timeout.
- **`force_experience` is always `avatar_only`.** `buildJoin` sets it on every call. See [client-configuration.md](../wire-protocol/client-configuration.md#structured-experiences-force_experience--unisphere-tool) for what that means for widgets.
- **`capabilities` and `request_vars` are client-controlled.** They are sent at `join`. You can update them mid-session with the `updateGenieContext` event ([events catalog](../wire-protocol/events-catalog.md#4a-client--server-emit)).
- **The socket carries the same agent protocol as the HTTP API.** It streams `agent_raw_text` in the same envelope as HTTP `/assistant/converse`, documented in [API-REFERENCE.md](../../API-REFERENCE.md). Headless or text-only integrations use that HTTP path. The live avatar runtime uses the socket.

## Related docs

| Doc | Covers |
|---|---|
| [channels.md](channels.md) | ASR uplink + STV downlink |
| [conversation-flow.md](conversation-flow.md) | What streams while connected, sending user input, the message catalog |
| [../ARCHITECTURE-REFERENCE.md](../ARCHITECTURE-REFERENCE.md) | Back to the index |
