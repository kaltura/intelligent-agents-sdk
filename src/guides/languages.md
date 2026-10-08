---
layout: base.njk
title: "Languages"
description: "Pin the language an agent speaks and listens in with setForcedLanguage, clear it again, and see which other language settings exist."
eyebrow: How-to Guide
---

# Languages

Pin the language an agent speaks and listens in with `setForcedLanguage`. This page covers what the SDK does. It does not list which languages the platform supports.

## Pin a language

```js
import { Management } from '@kaltura/intelligent-agents/management';

const mgmt = new Management({ partnerId, adminSecret });
const admin = await mgmt.sessions.createAdminToken({ userId: 'admin@example.com' });

await mgmt.setForcedLanguage({ configId, agentId, language: 'he' }, admin.ks);
```

One call writes two fields, so the agent speaks and listens in the same language:

| Field | Set to | Effect |
|---|---|---|
| `force_language` on the intellect | The display name, for example `"Hebrew"` | Replies come back in that language, whatever language the user writes or speaks |
| `asr.language` on the agent | The code, for example `"he"` | Speech recognition matches the language |

The call is idempotent. It needs an admin token, so run it on your server.

## Clear it

```js
await mgmt.setForcedLanguage({ configId, agentId, language: null }, admin.ks);
```

This clears `force_language` and resets `asr.language` to `"en"`.

## Options

| Option | Notes |
|---|---|
| `configId`, `agentId` | Both required. `configId` is the intellect the agent points at |
| `language` | An ISO 639-1 code such as `"he"`, or `null` to clear |
| `languageName` | The display name written to `force_language`. Required when the code is not in `LANGUAGE_NAMES` |
| `asrProvider` | Passed through to `agents.update`. Defaults to `"kaltura"` |

`LANGUAGE_NAMES` is exported from `@kaltura/intelligent-agents/management`. It maps codes to display names for the call above. It is a lookup table for this helper, not a list of supported languages.

```js
import { LANGUAGE_NAMES } from '@kaltura/intelligent-agents/management';

await mgmt.setForcedLanguage({ configId, agentId, language: 'xx', languageName: 'Your Language' }, admin.ks);
```

A code that is not in `LANGUAGE_NAMES` and has no `languageName` throws `bad_request` before any network call.

## Other language settings

| Setting | Where |
|---|---|
| Voice language | `catalog.createVoice(file, { name, description, language })`. ISO 639-1 code, defaults to `"en"`. See [Design](/reference/api/design/) |
| Conversation language the runtime reports | `languageCode` in the `clientConfiguration` event. See [client configuration](/reference/wire-protocol/client-configuration/) |

## Which language is supported, and how to ask for one

The SDK does not decide which languages work. Ask your Kaltura Account Manager for the current list and to request a language you need.

