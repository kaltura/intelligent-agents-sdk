# @kaltura/intelligent-agents

The **Agentic Avatars SDK** — a zero-dependency JavaScript SDK for building and operating **Kaltura Agentic Avatars**, Kaltura's conversational agents with a visual, human-like avatar interface.

Two entry points, plus several optional plugin subpaths that don't bloat the base runtime:

- `./management` — provision, configure, and measure agents (server-side)
- `./experience` — the live interactive runtime: socket + WHEP video (browser)
- `./experience/presenter` — optional: the `Presenter` deck-walkthrough plugin
- `./experience/chroma-key` — optional: transparent-background avatar compositor (bring your own chroma-key-video)
- `./experience/genui` — optional: `ExperienceRenderer`/`mountWidget` GenUI widget rendering
- `./experience/analytics` — optional: `KavaAnalytics`, client-only KAVA Application Events (`pageLoad`/`buttonClicked`)
- `./experience/noise-suppressor` — optional: `createNoiseSuppressor`, a zero-dependency AudioWorklet noise gate

No build step, no npm registry publish — that's disabled by design (`"private": true`, no `publishConfig`, no publish workflow). Ship `src/` raw ESM directly: import from `src/...` server-side, or load it in the browser via a jsDelivr CDN URL pinned to a git tag once the repo is public. `node:test` throughout.

**New here?** [GETTING-STARTED.md](GETTING-STARTED.md) walks through creating and talking to your
first agent in about 5 minutes. Come back here once you're building a real app with the SDK. Also
see [CONTRIBUTING.md](CONTRIBUTING.md) (how to
contribute) and [SDK_CONSTITUTION.md](SDK_CONSTITUTION.md) (the invariants every change must hold).
[What changed between versions](https://github.com/kaltura/intelligent-agents-sdk/releases) lives
in GitHub Releases, generated from merged PRs at tag time — not a hand-maintained file.

> Issue references like "(issue #N)" in this repo's docs and code comments point to the private
> originating monorepo's history, not to an issue filed in this repo's own tracker.

**Security & compliance:** zero runtime dependencies, short-lived tokens, pre-redacted audit
events, and a NIST 800-53 control matrix — designed for enterprise, HIPAA, and HITRUST
deployments. See [Security posture](#security-posture) below or the full matrix in
[SECURITY.md](SECURITY.md).

**Why this SDK?** You own raw ESM source you can read line by line — no build step, no
bundler-only `node_modules` black box, and (once a tag is public) no install step at all: import
straight from a jsDelivr CDN URL pinned to a git tag. Zero runtime dependencies means no
transitive supply-chain surface to audit. Voice and visual cloning are self-serve calls in this
SDK (`catalog.importVoiceFromElevenLabs`/`importVoiceFromCartesia`, `catalog.createVisual`), not a
support ticket. And the security posture — pre-redacted audit events, short-lived tokens, a NIST
800-53 control matrix — is designed in from the start for enterprise/HIPAA/HITRUST deployments
rather than bolted on. Full details in [SECURITY.md](SECURITY.md).

---

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Management](#management)
- [Experience](#experience)
  - [`{{var}}` Jinja personalization (`request_vars`)](#var-jinja-personalization-request_vars)
  - [Tap-to-talk (push-to-talk voice)](#tap-to-talk-push-to-talk-voice)
  - [Resilience: brain stalls and tool-call spirals](#resilience-brain-stalls-and-tool-call-spirals)
  - [Devices and media quality](#devices-and-media-quality)
  - [Noise suppression (Tier-1 default + Tier-2 BYO-DSP)](#noise-suppression-tier-1-default--tier-2-byo-dsp)
  - [KAVA analytics (opt-in, client-only Application Events)](#kava-analytics-opt-in-client-only-application-events)
  - [Connectivity beacon (opt-in)](#connectivity-beacon-opt-in)
- [Accessibility (WCAG 2.2 AA / captions) + AI-disclosure gate](#accessibility-wcag-22-aa--captions--ai-disclosure-gate)
- [Security posture](#security-posture)
- [Key design rules](#key-design-rules)
- [Client-side commands](#client-side-commands)
  - [Native client tools with a real wire ACK](#native-client-tools-with-a-real-wire-ack)
  - [Handler results (local only, unless `waitForResponse:true`)](#handler-results-local-only-unless-waitforresponsetrue)
  - [Arg validation before dispatch](#arg-validation-before-dispatch)
  - [Fused multi-tool turns (handled automatically on the live session)](#fused-multi-tool-turns-handled-automatically-on-the-live-session)
- [AI-SDR / CRM lead capture](#ai-sdr--crm-lead-capture)
- [GenUI](#genui)
- [Presenter](#presenter)
- [Chroma-key Avatar Compositor](#chroma-key-avatar-compositor)
- [Advanced / building-block exports](#advanced--building-block-exports)
- [Testing](#testing)
- [Intellect configuration](#intellect-configuration)
- [Skills, voice import, and the embed snippet](#skills-voice-import-and-the-embed-snippet)
- [RAG (knowledge base)](#rag-knowledge-base)
- [Honest limits](#honest-limits)
- [Reference](#reference)
- [License](#license)

---

## Quick start

```bash
# see it work — no account needed, fully offline (~105 s)
npm test

# server: provision + headless converse (needs a Kaltura account)
export AGENTIC_PARTNER_ID=…
export AGENTIC_ADMIN_SECRET=…
node examples/server-token.mjs "A friendly yoga receptionist"

# browser: live avatar (needs a local server implementing /appInit to actually connect)
open examples/browser-experience.html

# browser: Presenter / deck walkthrough demo (needs a local server implementing /appInit to actually connect)
open examples/deck-presenter.html

# server + browser: scripted-video (STV-only) session — no brain, you provide the audio
export AVATAR_ID=…   # a visual-catalog id from mgmt.avatars.list(ks)
node examples/scripted-video-session.mjs
open http://localhost:8790
```

### Browser via jsDelivr (no bundler, no npm install)

Once the repo is public and has a tag pushed, jsDelivr serves any file straight from that tag by
its real repo path — it has no awareness of package.json's `exports` map, so import the real
`src/...` path, not a bare `@kaltura/intelligent-agents/...` specifier (those bare specifiers,
used elsewhere in these docs, only resolve for a Node/bundler consumer that reads `exports`):

```html
<script type="module">
  // Pinned to a release tag — recommended for anything you ship, since the file content at
  // this URL never changes once published (jsDelivr's immutable, long-cached tag path).
  import { KalturaAvatarSession } from 'https://cdn.jsdelivr.net/gh/kaltura/intelligent-agents-sdk@v1.4.0/src/experience/index.js';
  // ... same API as the local examples — see examples/browser-experience.html
</script>
```

Pin the tag (`@v1.4.0`, or whatever release you want) for anything you ship — jsDelivr caches a
tagged path forever, so a pin is both stable and fast. For local prototyping only, `@latest`
resolves to the newest tag without editing the URL on every release:

```html
<script type="module">
  import { KalturaAvatarSession } from 'https://cdn.jsdelivr.net/gh/kaltura/intelligent-agents-sdk@latest/src/experience/index.js';
</script>
```

`@latest` is **not cached the same way** — jsDelivr re-checks it periodically, so a new tag can
change what this URL serves without warning. Never use `@latest` in production; pin a real tag.
`examples/browser-experience.html` and `examples/deck-presenter.html` demonstrate the same
real-relative-path pattern locally (`../src/experience/index.js`).

---

## Architecture

```
  Management (./management)          Experience (./experience)
  ─────────────────────────────      ──────────────────────────────
  Sessions   — mint/revoke tokens    KalturaAvatarSession — socket+WHEP
  Agents     — CRUD                    connect / speak / onToolCall
  Avatars    — CRUD                    typed events, reconnect/resume
  Intellects — brain config          Presenter — deck walkthrough helper
  Catalog    — voices & visuals      ExperienceRenderer — GenUI widgets
  Knowledge  — RAG records CRUD      parseWidget / mountWidget
  Tools      — LLM-callable tools
  Skills     — reusable instructions
  Conversations — stream / converse
  Threads / Messages — history
  Feedback / Followups
```

**Core** (`src/core/`): injectable transports, RFC 9457 errors, NDJSON/SSE parser, redaction, idempotency, `_meta` receipts.

An **intellect** is the brain half of an agent: its prompts, tools, capabilities, and knowledge linkage — everything that decides what the agent says and does. An **avatar** is the face and voice half. `Agents — CRUD` above combines one of each into the deployed, callable actor.

---

## Management

```js
import { Management } from '@kaltura/intelligent-agents/management';

const mgmt = new Management({ partnerId, adminSecret });

// 1. provision a complete agent from a one-line brief
const admin = await mgmt.sessions.createAdminToken();   // admin KS — server-side only
const { agentId, configId, widgetId } = await mgmt.provision({
  brief: 'A helpful support agent for a video platform',
  ks: admin.ks,
});

// 2. headless streaming conversation (auto-mints a conversation token)
for await (const seg of mgmt.converse(configId, 'Hello!')) {
  if (seg.type === 'text') process.stdout.write(seg.content);
}

// 3. assembled result (text + toolCalls + threadId + _meta)
const result = await mgmt.converseOnce(configId, 'Hello!');
console.log(result.text, result.threadId);
```

`provision()` returns `{name, configId, avatarId, agentId, widgetId, profile, personaLint, blocks?, _meta}`. `personaLint` (see `lintPersonaIdentity` below) is a warning-only check for persona-name drift — it never fails `provision()`; inspect `personaLint.findings` yourself if you want to surface or act on it.

`converseOnce` returns `{ text, threadId, messageId, segments, toolCalls, experiences, experiencesList, kindCounts, spiralStopped, truncated, _meta }`. `spiralStopped:true` means a tool spiral was detected and cut short — check `toolCalls[0]` and re-prompt. `truncated:true` means the stream hit `maxSegments` (a runaway-non-tool-segment guard, default 2000) before finishing — gathered content is returned but the turn is incomplete.

Pass `recoverFromSpiral: true` (to `converseOnce` or `conversations.send`) to auto-recover from the empty-spiral case: a tool-call loop so long the brain never reaches a spoken sentence in that turn (`spiralStopped:true` with `text:''`) leaves nothing to fall back to in the same turn, since headless HTTP has no live-socket `interrupt()`/reconnect to fall back on. The result then carries `spiralRecovered` (`true`/`false`) and `firstAttempt: {toolCalls, spiralStopped}` from the discarded empty attempt. Off by default — omit the option for the original untouched behavior. See [Spiral recovery auto-resend](#resilience-brain-stalls-and-tool-call-spirals) below for how the shared `SPIRAL_RECOVERY_PREFIX` resend mechanism works; the headless path triggers it from an empty first attempt rather than a hard-spiral cold reconnect.

---

## Experience

```js
import { KalturaAvatarSession } from '@kaltura/intelligent-agents/experience';

const session = new KalturaAvatarSession({
  token,               // conversation KS — appInit.ks
  conversationManagerUrl,  // from appInit
  srsBaseUrl,          // from appInit
  turnServerUrl,       // from appInit
  videoEl: document.querySelector('video'),
  socketFactory: (url, opts) => io(url, opts),  // inject socket.io
});

await session.connect();
session.speak('Tell me about onboarding.');

session.on('transcript', ({ text }) => console.log(text));
session.onToolCall('navigate_to_slide', ({ slide_num }) => deck.goTo(slide_num));
```

**All transports are injected** — `socketFactory`, `rtcConstructor`, `fetch`, `getUserMedia`. Tests pass fakes; the SDK stays zero-dependency.

The SDK assigns the stream to `videoEl.srcObject` and applies no CSS of its own — size the box yourself with `object-fit: cover` (aspect-agnostic, no letterbox/pillarbox bars) — see [docs/ARCHITECTURE.md § Displaying the Avatar Video](docs/ARCHITECTURE.md#displaying-the-avatar-video).

### `{{var}}` Jinja personalization (`request_vars`)

Pass slow-changing personalization values (viewer name, account tier) that the brain's prompt reads via `{{var}}` templating — join-time via `cfg.requestVars`, or mid-session via `updateRequestVars()`:

```js
const session = new KalturaAvatarSession({ token, /* … */, requestVars: { user_name: 'Ada' } });
// later, once you learn more about the viewer:
session.updateRequestVars({ user_name: 'Ada', account_tier: 'enterprise' });
```

`updateRequestVars(vars)` always sends the **full current map** — conversation-manager resets `request_vars` to exactly what you send, it does not merge with the join-time map or a previous call. For a full per-turn context blob the brain reads fresh every turn (not just `{{var}}` substitution), use `session.setDynamicPrompt()` instead — the two mechanisms are distinct.

For the full picture of when to use `request_vars` vs. `setDynamicPrompt()` vs. actively nudging the brain with `speak()` vs. answering a brain-initiated request with `submitStructuredDataForm()` — and a worked example showing how they compose — see [docs/DYNAMIC-DATA-INJECTION.md](docs/DYNAMIC-DATA-INJECTION.md).

### Tap-to-talk (push-to-talk voice)

For the app-level decision of whether to use this at all, and the UI/accessibility/safety design
around it, see [docs/VOICE-INPUT-MODES.md](docs/VOICE-INPUT-MODES.md) — this section is the API
reference.

`startTapToTalk()`/`endTapToTalk()` are a distinct voice-input mode from typed-text `speak()`/`interrupt()`. The ASR mic uplink is always connected once `connect()` resolves; tapping just tells the conversation-manager to mark a capture window (`tapToTalkStart` → `InTappedMode`) and, on release, mint the turn from whatever it captured (`tapToTalkEnd` → its own ~300ms `processTapToTalkInput` timer). That turn then arrives through the same `agentTurnToTalk`/`transcript` pipeline as any open-mic turn — no separate transcript path to wire up.

```js
micButton.addEventListener('click', () => {
  if (session.tapToTalkActive) session.endTapToTalk();
  else session.startTapToTalk();
});
session.on('tapToTalkStarted', () => micButton.setAttribute('aria-pressed', 'true'));
session.on('tapToTalkEnded', () => micButton.setAttribute('aria-pressed', 'false'));
```

`startTapToTalk()` throws `capability_disabled` unless `session.capabilities.tapToTalk` (from `clientConfiguration.isTapToTalk`) is true. Treat `isTapToTalk` as a fixed, per-agent deployment choice, never a live per-session toggle — build the UI conditionally on the flag instead:

```js
if (session.capabilities.tapToTalk) {
  micButton.addEventListener('click', () => {
    if (session.tapToTalkActive) session.endTapToTalk();
    else session.startTapToTalk();
  });
  session.on('tapToTalkStarted', () => micButton.setAttribute('aria-pressed', 'true'));
  session.on('tapToTalkEnded', () => micButton.setAttribute('aria-pressed', 'false'));
} else {
  micButton.remove();   // open-mic agent: no tap control to show
}
```

`speak()`/`interrupt()` throw `invalid_state` while a tap is open (they'd otherwise bracket the CM's tapped-mode window with the typed-text `isSpeechStart` marker, minting a duplicate turn); `startTapToTalk()`/`endTapToTalk()` throw `invalid_state` if called out of order, and are gated by the same `requireDisclosureAck` disclosure gate as `speak()`. Pair it with silence-based auto-stop and a hard max-duration cap so an abandoned tap (tab closed, navigation away) can't leave a capture window open forever — treat a `disconnect`/`pagehide` while `tapToTalkActive` as an implicit `endTapToTalk()`.

Build the control as click-to-toggle, not press-and-hold: it's more usable for longer utterances, and it satisfies WCAG 2.5.2 Pointer Cancellation on its own, since the down-event never fires the action.

### Resilience: brain stalls and tool-call spirals

`KalturaAvatarSession` watches for a brain that goes quiet or loops instead of answering — see [ARCHITECTURE-REFERENCE.md](docs/ARCHITECTURE-REFERENCE.md#resilience--failure-handling) for the full failure-mode matrix.

- **Brain-stall watchdog** (`brainStallMs`, default on) — emits `brainStalled` (`{count}`), repeating for as long as nothing perceivable (spoken/avatar content or a GenUI widget) follows a turn.
- **Dead-air masking** (`responsePending`/`responseSettled`) — `responsePending` (`{}`) fires the moment a turn starts awaiting the brain's first perceivable output (spoken/avatar/GenUI content); `responseSettled` (`{}`) fires once that output arrives, the turn ends, an interruption occurs, or the session tears down. Use this pair to show/hide a "thinking…" affordance instead of leaving the avatar's face frozen during the gap — see `examples/browser-experience.html` for a working example.
- **Tool-call spiral circuit breaker** — a two-tier guard against a brain that re-issues the same client command instead of narrating. Soft (`toolSpiralLimit`, default 10, per turn): emits `toolSpiralDetected` — signal only, does NOT call `interrupt()` (a mid-turn barge-in was found to truncate the turn's own narration with no recovery — see `docs/CLIENT-COMMANDS.md`'s "Tool spirals starve the voice"). Hard (`hardToolSpiralLimit`, default `toolSpiralLimit * 3`, session-scoped, immune to turn-boundary resets): emits `toolSpiralRecovering` (`{count, limit, lastTurnText}`) and forces a cold reconnect — a brand-new socket, replaying `threadId` so brain memory continues.
- **Spiral recovery auto-resend** (`recoverFromSpiral`, default `true`) — a hard-spiral cold reconnect restores connectivity but would otherwise abandon the turn that triggered it (the user's question just silently dropped). With the default on, once the reconnect succeeds the SDK automatically resends that turn's text once, prefixed with the same `SPIRAL_RECOVERY_PREFIX` instruction proven live on the headless path (`Conversations#send({recoverFromSpiral:true})` — see [Management](#management) above), still passed through your `onBeforeSend` guardrail, and emits `spiralRecovered` (`{text}`, the original un-prefixed text — e.g. show "Let me get that for you" UI). Set `recoverFromSpiral: false` to opt out of the auto-resend and handle it yourself — `toolSpiralRecovering`'s `lastTurnText` still tells you what was abandoned.

```js
const session = new KalturaAvatarSession({ token, /* … */, recoverFromSpiral: false });
session.on('toolSpiralRecovering', ({ lastTurnText }) => {
  if (lastTurnText) myOwnResend(lastTurnText);
});
```

Two ICE-level failure modes get distinct, faster handling:

- **Zero-candidates fail-fast** — if ICE gathering completes having produced no candidates at all (a dead network path, e.g. TURN unreachable), the SDK escalates to media recovery immediately rather than waiting out the full 10s stuck-in-`new`/`checking` watchdog (a 3s floor guards against a genuinely slow TURN-only network).
- **Recoverable vs. session-gone** — an STV media-recovery failure carrying a WHEP 404 (the server session is truly gone, not just a transient drop) surfaces a distinct `connectivityChanged` `detail` (`'stv session gone (404)'`) before cold-reconnecting, so you can tell the two apart in logs/metrics even though both still cold-reconnect the same way today.

### Devices and media quality

```js
session.on('hardwareMuteChanged', ({ muted }) => micIndicator.set(muted));
session.on('localSpeakingChanged', ({ speaking }) => localSpeakerIndicator.set(speaking));
session.on('localMicLevel', ({ level }) => micButton.style.setProperty('--level', level)); // 0-1, every 50ms tick

const { mics, speakers } = await session.listDevices();
await session.switchMic(mics[1].deviceId);       // replaceTrack, no renegotiation
await session.setAudioOutput(speakers[1].deviceId); // HTMLMediaElement.setSinkId, retried 5x/500ms

await session.setAsrBandwidth(24); // kbps, applied live via RTCRtpSender.setParameters
```

- **`hardwareMuteChanged`** (`{muted}`) — fires when the OS/hardware mutes or unmutes the active mic track (`track.onmute`/`onunmute`). Mute is debounced 5s (many platforms blip `onmute` during device switches); unmute fires immediately.
- **`localSpeakingChanged`** (`{speaking}`) — an instant local speaking indicator from client-side volume analysis (`AnalyserNode`, 50ms sampling, threshold via `localVadThreshold`, default 300) — independent of the server's own turn-taking signals. Lazily activated only while at least one listener is registered, so a session that never listens pays zero Web Audio cost; deactivates the moment the last listener unsubscribes.
- **`localMicLevel`** (`{level}`, 0-1) — the same 50ms `AnalyserNode` sampler's continuous volume, normalized against the analyser's max possible byte-frequency sum, emitted on every tick rather than only on threshold transitions — drives a real-time UI meter (e.g. a mic button that visually fills with live input volume) without needing to bucket `localSpeakingChanged`. Shares the same lazy activate/deactivate lifecycle: registering a listener for either `localMicLevel` or `localSpeakingChanged` starts the sampler, and it stops only once every listener for both has unsubscribed.
- **`listDevices()`** — `{mics, speakers}` from `navigator.mediaDevices.enumerateDevices()` (video input omitted; an avatar session has no local camera). Returns empty lists headlessly/without permission rather than throwing.
- **`switchMic(deviceId)`** — swaps the ASR uplink's sender track via `replaceTrack`, no renegotiation; rewires the hardware-mute watch and VAD onto the new stream and stops the old one.
- **`setAudioOutput(deviceId)`** — routes `videoEl` playback via `setSinkId`, retrying up to 5 times at 500ms; returns `false` (never throws) if the platform lacks `setSinkId` or every retry is exhausted.
- **`preferredVideoCodec`** (constructor option, e.g. `'VP9'`) — filters the STV downlink's video transceiver to a single codec via `setCodecPreferences`. Silently falls back to browser-default negotiation if the codec isn't in this browser's `RTCRtpReceiver.getCapabilities('video')`.
- **`maxAsrBitrateKbps`** (constructor option) / **`setAsrBandwidth(kbps)`** (mid-session) — caps the ASR mic uplink's bitrate via `RTCRtpSender.setParameters()`, no renegotiation.

### Noise suppression (Tier-1 default + Tier-2 BYO-DSP)

Two independent layers:

```js
// Tier 1 (always on by default) — no code needed. To customize or opt out:
const session = new KalturaAvatarSession({ token, /* … */,
  micConstraints: { noiseSuppression: false },   // merge over the default, or...
  // micConstraints: false,                      // ...opt out entirely (bare audio:true)
});
```

```js
// Tier 2 (opt-in) — BYO-DSP: any lib or bespoke processor shaped (stream) => Promise<MediaStream|{stream,stop}>
import { createNoiseSuppressor } from '@kaltura/intelligent-agents/experience/noise-suppressor';

const session = new KalturaAvatarSession({ token, /* … */,
  noiseProcessor: createNoiseSuppressor({ thresholdDb: -50 }),   // the SDK's own lightweight AudioWorklet gate
  micConstraints: false,   // recommended when the DSP expects raw, unprocessed audio — stacking Tier-1 browser
                            // suppression under a second denoiser double-processes the signal
});
```

- **`micConstraints`** (constructor option) — `MediaTrackConstraints` merged into every `getUserMedia({audio})` call this session makes (`connect()`, `switchMic()`). Default `{echoCancellation:true, noiseSuppression:true, autoGainControl:true}` — the standard browser-native Tier-1 baseline. Pass `false` to send bare `audio:true`; pass a partial object to override individual fields.
- **`noiseProcessor`** (constructor option) — pluggable Tier-2 DSP hook: `(stream) => Promise<MediaStream|{stream,stop}>`. Called with the raw `getUserMedia` stream at `connect()` and every `switchMic()`; its returned stream (or `{stream,stop}`, if the processor owns a resource that needs explicit teardown — e.g. an `AudioWorkletNode` graph) is what actually reaches the ASR uplink. The SDK core bundles NO DSP library — bring a third-party processor (dynamically import it so apps that don't use it never load it) or a bespoke one; anything matching the shape works. A processor that throws fails mic acquisition closed with a typed `noise_processor_failed` error (same fail-closed behavior as a `getUserMedia` rejection).
- **`createNoiseSuppressor(opts)`** (`./experience/noise-suppressor`, separately importable — zero effect until constructed and passed as `noiseProcessor`) — the SDK's own real, lightweight, dependency-free Tier-2 implementation: an adaptive RMS noise gate running as a pure-browser-native `AudioWorkletProcessor` (attack/release-smoothed envelope, adaptive noise-floor tracking — NOT spectral/ML denoising, which is a heavier Tier-2 DSP approach). Options: `thresholdDb` (default `-50`), `attackMs` (default `5`), `releaseMs` (default `150`), `floorAdaptMs` (default `2000`); `audioContext`/`getAudioContext`/`audioWorkletNodeConstructor` are injectable for testing, mirroring the rest of the SDK's constructor-injection style.

### KAVA analytics (opt-in, client-only Application Events)

```js
import { KavaAnalytics } from '@kaltura/intelligent-agents/experience/analytics';

const analytics = new KavaAnalytics({
  partnerId: AGENTIC_PARTNER_ID, sessionId: session.threadId,
  hostingKalturaApplication: 28,   // see HOSTING_APPLICATIONS — Avatar Videos in this example
});
analytics.pageLoad({ pageType: 'View', pageName: 'earnings-deck' });
btnFeedbackDismiss.onclick = () => analytics.buttonClicked({ buttonType: 'Open', buttonName: 'feedback-dismiss' });
```

`KavaAnalytics` (`./experience/analytics`, its own subpath so apps that don't report analytics never load it) reports KAVA (Kaltura Video Analytics) events to `https://analytics.kaltura.com/api_v3/index.php` (`service=analytics&action=trackEvent`). It implements ONLY the 10000-range **Application Event** family — `pageLoad` (10003) and `buttonClicked` (10002) — for interactions the server has zero visibility into: a page/view landing, a UI-only click, a contact-form submit/skip, a widget dismiss. WRITE, best-effort, NOT idempotent (each call records a new row; there is no dedup contract) — fire-and-forget by design, so callers don't need to await it for correctness.

**Deliberately does NOT implement the 80000-range "Immersive Agents" events** (`callStarted`/`callEnded`/`messageResponse`/`messageFeedbackSent`) — there is no code path in this module that can send them. conversation-manager and the Genie brain backend already report all four server-side for every session `KalturaAvatarSession` connects to (same socket, matching event names, stickyId-routed pods); a client-side copy would double-count on the live analytics dashboards. If a real gap in that server-side reporting is ever found, file it as a GitHub issue rather than adding a client resend.

Transport: prefers `navigator.sendBeacon` (survives page-unload); falls back to an injectable `fetch` with `keepalive:true` when unavailable or when the beacon queue is full. Never reads a response body. `enabled: false` no-ops every call without touching the network — use for offline/mock test runs.

- **`pageLoad(fields)`** — `{pageType, pageName, pageValue, pageInfo}`. `pageType` is validated against the closed enum `PAGE_TYPES` (`View`/`Create`/`Edit`/`Participate`/`List`/`Analytics`/`Admin`/`Error`/`Login`/`Registration`/`Custom`); an invalid value throws before any network call.
- **`buttonClicked(fields)`** — `{buttonType, buttonName, buttonValue, buttonInfo}`. `buttonType` is free text (the spec leaves it open-ended, e.g. `Create`/`Filter`/`Navigate`/`Open`).
- Common params set once at construction and attached to every event: `partnerId`, `ks`, `entryId`, `sessionId`, `referrer`, `userId`, `hostingKalturaApplication`/`hostingKalturaApplicationVer`, `customId1`/`customId2`.
- `buildPageLoadParams`/`buildButtonClickedParams` are the pure param-builders behind the class — unit-testable in isolation, or usable directly if you want your own transport.

### Connectivity beacon (opt-in)

```js
const session = new KalturaAvatarSession({ token, /* … */, statsIntervalMs: 5000 });
session.on('connectionQuality', ({ channel, rttMs, packetLossPct, jitterMs, bitrateKbps }) => {
  metrics.gauge(`avatar.${channel}.rtt_ms`, rttMs);
});
```

- **`statsIntervalMs`** (constructor option) — polls `RTCPeerConnection.getStats()` on both the ASR uplink and STV downlink at this interval and emits `connectionQuality` (adopted from the WebRTC avatar engine's `PeerConnectionWebrtcStats`, but the raw numbers only — no scoring engine or telemetry-backend wiring, so you can feed them into whatever metrics pipeline you already run). Unset (the default) disables the beacon entirely, so a session that never opts in pays zero `getStats()` cost.
- **`connectionQuality`** (`{channel: 'asr'|'stv', rttMs, packetLossPct, jitterMs, bitrateKbps}`) — `rttMs` comes from the active candidate-pair's `currentRoundTripTime`; `packetLossPct`/`jitterMs` come from the RTP stream stats (`outbound-rtp` for ASR, `inbound-rtp` for STV); `bitrateKbps` is a byte-count delta against the previous poll, so it's `null` on the first tick for each channel. Any field the browser didn't report is `null` rather than a guessed value.

---

## Accessibility (WCAG 2.2 AA / captions) + AI-disclosure gate

Live captions satisfy WCAG 1.2.4 (Live Captions) — render them from `CaptionService`, which handles segmentation, timing, and barge-in invalidation for you:

```js
import { CaptionService } from '@kaltura/intelligent-agents/experience';

const captions = new CaptionService(session, {
  replacements: { 'Kalturah': 'Kaltura' },  // optional term corrections
});
captions.onCaption(({ text, clear }) => {
  captionEl.textContent = clear ? '' : text;
});
```

For the EU AI Act Art. 50 interaction-disclosure obligation, construct the session with `requireDisclosureAck:true` — this blocks `speak()` with a typed `disclosure_required` error until your app calls `acknowledgeDisclosure()`, so a deployer has a provable gate rather than a policy document:

```js
const session = new KalturaAvatarSession({ token, /* … */, requireDisclosureAck: true });
session.on('disclosure', (notice) => showDisclosureBanner(notice));
await session.connect();
// session.speak(...) throws `disclosure_required` here until:
session.acknowledgeDisclosure();
```

---

## Security posture

Designed for enterprise, HIPAA, HITRUST, and regulated frameworks. Full control matrix in [SECURITY.md](SECURITY.md). For Kaltura's authoritative legal/compliance positions, see [Kaltura's AI Principles](https://corp.kaltura.com/legal/compliance/kalturas-artificial-intelligence-principles/) and the [subprocessors list](https://corp.kaltura.com/legal/privacy/subprocessors-list/).

| Control | What the SDK does |
|---------|------------------|
| **Two-token invariant** | `disableentitlement` reachable only via `sessions.createAdminToken()` — no client surface can escalate |
| **Short-lived tokens** | Admin: 1h default; conversation/agent: 30min default. `revoke()` for active revocation; `setToken()` for mid-session rotation; `restrictions` for least privilege |
| **Audit stream** | `onAuditEvent` emits structured, pre-redacted events (`token.mint`, `guard.reject`, `tool.invoke`, …) to your SIEM |
| **Transport** | `https`/`wss` enforced; cleartext rejected; ephemeral TURN credentials preferred |
| **Browser hygiene** | Token is memory-only, non-enumerable, dropped on `disconnect()`; prototype-pollution scrub on `setDynamicPrompt`; AI disclosure gate before first speech (EU AI Act Art. 50) |
| **Supply chain** | Zero runtime deps, no registry install step — sourced straight from git; all CI-gated |

---

## Key design rules

- **Keep `disableentitlement` (management) server-side.** `KalturaAvatarSession` expects a `geniegpcid`/`agentid`/widget token (entitlement ON) — see [SECURITY.md](SECURITY.md#ks-kaltura-session-guidance-for-agents-ac-3--ac-6--ia-2) for the full guidance and the rare case where an app deliberately needs to hand a browser broader access.
- **Destructive ops require `{ confirmPermanent: true }`.** Never a flag on a read operation.
- **Capabilities are a full-replace dict.** A partial update drops keys you omit. Use `intellects.setCapability(configId, name, state, ks)` — it reads, merges, and writes.
- **`kaltura_genie_experiences` competes with client tools.** Set it `'off'` at creation for tool-driven intellects (the capability injects a system rule that out-competes custom tools). Set at creation — partner config is cached ~24 h server-side. `tools.clientToolReadiness(body)` lints for this.
- **`force_experience` is a hint, not a contract.** The live runtime hardcodes `avatar_only`; structured widgets arrive reliably only on the HTTP converse path.
- **Group turn events by `speechId`, never timestamp.** A new utterance invalidates the prior one's in-flight captions (barge-in guard).
- **Probe deployment-gated writes before calling them.** `intellects.brainConfigAvailable(ks)` / `knowledge.linkAvailable(ks)` return `{available, reason}`. Gated writes return `{applied:false, reason}` — they never throw or fake success.

---

## Client-side commands

The cleanest way for the brain to drive your UI — no custom JSON, no fragile text parsing, no server-side echo call. `tools.client()` builds a native `type:"client"` tool: the model calls it, the backend emits a silent `type:"tool"` segment carrying `tool_metadata.id`, and that's the entire server-side contract — no `request` block, no echo endpoint, no response shaper.

```js
// author once (server, admin KS)
import { tools } from '@kaltura/intelligent-agents/management';

const navigate = tools.client({
  name: 'navigate_to_slide',
  description: 'Go to a slide. Call when the user asks about a deck topic.',
  args: { slide_num: { prompt: 'Slide number (1-N).', type: 'int', required: true } },
  waitForResponse: false,   // fire-and-forget — omitting this blocks (backend default is true)
});

// tools are a SEPARATE, partner-level entity — create it, then reference the id.
const { id } = await mgmt.tools.add(navigate, ks);

const { configId } = await mgmt.intellects.create({
  capabilities: { kaltura_genie_experiences: 'off' },  // required — see design rules
  tool_ids: [id],
}, ks);

// consume at runtime (browser)
session.onToolCall('navigate_to_slide', ({ slide_num }) => deck.goTo(slide_num));

// or headless
const { toolCalls } = await mgmt.converseOnce(configId, 'tell me about pricing');
```

`waitForResponse` controls whether the model's turn blocks on a real client-supplied result — **omitting it is not the same as `false`**: the backend's own wire default for an absent field is `true` (blocking), so pass it explicitly. Fire-and-forget tools (`waitForResponse:false`) have no response channel back to the model at all, so fold any "call once, then narrate" guidance directly into the tool's `description` rather than relying on a fixed success message.

### Native client tools with a real wire ACK

For a tool that must block the model's turn on a real client-supplied result (rather than fire-and-forget), set `waitForResponse: true`:

```js
const pick = tools.client({
  name: 'ask_user_to_pick_a_slide',
  description: 'Ask the on-screen viewer to pick a slide, and wait for their answer.',
  waitForResponse: true,   // block the model's turn on a real client result
  timeout: 15,              // seconds to wait for the ACK (default 30)
});
const { id } = await mgmt.tools.add(pick, adminKs);

// live-socket host side
session.onToolCall('ask_user_to_pick_a_slide', async (call) => {
  const slide = await askViewer();
  await session.respondToTool(call.toolMetadata.id, { slide });
});
```

`waitForResponse:false` never populates `call.toolMetadata` with an id to ACK against — only register `respondToTool`/`onToolCall` ACK logic for tools you built with `waitForResponse:true`. A `respondToTool` call for an unknown or already-resolved id degrades to `{ok:false, reason:'unknown_or_stale'}` rather than throwing or hanging. This ACK is a live-socket operation only — there is no headless (`Management`) equivalent.

### Handler results (local only, unless `waitForResponse:true`)

A handler's return value (or thrown/rejected error) is captured and re-emitted as `'toolCallResult'` — `{call, ok:true, value}` for a non-`undefined` return/resolve, `{call, ok:false, error}` for a throw/reject. A handler returning `undefined` (the common case) emits nothing.

```js
session.onToolCall('create_slide', (args) => ({ slideNumber: deck.append(args) }));
session.on('toolCallResult', ({ call, ok, value, error }) => console.log(call.name, ok, value ?? error));
```

For a `waitForResponse:false` tool this is **local/app-observable only** — it never reaches Genie's brain. To actually carry your handler's result back to the model, build the tool with `waitForResponse:true` and call `session.respondToTool(call.toolMetadata.id, ...)` (see above) — that is the only wire channel back to the model.

### Arg validation before dispatch

`onToolCall` takes an optional third argument, a per-key `{type, required, enum}` schema, checked against `call.args` **before the handler runs**:

```js
session.onToolCall('navigate_to_slide', ({ slide_num }) => deck.goTo(slide_num), {
  slide_num: { type: 'int', required: true },
});
session.on('toolCallInvalid', ({ call, errors }) => console.warn('rejected', call.name, errors));
```

Validated fields, top-level keys only: `type` (one of `str`/`int`/`float`/`bool`/`list`/`dict` — the same six-value `ARG_TYPES` vocabulary as `tools.client`'s `args`, so you can pass the exact object you already declared there), `required`, and `enum` (a closed set of legal values). On a mismatch, the handler is **not invoked** — the SDK emits `'toolCallInvalid'` `{call, errors}` instead of `'toolCall'`, so a malformed call (e.g. a bare string where an int was declared) never runs on bad data. No schema registered → no check, zero behavior change. `collectConverse` has the same guard for headless use: pass `opts.toolArgSchemas: {toolName: schema}` and a mismatched call is diverted to the result's `toolCallsInvalid` array instead of `toolCalls`.

### Fused multi-tool turns (handled automatically on the live session)

When a turn calls 2+ tools, the server can stream them as **one** `type:"tool"` segment that names only the last tool, with earlier tools' JSON args concatenated into the same string (live-verified — see `WIRE-PROTOCOL.md` §4e). `parseToolCall(segment)` recovers the named tool's own args correctly either way, and exposes any earlier, unnamed blobs as `call.fusedArgs` (array, arrival order — absent when the segment wasn't fused). On `KalturaAvatarSession`, you don't need to do anything: it pairs each queued `fusedArgs` blob with the `tool_response` segment that echoes its real tool name (via `parseToolResponseName(segment)`) and dispatches it through the normal `onToolCall` path — same dedup, same schema validation, same `toolCallResult`/`toolCallInvalid` events. This queue is turn-scoped and clears on the next `agent_start_speech`, so a stray echo never leaks a recovery into the wrong turn.

Headless `collectConverse()` gets the corrected named-tool args for free but does **not** run this pairing — an earlier fused blob in a headless turn is reachable only via `fusedArgs` on that one `ToolCall`, not as its own `toolCalls` entry. If you need full recovery headlessly, replay `toolCalls` and pair each `fusedArgs` blob with the matching `tool_response`-derived name yourself using `parseToolResponseName`.

---

## AI-SDR / CRM lead capture

`./management` ships validated `api` tool builders for the common CRM contact-upsert integrations, so an AI-SDR or concierge agent doesn't need to hand-write the HTTP tool config:

```js
import { hubspotContactUpsert, salesforceContactUpsert } from '@kaltura/intelligent-agents/management';

// pure config builder — no network call, no secret VALUE here
const tool = hubspotContactUpsert({ secretName: 'HUBSPOT_TOKEN' });
// or: salesforceContactUpsert({ secretName: 'SF_TOKEN', instanceUrl: 'https://yourorg.my.salesforce.com' })

// inject the secret VALUE server-side (never in the tool config)
await mgmt.intellects.secrets.set(configId, { HUBSPOT_TOKEN: process.env.HUBSPOT_TOKEN }, ks);

// tools are a separate, partner-level entity — create it, then link it
const { id } = await mgmt.tools.add(tool, ks);
await mgmt.intellectConfig.setToolIds(configId, [id], ks);
```

Both recipes validate their config (via `tools.api()`) and throw a typed error for a missing `secretName`/`instanceUrl` before any write. See `src/management/crm-recipes.js` for the full arg list (`propertiesToCapture`/`fieldsToCapture`, `externalIdField`).

For Marketo, Airtable, Google Sheets/Forms, or any other REST target, plus the real backend-managed OAuth2 authorization-code flow (consent + auto-refresh) for providers that require it, see [docs/EXTERNAL-API-INTEGRATIONS.md](docs/EXTERNAL-API-INTEGRATIONS.md).

---

## GenUI

```js
import { ExperienceRenderer } from '@kaltura/intelligent-agents/experience/genui';

// 2-line happy path — renders all first-class GenUI widgets
new ExperienceRenderer({
  session,
  mount: document.getElementById('widgets'),
  onAction: (action, payload) => { /* followup / submit / play / open */ },
}).start();
```

`mountWidget(descriptor, target, opts)` is the zero-dep, never-`innerHTML`, accessible renderer. It ships zero styling — you theme the stable `kgenui`/`kgenui__*` class contract. `onMount(root, descriptor)` is the progressive-enhancement seam for host-injected libraries (Mermaid, Chart.js, KaTeX) — see `test/unit/genui.test.js` for the hook's contract.

A `summary` widget's text is markdown-in-plain-text by default (LLM-authored), and the SDK renders it as flat escaped text unless you opt in: `mountWidget(descriptor, target, { markdown: true })` parses that same text as markdown — headings, bold/italic, inline code, links, lists, fenced code blocks, and GFM tables (rendered through the same safe `tableEl` builder the structured widgets use) — all as real, accessible DOM, never `innerHTML`. This is markdown-IN-plain-text rendering, not a new wire segment type; every link goes through `safeUrl` and every text run through `safeText`/`safeSource`, so a `javascript:` link or a raw `<script>` tag in the LLM output is neutralized the same way the rest of GenUI's renderers neutralize untrusted output. Default (flat text) behavior is unchanged, so no existing app regresses by upgrading.

A widget interrupted mid-stream (a different runtime/`speechId` arrives before its JSON body finishes writing — e.g. a barge-in) is never mounted as a silently-truncated widget: `SegmentAssembler` recognizes the cut-off JSON shape and `ExperienceRenderer` mounts the same typed fallback it uses for a throwing custom renderer, `{kind:'error', data:{runtime, message}}`, distinguishable from any complete widget's descriptor.

In LIVE mode (`.start()`), `ExperienceRenderer` also subscribes to the session's `turnStart` event (re-emitted from the raw `agent_start_speech` socket event — `{speechId, turnId, isNewTurn}`) and, by default (`clearOnTurnStart: true`), discards the assembler's in-flight buffer and clears `rendered`/`last` when `isNewTurn` is true, so a widget from a previous turn never lingers into the next one — the same correctness fix Genie's own web client applies by nulling its content on `AgentStartSpeechReceived`. A duplicate turn (`isNewTurn:false`, e.g. a CM-side `tap-to-talk` retrigger for a `turnId` already in flight) is ignored here, matching every other `turnStart`/`isNewTurn` consumer in the SDK — otherwise the duplicate would wipe an already-rendered widget out from under the viewer mid-turn. Pass `clearOnTurnStart: false` to keep the previous default behavior (accumulate/persist across turns).

---

## Presenter

The `Presenter` helper (`./experience/presenter`, its own subpath so apps that don't need it never pay for its module graph) manages a deck walkthrough end to end: per-slide Dynamic Prompt (**DPP**) injection via `session.setDynamicPrompt()` — a structured context blob telling the brain what's on screen right now — navigation via ONE deterministic, silent, idempotent mechanism (`onToolCall('navigate_to_slide')` — no speech-parsing fallback), duplicate-nav suppression, a sequential resume point (`reason:'resume'`), and session memory ("welcome back") — all pure logic over an injected `session`/`storage`, fully unit-testable.

**Getters** (read-only):

| Getter | Returns |
|--------|---------|
| `covered` | Visited slide numbers |
| `questions` | Questions recorded so far |
| `lastNav` | `{target, reason, at}` |
| `lastDppSlide` | The `slide:` sub-object last sent in a DPP |
| `secondsOnCurrentSlide` | Seconds spent on the current slide |
| `memory` | The current session-memory object |

**Methods:**

| Method | Purpose |
|--------|---------|
| `start()` | Begin the walkthrough |
| `goTo(n, reason)` | Navigate to slide `n` |
| `refreshDpp()` | Resend the current slide's Dynamic Prompt |
| `saveMemory()` | Persist "welcome back" session memory |
| `clearMemory()` | Clear session memory |
| `recordQuestion(text)` | Record a question observed outside ASR (e.g. typed chat) |
| `appendSlide(slide)` | Grow the deck at runtime (e.g. a brain-driven `create_slide` command); pushes onto `slides`, grows `total`, and returns the new 1-based slide number without navigating |
| `destroy()` (alias `stop()`) | Remove every listener this Presenter registered on `session`, and make every other method above a no-op from then on. Idempotent. Call it before discarding a Presenter whose session stays connected (e.g. swapping decks mid-session) — otherwise the old instance keeps injecting DPPs/navigating/saving memory alongside any replacement, and (in dev) a skipped `destroy()`/`stop()` logs a `console.warn` the moment the replacement is constructed |

**App hooks** (each exists because a real app needed to extend one specific seam without forking the class):

| Hook | Signature | Purpose |
|------|-----------|---------|
| `extendDpp` | `(slide, ctx)` | Merges app-specific fields into every DPP sent (e.g. an engagement block built from `secondsOnCurrentSlide`) |
| `extraMemory` / `restoreMemory` | `(questions)` / `(memory)` | Write/read pair for persisting app-specific fields alongside Presenter's own "welcome back" session memory, instead of layering a second storage call |
| `onTurnText` | `(text, full)` | Fires with the per-turn accumulated avatar text — the same text Presenter itself uses internally — so an app can drive its own analytics or triggers off it |
| `onSlideChange` | `(n, slide, reason)` | Your renderer hook, called right after the DPP goes out (e.g. to page a PDF viewer to the new slide) |
| `metaFor` | `(category)` | Returns per-category DPP meta flags (`disclaimer_required`/`non_gaap_cited`) when your compliance categories differ from the financial/legal default |
| `dppSlide` | `(slide, ctx)` | Full-replace hook for the DPP's `slide:` sub-object when your slide shape doesn't match the default `{title, talking_points, category, content, narrator_guidance}` vocabulary (e.g. `body`/`topics`/`track`/`level`) |

The constructor option `oneNavPerTurn: true` guards against a brain "restart" firing two different nav targets within the same spoken turn — the second is silently suppressed until the next turn.

The constructor option `deckOutline: true` adds a full-deck `{slide_num, title}[]` outline to every DPP as `dpp.outline` — the SDK-native alternative to hand-rolling a topic→slide mapping into `BASE_DIRECTIVE` (which also goes stale after a runtime `appendSlide()`, since `BASE_DIRECTIVE` is static). Duplicate titles are disambiguated automatically (the colliding slide's first talking point, or its slide number if it has none). Default `false` — no `outline` key at all unless requested.

See `examples/deck-presenter.html` for a self-contained runnable demo: construct Presenter right after the session, before `connect()`, with `requireDisclosureAck: true` and the `extendDpp`/`extraMemory`/`restoreMemory` hooks in action.

---

## Chroma-key Avatar Compositor

`attachChromaKeyAvatar()` (`./experience/chroma-key`, its own subpath so apps that don't composite
the avatar never load it) wires a **bring-your-own** transparent-background compositor — any
`chroma-key-video`-shaped class — directly onto a `KalturaAvatarSession`'s own avatar `<video>`
element, and keeps that compositor's lifecycle in lockstep with the session's. The SDK never
bundles, imports, or depends on `chroma-key-video` (or any keying/matting library) itself — this
is glue, the same constructor-injection pattern `./experience/noise-suppressor` uses for
`audioWorkletNodeConstructor`:

```js
import { KalturaAvatarSession } from '@kaltura/intelligent-agents/experience';
import { attachChromaKeyAvatar } from '@kaltura/intelligent-agents/experience/chroma-key';
// YOUR dependency, not the SDK's — there is no npm package for chroma-key-video; load it by
// bundling https://github.com/kaltura/chroma-key-video locally, or straight from jsDelivr's
// GitHub-CDN mode, pinned to a released tag:
import { ChromaKeyVideo } from 'https://cdn.jsdelivr.net/gh/kaltura/chroma-key-video@v1.2.0/src/chromakey.js';

const session = new KalturaAvatarSession({ token, …appInit, videoEl, socketFactory });
const player = attachChromaKeyAvatar({
  session,
  videoEl: session.videoEl,     // must be the SAME element the session itself renders into
  ChromaKeyVideo,
  options: { autoTune: true },
  container: document.getElementById('composited'),   // omit to skip .mount() entirely
});
await session.connect();
// No extra teardown needed: player.destroy() fires automatically on session 'ended', a
// fatal session 'error', or session.disconnect()/stop() (the normal "hang up" path) —
// calling session.disconnect() alone is enough.
```

**Behavior:**

- **Construction is synchronous** — `attachChromaKeyAvatar()` returns the live `ChromaKeyVideo`
  instance immediately, no `Promise`.
- **`videoEl` must be `session.videoEl`** — the session's own read-only getter for the element its
  WHEP downlink actually assigns `srcObject` to. Passing a second, different reference throws a
  `KalturaError` — this catches a stale/duplicated element before it silently keys the wrong
  stream.
- **Returned unwrapped, zero shadow API** — the returned `player` is the exact instance
  `ChromaKeyVideo` constructed, with no proxy or wrapping. It's a standard `EventTarget` — listen
  on `player` directly via `addEventListener` for its own events (e.g. `chroma-key-video`'s
  `'started'`/`'backend'`/`'error'`) — `attachChromaKeyAvatar()` never re-emits them onto
  `session`.
- **Auto-cleanup** — `player.destroy()` is called exactly once, on the session's `'ended'` event, any
  FATAL `'error'` (`capacity_unavailable`/`tier_exceeded`/`bad_request`/`peer_removed`/
  `unsupported_client`), or the session reaching its `'disconnected'` state — which is what
  `session.disconnect()`/`session.stop()` (the human-in-the-loop kill switch, e.g. a "leave call"
  button) triggers; that path never emits `'ended'` on its own. A transient/recoverable error (e.g.
  a socket hiccup the session itself reconnects from) does NOT destroy the player. Checks the
  player's own `isDestroyed` flag first, so an integrator who already called `player.destroy()`
  themselves never gets a second call, and all three teardown paths are safe to fire together or in
  any order.
- **Idempotent, no double-wiring** — a second `attachChromaKeyAvatar()` call against a session that
  already has a live compositor logs `console.warn` and returns the EXISTING instance instead of
  constructing (and WebGL-context-leaking) a second one. Never throws for this.
- **No reconnect ceremony** — a WHEP reconnect reassigns `srcObject` on the SAME `videoEl` the
  compositor was already constructed against; no re-`attachChromaKeyAvatar()` call is needed.

**Non-goals:** this plugin does not reimplement chroma-keying, matting, backend fallback, or
WebGL context-loss recovery — that's entirely `chroma-key-video`'s (or your chosen library's) job.
If your app keys a URL-sourced clip with `chroma-key-video` directly, bypassing this plugin
entirely, running that URL through `safeUrl()` first is still your obligation (this plugin never
accepts or fetches a URL, only the session's own live video element).

See `examples/chroma-key-avatar.html` for a self-contained runnable demo.

---

## Advanced / building-block exports

These are importable from their entry points and useful when composing custom pipelines or renderers outside the high-level helpers.

### `./management`

| Export | Description |
|--------|-------------|
| `collectConverse(stream)` | Collects a `converse()` async-iterable into a single assembled result (`text`, `toolCalls`, `threadId`, `_meta`, etc.) — use when you need the full turn result without `converseOnce`. Dedupes tool calls semantically (by name + `canonicalJson(args)`, matching the live session's dispatch dedup — a non-deterministic JSON key order on an LLM retry doesn't defeat it) and caps spiraling tool calls (`spiralStopped`) and total segments (`truncated`). Does NOT itself recover from an empty spiral — see `conversations.send({recoverFromSpiral:true})`/`converseOnce` above. |
| `SPIRAL_RECOVERY_PREFIX` | The exact nudge text (`'Please answer in words only this turn, without calling any tool. '`) that `conversations.send({recoverFromSpiral:true})` prepends on its one headless recovery retry, and that `KalturaAvatarSession`'s `recoverFromSpiral` (default `true`) prepends on its one live-session auto-resend after a hard-spiral cold reconnect. Exported from `core/stream.js` (re-exported from `management/conversations.js` for back-compat) so callers can detect/strip it if they inspect raw thread history. |
| `canonicalJson(value)` | Deterministic JSON serialization with object keys sorted at every nesting level (arrays keep order). The key shape both `collectConverse` and the live session's `onToolCall` dispatch use to dedup semantically-identical tool calls whose JSON key order the LLM emitted non-deterministically. |
| `parseConverseStream(readable)` | Low-level NDJSON/SSE line parser. Turns a raw fetch `ReadableStream` into typed `Segment` objects — the foundation `converse()` builds on. |
| `redact(value)` | Scrubs KS tokens, secrets, and PII from any string or object before logging. Used internally by the audit stream. |
| `uuidv4()` | Cryptographically random UUID v4 (uses `crypto.randomUUID` when available, pure-JS fallback). |
| `randId(prefix?)` | Short collision-resistant ID with an optional prefix — used for idempotency keys and `_meta` receipts. |
| `parseCsv(text)` | Zero-dep CSV parser (RFC 4180). Used by the `tools.api` CSV response path. |
| `summarizeReport(rows, opts)` | Aggregates raw reporting rows into a `{ _meta, totals, byAgent, byThread }` summary — the same shape returned by `genie.mjs report-summary`. |
| `lintPrompts(prompts)` / `validatePromptVars(text, vars)` / `lintGlossary(glossary)` / `assembleSystemPrompt(parts)` | The prompt-authoring toolchain (`management/prompt-lint.js`): lint a prompt set for the `SYS_VARS` an intellect actually supplies, validate a template's `{{var}}` references against a known var set, lint a glossary for duplicate/conflicting terms, and assemble a final system prompt from ordered parts. Use these to catch a broken prompt (an unresolvable `{{var}}`, a name collision) before it ships, not after a live conversation surfaces it. |
| `lintPersonaIdentity({name?, openingPhrase?, baseDirective?, prompts?})` | Warns when a persona rename didn't fully propagate. `persona_name_drift` fires whenever a declared `name` (or an `openingPhrase`-derived name that differs from it) is missing from `base_directive`/`prompts[]` — it doesn't need `openingPhrase` at all, so it also catches intellects that only declare `name` and skip `openingPhrase` entirely. `persona_name_mismatch` still needs an `openingPhrase` that parses to a name different from the declared `name`. Returns `{ok, summary, findings, detectedName, _meta}` — warning-only, never throws. `mgmt.provision()` runs this automatically and returns the result as `personaLint` (see below); call it directly to re-check an intellect you're editing outside of `provision()`. |
| `resolveCapabilities(layers)` / `CAPABILITY_STATE` / `CAPABILITY_INFO` | `management/capabilities.js`'s typed capability resolver: merges the `env`/`partnerConfig`/`request` layers for each entry in `CAPABILITIES` down to one resolved `CAPABILITY_STATE` (`on`/`off`/`disabled`) plus a `resolvedFrom` provenance tag, so a caller can build an accurate "what can this agent do" view without re-deriving precedence from raw config fields. `CAPABILITY_INFO` carries the human-readable name/description per capability. |
| `findIntellectsReferencingTool(mgmt, toolId, ks)` | Lists every intellect's configId that currently references `toolId` in its `tool_ids`. This is the reuse-safety check `mgmt.tools.delete` runs by default before deleting a partner-level Tool — call it yourself to preview what a delete would break, or to build the same shared-by-name guard around your own upsert-by-name logic (`mgmt.skills`'s `delete` runs the analogous `findIntellectsReferencingSkill` check internally). |

### `./experience`

| Export | Description |
|--------|-------------|
| `TranscriptTracker` | Assembles per-`speechId` caption segments into a running transcript, respecting barge-in invalidation. Useful when building a custom captions UI outside `KalturaAvatarSession`. |
| `CaptionService` | Higher-level caption engine built on `TranscriptTracker` — call `onCaption(({text, clear}) => ...)` to register a render callback; fires with the next visible segment or `{text:'', clear:true}` to hide captions. |
| `parseToolCall(segment)` | Extracts a `{ name, args, raw }` tool-call from a raw `type:'tool'` segment. Handles both JSON and stringified-JSON argument encodings; on a fused multi-tool segment (see above), `args` is the named tool's own (last) blob and any earlier blobs ride along as `fusedArgs`. |
| `parseToolResponseName(segment)` | Extracts the tool name echoed by a `type:'tool_response'` segment (`"<name> responded with size <n>"`), or `null`. The attribution signal for pairing a fused `fusedArgs` blob with its real tool. |
| `segmentKind(segment)` | Returns one of `'spoken'`, `'control'`, `'experience'`, `'error'` for any segment object — normalizes the wire variance between HTTP converse and socket paths. |
| `apportion(text, maxLen)` | Splits a long text string into caption-display-safe chunks of at most `maxLen` characters, breaking on word boundaries. |
| `Emitter` | Minimal `on`/`off`/`emit` event emitter (zero deps). The base class for `KalturaAvatarSession` — extend it when building custom session wrappers. |
| `safeText(s)` | Returns an HTML-escaped string safe for text node injection. |
| `safeUrl(url)` | Validates and returns a URL string; returns `''` for `javascript:` and other unsafe schemes. |
| `renderSafeLink(href, label)` | Returns a safe `<a>` tag string using `safeUrl` + `safeText` — use in custom widget renderers that need to emit links without `innerHTML` risk. |
| `sanitizeJson(obj)` | Deep-clones a plain object, stripping non-serializable values and keys that start with `__`. Safe to pass to `JSON.stringify` for logging. |
| `clampInbound(value, min, max)` | Numeric clamp — used to bound untrusted inbound numeric fields (e.g. widget dimensions) before rendering. |

### `./experience/presenter`

| Export | Description |
|--------|-------------|
| `Presenter` | Deck-walkthrough plugin — see the [Presenter](#presenter) section above. Its own subpath so apps that don't present a deck never load it. |
| `parseSlideNumber` | Parses a `slide_num` tool-call argument (number, numeric string, or ordinal word like `"next"`/`"third"`) against a known slide total. |

### `./experience/chroma-key`

| Export | Description |
|--------|-------------|
| `attachChromaKeyAvatar(cfg)` | Wires a bring-your-own `chroma-key-video`-shaped compositor onto a session's own avatar video — see the [Chroma-key Avatar Compositor](#chroma-key-avatar-compositor) section above. Its own subpath so apps that don't composite the avatar never load it. |

### `./experience/genui`

| Export | Description |
|--------|-------------|
| `ExperienceRenderer` | 2-line happy-path renderer for all first-class GenUI widgets — see the [GenUI](#genui) section above. |
| `mountWidget(descriptor, target, opts)` | Zero-dep, never-`innerHTML`, accessible single-widget renderer with an `onMount` progressive-enhancement seam. |
| `parseWidget(segment)` / `normalizeRuntime` / `RUNTIMES` / `GENUI_WIDGET_NAME` | Wire-shape parsing helpers for building a custom GenUI renderer. |
| `DEFAULT_RENDERERS` / `WIDGET_KINDS` | The default per-kind renderer map and the frozen list of kinds it dispatches on. |
| `SegmentAssembler` | Collects typed stream segments from the live socket into the same assembled shape as `collectConverse` — use when replaying socket captures or building a custom turn handler. `onMalformed({runtime, runtimeName, speechId, reason, message})` fires instead of `onWidget` when a fragment sequence is interrupted (`reason:'boundary'`) before its JSON body finishes — a natural end-of-turn (`'turnEnd'`) or `stop()` flush is never flagged malformed. |

### `./experience/noise-suppressor`

| Export | Description |
|--------|-------------|
| `createNoiseSuppressor(opts)` | Builds a `cfg.noiseProcessor`-conforming function backed by a pure-browser-native `AudioWorkletProcessor` noise gate — see [Noise suppression](#noise-suppression-tier-1-default--tier-2-byo-dsp) above. Its own subpath so apps that don't opt into Tier-2 DSP never load it. |

### `./experience/analytics`

| Export | Description |
|--------|-------------|
| `KavaAnalytics` | Fire-and-forget KAVA reporter — see [KAVA analytics](#kava-analytics-opt-in-client-only-application-events) above. Its own subpath so apps that don't report analytics never load it. |
| `buildPageLoadParams(common, fields)` / `buildButtonClickedParams(common, fields)` | Pure param-builders for the two valid client-side event types, used internally by `KavaAnalytics` and importable directly for a custom transport. |
| `EVENT_TYPES` | `{pageLoad:10003, buttonClicked:10002}` — the only two valid client-side codes. |
| `PAGE_TYPES` | The closed enum `pageLoad`'s `pageType` field is validated against. |
| `HOSTING_APPLICATIONS` | `hostingKalturaApplication` values by name: `genieChat`, `agents`, `modelsSdk`, `conversationManager`, `avatarVideos`, `agenticAvatarsStudio`, plus an internal analytics-only identifier carried over from the backend's own dashboard naming — `kaiVendor` (a legacy internal hosting-app id with no public product meaning; kept only so KAVA event attribution matches the backend's existing dashboards). |
| `DEFAULT_ANALYTICS_URL` | The KAVA ingestion endpoint (`https://analytics.kaltura.com/api_v3/index.php`). |

---

## Testing

```bash
npm test                  # all layers, offline
npm run test:unit         # builders, parsers, errors, redaction
npm run test:integration  # provision flow, token mint, converse (fake fetch)
npm run test:e2e          # full connect machine (fake socket + fake RTCPeerConnection)
npm run test:evals        # SDK event model vs. golden captured session
```

Fakes live in `test/fakes/` — `socket.js`, `rtc.js`, `fetch.js`. Inject them in your own tests:

```js
import { FakeSocket } from '@kaltura/intelligent-agents/test/fakes/socket.js';
const session = new KalturaAvatarSession({ …, socketFactory: () => new FakeSocket() });
```

For live-backend Playwright e2e (real agent + WebRTC connect), boot a real session against `KalturaAvatarSession` with no `socketFactory`/fake transport override, then drive it the same way — `connect()`, wait for the ready state, assert on the resulting DOM/state.

---

## Intellect configuration

The `intellectConfig` facade wraps the read-merge-write cycle:

```js
// one call — reads current config, overlays your patch, writes
await mgmt.intellectConfig.patch(configId, { base_directive: 'Be concise.' }, ks);

// typed setters
await mgmt.intellects.setCapability(configId, 'use_knowledge_base', 'on', ks);
const { id: toolId } = await mgmt.tools.add(myTool, ks);       // tools are a separate, partner-level entity
await mgmt.intellectConfig.setToolIds(configId, [toolId], ks); // then link it
await mgmt.intellects.secrets.set(configId, { API_KEY: value }, ks);  // write-only
await mgmt.intellectConfig.setKnowledgeIds(configId, [knowledgeId], ks);  // Path A, ungated
await mgmt.intellectConfig.setMcpServers(configId, { docs: { url: 'https://mcp.example.com/sse' } }, ks);  // ungated
```

`setMcpServers` writes the intellect's `mcp_servers` map (`{"<name>": {url}}` — pass `{}` to clear). The backend normalizes on read (each entry comes back expanded with `type:'mcp'`, `transport:'streamable_http'`, and `null` header/allow-list fields), so never diff your input against a subsequent `get` byte-for-byte.

`intellectConfig.describe(configId, ks)` returns every editable field partitioned into `editable` + `readOnly` — wire directly to a settings UI.

---

## Skills, voice import, and the embed snippet

**Skills** (`mgmt.skills`) are standalone, partner-level reusable instruction entities on Genie (`v1/skill/*`) — `{id (uuid), name, description, instructions}`. Full lifecycle verified live, including `update`:

```js
const skill = await mgmt.skills.add({ name: 'greeter', description: 'Greets warmly.', instructions: 'Always say hi.' }, ks);
const page = await mgmt.skills.list(ks);          // async-iterable + awaitable first page
const one = await mgmt.skills.get(skill.id, ks);
await mgmt.skills.update(skill.id, { instructions: 'Always say hi, in one short sentence.' }, ks);  // idempotent; renaming re-checks the unique-name constraint (409 on conflict)
await mgmt.skills.delete(skill.id, ks, { confirmPermanent: true });
```

`name` is checked against your partner id OR partner `0` (a shared global pool), so a name can collide with a global-pool Skill in ways invisible from a partner-scoped `list()` — the same nuance applies to Tools.

Before deleting, `mgmt.skills.delete` lists every intellect and refuses with a typed `skill_in_use` error naming each one still referencing the id in `skill_ids`, unless called with `{confirmPermanent:true, force:true}` — Tools' `mgmt.tools.delete` carries the identical `tool_in_use` guard.

Attach a Skill to an intellect via `intellectConfig.setSkillIds` — the intellect only holds a reference list (`{id, mode}` pairs), the skill body itself lives in `mgmt.skills`. `mode` is `'preloaded'` (instructions go in the system prompt every turn) or `'adhoc'` (the brain pulls it in only when relevant) — see the exported `SKILL_MODES`:

```js
await mgmt.intellectConfig.setSkillIds(configId, [{ id: skill.id, mode: 'adhoc' }], ks);
// pass [] to detach every skill
```

**Provider voice import** (`mgmt.catalog`) creates a catalog Voice item directly from an ElevenLabs or Cartesia voice id — no audio upload:

```js
const v = await mgmt.catalog.importVoiceFromElevenLabs('EXAVITQu4vr4xnSDxMaL', ks);
// or: await mgmt.catalog.importVoiceFromCartesia('<cartesia-voice-id>', ks);
```

An unknown provider id creates **nothing** and raises a typed `voice_not_found_elevenlabs` / `voice_not_found_cartesia` error (the backend replies an HTTP-200 exception envelope; the SDK maps it — verified live).

**Embed snippet** (`mgmt.agents.getEmbedScript(agentId, embedType, ks)`) returns the ready-to-paste HTML `<script type='module'>` that renders the agent's chat widget on any page. `embedType` is one of `contained` (inline box), `page` (full page), or `floater` (floating launcher) — validated against the exported `EMBED_TYPES` before any network call.

---

## Scripted-Video (STV-only) Sessions

A second, independent backend (`avatar-session/*`) for a brain-free avatar: no LLM, no ASR, no socket.io — you drive it entirely from your own server by handing it pre-rendered speech audio. Use it when you already have the text (and optionally the TTS audio) and just need a talking-head video, e.g. reading back a scripted announcement or a pre-approved script.

```js
import { Management } from '@kaltura/intelligent-agents/management';

const mgmt = new Management({ partnerId, adminSecret });
const admin = await mgmt.sessions.createAdminToken();

const session = await mgmt.avatarSessions.create({ visualConfig: { id: avatarId } }, admin.ks);
const { whepUrl, turn } = await mgmt.avatarSessions.initClient(session);
// hand { whepUrl, turn } to the browser — non-secret, safe to send over your own API

await mgmt.avatarSessions.say(session, audioBytes, { duration: durationSeconds });
// duration is required — the server has no duration probe of its own; measure your own audio

await mgmt.avatarSessions.end(session);
```

```js
import { KalturaScriptedVideoSession } from '@kaltura/intelligent-agents/experience';

const view = new KalturaScriptedVideoSession({ whepUrl, turn, videoEl: document.querySelector('video') });
await view.connect();   // negotiates WHEP, resolves once the stream is playable
// ...later
view.disconnect();
```

`create` authenticates with your own **admin KS** (`mgmt.sessions.createAdminToken()`); every call after it (`initClient`/`say`/`interrupt`/`keepAlive`/`end`) authenticates with the **session's own Bearer token** instead — `create()`'s return value is a receipt (`{sessionId, token, isExpired(), secondsRemaining()}`), pass it straight to the other methods rather than re-deriving a KS. `say-audio` (wrapped as `say()`) is the only speech-injection mechanism this backend exposes — there is no verbatim text-to-speech endpoint on it (`say-text` 503s on the live deployment; `set-emotion`/`queue-status`/`status` don't exist). See [API-REFERENCE.md § Scripted-Video (STV-only) Sessions](API-REFERENCE.md#scripted-video-stv-only-sessions) for the full auth/lifecycle table, and `examples/scripted-video-session.mjs` + `.html` for a complete runnable server+browser pair (including a stand-in for your real TTS call).

---

## RAG (knowledge base)

```js
// Path A — ungated, verified live
const rec = await mgmt.knowledge.addRecord({ name: 'Product Docs' }, ks);
const { configId } = await mgmt.intellects.create({
  knowledge_ids: [rec.id],
  capabilities: { use_knowledge_base: 'on' },
}, ks);
// index-delta-v2 runs every ~1 min — call isIndexed() again until it reports {ready:true}
const status = await mgmt.knowledge.isIndexed(rec.id, ks);
```

Content modalities indexed: captions, OCR, document attachments. Don't use
`knowledge.search()`'s "couldn't find relevant information" reply, or
`knowledge.corpusStatus()`'s `populated` flag, as an indexing-status
signal — see API-REFERENCE.md § Ground the Agent for why.

Knowledge records have full lifecycle CRUD (all verified live):

```js
const got = await mgmt.knowledge.getRecord(rec.id, ks);            // read one
await mgmt.knowledge.updateRecord(rec.id, { name: 'Docs v2' }, ks); // rename/edit
await mgmt.knowledge.deleteRecord(rec.id, ks, { confirmPermanent: true });
```

`deleteRecord` does **NOT** unlink the record from intellects that reference it — an intellect's `knowledge_ids` keeps the dangling id. Clear it yourself (`intellectConfig.setKnowledgeIds(configId, [], ks)`) when retiring a record. A deleted or unknown record id → typed `not_found`; another partner's → `forbidden`. A record with more than one `sources` entry (e.g. `internal` + `web` together) can 500 on delete on the current deployment — see Honest limits below.

---

## Honest limits

- **`partner-config/update` 403s today** for a partner admin KS. Brain config (`setBrainConfig`) and the knowledge re-point (Path B) are gated. Probe first; writes return `{applied:false, reason}`. Grounding a new agent via `knowledge_ids` (Path A) is NOT gated. (Lifecycle webhooks have no backend implementation at all — dropped from the SDK.)
- **No verbatim speech** — `speak()` goes through the brain; the avatar may rephrase.
- **Custom face works self-serve** — upload a portrait image via `catalog.createVisual`, pass `itemId` as `visualId` in `provision`/`avatars.create`. The model animates the portrait at runtime. Video-clip ingest (higher-fidelity model) is not yet self-serve.
- **`force_experience` and `model_type:'fast'`** are hints; the SDK can't prove which model replied or which experience rendered.
- **Multi-source Knowledge records can fail to delete.** A record created with more than one `sources` entry (e.g. `internal` + `web` together) reliably 500s on `deleteRecord` on the current deployment (verified live, reproduced 3x, ruled out call ordering and lingering intellect references) — the record itself becomes an orphan (its backing category/entries can still be torn down separately). Single-source records delete cleanly. Until the backend fixes this, avoid mixing source types in one record if you expect to delete it later; use separate records per source type instead.

---

## Reference

| Resource | What it covers |
|----------|---------------|
| [API-REFERENCE.md](API-REFERENCE.md) | Every endpoint, payload, lifecycle, and use-case catalog |
| [docs/WIRE-PROTOCOL.md](docs/WIRE-PROTOCOL.md) | Socket events, `speechId`, WHEP, ICE — verified by live capture |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Backends, runtime, scale, and resilience model — the map |
| [docs/ARCHITECTURE-REFERENCE.md](docs/ARCHITECTURE-REFERENCE.md) | Exact connect sequence, wire shapes, scaling internals, SDK module routing, failure-mode tables |
| [docs/ARCHITECTURE-RECIPE.md](docs/ARCHITECTURE-RECIPE.md) | From-scratch reimplementation recipe, no Kaltura libs |
| [SECURITY.md](SECURITY.md) | NIST 800-53 matrix, FIPS mode, incident-response runbook |
| [docs/CLIENT-COMMANDS.md](docs/CLIENT-COMMANDS.md) | The two deployment gotchas, gotcha-free authoring pattern, and tool-spiral defenses for client-command intellects |
| [docs/GENUI-REFERENCE.md](docs/GENUI-REFERENCE.md) | All first-class GenUI widgets — wire shapes, SDK functions, rendering anchors |
| [docs/DYNAMIC-DATA-INJECTION.md](docs/DYNAMIC-DATA-INJECTION.md) | Per-turn `request_vars`/DPP injection — how to hand the brain live, per-request data |
| [docs/EXTERNAL-API-INTEGRATIONS.md](docs/EXTERNAL-API-INTEGRATIONS.md) | Wiring a brain-called tool to a durable write against your own external API (CRM, spreadsheet, ticketing) |
| [docs/STRUCTURED-DATA-FORMS.md](docs/STRUCTURED-DATA-FORMS.md) | Collecting typed fields from the user mid-conversation (`user_properties_forms`) — schema, rendering, where submitted values go |
| [docs/VOICE-INPUT-MODES.md](docs/VOICE-INPUT-MODES.md) | Choosing open-mic vs. push-to-talk, and the UX/accessibility/safety details around each |
| `examples/` | One runnable example per use-case |
| [.claude/skills/agentic-avatar/SKILL.md](.claude/skills/agentic-avatar/SKILL.md) | Agent Skill — load this SDK's whole surface into Claude Code or any [agentskills.io](https://agentskills.io)-compatible agent |

## License

MIT — see [LICENSE](LICENSE). No Kaltura account or credentials are needed to read, fork, or
build on this SDK's source; a Kaltura account with the Agentic Avatar feature enabled is needed
to call the live APIs it wraps — [start a free trial](https://subscription.kaltura.com/purchase-manager/purchase-manager/avatar-studio-free-trial).
