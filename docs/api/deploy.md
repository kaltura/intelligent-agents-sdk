[← Back to the API Reference index](../../API-REFERENCE.md)

# Phase 3 — Deploy

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
| `ks` | Enriched KS with `geniegpcid` — pass to Genie for conversation |
| `conversationManagerUrl` | Socket.IO control-plane host |
| `srsBaseUrl` | WHEP video-stream host |
| `turnServerUrl` | TURN host |
| `avatars[]` | `[{id, previewImageUrl, loadingVideoUrl}]` — raw backend asset URLs (an upload echo for a custom visual, a preset asset URL for a catalog item), not the rendered composite the live WHEP stream shows |

The admin secret never touches the browser — `appInit` derives the agent from the widget KS.

Feed this response straight into `new KalturaAvatarSession({ token: ks, conversationManagerUrl, srsBaseUrl, turnServerUrl, videoEl, socketFactory })` (`./experience`) to bring the runtime up in the browser. Optional `./experience` plugins layer on top of that same session — deck walkthroughs (`./experience/presenter`), a transparent-background compositor for the avatar video (`./experience/chroma-key`), noise suppression, GenUI widgets, and KAVA analytics. All of them are documented in [README.md](../../README.md#experience) alongside their runnable `examples/*.html` demos, not here — this reference covers the server-side Management API surface only.
