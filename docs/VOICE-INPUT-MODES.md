# Voice Input Modes — choosing and building open-mic vs. push-to-talk

Design guidance for app builders deciding **how a viewer's mic reaches the avatar**: continuous
open-mic listening (VAD auto-cuts turns) or push-to-talk (the viewer explicitly opens and closes a
capture window). This doc is about the **decision and the UI** — for the wire mechanics of
`startTapToTalk()`/`endTapToTalk()` see [README.md](../README.md#tap-to-talk-push-to-talk-voice),
and for the exact socket events see [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md) (`tapToTalkStart`/`tapToTalkEnd`,
`isTapToTalk`).

## The one rule that overrides everything else here

**Pick one mode per agent, at configuration time. Never offer both live in the same session.**

This is not a UI-polish preference — it is a correctness requirement. The conversation-manager's own
VAD turn-cutting branches on the agent's *configured* `isTapToTalk` flag, not on whether a tap window
is currently open. An open-mic agent (`isTapToTalk:false`) keeps auto-cutting turns from its VAD
unconditionally, even while a tap-to-talk bracket is open — the two mechanisms race the same
`conversationStatus`/`latestSpeech` state with no mutual exclusion server-side (see WIRE-PROTOCOL.md's
`tapToTalkStart`/`tapToTalkEnd` row for the verified source citation). The SDK enforces this client-side
(`startTapToTalk()` throws `capability_disabled` unless `session.capabilities.tapToTalk`), but that gate
exists because the server will not stop you from getting this wrong.

Every push-to-talk/open-mic product surveyed for this guidance — Discord (single Input Mode setting),
Amazon Alexa/Ford SYNC (wake-word vs. PTT-button as alternate *triggers* for one active capture
mechanism, not two concurrent ones), WhatsApp (hold-to-record voice notes, no separate open-mic mode) —
draws the same line: one active capture mechanism, chosen once, not a live per-session toggle exposing
both.

## Deciding which mode fits your app

| Use open-mic (VAD) when… | Use push-to-talk when… |
|---|---|
| Users ask longer, exploratory questions (investor Q&A, tutoring, free-form conversation) | Utterances are short, command-like bursts (a wake word, a walkie-talkie-style call) |
| The environment is relatively quiet / single-speaker (a kiosk, a 1:1 demo) | The environment is noisy or multi-speaker, and VAD would false-trigger on background talk |
| You want zero-friction "just speak naturally" — no button to find or learn | Users need an explicit, deliberate boundary on when the mic is live (privacy-sensitive settings, shared/public devices) |

If your app's users will regularly speak in full sentences or ask multi-part questions, open-mic is
the better default — the market research behind this doc found user complaints in both directions
(ChatGPT iOS's press-and-hold caused thumb strain and blocked scrolling while dictating; Gemini Live's
toggle/VAD mode cut off users mid-thought on long unstructured reasoning), and the complaints track
utterance length more than any inherent superiority of one mode.

## UX pattern: click-to-toggle, not press-and-hold

Prefer a single click/tap to open the capture window and a second click/tap to close it, over
press-and-hold-to-record. Reasons, in order of weight:

- **Accessibility.** WCAG 2.5.2 (Pointer Cancellation, Level A) is satisfied more simply by toggle —
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
   as the reference app's mute button already does for open-mic. A single static icon alone was
   explicitly criticized in the market research (NN/g's critique of Amazon Echo's single light ring as
   "a far cry from rich textual feedback").
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
  `getUserMedia`/socket teardown on tab close is the only mechanism that reliably fires when the user
  abandons the tab mid-recording; call `endTapToTalk()` (or just let `disconnect` naturally end the
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
   conditional-UI example in [README.md](../README.md#tap-to-talk-push-to-talk-voice).
4. Add the silence/max-duration/abandonment safeguards above; the SDK does not impose them for you.
5. Update any UI copy that currently assumes continuous listening (e.g. a text-input placeholder like
   "...or just speak naturally") — that copy is wrong for a tap-to-talk agent and should describe the
   button instead.

## Related docs

| Doc | What it adds |
|-----|---------------|
| [README.md](../README.md#tap-to-talk-push-to-talk-voice) | The SDK API: `startTapToTalk()`/`endTapToTalk()`, the `capability_disabled` gate, `tapToTalkActive`/`capabilities.tapToTalk` |
| [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md) | The exact `tapToTalkStart`/`tapToTalkEnd` socket events and the verified CM source finding behind the mixed-mode gate |
| [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md) | A different silent client→page channel (tool calls), not voice input — useful contrast for what this doc is *not* about |
