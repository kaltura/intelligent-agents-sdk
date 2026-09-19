[← Back to the API Reference index](../../API-REFERENCE.md)

# Catalog & Assets

## Browse the Catalog

```
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/list
```

```json
{
  "filter": { "typeEqual": "Visual" },
  "pager": { "offset": 0, "limit": 100 }
}
```

Change `typeEqual` to `"Voice"` for voices. Each item has an `itemId` — pass it to avatar creation.

**Visual preset fields:** `itemId`, `attributes.visual.{name, genderPresentation, skinTone, ageGroup, hairColor, clothing, background}`, `imageUrl`, `loadingVideo`. These are raw backend asset URLs, not the rendered composite the live video stream shows: an upload echo for a custom visual, or a preset asset URL for a catalog item.

**Voice preset fields:** `itemId`, `attributes.voice.{name, description, language}`, `voiceSampleUrl`.

SDK: `mgmt.catalog.list(ks, { type: 'Visual' })` or `{ type: 'Voice' }`.

---

## Generate an Agent Profile

```
POST https://api.avatar.us.kaltura.ai/v1/application/generateAgentProfile
```

```json
{ "userDescription": "A friendly technical support agent for a video platform" }
```

Returns `{goal, targetAudience, restrictedTopics, name, openingPhrase}` — pass directly to the intellect's configuration (see [Authentication & Services § The Five Services](authentication.md#the-five-services) for what an intellect is). Takes 2–3 s. The result is not saved automatically.

---

## Upload a Custom Voice (clone)

```
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/create   (multipart/form-data)
```

```
file=@sample.mp3
attributes={"voice":{"name":"My Voice","description":"non-empty description","language":"english"}}
adminTags=custom
```

Returns a catalog item whose `itemId` is the ElevenLabs clone. Pair with any avatar's `voice.id`.

**Gotchas:**

- `description` must be non-empty.
- Audio under ~6 s returns `500`.
- Send `adminTags=custom` bare, not as a JSON array string.

**SDK shortcut:** `catalog.createVoice(mp3Blob, { name, description, language?, consentRef? }, adminKs)`. It enforces the non-empty `description` client-side and tags the item `adminTags:['custom']`, so `catalog.list` filtered on that tag finds it. `language` is an ISO 639-1 code and defaults to `'en'`.

## Import a Provider Voice by id (no audio upload)

Already have a voice on ElevenLabs or Cartesia? Create the catalog Voice item directly from its provider voice id:

```
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/createVoiceFromElevenLabs   {"voiceId":"<provider-voice-id>"}
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/createVoiceFromCartesia     {"voiceId":"<provider-voice-id>"}
```

An unknown provider id creates **nothing**. It replies with an HTTP-200 `KalturaAPIException` envelope (`VOICE_DOES_NOT_EXIST_ON_ELEVEN_LABS` / `VOICE_DOES_NOT_EXIST_ON_CARTESIA`), and the SDK maps these to typed `voice_not_found_elevenlabs` / `voice_not_found_cartesia` errors. SDK: `mgmt.catalog.importVoiceFromElevenLabs(voiceId, ks)` / `importVoiceFromCartesia(voiceId, ks)`.

---

## Upload a Custom Visual (portrait → animated avatar)

```
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/create   (multipart/form-data)
```

```
file=@portrait.jpg
attributes={"visual":{"name":"My Portrait","genderPresentation":"Feminine","background":"Image","skinTone":"Light","ageGroup":"YoungAdult","hairColor":"Brown"}}
adminTags=custom
```

Returns a catalog item whose `itemId` is the catalog visual. Pass it as `visual.id` in `avatar/create` (or `visualId` in `provision`). The renderer animates the portrait live at runtime. No manual step is involved: upload, create the avatar, start a session.

### How the renderer frames your photo

The renderer applies one fixed rule to every source image: it scales the image so the face is a fixed fraction of the canvas height, then centers the face on the canvas. Everything else follows from that rule.

| Your source photo | What renders |
|---|---|
| The face fills most of the frame (a tight headshot) | The whole image is scaled down until the face reaches the target size. The canvas around it stays black. |
| The face is a small part of a large frame (a padded portrait) | The image is cropped in around the face and fills the canvas edge to edge. No borders. |

A padded source can always be cropped in. A tight source can only be scaled down, and that scaling is what produces the borders. Pad more, never less.

![Tight headshot crops shrink onto the render canvas with black borders; a generously padded portrait scales to fill it edge-to-edge](img/avatar-photo-framing.svg)

### Photo specification

Prepare the source image to this spec before upload. A photo that meets it renders edge to edge.

| Property | Requirement |
|---|---|
| Canvas | Square, 2600×2600 px. Minimum 2048×2048 px. |
| Head height (chin to top of hair) | 20 to 25% of the canvas height. |
| Head position | Centered on the canvas, horizontally and vertically. The renderer centers on the face, so equal room on every side gives it the most to work with. |
| Body | Shoulders and upper chest visible. Arms relaxed, not raised. |
| Background | One continuous background that reaches every edge. No borders, letterbox bars, or transparent areas. |
| Subject | One person, facing the camera, eyes open, mouth closed, even lighting. No sunglasses, hats that hide the hairline, or hands near the face. |
| File | JPEG or PNG, sRGB. |

Most photos you receive are tight portraits or phone snapshots. Do not crop them tighter. Extend them: upscale, fill the background outward, then resize to the square canvas.

### Prepare a photo with an AI image model

Give an image model that supports outpainting (Gemini, GPT Image, Higgsfield, or similar) the source photo and this prompt. It performs the three steps in order: upscale, extend, resize.

```text
Prepare this photo as an avatar source image. Keep the person's identity, face, hair,
skin tone, expression, and clothing exactly as they are. Do not restyle, beautify,
or relight the person.

1. Upscale the photo so the face stays sharp at the final size, with no visible noise
   or compression artifacts.
2. Extend the picture outward on all sides by continuing the existing background
   naturally (outpaint), until the canvas is square and the head, from chin to top of
   hair, is 20 to 25% of the canvas height. Keep the head centered on the canvas,
   horizontally and vertically, with the shoulders and upper chest visible below it.
   The background must reach every edge: no borders, frames, bars, or transparent areas.
3. Output one 2600×2600 px JPEG or PNG.
```

If the photo already has a flat, single-color background, pad it with that color instead of an AI model. Measure the head height `h` in pixels, then pad to a square of about 4.5×`h` and resize:

```bash
side=$((h * 9 / 2))
magick portrait.jpg -gravity center -background '#f2f2f2' -extent "${side}x${side}" -resize 2600x2600 avatar-source.jpg
```

Before upload, check the result against the spec table: square canvas, head height in range, head centered, background touching every edge, and the person unchanged next to the original.

The API accepts any subset of the attribute fields, including none. Video-clip ingest is not available through this API.

**SDK shortcut:** `catalog.createVisual(imageBlob, { name, genderPresentation, background, skinTone, ageGroup, hairColor }, adminKs)` requires `name` and `genderPresentation` client-side (`bad_request` before any network call if either is missing) and defaults the rest to a consistent baseline look. Returns the server response as is: `{ itemId, loadingVideo }`.

## Upload a custom Face or Background (compose-a-visual path)

`createVisual` above uploads a photo directly as a ready-to-use Visual. `catalog-item/create` also accepts an explicit `Face`/`Background` `type`, producing the two composable HALVES that the `avatar/create` `face`/`background` fields expect instead. This uses the same multipart shape and attribute fields as a Visual upload, just with `type` set.

**Watch for this name collision:** the `attributes.visual.background` field below is a photo ATTRIBUTE string (e.g. `"Image"`) describing the upload's own backdrop. It's unrelated to `avatar/create`'s own `background` field, the `{type:'color'|'visual', value}` composition selector used a few steps later.

```
file=@face-portrait.jpg
attributes={"visual":{"name":"Support rep","genderPresentation":"Feminine","background":"Image","skinTone":"Light","ageGroup":"YoungAdult","hairColor":"Brown"}}
type=Face
adminTags=custom
```

Send `type=Background` for a backdrop image instead. Only 36 preset Face items and 4 preset Background items exist today (live count) — this is the only way to add a custom one.

**SDK shortcut:** `catalog.createFace(imageBlob, attrs, adminKs)` / `catalog.createBackground(imageBlob, attrs, adminKs)` — same `attrs` shape as `createVisual`. See [build/avatar-and-agent.md § Three ways to get a visual](build/avatar-and-agent.md#three-ways-to-get-a-visual) for how to compose the result into an avatar.

---

## End-to-end: custom portrait avatar, server to browser

`catalog.createVisual` and `avatars.create` (steps 1 and the first call of step 2) are covered by the SDK's own integration tests (`test/integration/avatars-catalog.test.js`). Full recipe:

1. Server: `catalog.createVisual(portraitBlob, { name, genderPresentation, background, skinTone, ageGroup, hairColor }, adminKs)` → `{ itemId }`.
2. Server: `avatars.create({ voice: { id: voiceItemId }, visual: { id: itemId }, openingPhrase: SILENT_OPENING }, adminKs)` → `agents.create` → `application.resolveWidgetId`. The silent opening (`SILENT_OPENING`, exported from `./management`) lets the browser start the conversation with an interruptible first turn, see step 3.
3. Browser: `sessions.createWidgetToken({ widgetId })` → `application.appInit(widgetKs)` → `new KalturaAvatarSession({ token: init.ks, conversationManagerUrl: init.conversationManagerUrl, srsBaseUrl: init.srsBaseUrl, turnServerUrl: init.turnServerUrl, videoEl, kickoff: 'Greet the user and briefly say how you can help.' })`. The SDK sends `kickoff` once, as soon as the server accepts input ([START-THE-CONVERSATION.md](../START-THE-CONVERSATION.md)). No admin secret ever reaches the browser.
4. The portrait avatar animates live in `videoEl`; type or speak to it and it replies in the portrait's face with the chosen voice.
