[← Back to Architecture Reference](../ARCHITECTURE-REFERENCE.md)

# Resilience & Failure Handling

How the system behaves under network failures, disconnects, and device problems. There are **three reconnection tiers**, only loosely coordinated:

| Tier | Layer | Auto-recovers? | Scope |
|---|---|---|---|
| 1. Socket.IO transport | control socket | ✅ built-in (backoff + jitter + state recovery) | the websocket only |
| 2. WebRTC peer (ASR + STV) | the built-in client's media layer | ✅ 5 attempts × 2s, independent per channel | the media peer connections |
| 3. Avatar session | **this SDK** (`KalturaAvatarSession`) | ✅ socket-transport recovery: a recoverable drop → `reconnecting` → `reconnected` (same-instance, ≤~20s, no re-`join`); non-recoverable → clean `ended`. | the whole conversation |

The headline risk: **tiers 2 and 3 are not wired together for custom non-SDK clients** — the SDK wires them via `_recoverMedia` → `_coldReconnect`; when the WebRTC layer exhausts retries and emits `'failed'`, a custom client that does not use the SDK's `KalturaAvatarSession` must handle this itself.

### Device permissions (mic/camera)

`connecting → gettingUserMedia` calls `getUserMedia(audio:true, video:false)` on the built-in client's media layer — **audio only** by default; the avatar doesn't need your camera. On denial, the runtime client's device-media handler routes to `error` with `reason: DevicesPermissionDenied`, `skipDisconnect:true`, `suppressNotification:true` (and `shouldPurge=false`) — a clean, retryable abort with no scary toast. The SDK (`KalturaAvatarSession`) surfaces distinct `NotAllowed`/`NotFound`/`NotReadable` codes; the platform's built-in client's classification is coarse (no `NotAllowedError` vs `NotFoundError` vs `NotReadableError` distinction). No pre-flight `navigator.permissions.query`, no mid-call device-loss handling.

### WebRTC media peer (the built-in client's media layer)

- Config: `maxReconnectAttempts = 5`, `reconnectDelayMs = 2000` (fixed). ICE timers (`rtc-core` constants): connect-start 20s, no-SDP-answer 30s, disconnect-grace 60s.
- **ASR reconnection** (`handleAsrReconnection`): closes the peer, fully re-joins (new offer/answer via socket relay), **preserves mute state**. After 5 tries → emits `onConnectionState({type:'asr', status:'failed'})`.
- **STV reconnection** (`handleStvReconnection`): re-runs WHEP `joinSTV`. If WHEP returns **404 NO_ACTIVE_SESSION**, gives up immediately (server session gone — only the app can recreate it). After 5 tries → `'failed'`.

### Control socket & session machine (the platform's built-in client)

- Socket.IO built-in recovery: on `disconnect` with `socket.active`, auto-reconnects (may restore the same socket via `connectionStateRecovery`).
- But the runtime client's error handler converts every `disconnect`/`connect_error`/`error`/`removePeer`/`throwTo*` into a machine `Disconnect` → teardown. The session machine has **no auto-reconnect**; recovery is user-initiated.
- Connect-phase hang protection is strong: every sub-state has a timeout (5–30s). Teardown is reliable (routes through `disconnected` even on failure; resets the player-ready singleton). Disconnect reasons (the runtime client's notification layer) drive user-readable, severity-tagged messages.

### Failure-mode matrix

| Failure | Detected by | Handling today |
|---|---|---|
| User denies mic permission | `getUserMedia` throws | Clean abort, no toast, retry possible |
| No mic / mic busy | `getUserMedia` throws | Same generic path (not distinguished) |
| ASR/STV peer drops | the built-in client's media layer ICE state | 5× re-join @ 2s; SDK handles via `_onIceStateChange`; the platform's built-in client's wrapper leaves `failed` event unhandled |
| STV server session gone (404) | WHEP status | Give up; app must recreate session |
| Control socket transient drop | Socket.IO `disconnect` | Socket.IO auto-recovers… but the runtime client's error handler may also tear down |
| Control socket permanent drop | Socket.IO `disconnect` (`!active`) | Teardown + "reconnect" notification |
| All agent slots busy | `throwToNoAgent` | Availability queue + poll (see [Scale & Sticky Sessions](scale-and-sticky-sessions.md#scale--sticky-sessions)) |
| Plan/tier exceeded | `throwToExceededTier` | Fatal, clear message |
| Connect hangs | SDK: `setTimeout` (`TIMEOUTS` constants); the platform's built-in client: internal state-machine timeouts | 5–30s timeouts → error (well covered) |
| Player/video element error | `onPlayerError` chain | → `Disconnect` (`PlayerConnectionFailed`) |
| Brain stalls mid-conversation | `KalturaAvatarSession` watchdog | `brainStalled` event, repeating every `brainStallMs` until output lands; the platform's built-in client has no liveness timeout |
| Tool-call spiral (same command retried with no narration) | `KalturaAvatarSession` two-tier circuit breaker | Soft signal (`toolSpiralDetected`) + hard cold-reconnect recovery — see [Tool-call spiral: what happened and how it's mitigated](#tool-call-spiral-what-happened-and-how-its-mitigated) below |
| Tab backgrounded / network change | `KalturaAvatarSession` | `online`/`offline`/`visibilitychange` handling in SDK; the platform's built-in client does not handle these events |

### Tool-call spiral: what happened and how it's mitigated

A tool-eager brain can retry the same client command dozens or hundreds of times in one turn instead of narrating. `KalturaAvatarSession` defends against this with a two-tier circuit breaker.

**Soft tier — signal only.** Once a *turn* accumulates `toolSpiralLimit` (default 10) raw `type:"tool"` segments (counted before dedup, since a spiral IS the same call repeating), the SDK emits `toolSpiralDetected` once. The soft tier only signals. It never calls `interrupt()`: interrupting a spiral already running server-side has no effect on it and can truncate the turn's own narration.

A legitimate turn can double its raw tool-segment count when `speak()`'s barge-in branch (still-playing TTS audio from a prior turn) spawns a parallel tap-to-talk stream for the same question — a 3-tool turn duplicates into 6 raw segments this way. The default limit of 10 is high enough to absorb that duplication without tripping the breaker on an ordinary turn, not a real spiral.

**Hard tier — the actual fix.** A **session-scoped hard counter** (`hardToolSpiralLimit`, default `toolSpiralLimit * 3`) counts raw tool segments since the last perceivable output and is immune to turn-boundary resets — an idle wake-up nudge mid-spiral cannot hide it. Once it's crossed, the SDK emits `toolSpiralRecovering` (carrying `lastTurnText`, the abandoned turn) and forces `_coldReconnect()` — the same full media rebuild already used for a dead media channel, replaying `threadId` so brain memory continues. This turns the eventual uncontrolled `JoinRoomTimeout` into a deliberate, bounded, self-healing reconnect.

Because the control socket is still live at this point (unlike a genuine transport drop), `_coldReconnect()` opens a brand-new socket rather than re-`join`-ing the still-connected one — the server's `join` handler is idempotent-guarded per-connection and silently no-ops a re-join on a live socket. `_coldReconnect()` detects this case (`this.state !== 'reconnecting'` at entry means the socket never actually dropped) and opens a genuinely new socket via the same factory `connect()` uses, before re-`join`-ing on it. The one path that safely reuses the existing socket is the genuine-transport-disconnect case, reached only after a real drop already set `state` to `'reconnecting'` — there the server has already discarded that session, so re-`join`-ing it is not a no-op.

The hard guard re-arms on a successful cold reconnect, not just on perceivable output — a spiral by definition never produces spoken/GenUI content, so that's the only reset path that can actually fire while one is running. Without this re-arm, a second spiral later in the same session would find the guard permanently latched from the first recovery and hang indefinitely instead of recovering.

A cold reconnect restores connectivity and brain memory (`threadId`) but otherwise abandons the turn that triggered it. With `recoverFromSpiral` (default `true`), the SDK auto-resends that turn's tracked text once (from `speak()` or ASR's `userTranscription`), prefixed with `SPIRAL_RECOVERY_PREFIX` (the same nudge used on the headless `Conversations#send({recoverFromSpiral:true})` path), and emits `spiralRecovered {text}`. `recoverFromSpiral:false` suppresses the resend and leaves it to the app via `lastTurnText`. All three thresholds (`brainStallMs`, `toolSpiralLimit`, `hardToolSpiralLimit`) are configurable at construction; `0` disables any of them. The platform's built-in client has no such breaker. Author-side mitigation (a tool-call budget in the system prompt) and the headless-path equivalent are covered in [CLIENT-COMMANDS.md](../CLIENT-COMMANDS.md)'s "Tool spirals starve the voice" — this section documents only the SDK's own recovery mechanism.

`KalturaChatSession` (the HTTP text transport) ports the soft tier only: `cfg.toolSpiralLimit` (default 10, same counting rule) emits the same `toolSpiralDetected {count, limit}` once per turn. There's no hard tier here — a chat turn is one stateless HTTPS request with no socket to cold-reconnect, so a stuck turn is bounded by the caller's own `sendText({signal})` abort, not by a session-level recovery mechanism.

### Session-completion signal (`session_completed`) — telling the backend a conversation is truly over

Without this, the backend only learns a thread is done when its idle scanner sweeps (~10 min default), so end-of-conversation lifecycle rules (summaries, insights, CRM pushes) fire minutes late, and a closed tab looks identical to a user who just walked away. `KalturaAvatarSession`, `KalturaChatSession`, and `KalturaAgentSession` all POST `{genieUrl}/thread/session_completed` (`{"id":"<threadId>"}`, the same conversation KS as every other client call) the moment a conversation genuinely ends — including tab-close, backgrounding, and bfcache freeze — without ever firing on an internal transition like a mode switch, and without ending a thread another tab is still using. Full config surface: [README.md § Ending a conversation cleanly](../../README.md#ending-a-conversation-cleanly-session_completed-signal). Wire shape: [wire-protocol/events-catalog.md § Session-completion signal](../wire-protocol/events-catalog.md#session-completion-signal--tell-the-backend-a-conversation-is-truly-over).

| Trigger | Fires? | Why |
|---|---|---|
| App calls `disconnect()` / `stop()` | yes | Unambiguous hangup |
| Idle auto-logoff | yes | Real end of session |
| `pagehide` (tab/window closed, navigated away) | yes | The primary win over the idle-scanner fallback |
| `pagehide` with `persisted:true` (bfcache freeze) | yes, by default | The SDK can't survive the freeze anyway — media/socket are already torn down |
| Hidden longer than `hiddenGraceMs` (default 30s) | yes, by default | Catches iOS Safari / Chrome Android tab-kills where `pagehide` never fires |
| Server ends the conversation (`conversationEnded`) | no, by default | The backend already knows; re-signaling wastes a redundant lifecycle-rule evaluation |
| `KalturaAgentSession.switchMode()` tearing down the old transport | no | Thread continuity is the entire point of switching modes |
| Fatal/unrecoverable error (`_endWith()`) | no | An error isn't a clean end; the app may reconnect and continue the same thread |
| A second tab on the same thread is still alive (`crossTabPresence`, same-origin/same-device only via `BroadcastChannel`) | no — suppressed | Avoids ending a thread another tab is actively using; the last tab standing still fires |

The signal is idempotent (a repeat POST for the same thread is a server-side no-op) and never awaited on the unload path — `fetch(url, {keepalive:true})`, not `navigator.sendBeacon` (which can't carry the `Authorization` header). Cross-device duplicate tabs are out of scope by design (`BroadcastChannel` is same-origin/same-device only); the backend's own self-healing on the next real message covers that case.

### What's already solid (don't regress)

- Connect-phase hang protection (per-substate timeouts).
- Clean teardown (no stale connection state; player-ready reset).
- Permission-denied UX (silent, retryable).
- TURN relay for connectivity behind hostile NATs (STV forces relay; ASR relays in practice regardless of policy — see [Endpoints & Credentials](connection-and-handshake.md#endpoints--credentials)).
- Mute-state preservation across ASR reconnects.
- Capacity queue (graceful waiting vs hard failure).
- Distinct, user-readable disconnect reasons.
- WHEP 404 short-circuit.
- **SDK (`KalturaAvatarSession`) implements**: ICE restart (`_recoverMedia`), socket-transport recovery, a repeating brain-stall watchdog + `brainStalled` event and a two-tier tool-call-spiral circuit breaker (`toolSpiralDetected` soft, `toolSpiralRecovering` + cold reconnect hard), granular device error codes — `NotAllowed`/`NotFound`/`NotReadable`, and `online`/`offline`/`visibilitychange` handling. These limitations apply only to custom clients that bypass the SDK.

## Related docs

| Doc | Covers |
|---|---|
| [scale-and-sticky-sessions.md](scale-and-sticky-sessions.md) | `throwToNoAgent`/`throwToExceededTier` and the availability queue |
| [connection-and-handshake.md](connection-and-handshake.md) | Endpoints & Credentials, TURN/relay policy |
| [../ARCHITECTURE-REFERENCE.md](../ARCHITECTURE-REFERENCE.md) | Back to the index |
