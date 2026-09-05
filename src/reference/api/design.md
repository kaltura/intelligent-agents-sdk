---
layout: base.njk
title: "API · Phase 1 — Design"
description: "Catalog browsing, agent profile generation, custom voice cloning, provider voice import, and custom portrait avatars."
eyebrow: Reference
---

# Phase 1 — design

[← Back to the API Reference index](/reference/api-reference/)

**On this page:** [Browse the Catalog](#browse-the-catalog) · [Generate an Agent Profile](#generate-an-agent-profile) · [Upload a Custom Voice (clone)](#upload-a-custom-voice-clone) · [Import a Provider Voice by id (no audio upload)](#import-a-provider-voice-by-id-no-audio-upload) · [Upload a Custom Visual (portrait → animated avatar)](#upload-a-custom-visual-portrait--animated-avatar) · [End-to-end: custom portrait avatar, server to browser](#end-to-end-custom-portrait-avatar-server-to-browser)


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

**Visual preset fields:** `itemId`, `attributes.visual.{name, genderPresentation, skinTone, ageGroup, hairColor, clothing, background}`, `imageUrl`, `loadingVideo` — raw backend asset URLs (an upload echo for a custom visual, a preset asset URL for a catalog item), not the rendered composite the live WHEP stream shows.

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

Returns `{goal, targetAudience, restrictedTopics, name, openingPhrase}` — pass directly to intellect configuration. Takes 2–3 s; result is not saved automatically.

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

Returns a `CatalogItemDto` whose `itemId` is the ElevenLabs clone. Pair with any avatar's `voice.id`.

**Gotchas:** `description` must be non-empty; audio under ~6 s returns `500`; send `adminTags=custom` bare (not a JSON array string).

**SDK shortcut:** `catalog.createVoice(mp3Blob, { name, description, language?, consentRef? }, adminKs)` — enforces the non-empty `description` client-side and tags the item `adminTags:['custom']` so `catalog.list` filtered on that tag finds it. `language` is an ISO 639-1 code and defaults to `'en'`.

## Import a Provider Voice by id (no audio upload)

Already have a voice on ElevenLabs or Cartesia? Create the catalog Voice item directly from its provider voice id:

```
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/createVoiceFromElevenLabs   {"voiceId":"<provider-voice-id>"}
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/createVoiceFromCartesia     {"voiceId":"<provider-voice-id>"}
```

An unknown provider id creates **nothing** and replies an HTTP-200 `KalturaAPIException` envelope (`VOICE_DOES_NOT_EXIST_ON_ELEVEN_LABS` / `VOICE_DOES_NOT_EXIST_ON_CARTESIA`) — the SDK maps these to typed `voice_not_found_elevenlabs` / `voice_not_found_cartesia` errors. SDK: `mgmt.catalog.importVoiceFromElevenLabs(voiceId, ks)` / `importVoiceFromCartesia(voiceId, ks)`.

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

Returns a `CatalogItemDto` whose `itemId` is the catalog visual. Pass it as `visual.id` in `avatar/create` (or `visualId` in `provision`). The model **animates the portrait live at runtime** — no ops involvement, self-serve. Verified: a real 2.4 MB portrait JPEG (`avatar-session/create` → `{success:true, sessionId}`).

The backend does preprocess the uploaded image before rendering: it crop-fits the source to a fixed face-height-to-frame ratio and centers it on the render canvas. A tight "headshot"-style crop (the intuitive upload) is the worst case. The bigger the face already fills the source frame, the more the backend downscales it to hit that ratio, and the bigger the resulting black borders around the rendered avatar. One confirmed case: padding the source out to roughly 2600×2600 (face occupying a small fraction of the frame) produced an edge-to-edge render with no borders. This is an observed data point from one real upload, not a documented API contract. The exact ratio isn't published, so pad generously and check the result in a live session rather than assuming this number is precise.

![Tight headshot crops shrink onto the render canvas with black borders; a generously padded portrait scales to fill it edge-to-edge](/assets/img/avatar-photo-framing.svg)

**Required fields** (API 400s if any are missing): `name`, `genderPresentation`, `background`, `skinTone`, `ageGroup`, `hairColor`. Video-clip ingest is not available through this API.

**SDK shortcut:** `catalog.createVisual(imageBlob, { name, genderPresentation, background, skinTone, ageGroup, hairColor }, adminKs)` — returns `{ itemId, loadingVideo }` (raw API response — field names come from the CatalogItemDto and are not SDK-normalized; treat as best-effort until the API contract is pinned).

---

## End-to-end: custom portrait avatar, server to browser

The full path is exercised end-to-end by the SDK's own integration test (`test/integration/avatars-catalog.test.js`) plus this recipe:

1. Server: `catalog.createVisual(portraitBlob, { name, genderPresentation, background, skinTone, ageGroup, hairColor }, adminKs)` → `{ itemId }`.
2. Server: `avatars.create({ voice: { id: voiceItemId }, visual: { id: itemId }, openingPhrase: '<blank>' }, adminKs)` → `agents.create` → `application.resolveWidgetId`.
3. Browser: `sessions.createWidgetToken({ widgetId })` → `application.appInit(widgetKs)` → `new KalturaAvatarSession({ token: init.ks, conversationManagerUrl: init.conversationManagerUrl, srsBaseUrl: init.srsBaseUrl, turnServerUrl: init.turnServerUrl, videoEl })`. No admin secret ever reaches the browser.
4. The portrait avatar animates live in `videoEl`; type or speak to it and it replies in the portrait's face with the chosen voice.

