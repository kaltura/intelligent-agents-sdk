---
layout: base.njk
title: "Architecture Reference · Scale and Sticky Sessions"
description: "Sticky routing, the capacity queue, connection vs. session recovery, and cross-pod shared state."
eyebrow: Reference
---

# Scale & Sticky Sessions

[← Back to Architecture Reference](/reference/architecture-reference/)


The session server runs as a **horizontally-scaled pool of pods** behind a load balancer, with a fixed number of concurrent avatar "agent slots" per pod. Three mechanisms make this work: sticky routing, a capacity queue, and shared cross-pod state.

### Sticky routing — `stickyId`

The single most important scaling detail. A live avatar session is **stateful and pinned to one pod** (it owns the ASR peer connection, the speech pipeline, and the brain conversation). Socket.IO starts on HTTP long-**polling** and only later upgrades to WebSocket — those initial polling requests must all reach the *same* pod, or the handshake breaks.

- The client generates a fresh `stickyId` per `connect()` — `nanoid(16)` in the platform's built-in client, `generateId(8)+generateId(8)` in the embed SDK. Both are 16-char random tokens.
- It is sent as a **socket query param** (`query.stickyId`), so it's present on every polling request and the WebSocket upgrade.
- The load balancer hashes/affixes on it to route all of that session's requests to one session-server pod.
- Generated per-connection, not persisted: a brand-new `connect()` gets a new pod assignment. There is **no session migration** across pods — a pod loss ends the session (see recovery below).

The STV video channel does **not** need stickiness — it's stateless SRS WHEP (`srs.avatar.us.kaltura.ai`), scaled independently and frontable by CDN/anycast.

### Capacity & the queue (`throwToNoAgent` / `throwToExceededTier`)

Each pod has a bounded number of agent slots (the face-renderer + brain pipeline is expensive). Two distinct "full" signals:

| Signal | Meaning | Client behavior |
|---|---|---|
| `throwToNoAgent` | All agent slots currently busy (transient) | Enter **availability queue** (poll until a slot frees) |
| `throwToExceededTier` | Account plan/tier limit hit (hard) | Fail immediately — `TIER_EXCEEDED`, not recoverable |

**The queue (transient capacity):**

- Capacity is polled **out-of-band** via `checkAvailability` → `availabilityResult {available, …}`; that poll **never disconnects**, so the socket stays open during the wait. (Note: a `throwToNoAgent` returned from the `stvNewSession` path is *terminal* — the session server's join handler calls `socket.disconnect()` right after emitting it — so capacity handling is the proactive poll loop, not "react to `throwToNoAgent` on a live socket".)
- Poll delay cycle (embed SDK): `[30s, 45s, 1m, 1.5m, 2m, 3m, 4m, 5m, 6m]`, wrapping via modulo — effectively infinite backoff with a cap, bounded by `maxWaitMs`.
- The platform's built-in client mirrors this: an `availability` parallel state that loops `checkAgentsAvailability` (emit `checkAvailability`, await `availabilityResult`, 10s timeout) with a 5s retry delay while `unavailable`.
- When a positive `availabilityResult` arrives, the client emits **`join` (then `stvNewSession`) on the same socket** (same pod, sticky preserved) — no reconnect, state stays `CONNECTING`. The non-disconnecting `checkAvailability` poll is what preserves stickiness. The 15s connect timeout is cancelled once the queue activates; the queue runs its own `maxWaitMs`.

Session validity is checked separately via `isValidSession` → `validSession` / `throwToExceededTier` / `throwToBadRequest`.

### Connection recovery vs. session recovery

- **Transport blips** — Socket.IO's built-in `connectionStateRecovery`: if `socket.active` on disconnect, it auto-reconnects with exponential backoff + jitter and may restore the same socket (`socket.recovered === true`). A short blip doesn't tear down the avatar.
- **Recoverable transport drop** (within ~20s) — the **server preserves the session same-pod**: the session server's join handler enables Socket.IO `connectionStateRecovery` (`maxDisconnectionDuration = CONNECTION_STATE_RECOVERY_TIMEOUT`, default 20s, floor 5s, cap 10min); the live STV/ASR session + in-memory state survive and the `join` handler skips re-init (`session.hasJoined`). **This SDK's `KalturaAvatarSession` exploits this** — it rides recovery, emits `reconnecting`/`reconnected`, and does not re-`join`.
- **Permanent disconnect** (`socket.active === false`, or past the recovery window) — the session is gone; the avatar must reconnect fresh (new `stickyId`, likely a different pod, new agent slot). Same-pod resume exists (above); **cross-pod resume does not** — only the brain thread is resumable via `threadId`.
- Distinct timeouts pinpoint where it broke: `HANDSHAKE_TIMEOUT` (transport up, server silent → activate queue) vs `CONNECTION_TIMEOUT` (transport never came up).

### Cross-pod shared state (data plane)

Pods are stateless-enough to scale because shared state lives in managed backing services:

| Service category | Role in scaling |
|---|---|
| **Shared cache / state store** | Session cache, resource/slot accounting, and routing state — clustered and replicated |
| **Async work queue** | Hands off work between the renderer, brain, and pipeline stages |
| **Durable registry** | Session/agent registry & coordination that survives a pod restart |
| **STV renderer + media relay** | Video origin — renders the face and relays it to clients over **WHEP** (URL varies by `cast_mode`). Scaled independently of the control plane |
| **Edge (CDN + WAF)** | Fronts the public surface; enforces origin/CDN-header validation on public API endpoints |

So "agent availability" isn't per-pod guesswork — slot accounting is centralized in the shared state store, which is what `checkAvailability` consults. Concretely, a slot is available when **STV has free capacity** (unless the call is speech-only) **AND the ASR service is available AND `activeCalls < maxCalls`**; `maxCalls` comes from the `CALL_CAPACITY` env (default 20 in prod / 12 in non-prod). `availabilityResult.details` surfaces exactly these: `{stvAvailable, whisperAvailable, activeCalls, maxCalls, capacityAvailable}`. The brain conversation/thread state is also externalized (the same thread is resumable via `threadId` regardless of which pod handles a later turn over the text API).

For what a custom (no-Kaltura-lib) client must implement to work correctly with this scaling model, see [Architecture Recipe's "Implications for a Custom Client"](/reference/architecture-recipe/#implications-for-a-custom-no-kaltura-lib-client).

## Related docs

| Doc | Covers |
|---|---|
| [Architecture Reference · Connection and Handshake](/reference/architecture-reference/connection-and-handshake/) | The connect sequence this queue sits alongside |
| [Architecture Reference · Resilience and Failure Handling](/reference/architecture-reference/resilience-and-failure-handling/) | The failure-mode matrix that references `throwToNoAgent`/`throwToExceededTier` |
| [Architecture Reference](/reference/architecture-reference/) | Back to the index |

