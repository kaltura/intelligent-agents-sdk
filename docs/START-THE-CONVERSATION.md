# Start the conversation: opening phrase, `SILENT_OPENING` + `kickoff`

The intellect's `opening_phrase` owns the first turn of every avatar session. The fastest, most predictable way to get an agent talking is to make that turn silent and let the SDK send the first turn for you:

```js
// server, once, at provisioning time
import { Management, SILENT_OPENING } from '@kaltura/intelligent-agents/management';
const agent = await kaltura.provision({ brief, ks, openingPhrase: SILENT_OPENING });

// browser, every session
import { KalturaAvatarSession } from '@kaltura/intelligent-agents/experience';
const session = new KalturaAvatarSession({
  ...runtimeConfig,
  kickoff: 'Greet the user and briefly say how you can help.',
});
await session.connect();   // the SDK sends the kickoff once, the moment the server accepts input
```

The user hears the agent's own greeting one to two seconds after `connect()` resolves, and can interrupt it from the first word. When you want a fixed, scripted first line instead, write it to the intellect as a Jinja2 template ([§ Personalize the opening](#personalize-the-opening)).

## Where the opening phrase lives

The intellect's `opening_phrase` is the one place to set the opening line. The browser never sends one.

| How | What it does |
|---|---|
| `provision({ brief, ks, openingPhrase })` | Creates the avatar with no `openingPhrase`, then writes `openingPhrase` to the new intellect's `opening_phrase`. Wins over the phrase in the generated profile. Default is the profile's phrase, then `'Hello!'`. |
| `intellectConfig.setOpeningPhrase(configId, phrase, ks)` | Sets or changes the phrase on an existing intellect. `null` clears it. |

The phrase must be a non-empty string. An empty string is rejected. For a silent opening use `SILENT_OPENING`, never `''`.

`provision()` creates the avatar before it writes the intellect, so the intellect write is always the last opening-phrase write of the run. An avatar can also carry an `openingPhrase` of its own (`avatars.create` / `avatars.update`); it is spoken only for a session whose intellect has no `opening_phrase`. Leave it unset. If an avatar you did not provision with the SDK has one, clear it:

```js
await kaltura.avatars.update({ id: avatarId, openingPhrase: null }, ks);   // voice and visual untouched
```

`SILENT_OPENING` is exported from both `./management` and `./experience`, together with `SILENT_OPENING_LABEL` (`[silence]`), the caption text the session classes emit for the silent turn.

## Personalize the opening

`opening_phrase` is a Jinja2 template. The server renders it once per session, before the first turn, so the same intellect can greet every visitor differently:

```js
await kaltura.intellectConfig.setOpeningPhrase(
  configId,
  '{% if user_name %}Welcome back, {{ user_name }}. Shall we pick up where we left off?{% else %}Hello there! What brings you here today?{% endif %}',
  ks,
);
```

The template can read two kinds of variables:

| Variable | Comes from | Notes |
|---|---|---|
| Client variables such as `user_name` | `new KalturaAvatarSession({ ..., requestVars: { user_name: 'Ada' } })` | The intellect must allow them first: `intellects.setClientVariablesEnabled(configId, true, ks)`. See [DYNAMIC-DATA-INJECTION.md § The gate](DYNAMIC-DATA-INJECTION.md#the-gate-allow_client_variables). |
| `sys__*` such as `sys__is_new_thread`, `sys__user_id` | Set by the server on every session | Full list: [api/operate.md § Reserved Template Variables](api/operate.md#reserved-template-variables-sys__). |

Rules that matter in practice:

- A variable that was not sent renders as empty text, so `Hello {{ user_name }}!` becomes `Hello !`. Guard every optional variable with `{% if var %}…{% else %}…{% endif %}`.
- Client variables sent to an intellect that does not allow them, or a template that cannot be rendered, mean the session fails to start. Test a new template on a scratch intellect before you ship it.
- The rendered text reaches the browser as the opening `speechChunk` / `transcript` events and is stored on the thread as an `opening` message.
- The scripted turn cannot be interrupted. Keep it to one or two sentences, or use `SILENT_OPENING` plus `kickoff` and put the personalization in `requestVars` and the kickoff text instead.

`scripts/live-verify-opening-phrase.mjs` is the CI-verified example of this path: it provisions a throwaway agent, sets a `{% if %}` template, connects with and without `requestVars`, and asserts the spoken opening for each. `test/integration/intellect-config.test.js` and `test/integration/avatars-catalog.test.js` cover the same calls without a live backend.

## Scripted opening or silent opening + kickoff

The server speaks `opening_phrase` as the first turn of a session, and that turn cannot be interrupted: anything the user says or types while it plays is ignored by the server. The SDK protects typed text (`speak()` holds it until the turn ends, see below), but the user still waits for the whole scripted line before the agent can react to them.

A silent opening removes that wait. `SILENT_OPENING` is a valid, non-empty opening phrase that produces no speech. The opening turn still runs, so the session follows the normal path, but it ends in well under a second. The `kickoff` text then goes out as the first real turn. The agent's reply to it is an ordinary, interruptible turn driven by your prompt, not a fixed script.

| | Scripted `opening_phrase` | `SILENT_OPENING` + `kickoff` |
|---|---|---|
| First words come from | a fixed template, rendered server-side | the model, following your prompt and the kickoff text |
| Interruptible | no | yes |
| Personalized | via Jinja2 over `requestVars` and `sys__*` in the phrase | via the prompt, `requestVars`, and the kickoff text |
| Time from `connect()` resolving to first words | length of the scripted line plus server latency | 1–2 s in live runs ([§ What happens on the wire](#what-happens-on-the-wire)) |
| Where the greeting text lives | the intellect's `opening_phrase` | your browser code (or `requestVars`) |

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
- Sent only once the server accepts input: after the opening turn ends, or after `acknowledgeDisclosure()` when `requireDisclosureAck` is set.
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

Keep it short. A long kickoff delays the first words, because the model reads it before it answers. Put standing rules (tone, persona, what to offer) in the intellect prompts; put only the per-session facts in the kickoff.

## What happens on the wire

Event order for an avatar session with `SILENT_OPENING` and a `kickoff`, with typical timings from live headless-browser runs against a fake mic (`npm run live-verify:connect-timing`, medians over 5 runs):

| Step | What you observe | Typical time |
|---|---|---|
| 1 | `connect()` starts. The mic prompt, the socket handshake and the media negotiation run alongside each other. | 0 |
| 2 | `connect()` resolves, `state === 'connected'`. The silent opening turn is already committed. The first video frame and the first audio are usually presented a little before this. | 1.5–2.2 s |
| 3 | `avatarStartTalking`, then one `transcript`/`speechChunk` and `avatarStopTalking`, all with `text: '[silence]'` (`SILENT_OPENING_LABEL`) for the opening turn. | ends about 0.5 s after step 2 |
| 4 | The SDK sends the kickoff. `session.kickoff.sent` becomes `true`. | same tick as step 3 |
| 5 | `responsePending` fires when the server acknowledges the turn (its first think delta). Show a "thinking" indicator here. | tens of ms after step 4 |
| 6 | `speechChunk` / `transcript {type:'agent'}` / `avatarStartTalking` for the agent's first real words. `responseSettled` fires. | 1.0–1.7 s after step 2 |

These are tracked startup KPIs. `scripts/live-verify-connect-timing.mjs` checks the medians for `connect()`, first video frame, first audio, first words and sound heard against fixed budgets and fails when one is missed. CI runs it on pull requests labeled `run-live-verify`, in the merge queue, on manual dispatch, and on a weekly schedule. The budgets and how they were calibrated are in the script header. Run it yourself with `npm run live-verify:connect-timing`; `--browser` picks the engine and `--headed` shows the run.

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

`KalturaAgentSession` takes `kickoff` at the top level of its config. It passes the kickoff to the first transport only. A later `switchMode()` builds a new transport without it, so the kickoff is sent once for the whole conversation whichever mode it starts in.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The kickoff text shows up as a user message | `echo: true`, or an `onBeforeSend` hook added to the text, so the added part surfaces on its own | Use `echo: false` (the default) and put the wording in the kickoff text itself instead of adding it in `onBeforeSend`. |
| `warning` with code `kickoff_failed` | A guardrail or the disclosure gate rejected the send. `detail` says which. | Fix the guardrail, or call `speak()` yourself after the gate opens. |
| The agent speaks a scripted line before the kickoff reply | The intellect's `opening_phrase` is not `SILENT_OPENING`, or the intellect has none and the avatar carries a legacy `openingPhrase` | `intellectConfig.setOpeningPhrase(configId, SILENT_OPENING, ks)`; clear the avatar's copy with `avatars.update({ id, openingPhrase: null }, ks)`. |
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
