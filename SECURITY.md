# Security & Compliance — `@kaltura/intelligent-agents`

This SDK is built for enterprise and government deployments. It is secure by
default, low-friction by design: the safe path is the clear path, and where
strict compliance would otherwise hurt usability the SDK keeps the ergonomic
default and gives you a config knob plus a compliance note to tighten it.

- No runtime dependencies, no install scripts. Zero transitive supply-chain
  surface — the SDK is sourced directly from git (`src/`), not a package
  registry. Enforced in CI.
- All cryptography is delegated to the platform. The SDK never rolls its own
  crypto — TLS, DTLS-SRTP (the encryption protocol securing WebRTC audio and
  video), and base64 come from the host (Node `tls`/`crypto`, browser
  WebCrypto/TLS). Run Node/OpenSSL in FIPS mode and a FIPS-validated
  OS/browser to operate in a FIPS-validated configuration (NIST SC-13).
- Secrets never reach the client. The Admin Secret lives only server-side in
  `Management`; the browser `KalturaAvatarSession` takes only a short-lived,
  entitlement-ON conversation token.

Framework crosswalks — HIPAA, HITRUST, the OWASP LLM/Agentic Top 10, and
avatar/deepfake/voice-clone law (EU AI Act Art. 50, NO FAKES, CA SB 1001, BIPA,
C2PA) — are mapped control-by-control in the [framework crosswalks](#framework-crosswalks)
below, with a copy-paste secure production baseline config.

## Reporting a vulnerability

Email `security@kaltura.com` with details and a PoC if available. Please do
not open a public issue for an undisclosed vulnerability. We acknowledge within
a few business days and coordinate disclosure (NIST IR-6 / SI-2 is the
operator's reporting duty; this is the vendor contact).

## Table of contents

- [AI-application controls](#ai-application-controls-owasp-llmagentic-hipaa-technical-safeguards)
- [KS guidance for agents](#ks-kaltura-session-guidance-for-agents-ac-3--ac-6--ia-2)
- [Token lifecycle](#token-lifecycle-rfc-9700-oauth-20-security-bcp-nist-ac-family)
- [Audit logging](#audit-logging-nist-au-2--au-3--au-12-owasp-logging-soc-2-cc7)
- [Transport security](#transport-security-nist-sc-8-owasp-wsstls)
- [Browser hardening](#browser-hardening-owasp-asvs--websocket-cs)
- [Isolation & multi-tenancy](#isolation--multi-tenancy-nist-sc-4--ac-64)
- [Supply-chain integrity](#supply-chain-integrity-slsa--openssf--eo-14028)
- [Shared-responsibility control matrix](#shared-responsibility-control-matrix-nist-800-53)
- [FIPS mode](#fips-mode-how-to)
- [Data residency](#data-residency-sc-7)
- [Framework crosswalks](#framework-crosswalks)
  - [HIPAA](#hipaa-45-cfr-part-164)
  - [HITRUST CSF](#hitrust-csf-incl-the-ai-security-assessment)
  - [OWASP Top 10 for LLM Applications](#owasp-top-10-for-llm-applications-2025)
  - [OWASP Agentic](#owasp-agentic-agentic-security-initiative--top-10-for-agentic-apps)
  - [Avatar / digital-human / deepfake / voice-clone](#avatar--digital-human--deepfake--voice-clone)
  - [Secure production baseline](#secure-production-baseline-cm-6)

## AI-application controls (OWASP LLM/Agentic; HIPAA technical safeguards)

Beyond the platform controls below, the SDK exposes DX-first guardrails for the
AI/agent layer, detailed in the [framework crosswalks](#framework-crosswalks)
below. Most require you to opt in by passing a callback or option. Two run
automatically regardless of configuration: the idle-timeout auto-logoff
(900000 ms, 15 minutes, by default — pass `0` to disable) and the AI-disclosure
event, which fires before the avatar's first words on every connect.

- **Output handling (LLM05).** Opt-in: `safeUrl` / `safeText` / `renderSafeLink`
  (DOM-built, scheme-checked — never `innerHTML`) — call these yourself when
  rendering avatar text. On by default: inbound clamping of captions/segments.
- **Input guardrail (LLM01).** Opt-in: `onBeforeSend(text, ctx)` may transform
  or block a turn — a no-op until you pass it.
- **Agentic gate (LLM06 / ASI 01-02).** Opt-in: `onAgentAction(action)` and the
  declarative `agentActions` policy. Always available: the read-only
  `capabilities` surface and the `stop()` kill switch.
- **Consumption valve (LLM10).** Opt-in: `maxTurnsPerMinute` (unlimited until
  you set it).
- **HIPAA technical safeguards.** On by default: `idleTimeoutMs` auto-logoff
  (164.312(a)(2)(iii)), 900000 ms (15 minutes) — pass `0` to disable. Opt-in:
  the opaque `subjectId` unique-user-id (164.312(a)(2)(i)); content-free turn
  audit events (164.312(b)) fire automatically once you wire `onAuditEvent`.
- **Avatar/deepfake.** On by default: disclosure-before-speech with
  `synthetic`/`provenance` data, fired before the avatar's first words on every
  connect; `getDisclosure()` is queryable any time. Opt-in:
  `requireDisclosureAck` (also a biometric-consent gate); an optional
  `consentRef` on voice/visual cloning.

## KS (Kaltura Session) guidance for agents (AC-3 / AC-6 / IA-2)

A KS carries the privileges that decide what it can do. The full privilege
reference is Kaltura's own docs, not this file — see [Kaltura API
Authentication and
Security](https://github.com/kaltura/developer-platform-docs/blob/master/documentation/VPaaS-API-Getting-Started/Kaltura_API_Authentication_and_Security.md).
What follows is only what matters for agent/avatar deployments.

| Token | Mint with | Privilege | Entitlement | Typical use |
|-------|-----------|-----------|-------------|--------------|
| **admin** | `sessions.createAdminToken()` | `disableentitlement` | OFF | Management-plane calls (provisioning, config) — server-side |
| **conversation / agent** | `sessions.createConversationToken()` / `createAgentToken()` | `geniegpcid:<configId>` / `agentid:<id>` | ON | The token your server hands a live avatar/chat session |
| **widget** | `sessions.createWidgetToken({widgetId})` | server-derived | ON | Public, secret-free anonymous embed — safe to mint straight from the browser |

Default recommendation: mint `conversation`/`agent`/`widget` tokens for
anything reaching a browser, and keep `admin` tokens server-side.
`createConversationToken`/`createAgentToken` refuse `extraPrivileges` that
disable entitlement, so neither method can be tricked into minting an
entitlement-bypassing token — tested and gated
(`test/unit/scope-guard.test.js`, `test/integration/sessions.test.js`).

Whether a given browser session should instead carry broadened
(entitlement-bypassing) access is an **application-level decision** you make
when you mint that session's token server-side — not something this SDK
enforces on the client. A real KS's privileges are AES-encrypted with the
partner secret and are not client-readable (`inspectKs()` reports
`disableEntitlement: null` for a real token; see
`src/management/ks-inspect.js`), so a client-side check would be inert for
production tokens and isn't attempted.

## Token lifecycle (RFC 9700 OAuth 2.0 Security BCP; NIST AC family)

- Short-lived by default: browser-bound tokens (`conversation`/`agent`) default
  to 30 minutes, admin to 1 hour. Short TTL is the primary revocation lever for
  a stateless KS (RFC 9700 §6.1). Override per call with `ttlSeconds`; absurd
  lifetimes on browser-bound kinds are rejected (`ttl_too_long`). UX note:
  "refresh" means your server re-mints a fresh short token, and the browser
  calls `session.setToken(freshKs)` to rotate mid-session without a reconnect.
- Least privilege / binding (RFC 9700 §2.3, §4.10): tighten a token with the
  structured `restrictions` option instead of hand-crafting privilege strings —
  `{ role, actionsLimit, ipRestrict, uriRestrict, sessionGroupId }` compile to
  the matching Kaltura privileges (`setrole`/`actionslimit`/`iprestrict`/
  `urirestrict`/`sessionid`). Defaults stay wide-open so nobody is
  surprise-locked out; tightening is opt-in.
- Active revocation (RFC 9700 §5.2.1.1; SOC 2 CC6.2/CC6.3):
  `sessions.revoke(tokenOrKs)` ends a leaked token now (Kaltura `session/end`).
  Mint a family with `restrictions.sessionGroupId` and, by design, one `revoke`
  is intended to kill the whole group — this cascade is asserted by design and
  verified only at the KS-privilege-string level (the token really does carry
  `sessionid:<id>`), not independently confirmed against live backend
  revocation semantics. Returns a `_meta` revocation receipt.
- Vault/KMS (NIST IA-5): pass `getAdminSecret: () => fetchFromVault()` to fetch
  the secret per-mint instead of holding it; it is never stored as an
  enumerable field.
- Incident runbook — revoke a leaked conversation token:

  ```js
  await management.sessions.revoke(leakedKs);   // or revoke(token)
  // if minted with restrictions.sessionGroupId: revoking any member is DESIGNED to end
  // the family (asserted by design, not independently live-verified — see above).
  ```

## Audit logging (NIST AU-2 / AU-3 / AU-12; OWASP Logging; SOC 2 CC7)

The SDK is an event emitter, not a logging framework. Pass `onAuditEvent` to
`Management` and/or `KalturaAvatarSession` (opt-in — no event fires until you
pass this hook) to receive discrete, already-redacted, structured `AuditEvent`
objects and route them into your SIEM:

```js
new Management({ partnerId, adminSecret, onAuditEvent: (e) => siem.write(e) });
```

### Event catalog

| Event | Fires when |
|---|---|
| `token.mint` | A KS is minted (admin, conversation, agent, or widget) |
| `token.revoke` | `sessions.revoke()` ends a token |
| `token.refresh` | `setToken()` rotates a live session's token |
| `guard.reject` | A call is rejected for carrying the wrong token kind (e.g. an admin token where a conversation token was required) |
| `auth.fail` | A request returns HTTP 401 or 403 |
| `session.connect` | `KalturaAvatarSession` finishes connecting |
| `session.disconnect` | `KalturaAvatarSession` disconnects |
| `session.timeout` | The idle timeout fires and auto-disconnects the session |
| `guardrail.block` | `onBeforeSend` or `onAgentAction` blocks a turn or action |
| `rate.limit` | `maxTurnsPerMinute` rejects a turn |
| `turn.user_captured` | The user's speech or text turn is captured |
| `turn.avatar_spoke` | The avatar starts speaking a turn |
| `tool.invoke` | A client-side tool call is invoked (from user text or an agent action) |
| `agent.action.allow` | `onAgentAction` allows an agent-initiated action |
| `agent.action.deny` | `onAgentAction` denies an agent-initiated action |
| `clone.consent` | A `consentRef` is recorded on a voice/visual clone upload |
| `whep.release` | The WHEP (WebRTC-HTTP Egress Protocol) video resource fails to release cleanly on disconnect |

### Event fields

Every event carries this AU-3 content shape:

| Field | Type | Description |
|---|---|---|
| `ts` | string | ISO-8601 UTC timestamp |
| `type` | string | One of the event names in the catalog above |
| `severity` | string | `info`, `warning`, or `error` |
| `outcome` | string | `success` or `fail` |
| `requestId` | string | Correlation id, reused from the triggering call |
| `actor.partnerId` | string | Kaltura partner id |
| `actor.subjectId` | string | Opaque operator-supplied user id, if set |
| `actor.kind` | string | Token kind (`admin` / `conversation` / `agent` / `widget`) |
| `actor.entitlementEnforced` | boolean | Whether entitlement was ON for this actor |
| `action` | string | The specific action taken |
| `scope` | string | The privilege string in effect, one-lined |
| `reason` | string | Failure reason, if any |
| `source` | string | Which SDK entry point emitted the event |
| `_meta` | object | Provenance receipt |

### Guarantees

- The raw KS is never included in an event — only its kind and scope.
- Free-text fields are stripped of CR/LF (CWE-117 log-injection guard).
- A throwing SIEM sink can never break a mint or a live turn — event emission
  is crash-safe.
- This audit stream is distinct from the chatty debug `logger` and is never
  gated behind a debug level.

## Transport security (NIST SC-8; OWASP WSS/TLS)

`KalturaAvatarSession` rejects non-TLS `conversationManagerUrl`/`srsBaseUrl`
(`insecure_transport`). `localhost`/`127.0.0.1` is allowed for dev with a loud
one-time warning; non-localhost cleartext requires an explicit
`allowInsecureTransport:true` (dev/test only — never production). Prefer
server-minted ephemeral TURN credentials (`turnCredentials` from appInit,
RFC 7635) over the static fallback; the SDK warns when it falls back.

## Browser hardening (OWASP ASVS / WebSocket CS)

- Memory-only token: the SDK keeps the token in a non-enumerable instance
  field and drops it on `disconnect()`. Do not put a conversation token in
  `localStorage`/`sessionStorage` (XSS-exfiltratable) — pass it directly and
  re-mint from your server on reload.
- No token in URLs: tokens travel only in the socket `auth` field or the
  `Authorization` header, never a query string (OWASP API2:2023).
- Prototype-pollution guard: `setDynamicPrompt` data is scrubbed of
  `__proto__`/`constructor`/`prototype` before it touches the wire.
- CSP: the SDK uses no `eval`/`new Function`. A working policy sets
  `connect-src` to your CM (Conversation Manager — the live-session
  control-plane host, `conversationManagerUrl`) plus SRS (the WHEP
  video-egress host, `srsBaseUrl`) plus your TURN host; `media-src blob:`;
  `script-src` your injected socket.io origin, pinned with SRI (see the
  README's "Injecting socket.io securely"). Set `frame-ancestors` on the
  embedding page — a mic-capable widget warrants anti-clickjacking headers.
- AI disclosure (EU AI Act Art. 50): a `disclosure` event fires before the
  avatar's first words. `requireDisclosureAck` holds the avatar greeting until
  `acknowledgeDisclosure()`. Note: ASR (Automatic Speech Recognition — the
  mic-to-text channel) connects before disclosure, so obtain consent before
  `connect()` in IL/TX/WA.

## Isolation & multi-tenancy (NIST SC-4 / AC-6(4))

No SDK module holds credential or tenant state at module scope — the admin
secret, KS, and partnerId live only as (non-enumerable) instance fields. A
single process can safely run N `Management` and M `KalturaAvatarSession`
instances for different tenants with fully independent tokens, transports, and
teardown; nothing is shared or global (tested in `test/unit/isolation.test.js`).

## Supply-chain integrity (SLSA / OpenSSF / EO 14028)

- Zero runtime dependencies, no install lifecycle scripts (CI-enforced).
- No registry publish step. The SDK is consumed straight from its git tags
  (`src/`, imported by path or served via jsDelivr's GitHub CDN once the
  repo is public) — there is no npm package, and so no registry-side
  supply-chain surface to audit.

## Shared-responsibility control matrix (NIST 800-53)

The SDK generates and protects the records and enforces the client-side
controls below; the operator owns storage-side controls a client library
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
| GDPR Art. 17 | Right to erasure | `threads.delete()` and `knowledge.deleteRecord()` (management API) | Neither is a bulk-erasure endpoint: `threads.delete()` is a soft delete (data retained server-side, per [API-REFERENCE.md § Threads](API-REFERENCE.md#threads)) and `knowledge.deleteRecord()` doesn't unlink the record from intellects that reference it. Erasure requests currently require operator-side manual deletion via the management API; no dedicated bulk-erasure endpoint exists yet |

> **Backend-blocked, dated 2026-08-22 (tracks issue #42).** `threads.delete()` hard-delete is
> backend-blocked — backend investigation confirms the erasure logic exists in the backend but is
> wired only to an internal cleanup path, not the public delete API. See
> [API-REFERENCE.md § Threads](API-REFERENCE.md#threads) for the full note.

## FIPS mode (how-to)

```bash
# Node with an OpenSSL FIPS provider:
node --enable-fips your-server.js
# or via OpenSSL 3 FIPS provider config (OPENSSL_CONF / fipsmodule.cnf)
```

In the browser, FIPS validation is a property of the OS/browser crypto module.
Deploy on a FIPS-validated platform; the SDK adds no non-validated crypto.

## Data residency (SC-7)

The SDK is a thin client. It contacts only the Kaltura endpoints you configure
(`agenticUrl`/`genieUrl`/`ovpUrl`/`conversationManagerUrl`/`srsBaseUrl`/
`turnServerUrl`) — no telemetry, analytics, or hidden beacons. Point every URL
at your in-boundary (e.g. US-Gov) hosts to keep all data within your
authorization boundary.

## Framework crosswalks

This section maps the SDK to the specific frameworks an enterprise,
government, or healthcare buyer audits against — the companion to the posture
and NIST 800-53 matrix above.

Shared responsibility: a client SDK can implement technical controls and
generate the records, but it cannot sign a contract, retain logs, or
authenticate the human user. Each table marks **SDK** (the library provides it)
vs **Operator** (your duty, fed by the SDK's hooks/events).

### HIPAA (45 CFR Part 164)

> Gating item: Kaltura offers a Business Associate Agreement, covering
> Kaltura and its avatar/ASR/TTS/brain subprocessors, as required before any
> PHI flows (164.308(b), 164.502(e)). Contact your Kaltura Account Manager
> or CSM to execute one.

| Safeguard (CFR) | SDK provides | Operator responsible |
|---|---|---|
| **164.312(e)(1)/(e)(2) Transmission security** | https/wss enforced (`insecure_transport`); WebRTC media is DTLS-SRTP; crypto delegated to platform TLS | TLS termination, cert management |
| **164.312(b) Audit controls** | `onAuditEvent` (token + auth + guard lifecycle) and content-free PHI-exchange turn events (`turn.user_captured`, `turn.avatar_spoke`, `session.timeout`) — never content | Wire to SIEM; review (164.308(a)(1)(ii)(D)) |
| **164.312(a)(2)(iii) Automatic logoff** | `idleTimeoutMs` (default ON, 900000 ms) → `disconnect()` + `idleWarning` + `session.timeout` audit | Choose the timeout per care setting |
| **164.312(a)(2)(i) Unique user identification** | Optional opaque `subjectId` threaded onto every AuditEvent | Supply an opaque id (never the patient's name/PHI) |
| **164.312(a)(1) Access control** | Two-token invariant; entitlement-ON conversation tokens; least-privilege `restrictions` | Role/entitlement config in Kaltura |
| **164.312(d) Person/entity authentication** | Authenticates the session (KS), minted server-side under your control | Proof the patient before minting the conversation token; bind via `subjectId` |
| **164.502(b) Minimum necessary** | Redaction chokepoint; SDK persists no transcripts/captions/screenshots | Don't persist captions/screenshots beyond minimum necessary; apply retention |
| **164.402 Breach / safe harbor** | PHI encrypted in transit + no token/PHI at rest → supports the encryption safe harbor for the SDK-controlled path | At-rest encryption; breach detection + 164.404/164.410 notification |
| **164.316(b)(2) Retention** | Emits the records | Tamper-evident storage + 6-year retention |

PHI note: a patient may speak PHI to the avatar, so captions, transcripts,
screenshots, and `setDynamicPrompt` context can carry PHI. The SDK surfaces
these to your app but persists none of them; treat them as PHI in your app.

### HITRUST CSF (incl. the AI Security Assessment)

The SDK is an AI Application Provider component you can largely inherit in a
HITRUST assessment; Kaltura's platform posture is the upstream inheritance
source.

| HITRUST AI requirement | SDK provides | Operator / inherited |
|---|---|---|
| Encrypt traffic to/from the model | https/wss enforced; DTLS-SRTP | Platform/TLS |
| Restrict access to interact with the model | Two-token invariant; entitlement ON; `revoke()` | Identity proofing |
| Log AI inputs/outputs (AI.PI.a) | Security + turn audit via `onAuditEvent` (content-free by default) | SIEM storage/retention |
| Model rate limiting / DoS | Client-side `maxTurnsPerMinute` valve | Authoritative server-side quota (inherited) |
| **Humans can intervene (AI.NI.a, non-inheritable)** | `stop()` / `disconnect()`, `revoke()`, barge-in (`interrupt()`), `requireDisclosureAck`, `onAgentAction` veto | Wire at least one to a visible UI control |
| Output filtering / prompt-injection | `safeUrl`/`safeText`/`renderSafeLink` (output); `onBeforeSend` hook (input) | Model-side guardrails (inherited); red-team the intellect (the SDK's term for the agent's configured brain — its prompts, tools, and knowledge linkage) |
| AI supply chain | Zero deps, no install scripts, no registry publish step | Due-diligence review |
| AI transparency to end-user | Disclosure-before-speech + `getDisclosure()` | Render it accessibly |
| Audit retention / tamper-evidence | Emits records | 6-year-or-longer tamper-evident storage |

> Prompt-injection note: the prototype-pollution scrub on
> `setDynamicPrompt`/inbound is object-injection defense, not prompt-injection
> defense, and `redact()` is log-scoped, not an output content filter. Don't
> pass unsanitized end-user text into `setDynamicPrompt`; instruction/data
> separation, source allow-listing, and model guardrails are operator/platform
> duties.

### OWASP Top 10 for LLM Applications (2025)

| Item | Status |
|---|---|
| **LLM01 Prompt Injection** | `onBeforeSend(text, ctx)` input-filter hook (block/transform). Model-side detection is operator/platform. |
| **LLM02 Sensitive Info Disclosure** | Redaction of secrets in logs/audit; `onBeforeSend` lets you mask outbound PII. Don't put secrets in the DPP (Dynamic Prompt — the per-turn context payload sent to the model via `setDynamicPrompt`). |
| **LLM03 Supply Chain** | Zero runtime deps, no install scripts, no registry publish step, SRI on the injected socket.io (CI-gated). |
| **LLM05 Improper Output Handling** | `safeUrl` (scheme allow-list), `safeText`, `renderSafeLink` (DOM-built, never `innerHTML`), inbound clamping of captions/segments. Reference app uses the safe sink. Treat avatar text/GenUI (the SDK's on-screen widget layer — flashcards, forms, images rendered from brain output) as untrusted. |
| **LLM06 Excessive Agency** | `onAgentAction` gate + declarative `agentActions` policy + `capabilities` surface + `requireDisclosureAck`/`requireActionAck` HITL. |
| **LLM07 System-Prompt Leakage** | Documented: never embed secrets/authz rules in the provisioned prompt or `setDynamicPrompt`. |
| **LLM10 Unbounded Consumption** | Client `maxTurnsPerMinute` valve (`rate_limited`); server quota is authoritative. |
| LLM04 / LLM08 / LLM09 | Operator: data/model poisoning, RAG/embedding ACLs, and misinformation/overreliance UX are out of a client SDK's control. |

Bounded-parser contract: nav/action commands parsed out of avatar text must be
bounded allow-lists, never `eval`/dispatch of arbitrary strings —
`parseSlideNumber` (integer-bounded, range-checked) is the template.

### OWASP Agentic (Agentic Security Initiative / Top 10 for Agentic Apps)

The avatar's brain is an agent (navigates, renders GenUI, captures leads,
searches knowledge). The SDK is the client boundary where agent-initiated
actions surface.

| Threat | Control |
|---|---|
| **ASI 01 Goal Hijack** / **ASI 02 Tool Misuse** | `onAgentAction(action)` chokepoint — every agent-initiated action (`navigate`/`render-genui`/`structured-data-form`/…) passes through it before taking effect; veto via false/throw. **Operator (server-side `api`/`code`/`csv` tools):** these fire server-to-server, outside the SDK's reach — independently authorize each call against the caller's real session/permissions; never treat model/system-prompt tool scoping, or a client-suppliable `request_vars` value, as an authorization claim. See [API-REFERENCE.md § Tools](API-REFERENCE.md#tools-api--csv--code). |
| **ASI 03 Identity & Privilege Abuse** | Scoped, entitlement-ON, short-TTL, revocable token; least-privilege `restrictions`; `agentActions` policy (e.g. `navigate:'off'`). |
| **ASI 06 Memory & Context Poisoning** | `Presenter` session memory is bounded and operator-cleared via `clearMemory()`; persisted memory is replayed context — operator owns the storage choice. |
| **ASI 08 Cascading Failures** | Reconnect-window bound, media-recovery escalation, brain-liveness watchdog, client rate valve. |
| **ASI 09 Human-Agent Trust** | Disclosure-before-speech + `getDisclosure()`; `requireDisclosureAck`. |
| **T8 Repudiation** | `agent.action.allow`/`agent.action.deny` audit events. |
| ASI 05 RCE | The SDK never `eval`s agent output; nav uses a bounded parser. |

### Avatar / digital-human / deepfake / voice-clone

| Obligation | Citation | Status |
|---|---|---|
| AI-interaction disclosure | EU AI Act Art. 50(1); CA SB 1001 (BOT Act); Utah AI Policy Act; Colorado AI Act | **SDK:** disclosure fires before first avatar speech + `getDisclosure()` queryable any time. **Operator:** render it accessibly (ARIA live region, not color-only — WCAG 2.1 SC 4.1.3). |
| Synthetic-media output marking | EU AI Act Art. 50(2); Recital 133; C2PA 2.x | **SDK:** `disclosure.synthetic:true` + `provenance{generatedBy,voice,sessionId}`. **Operator/Platform:** durable machine-readable marking (C2PA manifest) of the live media stream is server-side; stamp client-captured screenshots/recordings with an "AI-generated" assertion. |
| Deepfake disclosure (deployer) | EU AI Act Art. 50(4); Recital 134 | Operator (deployer) discloses manipulated content; SDK's disclosure supports it. |
| Bot identification | CA SB 1001 §17940 | SDK disclosure + persistent `getDisclosure()`. |
| Biometric notice + consent | BIPA 740 ILCS 14/15; TX CUBI §503.001; WA RCW 19.375 | The mic uplink may capture a "voiceprint." **SDK:** `requireDisclosureAck` can gate the mic until acknowledged. **Operator:** capture written-equivalent consent in IL/TX/WA before mic start; the avatar face/voice handling is operator/platform. |
| Voice/likeness clone consent | NO FAKES Act; TN ELVIS Act; CA AB 1836/2602; FTC impersonation rule | **SDK:** Management voice/visual provisioning accepts optional `consentRef` stored in `data._consent` on the returned catalog item. A `clone.consent` audit event is emitted. **Operator:** obtain and retain the source individual's consent. |
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

Plus: pin the injected socket.io with SRI; set a strict CSP (`connect-src`
your CM+SRS+TURN; `media-src blob:`; no inline script/`unsafe-eval`) and
`frame-ancestors` on the embedding page; render the disclosure accessibly.
