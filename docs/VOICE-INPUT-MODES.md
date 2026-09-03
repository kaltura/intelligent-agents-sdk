# Input Modes — open-mic, push-to-talk, and text-only chat

Design guidance for app builders deciding **how a viewer's input reaches the agent**. Three modes:

| Mode | Session class | Mic permission | How a turn starts |
|---|---|---|---|
| **Open-mic** (VAD) | `KalturaAvatarSession` | Prompted at connect* | Viewer just speaks; server VAD cuts the turn |
| **Push-to-talk** | `KalturaAvatarSession` (`isTapToTalk`) | Prompted at connect* | Viewer opens/closes a capture window (`startTapToTalk()`/`endTapToTalk()`) |
| **Chat (text-only)** | `KalturaChatSession` | **Never requested** — the class never touches `getUserMedia` or WebRTC | `sendText('…')` over plain HTTPS |

\* Or deferred: `micStartMode: 'deferred'` connects the avatar session with no mic at all, and the app calls `startMic()` later from a real user click, so the permission prompt is gesture-anchored instead of firing on page load. Until then, typed turns work; `startTapToTalk()` throws `mic_not_started`. See [README.md](../README.md#devices-and-media-quality).

The first two are **voice-capture** modes on the live avatar transport; most of this doc is about choosing between them and building their UI. Chat mode is a full text-only transport — same brain, same tools, same thread — covered in [README.md](../README.md#text-only-chat-kalturachatsession), with mid-conversation switching between avatar and chat via `KalturaAgentSession` ([switching section below](#switching-between-avatar-and-chat-mid-conversation)). For the wire mechanics of `startTapToTalk()`/`endTapToTalk()` see [README.md](../README.md#tap-to-talk-push-to-talk-voice), and for the exact socket events see [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md) (`tapToTalkStart`/`tapToTalkEnd`, `isTapToTalk`).

Text input is not voice-mode-exclusive: an avatar session accepts typed turns too (`session.speak(text)` — see [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md) and README). Offering a text box *alongside* either voice mode is how the SDK satisfies EN 301 549 §6.2.1.2 (concurrent voice and text) — see [README.md](../README.md#accessibility-wcag-22-aa--captions--ai-disclosure-gate).

## The one rule that overrides everything else here

**Pick one VOICE mode per agent, at configuration time. Never offer both voice modes live in the same session.** (Chat text-only input is exempt — typed turns don't touch the VAD/capture machinery this rule protects, so text can coexist with either voice mode, or replace voice entirely.)

This is not a UI-polish preference. It is a correctness requirement.

**The server will not stop you from getting this wrong.** The SDK's own client-side gate (`startTapToTalk()` throws `capability_disabled` unless `session.capabilities.tapToTalk`) is the only thing standing between you and the failure below — the server itself never rejects the mismatch.

The server's own VAD turn-cutting branches on the agent's *configured* `isTapToTalk` flag, not on whether a tap window is currently open. An open-mic agent (`isTapToTalk:false`) keeps auto-cutting turns from its VAD unconditionally, even while a tap-to-talk bracket is open. The two mechanisms race the same `conversationStatus`/`latestSpeech` state with no mutual exclusion server-side (see WIRE-PROTOCOL.md's `tapToTalkStart`/`tapToTalkEnd` row).

Every push-to-talk/open-mic product draws the same line — one active capture mechanism, chosen once, not a live per-session toggle exposing both:

<!-- nova-target: voice-input-modes-table | How other products handle capture mode -->

| Product | How it handles capture mode |
|---|---|
| Discord | Single Input Mode setting — no per-session switch |
| Amazon Alexa / Ford SYNC | Wake-word vs. PTT-button are alternate *triggers* for one active capture mechanism, not two concurrent ones |
| WhatsApp | Hold-to-record voice notes only — no separate open-mic mode |
<!-- /nova-target -->

## Deciding which mode fits your app

| Use open-mic (VAD) when… | Use push-to-talk when… | Use chat (text-only) when… |
|---|---|---|
| Viewers ask longer, exploratory questions (investor Q&A, tutoring, free-form conversation) | Utterances are short, command-like bursts (a wake word, a walkie-talkie-style call) | The viewer can't or won't speak (open office, quiet space, no mic) or won't grant mic permission |
| The environment is relatively quiet / single-speaker (a kiosk, a 1:1 demo) | The environment is noisy or multi-speaker, and VAD would false-trigger on background talk | Bandwidth is constrained — no video, no WebRTC, just HTTPS request/response |
| You want zero-friction "just speak naturally" — no button to find or learn | Viewers need an explicit, deliberate boundary on when the mic is live (privacy-sensitive settings, shared/public devices) | You need a zero-permission-prompt entry point; the viewer can switch up to the full avatar later without losing the thread |

If your viewers will regularly speak in full sentences or ask multi-part questions, open-mic is the better default. Neither mode is inherently better — press-and-hold can strain a viewer's hand on a long dictation, and VAD-based toggle can cut a speaker off mid-thought on long unstructured reasoning. Which complaint you'll hear from your own viewers tracks utterance length, not a fixed advantage of one mode over the other.

## UX pattern: click-to-toggle, not press-and-hold

Prefer a single click/tap to open the capture window and a second click/tap to close it, over press-and-hold-to-record. Reasons, in order of weight:

- **Accessibility.** Toggle satisfies WCAG 2.5.2 (Pointer Cancellation, Level A) on its own — the down-event never fires the action, so an accidental touch can be dragged away before commit. Press-and-hold can satisfy it too (release-to-stop counts as an "up reversal"), but only if release doesn't also irreversibly submit the utterance.
- **Screen readers.** Sustained-hold gestures are poorly supported by mobile screen readers (Android TalkBack has no native single-tap "hold" gesture — it requires double-tap-then-hold). Toggle needs only a single activation gesture, which every screen reader supports natively.
- **Usability at length.** Holding a button for the duration of a multi-sentence question is physically awkward and blocks other interaction (scrolling, reading) with the holding hand/thumb.

If your product genuinely needs walkie-talkie-style short bursts (not this SDK's typical investor-deck or knowledge-avatar use case), a press-and-hold-with-slide-to-lock hybrid (WhatsApp's pattern) is the documented middle ground — but start from toggle and only move to hold-based capture if you have evidence your utterances are consistently short.

## Visual and non-visual state feedback

Give the viewer three redundant signals that the mic is live, not one:

1. **Icon/color change** on the button itself (e.g. this SDK's existing `#btn-mute` icon-swap pattern in the reference app — mirror that structure for a tap-to-talk button: swap an idle-mic icon for a recording icon, not just an `aria-pressed` attribute change).
2. **An animated level indicator** — a waveform, pulsing glow, or (simplest, and already available) this SDK's `localMicLevel` event (`{level}`, 0–1, ~50ms tick) driving a CSS custom property, exactly as the reference app's mute button already does for open-mic. A single static icon alone is not enough (NN/g's critique of Amazon Echo's single light ring as "a far cry from rich textual feedback").
3. **A live-region text or caption update** (`aria-live`) confirming state changes ("Listening…" / "Sent") — necessary for screen-reader users who can't see the icon/waveform at all. Pair with an audio cue (a short start/stop tone) as an additional non-visual channel if your app's audio design allows it.

## Safety: don't let a capture window hang open forever

A tap window that never closes (tab closed mid-recording, app crash, network drop) must not leave the server's tap-mode state stuck open. Layer these on top of `startTapToTalk()`/`endTapToTalk()`:

- **Silence-based auto-stop** — close the window automatically after a period of continuous silence, so a forgotten "open" mic doesn't stay live indefinitely.
- **A hard max-duration cap** — an absolute ceiling regardless of speech/silence, as a backstop.
- **Treat disconnect/`pagehide`/`visibilitychange` as an implicit close** — the browser's own `getUserMedia`/socket teardown on tab close is the only mechanism that reliably fires when the viewer abandons the tab mid-recording; call `endTapToTalk()` (or just let `disconnect` naturally end the session) from those events rather than assuming a clean call will always arrive.

## Implementation checklist

1. Decide the agent's mode **at provisioning time** — `isTapToTalk` is a fixed per-agent deployment choice (set wherever your app builds its intellect/session config), not something your UI code branches on live.
2. Build the UI conditionally on `session.capabilities.tapToTalk` (derived from `clientConfiguration.isTapToTalk`) — render a tap-to-talk control only when true, and never render both a tap-to-talk control and an open-mic affordance for the same session.
3. Wire click-to-toggle calling `session.startTapToTalk()`/`session.endTapToTalk()`, updating `aria-pressed` and an icon/level indicator on `tapToTalkStarted`/`tapToTalkEnded` — see the conditional-UI example in [README.md](../README.md#tap-to-talk-push-to-talk-voice).
4. Add the silence/max-duration/abandonment safeguards above; the SDK does not impose them for you.
5. Update any UI copy that currently assumes continuous listening (e.g. a text-input placeholder like "...or just speak naturally") — that copy is wrong for a tap-to-talk agent and should describe the button instead.

## Switching between avatar and chat mid-conversation

`KalturaAgentSession` runs one conversation over either transport and switches between them with `switchMode('avatar' | 'chat')` — the thread, the `request_vars` context, and every `onToolCall` handler carry over automatically. One state machine:

| From | Call / event | To | Notes |
|---|---|---|---|
| `idle` | `connect()` | `connecting` → `connected` | Once-only; a second `connect()` throws `invalid_state` |
| `connected` | `switchMode(other)` | `switching` → `connected` | Emits `transportChanged`, then `modeChanged {mode, threadContinuity}` |
| `connected` | `switchMode(current)` | `connected` | Idempotent no-op — nothing tears down |
| `switching` | switch fails | `failed` (`reason: 'transport_failed'`) | No rollback; buffered sends reject with the switch error |
| `connected` | transport dies | `failed` + `ended` forwarded | Socket drop, server end |
| any | `disconnect()` | `closed` | Idempotent; exactly one `ended {reason:'disconnected'}` |

`modeChanged.threadContinuity` is the honest signal: `true` means the new transport was seeded with the live thread (show "conversation restored"); `false` means no turn had happened yet, so there was no thread to carry.

Two UX rules for the switch:

- **Switching INTO a voice mode prompts for the mic.** Browsers require a live user gesture for `getUserMedia`, and a prior grant in chat mode doesn't exist to reuse. Route `switchMode('avatar')` through a real click target (a "Continue with video" button), never a state-change callback — a programmatic call outside a gesture gets auto-denied, landing the session in `failed` (`reason: 'permission_denied'` on the initial connect path).
- **Expect a brief reconnect blip.** Switching is tear-down-and-reconstruct by design — show a transient "switching…" state on the facade's `stateChange {state:'switching'}` event rather than hiding it. `sendText()` calls during the blip are buffered (up to 8) and delivered in order on the new transport.

## Related docs

| Doc | What it adds |
|-----|---------------|
| [README.md](../README.md#tap-to-talk-push-to-talk-voice) | The SDK API: `startTapToTalk()`/`endTapToTalk()`, the `capability_disabled` gate, `tapToTalkActive`/`capabilities.tapToTalk` |
| [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md) | The exact `tapToTalkStart`/`tapToTalkEnd` socket events and the finding behind the mixed-mode gate |
| [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md) | A different silent client→page channel (tool calls), not voice input — useful contrast for what this doc is *not* about |
| [README.md](../README.md#text-only-chat-kalturachatsession) | `KalturaChatSession` (text-only transport) and `KalturaAgentSession` (mode switching) — full API |
