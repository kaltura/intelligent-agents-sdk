# SDK Constitution

Strict, testable engineering rules for `@kaltura/intelligent-agents`.

Each rule is machine-verifiable by `scripts/agent_verify.mjs`. The verify script is the only valid proof of compliance — a natural-language declaration of "done" is not acceptable.

---

## Part 1 — Isolation (multiple instances)

**Rule I-1: No module-level mutable state.**  
Every module-level variable in `src/` must be `const` and must not be mutated after its initializer runs. Arrays, Sets, Maps, and plain objects that are module-level must be either `Object.freeze()`d or provably local to the function that reads them.

*Verify:* `agent_verify.mjs` greps `src/**/*.js` for `let ` at the module top level (before any `class` or `export function` declaration). Any hit is a violation.

**Rule I-2: No writes to `window`, `globalThis`, or `self`.**  
The SDK must never assign a property to `window`, `globalThis`, or `self`. Reads of platform APIs (`globalThis.fetch`, `globalThis.crypto`, etc.) are permitted; writes are not.

*Verify:* grep for `globalThis\.\w+\s*=` / `window\.\w+\s*=` / `self\.\w+\s*=` in `src/`. No matches is the passing state.

**Rule I-3: Class-based encapsulation — no cross-instance state leakage.**  
All configuration (`partnerId`, `adminSecret`, endpoints, tokens) must be stored as instance properties of the class that owns them. Submodule classes must receive their context from the owning `Management` or `KalturaAvatarSession` instance only — never from a shared module-level cache or singleton.

*Verify:* Instantiate two `Management` objects with different credentials in the same process and run ten concurrent token mints across both; confirm no credential bleed. This test lives in `test/unit/isolation.test.js`.

**Rule I-4: Event-listener cleanup.**  
Any event listener added to `window`, `globalThis`, `document`, or a socket MUST be removed when the owning instance is disconnected or destroyed.

*Verify:* The isolation test in `test/unit/isolation.test.js` asserts that `_unwireNetwork()` removes the `online`/`offline` handlers added by `_wireNetwork()`.

---

## Part 2 — Security (AppSec / CSP compliance)

**Rule S-1: No `eval()`, `new Function()`, or equivalent dynamic code execution.**  
`eval`, `new Function(…)`, `Function()`, `setTimeout(string, …)`, `setInterval(string, …)`, and `document.write()` are banned in `src/`.

*Verify:* grep. Zero matches required.

**Rule S-2: No `innerHTML`, `outerHTML`, or `insertAdjacentHTML` assignments.**  
All DOM mutation must go through `textContent`, `createElement`/`appendChild`, or similar structural DOM APIs. Comment nodes (`createComment`) are fine.

*Verify:* grep for `\.innerHTML\s*=` / `\.outerHTML\s*=` / `insertAdjacentHTML\s*\(` in `src/`. Zero assignment matches required. (Comment strings that say "no innerHTML" are not matches — grep for the assignment operator specifically.)

**Rule S-3: All user-supplied URLs must pass through `safeUrl()`.**  
Any URL that originates from untrusted input (LLM output, user message, external API response) before being set as `href`, `src`, or passed to `fetch` must be validated by `core/safety.js#safeUrl`. `safeUrl` returns `''` for `javascript:`, `data:`, and authority-relative `//host` patterns. It also returns `''` for any URL carrying embedded userinfo credentials (`https://user:pass@host/...`) — a phishing/link-spoofing vector distinct from classic XSS, since an attacker-controlled label could otherwise point at a credential-dressed host that looks trusted.

*Verify:* The `safeUrl` unit test in `test/unit/safety.test.js` asserts that `javascript:`/`data:`/`vbscript:` schemes, authority-relative `//host` URLs, and embedded-userinfo URLs (`user:pass@host`) all resolve to `''`, while the https/http/mailto/tel allowlist and relative paths pass through unchanged.

**Rule S-4: No prototype pollution.**  
JSON objects arriving from any external source (LLM, API response, user input) must pass through `sanitizeJson()` from `core/safety.js` before being merged into any plain object. `sanitizeJson` strips `__proto__`, `constructor`, and `prototype` keys recursively.

*Verify:* `test/unit/safety.test.js` ("sanitizeJson drops prototype-pollution keys, keeps data") asserts `sanitizeJson()` strips `__proto__` from a plain object. `test/e2e/security.test.js` ("setDynamicPrompt scrubs prototype-pollution keys, keeps real data") asserts the same for `setDynamicPrompt({ __proto__: { x: 1 } })` end-to-end: it does not pollute `Object.prototype`.

**Rule S-5: Admin secret non-enumerable and non-serializable.**  
`_adminSecret` must be stored with `Object.defineProperty` as `{ enumerable: false, configurable: false, writable: false }`. It must not appear in `JSON.stringify(instance)` or in a `for…in` loop over the instance.

*Verify:* `test/unit/isolation.test.js` "admin secret non-enumerable" test.

**Rule S-6: No hard-coded credentials or token literals.**  
`src/` must contain no string matching a KS token pattern (`djJ8…`) or a 32-character hex secret, outside of test fakes and the redaction regex itself.

*Verify:* grep for `djJ8` and 32-char lowercase hex literals in `src/`. Only the regex pattern in `core/redact.js` and test fixtures are allowed.

---

## Part 3 — Resiliency

**Rule R-1: Exponential backoff on transient network failures.**  
`Http.request()` must retry using truncated exponential backoff with full jitter. A network-layer error (status 0, no response received) is retried on every method. A received HTTP 429, 502, 503, or 504 is retried only for `GET`/`HEAD`, or for another method that carries an `Idempotency-Key` (see Rule R-3) — a plain `POST`/`PUT`/`PATCH`/`DELETE` without one is not retried on a received transient status, since the server may already have processed it. Non-retriable failure codes (400, 401, 403, 404, 405, 409, 422) must NOT be retried — retrying auth failures wastes quota and delays the caller.

Retry parameters (defaults, all configurable via `HttpOptions`):
- `maxRetries`: 3 (total attempts = 4)
- `baseDelayMs`: 200 ms
- `maxDelayMs`: 10 000 ms (10 s)
- Backoff formula: `min(maxDelayMs, baseDelayMs * 2^attempt) * random(0.5, 1.0)`

**Rule R-2: Idempotent GETs are always safe to retry.**  
`GET` requests carry no body and are safe to retry on any transient failure without an idempotency key.

*Verify:* `test/unit/http.test.js` ("R-2: GET requires no idempotency key to be retry-safe") asserts a GET is retried on a transient failure with no `idempotencyKey` passed at all.

**Rule R-3: POSTs that carry an `Idempotency-Key` header are retry-safe.**  
`Http.postJson()` already accepts an `idempotencyKey` option and forwards it as the `Idempotency-Key` request header. A POST with this header set is safe to retry; a POST without it is retry-safe only on a network-layer failure (status 0) where the request may never have reached the server.

**Rule R-4: Retry budget does not consume the caller's `AbortSignal`.**  
If the caller cancels via `signal`, the retry loop must stop immediately and throw without starting the next attempt. The existing `mergeSignals()` helper already handles per-attempt abort; Rule R-4 requires that a cancelled signal also breaks the retry loop.

**Rule R-5: Retry behaviour must be fully exercisable offline.**  
The backoff delay must be injectable (`delayFn` option, default `(ms) => new Promise(r => setTimeout(r, ms))`) so tests can pass `() => Promise.resolve()` and exercise all retry paths at zero wall-clock cost.

*Verify:* `test/unit/http.test.js` must include tests that: (a) assert a 503 response is retried up to `maxRetries` times and then throws; (b) assert a 429 response is retried; (c) assert a 401 response is NOT retried; (d) assert a `POST` with no idempotency key IS retried on status-0 (network error, no bytes sent) but NOT on a received HTTP error like 503 (bytes were sent; the server may have processed it); (e) assert that if `signal.abort()` is called mid-retry loop, the loop stops.

**Rule R-6: `connect()` never waits on, and never fails for, the microphone.**  
Mic acquisition runs alongside the connect handshake. A denied, missing or busy mic emits one `warning` (`mic_permission_denied`, `mic_not_found`, `mic_in_use`) and the session connects mic-less; typed turns keep working. `startMic()` called explicitly still throws, because an explicit call wants the error. The only allowed `micStartMode` values are `'immediate'` and `'deferred'`.

*Verify:* `test/e2e/mic-concurrency.test.js` proves `connect()` resolves with the mic still pending, and that a denied mic yields `warning` + `connected`. `test/e2e/deferred-mic.test.js` proves the mic-less path and that `micStartMode: 'required'` is rejected with `bad_request`. `agent_verify.mjs` greps `src/experience/session.js` for the `'immediate'`/`'deferred'`-only validation and checks those test needles exist.

**Rule R-7: Turn state changes only on named socket events, never on timers.**  
Held `speak()`/`kickoff` text is released by `stvFinishedTalking` or `agentInterrupted`, and dropped by `disconnect()`/`ended`/`error`. No `setTimeout` watchdog may release, drop or re-send a held turn, because a timer-driven release produces bugs that cannot be reproduced from an event log.

*Verify:* `test/unit/kickoff.test.js` covers every row of the hold/release table (release on both events, drop on `disconnect()`, survival across `resume()` and a cold reconnect). `agent_verify.mjs` greps `src/experience/session.js` for `setTimeout`/`setInterval` within the `_endUninterruptibleTurn`/`_dropHeldTurns`/`_maybeSendKickoff` bodies. Zero matches required.

---

## Part 4 — Performance

**Rule P-1: Response payload size budget.**  
`Http.request()` must enforce a configurable maximum response body size. The default limit is 10 MB. If `Content-Length` exceeds the limit before reading, or if the accumulated body text exceeds the limit, throw a `KalturaError` with `code: 'response_too_large'`.

*Verify:* `test/unit/http.test.js` asserts that a fake response whose `Content-Length` or body size exceeds `maxResponseBytes` throws `response_too_large`.

**Rule P-2: No synchronous blocking operations in the SDK's hot paths.**  
The SDK must not call `JSON.parse` on arbitrarily large strings without a size guard. All JSON parsing goes through `parseBody()` in `core/http.js`, which already runs after the response is received — Rule P-1's size guard is the enforcement point.

**Rule P-3: The SDK has zero runtime dependencies.**  
`package.json` must list no `dependencies` (only `devDependencies` for test tooling). Injectable transports (`fetch`, `socketFactory`, `rtcConstructor`, `getUserMedia`) are the deliberate points of external integration.

*Verify:* Parse `package.json` and assert the `dependencies` key is absent or empty.

---

## Part 5 — DX and Clean Code

**Rule D-1: All public exports must carry JSDoc.**  
Every `export`ed `class`, `function`, and `const` in `src/` must have a JSDoc block with at minimum: a one-line description plus `@param` for every named parameter and `@returns` for non-void returns.

Private / internal helpers (unexported, or named with `_`) are exempt.

*Verify:* `agent_verify.mjs` scans `src/**/*.js` for exported symbols without a preceding `/**` block.

**Rule D-2: No dead code (exported symbols with zero consumers).**  
Symbols that are exported from an internal module but neither re-exported from an entry point (`src/management/index.js`, `src/experience/index.js`) nor used by any other module in `src/` are dead. Flag them. Do not delete without confirming they are also absent from all `apps/` and `tools/` consumers.

*Verify:* `agent_verify.mjs` cross-references exports vs. imports. Any symbol exported but never imported anywhere is flagged as dead code (warning, not error, on first pass — must be manually confirmed before deletion).

**Rule D-3: No `TODO`, `FIXME`, or `HACK` comments in shipped code.**  
These comments indicate incomplete implementations. Track them as a GitHub issue instead.

*Verify:* grep `src/` for `TODO\|FIXME\|HACK\|XXX\|STUB`. Zero matches required.

**Rule D-4: Lifecycle discipline — typed `invalid_state`, idempotent teardown.**  
Every session class (`KalturaAvatarSession`, `KalturaChatSession`, `KalturaAgentSession`, `KalturaScriptedVideoSession`) must:

- (a) throw a `KalturaError` with `code: 'invalid_state'` when a lifecycle method is called from a state where it cannot act (`sendText()` before `connect()`, a second `connect()`, any post-`disconnect()` call);
- (b) make teardown-shaped methods (`disconnect()`) and same-target transitions (`switchMode(<current mode>)`) idempotent no-ops — a repeat call must not throw, change state, or emit a duplicate `ended`.

This is deliberately NOT blanket idempotency: constructive lifecycle calls (`connect()`, `switchMode(<other mode>)`) stay once-only and throw typed `invalid_state` on misuse, so callers discover sequencing bugs immediately instead of silently double-connecting.

Media binding and audio-output setters (`setVideoEl`, `setAudioEl`, `muteAudioOutput`, `unmuteAudioOutput`, `setAudioOutputVolume`, `setAudioOutput`, `startPlayback`) are configuration, not lifecycle: they work before `connect()`, while connected, and after `disconnect()`, and never throw `invalid_state`. Frameworks call cleanup in arbitrary order (React unmount, Vue `onUnmounted`), so these must stay safe to call at any time.

*Verify:* `agent_verify.mjs` asserts every session class constructs `code: 'invalid_state'` errors, and that the lifecycle tests (`test/unit/chat-session.test.js` "connect is once-only; disconnect idempotent", `test/unit/agent-session.test.js` same-target no-op + idempotent disconnect) exist; the suite run proves them green. `test/unit/avatar-media.test.js` and `test/unit/session-media.test.js` prove the media setters are state-independent.

**Rule D-5: `kickoff` is sent at most once per session object.**  
The `kickoff` option on `KalturaAvatarSession`, `KalturaChatSession` and `KalturaAgentSession` is sent exactly once, the first time the server accepts input. It is never re-sent on `resume()`, a cold reconnect, or `switchMode()`. Empty or omitted means nothing is sent. Any other shape throws `bad_request` at construction, before any network call.

*Verify:* `test/unit/kickoff.test.js` (avatar: once, not after `resume()`, not after a cold reconnect, disclosure-gated), `test/unit/chat-session.test.js` "kickoff" block (once per `connect()`), `test/unit/agent-session.test.js` (first transport only; the `switchMode()` transport has no `kickoff`).

---

## Part 6 — Media path

**Rule M-1: The avatar media path is pure track routing.**  
`src/experience/avatar-media.js` owns how downlink tracks reach the app's elements (one merged stream on `videoEl`, or video/audio split across `videoEl` + `audioEl`, or headless via `avatarStream`). It must not create DOM, read `document`, install timers, or write to `console`. Elements come from the app; readiness timing stays in `session.js`; diagnostics go through the injected logger. This keeps the media path deterministic, testable over fakes, and free of hidden global side effects when several avatars share one page.

*Verify:* `agent_verify.mjs` greps `src/experience/avatar-media.js` for `document\.`, `createElement`, `setTimeout`, `setInterval`, `requestAnimationFrame`, `console\.`. Zero matches required.

**Rule M-2: The raw silent opening phrase never reaches a listener.**  
When the opening phrase is `SILENT_OPENING` (`<blank>`), the opening turn surfaces as `SILENT_OPENING_LABEL` (`[silence]`) on `transcript`, `speechChunk` and `avatarStopTalking.text`, so a UI can render it as-is. `avatarStartTalking`/`avatarStopTalking` still fire (they drive the `speak()` hold). The relabel applies only to the opening turn's speech id; a `<blank>` in a normal reply is left alone.

*Verify:* `test/unit/kickoff.test.js` "silent opening" tests: `<blank>` on the opening speech id surfaces as `[silence]` on transcript/speechChunk/stop and the raw phrase never reaches a listener; a spoken opening still surfaces; `<blank>` on a normal reply is not relabelled.

**Rule M-3: The downlink subscription is released wherever it is dropped or replaced.**  
Closing the downlink peer locally does not free the server's side of the subscription. Every path that closes or replaces that peer (teardown from `disconnect()`/`ended`/`error`, media recovery after an ICE drop, a cold reconnect, `resume()`) releases the subscription through one idempotent helper, which clears the stored location before sending the release, so no path leaks one and no path releases the same one twice. Exactly one site stores a location, so a re-subscribe can never overwrite an unreleased one. A subscription answered after the session already gave up (the app disconnected while the answer was being read, the connect deadline expired, or the other connect lane failed) is released on the spot, because it is never stored.

*Verify:* `agent_verify.mjs` checks the single store site, the clear-then-release helper shape, a release near every peer close, and all three abort lanes; `connect.test.js`, `connect-concurrency.test.js`, `connect-cancel.test.js` and `resilience.test.js` count the releases over disconnect, the error path, a disconnect mid-handshake, the connect deadline, ICE recovery, cold reconnect and `resume()`.

---

## Compliance summary

This table summarizes what each rule checks, not whether it currently passes — for current pass/fail status, run `npm run verify` (`scripts/agent_verify.mjs`), the only valid proof of compliance per the note at the top of this document.

| Rule | Category | What it checks | How to verify |
|------|----------|-----------------|---------------|
| I-1 | Isolation | No `let` at module top level | grep |
| I-2 | Isolation | Only reads of `globalThis`/`window`/`self`, never writes | grep |
| I-3 | Isolation | No cross-instance credential/state leakage | isolation.test.js |
| I-4 | Isolation | Event listeners removed on disconnect/destroy | isolation.test.js |
| S-1 | Security | No `eval` / `new Function` / equivalent | grep |
| S-2 | Security | No `innerHTML`/`outerHTML`/`insertAdjacentHTML` assignments | grep |
| S-3 | Security | Untrusted URLs pass through `safeUrl` | safety.test.js |
| S-4 | Security | Untrusted JSON passes through `sanitizeJson` | safety.test.js + security.test.js |
| S-5 | Security | Admin secret is non-enumerable | isolation.test.js |
| S-6 | Security | No hardcoded credentials or token literals | grep |
| R-1 | Resiliency | Exponential backoff with full jitter in `Http.request()` | see R-5 |
| R-2 | Resiliency | GETs retried on any transient failure | http.test.js |
| R-3 | Resiliency | Idempotency-key POSTs retried; non-keyed POSTs retried only on status-0 | see R-5 |
| R-4 | Resiliency | Abort signal stops the retry loop immediately | http.test.js |
| R-5 | Resiliency | Injectable `delayFn`, retries exercised at zero wall-clock cost | http.test.js |
| R-6 | Resiliency | `connect()` never waits on or fails for the mic; denial → `warning`, session mic-less | mic-concurrency.test.js + deferred-mic.test.js |
| R-7 | Resiliency | Held turns released/dropped only on named socket events, never timers | kickoff.test.js + grep |
| P-1 | Performance | `maxResponseBytes` enforced on `Content-Length` and body size | http.test.js |
| P-2 | Performance | JSON parsing happens post-read, size-guarded | see P-1 |
| P-3 | Performance | Zero runtime dependencies | package.json |
| D-1 | DX | All public exports carry JSDoc | scan |
| D-2 | DX | See Rule D-2 above — candidate dead exports (warning, not error) | `node scripts/agent_verify.mjs` |
| D-3 | DX | No TODO/FIXME/HACK/XXX/STUB found | grep |
| D-4 | DX | Typed `invalid_state` on lifecycle misuse; idempotent teardown/same-target no-ops; media setters state-independent | grep + lifecycle tests |
| D-5 | DX | `kickoff` sent at most once per session object; never on `resume()`/reconnect/`switchMode()` | kickoff.test.js + chat/agent-session tests |
| M-1 | Media | `avatar-media.js` has no `document`, DOM creation, timers or `console` | grep |
| M-2 | Media | Silent opening surfaces as `SILENT_OPENING_LABEL` on `transcript`/`speechChunk`/`avatarStopTalking.text`, never as the raw phrase | kickoff.test.js |
| M-3 | Media | Every path that drops or replaces the downlink releases its subscription exactly once | grep + connect/connect-concurrency/connect-cancel/resilience tests |

Rule D-2 warns rather than errors by design — see Rule D-2 above for why.
