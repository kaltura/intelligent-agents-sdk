---
layout: base.njk
title: "Catalog & Assets"
description: "Catalog browsing, agent profile generation, custom voice cloning, provider voice import, and custom portrait avatars."
eyebrow: Reference
---

# Catalog & Assets

[← Back to the API Reference index](/reference/api-reference/)


Browse preset voices and visuals, and upload your own voice, portrait, face or background. Read this before you create an avatar from custom media.

## Browse the Catalog

```
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/list
```

```json
{
  "filter": { "typeEqual": "Visual" },
  "orderBy": "-createdAt",
  "pager": { "offset": 0, "limit": 100 }
}
```

Each item has an `itemId`. Pass it to avatar creation.

| `filter` key | Value |
|---|---|
| `typeEqual` | `"Visual"`, `"Voice"`, `"Face"` or `"Background"` |
| `itemIdEqual` | One `itemId` |
| `idsIn` | An array of `itemId`s |
| `languageEqual` | A voice language code, for example `"en"` |
| `adminTagsIn` | An array of tags |

Any other filter key returns `bad_request` (400). The request also takes a top-level `orderBy` and a top-level `agentScope` string. `orderBy` is `"+createdAt"` or `"-createdAt"`. `"-createdAt"` sorts newest first. `"+createdAt"` is accepted but does not change the order. Any other `orderBy` returns `bad_request` (400), and the error lists both values.

`agentScope` is an agent id. Without it, the list returns only unscoped items. With an agent id, it returns the unscoped items plus that agent's own items. An unknown agent id is not an error.

**Visual preset fields:** `itemId`, `attributes.visual.{name, genderPresentation, skinTone, ageGroup, hairColor, clothing, background}`, `imageUrl`, `loadingVideo`. These are asset URLs for previews. They are not the rendered composite that the live video stream shows.

**Voice preset fields:** `itemId`, `attributes.voice.{name, description, language}`, `voiceSampleUrl`.

SDK: `mgmt.catalog.list(ks, { type, filter, orderBy, agentScope })`. `type` is a shortcut for `filter.typeEqual`. Passing both with different values throws `bad_request` before any request.

---

## Upload a Custom Voice (clone)

```
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/create   (multipart/form-data)
```

```
file=@sample.mp3
attributes={"voice":{"name":"My Voice","description":"non-empty description","language":"en"}}
adminTags=custom
```

Returns a catalog item whose `itemId` is the cloned voice. Pair it with any avatar's `voice.id`.

**Gotchas:**

- `description` must be non-empty.
- Use an audio sample longer than about 6 seconds.
- Send `adminTags=custom` bare, not as a JSON array string.

**SDK shortcut:** `catalog.createVoice(mp3Blob, { name, description, language?, consentRef? }, adminKs)`. It enforces the non-empty `description` client-side and tags the item `adminTags:['custom']`. `language` is a language code, for example `"en"` or `"he"`, and defaults to `'en'`. A code outside the accepted list returns `bad_request` (400), and the error lists the accepted codes.

## Import a Provider Voice by id (no audio upload)

Already have a voice on ElevenLabs or Cartesia? Create the catalog Voice item directly from its provider voice id:

```
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/createVoiceFromElevenLabs   {"voiceId":"<provider-voice-id>"}
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/createVoiceFromCartesia     {"voiceId":"<provider-voice-id>"}
```

An unknown provider id creates **nothing**. A `voiceId` must be 1 to 128 characters, letters, digits, `_` or `-` only. Anything else throws `bad_request` before any request. The SDK throws a typed `voice_not_found_elevenlabs` / `voice_not_found_cartesia` error. A voice with no audio samples throws `voice_has_no_samples`: upload an audio file with `catalog.createVoice` instead. SDK: `mgmt.catalog.importVoiceFromElevenLabs(voiceId, ks)` / `importVoiceFromCartesia(voiceId, ks)`.

---

## Custom look: a Face and a Background (recommended)

Upload one Face and any number of Backgrounds, then pair them in `avatars.create`. One person on many backdrops costs one Face upload. A later background swap needs no upload at all. Use this path for your own media. A single photo with its background baked in is the [alternative](#upload-a-custom-visual-portrait--animated-avatar).

| Piece | SDK upload | Requirement |
|---|---|---|
| Face | `catalog.createFace(pngBlob, attrs, ks)` | A **transparent PNG cutout**: the person only, with alpha around them. Square, 2048×2048 px or larger. |
| Background | `catalog.createBackground(imageBlob, attrs, ks)` | Any JPEG or PNG. For a flat color skip the upload and pass `background: { type: 'color', value: '#RRGGBB' }`. |

A Face that is an opaque photo keeps its own backdrop in the live stream and ignores the background you pick, even a flat color. Preset Faces are transparent PNGs for the same reason.

`attrs` takes the same fields as `createVisual` ([values](#upload-a-custom-visual-portrait--animated-avatar)). `attrs.background` is a photo attribute string such as `"Image"`. It is unrelated to the `background` selector of `avatar/create`. Compose, then swap a background later: [Agent Components · Create an Avatar and an Agent § Compose from a custom Face and Background](/reference/api/build/avatar-and-agent/#compose-from-a-custom-face-and-background). Live example, one Face on five backgrounds: [examples/face-and-backgrounds/](https://github.com/kaltura/intelligent-agents-sdk/blob/main/examples/face-and-backgrounds/).

### Make the Face with Google Flow or Gemini

Image models cannot write real transparency. Ask for a flat green background, then key the green out.

1. Get a portrait: your own photo, or one generated in [Google Flow](https://flow.google.com) or the Gemini app.
2. Ask an image model that edits photos (Gemini, "Nano Banana") for the same person on flat green. In Flow, send the prompt in the project chat. In Gemini, attach the portrait.

   ```text
   Edit this portrait. Keep the person's identity, face, hair, skin tone, expression and
   clothing exactly as they are. Replace the whole background with one flat, pure green
   (#00FF00). No shadows, no gradient, no green light on the skin or hair, no props.
   Head and shoulders, centered, facing the camera, eyes open, mouth closed, even lighting.
   Square image.
   ```

   To start from nothing, replace the first two sentences with "Generate a photo-real portrait of …".
3. Download the largest size (Flow: Download, then 2K). Expect a square image of at least 2048 px.
4. Key the green out with [key-green-screen.py](https://github.com/kaltura/intelligent-agents-sdk/blob/main/examples/face-and-backgrounds/key-green-screen.py):

   ```bash
   pip install pillow numpy
   python3 examples/face-and-backgrounds/key-green-screen.py face-green.jpg face.png
   ```

   The script does three things: a difference key (how much greener a pixel is than its red and blue), a despill that removes the green tint on edge pixels, and a 2 px matte shave plus a soft edge that removes the halo. The downloaded green is rarely exact (about `rgb(13,247,0)` in the example), which the difference key tolerates. Green fringe left: lower `--high`. Holes in the person: raise `--low`.
5. Check the edges on a dark and a light backdrop before upload:

   ```bash
   magick face.png -background '#202020' -flatten check-dark.png
   magick face.png -background '#f2f2f2' -flatten check-light.png
   ```

   Look for a green line along the hair and shoulders. The input and output of the example are `assets/face-green.jpg` and `assets/face.png`.

---

## Upload a Custom Visual (portrait → animated avatar)

The alternative to a [Face and a Background](#custom-look-a-face-and-a-background-recommended). Use it when you have one finished photo and its background never changes. The photo carries its own backdrop, so the background cannot be swapped without a new upload.

```
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/create   (multipart/form-data)
```

```
file=@portrait.jpg
attributes={"visual":{"name":"My Portrait","genderPresentation":"Feminine","background":"Image","skinTone":"Light","ageGroup":"YoungAdult","hairColor":"Brown"}}
adminTags=custom
```

Returns a catalog item whose `itemId` is the catalog visual. Pass it as `visual.id` in `avatar/create` (or `visualId` in `provision`). The portrait is animated live at runtime. No manual step is involved: upload, create the avatar, start a session.

### How your photo renders

| Your source photo | What renders |
|---|---|
| The face fills most of the frame (a tight headshot) | The whole image shrinks. The canvas around it stays black. |
| The face is a small part of a large frame (a padded portrait) | The image fills the canvas edge to edge. No borders. |

Pad more, never less.

![Tight headshot crops shrink onto the render canvas with black borders; a generously padded portrait scales to fill it edge-to-edge](/assets/img/avatar-photo-framing.svg)

### Photo specification

Prepare the source image to this spec before upload. A photo that meets it renders edge to edge.

| Property | Requirement |
|---|---|
| Canvas | Square, 2600×2600 px. Minimum 2048×2048 px. |
| Head height (chin to top of hair) | 20 to 25% of the canvas height. |
| Head position | Centered on the canvas, horizontally and vertically. Equal room on every side gives the best result. |
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

**Visual attribute values**

| Attribute | Accepted values | SDK default |
|---|---|---|
| `genderPresentation` | `Masculine`, `Feminine` | required |
| `background` | `Color`, `Image` | `Image` |
| `skinTone` | `MediumTan`, `Light`, `LightMedium` | `Light` |
| `ageGroup` | `YoungAdult`, `OlderAdult` | `YoungAdult` |
| `hairColor` | `Black`, `Brown`, `Blonde`, `Red`, `Gray` | `Brown` |
| `hairStyle` | An array of strings | `["Short"]` |
| `clothing` | An array of strings | `["Casual"]` |
| `glasses` | `true` or `false` | `false` |

A value outside the lists above for `genderPresentation`, `background`, `skinTone`, `ageGroup` or `hairColor` returns `bad_request` (400), and the error lists the accepted values. A `glasses` value that is not a boolean also returns `bad_request`.

**SDK shortcut:** `catalog.createVisual(imageBlob, { name, genderPresentation, ...attributes }, adminKs)` takes the attributes from the table above. It requires `name` and `genderPresentation` client-side (`bad_request` before any network call if either is missing) and defaults the rest to a consistent baseline look. Returns the server response: `{ itemId, loadingVideo }`. Pass an optional `consentRef` and the result also carries a consent receipt. See [Security & Compliance](/reference/security/) for the receipt.

## Tag an upload with an agent id (`agentScope`)

Every file upload above (`createVoice`, `createVisual`, `createFace`, `createBackground`) takes an optional `agentScope`, and `catalog-item/update` takes it too. It is one more form field on `catalog-item/create`, or one more key in the `catalog-item/update` body:

```
agentScope=<agent id>
```

[Browse the catalog](#browse-the-catalog) with the same `agentScope` to list the items tagged with that agent next to the unscoped ones. `agentScope` is a tag for listing. It is not access control. A list call without `agentScope` does not return a scoped item. After `update` with `agentScope: ''`, the item is unscoped and appears in every list.

| Call | `agentScope` |
|---|---|
| `createVoice`, `createVisual`, `createFace`, `createBackground` | Omit it for an unscoped item. Otherwise a non-blank string. |
| `update` | Omit it to leave the tag as it is. A non-blank string sets it. `''` clears it. |

Anything else (`null`, a number, a blank string, or `''` on create) throws `bad_request` before any request. The SDK does not trim the value or check that the id names an existing agent, so it must equal the `agentScope` you pass to `catalog.list`, including case and spaces.

```js
const voice = await mgmt.catalog.createVoice(mp3, { name, description, agentScope: agentId }, adminKs);
await mgmt.catalog.update({ itemId: voice.itemId, agentScope: '' }, adminKs);   // share with every agent
```

---

## End-to-end: custom portrait avatar, server to browser

Each step lives on its own page. Follow them in order:

1. Upload the Face and a Background ([§ Custom look](#custom-look-a-face-and-a-background-recommended)), or one portrait ([§ Upload a Custom Visual](#upload-a-custom-visual-portrait--animated-avatar)). Each returns an `itemId`.
2. Create the avatar with `face` and `background`, or with `visual: { id: itemId }`, then the agent: [Agent Components · Create an Avatar and an Agent](/reference/api/build/avatar-and-agent/).
3. Resolve the widget id and initialize the browser runtime: [Widget & Runtime Init](/reference/api/deploy/).
4. Start the conversation from the browser with a silent opening and `kickoff`: [Start the Conversation](/guides/start-the-conversation/).

