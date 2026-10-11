---
layout: base.njk
title: "Architecture Reference · Scale and Sticky Sessions"
description: "Sticky routing, the capacity queue, connection vs. session recovery, and externalized session state."
eyebrow: Reference
---

# Scale & Sticky Sessions

[← Back to Architecture Reference](/reference/architecture-reference/)


Three things matter to a client: sticky routing, capacity handling, and what survives a reconnect.

## Sticky routing: `stickyId`

Send the same `stickyId` on every socket connection, and do not rotate it mid-session.

- The SDK generates a `stickyId` once per session (16 random characters, or your own value via the `stickyId` option). It does not change it on each `connect()`.
- It goes out as a **socket query param** (`query.stickyId`), so it goes out on every socket connection the SDK opens. The SDK uses the WebSocket transport only.
- Read it with `getStickyId()`.
- It is kept for the whole session, including a cold reconnect. A rebuilt socket carries the same `stickyId`.
- A new `KalturaAvatarSession` gets a new `stickyId`.

The STV video channel needs no stickiness. It is a plain WHEP stream, independent of the control socket.

## Capacity & the queue (`throwToNoAgent` / `throwToExceededTier`)

The number of live avatars is limited. There are two "full" signals:

| Signal | Meaning | SDK behavior |
|---|---|---|
| `throwToNoAgent` | No free agent slot (transient) | `connect()` rejects with `capacity_unavailable` (6001, retryable). |
| `throwToExceededTier` | Account plan/tier limit hit (hard) | `connect()` rejects with `tier_exceeded` (6002, not retryable). |

After either signal the server closes the socket. To retry, call `connect()` again, or wait first with `waitForCapacity()`.

All capacity codes are `KalturaError` values. `status` is an SDK number, not an HTTP status.

| `err.code` | `status` | Retry? | Raised by |
|---|---|---|---|
| `capacity_unavailable` | `6001` | Yes, later | `connect()`, and the session `error` event |
| `tier_exceeded` | `6002` | No. Check the plan with your Kaltura contact. | `connect()`, and the session `error` event |
| `capacity_timeout` | none | Yes, call `waitForCapacity()` again | `waitForCapacity()` only |

**During `connect()`:**

- The SDK sends `stvNewSession` at once and also polls `checkAvailability` on the same socket. The poll never disconnects, so stickiness is kept.
- Every `availabilityResult` is re-emitted as `capacityChanged { available, details }`.
- If `available` is `false`, the SDK polls again after a delay. The delays are `[30s, 45s, 60s, 90s, 120s, 180s, 240s, 300s, 360s]` with ±15% jitter. After the last one it keeps using 360s.
- The wait shares the 30 s overall connect deadline. It is **not** paused while queued, so a long wait can end in `ConnectTimeout`.

**Waiting longer, before `connect()`:** `waitForCapacity({ maxWaitMs, pollIntervalMs })`.

| Option | Default | Meaning |
|---|---|---|
| `maxWaitMs` | `300000` | Give up after this long with `capacity_timeout`. |
| `pollIntervalMs` | `5000` | Time between `checkAvailability` polls. |

It opens its own light socket, uses no slot, and resolves `{ available: true, details? }` as soon as a slot is free. It also emits `capacityChanged` on each reply. See [Architecture Reference · Connection and Handshake](/reference/architecture-reference/connection-and-handshake/#full-connect-sequence-state-machine-order).

## What survives a reconnect

Only the brain **thread** resumes across sessions, via `threadId`. The recovery layers are in [Architecture Reference · Resilience and Failure Handling](/reference/architecture-reference/resilience-and-failure-handling/).

## Slot data

`availabilityResult.details` is passed through from the server as an optional, informational object. The SDK does not read it. Treat it as optional.

For what a custom (no-Kaltura-lib) client must implement to work with this model, see [ARCHITECTURE-RECIPE.md's "Implications for a Custom Client"](https://github.com/kaltura/intelligent-agents-sdk/blob/main/docs/ARCHITECTURE-RECIPE.md#implications-for-a-custom-no-kaltura-lib-client).

## Related docs

| Doc | Covers |
|---|---|
| [Architecture Reference · Connection and Handshake](/reference/architecture-reference/connection-and-handshake/) | The connect sequence this queue sits alongside |
| [Architecture Reference · Resilience and Failure Handling](/reference/architecture-reference/resilience-and-failure-handling/) | The failure-mode matrix that references `throwToNoAgent`/`throwToExceededTier` |
| [Architecture Reference](/reference/architecture-reference/) | Back to the index |

