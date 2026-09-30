[← Back to the API Reference index](../../API-REFERENCE.md)

# Widget & Runtime Init

## Resolve Widget ID

```
POST https://api.avatar.us.kaltura.ai/v1/application/resolveWidgetId
```

```json
{ "agentId": "33b7c8b7-f67b-4ca3-b853-0f7ced06a6a3" }
```

Returns `{ "widgetId": "1_v1mj1kxb" }`. Idempotent.

---

## Initialize the Runtime

```
POST https://api.avatar.us.kaltura.ai/v1/application/appInit   (widget KS, no body)
```

```bash
WIDGET_KS=$(curl -s -X POST "https://www.kaltura.com/api_v3/service/session/action/startWidgetSession" \
  -d "format=1" -d "widgetId=1_v1mj1kxb" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['ks'])")
```

Response:

| Field | What it is |
|-------|-----------|
| `partnerId` | The partner the widget resolves to |
| `ks` | Enriched KS with `geniegpcid`. Use it for conversation |
| `conversationManagerUrl` | Socket.IO control-plane host |
| `srsBaseUrl` | WHEP video-stream host |
| `turnServerUrl` | TURN host |
| `avatars[]` | `[{id, previewImageUrl, loadingVideoUrl}]` — raw backend asset URLs (an upload echo for a custom visual, a preset asset URL for a catalog item), not the rendered composite the live WHEP stream shows |
| `widgetConfig` / `embedConfig` | Optional, present only when the widget was configured with them |

The admin secret never touches the browser — `appInit` derives the agent from the widget KS.

**A widget KS is one shared identity.** Every visitor gets the same string. Anyone who holds a `threadId` can continue that thread, so treat `threadId` as a secret and store it per user on your server. Reading, listing and deleting threads and messages with a widget token fails. Through `Management`, a minted widget `Token` makes those methods throw `wrong_token_scope` before any request. A raw HTTP call, or a raw KS string passed to `Management`, gets 403. Per-attendee credentials and per-user separation are not possible on this path.

### Per-visitor browser path

Use this when users must be kept apart. The server mints the token and the browser only receives the result:

1. Server: `createAgentToken({ agentId, userId })`, with a distinct `userId` per visitor.
2. Server: `mgmt.application.appInit(token)`.
3. Server: send the returned `ks` (and hosts) to the browser.

That KS answers as the agent, keeps entitlement ON and keeps the user's identity. What it can reach: [SECURITY.md § Session type](../../SECURITY.md#session-type).

Feed this response straight into `new KalturaAvatarSession({ token: ks, conversationManagerUrl, srsBaseUrl, turnServerUrl, videoEl, socketFactory })` (`./experience`) to bring the runtime up in the browser.

`appInit` does not return the brain host. The session still makes two direct POSTs of its own, the `respondToTool()` ACKs and the session-completed signal, and it sends them to the same built-in US production `genieUrl` that `Management` falls back to. If your partner is on any other environment, pass the session the same `genieUrl` you gave `Management`, or those two calls fail with a `401` after an otherwise healthy session. `KalturaAgentSession` takes it under `avatar` and `chat`.

Two options on all three session classes (`KalturaAvatarSession`, `KalturaChatSession`, `KalturaAgentSession`) shape how the conversation starts:

| Option | Effect |
|---|---|
| `kickoff: 'text'` or `{ text, echo? }` | The SDK sends `text` as the first turn, once per session object, as soon as the server accepts input (after the opening turn, or after `acknowledgeDisclosure()`). Never re-sent on `resume()`, a reconnect or `switchMode()`. `echo: true` also emits it as a user `transcript`. A blocked send emits `warning {code:'kickoff_failed'}`. Pair with a silent opening phrase (`SILENT_OPENING`) for the fastest interruptible first reply: [START-THE-CONVERSATION.md](../START-THE-CONVERSATION.md) |
| `micStartMode: 'immediate' \| 'deferred'` (avatar only) | `connect()` never waits for or fails on the mic. A denied or missing mic emits a `warning` and the session connects mic-less; typed turns still work |

`responsePending` fires when a turn starts awaiting the brain's first perceivable output, and again when the server acknowledges a turn with its first think delta, so a `kickoff` reply shows "thinking" before the first word.

Optional `./experience` plugins layer on top of that same session:

- Deck walkthroughs (`./experience/presenter`)
- A transparent-background compositor for the avatar video (`./experience/chroma-key`)
- Noise suppression
- GenUI widgets
- KAVA (Kaltura Video Analytics) reporting

All of them are documented in [README.md](../../README.md#experience) alongside their runnable `examples/*.html` demos, not here — this reference covers the server-side Management API surface only.
