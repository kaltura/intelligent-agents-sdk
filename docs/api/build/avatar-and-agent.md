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
  "openingPhrase": "Hello! I'm StreamBot. How can I help you today?"
}
```

`voice.id` and `visual.id` come from the catalog (see [Catalog & Assets](../design.md) § Browse the Catalog). Returns `id` (24-char hex). **No `adminTags`** — `avatar/create` accepts and stores it, but no read path ever returns it, and `avatar/update` genuinely rejects it (no tag field). Tag the parent agent instead.

`openingPhrase` is the line the avatar speaks as the first, uninterruptible turn of every session. It must be a non-empty string. For the fastest interruptible start pass `SILENT_OPENING` (exported from `./management`, the string `<blank>`): the opening turn then produces no speech, and the browser sends the first turn with the session's `kickoff` option. See [START-THE-CONVERSATION.md](../../START-THE-CONVERSATION.md).

If `visual.id` points at a custom uploaded portrait rather than a catalog preset, the framing of that source photo decides how the persona renders on this avatar. The renderer scales the face to a fixed fraction of the canvas and centers it, so a padded portrait fills the canvas and a tight headshot renders with black borders:

![Tight headshot crops shrink onto the render canvas with black borders; a generously padded portrait scales to fill it edge-to-edge](../img/avatar-photo-framing.svg)

Prepare the photo to the spec in [Catalog & Assets § Upload a Custom Visual](../design.md#upload-a-custom-visual-portrait--animated-avatar): square 2600×2600 canvas, head 20 to 25% of the height, centered, background reaching every edge. That section also has a paste-ready prompt for AI image models.

### Three ways to get a visual

`avatar/create` needs exactly one of these to resolve a visual — pick one:

| Way | Body | When |
|---|---|---|
| An existing Visual | `visual: { id }` | Fastest — a catalog preset, or your own upload via `catalog.createVisual` (§ Upload a Custom Visual, above). Wins only if `face`/`background` are both omitted, or both sent together as a complete pair. Sending just one of `face`/`background` alongside `visual` is still a domain error (see the row below) — `visual` does not exempt it. |
| Compose a new Visual from a Face + Background | `face: { id }` + `background: { type: 'color', value?: '#hex' }` (`value` optional, defaults to white) or `{ type: 'visual', value: <Background catalog itemId> }` (`value` required) | You want a specific face (a `catalog.createFace` upload, or one of the 36 preset Face items) over a specific backdrop. `face`/`background` must travel together. Sending just one of them still returns an HTTP 200 with a domain error in the body (`AVATAR_MISSING_VISUAL_RESOLUTION`), even if `visual` is also sent — unless `templateId` is also given: a template can carry its own `face` and/or `background`, filling in whichever half you didn't send. |
| A curated template + whatever it's missing | `templateId` + whichever of `face`/`background`/`visual` the template doesn't already supply | Fastest good-looking result — see below. `templateId` alone is a domain failure unless the template already resolves to a complete `visual` on its own. |

Whichever way you pick, the composed result is reflected in the created avatar's `visual.composition` and a fresh raw `previewImageUrl`/`loadingVideoUrl` (backend asset URLs, not the rendered live-session composite). Inspect those to see what was actually built, rather than assuming the inputs alone describe the output.

**Faster path — pick a curated preset instead of assembling voice+visual by hand:** `mgmt.avatars.listTemplates(ks, opts)` lists curated bundles (36 live today — "Adam", "Amir", "Ben", ...), each pairing a `voice` with either a ready `visual` or a `face`/`background` pair. Pass the template's own `id` as `templateId`; if the template's `face`/`background` isn't already a complete pair, add whichever half it's missing:

```js
const templates = await mgmt.avatars.listTemplates(ks, { pageSize: 10 });
const t = templates[0]; // { id, name: 'Adam', voice: { id }, face: { id, imageUrl } }
await mgmt.avatars.create(
  { voice: t.voice, templateId: t.id, background: { type: 'color', value: '#ffffff' }, openingPhrase: SILENT_OPENING },
  ks,
);
```

### Upload a custom Face or Background (for the compose-a-visual path)

`catalog.createFace`/`catalog.createBackground` upload an image as an explicit `Face`-/`Background`-typed catalog item — the two composable halves the `face`/`background` avatar fields expect. Same multipart shape and attribute fields as `catalog.createVisual` (§ Upload a Custom Visual, above); the only difference is the wire `type` field, which the SDK sets for you. Note the name collision below: the catalog upload's `attrs.background` (a photo attribute string like `'Image'`) is unrelated to the avatar-level `background` composition field used in `avatars.create`.

```js
const face = await mgmt.catalog.createFace(portraitBlob, { name: 'Support rep', genderPresentation: 'Feminine' }, ks);
const bg = await mgmt.catalog.createBackground(backdropBlob, { name: 'Office', genderPresentation: 'Feminine' }, ks);
await mgmt.avatars.create(
  { voice: { id: voiceItemId }, face: { id: face.itemId }, background: { type: 'visual', value: bg.itemId }, openingPhrase: SILENT_OPENING },
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
| `maxConversationLength` | Seconds. Default 540, range 1–3600 |
| `widgetConfig.initialPage.title` | Max 100 chars |

Returns `agentId` (UUID). **Save this.**

---

## Related docs

| Doc | What it adds |
|---|---|
| [`intellect.md`](intellect.md) | The intellect an agent's `intellect.id` points at |
| [`../build.md`](../build.md) | The Agent Components index |
