---
layout: base.njk
title: "Voice Input Modes"
description: "Design guidance for app builders on choosing between continuous open-mic voice input and push-to-talk, and for building the UI around whichever mode you pick."
eyebrow: How-to Guide
---

# Voice Input Modes — choosing and building open-mic vs. push-to-talk

Design guidance for app builders deciding **how a viewer's mic reaches the avatar**: continuous
open-mic listening (VAD auto-cuts turns) or push-to-talk (the viewer explicitly opens and closes a
capture window). This doc is about the **decision and the UI** — for the wire mechanics of
`startTapToTalk()`/`endTapToTalk()` see [README.md](/reference/sdk-reference/#tap-to-talk-push-to-talk-voice),
and for the exact socket events see [WIRE-PROTOCOL.md](/reference/wire-protocol/) (`tapToTalkStart`/`tapToTalkEnd`,
`isTapToTalk`).

## The one rule that overrides everything else here

**Pick one mode per agent, at configuration time. Never offer both live in the same session.**

This is not a UI-polish preference — it is a correctness requirement. The conversation-manager service (`CM`, the server runtime)'s own VAD turn-cutting branches on the agent's *configured* `isTapToTalk` flag, not on whether a tap window is currently open. An open-mic agent (`isTapToTalk:false`) keeps auto-cutting turns from its VAD unconditionally, even while a tap-to-talk bracket is open — the two mechanisms race the same `conversationStatus`/`latestSpeech` state with no mutual exclusion server-side (see WIRE-PROTOCOL.md's `tapToTalkStart`/`tapToTalkEnd` row for the verified source citation). The SDK enforces this client-side (`startTapToTalk()` throws `capability_disabled` unless `session.capabilities.tapToTalk`), but that gate exists because the server will not stop you from getting this wrong.

Every push-to-talk/open-mic product draws the same line — one active capture mechanism, chosen once, not a live per-session toggle exposing both:

<div data-nova-target="voice-input-modes-table" data-nova-label="How other products handle capture mode">

| Product | How it handles capture mode |
|---|---|
| Discord | Single Input Mode setting — no per-session switch |
| Amazon Alexa / Ford SYNC | Wake-word vs. PTT-button are alternate *triggers* for one active capture mechanism, not two concurrent ones |
| WhatsApp | Hold-to-record voice notes only — no separate open-mic mode |

</div>

## Deciding which mode fits your app

| Use open-mic (VAD) when… | Use push-to-talk when… |
|---|---|
| Viewers ask longer, exploratory questions (investor Q&A, tutoring, free-form conversation) | Utterances are short, command-like bursts (a wake word, a walkie-talkie-style call) |
| The environment is relatively quiet / single-speaker (a kiosk, a 1:1 demo) | The environment is noisy or multi-speaker, and VAD would false-trigger on background talk |
| You want zero-friction "just speak naturally" — no button to find or learn | Viewers need an explicit, deliberate boundary on when the mic is live (privacy-sensitive settings, shared/public devices) |

If your viewers will regularly speak in full sentences or ask multi-part questions, open-mic is the
better default. Neither mode is inherently better — press-and-hold can strain a viewer's hand on a
long dictation, and VAD-based toggle can cut a speaker off mid-thought on long unstructured
reasoning. Which complaint you'll hear from your own viewers tracks utterance length, not a fixed
advantage of one mode over the other.

## UX pattern: click-to-toggle, not press-and-hold

Prefer a single click/tap to open the capture window and a second click/tap to close it, over
press-and-hold-to-record. Reasons, in order of weight:

- **Accessibility.** Toggle satisfies WCAG 2.5.2 (Pointer Cancellation, Level A) on its own —
  the down-event never fires the action, so an accidental touch can be dragged away before commit.
  Press-and-hold can satisfy it too (release-to-stop counts as an "up reversal"), but only if release
  doesn't also irreversibly submit the utterance.
- **Screen readers.** Sustained-hold gestures are poorly supported by mobile screen readers (Android
  TalkBack has no native single-tap "hold" gesture — it requires double-tap-then-hold). Toggle needs
  only a single activation gesture, which every screen reader supports natively.
- **Usability at length.** Holding a button for the duration of a multi-sentence question is
  physically awkward and blocks other interaction (scrolling, reading) with the holding hand/thumb.

If your product genuinely needs walkie-talkie-style short bursts (not this SDK's typical investor-deck
or knowledge-avatar use case), a press-and-hold-with-slide-to-lock hybrid (WhatsApp's pattern) is the
documented middle ground — but start from toggle and only move to hold-based capture if you have
evidence your utterances are consistently short.

## Visual and non-visual state feedback

Give the viewer three redundant signals that the mic is live, not one:

1. **Icon/color change** on the button itself (e.g. this SDK's existing `#btn-mute` icon-swap pattern
   in the reference app — mirror that structure for a tap-to-talk button: swap an idle-mic icon for a
   recording icon, not just an `aria-pressed` attribute change).
2. **An animated level indicator** — a waveform, pulsing glow, or (simplest, and already available)
   this SDK's `localMicLevel` event (`{level}`, 0–1, ~50ms tick) driving a CSS custom property, exactly
   as the reference app's mute button already does for open-mic. A single static icon alone is not
   enough (NN/g's critique of Amazon Echo's single light ring as "a far cry from rich textual
   feedback").
3. **A live-region text or caption update** (`aria-live`) confirming state changes ("Listening…" /
   "Sent") — necessary for screen-reader users who can't see the icon/waveform at all. Pair with an
   audio cue (a short start/stop tone) as an additional non-visual channel if your app's audio design
   allows it.

## Safety: don't let a capture window hang open forever

A tap window that never closes (tab closed mid-recording, app crash, network drop) must not leave the
CM's `InTappedMode` state stuck. Layer these on top of `startTapToTalk()`/`endTapToTalk()`:

- **Silence-based auto-stop** — close the window automatically after a period of continuous silence,
  so a forgotten "open" mic doesn't stay live indefinitely.
- **A hard max-duration cap** — an absolute ceiling regardless of speech/silence, as a backstop.
- **Treat disconnect/`pagehide`/`visibilitychange` as an implicit close** — the browser's own
  `getUserMedia`/socket teardown on tab close is the only mechanism that reliably fires when the
  viewer abandons the tab mid-recording; call `endTapToTalk()` (or just let `disconnect` naturally end the
  session) from those events rather than assuming a clean call will always arrive.

## Implementation checklist

1. Decide the agent's mode **at provisioning time** — `isTapToTalk` is a fixed per-agent deployment
   choice (set wherever your app builds its intellect/session config), not something your UI code
   branches on live.
2. Build the UI conditionally on `session.capabilities.tapToTalk` (derived from
   `clientConfiguration.isTapToTalk`) — render a tap-to-talk control only when true, and never render
   both a tap-to-talk control and an open-mic affordance for the same session.
3. Wire click-to-toggle calling `session.startTapToTalk()`/`session.endTapToTalk()`, updating
   `aria-pressed` and an icon/level indicator on `tapToTalkStarted`/`tapToTalkEnded` — see the
   conditional-UI example in [README.md](/reference/sdk-reference/#tap-to-talk-push-to-talk-voice).
4. Add the silence/max-duration/abandonment safeguards above; the SDK does not impose them for you.
5. Update any UI copy that currently assumes continuous listening (e.g. a text-input placeholder like
   "...or just speak naturally") — that copy is wrong for a tap-to-talk agent and should describe the
   button instead.

## Related docs

| Doc | What it adds |
|-----|---------------|
| [README.md](/reference/sdk-reference/#tap-to-talk-push-to-talk-voice) | The SDK API: `startTapToTalk()`/`endTapToTalk()`, the `capability_disabled` gate, `tapToTalkActive`/`capabilities.tapToTalk` |
| [WIRE-PROTOCOL.md](/reference/wire-protocol/) | The exact `tapToTalkStart`/`tapToTalkEnd` socket events and the verified CM source finding behind the mixed-mode gate |
| [CLIENT-COMMANDS.md](/guides/client-commands/) | A different silent client→page channel (tool calls), not voice input — useful contrast for what this doc is *not* about |
