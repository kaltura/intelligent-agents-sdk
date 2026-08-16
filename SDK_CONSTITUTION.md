# SDK Constitution

Strict, testable engineering rules for `@kaltura/intelligent-agents`.

Each rule is machine-verifiable by `scripts/agent_verify.mjs`. The verify script
is the only valid proof of compliance — a natural-language declaration of "done"
is not acceptable.

---

## Part 1 — Isolation (multiple instances)

**Rule I-1: No module-level mutable state.**
Every module-level variable in `src/` must be `const` and must not be
mutated after its initializer runs. Arrays, Sets, Maps, and plain objects that
are module-level must be either `Object.freeze()`d or provably local to the
function that reads them.

*Verify:* `agent_verify.mjs` greps `src/**/*.js` for `let ` at the module
top level (before any `class` or `export function` declaration). Any hit is a
violation.

**Rule I-2: No writes to `window`, `globalThis`, or `self`.**
The SDK must never assign a property to `window`, `globalThis`, or `self`.
Reads of platform APIs (`globalThis.fetch`, `globalThis.crypto`, etc.) are
permitted; writes are not.

*Verify:* grep for `globalThis\.\w+\s*=` / `window\.\w+\s*=` / `self\.\w+\s*=`
in `src/`. No matches is the passing state.

**Rule I-3: Class-based encapsulation — no cross-instance state leakage.**
All configuration (`partnerId`, `adminSecret`, endpoints, tokens) must be stored
as instance properties of the class that owns them. Submodule classes must
receive their context from the owning `Management` or `KalturaAvatarSession`
instance only — never from a shared module-level cache or singleton.

*Verify:* Instantiate two `Management` objects with different credentials in the
same process and run ten concurrent token mints across both; confirm no
credential bleed. This test lives in `test/unit/isolation.test.js`.

**Rule I-4: Event-listener cleanup.**
Any event listener added to `window`, `globalThis`, `document`, or a socket
MUST be removed when the owning instance is disconnected or destroyed.

*Verify:* The isolation test in `test/unit/isolation.test.js` asserts that
`_unwireNetwork()` removes the `online`/`offline` handlers added by `_wireNetwork()`.

---

## Part 2 — Security (AppSec / CSP compliance)

**Rule S-1: No `eval()`, `new Function()`, or equivalent dynamic code execution.**
`eval`, `new Function(…)`, `Function()`, `setTimeout(string, …)`,
`setInterval(string, …)`, and `document.write()` are banned in `src/`.

*Verify:* grep. Zero matches required.

**Rule S-2: No `innerHTML`, `outerHTML`, or `insertAdjacentHTML` assignments.**
All DOM mutation must go through `textContent`, `createElement`/`appendChild`,
or similar structural DOM APIs. Comment nodes (`createComment`) are fine.

*Verify:* grep for `\.innerHTML\s*=` / `\.outerHTML\s*=` /
`insertAdjacentHTML\s*\(` in `src/`. Zero assignment matches required.
(Comment strings that say "no innerHTML" are not matches — grep for the
assignment operator specifically.)

**Rule S-3: All user-supplied URLs must pass through `safeUrl()`.**
Any URL that originates from untrusted input (LLM output, user message, external
API response) before being set as `href`, `src`, or passed to `fetch` must be
validated by `core/safety.js#safeUrl`. `safeUrl` returns `''` for `javascript:`,
`data:`, and authority-relative `//host` patterns. It also returns `''` for any
URL carrying embedded userinfo credentials (`https://user:pass@host/...`) — a
phishing/link-spoofing vector distinct from classic XSS, since an
attacker-controlled label could otherwise point at a credential-dressed host
that looks trusted.

*Verify:* The `safeUrl` unit test in `test/unit/safety.test.js` asserts that
`javascript:`/`data:`/`vbscript:` schemes, authority-relative `//host` URLs, and
embedded-userinfo URLs (`user:pass@host`) all resolve to `''`, while the
https/http/mailto/tel allowlist and relative paths pass through unchanged.

**Rule S-4: No prototype pollution.**
JSON objects arriving from any external source (LLM, API response, user input)
must pass through `sanitizeJson()` from `core/safety.js` before being merged
into any plain object. `sanitizeJson` strips `__proto__`, `constructor`, and
`prototype` keys recursively.

*Verify:* The compliance test asserts `setDynamicPrompt({ __proto__: { x: 1 } })`
does not pollute `Object.prototype`. Confirm in `test/e2e/compliance.test.js`.

**Rule S-5: Admin secret non-enumerable and non-serializable.**
`_adminSecret` must be stored with `Object.defineProperty` as
`{ enumerable: false, configurable: false, writable: false }`. It must not
appear in `JSON.stringify(instance)` or in a `for…in` loop over the instance.

*Verify:* `test/unit/isolation.test.js` "admin secret non-enumerable" test.

**Rule S-6: No hard-coded credentials or token literals.**
`src/` must contain no string matching a KS token pattern (`djJ8…`) or a
32-character hex secret, outside of test fakes and the redaction regex itself.

*Verify:* grep for `djJ8` and 32-char lowercase hex literals in `src/`.
Only the regex pattern in `core/redact.js` and test fixtures are allowed.

---

## Part 3 — Resiliency

**Rule R-1: Exponential backoff on transient network failures.**
`Http.request()` must retry `GET` and `POST` requests that fail with HTTP 429,
502, 503, 504, or a network-layer error (status 0) using truncated exponential
backoff with full jitter. Non-retriable failure codes (400, 401, 403, 404, 405,
409, 422) must NOT be retried — retrying auth failures wastes quota and delays
the caller.

Retry parameters (defaults, all configurable via `HttpOptions`):
- `maxRetries`: 3 (total attempts = 4)
- `baseDelayMs`: 200 ms
- `maxDelayMs`: 10 000 ms (10 s)
- Backoff formula: `min(maxDelayMs, baseDelayMs * 2^attempt) * random(0.5, 1.0)`

**Rule R-2: Idempotent GETs are always safe to retry.**
`GET` requests carry no body and are safe to retry on any transient failure
without an idempotency key.

**Rule R-3: POSTs that carry an `Idempotency-Key` header are retry-safe.**
`Http.postJson()` already accepts an `idempotencyKey` option and forwards it as
the `Idempotency-Key` request header. A POST with this header set is safe to
retry; a POST without it is retry-safe only on a network-layer failure (status 0)
where the request may never have reached the server.

**Rule R-4: Retry budget does not consume the caller's `AbortSignal`.**
If the caller cancels via `signal`, the retry loop must stop immediately and
throw without starting the next attempt. The existing `mergeSignals()` helper
already handles per-attempt abort; Rule R-4 requires that a cancelled signal
also breaks the retry loop.

**Rule R-5: Retry behaviour must be fully exercisable offline.**
The backoff delay must be injectable (`delayFn` option, default `(ms) =>
new Promise(r => setTimeout(r, ms))`) so tests can pass `() => Promise.resolve()`
and exercise all retry paths at zero wall-clock cost.

*Verify:* `test/unit/http.test.js` must include tests that:
(a) assert a 503 response is retried up to `maxRetries` times and then throws;
(b) assert a 429 response is retried;
(c) assert a 401 response is NOT retried;
(d) assert a `POST` with no idempotency key IS retried on status-0 (network error,
    no bytes sent) but NOT on a received HTTP error like 503 (bytes were sent; the
    server may have processed it);
(e) assert that if `signal.abort()` is called mid-retry loop, the loop stops.

---

## Part 4 — Performance

**Rule P-1: Response payload size budget.**
`Http.request()` must enforce a configurable maximum response body size. The
default limit is 10 MB. If `Content-Length` exceeds the limit before reading,
or if the accumulated body text exceeds the limit, throw a `KalturaError` with
`code: 'response_too_large'`.

*Verify:* `test/unit/http.test.js` asserts that a fake response whose
`Content-Length` or body size exceeds `maxResponseBytes` throws `response_too_large`.

**Rule P-2: No synchronous blocking operations in the SDK's hot paths.**
The SDK must not call `JSON.parse` on arbitrarily large strings without a size
guard. All JSON parsing goes through `parseBody()` in `core/http.js`, which
already runs after the response is received — Rule P-1's size guard is the
enforcement point.

**Rule P-3: The SDK has zero runtime dependencies.**
`package.json` must list no `dependencies` (only `devDependencies` for test
tooling). Injectable transports (`fetch`, `socketFactory`, `rtcConstructor`,
`getUserMedia`) are the deliberate points of external integration.

*Verify:* Parse `package.json` and assert the `dependencies` key is absent
or empty.

---

## Part 5 — DX and Clean Code

**Rule D-1: All public exports must carry JSDoc.**
Every `export`ed `class`, `function`, and `const` in `src/` must have a
JSDoc block with at minimum: a one-line description plus `@param` for every
named parameter and `@returns` for non-void returns.

Private / internal helpers (unexported, or named with `_`) are exempt.

*Verify:* `agent_verify.mjs` scans `src/**/*.js` for exported symbols
without a preceding `/**` block.

**Rule D-2: No dead code (exported symbols with zero consumers).**
Symbols that are exported from an internal module but neither re-exported from
an entry point (`src/management/index.js`, `src/experience/index.js`)
nor used by any other module in `src/` are dead. Flag them. Do not delete
without confirming they are also absent from all `apps/` and `tools/` consumers.

*Verify:* `agent_verify.mjs` cross-references exports vs. imports. Any symbol
exported but never imported anywhere is flagged as dead code (warning, not
error, on first pass — must be manually confirmed before deletion).

**Rule D-3: No `TODO`, `FIXME`, or `HACK` comments in shipped code.**
These comments indicate incomplete implementations. Track them as a GitHub issue instead.

*Verify:* grep `src/` for `TODO\|FIXME\|HACK\|XXX\|STUB`. Zero matches required.

---

## Compliance summary

This table summarizes what each rule checks, not whether it currently passes — for
current pass/fail status, run `npm run verify` (`scripts/agent_verify.mjs`), the only
valid proof of compliance per the note at the top of this document.

| Rule | Category | What it checks | How to verify |
|------|----------|-----------------|---------------|
| I-1 | Isolation | No `let` at module top level | grep |
| I-2 | Isolation | Only reads of `globalThis`/`window`/`self`, never writes | grep |
| I-3 | Isolation | No cross-instance credential/state leakage | isolation.test.js |
| I-4 | Isolation | Event listeners removed on disconnect/destroy | isolation.test.js |
| S-1 | Security | No `eval` / `new Function` / equivalent | grep |
| S-2 | Security | No `innerHTML`/`outerHTML`/`insertAdjacentHTML` assignments | grep |
| S-3 | Security | Untrusted URLs pass through `safeUrl` | safety.test.js |
| S-4 | Security | Untrusted JSON passes through `sanitizeJson` | compliance.test.js |
| S-5 | Security | Admin secret is non-enumerable | isolation.test.js |
| S-6 | Security | No hardcoded credentials or token literals | grep |
| R-1 | Resiliency | Exponential backoff with full jitter in `Http.request()` | http.test.js |
| R-2 | Resiliency | GETs retried on any transient failure | http.test.js |
| R-3 | Resiliency | Idempotency-key POSTs retried; non-keyed POSTs retried only on status-0 | http.test.js |
| R-4 | Resiliency | Abort signal stops the retry loop immediately | http.test.js |
| R-5 | Resiliency | Injectable `delayFn`, retries exercised at zero wall-clock cost | http.test.js |
| P-1 | Performance | `maxResponseBytes` enforced on `Content-Length` and body size | http.test.js |
| P-2 | Performance | JSON parsing happens post-read, size-guarded | http.js |
| P-3 | Performance | Zero runtime dependencies | package.json |
| D-1 | DX | All public exports carry JSDoc | scan |
| D-2 | DX | See Rule D-2 above — candidate dead exports (warning, not error) | `node scripts/agent_verify.mjs` |
| D-3 | DX | No TODO/FIXME/HACK/XXX/STUB found | grep |

Rule D-2 warns rather than errors by design — see Rule D-2 above for why.
