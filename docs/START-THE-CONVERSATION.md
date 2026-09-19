# Start the conversation: silent opening + `kickoff`

The fastest, most predictable way to get an agent talking: give the avatar a silent opening phrase and let the SDK send the first turn for you.

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

The user hears the agent's own greeting about two seconds after `connect()` resolves, and can interrupt it from the first word.

## Why not a scripted opening line

Every avatar has an `openingPhrase`. The server speaks it as the first turn of a session, and that turn cannot be interrupted: anything the user says or types while it plays is ignored by the server. The SDK protects typed text (`speak()` holds it until the turn ends, see below), but the user still waits for the whole scripted line before the agent can react to them.

A silent opening removes that wait. `SILENT_OPENING` is a valid, non-empty opening phrase that produces no speech. The opening turn still runs, so the session follows the normal path, but it ends in well under a second. The `kickoff` text then goes out as the first real turn. The agent's reply to it is an ordinary, interruptible turn driven by your prompt, not a fixed script.

| | Scripted `openingPhrase` | `SILENT_OPENING` + `kickoff` |
|---|---|---|
| First words come from | a fixed string, rendered server-side | the model, following your prompt and the kickoff text |
| Interruptible | no | yes |
| Personalized | via `{{request_vars}}` in the phrase | via the prompt, `request_vars`, and the kickoff text |
| Time from `connect()` to first words | length of the scripted line plus server latency | about 1.8 s in live measurements |
| Where the greeting text lives | avatar or intellect config | your browser code (or `request_vars`) |

`openingPhrase` must be a non-empty string. An empty string makes the first turn fail. Use `SILENT_OPENING`, never `''`.

## Setting the silent opening

Three places can set the opening phrase. The intellect's phrase, when set, overrides the avatar's. The browser never sends one.

| Where | How | Notes |
|---|---|---|
| `provision()` | `provision({ brief, ks, openingPhrase: SILENT_OPENING })` | Wins over the phrase in the generated profile. Default stays `'Hello!'` when omitted. |
| Avatar | `avatars.create({ ..., openingPhrase: SILENT_OPENING }, ks)` or `avatars.update({ id: avatarId, openingPhrase: SILENT_OPENING }, ks)` | The avatar-level default for every session on that avatar. |
| Intellect | `intellectConfig.setOpeningPhrase(configId, SILENT_OPENING, ks)` | Overrides the avatar's phrase. Pass `null` to clear and fall back to the avatar's phrase. |

`SILENT_OPENING` is exported from both `./management` and `./experience`, together with `SILENT_OPENING_LABEL` (`[silence]`), the caption text the session classes emit for the silent turn.

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
- The reply is interruptible, like any reply to `speak()`.
- If the text cannot be sent (a guardrail or gate rejected it, or the session ended first) the session emits `warning` with code `kickoff_failed` and a `detail`. The session stays connected.

`session.kickoff` (avatar session) returns `{ text, echo, sent }` or `null`. `sent: true` means the SDK handed the text to the send path once. It does not mean the server replied, and the SDK never retries.

### Recommended kickoff text

Write the kickoff as an instruction to the agent, not as a user line. It is a prompt the model reads once, so it can carry anything the browser knows at load time:

```js
kickoff: `Greet ${firstName} warmly, say you are the ${siteName} assistant, and ask what they want to do today. Keep it to two short sentences.`
```

Keep it short. A long kickoff delays the first words, because the model reads it before it answers. Put standing rules (tone, persona, what to offer) in the intellect prompts; put only the per-session facts in the kickoff.

## What happens on the wire

Event order for an avatar session with `SILENT_OPENING` and a `kickoff`, with typical timings from live runs (`examples/event-timing.html?kickoff=...` against a fake mic):

| Step | What you observe | Typical time |
|---|---|---|
| 1 | `connect()` starts. The mic prompt, the socket handshake and the media negotiation run alongside each other. | 0 |
| 2 | `connect()` resolves, `state === 'connected'`. The silent opening turn is already committed. | 2.2–3.6 s |
| 3 | `avatarStartTalking`, then one `transcript`/`speechChunk` and `avatarStopTalking`, all with `text: '[silence]'` (`SILENT_OPENING_LABEL`) for the opening turn. | ends about 0.5 s after step 2 |
| 4 | The SDK sends the kickoff. `session.kickoff.sent` becomes `true`. | same tick as step 3 |
| 5 | `responsePending` fires when the server acknowledges the turn (its first think delta). Show a "thinking" indicator here. | tens of ms after step 4 |
| 6 | `speechChunk` / `transcript {type:'agent'}` / `avatarStartTalking` for the agent's first real words. `responseSettled` fires. | about 1.8 s after step 2 |

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
| The kickoff text shows up as a user message | `echo: true`, or an `onBeforeSend` hook rewrote the text so it no longer matches the server's echo | Use `echo: false` (the default) and rewrite the kickoff text itself instead of rewriting it in `onBeforeSend`. |
| `warning` with code `kickoff_failed` | A guardrail or the disclosure gate rejected the send, or the session ended first. `detail` says which. | Fix the guardrail, or call `speak()` yourself after the gate opens. |
| The agent speaks a scripted line before the kickoff reply | The intellect's `opening_phrase` or the avatar's `openingPhrase` is not `SILENT_OPENING` | Check both. The intellect's phrase overrides the avatar's. |
| `session.kickoff.sent` is `true` but nothing was said | The reply is still pending, or the model chose to say nothing | Watch `responsePending` / `responseSettled`. A second `speak()` starts a new turn. |
| Two sessions on one page both greet | Each session object sends its own kickoff once | Construct one session per conversation. |
| Kickoff sent again after `resume()` or a reconnect | It is not. `session.kickoff.sent` stays `true`. | If you see a second greeting, it comes from your own `speak()` call. |

## Related docs

| Doc | What it adds |
|---|---|
| [README.md § Experience](../README.md#experience) | The `kickoff` option in context with the other session options. |
| [DYNAMIC-DATA-INJECTION.md § When speak() actually sends](DYNAMIC-DATA-INJECTION.md#when-speak-actually-sends) | The hold behavior for every `speak()` call, not just the first. |
| [VOICE-INPUT-MODES.md](VOICE-INPUT-MODES.md) | Open-mic vs push-to-talk, and mic-less sessions. |
| [wire-protocol/connection-basics.md](wire-protocol/connection-basics.md) | The connect sequence step by step, including where the opening turn starts. |
| [api/deploy.md](api/deploy.md) | Minting the runtime token the browser needs before `connect()`. |
