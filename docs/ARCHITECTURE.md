# Platform Architecture — Agentic Avatar System

For **platform developers**: how the whole system works end to end — the backend services, the text-conversation flow, the live-video runtime wire protocol, how it scales, and how it handles failure. Enough detail to reimplement any layer with **zero dependency** on Kaltura's apps, widgets, or libraries (just a Socket.IO client + standard WebRTC).

**Source of truth.** This describes the protocol as the live system implements it: the management API (agents/avatars/catalog/intellects/application), the brain API (conversations, threads, messages, feedback, followups), the live-avatar control plane (the Socket.IO session plus the ASR/STV WebRTC media), and the scripted-video control API (`/v1/avatar-session/*`). Symbol names below are the stable contracts to navigate by; exact details live in [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

**Companion docs.** New here? [GETTING-STARTED.md](../GETTING-STARTED.md). Building an app? [API-REFERENCE.md](../API-REFERENCE.md). Driving your UI from the avatar? [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md). This page is the map — the exact field-by-field mechanics (connect sequence, ASR/STV wire shapes, scaling internals, SDK module routing, failure-mode tables) live in **[ARCHITECTURE-REFERENCE.md](ARCHITECTURE-REFERENCE.md)**; a from-scratch reimplementation recipe lives in **[ARCHITECTURE-RECIPE.md](ARCHITECTURE-RECIPE.md)**.

**Contents**

- [The Three Planes](#the-three-planes)
- [Backend Services Map](#backend-services-map)
- [Text Conversation Flow](#text-conversation-flow)
- [Video Runtime Protocol — The Big Picture](#video-runtime-protocol--the-big-picture)
- [Two Session Modes (choose the right one)](#two-session-modes-choose-the-right-one)
- [SDK Module Map — Overview](#sdk-module-map--overview)
- [Resilience & Failure Handling — Overview](#resilience--failure-handling--overview)

---

## The Three Planes

The system is three planes. An app uses only the planes it needs.

| Plane | What it does | Backend host | Where documented |
|-------|-------------|-------------|------------------|
| **Management** | Create/configure agents, avatars, intellects, catalog, sessions | `api.avatar.us.kaltura.ai` | [API-REFERENCE.md](../API-REFERENCE.md) |
| **Conversation (text)** | The AI brain — chat, memory, structured output | `genie.nvp1.ovp.kaltura.com` | "Text Conversation Flow" below |
| **Runtime (video)** | Live photorealistic talking avatar over WebRTC | the session server + media relay + brain | "Video Runtime Protocol" below |

### The three flows in every live conversation

The planes above describe *infrastructure*. A live conversation itself runs **three flows** at once:

1. **Conversation Control** — turn-taking, interruptions, real-time sync of speech recognition, voice, avatar video, and language models, emotion, recording, device coverage. Kaltura, always.
2. **Agent Orchestration** — the server-side reasoning loop while the person talks: knowledge grounding (RAG), tool calls, routing to expert agents. Kaltura, always.
3. **Your Expertise** — your knowledge bases, APIs, models, and expert agents, plugged into flow 2.

Full explanation and plug points: [Inside a Live Conversation](https://kaltura.github.io/intelligent-agents-sdk/explanation/inside-a-live-conversation/).

---

## Backend Services Map

| Service | Public host | Responsibility |
|---|---|---|
| management API | `api.avatar.us.kaltura.ai/v1` | Agents, avatars, catalog (incl. ElevenLabs voice cloning), `application/*` utilities. Routes follow a `<prefix>/<action>` convention (e.g. catalog prefix is `catalog-item`). |
| scripted-video control API | `api.avatar.us.kaltura.ai/v1/avatar-session/*` | The **scripted-video** control API: `avatar-session/create` (KS) → `init-client` → `keep-alive` (10s) → `end`. A distinct service from the management API — only the host/path prefix is shared. |
| brain API | `genie.nvp1.ovp.kaltura.com` | The brain: `assistant/converse`, intellect CRUD, threads, messages, feedback, followups |
| session server | `conversation.avatar.us.kaltura.ai` | Live-avatar control plane (Socket.IO): session orchestration, ASR signaling relay, brain output stream |
| STV + media relay | `srs.avatar.us.kaltura.ai` (egress host) | Video origin. Renders the talking face and egresses it to clients via **WHEP** (never RTMP, regardless of internal transport). The `cast_mode` field selects the egress; the SDK never sends it, so it always takes the server's fully-omitted-default path, verified working with real video (see [WIRE-PROTOCOL.md §6](WIRE-PROTOCOL.md)). Explicit `cast_mode:'webrtc'` (the runtime client only, never this SDK) has resolved to a private IP in this deployment — the SDK's `whepUrlHasPrivateIp()` guard exists for that case. |
| TURN | `turn.avatar.us.kaltura.ai` | WebRTC relay for both media legs (default username/credential in `wire.js`'s `turnServers()`, overridable via `creds`). Addressed with explicit ports+transports (see [ARCHITECTURE-REFERENCE.md](ARCHITECTURE-REFERENCE.md#endpoints--credentials)). STV uses `iceTransportPolicy:'relay'`; ASR's policy is client-dependent but **relays via TURN either way** (the ASR server only advertises a private candidate). See [WIRE-PROTOCOL.md §5](WIRE-PROTOCOL.md) for the per-client matrix. |
| ML services | internal | Machine-learning services behind `application/generateAgentProfile` |

---

## Text Conversation Flow

The simplest intelligent path — no video, fully headless. Client → `POST https://genie.nvp1.ovp.kaltura.com/assistant/converse` with a `geniegpcid:<configId>` KS. The response is an NDJSON (or SSE) stream of segments; the brain runs server-side. Segment `type` values and parsing rules are identical to the avatar's `agent_raw_text` stream (see [ARCHITECTURE-REFERENCE.md's "Conversation Phase"](ARCHITECTURE-REFERENCE.md#conversation-phase--what-streams-while-connected)). Full endpoint details: [API-REFERENCE.md](../API-REFERENCE.md).

---

## Video Runtime Protocol — The Big Picture

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
   │          │  WebRTC (STV, server→video) via WHEP (HTTP SDP)
   │  <video> │◄═════════════════════════════════════════  srs.avatar.us.kaltura.ai
   └──────────┘
```

- **Control plane** — one Socket.IO connection. Carries the handshake, the agent's streaming text, talking state, and ASR signaling.
- **ASR channel (uplink)** — a WebRTC peer connection that publishes your **microphone** to the server. SDP offer/answer + ICE are relayed **through the Socket.IO connection** (custom `asr-webrtc-*` events). The server runs speech-to-text → feeds the brain.
- **STV channel (downlink)** — a WebRTC peer connection that receives the **avatar video+audio**. Uses standard **WHEP** (plain-SDP-over-HTTP), independent of the socket.

The brain runs entirely server-side. The client never calls an LLM — it publishes audio, receives video, and receives the brain's text as `agent_raw_text` deltas (identical format to the `/assistant/converse` NDJSON).

> For the exact connect sequence, wire shapes, endpoints, and scaling model, see **[ARCHITECTURE-REFERENCE.md](ARCHITECTURE-REFERENCE.md)**. For the **exhaustive** map — every socket event with its payload shape, the exact ICE/SDP/WHEP config, the parsed `agent_raw_text` delta types, and a turn-by-turn event trace — see **[WIRE-PROTOCOL.md](WIRE-PROTOCOL.md)**. This section is the orientation; those docs are the reference.

---

## Two Session Modes (choose the right one)

There are two session modes, and they are NOT interchangeable. Scripted sessions render speech you author, line by line. Interactive sessions run all [three conversation flows](https://kaltura.github.io/intelligent-agents-sdk/explanation/inside-a-live-conversation/) for you: conversation control, agent orchestration, and your plugged-in expertise. **Interactive agentic** is the product experience; **scripted (puppet)** is a narrow authoring tool.

| | scripted-video client (`/v1/avatar-session`) | interactive avatar client (`conversation.avatar` socket) |
|---|---|---|
| Avatar video (STV/WHEP) | ✅ | ✅ |
| Mic / ASR uplink | ❌ | ✅ (`asr-webrtc-*`) |
| Brain | ❌ (you supply every line of text) | ✅ (server-side, streams `agent_raw_text`) |
| You call | `mgmt.avatarSessions.say()` (audio only — see below) | nothing — the user speaks, the brain answers |
| Use for | **scripted / puppet** avatars (you drive the words) | **interactive agentic** avatars (autonomous conversation) |

The protocol above describes the **interactive** path. The scripted path has no text-in of its own: the service's `say-text` route 503s on every call (a live server bug), so the SDK wraps only `say-audio` — you provide pre-rendered speech audio (e.g. from your own TTS call) and its duration. Full auth/lifecycle details: [API-REFERENCE.md § Scripted-Video (STV-only) Sessions](api/scripted-video.md); runnable example: `examples/scripted-video-session.mjs` + `.html`.

### Audio-mode / phone-mode agents (partial support)

An agent with no avatar attached (create it with `avatarIds` omitted) is treated server-side as audio/phone-mode: `stvNewSession` replies with a "no STV session" status instead of a video session, and the `clientConfiguration` the server sends carries `audioMode`/`phoneMode` flags (see [WIRE-PROTOCOL.md §7](WIRE-PROTOCOL.md)). `KalturaAvatarSession` detects this and sets `session.mode = 'audio'`, skipping the STV video pipeline entirely.

**This SDK does not implement the audio-mode WebRTC downlink** ([WIRE-PROTOCOL.md §5b](WIRE-PROTOCOL.md)) that carries the agent's spoken audio when there's no STV session — that peer connection is signaled over a separate event family (`webrtc-create-offer`/`webrtc-offer`/`webrtc-answer`) the SDK never emits or listens for. So today, `mode:'audio'` is detected but not functional end-to-end: the mic uplink (ASR) still connects, but you won't receive the agent's spoken reply through this SDK. Treat audio/phone-mode as INFERRED wire behavior, not a supported feature, until the downlink is implemented.

---

## Displaying the Avatar Video

The SDK assigns the WHEP stream to `cfg.videoEl.srcObject` and does nothing else — no CSS, no sizing. The backend's rendered aspect ratio is not a published contract (see [Upload a Custom Visual](api/design.md#upload-a-custom-visual-portrait--animated-avatar) on `catalog.createVisual` preprocessing), so size the box with `object-fit: cover` rather than assuming a fixed aspect ratio — it fills the box and crops evenly no matter what the stream's actual aspect ratio turns out to be:

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

Same pattern as `object-fit: cover` above but one layer earlier: `attachChromaKeyAvatar()` constructs the injected `ChromaKeyVideo` class against the session's OWN video element (`session.videoEl`, not a second reference). It keeps its lifecycle in lockstep with the session's: `player.destroy()` fires automatically on the session's `'ended'` event, a fatal `'error'`, or the session's own `disconnect()`/`stop()` (its documented human-in-the-loop kill switch, e.g. a "leave call" button), so `session.disconnect()` alone is enough teardown. It never reimplements chroma-keying, matting, or WebGL context-loss recovery itself, and returns the constructed player instance UNWRAPPED. Listen on `player` directly for its own events, never on `session`. Full behavior contract, misuse guard, and the `videoEl` source element are the SDK's zero-dependency rule in miniature: see [README.md § `./experience/chroma-key`](../README.md#experiencechroma-key).

---

## SDK Module Map — Overview

For the public surface, entry points, and how-tos, read [README.md](../README.md) — its ["Architecture" section](../README.md#architecture) has the module-to-resource map.

Both SDK entry points share one core: `src/core/*` is the shared leaf layer both `./management` and `./experience` depend on (`http.js` transport, `errors.js`, `session.js`, `stream.js`, `redact.js`, `safety.js`, `ids.js`, `knowledge-enums.js`). Core never imports from `management/` or `experience/`. `./management` (`Management`, `src/management/client.js`) enforces the two-KS guard via `assertAdmin`/`assertConversation` before any network call; `./experience` (`KalturaAvatarSession`, `src/experience/session.js`) is the live socket+WHEP runtime from "Video Runtime Protocol" above, taking only a short-lived conversation token, with socket.io INJECTED, never bundled.

For the full module-by-module map (each management module's exposed surface and which backend door it writes to), the capabilities-resolution return shape, and the GenUI rendering layer, see **[ARCHITECTURE-REFERENCE.md's "SDK Module Map & Data Flow"](ARCHITECTURE-REFERENCE.md#sdk-module-map--data-flow)**.

---

## Resilience & Failure Handling — Overview

How the system behaves under network failures, disconnects, and device problems: **three reconnection tiers** — Socket.IO transport, the WebRTC media peers (ASR + STV), and this SDK's own avatar-session recovery — only loosely coordinated with each other. The SDK wires the WebRTC-peer tier to its own session-recovery tier (`_recoverMedia` → `_coldReconnect`); a custom client that skips `KalturaAvatarSession` must wire that itself.

For the full three-tier table, the headline risk in detail, the failure-mode matrix, device-permission handling, and the tool-call-spiral circuit breaker mechanism, see **[ARCHITECTURE-REFERENCE.md's "Resilience & Failure Handling"](ARCHITECTURE-REFERENCE.md#resilience--failure-handling)**.

A conversation ending cleanly is a separate concern from recovering from failure: on tab-close, backgrounding, bfcache freeze, or an explicit `disconnect()`, the SDK tells the backend the thread is genuinely over (`POST /thread/session_completed`) instead of waiting for the ~10-minute idle scanner, so end-of-conversation lifecycle rules fire in seconds. See [ARCHITECTURE-REFERENCE.md's "Session-completion signal"](ARCHITECTURE-REFERENCE.md#session-completion-signal-session_completed--telling-the-backend-a-conversation-is-truly-over) for the condensed decision table, and [README.md § Ending a conversation cleanly](../README.md#ending-a-conversation-cleanly-session_completed-signal) for the app-facing config surface.
