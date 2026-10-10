[← Back to System Internals Reference](../ARCHITECTURE-REFERENCE.md)

# Resilience & Failure Handling

How `KalturaAvatarSession` behaves under network failures, disconnects, and device problems. Recovery has three layers. Each escalates to the next:

| Layer | Scope | What the SDK does | Events |
|---|---|---|---|
| 1. Control socket | the websocket only | Socket.IO reconnects with backoff. If the socket state was recovered, the session goes straight back to `connected`. If not, the SDK does a cold reconnect (layer 3). The `reconnecting` state is bounded by `reconnectWindowMs` (default 22000). | `connectivityChanged` (`channel:'socket'`), `reconnecting`, `reconnected` |
| 2. Media peers (ASR + STV) | one peer connection at a time | Watches ICE state, peer state and incoming video. Recovers in place first. If that fails, escalates to layer 3. | `connectivityChanged`, `mediaRecovering`, `mediaRecovered` |
| 3. Cold reconnect | the whole conversation | Opens a new socket, re-`join`s, and rebuilds both media peers. Replays `threadId` so brain memory continues. Tries twice before it gives up. | `reconnecting`, `reconnected` |

A non-recoverable failure ends the session cleanly (`ended`, or an error such as `reconnect_failed` or `reconnect_timeout`). It never hangs.

A custom client that does not use `KalturaAvatarSession` must implement these layers itself. The rest of this page describes what the SDK does.

## Control socket

- `maxReconnectAttempts` (default 5) caps Socket.IO's own attempts. It also appears as `attempt`/`maxAttempts` on `reconnecting` and `connectivityChanged`.
- Recoverable disconnect reasons: `transport error`, `transport close`, `forced close`, `ping timeout`. Any other reason ends the session.
- `reconnectWindowMs` (default 22000) bounds the whole `reconnecting` state. If nothing recovers in that time, the session ends with `reconnect_timeout`. If Socket.IO runs out of attempts first, it ends with `reconnect_failed`.
- After a reconnect where the socket state was **not** recovered, the old session is gone. The SDK runs a cold reconnect (layer 3).
- After a reconnect where it **was** recovered, the SDK also checks both media peers. A peer stuck in a down ICE state goes through layer 2.

## Media peers (ICE watch)

| ICE state | SDK action |
|---|---|
| `disconnected` | Waits 1.5 s. If it has not returned to `connected`, recovers. |
| `failed` | Recovers at once. |
| `new` or `checking` for 10 s, or gathering ends with no candidates | Recovers. |
| `connected` / `completed` | Clears the recovery flag. |

The SDK emits `mediaRecovering { channel, state }` when recovery starts and `mediaRecovered { channel, method }` when it works. Every ICE state change also emits `connectivityChanged { channel, state }`.

| Channel | In-place recovery (`method`) | Details |
|---|---|---|
| ASR (mic uplink) | `ice-restart` | Restarts ICE on the same peer and re-offers over the socket with `is_reconnect: true`. Mute state is kept. Waits up to 30 s for the answer. |
| STV (avatar video) | `re-subscribe` | Waits for the `DELETE` of the old WHEP resource, then sends a new WHEP offer. A `404` or `409` first asks for a new avatar session on the live socket ([details](../wire-protocol/audio-channels.md#6-stv-downlink-pc2--avatar-videoaudio--you)). Then it resumes playback if the browser paused the element. |

If in-place recovery fails, the SDK emits `connectivityChanged` with `state:'recover_failed'` and does a cold reconnect. `timeouts.recover` (15 s) bounds the STV re-subscribe. The ASR restart waits up to 30 s for its answer. Each channel has its own grace timer, so the two peers recover independently.

The same recovery runs when the browser fires `online` after an `offline` and a peer is still in a down ICE state. Both events also emit `connectivityChanged` with `channel:'network'`. If the control socket is down while `reconnecting`, `online` makes it retry at once instead of waiting out its backoff. Turn this off with `networkAware:false`.

### Peer health watchdog

A peer can die without an ICE event: closing it from outside fires nothing, and a stalled sender keeps ICE `connected` while no video arrives. While the session is `connected` (not paused or released), a check runs every `timeouts.healthTick` (1 s):

| Check | Recovers when |
|---|---|
| Peer state | A peer is `failed` or `closed` |
| Video flow (STV) | The incoming video bytes have not grown for `timeouts.videoStall` (4 s) |

Both go through the same recovery as an ICE failure and emit the same events. A peer that reports no video receiver is not judged. A sender that stays stalled gets two re-subscribes in a row. If video still does not flow, the next stall does a cold reconnect. The watchdog stops on `disconnect()`.

### Cold reconnect retries

A cold reconnect makes up to `timeouts.coldAttempts` (2) attempts, `timeouts.coldBackoff` (500 ms) apart. A failed first attempt emits `connectivityChanged { channel:'socket', state:'reconnect_retry' }`. When the last attempt fails, the session emits `error` and then `ended`, both with `reconnect_failed` (`phase: 'reconnect'`, `retryable: true`). `error.cause` holds the last attempt's error. `disconnect()` during the backoff cancels the retry.

### Recovery events

| Event | Payload |
|---|---|
| `reconnecting` | `{reason, attempt, maxAttempts}`; `cold: true` when the SDK rebuilds the session |
| `reconnected` | `{recovered}`: `true` when the socket kept its state, `false` after a cold reconnect |
| `connectivityChanged` | `{channel, state}` plus `reason`, `attempt`, `maxAttempts` (socket drop) or `detail` (`recover_failed`, `reconnect_retry`). `channel` is `asr`, `stv`, `socket` or `network`. `state` is the ICE state, `connected`, `disconnected`, `offline`, `online`, `recover_failed` or `reconnect_retry` |

### Timeouts

All keys go in `cfg.timeouts` of a `KalturaAvatarSession`. In a `KalturaAgentSession`, put it inside the `avatar` option. Unset keys keep the default.

| Key | Default | Meaning |
|---|---|---|
| `whepTry`, `whepTries`, `whepBackoff` | 5000 ms, 3, 1000 ms | WHEP POST per-try deadline, tries, wait between tries |
| `whepRelease` | 3000 ms | WHEP `DELETE` deadline |
| `recover` | 15000 ms | One media recovery |
| `healthTick`, `videoStall` | 1000 ms, 4000 ms | Watchdog interval, video stall limit |
| `coldAttempts`, `coldBackoff` | 2, 500 ms | Cold reconnect attempts, wait between them |

The connect-time keys (`overall`, `joinRoom`, and the rest) are in [Connection & Handshake](connection-and-handshake.md#start-faster).

## Device permissions (mic)

`connect()` starts `getUserMedia({audio})` in the background (`micStartMode: 'immediate'`, the default). It asks for audio only. The avatar does not need your camera.

- A denied, missing or busy mic **does not fail `connect()`**. The SDK emits one `warning` and connects without a mic. `speak()` still works, and `startMic()` retries.
- `startMic()` throws the same codes.
- `micStartMode:'deferred'` skips the automatic prompt. Call `startMic()` from a user gesture.

| Browser error | SDK code |
|---|---|
| `NotAllowedError`, `SecurityError` | `mic_permission_denied` |
| `NotFoundError`, `OverconstrainedError` | `mic_not_found` |
| `NotReadableError`, `AbortError` | `mic_in_use` |
| anything else | `devices_permission_denied` |

## Failure-mode matrix

| Failure | Detected by | SDK handling |
|---|---|---|
| User denies mic permission | `getUserMedia` rejects | `warning` with `mic_permission_denied`. The session connects without a mic. |
| No mic / mic busy | `getUserMedia` rejects | `warning` with `mic_not_found` or `mic_in_use`. |
| ASR/STV peer drops | ICE state | In-place recovery, then cold reconnect. |
| Peer closed or failed with no ICE event, or video stops arriving | Health watchdog | In-place recovery, then cold reconnect. |
| STV session gone (WHEP `404` or `409`) | WHEP status | One new avatar session on the live socket, then a new POST. A second `404` or `409` is `stv_session_gone`. |
| WHEP POST gets no answer | Per-try deadline | Up to 3 tries. Then `whep_timeout` or `whep_failed`. |
| Cold reconnect attempt fails | The attempt rejects | A second attempt. Then `reconnect_failed`. |
| Tab closed or navigated away | `pagehide` | [Page exit](#page-exit). |
| Control socket transient drop | Socket.IO `disconnect` (recoverable reason) | `reconnecting`, then `reconnected` or cold reconnect, within `reconnectWindowMs`. |
| Control socket permanent drop | Socket.IO `disconnect` (other reason), `reconnect_failed` | Session ends. |
| All agent slots busy | `throwToNoAgent` | Availability poll. See [Scale & Sticky Sessions](scale-and-sticky-sessions.md#scale--sticky-sessions). |
| Plan/tier exceeded | `throwToExceededTier` | Fails with `tier_exceeded`. |
| Connect hangs | Per-step timeouts and the 30 s deadline | `connect()` rejects with `timeout` and `error.phase`. See the [connect sequence](connection-and-handshake.md#full-connect-sequence-state-machine-order). |
| Tool reply gets no answer | 15 s deadline | `respondToTool()` returns `{ok:false, reason:'timeout'}`. The call stays pending, so you can retry. The first reply may still have arrived, so make the tool's side effect safe to repeat. |
| Brain stalls mid-conversation | Watchdog | `brainStalled`, repeating every `brainStallMs` (default 12000) until output lands. |
| Tool-call spiral (same command retried with no narration) | Two-tier circuit breaker | Soft signal (`toolSpiralDetected`), then a hard cold reconnect. See [below](#tool-call-spiral-what-happened-and-how-its-mitigated). |
| Tab backgrounded / network change | `online`/`offline`/`visibilitychange` listeners | Media recovery as above. See the `session_completed` section for the page-lifecycle signal. |

### Tool-call spiral: what happened and how it's mitigated

A tool-eager brain can retry the same client command dozens or hundreds of times in one turn instead of narrating. `KalturaAvatarSession` defends against this with a two-tier circuit breaker.

**Soft tier: signal only.** Once a *turn* accumulates `toolSpiralLimit` (default 10) raw `type:"tool"` segments, counted before dedup since a spiral is the same call repeating, the SDK emits `toolSpiralDetected` once. The soft tier only signals. It never calls `interrupt()`, because interrupting does not stop a spiral that is already running, and it can truncate the turn's own narration.

A legitimate turn can double its raw tool-segment count when `speak()`'s barge-in branch (still-playing TTS audio from a prior turn) spawns a parallel tap-to-talk stream for the same question. For example, a 3-tool turn duplicates into 6 raw segments this way. The default limit of 10 is high enough to absorb that duplication without tripping the breaker on an ordinary turn.

**Hard tier: the actual fix.** A **session-scoped hard counter** (`hardToolSpiralLimit`, default `toolSpiralLimit * 3`) counts raw tool segments since the last perceivable output. Turn boundaries do not reset it. Once it's crossed, the SDK emits `toolSpiralRecovering` (carrying `lastTurnText`, the abandoned turn) and forces `_coldReconnect()`. This is the same full media rebuild used for a dead media channel, replaying `threadId` so brain memory continues. It turns an uncontrolled `JoinRoomTimeout` into a deliberate, bounded reconnect.

The control socket is still live at this point, unlike a genuine transport drop. So `_coldReconnect()` opens a brand-new socket through the same factory `connect()` uses, then re-`join`s on it. It detects this case when `this.state !== 'reconnecting'` at entry. After a genuine transport drop, `state` is already `'reconnecting'`, and the SDK re-`join`s on the socket Socket.IO reopened.

The hard guard re-arms on a successful cold reconnect, not just on perceivable output. A spiral never produces spoken or GenUI content, so that is the only reset that can fire while one runs. Without the re-arm, a second spiral later in the same session would find the guard latched from the first recovery.

A cold reconnect restores connectivity and brain memory (`threadId`) but abandons the turn that triggered it. With `recoverFromSpiral` (default `true`), the SDK auto-resends that turn's tracked text once, from `speak()` or ASR's `userTranscription`. It prefixes the resend with `SPIRAL_RECOVERY_PREFIX` (the same nudge used on the headless `Conversations#send({recoverFromSpiral:true})` path), and emits `spiralRecovered {text}`. `recoverFromSpiral:false` suppresses the resend and leaves it to the app via `lastTurnText`. All three thresholds (`brainStallMs`, `toolSpiralLimit`, `hardToolSpiralLimit`) are configurable at construction; `0` disables any of them. Author-side mitigation (a tool-call budget in the system prompt) and the headless-path equivalent are covered in [CLIENT-COMMANDS.md](../CLIENT-COMMANDS.md)'s "Tool spirals starve the voice".

`KalturaChatSession` (the HTTP text transport) ports the soft tier only: `cfg.toolSpiralLimit` (default 10, same counting rule) emits the same `toolSpiralDetected {count, limit}` once per turn. There's no hard tier here. A chat turn is one stateless HTTPS request with no socket to cold-reconnect, so a stuck turn is bounded by the caller's own `sendText({signal})` abort.

### Session-completion signal (`session_completed`): telling the backend a conversation is truly over

`KalturaAvatarSession`, `KalturaChatSession`, and `KalturaAgentSession` all POST `{genieUrl}/thread/session_completed` (`{"id":"<threadId>"}`, the same conversation KS as every other client call) the moment a conversation genuinely ends. This includes tab-close, backgrounding, and bfcache freeze. It never fires on an internal transition like a mode switch, and never ends a thread another tab is still using. Full config surface: [README.md § Ending a conversation cleanly](../../README.md#ending-a-conversation-cleanly-session_completed-signal). Request shape: [operate.md § Session-Completion Signal](../api/operate.md#session-completion-signal).

| Trigger | Fires? | Why |
|---|---|---|
| App calls `disconnect()` / `stop()` | yes | Unambiguous hangup |
| Idle auto-logoff (`idleTimeoutMs`, default 15 min) | yes | Real end of session |
| `pagehide` (tab/window closed, navigated away) | yes | The main case this signal exists for |
| `pagehide` with `persisted:true` (bfcache freeze) | yes, by default | The SDK can't survive the freeze anyway: media/socket are already torn down |
| Hidden longer than `hiddenGraceMs` (default 30s) | yes, by default | Catches iOS Safari / Chrome Android tab-kills where `pagehide` never fires |
| Server ends the conversation (`conversationEnded`) | no, by default (`completeOnServerEnd`) | The server already ends the thread |
| `KalturaAgentSession.switchMode()` tearing down the old transport | no | Thread continuity is the entire point of switching modes |
| Fatal/unrecoverable error (`_endWith()`) | no | An error isn't a clean end; the app may reconnect and continue the same thread |
| A second tab on the same thread is still alive (`crossTabPresence`, same-origin/same-device only via `BroadcastChannel`) | no, suppressed | Avoids ending a thread another tab is actively using; the last tab standing still fires |

Sending the signal twice for the same thread is safe. The SDK never awaits it on the unload path. It uses `fetch(url, {keepalive:true})`, not `navigator.sendBeacon`, because `sendBeacon` can't carry the `Authorization` header. Duplicate tabs on different devices are out of scope by design (`BroadcastChannel` is same-origin/same-device only).

### Page exit

A `pagehide` that is not a bfcache freeze runs `disconnect()`. The session sends `session_completed` first, then `DELETE`s the WHEP resource with `keepalive` so the request outlives the page, closes both peers and closes the socket. It is installed when `connect()` starts, so a tab closed mid-connect is cleaned up too. A request already in flight is aborted, and a `DELETE` can only name a resource whose answer has arrived. The browser decides whether a request sent while a page closes completes, so the release is best effort. A `pagehide` with `persisted:true` leaves the session alone, as in the table above. Turn the whole page-lifecycle handling off with `pageLifecycleAware:false`.

### What the SDK implements (don't regress)

- Per-step connect timeouts and the 30 s connect deadline.
- Clean teardown, including a WHEP `DELETE` for the viewer slot, also on page exit.
- A deadline on every control request, a bounded WHEP retry, and a health watchdog that catches silent peer death.
- A mic problem never fails `connect()`. It emits a `warning`.
- TURN relay for connectivity behind hostile NATs ([details](../wire-protocol/audio-channels.md#5-asr-uplink-pc1--microphone--server)).
- Socket recovery within `reconnectWindowMs`, with a clean end otherwise.
- ICE restart for ASR and re-subscribe for STV, then cold reconnect.
- Mute-state preservation across ASR recovery.
- Capacity queue (`waitForCapacity`) instead of a hard failure.
- A repeating brain-stall watchdog and a two-tier tool-call-spiral breaker.
- Distinct mic error codes and `online`/`offline`/`visibilitychange` handling.

## Related docs

| Doc | Covers |
|---|---|
| [scale-and-sticky-sessions.md](scale-and-sticky-sessions.md) | `throwToNoAgent`/`throwToExceededTier` and the availability queue |
| [connection-and-handshake.md](connection-and-handshake.md) | Endpoints & Credentials, TURN/relay policy |
| [../ARCHITECTURE-REFERENCE.md](../ARCHITECTURE-REFERENCE.md) | Back to the index |
