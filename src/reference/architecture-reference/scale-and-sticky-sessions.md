---
layout: base.njk
title: "Architecture Reference · Scale and Sticky Sessions"
description: "Sticky routing, the capacity queue, connection vs. session recovery, and externalized session state."
eyebrow: Reference
---

# Scale & Sticky Sessions

[← Back to Architecture Reference](/reference/architecture-reference/)


The session server is a horizontally scaled pool of instances behind a load balancer, with a bounded number of concurrent avatar "agent slots" per instance. Three mechanisms make this work for a client: sticky routing, a capacity queue, and externalized session state.

### Sticky routing — `stickyId`

The single most important scaling detail. A live avatar session is **stateful and pinned to one server instance** (it owns the ASR peer connection, the speech pipeline, and the brain conversation). Socket.IO starts on HTTP long-**polling** and only later upgrades to WebSocket — those initial polling requests must all reach the *same* instance, or the handshake breaks.

- The client generates a fresh `stickyId` per `connect()`: a 16-char random token.
- It is sent as a **socket query param** (`query.stickyId`), so it's present on every polling request and the WebSocket upgrade.
- The load balancer routes all requests carrying the same `stickyId` to one instance.
- Generated per-connection, not persisted: a brand-new `connect()` gets a new instance assignment. There is **no session migration** across instances — losing the instance ends the session (see recovery below).

The STV video channel does **not** need stickiness — it's a stateless WHEP stream, scaled independently of the control plane.

### Capacity & the queue (`throwToNoAgent` / `throwToExceededTier`)

Each instance has a bounded number of agent slots (the face-renderer + brain pipeline is expensive). Two distinct "full" signals:

| Signal | Meaning | Client behavior |
|---|---|---|
| `throwToNoAgent` | All agent slots currently busy (transient) | Enter **availability queue** (poll until a slot frees) |
| `throwToExceededTier` | Account plan/tier limit hit (hard) | Fail immediately — `TIER_EXCEEDED`, not recoverable |

**The queue (transient capacity):**

- Capacity is polled **out-of-band** via `checkAvailability` → `availabilityResult {available, …}`; that poll **never disconnects**, so the socket stays open during the wait. A `throwToNoAgent` returned from the `stvNewSession` path is *terminal*: the server disconnects the socket right after emitting it. Capacity handling is therefore the proactive poll loop, not "react to `throwToNoAgent` on a live socket".
- Poll delay cycle: `[30s, 45s, 1m, 1.5m, 2m, 3m, 4m, 5m, 6m]`, wrapping via modulo — effectively infinite backoff with a cap, bounded by `maxWaitMs`.
- When a positive `availabilityResult` arrives, the client emits **`join` (then `stvNewSession`) on the same socket** (same instance, sticky preserved) — no reconnect, state stays `CONNECTING`. The non-disconnecting `checkAvailability` poll is what preserves stickiness. The 15s connect timeout is cancelled once the queue activates; the queue runs its own `maxWaitMs`.

Session validity is checked separately via `isValidSession` → `validSession` / `throwToExceededTier` / `throwToBadRequest`.

### Connection recovery vs. session recovery

- **Transport blips** — Socket.IO's built-in `connectionStateRecovery`: if `socket.active` on disconnect, it auto-reconnects with exponential backoff + jitter and may restore the same socket (`socket.recovered === true`). A short blip doesn't tear down the avatar.
- **Recoverable transport drop** (within ~20s) — the **server preserves the session on the same instance**: the live STV/ASR session and in-memory state survive, and a re-`join` is not needed. **This SDK's `KalturaAvatarSession` relies on this** — it rides recovery, emits `reconnecting`/`reconnected`, and does not re-`join`.
- **Permanent disconnect** (`socket.active === false`, or past the recovery window) — the session is gone; the avatar must reconnect fresh (new `stickyId`, likely a different instance, new agent slot). Same-instance resume exists (above); **cross-instance resume does not** — only the brain thread is resumable via `threadId`.
- Distinct timeouts pinpoint where it broke: `HANDSHAKE_TIMEOUT` (transport up, server silent → activate queue) vs `CONNECTION_TIMEOUT` (transport never came up).

### Externalized state

Slot accounting is centralized, not per-instance guesswork: `checkAvailability` consults a shared store. A slot is available when **STV has free capacity** (unless the call is speech-only) **AND the ASR service is available AND `activeCalls < maxCalls`**. `availabilityResult.details` surfaces exactly these: `{stvAvailable, whisperAvailable, activeCalls, maxCalls, capacityAvailable}`. The brain conversation/thread state is also externalized: the same thread is resumable via `threadId` regardless of which instance handles a later turn over the text API.

For what a custom (no-Kaltura-lib) client must implement to work correctly with this scaling model, see [Architecture Recipe's "Implications for a Custom Client"](/reference/architecture-recipe/#implications-for-a-custom-no-kaltura-lib-client).

## Related docs

| Doc | Covers |
|---|---|
| [Architecture Reference · Connection and Handshake](/reference/architecture-reference/connection-and-handshake/) | The connect sequence this queue sits alongside |
| [Architecture Reference · Resilience and Failure Handling](/reference/architecture-reference/resilience-and-failure-handling/) | The failure-mode matrix that references `throwToNoAgent`/`throwToExceededTier` |
| [Architecture Reference](/reference/architecture-reference/) | Back to the index |

