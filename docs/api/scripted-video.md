[← Back to the API Reference index](../../API-REFERENCE.md)

# Scripted-Video (STV-only) Sessions

> **When to use this:** pre-authored speech only — you supply every line. Interactive conversation, knowledge grounding, tool calls, and analytics come from full agentic sessions. See [what you'd take on yourself](https://kaltura.github.io/intelligent-agents-sdk/explanation/inside-a-live-conversation/#what-youd-take-on-yourself) before choosing this path.

A second, INDEPENDENT session type — `https://api.avatar.us.kaltura.ai/v1/avatar-session/*` — that sits next to, not on top of, everything in Phases 1–4 above. No LLM, no ASR, no socket.io: REST + WHEP only. The avatar speaks exactly the audio you hand it, in the order you hand it. Use this when YOU are the script (IVR-style flows, pre-recorded/TTS'd announcements, kiosk greetings) rather than the conversational brain. SDK: `mgmt.avatarSessions` (management) + `KalturaScriptedVideoSession` (experience, browser-side playback).

**Two-stage auth** — this is the one surface on the whole agentic host that switches auth schemes mid-flow:

| Call | Auth |
|------|------|
| `create` | `Authorization: KS <admin-ks>` — your normal admin token |
| every call after `create` | `Authorization: Bearer <session-token>` — the JWT `create` returns, NOT a KS |

The Bearer token is valid about 24h (decoded from the JWT's own `exp` claim) and grants full control of the session. Keep it server-side, exactly like an admin KS. The browser only ever needs the non-secret `{whepUrl, turn}` pair from `init-client`.

| Operation | Endpoint | Auth | Body |
|-----------|----------|------|------|
| Create | `POST /v1/avatar-session/create` | Admin KS | `{"visualConfig":{"id":"24-char-hex"}}` |
| Negotiate video | `POST /v1/avatar-session/{sessionId}/init-client` | Bearer | `{}` → `{whepUrl, turn}` |
| Speak | `POST /v1/avatar-session/{sessionId}/say-audio` | Bearer | multipart: `turnId`, `duration` (seconds), `audio` (file) |
| Barge-in | `POST /v1/avatar-session/{sessionId}/interrupt` | Bearer | `{}` |
| Keep alive | `POST /v1/avatar-session/{sessionId}/keep-alive` | Bearer | `{}` |
| End | `POST /v1/avatar-session/{sessionId}/end` | Bearer | `{}` |

`say-audio` is the only way to make the avatar speak. There is no text input. Generate the audio yourself with any TTS provider, measure its duration (e.g. `ffprobe`), and pass both to `say-audio`. An inaccurate duration desyncs the mouth from the audio but does not error. The call is async and queued: it resolves in about 100ms once the turn is accepted, not once playback finishes. Call `interrupt` to cut off whatever's currently playing.

```js
import { Management } from '@kaltura/intelligent-agents/management';

const mgmt = new Management({ partnerId, adminSecret });
const admin = await mgmt.sessions.createAdminToken({ userId: 'admin@example.com' });

const session = await mgmt.avatarSessions.create({ visualConfig: { id: avatarId } }, admin.ks);
const { whepUrl, turn } = await mgmt.avatarSessions.initClient(session);
// send only { whepUrl, turn } to the browser — never `session`/`session.token`

const mp3 = await ttsProvider.synthesize('Hello there.');
const duration = await measureDurationSeconds(mp3);          // your own probe, e.g. ffprobe
await mgmt.avatarSessions.say(session, mp3, { duration });

await mgmt.avatarSessions.end(session);
```

Browser side, `KalturaScriptedVideoSession` renders the video/audio downlink from `{whepUrl, turn}` — it has no `speak()` of its own on purpose (that would need the Bearer token in the browser):

```js
import { KalturaScriptedVideoSession } from '@kaltura/intelligent-agents/experience';

const view = new KalturaScriptedVideoSession({ whepUrl, turn, videoEl });  // optional audioEl plays the voice through its own element
await view.connect();
// ...call your own server endpoint, which calls mgmt.avatarSessions.say()...
view.disconnect();
```

`connect()` only runs from `'idle'` or `'disconnected'`. After `disconnect()`, the same instance connects again with a fresh peer connection. From any other state it throws `invalid_state`. From `'error'`, call `disconnect()` first. The view emits `stateChange` (`{state}`) on every state change.

See the runnable example: [`examples/scripted-video-session.mjs`](../../examples/scripted-video-session.mjs) + [`examples/scripted-video-session.html`](../../examples/scripted-video-session.html).
