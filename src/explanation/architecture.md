---
layout: base.njk
title: "Platform Architecture"
description: "Explains how the Agentic Avatar System's backend services, text-conversation flow, and live-video runtime protocol fit together end to end, and how the system scales and handles failure."
eyebrow: Explanation
---

# Platform Architecture — Agentic Avatar System

For **platform developers**: how the whole system works end to end — the backend services, the text-conversation flow, the live-video runtime wire protocol, how it scales, and how it handles failure. Enough detail to reimplement any layer with **zero dependency** on Kaltura's apps, widgets, or libraries (just a Socket.IO client + standard WebRTC).

**Source of truth.** Reverse-engineered and verified against the running system: the avatar management backend (management plane — organized internally into agent / avatar / catalog / intellect / application modules), the Genie brain backend (organized internally into assistant / thread / message / feedback / followup / intellect / knowledge modules), the avatar runtime client (the browser-side connection state machine + XState connect machine), the WebRTC avatar engine (the client-side session object driving the ASR/STV peer connections), the scripted-video control service (the scripted-video control API at `/v1/avatar-session/*`), and the avatar infrastructure module. Symbol names below are the stable contracts to navigate by; exact details live in [Wire Protocol](/reference/wire-protocol/).

**Companion docs.** New here? [Getting Started](/getting-started/). Building an app? [API Reference](/reference/api-reference/). Driving your UI from the avatar? [Client-Side Commands](/guides/client-commands/). This page is the map — the exact field-by-field mechanics (connect sequence, ASR/STV wire shapes, scaling internals, SDK module routing, failure-mode tables) live in **[Architecture Reference](/reference/architecture-reference/)**; a from-scratch reimplementation recipe lives in **[Architecture Recipe](/guides/architecture-recipe/)**.

**Contents**

- [The three planes](#the-three-planes)
- [Backend services map](#backend-services-map)
- [Text conversation flow](#text-conversation-flow)
- [Video runtime protocol — the big picture](#video-runtime-protocol--the-big-picture)
- [Two runtime SDK paths (choose the right one)](#two-runtime-sdk-paths-choose-the-right-one)
- [SDK module map — overview](#sdk-module-map--overview)
- [Resilience & failure handling — overview](#resilience--failure-handling--overview)

---

## The three planes

The system is three planes. An app uses only the planes it needs.

| Plane | What it does | Backend host | Where documented |
|-------|-------------|-------------|------------------|
| **Management** | Create/configure agents, avatars, intellects, catalog, sessions | `api.avatar.us.kaltura.ai` | [API Reference](/reference/api-reference/) |
| **Conversation (text)** | The AI brain — chat, memory, structured output | `genie.nvp1.ovp.kaltura.com` | "Text Conversation Flow" below |
| **Runtime (video)** | Live photorealistic talking avatar over WebRTC | conversation-manager + SRS + brain | "Video Runtime Protocol" below |

---

## Backend services map

| Service | Public host | Responsibility |
|---|---|---|
| avatar management backend | `api.avatar.us.kaltura.ai/v1` | Agents, avatars, catalog (incl. ElevenLabs voice cloning), `studio-intellect` proxy, `application/*` utilities. Organized internally into agent/avatar/catalog/intellect/application modules; routes follow a `<prefix>/<action>` convention (e.g. catalog prefix is `catalog-item`). |
| scripted-video control service | `api.avatar.us.kaltura.ai/v1/avatar-session/*` (nginx-proxied) | The **scripted-video** control API: `avatar-session/create` (KS) → `init-client` → `keep-alive` (10s) → `end`. Served by the scripted-video control service, NOT the avatar management backend — only the host/path prefix is shared via proxy. |
| Genie brain backend | `genie.nvp1.ovp.kaltura.com` | The brain: `assistant/converse`, intellect CRUD, threads, messages, feedback, followups |
| conversation-manager | `conversation.avatar.us.kaltura.ai` | Live-avatar control plane (Socket.IO): session orchestration, ASR signaling relay, brain output stream |
| STV + media server | `srs.avatar.us.kaltura.ai` (egress host) | Video origin. The **STV controller** renders the talking face and pushes it via **RTMP into OvenMediaEngine (OME)**; clients always receive it via **WHEP** (never RTMP). Two egress modes via `cast_mode`: **SRS WHEP** (wire `cast_mode:'rtmp'`, the working default) → `{srsBaseUrl}/rtc/v1/whep/?app=app&stream={session_id}`; **STV-direct** (wire `cast_mode:'webrtc'`) → the STV server's own `/whep/session/{session_id}` (fails when `encryptAddress` is not configured server-side — leaks a private IP; the default SRS path is unaffected). Played with **OvenPlayer**. |
| TURN | `turn.avatar.us.kaltura.ai` | WebRTC relay for both media legs (default username/credential in `wire.js`'s `turnServers()`, overridable via `creds`). Addressed with explicit ports+transports (see [Architecture Reference](/reference/architecture-reference/#endpoints--credentials)). STV uses `iceTransportPolicy:'relay'`; ASR's policy is client-dependent but **relays via TURN either way** (the ASR server only advertises a private candidate). See [Wire Protocol §5](/reference/wire-protocol/) for the per-client matrix. |
| ML services | internal | Machine-learning services behind `application/generateAgentProfile` |

---

## Text conversation flow

The simplest intelligent path — no video, fully headless. Client → `POST https://genie.nvp1.ovp.kaltura.com/assistant/converse` with a `geniegpcid:<configId>` KS. The response is an NDJSON (or SSE) stream of segments; the brain runs server-side. Segment `type` values and parsing rules are identical to the avatar's `agent_raw_text` stream (see [Architecture Reference's "Conversation Phase"](/reference/architecture-reference/#conversation-phase--what-streams-while-connected)). Full endpoint details: [API Reference](/reference/api-reference/).

---

## Video runtime protocol — the big picture

The live talking avatar — the full bidirectional protocol.

A full interactive agentic avatar is **three concurrent channels** over one Socket.IO connection plus two WebRTC peer connections:

```
                          ┌───────────────────────────────────────────────┐
                          │   conversation.avatar.us.kaltura.ai           │
                          │   (Socket.IO control plane + agent brain)     │
   ┌──────────┐  socket   │                                               │
   │          │◄─────────►│  • handshake / join / session                 │
   │  YOUR    │           │  • agent_raw_text  (brain output, NDJSON)     │
   │  BROWSER │           │  • stvStartedTalking / stvFinishedTalking     │
   │  CLIENT  │           │  • ASR WebRTC signaling relay                 │
   │          │           └───────────────────────────────────────────────┘
   │          │  WebRTC (ASR, mic→server)   via socket-relayed SDP/ICE
   │          │═════════════════════════════════════════►  speech-to-text + brain
   │          │
   │          │  WebRTC (STV, server→video) via SRS WHEP (HTTP SDP)
   │  <video> │◄═════════════════════════════════════════  srs.avatar.us.kaltura.ai
   └──────────┘
```

- **Control plane** — one Socket.IO connection. Carries the handshake, the agent's streaming text, talking state, and ASR signaling.
- **ASR channel (uplink)** — a WebRTC peer connection that publishes your **microphone** to the server. SDP offer/answer + ICE are relayed **through the Socket.IO connection** (custom `asr-webrtc-*` events). The server runs speech-to-text → feeds the Genie brain.
- **STV channel (downlink)** — a WebRTC peer connection that receives the **avatar video+audio**. Uses standard **SRS WHEP** (plain-SDP-over-HTTP), independent of the socket.

The brain (Genie) runs entirely server-side. The client never calls an LLM — it publishes audio, receives video, and receives the brain's text as `agent_raw_text` deltas (identical format to the `/assistant/converse` NDJSON).

> For the exact connect sequence, wire shapes, endpoints, and scaling model, see **[Architecture Reference](/reference/architecture-reference/)**. For the **exhaustive** map — every socket event with its captured payload + repo source, the exact ICE/SDP/WHEP config, the parsed `agent_raw_text` delta types, and a turn-by-turn event trace — see **[Wire Protocol](/reference/wire-protocol/)** (built from a live capture, verified against the running system). This section is the orientation; those docs are the reference.

---

## Two runtime SDK paths (choose the right one)

There are two avatar runtimes. They are NOT interchangeable.

<div data-nova-target="two-runtime-sdk-paths-table" data-nova-label="Two Runtime SDK Paths comparison">

| | scripted-video control service client (`/v1/avatar-session`) | avatar runtime client (`conversation.avatar` socket) |
|---|---|---|
| Avatar video (STV/WHEP) | ✅ | ✅ |
| Mic / ASR uplink | ❌ | ✅ (`asr-webrtc-*`) |
| Genie brain | ❌ (you supply every line of text) | ✅ (server-side, streams `agent_raw_text`) |
| You call | `mgmt.avatarSessions.say()` (audio only — see below) | nothing — the user speaks, the brain answers |
| Use for | **scripted / puppet** avatars (you drive the words) | **interactive agentic** avatars (autonomous conversation) |

</div>

The protocol above describes the **interactive** path. The scripted path has no text-in of its own: the service's `say-text` route 503s on every call (a live server bug), so the SDK wraps only `say-audio` — you provide pre-rendered speech audio (e.g. from your own TTS call) and its duration. Full auth/lifecycle details: [API Reference § Scripted-video (STV-only) sessions](/reference/api-reference/#scripted-video-stv-only-sessions); runnable example: `examples/scripted-video-session.mjs` + `.html`.

---

## Displaying the avatar video

The SDK assigns the WHEP stream to `cfg.videoEl.srcObject` and does nothing else — no CSS, no sizing. The backend's rendered aspect ratio is not a published contract (see [API Reference § Upload a Custom Visual](/reference/api-reference/) on `catalog.createVisual` preprocessing), so size the box with `object-fit: cover` rather than assuming a fixed aspect ratio — it fills the box and crops evenly no matter what the stream's actual aspect ratio turns out to be:

```css
.avatar-box {
  width: 320px;
  aspect-ratio: 1 / 1;      /* pick whatever the fixed side of YOUR layout needs */
  overflow: hidden;
  border-radius: 12px;      /* optional */
}
.avatar-box video {
  width: 100%;
  height: 100%;
  object-fit: cover;        /* fills the box, crops evenly — no letterbox/pillarbox bars */
}
```

For a circular picture-in-picture mask, swap `border-radius` + `overflow: hidden` for `clip-path: circle(50%)` on `.avatar-box` (or directly on the `<video>`).

`object-fit: cover` never shows bars regardless of the source's actual aspect ratio — that's why it's the right default even without a published backend resolution to size against.

Omit `videoEl` entirely for a headless/custom-render integration (canvas, WebGL, a circular-mask renderer) — both `KalturaAvatarSession` and `KalturaScriptedVideoSession` fire a `'track'` event (`{track, streams}`) the moment their STV peer's `ontrack` fires, whether or not `videoEl` is configured.

For a dynamic crop/`object-position` instead of generic `object-fit: cover`, both classes also fire `'videoMetadata'` (`{videoWidth, videoHeight}`) once per connect, as soon as the decoder resolves the stream's actual dimensions. There's no fixed/published output resolution to hardcode against — this event is the source of truth.

### Compositing a transparent-background avatar (chroma key)

The rendered avatar stream is opaque — there's no alpha channel or published green/blue-screen backdrop to key against as a platform guarantee. If your layout needs the avatar composited over arbitrary page content (not a fixed rectangle), key it live with a bring-your-own `chroma-key-video`-shaped compositor via `./experience/chroma-key`'s `attachChromaKeyAvatar()`:

```js
import { KalturaAvatarSession } from '@kaltura/intelligent-agents/experience';
import { attachChromaKeyAvatar } from '@kaltura/intelligent-agents/experience/chroma-key';
// YOUR dependency, not the SDK's — there is no npm package for chroma-key-video; load it by
// bundling https://github.com/kaltura/chroma-key-video locally, or straight from jsDelivr's
// GitHub-CDN mode, pinned to a released tag:
import { ChromaKeyVideo } from 'https://cdn.jsdelivr.net/gh/kaltura/chroma-key-video@v1.2.0/src/chromakey.js';

const session = new KalturaAvatarSession({ token, …appInit, videoEl, socketFactory });
const player = attachChromaKeyAvatar({
  session, videoEl: session.videoEl, ChromaKeyVideo,
  options: { autoTune: true },
  container: document.getElementById('composited'),
});
await session.connect();
```

Same pattern as `object-fit: cover` above but one layer earlier: `attachChromaKeyAvatar()` constructs the injected `ChromaKeyVideo` class against the session's OWN video element (`session.videoEl`, not a second reference — verified, not assumed) and keeps its lifecycle in lockstep with the session's — `player.destroy()` fires automatically on the session's `'ended'` event, a fatal `'error'`, or the session's own `disconnect()`/`stop()` (its documented human-in-the-loop kill switch, e.g. a "leave call" button), so `session.disconnect()` alone is enough teardown. It never reimplements chroma-keying, matting, or WebGL context-loss recovery itself, and returns the constructed player instance UNWRAPPED — listen on `player` directly for its own events, never on `session`. Full behavior contract, misuse guard, and the `videoEl` source element are the SDK's zero-dependency rule in miniature: see [SDK Reference § Chroma-key Avatar Compositor](/reference/sdk-reference/#chroma-key-avatar-compositor).

---

## SDK module map — overview

For the public surface, entry points, and how-tos, read [SDK Reference](/reference/sdk-reference/) — its Management/Experience overview has the module-to-resource map.

Both SDK entry points share one core: `src/core/*` is the shared leaf layer both `./management` and `./experience` depend on (`http.js` transport, `errors.js`, `session.js`, `stream.js`, `redact.js`, `safety.js`, `ids.js`, `knowledge-enums.js`). Core never imports from `management/` or `experience/`. `./management` (`Management`, `src/management/client.js`) enforces the two-KS guard via `assertAdmin`/`assertConversation` before any network call; `./experience` (`KalturaAvatarSession`, `src/experience/session.js`) is the live socket+WHEP runtime from "Video Runtime Protocol" above, taking only a short-lived conversation token, with socket.io INJECTED, never bundled.

For the full module-by-module map (each management module's exposed surface and which backend door it writes to), the capabilities-resolution return shape, the GenUI rendering layer, and the partner-config-DTO-vs-intellect-DTO routing rule, see **[Architecture Reference's "SDK module map & data flow"](/reference/architecture-reference/#sdk-module-map--data-flow)**.

---

## Resilience & failure handling — overview

How the system behaves under network failures, disconnects, and device problems: **three reconnection tiers** — Socket.IO transport, the WebRTC media peers (ASR + STV), and this SDK's own avatar-session recovery — only loosely coordinated with each other. The SDK wires the WebRTC-peer tier to its own session-recovery tier (`_recoverMedia` → `_coldReconnect`); a custom client that skips `KalturaAvatarSession` must wire that itself.

For the full three-tier table, the headline risk in detail, the failure-mode matrix, device-permission handling, WebRTC media-peer reconnection detail, and the tool-call-spiral circuit breaker mechanism, see **[Architecture Reference's "Resilience & failure handling"](/reference/architecture-reference/#resilience--failure-handling)**.

---

## Related docs

| Doc | What it adds |
|-----|---------------|
| [Getting Started](/getting-started/) | First working agent in about five minutes |
| [API Reference](/reference/api-reference/) | Every management endpoint, with its SDK wrapper |
| [Architecture Reference](/reference/architecture-reference/) | The field-by-field mechanics behind every section above: connect sequence, wire shapes, scaling internals, SDK module routing, failure-mode tables |
| [Architecture Recipe](/guides/architecture-recipe/) | A from-scratch reimplementation recipe, for a client with zero Kaltura libraries |
| [Wire Protocol](/reference/wire-protocol/) | The exhaustive socket/WebRTC event catalog this page's protocol diagram summarizes |
| [Client-Side Commands](/guides/client-commands/) | Driving your own UI from the avatar, one layer above this page's runtime protocol |
