# Dynamic Data Injection — keeping the brain in sync with your app

Design guidance for app builders on **getting your app's state into the conversation** — who the
viewer is, what's currently on screen, and what just happened in your UI — so the brain reasons
with fresh, correct context instead of a stale snapshot from when the session first connected.

The SDK gives you three mechanisms, each solving a different problem. Reaching for the wrong one
is the most common integration mistake: using a passive mechanism when you needed the brain to
react *right now*, or using the active one for something that should just be quiet background
context. This doc explains why each exists, when to reach for it, and how they compose into one
coherent update flow.

## Three ways to get information to the brain

| Mechanism | What it's for | Does it make the avatar talk? |
|---|---|---|
| [Request variables](#the-context-channel-request-variables) — `requestVars` / `updateRequestVars()` / `setDynamicPrompt()` | Everything the brain should *know*: viewer facts for `{{var}}` prompt slots, and a full structured page-context blob. Persists for the whole thread. | No — passive |
| [`session.speak()`](#the-active-nudge-speak) | Actively provoke a new turn — the brain reacts immediately, in this turn | Yes — the only one that does |
| [`session.submitStructuredDataForm()`](#answering-a-brain-initiated-request) | Answer a request the brain itself made for structured fields | No — feeds the answer back into the conversation |

Request variables are **passive**: they update what the brain will see, whenever its next turn
happens to occur. `speak()` is the only **active** one — it's the trigger that makes a turn happen
right now. Getting this distinction right is the key to reliable behavior: if you need the brain
to react to something the instant it happens (a modal just closed, a background action just
finished), a passive update alone will sit there unread until some *other* turn happens to occur —
sometimes much later, sometimes never in a short session.

## The context channel: request variables

Request variables (`request_vars`) are the SDK's one channel for app-supplied context. Each
variable is a string value the brain's prompt reads via `{{var}}` templating — a viewer's name, an
account tier, or a whole JSON document the prompt reasons over. Seed them at connect time, update
them any time after:

```js
const session = new KalturaAvatarSession({
  token, /* … */,
  requestVars: { user_name: 'Ada' },
});

// later, once you learn more about the viewer:
session.updateRequestVars({ account_tier: 'enterprise' });
```

Three properties make this channel do the heavy lifting:

- **Updates merge.** `updateRequestVars(vars)` merges what you pass into the session's canonical
  map — send only the keys that changed; keys you omit keep their values. (The full merged map
  goes to the server each time, and the server also merges per-thread, so a headless
  `converse` call sending a delta behaves the same way.)
- **Values persist for the whole thread.** Send a variable once and every later turn on that
  thread still sees it — you don't resend per turn. A new thread starts clean. On a warm
  reconnect the SDK re-sends the full map automatically.
- **Values are strings, and can be big.** Tens of kilobytes of JSON in one variable works —
  the SDK's live verification pushes a ~31 KB blob through and reads it back (see
  [Verified live](#verified-live) below).

### Page context: `setDynamicPrompt()`

For "what's on screen right now" — the current slide, page section, or task state — you don't
hand-pick variables. `setDynamicPrompt(data)` serializes any JSON-safe object into one
well-known request variable, `page_context`, and sends it through the same channel:

```js
session.setDynamicPrompt({
  current_section: 'pricing',
  section_summary: 'Enterprise tier: $499/mo, includes SSO and priority support.',
});
```

Each call replaces the previous `page_context` whole (it's one variable — no deep merge), and it
persists on the thread like any other variable. This is **context, not speech** — calling it does
not make the avatar say anything. It just updates what the brain reads the next time it takes a
turn.

**The prompt must reference `{{page_context}}`, or the brain never sees it.** The management
entry point exports the canonical prompt block for this — spread `PAGE_CONTEXT_PROMPT` into the
`prompts[]` you provision instead of hand-rolling your own:

```js
import { PAGE_CONTEXT_PROMPT } from '@kaltura/intelligent-agents/management';
await mgmt.intellects.setPrompts(configId, [PAGE_CONTEXT_PROMPT, ...otherBlocks]);
```

If you're using the SDK's `Presenter` plugin for a slide-deck-style walkthrough, it already
manages per-slide page-context injection for you — see [README.md → Presenter](../README.md#presenter)
for the deck-specific API surface. `Presenter.refreshContext()` re-sends the current context
outside of a navigation, which is exactly the building block the worked example below relies on.

### The gate: `allow_client_variables`

The intellect must have `allow_client_variables: true`, or every request variable you send —
including `page_context` — is rejected. Enable it once, server-side, with an admin KS:

```js
await mgmt.intellects.setClientVariablesEnabled(configId, true, adminKs);
```

The rejection is **silent on every path**: the turn comes back as an empty
reply — no HTTP error, no socket error. The server's 403 fires inside its streaming pipeline
*after* the response has already opened, so it never reaches the wire. Both session classes
(`KalturaAvatarSession` and `KalturaChatSession`) detect the pattern and emit a once-per-session
`warning` event, `{ code: 'empty_turn_with_request_vars', message, requestVarKeys }` (variable
*names* only, never values), pointing at the gate:

```js
session.on('warning', (w) => {
  if (w.code === 'empty_turn_with_request_vars') console.warn(w.message);
});
```

The mirror-image misconfiguration — gate on, but no prompt block referencing any client
`{{variable}}` — is also silent live: the server accepts your variables and ignores them. Catch
both before shipping with the `lintPrompts` pre-flight:

```js
import { lintPrompts } from '@kaltura/intelligent-agents/management';
const lint = lintPrompts(prompts, { allowClientVariables: true, knownVars: ['page_context'] });
// findings to look for:
//   vars_gate_unreferenced  — gate on, but NO block references any client {{variable}}
//   known_var_unreferenced  — a var you send is never referenced by any block
//   client_variable_not_allowed — a block references a client var but the gate is off
```

### Reserved `sys__*` variables

Reserved `sys__*` keys (like `sys__user_id` and `sys__thread_id`) are server-injected on every
turn and rejected if you try to set them yourself, regardless of the gate — see
[Reserved Template Variables](api/operate.md#reserved-template-variables-sys__). The SDK's
own pre-flight rejects them (and non-string values) client-side before anything hits the wire.

### Server-side tools read them too

Request variables aren't limited to prompt text. A server-side `api` tool's request template can
interpolate them (`{{account_id}}` in a URL, header, or body), so a value your app set turns into
a parameter of a backend call the brain makes — including variables from earlier turns that were
never mentioned in conversation. See [API-REFERENCE.md § Tools](api/build.md#tools-api--csv--code).

**Security stance:** request variables are client-suppliable *and* thread-persistent. Never treat
one as an authorization claim — your endpoints must independently authorize every call — and
remember a poisoned value outlives its turn: it keeps interpolating into prompts and tool calls
for the rest of the thread. Don't pass unsanitized end-user text into `setDynamicPrompt`, and
never put secrets in any request variable.

### Verified live

Every behavior above is exercised against the real API by two runnable scripts:

- `examples/request-vars-live-context.mjs` — a five-turn walkthrough of seed → persist → merge →
  large `page_context` → fresh-thread reset.
- `npm run live-verify:request-vars` — the full verification suite (persistence, merge, tool
  interpolation, `sys__*` injection, ~31 KB payload, thread isolation).

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
`Presenter.refreshContext()`) first, then `speak()` immediately after. That way the nudge that
provokes the turn arrives *after* the context it needs to reason correctly about is already in
place, not racing it.

## Answering a brain-initiated request

The mechanisms above all push data from your app *to* the brain. There's also a path in the
other direction: your agent's configuration can require the brain to ask the viewer for specific
structured fields at some point in the conversation (an email, a booking date, a support ticket's
category) — see [STRUCTURED-DATA-FORMS.md](STRUCTURED-DATA-FORMS.md) for how to configure what it
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
  // The form closing either way is a real, immediate event — update a variable, then
  // nudge, exactly like a section change, rather than waiting for whatever turn
  // happens next to pick it up.
  session.updateRequestVars({ email_form_status: email ? 'submitted' : 'declined' });
  session.speak(`[EMAIL FORM] The form just closed — the viewer ${email ? 'submitted an email' : 'declined'}.`);
}
```

The pattern that repeats: **update context, then actively nudge, in that order, for anything that
just happened and needs an immediate reaction.**

## Which one do I want?

| I need to… | Use |
|---|---|
| Substitute the viewer's name/tier into my prompt template | `updateRequestVars({ user_name: 'Ada' })` |
| Give the brain a full snapshot of what's on screen, for whenever it next speaks | `setDynamicPrompt(data)` |
| Make the brain react to something *right now*, not whenever it next happens to speak | `setDynamicPrompt()` + `speak()` |
| Feed a value into a server-side `api` tool the brain calls | Any request variable the tool's template interpolates |
| Get an answer back for a field the brain itself asked for | `submitStructuredDataForm()` |

## Related but distinct: client-side commands

If instead you need the *avatar* to drive your UI — navigate, open a panel, highlight something —
that's a different, silent channel (`session.onToolCall()`), not a data-injection mechanism. See
[CLIENT-COMMANDS.md](CLIENT-COMMANDS.md).

## Related docs

| Doc | What it adds |
|-----|---------------|
| [README.md → `{{var}}` Jinja personalization](../README.md#var-jinja-personalization-request_vars) | The `request_vars` API reference |
| [README.md → Experience](../README.md#experience) | `KalturaAvatarSession` and the `Presenter` deck plugin this doc's worked example builds on |
| [API-REFERENCE.md → Converse](api/operate.md#converse) | Sending `request_vars` on the headless HTTP path, and the `sys__*` reserved set |
| [STRUCTURED-DATA-FORMS.md](STRUCTURED-DATA-FORMS.md) | Configuring what the brain asks the viewer for, and how it's rendered |
| [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md) | The avatar-driving-your-UI channel — the opposite direction from this doc |
| [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md) | The exact socket events behind each mechanism, for anyone debugging at the wire level |
