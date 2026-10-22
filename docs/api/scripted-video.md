[← Back to the API Reference index](../../API-REFERENCE.md)

# Scripted-Video (STV-only) Sessions

> **Deprecated.** This API will be removed in the next major version. Build with agents instead: start at [Getting Started](../../GETTING-STARTED.md).

> **When to use this:** pre-authored speech only. You supply every line. Interactive conversation, knowledge grounding, tool calls, and analytics come from full agentic sessions. See [what you'd take on yourself](https://kaltura.github.io/intelligent-agents-sdk/explanation/inside-a-live-conversation/#what-youd-take-on-yourself) before choosing this path.

A second, independent session type at `https://api.avatar.us.kaltura.ai/v1/avatar-session/*`. It sits next to the agentic sessions, not on top of them. No LLM, no ASR, no socket.io: REST + WHEP only. The avatar speaks exactly the audio you hand it, in the order you hand it. Use this when YOU are the script (IVR-style flows, pre-recorded/TTS'd announcements, kiosk greetings) rather than a conversational agent. SDK: `mgmt.avatarSessions` (management) + `KalturaScriptedVideoSession` (experience, browser-side playback).

**Two-stage auth.** This is the one surface on the management host that switches auth schemes mid-flow:

| Call | Auth |
|------|------|
| `create` | `Authorization: KS <admin-ks>`, your normal admin token |
| every call after `create` | `Authorization: Bearer <session-token>`, the JWT that `create` returns (not a KS) |

The Bearer token is valid about 24h (decoded from the JWT's own `exp` claim) and grants full control of the session. Keep it server-side, exactly like an admin KS. The browser only ever needs the `{whepUrl, turn}` pair from `init-client`. `turn` holds short-lived TURN credentials for that one session.

| Operation | Endpoint | Auth | Body |
|-----------|----------|------|------|
| Create | `POST /v1/avatar-session/create` | Admin KS | `{"visualConfig":{"id":"24-char-hex"}}` |
| Negotiate video | `POST /v1/avatar-session/{sessionId}/init-client` | Bearer | `{}` → `{whepUrl, turn}` |
| Speak | `POST /v1/avatar-session/{sessionId}/say-audio` | Bearer | multipart: `turnId`, `duration` (seconds), `audio` (file) |
| Barge-in | `POST /v1/avatar-session/{sessionId}/interrupt` | Bearer | `{}` |
| Keep alive | `POST /v1/avatar-session/{sessionId}/keep-alive` | Bearer | `{}` |
| End | `POST /v1/avatar-session/{sessionId}/end` | Bearer | `{}` |

`say-audio` is the only way to make the avatar speak. There is no text input. Generate the audio yourself with any TTS provider, measure its duration (e.g. `ffprobe`), and pass both to `say-audio`. An inaccurate duration desyncs the mouth from the audio but does not error. The call is async and queued: it resolves once the turn is accepted, not once playback finishes. Call `interrupt` to cut off whatever's currently playing.

Call `keepAlive` about every 10 seconds while the session is idle. It makes one call and starts no timer, so drive it from your own `setInterval`.

```js
import { Management } from '@kaltura/intelligent-agents/management';

const mgmt = new Management({ partnerId, adminSecret });
const admin = await mgmt.sessions.createAdminToken({ userId: 'admin@example.com' });

const session = await mgmt.avatarSessions.create({ visualConfig: { id: avatarId } }, admin.ks);
const { whepUrl, turn } = await mgmt.avatarSessions.initClient(session);
// send only { whepUrl, turn } to the browser, never `session`/`session.token`

const mp3 = await ttsProvider.synthesize('Hello there.');
const duration = await measureDurationSeconds(mp3);          // your own probe, e.g. ffprobe
await mgmt.avatarSessions.say(session, mp3, { duration });

await mgmt.avatarSessions.end(session);
```

Browser side, `KalturaScriptedVideoSession` renders the video/audio downlink from `{whepUrl, turn}`. It has no `speak()` of its own, because that would need the Bearer token in the browser:

```js
import { KalturaScriptedVideoSession } from '@kaltura/intelligent-agents/experience';

const view = new KalturaScriptedVideoSession({ whepUrl, turn, videoEl });  // optional audioEl plays the voice through its own element
await view.connect();
// ...call your own server endpoint, which calls mgmt.avatarSessions.say()...
view.disconnect();
```

`connect()` only runs from `'idle'` or `'disconnected'`. After `disconnect()`, the same instance connects again with a fresh peer connection. From any other state it throws `invalid_state`. From `'error'`, call `disconnect()` first. The view emits `stateChange` (`{state}`) on every state change.

