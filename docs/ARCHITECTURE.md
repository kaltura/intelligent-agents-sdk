# Platform Architecture — Agentic Avatar System

This page is for **platform developers**. It explains how the whole system works end to end:

- the backend services
- the text-conversation flow
- the live-video wire protocol
- how it scales
- how it handles failures

It gives enough detail to reimplement any layer with **zero dependency** on Kaltura's apps, widgets, or libraries. All you need is a Socket.IO client and standard WebRTC.

**Source of truth.** This page describes the protocol as the live system implements it, across four layers:

- the **management API**: agents, avatars, catalog, intellects (an agent's brain — its prompts, tools, and knowledge), application
- the **brain API**: conversations, threads, messages, feedback, followups
- the **live-avatar control plane**: the Socket.IO session plus the ASR/STV WebRTC media
- the **scripted-video control API**: `/v1/avatar-session/*`

Symbol names below are the stable contracts to navigate by. Exact details live in [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

**Companion docs.**

- New here? [GETTING-STARTED.md](../GETTING-STARTED.md)
- Building an app? [API-REFERENCE.md](../API-REFERENCE.md)
- Driving your UI from the avatar? [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md)

This page is the map. The exact field-by-field mechanics (connect sequence, ASR/STV wire shapes, scaling internals, SDK module routing, failure-mode tables) live in **[ARCHITECTURE-REFERENCE.md](ARCHITECTURE-REFERENCE.md)**. A from-scratch reimplementation recipe lives in **[ARCHITECTURE-RECIPE.md](ARCHITECTURE-RECIPE.md)**.

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
| **Conversation (text)** | The AI brain: chat, memory, structured output | `genie.nvp1.ovp.kaltura.com` | "Text Conversation Flow" below |
| **Runtime (video)** | Live photorealistic talking avatar over WebRTC | the session server + media relay + brain | "Video Runtime Protocol" below |

### The three flows in every live conversation

The planes above describe *infrastructure*. A live conversation itself runs **three flows** at once:

1. **Conversation Control**: turn-taking, interruptions, and real-time sync between speech recognition, voice, avatar video, language models, emotion, recording, and device coverage. Handled by Kaltura, always.
2. **Agent Orchestration**: the server-side reasoning loop that runs while the person talks. It covers knowledge grounding (RAG — pulling relevant facts from your knowledge base before answering), tool calls, and routing to expert agents. Handled by Kaltura, always.
3. **Your Expertise**: your knowledge bases, APIs, models, and expert agents. You plug these into flow 2 (Agent Orchestration).

Full explanation and plug points: [Inside a Live Conversation](https://kaltura.github.io/intelligent-agents-sdk/explanation/inside-a-live-conversation/).

---

## Backend Services Map

| Service | Public host | Responsibility |
|---|---|---|
| management API | `api.avatar.us.kaltura.ai/v1` | Agents, avatars, catalog (incl. ElevenLabs voice cloning), `application/*` utilities. Routes follow a `<prefix>/<action>` convention (e.g. catalog prefix is `catalog-item`). |
| scripted-video control API | `api.avatar.us.kaltura.ai/v1/avatar-session/*` | The **scripted-video** control API: `avatar-session/create` (KS) → `init-client` → `keep-alive` (10s) → `end`. A distinct service from the management API. Only the host/path prefix is shared. |
| brain API | `genie.nvp1.ovp.kaltura.com` | The brain: `assistant/converse`, intellect CRUD, threads, messages, feedback, followups |
| session server | `conversation.avatar.us.kaltura.ai` | Live-avatar control plane (Socket.IO): session orchestration, ASR signaling relay, brain output stream |
| STV + media relay | the egress host in `appInit`'s `srsBaseUrl` | Video origin. Renders the talking face and sends it to clients over **WHEP**, never RTMP, regardless of internal transport. The `cast_mode` field selects the egress method. The SDK never sends this field, so it always takes the server's default path, verified working with real video (see [wire-protocol/audio-channels.md §6](wire-protocol/audio-channels.md#6-stv-downlink-pc2--avatar-videoaudio--you)). A different setting, explicit `cast_mode:'webrtc'` (used by the runtime client, never this SDK), has resolved to a private IP in this deployment. The SDK's `whepUrlHasPrivateIp()` guard exists to catch that case. |
| TURN | `turn.avatar.us.kaltura.ai` | WebRTC relay for both media legs (default username/credential in `wire.js`'s `turnServers()`, overridable via `creds`). Addressed with explicit ports+transports (see [ARCHITECTURE-REFERENCE.md](architecture-reference/connection-and-handshake.md#endpoints--credentials)). STV uses `iceTransportPolicy:'relay'` (Firefox is the one exception: `'all'`). ASR's policy is client-dependent, but it **relays via TURN either way**, because the ASR server only advertises a private candidate. See [wire-protocol/audio-channels.md §5](wire-protocol/audio-channels.md#5-asr-uplink-pc1--microphone--server) for the per-client matrix. |
| ML services | internal | Machine-learning services behind `application/generateAgentProfile` |

---

## Text Conversation Flow

The simplest intelligent path: no video, fully headless. Client calls `POST https://genie.nvp1.ovp.kaltura.com/assistant/converse` with a `geniegpcid:<configId>` KS. The response is an NDJSON (or SSE) stream of segments. The brain runs server-side. Segment `type` values and parsing rules are identical to the avatar's `agent_raw_text` stream (see [ARCHITECTURE-REFERENCE.md's "Conversation Phase"](architecture-reference/conversation-flow.md#conversation-phase-what-streams-while-connected)). Full endpoint details: [API-REFERENCE.md](../API-REFERENCE.md).

---

## Video Runtime Protocol — The Big Picture

The live talking avatar: the full bidirectional protocol.

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
   │  <video> │◄═════════════════════════════════════════  STV media relay (srsBaseUrl)
   └──────────┘
```

- **Control plane**: one Socket.IO connection. It carries the handshake, the agent's streaming text, talking state, and ASR signaling.
- **ASR channel (uplink)**: a WebRTC peer connection that publishes your **microphone** to the server. SDP offer/answer and ICE are relayed **through the Socket.IO connection** (custom `asr-webrtc-*` events). The server runs speech-to-text, then feeds the brain.
- **STV channel (downlink)**: a WebRTC peer connection that receives the **avatar video and audio**. It uses standard **WHEP** (plain SDP over HTTP), independent of the socket.

The brain runs entirely server-side. The client never calls an LLM. It only publishes audio, receives video, and receives the brain's text as `agent_raw_text` deltas, in the same format as the `/assistant/converse` NDJSON.

> For the exact connect sequence, wire shapes, endpoints, and scaling model, see **[ARCHITECTURE-REFERENCE.md](ARCHITECTURE-REFERENCE.md)**.  
>  
> For the **exhaustive** map, see **[WIRE-PROTOCOL.md](WIRE-PROTOCOL.md)**. It covers every socket event with its payload shape, the exact ICE/SDP/WHEP config, the parsed `agent_raw_text` delta types, and a turn-by-turn event trace.  
>  
> This section is the orientation. Those docs are the reference.

---

## Two Session Modes (choose the right one)

There are two session modes, and they are NOT interchangeable. Scripted sessions render speech you author, line by line. Interactive sessions run all [three conversation flows](https://kaltura.github.io/intelligent-agents-sdk/explanation/inside-a-live-conversation/) for you: conversation control, agent orchestration, and your plugged-in expertise. **Interactive agentic** is the product experience. **Scripted (puppet)** is a narrow authoring tool.

<!-- nova-target: two-runtime-sdk-paths-table | Two session modes comparison -->

| | scripted-video client (`/v1/avatar-session`) | interactive avatar client (`conversation.avatar` socket) |
|---|---|---|
| Avatar video (STV/WHEP) | ✅ | ✅ |
| Mic / ASR uplink | ❌ | ✅ (`asr-webrtc-*`) |
| Brain | ❌ (you supply every line of text) | ✅ (server-side, streams `agent_raw_text`) |
| You call | `mgmt.avatarSessions.say()` (audio only, see below) | nothing: the user speaks, the brain answers |
| Use for | **scripted / puppet** avatars (you drive the words) | **interactive agentic** avatars (autonomous conversation) |
<!-- /nova-target -->

The protocol above describes the **interactive** path. The scripted path has no text-in of its own: the service's `say-text` route 503s on every call, so the SDK wraps only `say-audio`. You provide pre-rendered speech audio (for example, from your own TTS call) and its duration. Full auth/lifecycle details: [API-REFERENCE.md § Scripted-Video (STV-only) Sessions](api/scripted-video.md). Runnable example: `examples/scripted-video-session.mjs` + `.html`.

### Audio-mode / phone-mode agents (partial support)

An agent with no avatar attached (create it with `avatarIds` omitted) is treated server-side as audio/phone-mode. `stvNewSession` replies with a "no STV session" status instead of a video session. The `clientConfiguration` the server sends carries `audioMode`/`phoneMode` flags (see [wire-protocol/client-configuration.md §7](wire-protocol/client-configuration.md#7-clientconfiguration-fields-per-session-agent-config)). `KalturaAvatarSession` detects this and sets `session.mode = 'audio'`, which skips the STV video pipeline entirely.

**This SDK does not implement the audio-mode WebRTC downlink** ([wire-protocol/audio-channels.md §5b](wire-protocol/audio-channels.md#5b-audio-mode-webrtc-separate-from-the-asr-uplink)) that carries the agent's spoken audio when there's no STV session. That peer connection is signaled over a separate event family (`webrtc-create-offer`/`webrtc-offer`/`webrtc-answer`) that the SDK never emits or listens for.

So today, `mode:'audio'` is detected but not functional end to end. The mic uplink (ASR) still connects, but you won't receive the agent's spoken reply through this SDK. Audio/phone mode is not a supported feature of this SDK.

---

## Displaying the Avatar Video

### How the SDK splits video and audio

The STV downlink carries two tracks: video and audio. Each track has its own `recvonly` transceiver, and each arrives in a separate `pc.ontrack` event.

The server's SDP gives each track its own `msid`, so `e.streams[0]` is a *different* `MediaStream` per event. The classic `videoEl.srcObject = e.streams[0]` pattern silently drops whichever track landed first. The SDK never does that.

`src/experience/avatar-media.js` (internal; both `KalturaAvatarSession` and `KalturaScriptedVideoSession` own one) builds its own streams from the raw tracks:

| Stream | Holds | Exposed as |
|---|---|---|
| canonical | every live downlink track (video + audio) | `session.avatarStream`: hand it to a `MediaRecorder`, a Web Audio graph, or a second element once |
| video | video, plus audio when there is no `audioEl` | `cfg.videoEl.srcObject` |
| audio | audio only (split mode) | `cfg.audioEl.srcObject` |

### Split, merged, or headless

You can bind the avatar stream to your UI in three ways:

- **Split** (`videoEl` + `audioEl`, recommended): the picture goes to the video element, the voice to the audio element.
- **Merged** (one `videoEl` only): the element plays both tracks. Fine when the app owns that element for the whole session.
- **Headless** (no `videoEl`): nothing is bound. Consume `avatarStream` or the `'track'` event yourself.

Split has one big advantage. Browsers pause a media element the moment it leaves the document. If your UI framework unmounts the `<video>` (a re-render, a route change, a conditional block), a merged element takes the voice down with the picture. A split `<audio>` kept on a stable node keeps the conversation audible until `setVideoEl(newEl)` restores the picture. Split also keeps sound when the video is a muted, off-screen texture source (chroma-key compositing) or part of a mixed multi-avatar layout.

Each element gets exactly one `srcObject` write and one `play()` call per binding. The SDK applies no CSS.

`setVideoEl(el)` and `setAudioEl(el)` rebind at runtime in any state. Pass `null` to unbind, or pass `null` to `setAudioEl` to merge audio back into `videoEl`.

`disconnect()` stops every track and nulls each bound element's `srcObject`. The elements themselves belong to the app: the SDK never creates, moves, or removes them.

### Recovery behavior

Media recovery (an STV re-subscribe after a stall) swaps the new tracks *inside* the same three streams. The elements are never touched, so there's no second `srcObject` write. A compositor, recorder, or Web Audio graph attached to `avatarStream` or to the element keeps working across recovery.

There is one exception: if the app replaced an element's `srcObject` itself, `attach()` binds it again. This means a self-hidden avatar comes back on recovery just as it did before.

Firefox pauses a media element whose tracks all ended before the replacements arrived. After the swap, the SDK calls `resumePlayback()`, which retries `play()` only on elements that report `paused === true` (a no-op on Chromium and WebKit). A refusal there only logs at debug level. It never raises the `playback_blocked` warning.

### Audio controls

Audio controls act on whichever element carries the audio track (`audioEl` if set, else `videoEl`), and they follow it across rebinds:

- `muteAudioOutput()` / `unmuteAudioOutput()`
- `setAudioOutputVolume(0..1)`
- `setAudioOutput(deviceId)`: wraps `setSinkId`. It resolves `false`, never throws, when the platform lacks it or no element is bound yet. The device id is stored and applied to the next element bound.
- `startPlayback()`: retries `play()` on every bound element from a user gesture, after a `playback_blocked` warning. It resolves `true` once all of them are playing.

Chromium only decodes a remote audio track while some media element plays it. A headless app that mixes `avatarStream` through Web Audio on Chromium must keep a muted `<audio>` bound to the track: `el.muted = true; el.srcObject = new MediaStream(session.avatarStream.getAudioTracks()); el.play()`. Firefox and WebKit decode without one.

### Sizing the video box

The backend's rendered aspect ratio is not a published contract (see [Upload a Custom Visual](api/design.md#upload-a-custom-visual-portrait--animated-avatar) on `catalog.createVisual` preprocessing). So size the box with `object-fit: cover` rather than assuming a fixed aspect ratio. It fills the box and crops evenly, no matter what the stream's actual aspect ratio turns out to be:

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
  object-fit: cover;        /* fills the box, crops evenly, no letterbox/pillarbox bars */
}
```

For a circular picture-in-picture mask, swap `border-radius` + `overflow: hidden` for `clip-path: circle(50%)` on `.avatar-box` (or directly on the `<video>`).

`object-fit: cover` never shows bars, regardless of the source's actual aspect ratio. That's why it's the right default, even without a published backend resolution to size against.

### Headless and custom rendering

Omit `videoEl` entirely for a headless or custom-render integration (canvas, WebGL, a circular-mask renderer). Both `KalturaAvatarSession` and `KalturaScriptedVideoSession` fire a `'track'` event (`{track, streams}`) the moment their STV peer's `ontrack` fires, whether or not `videoEl` is configured. `avatarStream` holds every live track in one stream that stays stable across recovery.

Calling `disconnect()` from inside a `'track'` listener is safe. The SDK defers the peer's `close()` to the next macrotask, because Chromium hangs the renderer when a peer connection is closed from within its own `ontrack` dispatch.

For a dynamic crop/`object-position` instead of generic `object-fit: cover`, both classes also fire `'videoMetadata'` (`{videoWidth, videoHeight}`) once per connect, as soon as the decoder resolves the stream's actual dimensions. There's no fixed or published output resolution to hardcode against. This event is the source of truth.

### Loading UI: `streamReady` vs `mediaReady`

**For `KalturaAvatarSession` only: don't hide a loading UI on `'streamReady'`.** Despite the name, it fires at the initial signaling handshake (`connect()` step 1), before any video track exists. There can be a real gap of a second or more between it and actual video.

Listen for `'mediaReady'` instead. It fires once per connect, unconditionally, in one of two shapes:

- `{mode:'video', videoWidth, videoHeight}` once the STV media is playable. It uses `'videoMetadata'`'s dimensions if they resolved in time, or `0` if they didn't (for example, no `videoEl`, or a decoder that never fires `loadedmetadata`).
- `{mode:'audio'}` immediately, if the session falls back to audio-only.

So a loading spinner has one deterministic event to hide on, in either mode, with no fallback timeout to guess.

`KalturaScriptedVideoSession` has no signaling handshake and emits neither event.

### Compositing a transparent-background avatar (chroma key)

The rendered avatar stream is opaque. There's no alpha channel or published green/blue-screen backdrop to key against as a platform guarantee.

If your layout needs the avatar composited over arbitrary page content (not a fixed rectangle), key it live yourself. Use a compositor shaped like `chroma-key-video` (bring your own), through `./experience/chroma-key`'s `attachChromaKeyAvatar()`:

```js
import { KalturaAvatarSession } from '@kaltura/intelligent-agents/experience';
import { attachChromaKeyAvatar } from '@kaltura/intelligent-agents/experience/chroma-key';
// Your dependency, not the SDK's. There is no npm package for chroma-key-video.
// Load it by bundling https://github.com/kaltura/chroma-key-video locally, or
// straight from jsDelivr's GitHub-CDN mode, pinned to a released tag:
import { ChromaKeyVideo } from 'https://cdn.jsdelivr.net/gh/kaltura/chroma-key-video@v1.2.0/src/chromakey.js';

// The keyed source <video> is muted and off-screen, so give the voice its own element:
const videoEl = document.createElement('video');
const audioEl = document.querySelector('audio');
// token: short-lived conversation token from your backend
const session = new KalturaAvatarSession({ token, videoEl, audioEl });
const player = attachChromaKeyAvatar({
  session, videoEl: session.videoEl, ChromaKeyVideo,
  options: { autoTune: true },
  container: document.getElementById('composited'),
});
await session.connect();
```

This follows the same pattern as `object-fit: cover` above, but one layer earlier. `attachChromaKeyAvatar()` constructs the injected `ChromaKeyVideo` class against the session's own video element (`session.videoEl`), not a second reference.

It keeps its lifecycle in lockstep with the session's. `player.destroy()` fires automatically on the session's `'ended'` event, a fatal `'error'`, or the session's own `disconnect()`/`stop()` (its documented human-in-the-loop kill switch, for example a "leave call" button). So `session.disconnect()` alone is enough teardown.

It never reimplements chroma-keying, matting, or WebGL context-loss recovery itself, and it returns the constructed player instance unwrapped. Listen on `player` directly for its own events, never on `session`.

The full behavior contract, the misuse guard, and the `videoEl` source element together show the SDK's zero-dependency rule in miniature. See [README.md § `./experience/chroma-key`](../README.md#experiencechroma-key) for the details.

---

## SDK Module Map — Overview

For the public surface, entry points, and how-tos, read [README.md](../README.md). Its ["Architecture" section](../README.md#architecture) has the module-to-resource map.

Both SDK entry points share one core. `src/core/*` is the shared leaf layer that both `./management` and `./experience` depend on (`http.js` transport, `errors.js`, `session.js`, `stream.js`, `redact.js`, `safety.js`, `ids.js`, `knowledge-enums.js`). Core never imports from `management/` or `experience/`.

`./management` (`Management`, `src/management/client.js`) enforces the two-KS guard via `assertAdmin`/`assertConversation` before any network call.

`./experience` (`KalturaAvatarSession`, `src/experience/session.js`) is the live socket+WHEP runtime described in "Video Runtime Protocol" above. It takes only a short-lived conversation token, and socket.io is injected into it, never bundled.

For the full module-by-module map, see **[ARCHITECTURE-REFERENCE.md's "SDK Module Map & Data Flow"](architecture-reference/module-map-and-data-flow.md#sdk-module-map--data-flow)**. It covers each management module's exposed surface and which backend door it writes to, the capabilities-resolution return shape, and the GenUI rendering layer.

---

## Resilience & Failure Handling — Overview

How the system behaves under network failures, disconnects, and device problems. There are **three reconnection tiers**: Socket.IO transport, the WebRTC media peers (ASR + STV), and this SDK's own avatar-session recovery. These tiers are only loosely coordinated with each other.

The SDK wires the WebRTC-peer tier to its own session-recovery tier (`_recoverMedia` → `_coldReconnect`). A custom client that skips `KalturaAvatarSession` must wire that itself.

See **[ARCHITECTURE-REFERENCE.md's "Resilience & Failure Handling"](architecture-reference/resilience-and-failure-handling.md#resilience--failure-handling)** for the full three-tier table and the failure-mode matrix. It also covers the headline risk in detail, device-permission handling, and the tool-call-spiral circuit breaker mechanism.

A conversation ending cleanly is a separate concern from recovering from failure. On tab-close, backgrounding, bfcache freeze, or an explicit `disconnect()`, the SDK tells the backend the thread is genuinely over (`POST /thread/session_completed`). This happens instead of waiting for the ~10-minute idle scanner, so end-of-conversation lifecycle rules fire in seconds.

See [ARCHITECTURE-REFERENCE.md's "Session-completion signal"](architecture-reference/resilience-and-failure-handling.md#session-completion-signal-session_completed-telling-the-backend-a-conversation-is-truly-over) for the condensed decision table. See [README.md § Ending a conversation cleanly](../README.md#ending-a-conversation-cleanly-session_completed-signal) for the app-facing config surface.
