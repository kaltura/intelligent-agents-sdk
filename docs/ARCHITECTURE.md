# Platform Architecture: Agentic Avatar System

This page is the map for platform developers. It shows how the SDK reaches the agentic backend, end to end. It gives enough detail to reimplement any layer with only a Socket.IO client and standard WebRTC, with no dependency on Kaltura's apps, widgets or libraries.

The SDK works across four layers:

- the **management API**: agents, avatars, catalog, intellects (an agent's prompts, tools and knowledge), application
- the **conversation API**: conversations, threads, messages, feedback, followups
- the **live-avatar control plane**: the Socket.IO session plus the ASR/STV WebRTC media
- the **scripted-video control API**: `/v1/avatar-session/*`

Symbol names below are the stable contracts to navigate by. Exact details live in [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

| Need | Go to |
|---|---|
| First agent | [GETTING-STARTED.md](../GETTING-STARTED.md) |
| Build an app | [API-REFERENCE.md](../API-REFERENCE.md) |
| Drive your UI from the avatar | [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md) |
| Connect sequence, scaling, sticky routing, recovery, failure tables | [ARCHITECTURE-REFERENCE.md](ARCHITECTURE-REFERENCE.md) |
| Reimplementation recipe | [ARCHITECTURE-RECIPE.md](ARCHITECTURE-RECIPE.md) |
| Render the avatar video in your page | [README.md § Avatar audio and video rendering](../README.md#avatar-audio-and-video-rendering) |

**Contents**

- [The Three Planes](#the-three-planes)
- [Backend Services Map](#backend-services-map)
- [Text Conversation Flow](#text-conversation-flow)
- [Video Runtime Protocol: The Big Picture](#video-runtime-protocol-the-big-picture)
- [Two Session Modes (choose the right one)](#two-session-modes-choose-the-right-one)
- [SDK Entry Points](#sdk-entry-points)
- [Resilience & Failure Handling: Overview](#resilience--failure-handling-overview)

---

## The Three Planes

An app uses only the planes it needs.

| Plane | What it does | SDK option | Where documented |
|-------|-------------|-------------|------------------|
| **Management** | Create and configure agents, avatars, intellects, catalog, sessions | `agenticUrl` | [API-REFERENCE.md](../API-REFERENCE.md) |
| **Conversation (text)** | Chat, memory, structured output | `genieUrl` | "Text Conversation Flow" below |
| **Runtime (video)** | Live photorealistic talking avatar over WebRTC | `conversationManagerUrl`, `srsBaseUrl`, `turnServerUrl` | "Video Runtime Protocol" below |

A live conversation also runs three flows at once: conversation control, agent orchestration and your own expertise. See [Inside a Live Conversation](https://kaltura.github.io/intelligent-agents-sdk/explanation/inside-a-live-conversation/).

---

## Backend Services Map

The SDK talks to six endpoints. Each has an option that overrides it.

| Connection | SDK option | Value comes from | What the SDK uses it for |
|---|---|---|---|
| Management API | `agenticUrl` | `REGIONS[region]` or the option | Agents, avatars, catalog, `application/*` utilities, scripted-video sessions (`avatar-session/*`) |
| Conversation API | `genieUrl` | `REGIONS[region]` or the option | `assistant/converse`, intellect CRUD, threads, messages, feedback, followups. Also the direct POSTs a session sends itself: tool ACKs and the session-completed signal |
| Kaltura OVP | `ovpUrl` | `REGIONS[region]` or the option | Media-plane calls such as categories and entries. `Management` sends the admin secret here |
| Live-session socket | `conversationManagerUrl` | `appInit` | The Socket.IO control plane |
| Avatar video | `srsBaseUrl` | `appInit` | WHEP video. The SDK builds the WHEP URL from it when `stvNewSession` has no `webrtc_url`. See [audio-channels.md §6](wire-protocol/audio-channels.md#6-stv-downlink-pc2-avatar-videoaudio--you) |
| TURN | `turnServerUrl`, `turnCredentials` | `appInit` | WebRTC relay for both media legs. `turnCredentials` is `{username, credential, expiry?}`. See [audio-channels.md §5](wire-protocol/audio-channels.md#5-asr-uplink-pc1-microphone--server) |

The scripted-video control API (`avatar-session/*`) is a separate API from the management API, reached through `agenticUrl`. Details: [Scripted-Video Sessions](api/scripted-video.md).

`REGIONS[region]` and the explicit `*Url` options are described in [Regions and base URLs](api/authentication.md#regions-and-base-urls). The socket, video and TURN values always come from `appInit`.

The SDK checks every WHEP URL with `whepUrlHasPrivateIp()`. A URL that points at a private address makes `connect()` throw `whep_private_ip`, because a browser can't reach it.

---

## Text Conversation Flow

The simplest path: no video, fully headless. The client calls `POST {genieUrl}/assistant/converse` with a conversation token or an agent token ([token kinds](api/authentication.md)). The response is an NDJSON (or SSE) stream of segments. Segment `type` values and parsing rules are the same as the avatar's `agent_raw_text` stream (see the [events catalog](wire-protocol/events-catalog.md)). Endpoint details: [API-REFERENCE.md](../API-REFERENCE.md).

---

## Video Runtime Protocol: The Big Picture

The live talking avatar: the full bidirectional protocol.

A full interactive agentic avatar is **three concurrent channels** over one Socket.IO connection plus two WebRTC peer connections:

```
                          ┌───────────────────────────────────────────────┐
                          │   conversationManagerUrl                      │
                          │   (Socket.IO control plane)                   │
   ┌──────────┐  socket   │                                               │
   │          │◄─────────►│  • handshake / join / session                 │
   │  YOUR    │           │  • agent_raw_text  (agent output, NDJSON)     │
   │  BROWSER │           │  • stvStartedTalking / stvFinishedTalking     │
   │  CLIENT  │           │  • ASR WebRTC signaling relay                 │
   │          │           └───────────────────────────────────────────────┘
   │          │  WebRTC (ASR, mic→server)   via socket-relayed SDP/ICE
   │          │═════════════════════════════════════════►  speech-to-text
   │          │
   │          │  WebRTC (STV, server→video) via WHEP (HTTP SDP)
   │  <video> │◄═════════════════════════════════════════  avatar video (srsBaseUrl)
   └──────────┘
```

- **Control plane**: one Socket.IO connection. It carries the handshake, the agent's streaming text, talking state, and ASR signaling.
- **ASR channel (uplink)**: a WebRTC peer connection that publishes your **microphone**. SDP offer/answer and ICE are relayed **through the Socket.IO connection** (custom `asr-webrtc-*` events). Your speech comes back as the agent's reply.
- **STV channel (downlink)**: a WebRTC peer connection that receives the **avatar video and audio**. It uses standard **WHEP** (plain SDP over HTTP), independent of the socket.

The client never calls an LLM. It only publishes audio, receives video, and receives the agent's text as `agent_raw_text` deltas, in the same format as the `/assistant/converse` NDJSON.

> For the exact connect sequence, wire shapes, endpoints, and scaling model, see **[ARCHITECTURE-REFERENCE.md](ARCHITECTURE-REFERENCE.md)**.  
>  
> For the **exhaustive** map, see **[WIRE-PROTOCOL.md](WIRE-PROTOCOL.md)**. It covers every socket event with its payload shape, the exact ICE/SDP/WHEP config, the parsed `agent_raw_text` delta types, and a turn-by-turn event trace.  
>  
> This section is the orientation. Those docs are the reference.

---

## Two Session Modes (choose the right one)

There are two session modes, and they are NOT interchangeable. Scripted sessions render speech you author, line by line. Interactive sessions run all [three conversation flows](https://kaltura.github.io/intelligent-agents-sdk/explanation/inside-a-live-conversation/) for you: conversation control, agent orchestration, and your plugged-in expertise. **Interactive agentic** is the product experience. **Scripted (puppet)** is a narrow authoring tool.

<!-- nova-target: two-runtime-sdk-paths-table | Two session modes comparison -->

| | scripted-video client (`/v1/avatar-session`) | interactive avatar client (`conversationManagerUrl` socket) |
|---|---|---|
| Avatar video (STV/WHEP) | ✅ | ✅ |
| Mic / ASR uplink | ❌ | ✅ (`asr-webrtc-*`) |
| Agent | ❌ (you supply every line of text) | ✅ (streams `agent_raw_text`) |
| You call | `mgmt.avatarSessions.say()` (audio only, see below) | nothing: the user speaks, the agent answers |
| Use for | **scripted / puppet** avatars (you drive the words) | **interactive agentic** avatars (autonomous conversation) |
<!-- /nova-target -->

The protocol above describes the **interactive** path. The scripted path has no text-in of its own: the SDK wraps only `say-audio`. You provide pre-rendered speech audio (for example, from your own TTS call) and its duration. Full auth/lifecycle details: [Scripted-Video sessions](api/scripted-video.md).

Agents with no avatar run in audio/phone mode, which this SDK does not support end to end. See [audio-channels.md §5b](wire-protocol/audio-channels.md#5b-audio-mode-webrtc-separate-from-the-asr-uplink).

---

## SDK Entry Points

| Entry point | Class | Runs in | Token it takes |
|---|---|---|---|
| `./management` | `Management` | Server | The admin secret. It mints the tokens below. |
| `./experience` | `KalturaAvatarSession` | Browser | A short-lived, non-admin conversation KS from `application.appInit` |

`Management` checks the token kind before any network call whenever the kind is known client-side. A minted `Token` records its kind (`admin`, `conversation`, `agent`, `widget`). A raw encrypted KS string can't be inspected, so `Management` sends the call without that check. `KalturaAvatarSession` is the live socket and WHEP runtime described in "Video Runtime Protocol" above. Socket.IO is injected into it, never bundled. Entry points, modules and how-tos: [README.md § Architecture](../README.md#architecture).

---

## Resilience & Failure Handling: Overview

How the system behaves under network failures, disconnects, and device problems. `KalturaAvatarSession` recovers in three layers: the control socket (Socket.IO reconnect, then a cold reconnect if state was lost), the WebRTC media peers (ICE restart for ASR, WHEP re-subscribe for STV), and a cold reconnect of the whole session as the last step (two attempts). A health watchdog catches peers that die without an ICE event, and closing the tab releases the server side. A custom client that skips `KalturaAvatarSession` must implement these itself.

Recovery layers, the failure-mode matrix, device-permission handling and the tool-call spiral breaker: **[Resilience & Failure Handling](architecture-reference/resilience-and-failure-handling.md#resilience--failure-handling)**.

A conversation ending cleanly is a separate concern from recovering from failure. On tab-close, backgrounding, bfcache freeze, or an explicit `disconnect()`, the SDK sends `POST /thread/session_completed` to mark the thread as over.

App-facing config and the trigger table: [README.md § Ending a conversation cleanly](../README.md#ending-a-conversation-cleanly-session_completed-signal).
