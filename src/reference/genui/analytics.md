---
layout: base.njk
title: "GenUI · Widget Analytics"
description: "How to report GenUI widget interactions to KAVA via KavaAnalytics.buttonClicked() without duplicating what the platform already tracks server-side."
eyebrow: Reference
---

# Widget-interaction analytics (avoiding double-counting)

A recipe for reporting GenUI widget interactions — which widget the learner acted on, what they picked — to KAVA via `KavaAnalytics.buttonClicked()` (`./experience/analytics`), without duplicating anything the platform already tracks server-side.

**On this page:** [What not to report (read this first)](#what-not-to-report-read-this-first) · [The recipe: two widget interaction types, two distinguishable events](#the-recipe-two-widget-interaction-types-two-distinguishable-events) · [Live-verified](#live-verified) · [Related docs](#related-docs)

## What not to report (read this first)

The backend (the session server + the brain) already reports its own server-side KAVA events for every session a `KalturaAvatarSession` connects to — the 80000-range "Immersive Agents" events: `callStarted`, `callEnded`, `messageResponse` (message delivery), and `messageFeedbackSent` (feedback). `KavaAnalytics` has no code path that can send any of these (see the module docblock in `src/experience/analytics.js`) — that is deliberate, not a gap to fill. Do **not** build client-side reporting for:

| Already server-tracked (80000-range) | Don't re-report client-side as... |
|---|---|
| A message was delivered to the user | A `buttonClicked`/`pageLoad` for "message shown" |
| The user thumbs-up/down'd a reply (`mgmt.feedback.add`) | A `buttonClicked` for "feedback given" |
| A call/session started or ended | A `buttonClicked`/`pageLoad` for "session start/end" |

A GenUI widget rendering on screen isn't itself one of those signals — the widget's *arrival* rides the same message-delivery event the server already counted. What's safe to report (because it has no server-side equivalent) is the **client-only choice the learner makes on that widget** — which chip they clicked, which link they opened, which answer they picked. That choice is the only thing this recipe reports.

## The recipe: two widget interaction types, two distinguishable events

Wire each widget's `onAction` intent (see [GenUI · Authoring and Consuming Widgets § `onAction`, `WIDGET_KINDS`, and the hand-rolled escape hatch](/reference/genui/authoring-and-consuming/#onaction-widget_kinds-and-the-hand-rolled-escape-hatch) above) straight into one `buttonClicked()` call. Construct one `KavaAnalytics` per page/session (same pattern as README's [KAVA analytics](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md#kava-analytics-opt-in-client-only-application-events) section) and call it from the same `onAction` handler you already pass to `ExperienceRenderer`:

```js
import { ExperienceRenderer } from '@kaltura/intelligent-agents/experience/genui';
import { KavaAnalytics } from '@kaltura/intelligent-agents/experience/analytics';

const analytics = new KavaAnalytics({
  partnerId: AGENTIC_PARTNER_ID,
  sessionId: session.threadId,   // ties the event to this conversation without re-reporting the conversation itself
  hostingKalturaApplication: 25, // HOSTING_APPLICATIONS.agents
});

new ExperienceRenderer({
  session,
  mount: document.getElementById('widgets'),
  onAction(action, payload) {
    if (action === 'followup') {
      // Interaction type 1: a followups-tool suggested-question chip was clicked.
      analytics.buttonClicked({
        buttonType: 'Select',
        buttonName: 'genui-followup-chip',
        buttonValue: payload.question,   // which chip — makes this event distinguishable per question
        buttonInfo: 'GenUI followups widget — suggested-question chip clicked',
      });
      session.speak(payload.question);
    } else if (action === 'open') {
      // Interaction type 2: a show-link-tool (or sources/content-gallery) link card was opened.
      analytics.buttonClicked({
        buttonType: 'Open',
        buttonName: 'genui-show-link-card',
        buttonValue: payload.url,
        buttonInfo: 'GenUI show-link widget — link card opened',
      });
    }
  },
}).start();
```

Two rules keep the two events distinguishable and non-duplicated:

- **A different `buttonName` per widget/interaction type** (`genui-followup-chip` vs. `genui-show-link-card`) — this is what a KAVA dashboard groups and filters on. Don't reuse one generic name across widget kinds.
- **`buttonValue` carries the specific choice** (the exact question text, the exact URL) rather than a boolean or the widget kind — the kind already lives in `buttonName`. Two clicks on two different chips inside the SAME `followups` widget still produce two distinct, non-duplicate rows, because each carries a different `buttonValue`.

Apply the same two-line pattern to any other `onAction` intent with no server-side equivalent: `'play'` (`{entryId, url, embedUrl}` — a video-gallery clip opened) and `'submit'` (`{values}` — a `user-properties-form` was submitted; report only that it happened and which fields were filled, not the raw values if they're personal data — see [Structured Data Forms](/guides/structured-data-forms/) for where that data durably belongs instead).

## Live-verified

Both `followups-tool` and `show-link-tool` (the second requires enabling the `show_link` capability — OFF by default, see [GenUI · Authoring and Consuming Widgets](/reference/genui/authoring-and-consuming/#authoring--which-capability-turns-each-widget-on)) were captured firing in the same real turn against a live agent over the HTTP converse path, assembled with `SegmentAssembler`, and run through the two `buttonClicked()` calls above with an injected transport so no test rows landed on production KAVA. The two resulting payloads shared the same `partnerId`/`sessionId` (same conversation) but differed in `buttonName`/`buttonType`/`buttonValue` — two distinguishable, non-duplicated events tied to one conversation, not two copies of the same one.

## Related docs

| Doc | Covers |
|---|---|
| [GenUI · Authoring and Consuming Widgets](/reference/genui/authoring-and-consuming/) | `ExperienceRenderer`'s `onAction` contract this recipe wires into |
| [GenUI · Per-Runtime Widget Detail](/reference/genui/widgets/) | Per-runtime model keys, constraints, and descriptor shapes |
| [GenUI Reference](/reference/genui-reference/) | Back to the index |

