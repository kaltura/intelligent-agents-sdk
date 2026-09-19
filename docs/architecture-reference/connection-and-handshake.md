[← Back to System Internals Reference](../ARCHITECTURE-REFERENCE.md)

# Connection and Handshake

## Endpoints & Credentials

| Thing | Value |
|---|---|
| Control socket | `wss://conversation.avatar.us.kaltura.ai` path `/socket.io` |
| STV WHEP base | `https://srs.avatar.us.kaltura.ai` |
| STV play URL | `{srsBaseUrl}/rtc/v1/play/?app=app&stream={session_id}` (or `webrtc_url` from `stvNewSession`) |
| STV WHEP signaling | `POST {srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id}` (body: plain SDP, `Content-Type: application/sdp`) |
| TURN | `turn.avatar.us.kaltura.ai` (default username/credential in `wire.js`'s `turnServers()`, overridable via `creds`). See [TURN configuration](#turn-configuration) below. |
| Auth | Socket.IO `auth: { token: <enrichedKS> }` + `query.partnerId` |

All of `conversationManagerUrl`, `srsBaseUrl`, `turnServerUrl`, and the enriched `ks` come from **`POST https://api.avatar.us.kaltura.ai/v1/application/appInit`** (see [API-REFERENCE.md](../../API-REFERENCE.md)). The agent is identified by `partnerId` (from the KS) and the KS itself, not by `clientId` or `flowId`. Both of those are optional and unused by Kaltura agents.

### TURN configuration

Set explicit ports and transports on the TURN address. A bare `turn:host` gives no relay candidate. When that happens, `packetsSent` stays at `0` and the avatar can't hear you. Use all four forms:

- `turn:HOST:80?transport=udp`
- `turn:HOST:443?transport=udp`
- `turn:HOST:80?transport=tcp`
- `turns:HOST:443?transport=tcp`

`iceTransportPolicy` resolves per leg, in the built-in client's media layer, as `forceRelay && !isFirefox ? 'relay' : 'all'`:

- STV uses `'relay'` in every client except Firefox, where it uses `'all'`.
- ASR uses `'relay'` in the production runtime (`forceAsrRelay:true`), but `'all'` in the embed SDK and the debug app, and always `'all'` in Firefox.

Both ASR policies behave the same in practice: the ASR server advertises only a private host candidate, so the pair relays through TURN either way. This means the TURN URLs must be correct. The policy setting matters less.

Full per-client matrix: [wire-protocol/audio-channels.md §5](../wire-protocol/audio-channels.md#5-asr-uplink-pc1--microphone--server).

---

## Socket.IO Connection

```js
import { io } from 'socket.io-client';

const socket = io(conversationManagerUrl, {   // from appInit
  path: '/socket.io',
  transports: ['websocket'],
  auth: { token: enrichedKs },                // from appInit
  query: {
    partnerId: '<your_partner_id>',           // derived from the KS
    clientId: undefined,                       // optional; unused for Kaltura agents
    flowId: undefined,                         // optional; unused for Kaltura agents
    billed_client: '',
    stickyId: '<random-16>',
    level: 'published',
    debugMode: true
  }
});
```

---

## Full Connect Sequence (state-machine order)

Exact order from the platform's built-in client's connection state machine. Steps 1–5 are serial: each waits for the named inbound event before advancing. After step 5 the SDK runs two lanes in parallel: lane A is steps 6→7→9 (agent, ready, ASR uplink), lane B is step 10 (WHEP), which needs only the step 5 result. Step 11 runs once both lanes are done. The first lane to fail rejects `connect()` at once. Step 0 is never awaited: the mic prompt runs alongside the whole sequence and a denied mic emits a `warning`, never a failure. Timeouts appear in the last column.

<!-- nova-target: full-connect-sequence-table | Full connect sequence (state-machine order) -->

| # | Client does | Emits (→) / Waits (←) | Inbound event | Timeout |
|---|-------------|----------------------|---------------|---------|
| 0 | Init WebRTC session (TURN config) + start `getUserMedia(audio:true,video:false)` in the background | — | (browser mic prompt) | — (not awaited) |
| 1 | Open socket | ← | `onServerConnected` `{finalUrl, loadingVideoURL, agentName, hostName}` | 10s |
| 2 | Join room | → `join` (see payload below) | — | — |
| 3 | Wait config + join ack | ← `clientConfiguration`, ← `joinComplete` | both required | `clientConfiguration` 5s, `joinComplete` **20s** (both `JoinRoomTimeout`) |
| 4 | Create STV session | → `stvNewSession` `{room_id, cast_mode}` | — | — |
| 5 | Wait session | ← `stvNewSession` `{session_id, status, webrtc_url?}` (or ← `throwToNoAgent`) | sets `sessionId` + `webrtcUrl` | — |
| 6 | Wait agent | ← `showAgent` `{}` | agent joined | 10s |
| 7 | Wait ready | ← `askPermissions` `{constraints:{audio,video}}` | server ready | — |
| 8 | (optional) wait player-ready, 1s delay | — | — | — |
| 9 | Connect ASR (mic uplink), lane A, after 6→7 | `asr-webrtc-*` handshake (below) | — | 30s per wait |
| 10 | Subscribe STV video (WHEP) **and wait until it is *playable*, or give up waiting**, lane B, starts right after step 5 | → WHEP `POST` (no timeout of its own) → wait `<video>` `canplay` + ~300ms settle, or a 6s hard cap if `canplay` never fires | first decoded frame, or the 6s cap elapsing | 6s (hard cap; settles either way) |
| 11 | Approve (this starts the spoken greeting), once lanes A and B are both done | → `approvedPermissions` `{client, room}` | — | — |
| → | **CONNECTED** | listen for `agent_raw_text`, `generatingSpeech`, `stvStartedTalking` | — | — |
<!-- /nova-target -->

Overall connecting timeout: 30s. It bounds every wait in the table, including the two ASR waits and the WHEP answer: an event or WHEP answer that lands after the deadline rejects `connect()` with `ConnectTimeout`.

**Why step 3 has two timeouts, not one.** The server emits `clientConfiguration` immediately on join. It emits `joinComplete` only after an awaited context-update call, which can take more than 5s under load. The SDK budgets the two waits separately: `clientConfiguration` gets 5s, `joinComplete` gets 20s. See [wire-protocol/connection-basics.md §3](../wire-protocol/connection-basics.md#3-connect-sequence-state-machine-order) for the full rationale. Conflating them into one 5s budget causes spurious `JoinRoomTimeout` failures on loaded rooms.

This 30s deadline is set once, at the start of `connect()`. It keeps running through every step below, including the capacity queue, and is **not** paused or extended when the queue activates. If the account is queued (`throwToNoAgent` / `availabilityResult{available:false}`) and no slot frees up before the 30s runs out, `connect()` rejects with `ConnectTimeout`. To wait longer than that for a slot, call `waitForCapacity({maxWaitMs, pollIntervalMs})` **before** `connect()`. This is a separate, opt-in poll with its own bound: `maxWaitMs` defaults to 300000ms. See [Capacity & the queue](../architecture-reference/scale-and-sticky-sessions.md#capacity--the-queue-throwtonoagent--throwtoexceededtier).

> **Ordering matters: `approvedPermissions` triggers the opening line.** Subscribe to the STV video and wait until it is actually *decoding frames* before emitting `approvedPermissions`. That means `<video>` fires `canplay`, `readyState` reaches at least `HAVE_FUTURE_DATA`, and a short jitter-buffer settle finishes. ICE `connected` fires about 2s before the first frame decodes. Approving on ICE alone means the first 1-2s of the greeting is spoken before the user can see or hear it, so it gets clipped. This wait is not unconditional: if `canplay` never fires (for example, a stalled or dropped video track), a 6s hard cap settles anyway, and approval proceeds without a decoded frame instead of hanging forever. The platform's built-in client gates approval on **both** mic-ready and video-ready. The SDK reproduces this in `src/experience/session.js` (`_approve`), gated on the same canplay/`HAVE_FUTURE_DATA` settle logic, with the same 6s fallback. Running the WHEP subscribe in parallel with the ASR handshake does not change this gate: approval still waits for both lanes. The opening line itself cannot be interrupted, and typed text during it is held (`speak()`) until its `stvFinishedTalking`. For the fastest interruptible start, give the avatar a silent opening phrase (`SILENT_OPENING`) and let the session's `kickoff` option send the first turn on that same event. See [START-THE-CONVERSATION.md](../START-THE-CONVERSATION.md).

---

## The `join` payload (step 2): carries the agent/brain config

```js
socket.emit('join', {
  client: clientId,            // optional
  room: roomId,                // a client-generated room id (also sent as 'channel')
  channel: roomId,
  kaltura: {
    entryId: <entryId>,            // only if context is a media entry
    contextId: <contextId>,        // category/entry the KB is scoped to
    contextType: <contextType>,    // the type of contextId (e.g. 'entry' vs 'category')
    threadId: <existingThreadId>,  // to resume a conversation thread
    force_experience: 'avatar_only',
    capabilities: {                // brain capabilities, same enum as intellect config
      avatar: 'on',
      generate_followup_questions: 'on',
      use_knowledge_base: 'off',   // forced off when an entryId is set
      // use_content_search, include_sources, etc.
    }
  },
  userAgent, userAgentHints, isMobile,
  channel_password: null, peer_name: 'unknown',
  peer_video: false, peer_audio: true
});
```

- **Which intellect loads.** The `geniegpcid:<configId>` in the KS tells the server which intellect (brain) to load.
- **Which `join` fields the server actually reads.** Of the `kaltura` sub-fields the client sends in `join`, the session server consumes `ks`, `entryId`, `threadId`, `contextId`, `contextType`, `capabilities`, and `request_vars` when present.
- **`force_experience` is hardcoded server-side, not read from the client.** The server ignores the `force_experience` value the client sends. It always fixes `force_experience: 'avatar_only'` and `model_type: 'fast'` on every converse call. So the avatar runtime never requests `flashcards` or `summarization` experiences, no matter what the client sends.
- **`capabilities` and `request_vars` are genuinely client-controlled.** By contrast, these two are read at `join` time. They can also be updated mid-session via the `updateGenieContext` socket event. The server merges them over defaults, with no allowlist, before forwarding them to the brain.
- **The live socket carries the same brain protocol as the HTTP API.** The socket exchanges JSON frames `{event:'init'|'converse'|'abort', data:{…}}` and streams `agent_raw_text` back. This is the same envelope as HTTP `/assistant/converse`, documented in [API-REFERENCE.md](../../API-REFERENCE.md). Headless or text-only integrations use that HTTP path; the live avatar runtime uses the socket instead.

## Related docs

| Doc | Covers |
|---|---|
| [channels.md](channels.md) | ASR uplink + STV downlink |
| [conversation-flow.md](conversation-flow.md) | What streams while connected, sending user input, the message catalog |
| [../ARCHITECTURE-REFERENCE.md](../ARCHITECTURE-REFERENCE.md) | Back to the index |
