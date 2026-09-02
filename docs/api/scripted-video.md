[← Back to the API Reference index](../../API-REFERENCE.md)

# Scripted-Video (STV-only) Sessions

> **When to use this:** pre-authored speech only — you supply every line. Interactive conversation, knowledge grounding, tool calls, and analytics come from full agentic sessions. See [what you'd take on yourself](https://kaltura.github.io/intelligent-agents-sdk/explanation/inside-a-live-conversation/#what-youd-take-on-yourself) before choosing this path.

A second, INDEPENDENT session type — `https://api.avatar.us.kaltura.ai/v1/avatar-session/*` — that sits next to, not on top of, everything in Phases 1–4 above. No LLM, no ASR, no socket.io: REST + WHEP only. The avatar speaks exactly the audio you hand it, in the order you hand it. Use this when YOU are the script (IVR-style flows, pre-recorded/TTS'd announcements, kiosk greetings) rather than the conversational brain. SDK: `mgmt.avatarSessions` (management) + `KalturaScriptedVideoSession` (experience, browser-side playback).

**Two-stage auth** — this is the one surface on the whole agentic host that switches auth schemes mid-flow:

| Call | Auth |
|------|------|
| `create` | `Authorization: KS <admin-ks>` — your normal admin token |
| every call after `create` | `Authorization: Bearer <session-token>` — the JWT `create` returns, NOT a KS |

The Bearer token is valid roughly 24h (decoded from the JWT's own `exp` claim) and grants full control of the session — keep it server-side, exactly like an admin KS. The browser only ever needs the non-secret `{whepUrl, turn}` pair from `init-client`.

| Operation | Endpoint | Auth | Body |
|-----------|----------|------|------|
| Create | `POST /v1/avatar-session/create` | Admin KS | `{"visualConfig":{"id":"24-char-hex"}}` |
| Negotiate video | `POST /v1/avatar-session/{sessionId}/init-client` | Bearer | `{}` → `{whepUrl, turn}` |
| Speak | `POST /v1/avatar-session/{sessionId}/say-audio` | Bearer | multipart: `turnId`, `duration` (seconds), `audio` (file) |
| Barge-in | `POST /v1/avatar-session/{sessionId}/interrupt` | Bearer | `{}` |
| Keep alive | `POST /v1/avatar-session/{sessionId}/keep-alive` | Bearer | `{}` |
| End | `POST /v1/avatar-session/{sessionId}/end` | Bearer | `{}` |

`say-audio` is the ONLY speech-injection mechanism this backend exposes. There is no text-in: a sibling `say-text` route accepts the request but the server answers `503 Service temporarily unavailable` on every call, and a bare `say` route 404s. Neither is wrapped by the SDK. Generate the audio yourself with any TTS provider (this backend has none of its own), measure its duration (e.g. `ffprobe`; the server has no duration probe of its own, and an inaccurate value just desyncs the mouth from the audio, it doesn't error), and pass both to `say-audio`. The call itself is async/queued: it resolves in roughly 100ms once the server accepts the turn, not once playback finishes. Call `interrupt` to cut off whatever's currently playing.

`set-emotion`, `queue-status`, `status`, and `session-status` all 404 on the current deployment and are not wrapped.

```js
import { Management } from '@kaltura/intelligent-agents/management';

const mgmt = new Management({ partnerId, adminSecret });
const admin = await mgmt.sessions.createAdminToken();

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

const view = new KalturaScriptedVideoSession({ whepUrl, turn, videoEl });
await view.connect();
// ...call your own server endpoint, which calls mgmt.avatarSessions.say()...
view.disconnect();
```

See the runnable example: [`examples/scripted-video-session.mjs`](../../examples/scripted-video-session.mjs) + [`examples/scripted-video-session.html`](../../examples/scripted-video-session.html).
