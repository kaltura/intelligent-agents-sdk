---
layout: base.njk
title: "System Internals Reference · Scale and Sticky Sessions"
description: "Sticky routing, the capacity queue, connection vs. session recovery, and externalized session state."
eyebrow: Reference
---

# Scale & Sticky Sessions

[← Back to System Internals Reference](/reference/architecture-reference/)


The session server is a horizontally scaled pool of instances behind a load balancer, with a bounded number of concurrent avatar "agent slots" per instance. Three mechanisms make this work for a client: sticky routing, a capacity queue, and externalized session state.

### Sticky routing — `stickyId`

The single most important scaling detail. A live avatar session is **stateful and pinned to one server instance** (it owns the ASR peer connection, the speech pipeline, and the brain conversation). Socket.IO starts on HTTP long-**polling** and only later upgrades to WebSocket — those initial polling requests must all reach the *same* instance, or the handshake breaks.

- The client generates a `stickyId` once per session (a 16-char random token, or a caller-supplied value), not on every `connect()` call.
- It is sent as a **socket query param** (`query.stickyId`), so it's present on every polling request and the WebSocket upgrade.
- The load balancer routes all requests carrying the same `stickyId` to one instance.
- Kept for the life of the session, including a cold reconnect: `KalturaAvatarSession` reuses the same `stickyId` even when it rebuilds the socket from scratch, so a reconnect keeps landing on the instance that `stickyId` maps to. There is **no session migration** to a different instance — if that instance itself goes down, the session is gone (see recovery below). Only a brand-new session (a new `stickyId`, e.g. constructing a new `KalturaAvatarSession`) gets a fresh instance assignment.

The STV video channel does **not** need stickiness — it's a stateless WHEP stream, scaled independently of the control plane.

### Capacity & the queue (`throwToNoAgent` / `throwToExceededTier`)

Each instance has a bounded number of agent slots (the face-renderer + brain pipeline is expensive). Two distinct "full" signals:

| Signal | Meaning | Client behavior |
|---|---|---|
| `throwToNoAgent` | All agent slots currently busy (transient) | Enter **availability queue** (poll until a slot frees) |
| `throwToExceededTier` | Account plan/tier limit hit (hard) | Fail immediately — `TIER_EXCEEDED`, not recoverable |

**The queue (transient capacity):**

- Capacity is polled **out-of-band** via `checkAvailability` → `availabilityResult {available, …}`; that poll **never disconnects**, so the socket stays open during the wait. A `throwToNoAgent` returned from the `stvNewSession` path is *terminal*: the server disconnects the socket right after emitting it. Capacity handling is therefore the proactive poll loop, not "react to `throwToNoAgent` on a live socket".
- Poll delay cycle: `[30s, 45s, 1m, 1.5m, 2m, 3m, 4m, 5m, 6m]` (±15% jitter applied each time a delay is used), capped at the last value once exhausted — so re-polls never come faster than 30s or slower than 6m.
- When a positive `availabilityResult` arrives, the client emits **`join` (then `stvNewSession`) on the same socket** (same instance, sticky preserved) — no reconnect, state stays `CONNECTING`. The non-disconnecting `checkAvailability` poll is what preserves stickiness. This automatic queue inside `connect()` shares the same 30s overall connect deadline as every other step — it is **not** paused while queued, so a long wait can still end in `ConnectTimeout`. For a longer, separately-bounded wait, call `waitForCapacity({maxWaitMs, pollIntervalMs})` before `connect()` (see [System Internals Reference · Connection and Handshake](/reference/architecture-reference/connection-and-handshake/#full-connect-sequence-state-machine-order)).

Session validity is checked separately via `isValidSession` → `validSession` / `throwToExceededTier` / `throwToBadRequest`.

### Connection recovery vs. session recovery

- **Transport blips** — Socket.IO's built-in `connectionStateRecovery`: if `socket.active` on disconnect, it auto-reconnects with exponential backoff + jitter and may restore the same socket (`socket.recovered === true`). A short blip doesn't tear down the avatar.
- **Recoverable transport drop** (within ~20s) — the **server preserves the session on the same instance**: the live STV/ASR session and in-memory state survive, and a re-`join` is not needed. **This SDK's `KalturaAvatarSession` relies on this** — it rides recovery, emits `reconnecting`/`reconnected`, and does not re-`join`.
- **Permanent disconnect** (`socket.active === false`, or past the recovery window) — the session is gone; the avatar reconnects fresh: `KalturaAvatarSession`'s cold reconnect rebuilds the socket, re-`join`s, and re-creates the STV/agent session with a new agent slot — reusing the *same* `stickyId`, so it lands back on the instance that `stickyId` maps to, not a new random one. Same-instance resume exists (above); **cross-instance resume does not** — only the brain thread is resumable via `threadId`.
- Distinct timeouts pinpoint where it broke: `HANDSHAKE_TIMEOUT` (transport up, server silent → activate queue) vs `CONNECTION_TIMEOUT` (transport never came up).

### Externalized state

Slot accounting is centralized, not per-instance guesswork: `checkAvailability` consults a shared store. A slot is available when **STV has free capacity** (unless the call is speech-only) **AND the ASR service is available AND `activeCalls < maxCalls`**. `availabilityResult.details` surfaces exactly these: `{stvAvailable, whisperAvailable, activeCalls, maxCalls, capacityAvailable}`. The brain conversation/thread state is also externalized: the same thread is resumable via `threadId` regardless of which instance handles a later turn over the text API.

For what a custom (no-Kaltura-lib) client must implement to work correctly with this scaling model, see [Minimal Reimplementation Recipe's "Implications for a Custom Client"](/reference/architecture-recipe/#implications-for-a-custom-no-kaltura-lib-client).

## Related docs

| Doc | Covers |
|---|---|
| [System Internals Reference · Connection and Handshake](/reference/architecture-reference/connection-and-handshake/) | The connect sequence this queue sits alongside |
| [System Internals Reference · Resilience and Failure Handling](/reference/architecture-reference/resilience-and-failure-handling/) | The failure-mode matrix that references `throwToNoAgent`/`throwToExceededTier` |
| [System Internals Reference](/reference/architecture-reference/) | Back to the index |

