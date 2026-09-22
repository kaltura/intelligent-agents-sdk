[← Back to Agent Components](../build.md)

# Create an Avatar and an Agent

## Create an Avatar

```
POST https://api.avatar.us.kaltura.ai/v1/avatar/create
```

```json
{
  "voice": { "id": "KbakCphLGyrStJ2sp8mp", "speed": 1.0 },
  "visual": {
    "id": "f5a6b7c8-d9e0-4f1a-2b3c-4d5e6f7a8b9c",
    "motionControl": { "speaking": 0.7, "nonSpeaking": 0.2 }
  },
  "name": "Support rep"
}
```

Server-enforced ranges: `voice.speed` 0.5–1.5; `motionControl.speaking` and `motionControl.nonSpeaking` each 0.1–1.0 (keep `nonSpeaking` below `speaking`); `name` up to 255 characters. A value outside these ranges is a 400.

`voice.id` and `visual.id` come from the catalog ([Catalog & Assets § Browse the Catalog](../design.md#browse-the-catalog)). For your own portrait, upload it first and use the returned `itemId` as `visual.id` ([§ Upload a Custom Visual](../design.md#upload-a-custom-visual-portrait--animated-avatar), which also covers how to prepare the photo). Returns `id` (24-char hex). **No `adminTags`** on avatars: tag the parent agent instead ([Management Operations § Avatars](../management-operations.md#avatars--httpsapiavataruskalturaai)).

Leave `openingPhrase` unset. The intellect's `opening_phrase` owns the first, uninterruptible turn of every session ([Configure an Intellect](intellect.md#configure-an-intellect)); `provision()` writes it there and creates the avatar without a phrase. An avatar-level `openingPhrase` is spoken only for a session whose intellect has none. Clear one with `avatars.update({ id, openingPhrase: null }, ks)`. Where the phrase lives, how to personalize it with Jinja2, and the silent-opening + `kickoff` pattern: [START-THE-CONVERSATION.md](../../START-THE-CONVERSATION.md).

### Three ways to get a visual

`avatar/create` needs exactly one of these to resolve a visual — pick one:

| Way | Body | When |
|---|---|---|
| An existing Visual | `visual: { id }` | Fastest — a catalog preset, or your own upload via `catalog.createVisual`. Wins only if `face`/`background` are both omitted, or both sent together as a complete pair. Sending just one of `face`/`background` alongside `visual` is still a domain error (see the row below) — `visual` does not exempt it. |
| Compose a new Visual from a Face + Background | `face: { id }` + `background: { type: 'color', value?: '#hex' }` (`value` optional, defaults to white) or `{ type: 'visual', value: <Background catalog itemId> }` (`value` required) | You want a specific face (a `catalog.createFace` upload, or a preset Face item) over a specific backdrop. `face`/`background` must travel together at create time; you can't send `face` now and add `background` later. Sending just one of them still returns an HTTP 200 with a domain error in the body (`AVATAR_MISSING_VISUAL_RESOLUTION`), even if `visual` is also sent — unless `templateId` is also given: a template can carry its own `face` and/or `background`, filling in whichever half you didn't send. |
| A curated template + whatever it's missing | `templateId` + whichever of `face`/`background`/`visual` the template doesn't already supply | Fastest good-looking result — see below. `templateId` alone is a domain failure unless the template already resolves to a complete `visual` on its own. |

For `background.type: 'color'`, `value` must be a plain 6-digit hex string (`#RRGGBB`) with **no alpha channel**: an 8-digit hex (`#RRGGBBAA`), `rgba(...)`, or CSS4 `rgb(... / ...%)` all fail with `AVATAR_INVALID_BACKGROUND_ID` ("must be a 6-digit hex value"), live-confirmed against production.

An incomplete or invalid pairing is an HTTP-200 `KalturaAPIException` (`AVATAR_MISSING_VISUAL_RESOLUTION`, `AVATAR_FAILED_TO_COMPOSE_VISUAL`, `AVATAR_MISSING_VOICE`, `AVATAR_NOT_FOUND`). `avatars.create` catches the incomplete-pairing case before any network call.

Whichever way you pick, the composed result is reflected in the created avatar's `visual.composition` and a fresh raw `previewImageUrl`/`loadingVideoUrl` (backend asset URLs, not the rendered live-session composite). Inspect those to see what was actually built, rather than assuming the inputs alone describe the output. Changing the composition after create follows different rules: [Management Operations § Avatars](../management-operations.md#avatars--httpsapiavataruskalturaai).

**Faster path — pick a curated preset instead of assembling voice+visual by hand:** `mgmt.avatars.listTemplates(ks, opts)` lists curated bundles, each pairing a `voice` with either a ready `visual` or a `face`/`background` pair. Pass the template's own `id` as `templateId`; if the template's `face`/`background` isn't already a complete pair, add whichever half it's missing:

```js
const templates = await mgmt.avatars.listTemplates(ks, { pageSize: 10 });
const t = templates[0]; // { id, name, voice: { id }, face: { id, imageUrl } }
await mgmt.avatars.create(
  { voice: t.voice, templateId: t.id, background: { type: 'color', value: '#ffffff' } },
  ks,
);
```

## Compose from a custom Face and Background

Upload the two halves first ([Catalog & Assets § Upload a custom Face or Background](../design.md#upload-a-custom-face-or-background-compose-a-visual-path)), then pass their ids as `face.id` and `background.value`:

```js
const face = await mgmt.catalog.createFace(portraitBlob, { name: 'Support rep', genderPresentation: 'Feminine' }, ks);
const bg = await mgmt.catalog.createBackground(backdropBlob, { name: 'Office', genderPresentation: 'Feminine' }, ks);
await mgmt.avatars.create(
  { voice: { id: voiceItemId }, face: { id: face.itemId }, background: { type: 'visual', value: bg.itemId } },
  ks,
);
```

Unlike `createVisual` (a photo used directly, already a full custom digital twin), a Face/Background is only usable through the `face`+`background` composition. It can't be passed as `visual.id` on its own.

---

## Create an Agent

```
POST https://api.avatar.us.kaltura.ai/v1/agent/create
```

```json
{
  "displayName": "StreamBot Support Agent",
  "intellect": {
    "intellectType": "genie",
    "id": 1389
  },
  "avatarIds": ["6a07d63d8ccd85cbfafc5416"],
  "adminTags": ["support"],
  "maxConversationLength": 900
}
```

| Field | Notes |
|-------|-------|
| `intellect.intellectType` | `"genie"` — the only value `mgmt.intellects.create()` can produce today. The field also accepts `"external"`, for an intellect created and managed outside this SDK. |
| `intellect.id` | The intellect's configId, from intellect create — passed straight in, no discovery step |
| `avatarIds` | Optional — omit for a headless text-only agent |
| `maxConversationLength` | Seconds. Omit to use the backend's own default |
| `widgetConfig` / `embedConfig` | Optional, opaque config objects for the hosted widget/embed. Omit unless you're customizing widget or embed behavior |

Returns `agentId` (UUID). **Save this.**

---

## Related docs

| Doc | What it adds |
|---|---|
| [`intellect.md`](intellect.md) | The intellect an agent's `intellect.id` points at |
| [`../build.md`](../build.md) | The Agent Components index |
