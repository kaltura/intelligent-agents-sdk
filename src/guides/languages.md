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
| `force_language` on the intellect | The English name of the language, for example `"Hebrew"`. Use the same form if you set the field yourself | Replies come back in that language, whatever language the user writes or speaks |
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
| `language` | An ISO 639-1 code from `LANGUAGE_CODES`, such as `"he"`, or `null` to clear |
| `languageName` | The English name written to `force_language`. Required when the code is not in `LANGUAGE_NAMES` |
| `asrProvider` | Passed through to `agents.update`. Defaults to `"kaltura"` |

`LANGUAGE_CODES` and `LANGUAGE_NAMES` are exported from `@kaltura/intelligent-agents/management`. `LANGUAGE_CODES` lists the codes `setForcedLanguage` accepts. `LANGUAGE_NAMES` maps some of them to English names. Neither is a list of supported languages.

```js
import { LANGUAGE_CODES, LANGUAGE_NAMES } from '@kaltura/intelligent-agents/management';

await mgmt.setForcedLanguage({ configId, agentId, language: 'sw', languageName: 'Swahili' }, admin.ks);
```

A code outside `LANGUAGE_CODES` throws `bad_request` before any network call, even with a `languageName`. A code in `LANGUAGE_CODES` but not in `LANGUAGE_NAMES` needs `languageName`.

## Other language settings

| Setting | Where |
|---|---|
| Voice language | `catalog.createVoice(file, { name, description, language })`. A language code from the accepted list, defaults to `"en"`. See [Design](/reference/api/design/) |
| Conversation language on the wire | The `clientConfiguration` message carries a `languageCode` field. It is part of the wire protocol, not an SDK option you set. See [client configuration](/reference/wire-protocol/client-configuration/) |

## Which language is supported, and how to ask for one

The SDK does not decide which languages work. Ask your Kaltura Account Manager for the current list and to request a language you need.

