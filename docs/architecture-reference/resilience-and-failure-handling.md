[← Back to Architecture Reference](../ARCHITECTURE-REFERENCE.md)

# Resilience & Failure Handling

How `KalturaAvatarSession` behaves under network failures, disconnects, and device problems. Recovery has three layers. Each escalates to the next:

| Layer | Scope | What the SDK does | Events |
|---|---|---|---|
| 1. Control socket | the websocket only | Socket.IO reconnects with backoff. If the socket state was recovered, the session goes straight back to `connected`. If not, the SDK does a cold reconnect (layer 3). The `reconnecting` state is bounded by `reconnectWindowMs` (default 22000). | `connectivityChanged` (`channel:'socket'`), `reconnecting`, `reconnected` |
| 2. Media peers (ASR + STV) | one peer connection at a time | Watches ICE state, peer state and incoming video. Recovers in place first. If that fails, escalates to layer 3. | `connectivityChanged`, `mediaRecovering`, `mediaRecovered` |
| 3. Cold reconnect | the whole conversation | Opens a new socket, re-`join`s, and rebuilds both media peers. Replays `threadId` so the conversation memory continues. Tries twice before it gives up. | `reconnecting`, `reconnected` |

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

The SDK emits `mediaRecovering { channel, state, cause }` when recovery starts and `mediaRecovered { channel, method }` when it works. Every ICE state change also emits `connectivityChanged { channel, state }`.

| Channel | In-place recovery (`method`) | Details |
|---|---|---|
| ASR (mic uplink) | `ice-restart` | Restarts ICE on the same peer and re-offers over the socket with `is_reconnect: true`. Mute state is kept. Waits up to 30 s for the answer. |
| STV (avatar video) | `re-subscribe` | Waits for the `DELETE` of the old WHEP resource, then sends a new WHEP offer. A `404` or `409` first asks for a new avatar session on the live socket ([details](../wire-protocol/audio-channels.md#6-stv-downlink-pc2-avatar-videoaudio--you)). Then it resumes playback if the browser paused the element. |

If in-place recovery fails, the SDK emits `connectivityChanged` with `state:'recover_failed'` and does a cold reconnect. `timeouts.recover` (15 s) bounds the STV re-subscribe. The ASR restart waits up to 30 s for its answer. Each channel has its own grace timer, so the two peers recover independently.

Recoveries are bounded per channel. If a channel needs a third recovery and its ICE was never up since the first one, the session ends with `reconnect_failed` (`error.ice` holds the [ICE report](#ice-diagnostics) when there is one). ICE reaching `connected` resets the count.

The same recovery runs when the browser fires `online` after an `offline` and a peer is still in a down ICE state. Both events also emit `connectivityChanged` with `channel:'network'`. If the control socket is down while `reconnecting`, `online` makes it retry at once instead of waiting out its backoff. Turn this off with `networkAware:false`.

### ICE diagnostics

Each peer keeps a safe summary of what it gathered and what its STUN and TURN servers answered. No address, port or credential is stored. `cause` names the most likely reason a path is not up:

| `cause` | Meaning | What to do |
|---|---|---|
| `connected` | The media path is up | Nothing |
| `turn_credentials_rejected` | The relay refused the credentials and no relay address was allocated | Check the TURN settings the session was given |
| `turn_unreachable` | No relay address could be allocated | Allow outbound UDP and TCP on ports 80 and 443 to the relay host, or use another network |
| `no_candidates` | The browser found no network address | Check the device is online, a VPN or privacy setting is not hiding its interfaces, and outbound UDP and TCP on ports 80 and 443 to the relay host are allowed |
| `no_route` | Addresses exist but the media server was not reached | Try again, or use another network |
| `closed` | The peer was closed (for example after `disconnect()`) | Nothing |
| `still_gathering` | The browser was still looking for a path | Try again on a faster network |

`await session.getIceReport()` returns `{ asr, stv }`. Each is `null` before that peer exists, or an `IceReport`: `channel`, the three peer states, `candidates` by type (`host`, `srflx`, `prflx`, `relay`), `errors` (`code`, `text`, `scheme`), `cause`, `hint` and `selectedPair` (`localType`, `remoteType`, `protocol`, or `null`). It never rejects and is safe to log or attach to a support ticket.

`connect()` fails with `ice_failed` (`phase: 'ice'`, `retryable: true`, `error.ice` is the same summary) when the avatar peer never reaches ICE `connected`. This holds with or without a `<video>` element and with or without a frame callback: `connect()` never resolves while ICE is down. ICE `failed` ends the wait at once. Otherwise the wait ends at `timeouts.firstFrame`. The first miss re-subscribes once. The second miss rejects. A peer that is connected but shows no frame is a different case: `connect()` resolves with `media_no_video`. An ASR peer that fails while `connect()` is still running is recovered as soon as the session is `connected`.

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
| `iceStuck` | 10000 ms | A peer still in ICE `new` or `checking` this long is recovered |
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
| ASR/STV peer keeps failing with no ICE up | Recovery count | The third recovery ends the session with `reconnect_failed`. |
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
| Agent stalls mid-conversation | Watchdog | `brainStalled`, repeating every `brainStallMs` (default 12000) until output lands. |
| Tool-call spiral (same command retried with no narration) | Two-tier circuit breaker | Soft signal (`toolSpiralDetected`), then a hard cold reconnect. See [Tool-call spiral](#tool-call-spiral). |
| Tab backgrounded / network change | `online`/`offline`/`visibilitychange` listeners | Media recovery as above. See [Session completion](#session-completion). |

### Tool-call spiral

An agent can retry the same client command again and again instead of narrating. `KalturaAvatarSession` breaks the loop in two steps. `KalturaChatSession` has the first step only, because a chat turn has no socket to rebuild.

| Step | Trigger | Event | SDK action |
|---|---|---|---|
| Soft | `toolSpiralLimit` (default 10) tool segments in one turn | `toolSpiralDetected {count, limit}` | Signal only. The SDK does not interrupt the turn. |
| Hard | `hardToolSpiralLimit` (default `toolSpiralLimit * 3`) tool segments since the last spoken or GenUI output | `toolSpiralRecovering {count, limit, lastTurnText}` | Cold reconnect. `threadId` is replayed, so the conversation memory continues. |
| Resend | The cold reconnect succeeds and `recoverFromSpiral` is `true` (default) | `spiralRecovered {text}` | The SDK resends the abandoned turn once, with a short nudge prefix. |

Set `recoverFromSpiral:false` to resend the turn yourself from `lastTurnText`. Set any of the three limits to `0` to turn that step off. Options and a code sample: [README § Resilience: agent stalls and tool-call spirals](../../README.md#resilience-agent-stalls-and-tool-call-spirals). Prompt-side prevention: [CLIENT-COMMANDS.md](../CLIENT-COMMANDS.md).

### Session completion

All three session classes send `session_completed` when a conversation truly ends: `disconnect()`, idle logoff, tab close, or a long background. Triggers, options and the cross-tab rule: [README § Ending a conversation cleanly](../../README.md#ending-a-conversation-cleanly-session_completed-signal). Request shape: [operate.md § Session-Completion Signal](../api/operate.md#session-completion-signal).

### Page exit

A `pagehide` that is not a bfcache freeze runs `disconnect()`. The session sends `session_completed` first, then `DELETE`s the WHEP resource with `keepalive` so the request outlives the page, closes both peers and closes the socket. It is installed when `connect()` starts, so a tab closed mid-connect is cleaned up too. A request already in flight is aborted, and a `DELETE` can only name a resource whose answer has arrived. The browser decides whether a request sent while a page closes completes, so the release is best effort. A `pagehide` with `persisted:true` (bfcache freeze) leaves the session alone. Turn the whole page-lifecycle handling off with `pageLifecycleAware:false`.

## Related docs

| Doc | Covers |
|---|---|
| [scale-and-sticky-sessions.md](scale-and-sticky-sessions.md) | `throwToNoAgent`/`throwToExceededTier` and the availability queue |
| [connection-and-handshake.md](connection-and-handshake.md) | Endpoints & Credentials, TURN/relay policy |
| [../ARCHITECTURE-REFERENCE.md](../ARCHITECTURE-REFERENCE.md) | Back to the index |
