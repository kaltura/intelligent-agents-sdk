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

Allowed ranges: `voice.speed` 0.5 to 1.5; `motionControl.speaking` and `motionControl.nonSpeaking` each 0.1 to 1.0 (keep `nonSpeaking` below `speaking`); `name` up to 255 characters. A value outside these ranges is a 400.

`voice.id` and `visual.id` come from the catalog ([Catalog & Assets § Browse the Catalog](../design.md#browse-the-catalog)). For your own portrait, upload it first and use the returned `itemId` as `visual.id` ([§ Upload a Custom Visual](../design.md#upload-a-custom-visual-portrait--animated-avatar), which also covers how to prepare the photo). Returns `id` (24-char hex). **No `adminTags`** on avatars: tag the parent agent instead ([Management Operations § Avatars](../management-operations.md#avatars)).

Leave `openingPhrase` unset. The intellect's `opening_phrase` sets the first, uninterruptible turn of every session ([Configure an Intellect](intellect.md#configure-an-intellect)). `provision()` writes it there and creates the avatar without a phrase. An avatar-level `openingPhrase` is spoken only for a session whose intellect has none. Clear one with `avatars.update({ id, openingPhrase: null }, ks)`. Where the phrase lives, how to personalize it with a template, and the silent-opening and `kickoff` pattern: [START-THE-CONVERSATION.md](../../START-THE-CONVERSATION.md).

### Three ways to get a visual

`avatar/create` needs exactly one of these to resolve a visual:

| Way | Body | When |
|---|---|---|
| An existing Visual | `visual: { id }` | Fastest. A catalog preset, or your own upload via `catalog.createVisual`. Do not send just one of `face`/`background` alongside `visual`. Send both as a complete pair or neither. |
| Compose a new Visual from a Face + Background | `face: { id }` + `background: { type: 'color', value?: '#hex' }` (`value` optional, defaults to white) or `{ type: 'visual', value: <Background catalog itemId> }` (`value` required) | You want a specific face (a `catalog.createFace` upload, or a preset Face item) over a specific backdrop. Send `face` and `background` together at create time. `avatars.create` throws `bad_request` before any network call if you send only one, even when `visual` is also sent. With `templateId`, one half is enough: a template can carry its own `face` or `background`. |
| A curated template + whatever it's missing | `templateId` + whichever of `face`/`background`/`visual` the template doesn't already supply | Fastest good-looking result. See below. `templateId` alone works only when the template already includes a complete `visual`. |

You cannot create an avatar from a face alone and add the background afterwards: a face and a background are required together at create time. Once the avatar exists, `avatars.update` accepts a `background` on its own ([Management Operations § Avatars](../management-operations.md#avatars)).

For `background.type: 'color'`, `value` must be a plain 6-digit hex string (`#RRGGBB`) with **no alpha channel**. An 8-digit hex (`#RRGGBBAA`), `rgba(...)` or a CSS4 `rgb(... / ...%)` throws `bad_request` before any network call.

Whichever way you pick, the composed result is reflected in the created avatar's `visual.composition` and a fresh `previewImageUrl`/`loadingVideoUrl` (asset URLs, not the rendered live-session composite). Inspect those to see what was built. Changing the composition after create follows different rules: [Management Operations § Avatars](../management-operations.md#avatars).

**Faster path: pick a curated preset instead of assembling voice and visual by hand.** `mgmt.avatars.listTemplates(ks, opts)` lists curated bundles, each pairing a `voice` with either a ready `visual` or a `face`/`background` pair. Pass the template's own `id` as `templateId`; if the template's `face`/`background` is not already a complete pair, add whichever half it is missing:

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

Unlike `createVisual` (a photo used directly, already a full custom digital twin), a Face/Background is only usable through the `face` and `background` composition. You cannot pass it as `visual.id` on its own.

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
| `intellect.intellectType` | `"genie"`. The value `mgmt.intellects.create()` produces. The field also accepts `"external"`, for an intellect created and managed outside this SDK. |
| `intellect.id` | The intellect's configId, from intellect create. Pass it straight in, no discovery step |
| `avatarIds` | Optional. Omit for a headless text-only agent |
| `maxConversationLength` | Seconds, 1 to 3600. Omit to use the default |
| `widgetConfig` / `embedConfig` | Optional settings for the hosted widget and embed. See [Widget and embed settings](#widget-and-embed-settings) |
| `screenShare` | Optional `{enabled, prompt}`. Set `enabled: true` and a `prompt` that says how to describe the shared screen to let an avatar session share its screen. `mgmt.agents.update` changes it later. The reserved variable `sys__avatar_share_screen_enabled` is described in [Reserved Template Variables](../operate.md#reserved-template-variables-sys__) |
| `asr` | Optional `{language, provider}` for speech recognition. `language` is a language code, for example `"en"`. `provider` is `"kaltura"`, `"kaltura-hebrew"`, `"elevenlabs"` or `"soniox"`. Omit it to get `{"language":"en","provider":"kaltura"}`. A `provider` or `language` outside the accepted values returns `bad_request` (400). `mgmt.agents.update` changes it later. To pin one language for replies and recognition together, see [Languages](../../LANGUAGES.md) |

Returns `agentId` (UUID). **Save this.**

## Widget and embed settings

`widgetConfig` sets the hosted widget's start page and layout. `embedConfig` sets the embed theme.

```js
await mgmt.agents.update({
  agentId,
  widgetConfig: {
    tips: 'Ask about pricing or setup.',
    initialPage: { title: 'Support', subtitle: 'How can I help?', initialQuestions: [{ text: 'How do I start?', answerType: 'markdown' }] },
    layouts: { avatar: true, chat: true },
    tapToTalk: false,
  },
  embedConfig: { theme: 'dark' },
}, ks);
```

| Field | Rule |
|---|---|
| `tips` | String, up to 10000 characters |
| `initialPage.title` / `initialPage.subtitle` | Strings, up to 100 and 200 characters |
| `initialPage.backgroundImageUrl` | A URL, or `null`. Stored and returned raw |
| `initialPage.initialQuestions` | `[{ text, answerType }]`. `answerType` is `'markdown'` or `'flashcards'` |
| `layouts` | `{ avatar, chat }`, both booleans |
| `tapToTalk` | Boolean |
| `embedConfig.theme` | String |

- An update that sends `widgetConfig` replaces the whole object, nested fields included. Send every field you want to keep. Leave `widgetConfig` out to keep it as it is, or send `null` to clear it. `embedConfig` is separate: changing one does not touch the other.
- A wrong type, a value over its limit or an unknown key returns `bad_request` (400), and the message names the field.
- `application.appInit` returns the same `widgetConfig`, except the background comes back as `initialPage.background: { type: 'url', url }` instead of `backgroundImageUrl`, with the same raw URL.

## Screen share

The agent can look at the user's screen and help with what it sees. Two steps:

1. Turn it on for the agent. The `prompt` tells the vision step what to report.

```js
await mgmt.agents.update({ agentId, screenShare: { enabled: true, prompt: 'Describe code, errors and UI state.' } }, ks);
```

2. In the browser, call `session.startScreenShare()` from a click. The browser shows its screen picker.

```js
shareButton.addEventListener('click', () => {
  if (session.screenSharing) session.stopScreenShare();
  else session.startScreenShare().catch((e) => { if (e.code !== 'screen_share_denied') throw e; });
});
session.on('screenShareChanged', ({ active }) => shareButton.setAttribute('aria-pressed', String(active)));
```

`KalturaAgentSession` has the same `startScreenShare()`, `stopScreenShare()`, `screenSharing` and `screenShareChanged`. In chat mode `startScreenShare()` throws `screen_share_unsupported`. A `switchMode()` ends a running share.

The SDK sends a JPEG still every 2 seconds until `stopScreenShare()`, `disconnect()` or the user's own "stop sharing" control. The agent reads the stills as text, so answers can lag by a few seconds.

| Option (`startScreenShare(opts)`) | Default | Meaning |
|---|---|---|
| `intervalMs` | `2000` | Time between stills |
| `maxWidth` | `1500` | Wider stills (px) are scaled down |
| `quality` | `0.5` | JPEG quality, 0 to 1 |
| `stream` | none | A display stream you already hold. The SDK then skips the picker and does not stop its tracks |

| Error code | When |
|---|---|
| `capability_disabled` | The agent's `screenShare` setting is off |
| `screen_share_denied` | The user cancelled the picker or blocked access |
| `screen_share_unsupported` | The browser has no `getDisplayMedia` |
| `screen_share_failed` | The browser could not start the capture |

A failed capture during a share arrives as a `warning` event with code `screen_share_capture_failed`, and the share continues. `session.sendScreenShot(data)` sends one still you captured yourself. Full app: [examples/screen-share-agent.html](../../../examples/screen-share-agent.html).

---

## Related docs

| Doc | What it adds |
|---|---|
| [`intellect.md`](intellect.md) | The intellect an agent's `intellect.id` points at |
| [`../build.md`](../build.md) | The Agent Components index |
