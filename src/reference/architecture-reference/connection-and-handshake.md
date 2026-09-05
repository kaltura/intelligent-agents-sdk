---
layout: base.njk
title: "Architecture Reference · Connection and Handshake"
description: "Endpoints & credentials, the Socket.IO connection, the full connect sequence, and the join payload."
eyebrow: Reference
---

# Connection and Handshake

[← Back to Architecture Reference](/reference/architecture-reference/)

**On this page:** [Endpoints & Credentials](#endpoints--credentials) · [Socket.IO Connection](#socketio-connection) · [Full Connect Sequence (state-machine order)](#full-connect-sequence-state-machine-order) · [The `join` payload (step 2) — this carries the agent/brain config](#the-join-payload-step-2--this-carries-the-agentbrain-config) · [Related docs](#related-docs)


## Endpoints & Credentials

| Thing | Value |
|---|---|
| Control socket | `wss://conversation.avatar.us.kaltura.ai` path `/socket.io` |
| STV WHEP base | `https://srs.avatar.us.kaltura.ai` |
| STV play URL | `{srsBaseUrl}/rtc/v1/play/?app=app&stream={session_id}` (or `webrtc_url` from `stvNewSession`) |
| STV WHEP signaling | `POST {srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id}` (body: plain SDP, `Content-Type: application/sdp`) |
| TURN | `turn.avatar.us.kaltura.ai` (default username/credential in `wire.js`'s `turnServers()`, overridable via `creds`). **Address it with explicit ports + transports.** A bare `turn:host` yields no relay candidate (→ `packetsSent=0`, the avatar can't hear you). Use all four: `turn:HOST:80?transport=udp`, `turn:HOST:443?transport=udp`, `turn:HOST:80?transport=tcp`, `turns:HOST:443?transport=tcp`. **`iceTransportPolicy` resolves as `forceRelay && !isFirefox ? 'relay' : 'all'`** per leg (in the built-in client's media layer). STV uses `'relay'` in every client. ASR is `'relay'` in the production runtime (`forceAsrRelay:true`) but `'all'` in the embed SDK / debug-app. The two are **functionally identical**, because the ASR server advertises only a private host candidate, so the pair relays through TURN regardless. Firefox forces `'all'` on both. So the TURN URLs are what must be correct, not the policy. Full per-client matrix: [Wire Protocol · Audio Channels §5](/reference/wire-protocol/audio-channels/#5-asr-uplink-pc1--microphone--server). |
| Auth | Socket.IO `auth: { token: <enrichedKS> }` + `query.partnerId` |

All of `conversationManagerUrl`, `srsBaseUrl`, `turnServerUrl`, and the enriched `ks` come from **`POST https://api.avatar.us.kaltura.ai/v1/application/appInit`** (see [API Reference](/reference/api-reference/)). The agent is identified by `partnerId` (from the KS) + the KS itself — NOT `clientId`/`flowId` (both optional and unused by Kaltura agents).

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

Exact order from the platform's built-in client's connection state machine. Each step waits for the named inbound event before advancing; timeouts in parens.

<div data-nova-target="full-connect-sequence-table" data-nova-label="Full connect sequence (state-machine order)">

| # | Client does | Emits (→) / Waits (←) | Inbound event | Timeout |
|---|-------------|----------------------|---------------|---------|
| 0 | Init WebRTC session (TURN config) + `getUserMedia(audio:true,video:false)` | — | (browser mic prompt) | — |
| 1 | Open socket | ← | `onServerConnected` `{finalUrl, loadingVideoURL, agentName, hostName}` | 10s |
| 2 | Join room | → `join` (see payload below) | — | — |
| 3 | Wait config + join ack | ← `clientConfiguration`, ← `joinComplete` | both required | `clientConfiguration` 5s, `joinComplete` **20s** (both `JoinRoomTimeout`) |
| 4 | Create STV session | → `stvNewSession` `{room_id, cast_mode}` | — | — |
| 5 | Wait session | ← `stvNewSession` `{session_id, status, webrtc_url?}` (or ← `throwToNoAgent`) | sets `sessionId` + `webrtcUrl` | — |
| 6 | Wait agent | ← `showAgent` `{}` | agent joined | 10s |
| 7 | Wait ready | ← `askPermissions` `{constraints:{audio,video}}` | server ready | — |
| 8 | (optional) wait player-ready, 1s delay | — | — | — |
| 9 | Connect ASR (mic uplink) | `asr-webrtc-*` handshake (below) | — | 30s |
| 10 | Subscribe STV video (WHEP) **and wait until it is *playable*, or give up waiting** | → WHEP `POST` (no timeout of its own) → wait `<video>` `canplay` + ~300ms settle, or a 6s hard cap if `canplay` never fires | first decoded frame, or the 6s cap elapsing | 6s (hard cap; settles either way) |
| 11 | Approve — this is what starts the spoken greeting | → `approvedPermissions` `{client, room}` | — | — |
| → | **CONNECTED** | listen for `agent_raw_text`, `generatingSpeech`, `stvStartedTalking` | — | — |

</div>

Overall connecting timeout: 30s.

**Why step 3 has two timeouts, not one:** the server emits `clientConfiguration` immediately on join, but emits `joinComplete` only after an awaited context-update call that can exceed 5s under load. The SDK budgets the two waits separately (`clientConfiguration` 5s, `joinComplete` 20s) — see [Wire Protocol · Connection Basics §3](/reference/wire-protocol/connection-basics/#3-connect-sequence-state-machine-order) for the full rationale. Conflating them into one 5s budget causes spurious `JoinRoomTimeout` failures on loaded rooms.

This 30s figure is separate from the capacity queue's own `maxWaitMs` budget — see [Capacity & the queue](/reference/architecture-reference/scale-and-sticky-sessions/#capacity--the-queue-throwtonoagent--throwtoexceededtier). The connect timeout is cancelled once the queue activates, so the two never add up.

> **Ordering matters — `approvedPermissions` triggers the opening line.** Subscribe to the STV video and wait until it is actually *decoding frames* (`<video>` `canplay`, readyState ≥ `HAVE_FUTURE_DATA`, plus a short jitter-buffer settle) **before** emitting `approvedPermissions`. ICE `connected` fires ~2s before the first frame decodes — approving on ICE alone means the first 1–2s of the greeting is spoken into a pipe the user can't see/hear yet and is clipped. This wait is not unconditional: if `canplay` never fires (a stalled or dropped video track), a 6s hard cap settles anyway and approval proceeds without a decoded frame, rather than hanging forever. The platform's built-in client gates approval on **both** mic-ready AND video-ready; the SDK reproduces this in `src/experience/session.js` (`_approve`, gated on the same canplay/`HAVE_FUTURE_DATA` settle logic, with the same 6s fallback).

---

## The `join` payload (step 2) — this carries the agent/brain config

```js
socket.emit('join', {
  client: clientId,            // optional
  room: roomId,                // a client-generated room id (also sent as 'channel')
  channel: roomId,
  kaltura: {
    entryId: <entryId>,            // only if context is a media entry
    context_id: <contextId>,       // category/entry the KB is scoped to
    threadId: <existingThreadId>,  // to resume a conversation thread
    force_experience: 'avatar_only',
    capabilities: {                // brain capabilities — same enum as intellect config
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
- **`force_experience` is hardcoded server-side, not read from the client.** `force_experience` alone is **not** read by the server; it is fixed server-side to `force_experience: 'avatar_only'` and `model_type: 'fast'` on every converse call — so the avatar runtime never requests `flashcards`/`summarization` experiences regardless of what the client sends.
- **`capabilities` and `request_vars` are genuinely client-controlled.** By contrast, these two are read at `join` time and can also be updated mid-session via the `updateGenieContext` socket event, then merged over defaults with no server-side allowlist before being forwarded to the brain.
- **The live socket carries the same brain protocol as the HTTP API.** The socket exchanges JSON frames `{event:'init'|'converse'|'abort', data:{…}}` and streams `agent_raw_text` back — the same envelope as HTTP `/assistant/converse`, documented in [API Reference](/reference/api-reference/), which is the path for headless/text integrations; the live avatar runtime uses the socket instead.

## Related docs

| Doc | Covers |
|---|---|
| [Architecture Reference · Channels](/reference/architecture-reference/channels/) | ASR uplink + STV downlink |
| [Architecture Reference · Conversation Flow](/reference/architecture-reference/conversation-flow/) | What streams while connected, sending user input, the message catalog |
| [Architecture Reference](/reference/architecture-reference/) | Back to the index |

