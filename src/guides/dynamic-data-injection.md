---
layout: base.njk
title: "Dynamic Data Injection"
description: "Explains the four mechanisms for getting your app's state into the avatar conversation — request_vars, setDynamicPrompt, speak, and submitStructuredDataForm — and when to use each."
eyebrow: How-to Guide
---

# Dynamic Data Injection — keeping the brain in sync with your app

Design guidance for app builders on **getting your app's state into the conversation** — who the
viewer is, what's currently on screen, and what just happened in your UI — so the brain reasons
with fresh, correct context instead of a stale snapshot from when the session first connected.

The SDK gives you four distinct mechanisms for this, each solving a different problem. Reaching
for the wrong one is the most common integration mistake: using a passive mechanism when you
needed the brain to react *right now*, or using the active one for something that should just be
quiet background context. This doc explains why each exists, when to reach for it, and how they
compose into one coherent update flow.

## Four ways to get information to the brain

| Mechanism | What it's for | Does it make the avatar talk? |
|---|---|---|
| [`requestVars` / `session.updateRequestVars()`](#personalization-request_vars) | Slow-changing personalization substituted into `{{var}}` prompt templates (viewer name, account tier) | No — passive |
| [`session.setDynamicPrompt()`](#per-turn-context-the-dynamic-prompt) | A full, structured context blob the brain reads fresh on its next turn (what's on screen right now) | No — passive |
| [`session.speak()`](#the-active-nudge-speak) | Actively provoke a new turn — the brain reacts immediately, in this turn | Yes — this is the only one of the four that does |
| [`session.submitStructuredDataForm()`](#answering-a-brain-initiated-request) | Answer a request the brain itself made for structured fields | No — feeds the answer back into the conversation |

The first two are **passive**: they update what the brain will see, whenever its next turn
happens to occur. `speak()` is the only **active** one — it's the trigger that makes a turn happen
right now. Getting this distinction right is the key to reliable behavior: if you need the brain
to react to something the instant it happens (a modal just closed, a background action just
finished), a passive update alone will sit there unread until some *other* turn happens to occur —
sometimes much later, sometimes never in a short session.

## Personalization: `request_vars`

Pass slow-changing facts about the viewer that your prompt substitutes directly via `{{var}}`
templating — a name, an account tier, a language preference, anything your prompt's own template
references by key. Set it once at connect time, and update it again later as you learn more:

```js
const session = new KalturaAvatarSession({
  token, /* … */,
  requestVars: { user_name: 'Ada' },
});

// later, once you learn more about the viewer:
session.updateRequestVars({ user_name: 'Ada', account_tier: 'enterprise' });
```

The one rule that matters: **`updateRequestVars()` always sends the full current map.** The
backend resets `request_vars` to exactly what you send — it does not merge with the join-time map
or a previous call. If you only send `{ account_tier: 'enterprise' }`, you have just erased
`user_name` for the rest of the session. Keep the full map in your own app state and resend all of
it on every call.

Use this for values your prompt's `{{ }}` placeholders reference by name, and that don't change
every turn. It is not the right tool for "what's on screen right now" — for that, see the dynamic
prompt below.

## Per-turn context: the dynamic prompt

`setDynamicPrompt()` sends a full, structured JSON blob the brain reads as live context for its
next turns — not a set of named template substitutions, but a whole object your prompt can reason
over freely (the current slide's data, the current page section, the state of a task the viewer is
in the middle of).

```js
session.setDynamicPrompt({
  current_section: 'pricing',
  section_summary: 'Enterprise tier: $499/mo, includes SSO and priority support.',
});
```

This is **context, not speech** — calling it does not make the avatar say anything. It just
updates what the brain will read the next time it takes a turn, whenever that happens to be
(a user's next utterance, a tool call response, or an active nudge — see below).

Reach for this over `request_vars` when you have more than a handful of named values, when the
shape changes turn to turn, or when your prompt needs to reason over the data rather than just
substitute it into fixed template slots.

If you're using the SDK's `Presenter` plugin for a slide-deck-style walkthrough, it already
manages per-slide dynamic-prompt injection for you — see [README.md → Presenter](/reference/sdk-reference/#experience)
for the deck-specific API surface. `Presenter.refreshDpp()` re-sends the current context outside
of a navigation, which is exactly the building block the worked example below relies on.

## The active nudge: `speak()`

`speak()` is the one mechanism that actually provokes a new turn — it's routed through the same
pipeline as the viewer's own speech, so the brain reasons over it and responds, right then.

```js
session.speak('Tell me about your pricing.');
```

You're not limited to putting the viewer's own words here. A common and effective pattern is to
send a short, clearly-tagged app-generated message describing something that just happened in
your UI, so the brain reacts to it immediately rather than waiting for whatever the next real user
turn happens to be:

```js
session.speak('[SECTION CHANGE] The viewer just opened the pricing section — discuss THIS section only.');
```

A bracketed tag like `[SECTION CHANGE]` is not a wire-level feature — it's a convention. If your
system prompt is written to recognize a tag like this as an app-generated cue (as opposed to
something the viewer said out loud), you get a clean, unambiguous signal to react to, without ever
putting synthetic text in the viewer's own mouth. Design your own tag vocabulary to match whatever
events your app needs the brain to react to instantly.

**Pair it with a context update, in this order:** call `setDynamicPrompt()` (or
`Presenter.refreshDpp()`) first, then `speak()` immediately after. That way the nudge that
provokes the turn arrives *after* the context it needs to reason correctly about is already in
place, not racing it.

## Answering a brain-initiated request

The three mechanisms above all push data from your app *to* the brain. There's also a path in the
other direction: your agent's configuration can require the brain to ask the viewer for specific
structured fields at some point in the conversation (an email, a booking date, a support ticket's
category) — see [STRUCTURED-DATA-FORMS.md](/guides/structured-data-forms/) for how to configure what it
asks for. Once your UI collects the viewer's answer, hand it back with:

```js
session.submitStructuredDataForm({ email: 'ada@example.com' });
```

This routes the value back into the conversation so the brain can act on it. Treat the moment your
UI closes that form (submitted or explicitly declined) as a real, immediate event worth an active
nudge too — see the worked example below.

## How they work together — a worked example

Consider an interactive product walkthrough: viewer identity is known at connect, the UI advances
through sections as the viewer explores, and partway through, the agent asks the viewer for an
email address via a structured data form.

```js
// 1. Connect — personalization the prompt substitutes via {{user_name}}.
const session = new KalturaAvatarSession({ token, /* … */, requestVars: { user_name: 'Ada' } });
await session.connect();

// 2. The viewer navigates to a new section — refresh context, then actively nudge.
function onSectionChange(section) {
  session.setDynamicPrompt({ current_section: section.id, section_summary: section.summary });
  session.speak(`[SECTION CHANGE] Now viewing "${section.title}" — discuss THIS section only.`);
}

// 3. The brain asks for an email; your UI renders the form and the viewer submits it.
function onEmailFormClosed(email) {
  if (email) session.submitStructuredDataForm({ email });
  // The form closing either way is a real, immediate event — refresh context, then
  // nudge, exactly like a section change, rather than waiting for whatever turn
  // happens next to pick it up.
  session.setDynamicPrompt({ email_form_status: email ? 'submitted' : 'declined' });
  session.speak(`[EMAIL FORM] The form just closed — the viewer ${email ? 'submitted an email' : 'declined'}.`);
}
```

The pattern that repeats: **update context, then actively nudge, in that order, for anything that
just happened and needs an immediate reaction.** Use `request_vars` only for the slow-changing
facts that rarely change after connect.

## Which one do I want?

| I need to… | Use |
|---|---|
| Substitute the viewer's name/tier into my prompt template | `request_vars` (`updateRequestVars()`) |
| Give the brain a full snapshot of what's on screen, for whenever it next speaks | `setDynamicPrompt()` |
| Make the brain react to something *right now*, not whenever it next happens to speak | `setDynamicPrompt()` + `speak()` |
| Get an answer back for a field the brain itself asked for | `submitStructuredDataForm()` |

## Related but distinct: client-side commands

If instead you need the *avatar* to drive your UI — navigate, open a panel, highlight something —
that's a different, silent channel (`session.onToolCall()`), not a data-injection mechanism. See
[CLIENT-COMMANDS.md](/guides/client-commands/).

## Related docs

| Doc | What it adds |
|-----|---------------|
| [README.md → `{{var}}` Jinja personalization](/reference/sdk-reference/#var-jinja-personalization-request_vars) | The `request_vars` API reference |
| [README.md → Experience](/reference/sdk-reference/#experience) | `KalturaAvatarSession` and the `Presenter` deck plugin this doc's worked example builds on |
| [STRUCTURED-DATA-FORMS.md](/guides/structured-data-forms/) | Configuring what the brain asks the viewer for, and how it's rendered |
| [CLIENT-COMMANDS.md](/guides/client-commands/) | The avatar-driving-your-UI channel — the opposite direction from this doc |
| [WIRE-PROTOCOL.md](/reference/wire-protocol/) | The exact socket events behind each mechanism, for anyone debugging at the wire level |
