# Security & Compliance — `@kaltura/intelligent-agents`

This SDK is built for enterprise and government deployments. It is **secure by
default, low-friction by design**: the safe path is the clear path, and where
strict compliance would otherwise hurt usability the SDK keeps the ergonomic
default and gives you a **config knob + a compliance note** to tighten it.

- **No runtime dependencies, no install scripts.** Zero transitive supply-chain
  surface — the SDK is sourced directly from git (`src/`), not a package
  registry. Enforced in CI.
- **All cryptography is delegated to the platform.** The SDK never rolls its own
  crypto — TLS, DTLS-SRTP, and base64 come from the host (Node `tls`/`crypto`,
  browser WebCrypto/TLS). Run Node/OpenSSL in FIPS mode and a FIPS-validated
  OS/browser to operate in a FIPS-validated configuration (NIST SC-13).
- **Secrets never reach the client.** The Admin Secret lives only server-side in
  `Management`; the browser `KalturaAvatarSession` takes only a short-lived,
  entitlement-ON conversation token.

> **Framework crosswalks** — HIPAA, HITRUST, the OWASP LLM/Agentic Top 10, and
> avatar/deepfake/voice-clone law (EU AI Act Art. 50, NO FAKES, CA SB 1001, BIPA,
> C2PA) are mapped control-by-control in the [framework crosswalks](#framework-crosswalks)
> below, with a copy-paste "secure production baseline" config.

## AI-application controls (OWASP LLM/Agentic; HIPAA technical safeguards)

Beyond the platform controls below, the SDK exposes DX-first guardrails for the
AI/agent layer — all **opt-in and safe-by-default** (most are opt-in;
`idleTimeoutMs` defaults to 900000 ms — pass 0 to disable; disclosure fires on
every connect), detailed in the [framework crosswalks](#framework-crosswalks) below:

- **Output handling (LLM05):** `safeUrl` / `safeText` / `renderSafeLink` (DOM-built,
  scheme-checked — never `innerHTML`) + inbound clamping of captions/segments.
- **Input guardrail (LLM01):** `onBeforeSend(text, ctx)` may transform or block a turn.
- **Agentic gate (LLM06 / ASI 01-02):** `onAgentAction(action)` + declarative
  `agentActions` policy + read-only `capabilities`; `stop()` kill switch.
- **Consumption valve (LLM10):** `maxTurnsPerMinute`.
- **HIPAA technical safeguards:** `idleTimeoutMs` auto-logoff (164.312(a)(2)(iii)),
  opaque `subjectId` unique-user-id (164.312(a)(2)(i)), content-free turn audit
  events (164.312(b)).
- **Avatar/deepfake:** disclosure-before-speech with `synthetic`/`provenance` +
  `getDisclosure()`; `requireDisclosureAck` (also a biometric-consent gate);
  optional `consentRef` on voice/visual cloning.

## Reporting a vulnerability

Email **security@kaltura.com** with details and a PoC if available. Please do
not open a public issue for an undisclosed vulnerability. We acknowledge within
a few business days and coordinate disclosure (NIST IR-6 / SI-2 is the
operator's reporting duty; this is the vendor contact).

## The two-token invariant (AC-3 / AC-6 / IA-2)

There are exactly two kinds of Kaltura Session (KS) token, and they never mix:

| Token | Privilege | Entitlement | Where |
|-------|-----------|-------------|-------|
| **admin** | `disableentitlement` (bypasses access control) | OFF | **server-side only** — `sessions.createAdminToken()` |
| **conversation / agent / widget** | `geniegpcid:<configId>` / `agentid:<id>` / widget | **ON** | safe to hand to a browser |

It is **structurally impossible** to mint an entitlement-bypassing token from a
client surface: `createConversationToken`/`createAgentToken` throw
`entitlement_violation` if asked, and `KalturaAvatarSession` refuses a
`disableentitlement` token at construction *and* on `setToken()`. This invariant
is tested (`test/unit/scope-guard.test.js`, `test/e2e/security.test.js`) and
gated, so it can't silently regress.

## Token lifecycle (RFC 9700 OAuth 2.0 Security BCP; NIST AC family)

- **Short-lived by default.** Browser-bound tokens default to **30 minutes**
  (`conversation`/`agent`), admin to 1 hour. Short TTL is
  the primary revocation lever for a stateless KS (RFC 9700 §6.1). Override per
  call with `ttlSeconds`; absurd lifetimes on browser-bound kinds are rejected
  (`ttl_too_long`). **UX note:** "refresh" = your server re-mints a fresh short
  token; the browser calls `session.setToken(freshKs)` to rotate mid-session
  without a reconnect.
- **Least privilege / binding (RFC 9700 §2.3, §4.10).** Tighten a token with the
  structured `restrictions` option instead of hand-crafting privilege strings:
  `{ role, actionsLimit, ipRestrict, uriRestrict, sessionGroupId }` compile to
  the matching Kaltura privileges (`setrole`/`actionslimit`/`iprestrict`/
  `urirestrict`/`sessionid`). Defaults stay wide-open so nobody is surprise-locked
  out — tightening is opt-in.
- **Active revocation (RFC 9700 §5.2.1.1; SOC 2 CC6.2/CC6.3).**
  `sessions.revoke(tokenOrKs)` ends a leaked token now (Kaltura `session/end`).
  Mint a family with `restrictions.sessionGroupId` and, by design, one `revoke`
  is intended to kill the whole group — this cascade is asserted by design and
  verified only at the KS-privilege-string level (the token really does carry
  `sessionid:<id>`), NOT independently confirmed against live backend revocation
  semantics. Returns a `_meta` revocation receipt.
- **Vault/KMS (NIST IA-5).** Pass `getAdminSecret: () => fetchFromVault()` to
  fetch the secret per-mint instead of holding it; it is never stored as an
  enumerable field.
- **Incident runbook — revoke a leaked conversation token:**

  ```js
  await management.sessions.revoke(leakedKs);   // or revoke(token)
  // if minted with restrictions.sessionGroupId: revoking any member is DESIGNED to end
  // the family (asserted by design, not independently live-verified — see above).
  ```

## Audit logging (NIST AU-2 / AU-3 / AU-12; OWASP Logging; SOC 2 CC7)

The SDK is an **event emitter**, not a logging framework. Pass `onAuditEvent` to
`Management` and/or `KalturaAvatarSession` to receive discrete, **already-redacted**,
structured `AuditEvent` objects and route them into your SIEM:

```js
new Management({ partnerId, adminSecret, onAuditEvent: (e) => siem.write(e) });
```

Events: `token.mint`, `token.revoke`, `token.refresh`, `guard.reject`,
`auth.fail`, `session.connect`, `session.disconnect`, `session.timeout`,
`guardrail.block`, `rate.limit`, `turn.user_captured`, `turn.avatar_spoke`,
`tool.invoke`, `agent.action.allow`, `agent.action.deny`, `clone.consent`,
`whep.release`. Each carries AU-3 content —
`{ ts (ISO-8601 UTC), type, severity, outcome, requestId (correlation id),
actor:{ partnerId, subjectId, kind, entitlementEnforced }, action, scope, reason, source,
_meta }`. The **raw KS is never included** (only its kind + scope); free-text
fields are stripped of CR/LF (CWE-117 log-injection guard); a throwing sink can
never break a mint or a live turn (crash-safe). It is distinct from the chatty
debug `logger`, and is never gated behind a debug level.

## Transport security (NIST SC-8; OWASP WSS/TLS)

`KalturaAvatarSession` **rejects** non-TLS `conversationManagerUrl`/`srsBaseUrl`
(`insecure_transport`). `localhost`/`127.0.0.1` is allowed for dev with a loud
one-time warning; non-localhost cleartext requires an explicit
`allowInsecureTransport:true` (dev/test only — never production). Prefer
server-minted **ephemeral TURN credentials** (`turnCredentials` from appInit,
RFC 7635) over the static fallback; the SDK warns when it falls back.

## Browser hardening (OWASP ASVS / WebSocket CS)

- **Memory-only token.** The SDK keeps the token in a non-enumerable instance
  field and **drops it on `disconnect()`**. Do **not** put a conversation token
  in `localStorage`/`sessionStorage` (XSS-exfiltratable) — pass it directly and
  re-mint from your server on reload.
- **No token in URLs.** Tokens travel only in the socket `auth` field /
  `Authorization` header, never a query string (OWASP API2:2023).
- **Prototype-pollution guard.** `setDynamicPrompt` data is scrubbed of
  `__proto__`/`constructor`/`prototype` before it touches the wire.
- **CSP.** The SDK uses no `eval`/`new Function`. A working policy:
  `connect-src` your CM + SRS + TURN hosts; `media-src blob:`;
  `script-src` your injected socket.io origin (pin it with **SRI** — see the
  README "Injecting socket.io securely"). Set `frame-ancestors` on the embedding
  page (a mic-capable widget warrants anti-clickjacking headers).
- **AI disclosure (EU AI Act Art. 50).** A `disclosure` event fires **before**
  the avatar's first words. `requireDisclosureAck` holds the avatar greeting until
  `acknowledgeDisclosure()`. Note: ASR (mic) connects before disclosure — obtain
  consent before `connect()` in IL/TX/WA.

## Isolation & multi-tenancy (NIST SC-4 / AC-6(4))

No SDK module holds credential or tenant state at module scope — the admin
secret, KS, and partnerId live only as (non-enumerable) instance fields. A
single process can safely run **N `Management` and M `KalturaAvatarSession`
instances** for different tenants with fully independent tokens, transports, and
teardown; nothing is shared or global (tested in `test/unit/isolation.test.js`).

## Supply-chain integrity (SLSA / OpenSSF / EO 14028)

- **Zero runtime dependencies, no install lifecycle scripts** (CI-enforced).
- **No registry publish step.** The SDK is consumed straight from its git tags
  (`src/`, imported by path or served via jsDelivr's GitHub CDN once the
  repo is public) — there is no npm package, and so no registry-side
  supply-chain surface to audit.

## Shared-responsibility control matrix (NIST 800-53)

The SDK **generates and protects** the records and enforces the client-side
controls below; the **operator owns** storage-side controls a client library
cannot provide (retention, tamper-evidence, non-repudiation).

| Control | Family | SDK provides | Operator responsible |
|---------|--------|--------------|----------------------|
| AC-3, AC-6, IA-2 | Access / least privilege | Two-token invariant; client can't mint admin tokens; structured `restrictions` | Role/entitlement config in Kaltura |
| AC-12 | Session termination | Short TTLs; `revoke()`; `disconnect()` drops token + transports | Session-timeout policy |
| AU-2, AU-3, AU-12 | Audit generation/content | Structured, redacted, correlated `AuditEvent`s via `onAuditEvent` | Wire the hook to a SIEM |
| AU-4, AU-9, AU-10, AU-11 | Audit storage/integrity/retention | — | Tamper-evident storage, non-repudiation, retention |
| SC-8 | Transmission confidentiality | https/wss enforced; cleartext rejected | TLS termination, cert management |
| SC-13 | Validated cryptography | Delegates to platform TLS/WebCrypto | Run Node/OS/browser in FIPS mode |
| SC-4 | Info in shared resources | Per-instance isolation; non-enumerable secrets | Process/tenant separation |
| SI-10 | Input validation | Inbound payload validation; prototype-pollution scrub | — |
| IR-6, SI-2 | Incident/flaw response | Security contact; coordinated disclosure | US-CERT/agency reporting timelines |

## FIPS mode (how-to)

```bash
# Node with an OpenSSL FIPS provider:
node --enable-fips your-server.js
# or via OpenSSL 3 FIPS provider config (OPENSSL_CONF / fipsmodule.cnf)
```

In the browser, FIPS validation is a property of the OS/browser crypto module —
deploy on a FIPS-validated platform; the SDK adds no non-validated crypto.

## Data residency (SC-7)

The SDK is a thin client. It contacts **only** the Kaltura endpoints you
configure (`agenticUrl`/`genieUrl`/`ovpUrl`/`conversationManagerUrl`/`srsBaseUrl`/
`turnServerUrl`) — no telemetry, analytics, or hidden beacons. Point every URL at
your in-boundary (e.g. US-Gov) hosts to keep all data within your authorization
boundary.

## Framework crosswalks

This section maps the SDK to the specific frameworks an enterprise / government /
healthcare buyer audits against — the companion to the posture + NIST 800-53 matrix
above.

**Shared responsibility.** A client SDK can *implement* technical controls and
*generate* the records, but it cannot sign a contract, retain logs, or
authenticate the human user. Each table marks **SDK** (the library provides it)
vs **Operator** (your duty, fed by the SDK's hooks/events).

### HIPAA (45 CFR Part 164)

> **Gating item:** the operator (a covered entity) MUST execute a **Business
> Associate Agreement** with Kaltura — and Kaltura with its avatar/ASR/TTS/brain
> subprocessors — **before any PHI flows** (164.308(b), 164.502(e)). A library
> cannot sign a BAA; this is the #1 operator prerequisite.

| Safeguard (CFR) | SDK provides | Operator responsible |
|---|---|---|
| **164.312(e)(1)/(e)(2) Transmission security** | https/wss enforced (`insecure_transport`); WebRTC media is DTLS-SRTP; crypto delegated to platform TLS | TLS termination, cert management |
| **164.312(b) Audit controls** | `onAuditEvent` (token + auth + guard lifecycle) **and** content-free PHI-exchange turn events (`turn.user_captured`, `turn.avatar_spoke`, `session.timeout`) — never content | Wire to SIEM; review (164.308(a)(1)(ii)(D)) |
| **164.312(a)(2)(iii) Automatic logoff** | `idleTimeoutMs` (default ON, 15 min) → `disconnect()` + `idleWarning` + `session.timeout` audit | Choose the timeout per care setting |
| **164.312(a)(2)(i) Unique user identification** | optional opaque `subjectId` threaded onto every AuditEvent | Supply an opaque id (never the patient's name/PHI) |
| **164.312(a)(1) Access control** | two-token invariant; entitlement-ON conversation tokens; least-privilege `restrictions` | Role/entitlement config in Kaltura |
| **164.312(d) Person/entity authentication** | authenticates the *session* (KS); refuses admin tokens client-side | Proof the *patient* before minting the conversation token; bind via `subjectId` |
| **164.502(b) Minimum necessary** | redaction chokepoint; SDK persists no transcripts/captions/screenshots | Don't persist captions/screenshots beyond minimum necessary; apply retention |
| **164.402 Breach / safe harbor** | PHI encrypted in transit + no token/PHI at rest → supports the encryption safe harbor for the SDK-controlled path | At-rest encryption; breach detection + 164.404/164.410 notification |
| **164.316(b)(2) Retention** | emits the records | Tamper-evident storage + **6-year** retention |

PHI note: a patient may *speak* PHI to the avatar — so captions, transcripts,
screenshots, and `setDynamicPrompt` context can carry PHI. The SDK surfaces these
to your app but **persists none of them**; treat them as PHI in your app.

### HITRUST CSF (incl. the AI Security Assessment)

The SDK is an **AI Application Provider component** you can largely *inherit* in a
HITRUST assessment; Kaltura's platform posture is the upstream inheritance source.

| HITRUST AI requirement | SDK provides | Operator / inherited |
|---|---|---|
| Encrypt traffic to/from the model | https/wss enforced; DTLS-SRTP | Platform/TLS |
| Restrict access to interact with the model | two-token invariant; entitlement ON; `revoke()` | Identity proofing |
| Log AI inputs/outputs (AI.PI.a) | security + turn audit via `onAuditEvent` (content-free by default) | SIEM storage/retention |
| Model rate limiting / DoS | client-side `maxTurnsPerMinute` valve | **Authoritative** server-side quota (inherited) |
| **Humans can intervene (AI.NI.a, non-inheritable)** | `stop()` / `disconnect()`, `revoke()`, barge-in (`interrupt()`), `requireDisclosureAck`, `onAgentAction` veto | Wire ≥1 to a visible UI control |
| Output filtering / prompt-injection | `safeUrl`/`safeText`/`renderSafeLink` (output); `onBeforeSend` hook (input) | Model-side guardrails (inherited); red-team the intellect |
| AI supply chain | zero deps, no install scripts, no registry publish step | Due-diligence review |
| AI transparency to end-user | disclosure-before-speech + `getDisclosure()` | Render it accessibly |
| Audit retention / tamper-evidence | emits records | ≥6-year tamper-evident storage |

> **Prompt-injection note (important):** the prototype-pollution scrub on
> `setDynamicPrompt`/inbound is *object-injection* defense, **not** prompt-injection
> defense, and `redact()` is *log-scoped*, **not** an output content filter. Don't
> pass unsanitized end-user text into `setDynamicPrompt`; instruction/data
> separation, source allow-listing, and model guardrails are operator/platform duties.

### OWASP Top 10 for LLM Applications (2025)

| Item | Status |
|---|---|
| **LLM01 Prompt Injection** | `onBeforeSend(text, ctx)` input-filter hook (block/transform). Model-side detection is operator/platform. |
| **LLM02 Sensitive Info Disclosure** | redaction of secrets in logs/audit; `onBeforeSend` lets you mask outbound PII. Don't put secrets in DPP. |
| **LLM03 Supply Chain** | zero runtime deps, no install scripts, no registry publish step, SRI on the injected socket.io (CI-gated). |
| **LLM05 Improper Output Handling** | `safeUrl` (scheme allow-list), `safeText`, `renderSafeLink` (DOM-built, never `innerHTML`), inbound clamping of captions/segments. Reference app uses the safe sink. **Treat avatar text/GenUI as untrusted.** |
| **LLM06 Excessive Agency** | `onAgentAction` gate + declarative `agentActions` policy + `capabilities` surface + `requireDisclosureAck`/`requireActionAck` HITL. |
| **LLM07 System-Prompt Leakage** | documented: never embed secrets/authz rules in the provisioned prompt or `setDynamicPrompt`. |
| **LLM10 Unbounded Consumption** | client `maxTurnsPerMinute` valve (`rate_limited`); server quota is authoritative. |
| LLM04 / LLM08 / LLM09 | Operator: data/model poisoning, RAG/embedding ACLs, and misinformation/overreliance UX are out of a client SDK's control. |

**Bounded-parser contract:** nav/action commands parsed out of avatar text MUST
be bounded allow-lists, never `eval`/dispatch of arbitrary strings —
`parseSlideNumber` (integer-bounded, range-checked) is the template.

### OWASP Agentic (Agentic Security Initiative / Top 10 for Agentic Apps)

The avatar's brain is an agent (navigates, renders GenUI, captures leads, searches
knowledge). The SDK is the client boundary where agent-initiated actions surface.

| Threat | Control |
|---|---|
| **ASI 01 Goal Hijack** / **ASI 02 Tool Misuse** | `onAgentAction(action)` chokepoint — every agent-initiated action (`navigate`/`render-genui`/`structured-data-form`/…) passes through it before taking effect; veto via false/throw. |
| **ASI 03 Identity & Privilege Abuse** | scoped, entitlement-ON, short-TTL, revocable token; least-privilege `restrictions`; `agentActions` policy (e.g. `navigate:'off'`). |
| **ASI 06 Memory & Context Poisoning** | `Presenter` session memory is bounded + (operator-cleared via `clearMemory()`); persisted memory is replayed context — operator owns the storage choice. |
| **ASI 08 Cascading Failures** | reconnect-window bound, media-recovery escalation, brain-liveness watchdog, client rate valve. |
| **ASI 09 Human-Agent Trust** | disclosure-before-speech + `getDisclosure()`; `requireDisclosureAck`. |
| **T8 Repudiation** | `agent.action.allow`/`agent.action.deny` audit events. |
| ASI 05 RCE | the SDK never `eval`s agent output; nav uses a bounded parser. |

### Avatar / digital-human / deepfake / voice-clone

| Obligation | Citation | Status |
|---|---|---|
| AI-interaction disclosure | EU AI Act Art. 50(1); CA SB 1001 (BOT Act); Utah AI Policy Act; Colorado AI Act | **SDK:** disclosure fires *before* first avatar speech + `getDisclosure()` queryable any time. **Operator:** render it accessibly (ARIA live region, not color-only — WCAG 2.1 SC 4.1.3). |
| Synthetic-media output marking | EU AI Act Art. 50(2); Recital 133; C2PA 2.x | **SDK:** `disclosure.synthetic:true` + `provenance{generatedBy,voice,sessionId}`. **Operator/Platform:** durable machine-readable marking (C2PA manifest) of the live media stream is server-side; stamp client-captured screenshots/recordings with an "AI-generated" assertion. |
| Deepfake disclosure (deployer) | EU AI Act Art. 50(4); Recital 134 | Operator (deployer) discloses manipulated content; SDK's disclosure supports it. |
| Bot identification | CA SB 1001 §17940 | SDK disclosure + persistent `getDisclosure()`. |
| Biometric notice + consent | BIPA 740 ILCS 14/15; TX CUBI §503.001; WA RCW 19.375 | The mic uplink may capture a "voiceprint." **SDK:** `requireDisclosureAck` can gate the mic until acknowledged. **Operator:** capture written-equivalent consent in IL/TX/WA before mic start; the avatar face/voice handling is operator/platform. |
| Voice/likeness clone consent | NO FAKES Act; TN ELVIS Act; CA AB 1836/2602; FTC impersonation rule | **SDK:** Management voice/visual provisioning accepts optional `consentRef` stored in `data._consent` on the returned catalog item. A `clone.consent` audit event is emitted. **Operator:** obtain + retain the source individual's consent. |
| Emotion / biometric categorisation notice | EU AI Act Art. 50(3) | Operator, if such features are enabled. |

### Secure production baseline (CM-6)

Copy-paste hardened configuration for a regulated deployment:

```js
// Server — Management
new Management({
  partnerId, getAdminSecret: () => vault.fetch('kaltura-admin'),  // or adminSecret
  onAuditEvent: (e) => siem.write(e),
});
const token = await mgmt.sessions.createConversationToken({
  configId, ttlSeconds: 1800,                 // short-lived (RFC 9700)
  restrictions: { actionsLimit: 200, sessionGroupId: caseId },   // least privilege + revocable family
});

// Browser — Experience
new KalturaAvatarSession({
  token, conversationManagerUrl, srsBaseUrl, turnServerUrl,      // all https/wss
  turnCredentials,                            // ephemeral (RFC 7635), not the static fallback
  allowInsecureTransport: false,              // never true in production
  requireDisclosureAck: true,                 // EU AI Act / biometric jurisdictions
  idleTimeoutMs: 900000,                      // HIPAA auto-logoff
  subjectId: opaqueUserId,                    // HIPAA unique-user-id (never PHI)
  maxTurnsPerMinute: 30,                      // LLM10 valve
  onBeforeSend: (t) => myGuardrail(t),        // LLM01 input filter
  onAgentAction: (a) => myPolicy(a),          // LLM06 / Agentic action gate
  onAuditEvent: (e) => siem.write(e),
});
```

Plus: pin the injected socket.io with **SRI**; set a strict **CSP**
(`connect-src` your CM+SRS+TURN; `media-src blob:`; no inline script/`unsafe-eval`)
and **`frame-ancestors`** on the embedding page; render the disclosure accessibly.
