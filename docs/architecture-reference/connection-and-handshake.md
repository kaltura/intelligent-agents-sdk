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
| 10 | Subscribe STV video (WHEP) **and wait until it is *playable*, or give up waiting**, lane B, starts right after step 5 | → WHEP `POST` (5 s per try, 3 tries; [details](../wire-protocol/audio-channels.md#6-stv-downlink-pc2--avatar-videoaudio--you)) → wait for the video track, then for the first painted frame (`requestVideoFrameCallback`). Where that API is missing, the tab is hidden, the stream has no video track, or media is being recovered, the gate is `<video>` `canplay` + 100ms. With no `videoEl`, the gate is a 300ms settle | first painted frame | `timeouts.firstFrame` (6s), counted from the moment the answer is applied. At the cap with no frame the SDK re-subscribes once, then continues with warning `media_no_video` and `mediaReady {degraded:true}` |
| 11 | Emit `disclosure`, then approve (this starts the spoken greeting), once lanes A and B are both done | → `approvedPermissions` `{room}` | - | - |
| 12 | Opening turn runs. With a silent opening phrase (`SILENT_OPENING`) it produces no speech and ends in about 0.5 s. A configured `kickoff` is sent on its `stvFinishedTalking` ([guide](../START-THE-CONVERSATION.md)) | ← `stvStartedTalking` … ← `stvFinishedTalking`, then → `onTextEntered {text}` | `stvFinishedTalking` | - |
| → | **CONNECTED** | listen for `agent_raw_text`, `generatingSpeech`, `stvStartedTalking` | — | — |
<!-- /nova-target -->

Step 8 is unused. In audio/phone mode there is no STV session, so lane B is skipped ([wire-protocol/audio-channels.md §5b](../wire-protocol/audio-channels.md#5b-audio-mode-webrtc-separate-from-the-asr-uplink)).

Overall connecting timeout: 30s. It bounds every wait in the table, including the two ASR waits and the WHEP answer. An event or WHEP answer that lands after the deadline rejects `connect()` with `ConnectTimeout`.

**Timeout errors.** Every wait in the table rejects with `code: 'timeout'`. The names in the table (`JoinRoomTimeout` and the rest) are labels in `detail`, not codes. Branch on `error.phase`, which names the step that ran out:

| `error.phase` | Step |
|---|---|
| `serverConnect` | 1 |
| `join` | 3, `clientConfiguration` |
| `joinComplete` | 3, `joinComplete` |
| `agent` | 6 and 7 |
| `asr` | 9 |
| `whep` | 10, the WHEP request (`whep_timeout`, `whep_failed`, `stv_session_gone`) |
| `connect` | A fatal server event (`capacity_unavailable`, `tier_exceeded`, `bad_request`) or any other failure in `connect()` |
| `reconnect` | The socket or a cold reconnect ran out of attempts (`reconnect_failed`) |

`error.retryable` is `true` on `timeout`, `capacity_unavailable`, `whep_timeout`, a `whep_failed` caused by the network, `stv_session_gone` and `reconnect_failed`, because the same call can succeed on a later try. A `whep_failed` that carries an HTTP status does not set it. Both fields are also in `error.toJSON()`.

**Why step 3 has two timeouts.** `joinComplete` can arrive later than `clientConfiguration` under load. The SDK budgets the two waits separately: `clientConfiguration` gets 5s (`TIMEOUTS.joinRoom`), `joinComplete` gets 20s (`TIMEOUTS.joinComplete`). A single 5s budget for both causes spurious `JoinRoomTimeout` failures on loaded rooms.

The 30s deadline is set once, at the start of `connect()`. It keeps running through every later step, including the capacity queue, and is **not** paused or extended when the queue activates. If no slot frees up before it runs out, `connect()` rejects with `ConnectTimeout`. To wait longer for a slot, call `waitForCapacity({maxWaitMs, pollIntervalMs})` **before** `connect()`. It is a separate, opt-in poll with its own bound: `maxWaitMs` defaults to 300000ms. See [Capacity & the queue](scale-and-sticky-sessions.md#capacity--the-queue-throwtonoagent--throwtoexceededtier).

**Why `approvedPermissions` waits for playable video.** `approvedPermissions` is what makes the agent start speaking. ICE `connected` fires about 2s before the first frame decodes, so approving early clips the greeting. `_approve` (`src/experience/session.js`) waits for `<video>` to reach `canplay` (`HAVE_FUTURE_DATA`). The fallback timers (2s after the track, 6s after the subscribe starts) mean a stalled video track can't block approval forever. Do the same in a custom client.

The opening line itself can't be interrupted. Typed text sent during it is held (`speak()`) until `stvFinishedTalking`. For the fastest interruptible start, give the avatar a silent opening phrase (`SILENT_OPENING`) and let the session's `kickoff` option send the first turn on that event. See [START-THE-CONVERSATION.md](../START-THE-CONVERSATION.md).

---

**Connecting again.** `disconnect()` clears the token. Call `setToken()` with a fresh conversation KS before the next `connect()` or `prepare()`, or they reject with `invalid_state`. From the `error` state, call `disconnect()` first.

## Start faster

**`prepare()`.** `await session.prepare()` does steps 1 to 3 ahead of time: it opens the socket, sends `join` and waits for the join ack. Call it when the user is likely to start soon (page load, hover over the start button). The later `connect()` skips those steps. `prepare()` never asks for the microphone and never creates an avatar session, so a prepared page costs nothing until `connect()`.

| Rule | Behavior |
|---|---|
| Idempotent | A second call returns the first call's promise. It does nothing while a connect runs or after one finished. |
| `connect()` during a prepare | Waits for it, then reuses the socket. |
| Unused | After `timeouts.prepareIdle` (60 s) the socket is closed with warning `prepare_expired`. A later `connect()` starts fresh. |
| Dropped or failed | `connect()` starts fresh. A failed `prepare()` rejects with the same errors as steps 1 to 3. |
| Inputs | The `join` is sent at once. Set `threadId`, `requestVars`, `contextId` and the other join inputs in the constructor. |
| `streamReady` | Fires from `connect()`, so listeners attached before `connect()` still see it. |

**Resource hints.** Add these to the page `<head>` so the browser opens the connections while the page loads. The origins are the ones you pass as `conversationManagerUrl` and `srsBaseUrl`, and your TURN host.

```html
<link rel="preconnect" href="https://MESSAGING_HOST">
<link rel="preconnect" href="https://MESSAGING_HOST" crossorigin>
<link rel="preconnect" href="https://SRS_HOST" crossorigin>
<link rel="dns-prefetch" href="https://TURN_HOST">
```

**Connect timings.** `session.timings` returns the phases of the current or last `connect()` in ms from the start of that call. A phase that was not reached is absent. After a successful connect the session emits `connectTimings` once with the same object. A failed `connect()` attaches the phases it reached to `error.timings`.

| Phase | Reached when |
|---|---|
| `micRequested` | The microphone request started (absent with `micStartMode: 'deferred'`) |
| `socketOpen`, `serverConnected`, `joinComplete` | Steps 1 to 3. With `prepare()` they are all about 0 |
| `stvNewSessionReply` | The server answered `stvNewSession` |
| `whepSent`, `whepAnswer` | The WHEP `POST` left and its answer arrived |
| `iceConnectedStv` | The video peer's ICE connected |
| `firstTrack`, `firstFrame`, `mediaReady` | First downlink track, first painted frame, `mediaReady` emitted |
| `asrReady` | The microphone uplink is negotiated |
| `approved`, `connected` | `approvedPermissions` sent, state `connected` |

The rows group related phases and are not in time order. `firstFrame` is also absent when there is no `videoEl`, when the browser has no `requestVideoFrameCallback`, or when no frame arrived in time (`mediaReady` then has `degraded: true`).

**Tuning.** `timeouts` overrides any wait in the table above (`overall`, `serverConnect`, `joinRoom`, `joinComplete`, `agent`, `asr`, `firstFrame`, `prepareIdle`) and the WHEP, recovery and watchdog limits (`whepTry`, `whepTries`, `whepBackoff`, `whepRelease`, `recover`, `healthTick`, `videoStall`, `coldAttempts`, `coldBackoff`; defaults in [Resilience](resilience-and-failure-handling.md)). `reconnectionDelay` (default 250 ms) and `reconnectionDelayMax` (default 2000 ms) set how soon and how often a dropped socket retries.

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
