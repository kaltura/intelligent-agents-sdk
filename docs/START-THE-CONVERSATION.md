# Start the conversation: opening phrase, `SILENT_OPENING` + `kickoff`

The intellect's `opening_phrase` owns the first turn of every avatar join. There are two good ways to use it:

| You want | Use |
|---|---|
| Sound as soon as possible, a large prompt or knowledge base, a first line you can write in advance | A scripted Jinja2 opening ([§ Personalize the opening](#personalize-the-opening)) |
| A greeting the model writes, that the user can interrupt and that can call tools | `SILENT_OPENING` + `kickoff` ([§ The `kickoff` option](#the-kickoff-option)) |

```js
// server, once. Pick one.
import { Management, SILENT_OPENING } from '@kaltura/intelligent-agents/management';
const kaltura = new Management({ partnerId, adminSecret });
await kaltura.intellectConfig.setOpeningPhrase(configId,
  '{% if sys__is_new_thread %}Hi, I am the Acme assistant. What can I help you with?{% else %}Welcome back.{% endif %}', ks);
// or
await kaltura.intellectConfig.setOpeningPhrase(configId, SILENT_OPENING, ks);

// browser, every session. With SILENT_OPENING, add a kickoff.
import { KalturaAvatarSession } from '@kaltura/intelligent-agents/experience';
const session = new KalturaAvatarSession({
  ...runtimeConfig,
  kickoff: 'Greet the user and briefly say how you can help.',   // only with SILENT_OPENING
});
await session.connect();
```

Attach your `session.on(...)` listeners before `connect()`. Some events fire before it resolves: [README.md § Experience](../README.md#experience).

## Choose an opening

Medians in live runs, measured from the moment `connect()` resolves (headless Chromium, production):

| | Scripted Jinja2 opening | `SILENT_OPENING` + `kickoff` |
|---|---|---|
| First words (first `speechChunk`) | about 0.2 s | about 1 s |
| First sound heard | about 0.7 s | about 1.6 s |
| Opening turn holds the floor | its whole length, about 3 s for two sentences | about 0.3 s |
| Interruptible | no | yes |
| Written by | you, as a template | the model, from your prompt and the kickoff text |
| Can call tools | no | yes |
| Larger prompt or knowledge base | no effect on the first words | first words come later (about 0.15 s later with 25 KB of prompt) |
| Where the greeting text lives | the intellect's `opening_phrase` | your browser code |

Trade-offs:

- A scripted opening makes sound about 0.9 s sooner. But the user cannot interrupt it, and a `kickoff` or a typed `speak()` waits until the whole line has been spoken. Keep it to one or two short sentences.
- `SILENT_OPENING` + `kickoff` starts later, but the first reply is an ordinary model turn: it follows your whole prompt, can use tools, and stops the moment the user talks.
- Do not combine a spoken scripted line with a `kickoff`. The user hears the line, then waits for the kickoff reply. For a preset question, use [§ Open with a preset question](#open-with-a-preset-question).

Measure both on your own partner with `npm run live-verify:connect-timing:compare`. To pad each arm's prompt with N KB of neutral text, add `-- --prompt-kb N`, for example `npm run live-verify:connect-timing:compare -- --prompt-kb 25`.

## Where the opening phrase lives

The intellect's `opening_phrase` is the one place to set the opening line. The browser never sends one.

| How | What it does |
|---|---|
| `provision({ brief, ks, openingPhrase })` | Creates the avatar with no `openingPhrase`, then writes `openingPhrase` to the new intellect's `opening_phrase`. Wins over the phrase in the generated profile. Default is the profile's phrase, then `'Hello!'`. |
| `intellectConfig.setOpeningPhrase(configId, phrase, ks)` | Sets or changes the phrase on an existing intellect. `null` clears it. |

The phrase must be a non-empty string. An empty string is rejected. For a silent opening use `SILENT_OPENING` (`'<blank>'`), never `''`.

`provision()` creates the avatar before it writes the intellect, so the intellect write is always the last opening-phrase write of the run. An avatar can also carry an `openingPhrase` of its own (`avatars.create` / `avatars.update`); it is spoken only for a session whose intellect has no `opening_phrase`. Leave it unset. If an avatar you did not provision with the SDK has one, clear it:

```js
await kaltura.avatars.update({ id: avatarId, openingPhrase: null }, ks);   // voice and visual untouched
```

`SILENT_OPENING` is exported from both `./management` and `./experience`, together with `SILENT_OPENING_LABEL` (`[silence]`), the caption text the session classes emit for the silent turn.

## Personalize the opening

`opening_phrase` is a Jinja2 template. The server renders it on every avatar join, before the first turn, so the same intellect can greet every visitor differently:

```js
await kaltura.intellectConfig.setOpeningPhrase(
  configId,
  '{% if sys__is_new_thread %}'
  + '{% if user_name %}Hi {{ user_name }}, what brings you here today?{% else %}Hello there! What brings you here today?{% endif %}'
  + '{% else %}Welcome back{% if user_name %}, {{ user_name }}{% endif %}. Shall we pick up where we left off?{% endif %}',
  ks,
);
```

The template can read two kinds of variables:

| Variable | Comes from | Notes |
|---|---|---|
| Client variables such as `user_name` | `new KalturaAvatarSession({ ..., requestVars: { user_name: 'Ada' } })` | The intellect must allow them first: `intellects.setClientVariablesEnabled(configId, true, ks)`. See [DYNAMIC-DATA-INJECTION.md § The gate](DYNAMIC-DATA-INJECTION.md#the-gate-allow_client_variables). |
| `sys__*` such as `sys__is_new_thread`, `sys__user_id` | Set by the server on every join | `sys__is_new_thread` is true on a brand-new thread and false on a thread with earlier messages. Full list: [api/operate.md § Reserved Template Variables](api/operate.md#reserved-template-variables-sys__). |

Rules:

1. **Every branch must render non-empty text.** An empty render makes the agent speak its default greeting instead. For a silent branch, render `<blank>` (the value of `SILENT_OPENING`). A variable that was not sent renders as empty text, so `Hello {{ user_name }}!` becomes `Hello !`, and inside `{% if %}` it counts as false.
2. **A broken template stops the session.** A template that fails to render, or `requestVars` sent to an intellect that does not allow client variables, means the session never starts. Guard every optional variable with `{% if var %}`, and test a new template on a scratch intellect first.
3. **The opening plays on every avatar join**, not only the first: the first `connect()`, a cold reconnect, `switchMode('avatar')` on an existing thread, and a session that joins an existing `threadId`. Guard the first-visit greeting with `sys__is_new_thread`.
4. **A request variable stays set on the thread**, also on later joins. To turn a flag off, see [DYNAMIC-DATA-INJECTION.md § The context channel](DYNAMIC-DATA-INJECTION.md#the-context-channel-request-variables).
5. **Text chat has no opening turn.** In chat, send the greeting or preset question as the `kickoff` or as the first message.

The rendered text reaches the browser as the opening `speechChunk` / `transcript` events and is stored on the thread as an `opening` message. A `<blank>` branch never surfaces as `<blank>`. An opening event that carries text shows `SILENT_OPENING_LABEL` (`[silence]`) instead.

`scripts/live-verify-opening-phrase.mjs` is the CI-verified example of this path: it provisions a throwaway agent, sets `{% if %}` templates, and asserts the spoken opening with and without `requestVars`, the preset-question branch, and a re-join of the same thread. `test/integration/intellect-config.test.js` and `test/integration/avatars-catalog.test.js` cover the same calls without a live backend.

### Open with a preset question

A page link or a suggestion pill can open the agent with a question already asked. Keep the scripted opening for everyone else, and make it silent when a flag is set:

```js
import { SILENT_OPENING } from '@kaltura/intelligent-agents/management';

// server, once
await kaltura.intellectConfig.setOpeningPhrase(configId,
  `{% if preset_question %}${SILENT_OPENING}{% elif sys__is_new_thread %}Hi, I am the Acme assistant. What can I help you with?{% else %}Welcome back.{% endif %}`,
  ks);
await kaltura.intellects.setClientVariablesEnabled(configId, true, ks);

// browser, when the user picked a question
const session = new KalturaAvatarSession({
  ...runtimeConfig,
  requestVars: { preset_question: '1' },
  kickoff: { text: question, echo: true },   // echo: true shows it in the chat log as the user's message
});
await session.connect();
```

The opening is silent, so the kickoff goes out about 0.3 s after `connect()` resolves and the first reply answers the question. The flag stays set on the thread (rule 4), so clear it once the answer has started with `session.updateRequestVars({ preset_question: '' })`. Otherwise a later join of that thread opens silently too.

## The `kickoff` option

Available on `KalturaAvatarSession`, `KalturaChatSession` and `KalturaAgentSession`.

```js
kickoff: 'Greet the user and briefly say how you can help.'
kickoff: { text: 'Greet the user and briefly say how you can help.', echo: true }
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `text` | `string` | required | The first typed turn. Same path as `speak()` / `sendText()`. |
| `echo` | `boolean` | `false` | `false` drops the server's echo of this text from `transcript {type:'user'}`, so it never shows up in a chat log as if the user typed it. `true` keeps the echo. |

Rules the SDK guarantees:

- Sent exactly once per session object. Never re-sent on `resume()`, on a reconnect, or after `switchMode()` on `KalturaAgentSession`.
- Sent only once the server accepts input: after the opening turn ends, or after `acknowledgeDisclosure()` when `requireDisclosureAck` is set. With a spoken scripted opening, that is after the whole line.
- Empty or whitespace-only text sends nothing. Any other type than a string or `{ text, echo? }` throws `bad_request` from the constructor.
- With `echo: false`, only the kickoff text is dropped. If the same turn also carries what the user typed or said, that part still surfaces as `transcript {type:'user'}`.
- The reply is interruptible, like any reply to `speak()`.
- If a guardrail or gate rejects the text, the session emits `warning` with code `kickoff_failed` and a `detail`. The session stays connected.
- If the session ends while the text is still held, nothing is sent and no warning fires. `session.kickoff.sent` stays `true`.

`session.kickoff` (avatar session) returns `{ text, echo, sent }` or `null`. `sent: true` means the SDK handed the text to the send path once. It does not mean the server replied, and the SDK never retries.

### Recommended kickoff text

Write the kickoff as an instruction to the agent, not as a user line. It is a prompt the model reads once, so it can carry anything the browser knows at load time:

```js
kickoff: `Greet ${firstName} warmly, say you are the ${siteName} assistant, and ask what they want to do today. Keep it to two short sentences.`
```

Keep it short. A long kickoff delays the first words, because the model reads it before it answers. Put standing rules (tone, persona, what to offer) in the intellect prompts; put only the per-session facts in the kickoff. A preset question is the exception: send the user's question as-is, with `echo: true`.

## What happens on the wire

Event order for an avatar session with `SILENT_OPENING` and a `kickoff`, with typical timings from live headless-browser runs against a fake mic (`npm run live-verify:connect-timing`):

| Step | What you observe | Typical time |
|---|---|---|
| 1 | `connect()` starts. The mic prompt, the socket handshake and the media negotiation run alongside each other. | 0 |
| 2 | `connect()` resolves, `state === 'connected'`. The silent opening turn is already committed. The first video frame and the first audio are usually presented a little before this. | 1.5 to 2.2 s |
| 3 | `avatarStartTalking`, then one `transcript`/`speechChunk` and `avatarStopTalking`, all with `text: '[silence]'` (`SILENT_OPENING_LABEL`) for the opening turn. | ends about 0.3 s after step 2 |
| 4 | The SDK sends the kickoff. `session.kickoff.sent` becomes `true`. | same tick as step 3 |
| 5 | `responsePending` fires when the server acknowledges the turn (its first think delta). Show a "thinking" indicator here. | tens of ms after step 4 |
| 6 | `speechChunk` / `transcript {type:'agent'}` / `avatarStartTalking` for the agent's first real words. `responseSettled` fires. | about 1 s after step 2 |

With a scripted opening, step 3 carries the rendered line instead of `[silence]`. Its first `speechChunk` arrives about 0.2 s after step 2, and the turn ends when the whole line has been spoken.

These are tracked startup KPIs. `scripts/live-verify-connect-timing.mjs` checks the medians for `connect()`, first video frame, first audio, first words and sound heard against fixed budgets and fails when one is missed. `--compare jinja` runs the silent + kickoff path, a scripted opening and the preset-question pattern side by side, each with its own budgets. CI runs it on pull requests labeled `run-live-verify`, in the merge queue, on manual dispatch, and on a weekly schedule. The budgets and how they were calibrated are in the script header. Run it yourself with `npm run live-verify:connect-timing`; `--browser` picks the engine and `--headed` shows the run.

`avatarStartTalking` and `avatarStopTalking` still fire for the silent opening. They drive the hold described next, so an app that toggles a "speaking" indicator on them sees a brief flicker of under a second. The silent turn's `transcript`, `speechChunk` and `avatarStopTalking.text` all carry `SILENT_OPENING_LABEL` (`[silence]`), the same marker captions use for a silent stretch, so a transcript view can render it as-is or skip entries equal to the label. The raw phrase never reaches a listener.

## `speak()` during the opening turn

Text typed during any turn the server will not interrupt (the opening turn, the replayed line after `resume()`, the agent's own "are you still there?" check-in) is held by the SDK and sent the instant that turn ends. The kickoff uses the same hold. Several held texts go out as one turn, one text per line, so a `speak()` typed during the opening lands in the same turn as the kickoff.

| Moment | What happens to held text |
|---|---|
| The uninterruptible turn ends (`avatarStopTalking`) | Sent as one turn. Each held `speak()` resolves `true`. |
| The turn is interrupted server-side (`interrupted`) | Same as above. |
| `disconnect()`, `ended`, or `error` | Dropped. Each held `speak()` resolves `false`. |
| `pause()` then `resume()` | Kept. The replayed opening line's end releases it. |
| A cold reconnect | Kept. The next opening turn's end releases it. |

There are no timers in this path. Release happens only on the named events above, so a held text is either sent on a real turn boundary or dropped with `false` when the session ends.

## Disclosure gate

With `requireDisclosureAck: true` the kickoff waits for your app:

```js
const session = new KalturaAvatarSession({ ...runtimeConfig, requireDisclosureAck: true, kickoff: 'Greet the user.' });
session.on('disclosure', (notice) => showBanner(notice));
await session.connect();       // silent opening runs; kickoff is NOT sent yet
// ...user accepts the banner...
session.acknowledgeDisclosure();   // kickoff is sent now, once
```

The gate holds across recovery: a `resume()` or a cold reconnect while the ack is still outstanding keeps the conversation parked until `acknowledgeDisclosure()` lands. Once acknowledged, the ack lasts for the life of the session object, so a later reconnect never re-asks the user.

See [README.md § Accessibility + AI-disclosure gate](../README.md#accessibility-wcag-22-aa--captions--ai-disclosure-gate).

## Sessions without a microphone

`connect()` never waits for the mic and never fails because of it. In the default `micStartMode: 'immediate'` the permission prompt runs alongside the handshake. A denied, missing or busy mic emits one `warning` (`mic_permission_denied`, `mic_not_found` or `mic_in_use`) and the session connects mic-less. The kickoff is still sent, the agent still replies, and typed `speak()` keeps working. Call `startMic()` later to retry from a user click.

With `micStartMode: 'deferred'` the SDK does not touch the mic at all until you call `startMic()`. The kickoff behaves the same way.

## Text chat and switchable transports

`KalturaChatSession` sends the kickoff right after `connect()` resolves. There is no opening turn in text chat, so there is nothing to wait for. `echo: false` skips the user-side `transcript` for that one turn.

`KalturaAgentSession` takes `kickoff` at the top level of its config. It passes the kickoff to the first transport only. A later `switchMode()` builds a new transport without it, so the kickoff is sent once for the whole conversation whichever mode it starts in. It keeps one `requestVars` map for the conversation and seeds every new transport from it, so change variables with the facade's own `updateRequestVars()`, not on `agent.transport`. Each `switchMode('avatar')` plays the opening again (rule 3).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The kickoff text shows up as a user message | `echo: true`, or an `onBeforeSend` hook added to the text, so the added part surfaces on its own | Use `echo: false` (the default) and put the wording in the kickoff text itself instead of adding it in `onBeforeSend`. |
| `warning` with code `kickoff_failed` | A guardrail or the disclosure gate rejected the send. `detail` says which. | Fix the guardrail, or call `speak()` yourself after the gate opens. |
| The agent speaks a scripted line before the kickoff reply | The intellect's `opening_phrase` is not `SILENT_OPENING`, or the intellect has none and the avatar still carries its own `openingPhrase` | `intellectConfig.setOpeningPhrase(configId, SILENT_OPENING, ks)`; clear the avatar's copy with `avatars.update({ id, openingPhrase: null }, ks)`. |
| The agent speaks a default greeting instead of your line | One template branch rendered empty text | Make every branch render text; use `SILENT_OPENING` for a silent branch. |
| A returning user hears the first-visit greeting after a reconnect or `switchMode('avatar')` | The opening plays on every join | Guard the first-visit branch with `{% if sys__is_new_thread %}`. |
| A flag branch still plays after you stopped sending the flag | Request variables stay set on the thread | Turn the flag off: [DYNAMIC-DATA-INJECTION.md § The context channel](DYNAMIC-DATA-INJECTION.md#the-context-channel-request-variables). |
| The opening says `Hello !` or greets nobody | A template variable was not sent and rendered as empty text | Guard it: `{% if user_name %}…{% else %}…{% endif %}`. |
| The session never starts after setting a template | The template cannot be rendered, or `requestVars` were sent without `setClientVariablesEnabled(configId, true, ks)` | Fix the template on a scratch intellect first; enable client variables before sending any. |
| `session.kickoff.sent` is `true` but nothing was said | The reply is still pending, or the model chose to say nothing | Watch `responsePending` / `responseSettled`. A second `speak()` starts a new turn. |
| Two sessions on one page both greet | Each session object sends its own kickoff once | Construct one session per conversation. |
| Kickoff sent again after `resume()` or a reconnect | It is not. `session.kickoff.sent` stays `true`. | If you see a second greeting, it comes from your own `speak()` call. |

## Related docs

| Doc | What it adds |
|---|---|
| [README.md § Experience](../README.md#experience) | The `kickoff` option in context with the other session options. |
| [DYNAMIC-DATA-INJECTION.md § The context channel](DYNAMIC-DATA-INJECTION.md#the-context-channel-request-variables) | `requestVars`, the `allow_client_variables` gate, and the reserved `sys__*` names the opening template can read. |
| [DYNAMIC-DATA-INJECTION.md § When speak() actually sends](DYNAMIC-DATA-INJECTION.md#when-speak-actually-sends) | The hold behavior for every `speak()` call, not just the first. |
| [VOICE-INPUT-MODES.md](VOICE-INPUT-MODES.md) | Open-mic vs push-to-talk, and mic-less sessions. |
| [wire-protocol/connection-basics.md](wire-protocol/connection-basics.md) | The connect sequence step by step, including where the opening turn starts. |
| [api/deploy.md](api/deploy.md) | Minting the runtime token the browser needs before `connect()`. |
