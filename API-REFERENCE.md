# API Reference — Kaltura Agentic Avatar

Every endpoint, the full agent lifecycle, and a verified use-case catalog — copy-paste ready.

**New here?** Start with [GETTING-STARTED.md](GETTING-STARTED.md). Runtime details live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The zero-dependency SDK is in [`README.md`](README.md).

**Credentials** — all examples need `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` ([Rich Media CMS → Settings → Integration Settings](https://kmc.kaltura.com/index.php/kmcng/settings/integrationSettings)). Set them in a local `.env` (copy `.env.example`) or pass inline. Never hardcode the secret.

---

## Contents

| Lifecycle | Reference & Catalog |
|-----------|---------------------|
| [Authentication](#authentication) | [Management Operations](#management-operations) |
| [The Five Services](#the-five-services) | [Common Errors](#common-errors) |
| [Phase 1 — Design](#phase-1--design) | [Use-Case Catalog](#use-case-catalog) |
| [Phase 2 — Build](#phase-2--build) | [UC-1 Agent Factory](#use-case-catalog) |
| [Phase 3 — Deploy (embed + runtime init)](#phase-3--deploy) | [UC-7 Interactive Video Avatar](#use-case-catalog) |
| [Phase 4 — Operate](#phase-4--operate) | [UC-12 Anonymous End-User Embed](#use-case-catalog) |
| [Quick Reference](#quick-reference) | [UC-13 Custom Portrait Avatar](#use-case-catalog) |

---

## Authentication

Every call requires a Kaltura Session (KS) token in the `Authorization` header.

**Mint an admin KS:**

```bash
KS=$(curl -s -X POST "https://www.kaltura.com/api_v3/service/session/action/start" \
  -d "format=1" \
  -d "secret=$AGENTIC_ADMIN_SECRET" \
  -d "partnerId=$AGENTIC_PARTNER_ID" \
  -d "type=2" \
  -d "expiry=86400" \
  -d "privileges=disableentitlement" | tr -d '"')
```

**Pass it on every call:** `Authorization: KS <token>`

| KS type | `privileges` | Use |
|---------|-------------|-----|
| Admin | `disableentitlement` | Management — create/update/delete (server-only) |
| Conversation | `geniegpcid:<configId>` | Talking to the AI — entitlement ON |
| Agent | `agentid:<agentId>` | Agent-scoped calls targeting a specific agent |
| Widget | auto-derived from `widgetId` | End-user embed — no admin secret in the browser |

`disableentitlement` is for admin operations only. Never pass it to a conversation or end-user session.

---

## The Five Services

An agent is built from five services that layer on top of each other. All calls use `POST` with JSON (`GET /assistant/status` is the one exception).

| Service | Role | Base URL |
|---------|------|----------|
| **Catalog** | Preset visuals and voices — the wardrobe | `api.avatar.us.kaltura.ai/v1/catalog-item/` |
| **Avatar** | Pairs a face with a voice — the character | `api.avatar.us.kaltura.ai/v1/avatar/` |
| **Knowledge** | Indexed content for RAG — the reference library | `genie.nvp1.ovp.kaltura.com/v1/knowledge/` |
| **Intellect** | AI brain config (prompts, tools, capabilities) — the personality | `genie.nvp1.ovp.kaltura.com/v1/intellect/` |
| **Agent** | Combines Avatar + Intellect — the deployed actor | `api.avatar.us.kaltura.ai/v1/agent/` |

Once deployed, the **conversation surface** (`/assistant/converse`, `/v1/thread/`, `/mcp/`) lives on `genie.nvp1.ovp.kaltura.com`. Utility endpoints (`/application/`) for widget resolution and runtime init are on `api.avatar.us.kaltura.ai`.

To embed a live avatar in a browser, go to [Phase 3 — Deploy](#phase-3--deploy) or jump straight to [UC-12 Anonymous End-User Embed](#use-case-catalog).

---

## Phase 1 — Design

### Browse the Catalog

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

**Visual preset fields:** `itemId`, `attributes.visual.{name, genderPresentation, skinTone, ageGroup, hairColor, clothing, background}`, `imageUrl`, `loadingVideo`.

**Voice preset fields:** `itemId`, `attributes.voice.{name, description, language}`, `voiceSampleUrl`.

Tool: `node tools/agentic.mjs catalog-list Visual` or `catalog-list Voice`.

---

### Generate an Agent Profile

```
POST https://api.avatar.us.kaltura.ai/v1/application/generateAgentProfile
```

```json
{ "userDescription": "A friendly technical support agent for a video platform" }
```

Returns `{goal, targetAudience, restrictedTopics, name, openingPhrase}` — pass directly to intellect configuration. Takes 2–3 s; result is not saved automatically.

---

### Upload a Custom Voice (clone)

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

### Import a Provider Voice by id (no audio upload)

Already have a voice on ElevenLabs or Cartesia? Create the catalog Voice item directly from its provider voice id:

```
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/createVoiceFromElevenLabs   {"voiceId":"<provider-voice-id>"}
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/createVoiceFromCartesia     {"voiceId":"<provider-voice-id>"}
```

An unknown provider id creates **nothing** and replies an HTTP-200 `KalturaAPIException` envelope (`VOICE_DOES_NOT_EXIST_ON_ELEVEN_LABS` / `VOICE_DOES_NOT_EXIST_ON_CARTESIA`) — the SDK maps these to typed `voice_not_found_elevenlabs` / `voice_not_found_cartesia` errors. SDK: `mgmt.catalog.importVoiceFromElevenLabs(voiceId, ks)` / `importVoiceFromCartesia(voiceId, ks)`.

---

### Upload a Custom Visual (portrait → animated avatar)

```
POST https://api.avatar.us.kaltura.ai/v1/catalog-item/create   (multipart/form-data)
```

```
file=@portrait.jpg
attributes={"visual":{"name":"My Portrait","genderPresentation":"Feminine","background":"Image","skinTone":"Light","ageGroup":"YoungAdult","hairColor":"Brown"}}
adminTags=custom
```

Returns a `CatalogItemDto` whose `itemId` is the catalog visual. Pass it as `visual.id` in `avatar/create` (or `visualId` in `provision`). The model **animates the portrait live at runtime** — no preprocessing, no ops involvement, self-serve. Verified: a real 2.4 MB portrait JPEG (`avatar-session/create` → `{success:true, sessionId}`).

**Required fields** (API 400s if any are missing): `name`, `genderPresentation`, `background`, `skinTone`, `ageGroup`, `hairColor`. The gap today is video-clip ingest (a short clip → a higher-fidelity avatar model) — not yet self-serve.

**Shell shortcut:** `node tools/agentic.mjs visual-upload <file.jpg> <name> <Masculine|Feminine> [skinTone] [ageGroup] [hairColor]`

**SDK shortcut:** `catalog.createVisual(imageBlob, { name, genderPresentation, background, skinTone, ageGroup, hairColor }, adminKs)` — returns `{ itemId, loadingVideo }` (raw API response — field names come from the CatalogItemDto and are not SDK-normalized; treat as best-effort until the API contract is pinned).

---

### End-to-end: custom portrait avatar, server to browser

No app demo ships a portrait-upload UI today — `apps/earnings-avatar-q2` reuses a
fixed CEO avatar already in the catalog rather than uploading a new one — but the
full path is exercised end-to-end by the SDK's own integration test
(`sdk/test/integration/avatars-catalog.test.js`) plus this recipe:

1. Server: `catalog.createVisual(portraitBlob, { name, genderPresentation, background, skinTone, ageGroup, hairColor }, adminKs)` → `{ itemId }`.
2. Server: `avatars.create({ voice: { id: voiceItemId }, visual: { id: itemId }, openingPhrase: '<blank>' }, adminKs)` → `agents.create` → `application.resolveWidgetId`.
3. Browser: `sessions.createWidgetToken({ widgetId })` → `application.appInit(widgetKs)` → `new KalturaAvatarSession({ token: init.ks, conversationManagerUrl: init.conversationManagerUrl, srsBaseUrl: init.srsBaseUrl, turnServerUrl: init.turnServerUrl, videoEl })`. No admin secret ever reaches the browser — see `apps/earnings-avatar-q2/public/avatar-session.js` for this exact widget-KS pattern (steps happen against a fixed avatar there, but the session-construction code is identical for a freshly-uploaded portrait).
4. The portrait avatar animates live in `videoEl`; type or speak to it and it replies in the portrait's face with the chosen voice.

---

## Phase 2 — Build

### Create an Intellect

```
POST https://genie.nvp1.ovp.kaltura.com/v1/intellect/add
```

```json
{ "type": "internal", "status": 2 }
```

Returns the full intellect DTO. **Save `id`** — this is your `configId`.

| `status` | Meaning |
|----------|---------|
| `2` | ACTIVE |
| `1` | PENDING |
| `0` | FOR_DELETION |

---

### Configure an Intellect

```
POST https://genie.nvp1.ovp.kaltura.com/v1/intellect/update
```

```json
{
  "id": 1389,
  "type": "internal",
  "status": 2,
  "prompts": [
    {
      "key": "goal",
      "label": "Goal",
      "headerTemplate": "Your core strategic goal:",
      "type": "custom",
      "value": "Help users troubleshoot video streaming issues"
    }
  ],
  "base_directive": "You are StreamBot. Be concise and technically accurate.",
  "capabilities": {
    "avatar": "on",
    "generate_followup_questions": "on",
    "use_knowledge_base": "off"
  }
}
```

**Prompts** — each block composes a system-prompt section:

| Field | Purpose |
|-------|---------|
| `key` | Any string — labels the block. Common: `goal`, `targetAudience`, `restrictedTopics`, `name` |
| `headerTemplate` | Prepended before the value in the system prompt |
| `type` | Always `"custom"` |
| `value` | Your content |

**Top-level fields:**

| Field | Purpose |
|-------|---------|
| `base_directive` | Global system instruction |
| `glossary` | Domain terms (e.g. `"HLS: HTTP Live Streaming"`) |
| `capabilities` | Enable/disable features — see table below |
| `allow_client_variables` | Allow `{{vars}}` injection per request |
| `knowledge_ids` | Knowledge record IDs for RAG — create with `POST /v1/knowledge/add` |
| `name` / `description` / `tags` | Labels for organizing intellects |
| `tools` | LLM-callable tools — see [§ Tools](#tools-api--csv--code) |
| `secrets` | Named secrets for tool OAuth (write-only, masked on read) |
| `user_properties_forms` | Lead-capture form fields |

**Capabilities** — each is `"on"` / `"off"` / `"disabled"`:

| Key | Default | What it does |
|-----|---------|-------------|
| `avatar` | OFF | Enable avatar video conversation |
| `avatar_filler` | OFF | Avatar speaks filler while thinking |
| `generate_followup_questions` | ON | Suggest next questions |
| `use_knowledge_base` | ON | RAG over the linked knowledge base |
| `use_content_search` | ON | Search media entry metadata |
| `use_get_entry_content` | ON | Read full entry transcripts |
| `use_related_files` | ON | Access document attachments |
| `use_web_search` | OFF | Live external web search |
| `include_sources` | ON | Cite sources |
| `video_gallery` | OFF | Show a gallery of clips |
| `external_video` | OFF | Embed external video |
| `show_link` | OFF | Render link cards |
| `kaltura_genie_experiences` | ON | Enable structured GenUI experiences |
| `screen_share_analysis` | OFF | Analyze a shared screen |
| `avatar_show_content` | OFF | Enable in-avatar content display |

> `capabilities` is a **full-replace** sub-dict. To change one key, read the current dict first and re-send it with your overlay. The SDK handles this automatically via `mgmt.intellects.setCapability`.

`force_experience` (a hint for default rendering): `"markdown"`, `"summarization"`, `"flashcards"`, `"avatar_only"`. Not a guarantee.

---

### Tools (api / csv / code)

Tools are a standalone, PARTNER-LEVEL entity with their own CRUD (`/v1/tool/add|get|list|update|delete`,
Genie host) — **not** embedded in an intellect. An intellect only carries the `tool_ids` (an array
of tool uuid strings) it may call. **SDK:** `import { tools } from '@kaltura/intelligent-agents/management'`
builds and validates a tool's `config` before any network call; `mgmt.tools` is the CRUD surface;
`mgmt.intellectConfig.setToolIds` (or `tool_ids` passed straight to `intellects.create`/`update`)
links a tool to an intellect.

**`api` tool** — calls an external HTTP endpoint. `POST /v1/tool/add`:

```json
{
  "name": "order_status",
  "config": {
    "type": "api",
    "description": "Look up an order by id",
    "args": { "order_id": { "prompt": "the order number", "type": "str", "required": true } },
    "request": {
      "url": "https://api.example.com/order",
      "method": "GET",
      "timeout": 10,
      "authentication": {
        "type": "oauth2",
        "client_id": "id",
        "client_secret": "secrets.OAUTH_CLIENT_SECRET",
        "token_url": "https://api.example.com/token"
      }
    },
    "response_mapping": { "status": "order.status" }
  }
}
```

Returns a `Tool` — `{id, name, config, partner_id, created_at, updated_at}`. Link its `id` into an
intellect:

```json
{ "id": 42, "type": "internal", "status": 2, "tool_ids": ["<the returned id>"] }
```

sent to `POST /v1/intellect/update`.

`response_mapping`, `response_template`, and `response_chapters` are mutually exclusive. Reference secrets as `"secrets.NAME"` — never plaintext.

**`csv` tool** — inline lookup table:

```json
{ "name": "tier_lookup", "config": { "type": "csv", "description": "Map account to tier", "csv": "account,tier\n42,gold" } }
```

**`code` tool** — Python in a server sandbox:

```json
{ "name": "fx_rate", "config": { "type": "code", "description": "Convert currency", "code": "def main(request_config):\n    return 'ok'" } }
```

**`client` tool** — a native function-calling tool that makes NO server-side call at all. The model calls it, the backend emits a silent `type:"tool"` segment (see [WIRE-PROTOCOL.md](docs/WIRE-PROTOCOL.md)), and that's the entire contract — no `request` block, no echo endpoint, no response shaper:

```json
{
  "name": "navigate_to_slide",
  "config": {
    "type": "client",
    "description": "Navigate the on-screen deck. Call whenever the user asks about a topic the deck covers.",
    "args": { "slide_num": { "prompt": "The slide number to show (1-N).", "type": "int", "required": true } },
    "wait_for_response": false
  }
}
```

`wait_for_response` (SDK: `waitForResponse`) controls whether the model's turn blocks on a real client ACK. **Omitting it is not the same as `false`** — the backend's own wire default for an absent field is `true` (blocking); pass `false` explicitly for fire-and-forget dispatch. When `true`, the backend polls up to `timeout` seconds (default 30) for an ACK via `POST /assistant/tool_response` (SDK: `session.respondToTool(id, response)`).

**Client-tool gotcha** — a requirement that must be met at authoring time for ANY tool-referencing intellect (client, api, csv, or code): **`kaltura_genie_experiences` must be `'off'` at creation.** The experiences capability injects a system rule that out-competes custom tool calls. Set it to `'off'` when you call `intellect/add` — partner config is cached ~24 h server-side, so updating it later has no immediate effect.

Use `tools.client(...)` in the SDK, which validates the tool before any network call; `clientToolReadiness(body)` lints an intellect body's `tool_ids` + `capabilities` for this gotcha.

---

### Secrets (write-only)

`secrets` is a dict `{name: value}` on `config`. A read masks every value as `"***"`. A `"***"` value on update is preserved server-side — read-modify-write never clobbers a sibling. Reference as `"secrets.NAME"` in tool configs or `{{secrets.NAME}}` in prompts.

**SDK:** `mgmt.intellects.secrets.{listNames, set, remove, replaceAll, validate}`.

---

### Ground the Agent in Your Content (RAG)

**Step 1 — Create a knowledge record:**

```
POST https://genie.nvp1.ovp.kaltura.com/v1/knowledge/add
```

```json
{ "name": "Product Documentation" }
```

Returns `{ "id": 42, ... }`. Save the `id`.

**Step 2 — Link it to the intellect (at create or update):**

```json
{
  "id": 1389,
  "knowledge_ids": [42],
  "capabilities": { "use_knowledge_base": "on" }
}
```

Writes through the intellect DTO — no `partner-config/update`, no 403. RAG retrieval works after async indexing (~1 minute).

**Step 3 — Upload content** via `knowledge.uploadDocument()` (SDK) or the Kaltura OVP media ingest APIs.

| Modality | Source |
|----------|--------|
| `caption` | Video captions (SRT) |
| `ocr` | On-screen text |
| `document` | PDF / Markdown attachments |

**SDK:** `knowledge.addRecord()` + `knowledge.uploadDocument()` + `intellectConfig.setKnowledgeIds()` (Path A, verified live). Re-pointing an EXISTING intellect via the `partner-config/update` path (Path B — `knowledge.linkRecords()`, probed first with `knowledge.linkAvailable()`) is still gated (403s for a partner admin KS today) — prefer Path A for new agents; only reach for Path B if the intellect already exists and you can't recreate it. `knowledge.indexStatus(ks)` reads indexing progress (`partner-config/stats`, unaffected by the write gate — a read, like `getBrainConfig` in § Configure the Brain).

---

### Create an Avatar

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

`voice.id` and `visual.id` come from the catalog (§ Browse the Catalog). Returns `id` (24-char hex). **No `adminTags`** — avatars reject unknown fields. Tag the parent agent instead.

---

### Create an Agent

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
| `intellect.intellectType` | Always `"genie"` |
| `intellect.id` | The intellect's configId, from intellect create — passed straight in, no discovery step |
| `avatarIds` | Optional — omit for a headless text-only agent |
| `maxConversationLength` | Seconds. Default 540, range 1–3600 |
| `widgetConfig.initialPage.title` | Max 30 chars |

Returns `agentId` (UUID). **Save this.**

---

### Configure the Brain (deployment-gated)

> `partner-config/update` access will be removed for non-superadmin partners. Don't build production workflows on it.

The brain-model and rate-limit fields (`agent_llm`, `agent_fast_llm`, rate limits, and the best-effort `agent_avatar_llm`/`run_quota_check`/`web_search_config`) are **not in the intellect DTO** — `intellect/get`/`intellect/update` never expose or accept them. The only door is Genie's `partner-config/*` route family, split across three operations with different availability:

| Operation | Route | KS | Works on a partner admin KS today? |
|---|---|---|---|
| Read the brain config | `partner-config/get` | admin | **Yes** — a plain read, no gate |
| Probe write availability | `partner-config/get` (id:0) | admin | **Yes** — same read, used as a liveness check |
| Write the brain config | `partner-config/update` | admin | **No** — 403s; needs a higher/service privilege |

**Step 1 — probe before writing:**

```js
const probe = await mgmt.intellects.brainConfigAvailable(ks);
// { available: false, code: 'forbidden', reason: 'partner-config/update needs a higher privilege than a partner admin KS (deployment-gated)' }
```

**Step 2 — write (only if `available:true`; otherwise skip and treat as read-only):**

```js
const result = await mgmt.intellects.setBrainConfig(configId, {
  agentLlm: 'us.anthropic.claude-sonnet-5',
  rateLimits: { perMinute: 60, perHour: 1000 },
}, ks);
// { applied:false, code:'forbidden', reason:'...' } when gated — NEVER throws or fakes success.
// { applied:true, sentKeys:[...], result } when the door is open.
```

**Step 3 — read back what's actually persisted** (`setBrainConfig`'s `applied`/`sentKeys` list what was *sent*, not confirmed *persisted* — the Class-B subset `agent_avatar_llm`/`run_quota_check`/`web_search_config` is unverified to round-trip):

```js
const { brainConfig, unsetUseDefault } = await mgmt.intellects.getBrainConfig(configId, ks);
```

**SDK:** `mgmt.intellects.{brainConfigAvailable, setBrainConfig, getBrainConfig}`. `brainConfigAvailable`/`setBrainConfig` share a classifier with `knowledge.linkAvailable`/`linkRecords` (§ Ground the Agent Path B) — both probe the same `partner-config/*` door.

**Why the SDK still ships this** given the write is gated and slated for removal: the reads are live and useful today (`getBrainConfig` is the only way to see `agent_llm`/rate limits at all — the intellect DTO doesn't carry them), and until the route is actually removed, `setBrainConfig` is the only client-side path to those fields for a deployment where it *is* open (e.g. a superadmin-provisioned partner). The probe-first design means a caller never gets a false success — a closed door returns `{applied:false, reason}`, never a silent no-op or a thrown 403.

---

## Phase 3 — Deploy

### Resolve Widget ID

```
POST https://api.avatar.us.kaltura.ai/v1/application/resolveWidgetId
```

```json
{ "agentId": "33b7c8b7-f67b-4ca3-b853-0f7ced06a6a3" }
```

Returns `{ "widgetId": "1_v1mj1kxb" }`. Idempotent.

---

### Initialize the Runtime

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
| `avatars[]` | `[{id, previewImageUrl, loadingVideoUrl}]` |

The admin secret never touches the browser — `appInit` derives the agent from the widget KS.

---

## Phase 4 — Operate

### Converse

```
POST https://genie.nvp1.ovp.kaltura.com/assistant/converse
```

Requires a conversation KS:

```bash
CONV_KS=$(curl -s -X POST "https://www.kaltura.com/api_v3/service/session/action/start" \
  -d "format=1" -d "secret=$AGENTIC_ADMIN_SECRET" \
  -d "partnerId=$AGENTIC_PARTNER_ID" -d "type=2" -d "expiry=86400" \
  -d "privileges=geniegpcid:1389" | tr -d '"')
```

```json
{
  "userMessage": "How do I fix video buffering?",
  "threadId": null,
  "sse": false
}
```

| Field | Notes |
|-------|-------|
| `userMessage` | Required |
| `threadId` | Omit for new conversation; pass previous value for memory |
| `sse` | `false` = NDJSON (default); `true` = SSE |
| `model_type` | `"fast"` for cheaper/faster model |
| `force_experience` | Hint only — not a guarantee |
| `request_vars` | Per-message `{{var}}` interpolation; needs `allow_client_variables:true` on the intellect |
| `capabilities` | Per-message capability override |

**Stream segments** (each line is a JSON object):

| `type` | Meaning |
|--------|---------|
| `"think"` | Processing (show spinner) |
| `"text"` | Response content — concatenate `content` fields |
| `"tool"` / `"tool_response"` | Server tool call + result; `content` carries client commands |
| `"unisphere-tool"` | GenUI widget — `metadata.runtimeName` names the widget |
| `"error"` | Brain error |
| `"user-interruption"` | User barged in |

Key envelope fields: `threadId` (save for follow-ups), `messageId` (save for feedback), `isFinal:true` (stream done).

**Abort a running turn:**

```
POST https://genie.nvp1.ovp.kaltura.com/assistant/abort
{ "threadId": "154a05c4-..." }
```

---

### Check Status

```
GET https://genie.nvp1.ovp.kaltura.com/assistant/status
```

Returns `{aiConsent, avatar, identifiedUser}`. `avatar` is non-null when the agent has an avatar configured.

---

### Threads

All thread endpoints require an **admin KS** (`disableentitlement`). Pager: `{"pageIndex":1,"pageSize":30}`.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST .../v1/thread/list` | `{"filter":{"objectType":"ListThreadFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST .../v1/thread/get` | `{"id":"UUID"}` |
| Rename | `POST .../v1/thread/update` | `{"id":"UUID","title":"New name"}` |
| Delete | `POST .../v1/thread/delete` | `{"thread_ids":["UUID"]}` |
| Transcript | `POST .../v1/thread/get_transcripts` | `{"id":"UUID"}` |

`...` = `https://genie.nvp1.ovp.kaltura.com`

**Thread list response** fields per object: `id`, `title`, `created_at`, `updated_at`, `status`.

**Transcript response:** `{"status":"success","data":"human: …\nai: …"}` — plain text, one turn per line.

**Delete** returns `{totalCount, objects[]}` (soft delete — data is retained server-side; this is a known GDPR Art. 17 gap).

Tool: `node tools/genie.mjs thread-list | thread-get | thread-rename | thread-delete | thread-transcripts`.

---

### Feedback and Follow-ups (SDK)

Feedback and follow-up suggestions route through internal Genie paths — use the SDK rather than calling them directly.

- `mgmt.feedback.add({message_id, is_positive, comment?}, convKs)` — thumbs up/down on a message. `message_id` comes from the converse stream.
- `mgmt.followups.getSuggested(ks)` — pre-configured starter questions. Per-answer follow-ups stream inline as `unisphere-tool` segments when `capabilities.generate_followup_questions:"on"`.

Shell tools (`node tools/genie.mjs feedback-add`, `node tools/genie.mjs followup-get`) call these paths for debugging only.

---

### Usage Analytics

Partner-scoped read-only CSV — contains end-user IDs and verbatim questions (treat as PII).

Tool: `node tools/genie.mjs report` (raw CSV) · `node tools/genie.mjs report-summary` (volume + feedback ratio + top questions, with `_meta` provenance receipt).  
SDK: `mgmt.messages.report(ks)` / `mgmt.messages.reportSummary(ks)`.  
Example: `node tools/genie.mjs report-summary`.

---

### Knowledge Search (MCP)

**Official spec:** documented internally as `openapi-search-external.yaml` in the Genie brain backend's spec directory.

```
POST https://genie.nvp1.ovp.kaltura.com/mcp/search
{ "query": "adaptive bitrate streaming" }
```

Returns `{status, data}`. A partner with no indexed content returns a `"couldn't find relevant information"` error response. Tool: `node tools/genie.mjs mcp-search <query>`.

---

## Management Operations

All use the **admin KS**.

### Agents — `https://api.avatar.us.kaltura.ai`

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/agent/list` | `{"filter":{},"pager":{"offset":0,"limit":30}}` |
| Get | `POST /v1/agent/get` | `{"agentId":"UUID"}` |
| Embed snippet | `POST /v1/agent/getEmbedScript` | `{"agentId":"UUID","embedType":"contained\|page\|floater"}` |
| Update | `POST /v1/agent/update` | `{"agentId":"UUID", ...fields}` |
| Delete | `POST /v1/agent/delete` | `{"agentId":"UUID"}` |

`agent/list` has no server-side filtering — always send `"filter":{}` and filter client-side.

`agent/getEmbedScript` replies `{"objectType":"Object","html":"<script…>"}` — a ready-to-paste `<script type='module'>` snippet that loads the Unisphere embeds loader and renders the agent's chat widget (`apis.genieChat.<embedType>(…)`). `embedType` is a closed enum; anything else 400s. SDK: `mgmt.agents.getEmbedScript(agentId, embedType, ks)` unwraps to the html string.

### Avatars — `https://api.avatar.us.kaltura.ai`

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/avatar/list` | `{"pager":{"offset":0,"limit":30}}` |
| Get | `POST /v1/avatar/get` | `{"id":"24-char-hex"}` |
| Update | `POST /v1/avatar/update` | `{"id":"24-char-hex", ...fields}` |
| Clone | `POST /v1/avatar/clone` | `{"id":"24-char-hex"}` |
| Delete | `POST /v1/avatar/delete` | `{"id":"24-char-hex"}` |

### Intellects — `https://genie.nvp1.ovp.kaltura.com`

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/intellect/list` | `{"filter":{},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/intellect/get` | `{"id":1389}` |
| Update | `POST /v1/intellect/update` | See § Configure an Intellect |
| Delete | `POST /v1/intellect/delete` | `{"id":1389}` |

Deleting an agent does **not** delete its avatar or intellect.

### Tools — `https://genie.nvp1.ovp.kaltura.com`

A standalone, partner-level entity (see § Tools above) — not embedded in an intellect.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/tool/list` | `{"filter":{"objectType":"ToolListFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/tool/get` | `{"id":"TOOL_UUID"}` |
| Add | `POST /v1/tool/add` | `{"name":"...", "config":{...}}` |
| Update | `POST /v1/tool/update` | `{"id":"TOOL_UUID", "name"?, "config"?}` |
| Delete | `POST /v1/tool/delete` | `{"id":"TOOL_UUID"}` |

Deleting a Tool does **not** cascade — an intellect that still lists the id in `tool_ids` keeps a dangling reference; drop it first via `mgmt.intellectConfig.setToolIds`.

### Skills — `https://genie.nvp1.ovp.kaltura.com`

A standalone, partner-level reusable-instruction entity — `{id (uuid), name, description, instructions}`. All four operations verified live; there is **no `skill/update`** on the current deployment (recreate to change). SDK: `mgmt.skills`.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/skill/list` | `{"filter":{"objectType":"SkillListFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/skill/get` | `{"id":"SKILL_UUID"}` |
| Add | `POST /v1/skill/add` | `{"name":"...", "description":"...", "instructions"?}` |
| Delete | `POST /v1/skill/delete` | `{"id":"SKILL_UUID"}` — replies `{id}`; a follow-up get 404s |

### Knowledge records — `https://genie.nvp1.ovp.kaltura.com`

Full record lifecycle (all verified live). SDK: `mgmt.knowledge`. Linkage to an intellect is via `knowledge_ids` (Path A — see § Ground the Agent).

| Operation | Endpoint | Body |
|-----------|----------|------|
| Add | `POST /v1/knowledge/add` | `{"name":"..."}` |
| Get | `POST /v1/knowledge/get` | `{"id":2049}` |
| Update | `POST /v1/knowledge/update` | `{"id":2049, ...fields}` |
| Delete | `POST /v1/knowledge/delete` | `{"id":2049}` — HTTP 200, body `null`; a follow-up get 404s |

Deleting a record does **not** unlink it — an intellect's `knowledge_ids` keeps the dangling id; clear it via `mgmt.intellectConfig.setKnowledgeIds(configId, [], ks)`.

---

## Common Errors

| Status | Code / Detail | Fix |
|--------|--------------|-----|
| 400 | `bad_request` | Malformed JSON or missing field |
| 403 | Forbidden | Wrong KS type — admin KS for management, `geniegpcid` for conversations |
| 400 | `AGENT_NOT_FOUND` | Check the `agentId` |
| 400 | `AGENT_PARTNER_CONFIG_NOT_FOUND` | Create the intellect first |
| 405 | Method Not Allowed | Use `GET` for `/assistant/status`; everything else is `POST` |

---

## Use-Case Catalog

Each use case maps to a CLI tool command or a reference app. UC-1 has a quickstart script; UC-9 uses the CLI tool directly; UC-12/13 use the browser apps noted in the Script column.

| # | Use case | Key mechanism | Script / Tool |
|---|----------|--------------|--------|
| UC-1 | **Agent Factory** | `generateAgentProfile` → `intellect/add` → configure → `avatar/create` → `agent/create` → `resolveWidgetId` | `node quickstart/create-agent.mjs "Your brief"` |
| UC-2 | **Personalized Concierge** | Prompts with `{{firstName}}`/`{{plan}}` + `allow_client_variables:true`; pass `request_vars` per message | `node tools/genie.mjs converse-pretty` with `request_vars` |
| UC-3 | **Memory Chatbot** | First `converse` returns `threadId`; pass it back. `v1/thread/get_transcripts` for the full record | `node tools/genie.mjs converse-pretty` + `thread-list` |
| UC-4 | **GenUI Experiences** | `force_experience` hint + `capabilities`; render `unisphere-tool` segments by `metadata.runtimeName` | `node tools/genie.mjs converse-pretty` |
| UC-5 | **Avatar Fleet / A-B Personas** | `avatar/create` variants, `avatar/clone` to fork, `agent/update avatarIds` to swap | `node tools/agentic.mjs avatar-clone` |
| UC-6 | **Quality / Feedback Loop** | Capture `messageId` from converse → `mgmt.feedback.add()` → `report-summary` | `node tools/genie.mjs feedback-add` + `report-summary` |
| UC-7 | **Interactive Video Avatar** | `resolveWidgetId` → widget KS → `appInit` → socket.io + WHEP runtime | `apps/earnings-avatar-q2/public/avatar-session.js` |
| UC-8 | **Headless Streaming Text** | `assistant/converse` (`sse:true` or NDJSON); stream `type:"text"` chunks; persist `threadId` server-side | `node tools/genie.mjs converse-pretty` |
| UC-9 | **Custom Voice Clone** | `catalog-item/create` (multipart, `~6 s+` audio) → `itemId` → `avatar/create voice.id` | `node tools/agentic.mjs voice-upload` |
| UC-10 | **Slide-Deck Walkthrough** | Deck talking points in prompts; deterministic `navigate_to_slide` client-command tool call for nav; optional GenUI widget via `show_widget` | `apps/earnings-avatar-q2/` (full reference) |
| UC-11 | **Usage Analytics** | `node tools/genie.mjs report-summary` → CSV aggregated client-side; includes `_meta` provenance receipt | `node tools/genie.mjs report-summary` |
| UC-12 | **Anonymous End-User Embed** | `resolveWidgetId` once (server) → `sessions.createWidgetToken` (browser, no secret) → `appInit` → enriched KS | `apps/earnings-avatar-q2/public/avatar-session.js` |
| UC-13 | **Custom Portrait Avatar** | `catalog-item/create` with portrait JPEG → `catalogItemId` → `avatar/create visual.id` → `appInit` → `KalturaAvatarSession` connects with the portrait animating live | § End-to-end recipe above + `sdk/test/integration/avatars-catalog.test.js` |

### Composition patterns

| Pattern | Built from |
|---------|-----------|
| Knowledge-grounded support bot | UC-3 + `capabilities.use_knowledge_base:on` + § Ground the Agent |
| Multi-brand personas | UC-5 (voice) + UC-2 (`{{locale}}` var) |
| Lead-capture avatar | UC-7 + `user_properties_forms` |
| Scheduled / proactive avatar | UC-7 + your scheduler calls `speak()` on the socket |

---

## Quick Reference

```bash
node tools/agentic.mjs help
node tools/genie.mjs help
node tools/agentic.mjs agent-list  | python3 -m json.tool
node tools/genie.mjs  intellect-list | python3 -m json.tool
```
