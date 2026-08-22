> **NOT IMPLEMENTED.** Every API on this page is a **draft design contract**, not shipped
> code. Nothing here can be imported, called, or relied on today. Each section states what
> backend work is missing before the contract can become real code, and links the tracking
> issue. Treat this page the way you'd treat an RFC: it exists so an implementer (SDK or
> backend) has a concrete shape to build against and review, not so an integrator can start
> calling it.
>
> These contracts are **drafted by automated investigation, not reviewed by the Kaltura
> backend team.** "Documented" here does not mean "reviewed and approved" — that review is
> still pending for every contract on this page. Do not cite this page as evidence that a
> capability is planned for a specific release.

This is the registry for capabilities from the [SDK roadmap](https://github.com/kaltura/intelligent-agents-sdk/issues/46) that need new backend primitives before the SDK can ship a real client. When a contract here gets backend-team sign-off and a real endpoint, it moves out of this file into [API-REFERENCE.md](../API-REFERENCE.md) as shipped documentation, and this file's entry is deleted (not archived — `git log` is the archive).

---

## Contents

| Capability | Tracking issue | Blocked on |
|---|---|---|
| [Memory — structured per-user key/value facts](#memory--structured-per-user-key-value-facts-issue-38) | [#38](https://github.com/kaltura/intelligent-agents-sdk/issues/38) | New backend storage primitive (none exists today) + [#36](https://github.com/kaltura/intelligent-agents-sdk/issues/36) (session→userId binding, **PR [#48](https://github.com/kaltura/intelligent-agents-sdk/pull/48), not yet merged**) |

---

## Memory — structured per-user key/value facts (issue #38)

**Status: DRAFT CONTRACT — NOT IMPLEMENTED.** No backend storage primitive for
structured per-user facts exists today (confirmed by investigation in issue #38). This
section is the SDK-side interface the issue's own "How" asks for, so the backend team has
a concrete contract to build against — it is not a preview of an in-progress feature.

### Why this shape

Today the only way to give an agent continuity across sessions is to replay a prior
thread's full transcript into a new conversation (`Threads.transcript()` +
`request_vars`/prompt injection) — expensive on every turn, unstructured, and it doesn't
scale past a handful of past sessions per user. `Memory` is additive: a structured
key/value layer for discrete facts (preferences, progress state, prior answers) that sits
alongside transcript replay, not instead of it. **Existing full-transcript-replay
integrations are unaffected by this contract** — nothing about `Threads`/`Conversations`
changes.

### Dependency on issue #36

Memory is keyed by `userId`. `Sessions.createConversationToken({ userId })` (issue #36,
[PR #48](https://github.com/kaltura/intelligent-agents-sdk/pull/48)) is the mechanism that
binds a session to a real end-user identity — **PR #48 is open, not merged, as of this
writing.** Until it merges, there is no real `userId` to key memory against; this contract
assumes it has landed.

### Where it would live

`./management`, alongside `Conversations`/`Threads`/`Knowledge` in `src/management/`. A new
`Memory` class, instantiated once per `Management` instance as `mgmt.memory` — same pattern
as `mgmt.threads`, `mgmt.knowledge` (see `src/management/index.js`, `src/management/client.js`'s
`Ctx`).

**Token scope: admin only** (`assertAdmin`, same guard `Threads`/`Knowledge` use), not
conversation-scoped. Rationale: a conversation KS is handed to the browser/end-user client
(entitlement ON, no admin secret) — letting it write arbitrary key/value facts under a
`userId` would let any client-side caller forge or overwrite another user's stored facts
just by guessing/observing a `userId`. Writing and reading memory should happen from the
integrator's own server (which already knows and authenticates the real end user), the same
trust boundary `Threads.delete()` and the Knowledge CRUD already assume. If a future
iteration needs a narrower "read my own facts" conversation-scoped call, that is a separate,
additive contract — not part of this draft.

### Method signatures

```js
/**
 * @param {string} userId         Real end-user identity (same value passed to
 *                                 Sessions.createConversationToken({userId})).
 * @param {string} key             Fact key. [a-zA-Z0-9_.-]{1,128}, application-namespaced
 *                                 by convention (e.g. "onboarding.step", "pref.language").
 * @param {string|number|boolean|null} value  Scalar only — same constraint prompt-lint
 *                                 already enforces on request_vars (see RESERVED_VARS /
 *                                 validatePromptVars in src/management/conversations.js).
 *                                 No arrays/objects in v1: keeps the value trivially
 *                                 safe to interpolate into a prompt later, and keeps the
 *                                 size budget easy to reason about.
 * @param {{ifMatch?: number}} [opts]  Optimistic-concurrency guard — see "Concurrent
 *                                 writes" below.
 * @returns {Promise<{key: string, version: number, updatedAt: string}>}
 * @throws {KalturaError} bad_request | validation_error | value_too_large | conflict
 */
async function set(userId, key, value, opts) {}

/**
 * @param {string} userId
 * @param {string} key
 * @returns {Promise<{key: string, value: string|number|boolean|null, version: number,
 *                    updatedAt: string} | null>}   null (not an error) when the key has
 *                    never been set for this user — mirrors ordinary KV-store GET
 *                    semantics, not a 404 KalturaError, since "no fact recorded yet" is
 *                    the expected steady state for a brand-new user.
 * @throws {KalturaError} bad_request (malformed userId/key)
 */
async function get(userId, key) {}

/**
 * @param {string} userId
 * @param {{pageSize?: number, keyPrefix?: string}} [opts]  keyPrefix scopes listing to
 *                    one namespace (e.g. "onboarding.") — expected to be the common case
 *                    once integrators have more than a handful of facts per user.
 * @returns {Page<{key: string, value: string|number|boolean|null, version: number,
 *                 updatedAt: string}>}   Same async-iterable-and-thenable `Page` shape as
 *                 `agents.list()`/`Threads.list()` (see src/management/paginate.js) — not
 *                 a new pagination convention.
 * @throws {KalturaError} bad_request
 */
function list(userId, opts) {}

/**
 * @param {string} userId
 * @param {string} key
 * @param {{confirmPermanent: boolean}} confirm   Same explicit-confirm destructive-call
 *                    pattern as `Threads.delete()` — a typo'd key must not silently no-op
 *                    a delete a caller thinks succeeded, and a real delete must not be
 *                    reachable by accident.
 * @returns {Promise<void>}
 * @throws {KalturaError} bad_request | not_found | precondition_required (confirm missing)
 */
async function del(userId, key, confirm) {}
```

`set`/`get`/`list`/`delete` all require an **admin KS** (`ctx.assertAdmin(ks, 'memory.<method>')`),
matching `Threads`'s guard.

### Error semantics

| Condition | Behavior | `code` |
|---|---|---|
| `userId` missing/empty/non-string | Throw before any network call | `bad_request` |
| `key` missing, empty, or fails `[a-zA-Z0-9_.-]{1,128}` | Throw before any network call | `bad_request` |
| `value` is an array/object (non-scalar) | Throw before any network call — same rule as `request_vars` | `validation_error` |
| `value` serialized exceeds the size budget (proposed: 4 KB per value, TBD with backend) | Throw | `value_too_large` |
| `userId` well-formed but unknown to the backend (no session has ever bound it) | **Proposed:** not an error — `set` creates the first fact for that `userId` on demand (no separate "create user" step), `get`/`list` behave as if no facts exist (`null` / empty page) | n/a (no error) |
| `get`/`list` on a `userId` with zero facts recorded | Not an error — `get` returns `null`, `list` returns an empty page | n/a (no error) |
| `delete` called without `{confirmPermanent: true}` | Throw before any network call, same as `Threads.delete()` | `precondition_required` (proposed; `Threads.delete()`'s existing `requireConfirm` throws `bad_request` today — needs backend-team alignment on whether Memory reuses that code or gets its own) |
| `delete` on a key that doesn't exist | Backend TBD: idempotent no-op (delete-of-nonexistent succeeds) vs. `not_found`. **Proposed default: idempotent no-op**, consistent with `Rule R-3`-style idempotency the rest of the SDK favors, but this is a genuine open question for the backend team, not a settled decision. | `not_found` if backend chooses non-idempotent |
| Concurrent writes to the same `(userId, key)` | **Proposed:** optimistic concurrency via `version` — `set(..., {ifMatch: <version>})` fails if the stored version has moved on since the caller last read it. Omitting `ifMatch` always overwrites (last-write-wins), matching the "opts is optional" pattern the rest of the SDK uses for opt-in strictness. | `conflict` |
| Backend storage unavailable / 5xx | Passed through the SDK's existing `errorFromResponse()` normalization (`src/core/errors.js`) — no special-casing | `server_error` (or whatever `codeForStatus` maps) |
| Session's KS is a conversation token, not admin | Throw before any network call, same `assertAdmin` guard every other admin-only method uses | `forbidden` (`assertKind` in `src/management/client.js`) |

### Versioning

This is contract **v1 (draft)**. Backward-incompatible changes to method names, parameter
order, or return shapes before a real implementation ships are expected and don't need a
deprecation cycle — nothing has shipped yet. Once a real backend endpoint exists and this
moves to `API-REFERENCE.md`, normal semver/deprecation rules apply like any other shipped
method.

### What this document does and does not resolve (issue #38 success criteria)

| Issue #38 success criterion | Status |
|---|---|
| "A documented, versioned API contract exists for `Memory.set/get/list`, reviewed with the backend team." | **Partially met.** The contract is documented and versioned (this section, v1 draft). It has **not** been reviewed with the backend team — that review is still pending. Do not treat this document as backend-approved. |
| "Once backing storage ships: writing a fact for a user in one session and reading it back in a later session works live, verified by a test." | **Not met — blocked.** No backend storage primitive exists. This is future work gated on the backend team building it, then the SDK team implementing the real client against this (or a revised) contract, then a live round-trip test. |
| "Existing full-transcript-replay integrations are unaffected — this is additive, not a replacement." | **Met by design.** Nothing in this contract touches `Conversations`, `Threads`, or `Messages`; see "Why this shape" above. |

### Next steps (for a human / the backend team)

1. Backend team reviews this contract (method shapes, error codes, value-size limit,
   concurrency model, delete idempotency) and either approves it or proposes changes.
2. Backend team builds the real storage primitive + endpoint(s).
3. SDK team implements the real `Memory` class in `src/management/`, exported from
   `src/management/index.js`, following the reviewed contract (which may differ from this
   draft after step 1).
4. Move this section from `docs/PROPOSED-APIS.md` into `API-REFERENCE.md` as shipped
   documentation, with a worked example.
5. Write the live round-trip test issue #38's success criteria calls for (write in one
   session/thread, read back in a different one) — cannot be written honestly before step 2.
