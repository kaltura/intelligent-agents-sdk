# API Reference — Kaltura Agentic Avatars

Every endpoint, the full agent lifecycle, and a verified use-case catalog — copy-paste ready.

**New here?** Start with [GETTING-STARTED.md](GETTING-STARTED.md). Runtime details live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The zero-dependency SDK is in [`README.md`](README.md).

**Credentials** — all examples need `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` ([Rich Media CMS → Settings → Integration Settings](https://kmc.kaltura.com/index.php/kmcng/settings/integrationSettings)). Set them in a local `.env` (copy `.env.example`) or pass inline. Never hardcode the secret.

Every endpoint below is shown as a raw HTTP call plus its SDK wrapper. The SDK is what ships in
this repo — see [`README.md`](README.md) for the full `Management` method list.

---

## Contents

| Lifecycle | Reference & Catalog |
|-----------|---------------------|
| [Authentication](#authentication) | [Management Operations](#management-operations) |
| [The Five Services](#the-five-services) | [Common Errors](#common-errors) |
| [Phase 1 — Design](#phase-1--design) | [Use-Case Catalog](docs/USE-CASES.md) (13 use cases, UC-1 through UC-13) |
| [Phase 2 — Build](#phase-2--build) | [Quick Reference](#quick-reference) |
| [Phase 3 — Deploy (embed + runtime init)](#phase-3--deploy) | |
| [Phase 4 — Operate](#phase-4--operate) | |
| [Scripted-Video (STV-only) Sessions](#scripted-video-stv-only-sessions) | |

---

**What can you build?** A concierge with memory (UC-2/UC-3), a GenUI-driven product demo (UC-4),
a slide-deck walkthrough avatar (UC-10), a self-serve custom-voice/custom-portrait agent
(UC-9/UC-13), an anonymous embeddable widget (UC-12), or a fleet of A/B-tested personas (UC-5) —
see the full [Use-Case Catalog](docs/USE-CASES.md) for all 13, each mapped to its key mechanism
and a runnable script/tool.

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

To embed a live avatar in a browser, go to [Phase 3 — Deploy](#phase-3--deploy) or jump straight to [UC-12 Anonymous End-User Embed](docs/USE-CASES.md).

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

**Visual preset fields:** `itemId`, `attributes.visual.{name, genderPresentation, skinTone, ageGroup, hairColor, clothing, background}`, `imageUrl`, `loadingVideo` — raw backend asset URLs (an upload echo for a custom visual, a preset asset URL for a catalog item), not the rendered composite the live WHEP stream shows.

**Voice preset fields:** `itemId`, `attributes.voice.{name, description, language}`, `voiceSampleUrl`.

SDK: `mgmt.catalog.list(ks, { type: 'Visual' })` or `{ type: 'Voice' }`.

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

Returns a `CatalogItemDto` whose `itemId` is the catalog visual. Pass it as `visual.id` in `avatar/create` (or `visualId` in `provision`). The model **animates the portrait live at runtime** — no ops involvement, self-serve. Verified: a real 2.4 MB portrait JPEG (`avatar-session/create` → `{success:true, sessionId}`).

The backend does preprocess the uploaded image before rendering: it crop-fits the source to a fixed face-height-to-frame ratio and centers it on the render canvas. A tight "headshot"-style crop — the intuitive upload — is the worst case: the bigger the face already fills the source frame, the more the backend downscales it to hit that ratio, and the bigger the resulting black borders around the rendered avatar. One confirmed case: padding the source out to roughly 2600×2600 (face occupying a small fraction of the frame) produced an edge-to-edge render with no borders. This is an observed data point from one real upload, not a documented API contract — the exact ratio isn't published, so pad generously and check the result in a live session rather than assuming this number is precise.

**Required fields** (API 400s if any are missing): `name`, `genderPresentation`, `background`, `skinTone`, `ageGroup`, `hairColor`. The gap today is video-clip ingest (a short clip → a higher-fidelity avatar model) — not yet self-serve.

**SDK shortcut:** `catalog.createVisual(imageBlob, { name, genderPresentation, background, skinTone, ageGroup, hairColor }, adminKs)` — returns `{ itemId, loadingVideo }` (raw API response — field names come from the CatalogItemDto and are not SDK-normalized; treat as best-effort until the API contract is pinned).

---

### End-to-end: custom portrait avatar, server to browser

The full path is exercised end-to-end by the SDK's own integration test
(`test/integration/avatars-catalog.test.js`) plus this recipe:

1. Server: `catalog.createVisual(portraitBlob, { name, genderPresentation, background, skinTone, ageGroup, hairColor }, adminKs)` → `{ itemId }`.
2. Server: `avatars.create({ voice: { id: voiceItemId }, visual: { id: itemId }, openingPhrase: '<blank>' }, adminKs)` → `agents.create` → `application.resolveWidgetId`.
3. Browser: `sessions.createWidgetToken({ widgetId })` → `application.appInit(widgetKs)` → `new KalturaAvatarSession({ token: init.ks, conversationManagerUrl: init.conversationManagerUrl, srsBaseUrl: init.srsBaseUrl, turnServerUrl: init.turnServerUrl, videoEl })`. No admin secret ever reaches the browser.
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
| `tool_ids` | Tool entity uuid references — create/list the entities themselves via [§ Tools](#tools-api--csv--code) (`mgmt.tools`), then link the ids here via `intellectConfig.setToolIds` |
| `skill_ids` | Skill entity uuid references — partner-level reusable-instruction CRUD at `mgmt.skills`, linked via `intellectConfig.setSkillIds` |
| `mcp_servers` | MCP server configs the intellect can call — set via `intellectConfig.setMcpServers` (see `README.md`) |
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

**Security note:** an `api` tool's `request` fires server-to-server, outside the SDK's reach. The model/system-prompt scoping that led to the call is not a security boundary — your endpoint must independently authenticate and authorize each request (validate the caller's Kaltura Session and permissions), the same way you would for any other server-to-server API call. Treat interpolated `request_vars` (client-suppliable when `allow_client_variables:true` — see [Converse](#converse)) as untrusted input, never as an authorization claim.

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

**SDK:** `knowledge.addRecord()` + `knowledge.uploadDocument()` + `intellectConfig.setKnowledgeIds()` (Path A, verified live). Re-pointing an EXISTING intellect via the `partner-config/update` path (Path B — `knowledge.linkRecords()`, probed first with `knowledge.linkAvailable()`) is still gated (403s for a partner admin KS today) — prefer Path A for new agents; only reach for Path B if the intellect already exists and you can't recreate it.

**Checking whether indexing has finished:** use `knowledge.isIndexed(id, ks)` — reads `knowledge.getRecord(id, ks).status`, returning `{ready, status, indexPosition}`. Don't use `knowledge.search()` for this — its "couldn't find relevant information" reply fires for an unindexed KB, an indexed KB with `use_knowledge_base:'off'`, or a genuine no-match query alike, so it can't signal indexing status. `knowledge.corpusStatus()` only counts entries that exist in the category, not whether they've finished embedding. `knowledge.indexStatus()` (`partner-config/stats`) 403s for a partner admin KS on at least one deployment — the same privilege wall as the Path B write.

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

Brain-model and rate-limit fields are **not in the intellect DTO** — `intellect/get`/`intellect/update` never expose or accept them. The only door is Genie's `partner-config/*` route family:

| Class | Fields | Round-trip verified? |
|---|---|---|
| Class A | `agent_llm`, `agent_fast_llm`, rate limits | Yes |
| Class B (best-effort) | `agent_avatar_llm`, `run_quota_check`, `web_search_config` | No — sendable via `setBrainConfig`, but unverified to persist |

`partner-config/*` splits across three operations with different availability:

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
  agentLlm: '<your-agent-llm-id>',
  rateLimits: { perMinute: 60, perHour: 1000 },
}, ks);
// { applied:false, code:'forbidden', reason:'...' } when gated — NEVER throws or fakes success.
// { applied:true, sentKeys:[...], result } when the door is open.
```

**Step 3 — read back what's actually persisted** (`setBrainConfig`'s `applied`/`sentKeys` list what was *sent*, not confirmed *persisted* — see the Class B row above):

```js
const { brainConfig, unsetUseDefault } = await mgmt.intellects.getBrainConfig(configId, ks);
```

**SDK:** `mgmt.intellects.{brainConfigAvailable, setBrainConfig, getBrainConfig}`. `brainConfigAvailable`/`setBrainConfig` share a classifier with `knowledge.linkAvailable`/`linkRecords` (§ Ground the Agent Path B) — both probe the same `partner-config/*` door.

**Status of each part, despite the write being gated and slated for removal:**

| Part | Status |
|---|---|
| `getBrainConfig` (read) | Live — the only way to see `agent_llm`/rate limits; the intellect DTO doesn't carry them |
| `setBrainConfig` (write) | Client-side path to those fields where the door is open (e.g. a superadmin-provisioned partner); returns `{applied:false, reason}` rather than a silent no-op or a thrown 403 when it's closed |

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
| `avatars[]` | `[{id, previewImageUrl, loadingVideoUrl}]` — raw backend asset URLs (an upload echo for a custom visual, a preset asset URL for a catalog item), not the rendered composite the live WHEP stream shows |

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

**Delete** returns `{totalCount, objects[]}` — a soft delete; data is retained server-side.

SDK: `mgmt.threads.{list, get, rename, delete, transcript}`.

> **Compliance note.** `threads.delete()` is not a full GDPR Art. 17 erasure — retention past
> a soft delete is a server-side, operator-owned control. See
> [SECURITY.md](SECURITY.md#shared-responsibility-control-matrix-nist-800-53) for what the SDK
> provides versus what the operator must configure.

---

### Feedback and Follow-ups (SDK)

Feedback and follow-up suggestions route through internal Genie paths — use the SDK rather than calling them directly.

- `mgmt.feedback.add({message_id, is_positive, comment?}, convKs)` — thumbs up/down on a message. `message_id` comes from the converse stream.
- `mgmt.followups.getSuggested(ks)` — pre-configured starter questions. Per-answer follow-ups stream inline as `unisphere-tool` segments when `capabilities.generate_followup_questions:"on"`.

---

### Usage Analytics

Partner-scoped read-only CSV — contains end-user IDs and verbatim questions (treat as PII).

SDK: `mgmt.messages.report(ks)` (raw CSV) / `mgmt.messages.reportSummary(ks)` (volume + feedback ratio + top questions, with a `_meta` provenance receipt).

---

### Knowledge Search (MCP)

```
POST https://genie.nvp1.ovp.kaltura.com/mcp/search
{ "query": "adaptive bitrate streaming" }
```

Returns `{status, data}`. A partner with no indexed content returns a `"couldn't find relevant information"` error response. SDK: `mgmt.knowledge.search(query, ks)`.

---

## Scripted-Video (STV-only) Sessions

A second, INDEPENDENT session type — `https://api.avatar.us.kaltura.ai/v1/avatar-session/*` — that
sits next to, not on top of, everything in Phases 1–4 above. No LLM, no ASR, no socket.io: REST +
WHEP only. The avatar speaks exactly the audio you hand it, in the order you hand it. Use this when
YOU are the script (IVR-style flows, pre-recorded/TTS'd announcements, kiosk greetings) rather than
the conversational brain. SDK: `mgmt.avatarSessions` (management) +
`KalturaScriptedVideoSession` (experience, browser-side playback).

**Two-stage auth (verified live)** — this is the one surface on the whole agentic host that
switches auth schemes mid-flow:

| Call | Auth |
|------|------|
| `create` | `Authorization: KS <admin-ks>` — your normal admin token |
| every call after `create` | `Authorization: Bearer <session-token>` — the JWT `create` returns, NOT a KS |

The Bearer token is valid roughly 24h (decoded from the JWT's own `exp` claim) and grants full
control of the session — keep it server-side, exactly like an admin KS. The browser only ever
needs the non-secret `{whepUrl, turn}` pair from `init-client`.

| Operation | Endpoint | Auth | Body |
|-----------|----------|------|------|
| Create | `POST /v1/avatar-session/create` | Admin KS | `{"visualConfig":{"id":"24-char-hex"}}` |
| Negotiate video | `POST /v1/avatar-session/{sessionId}/init-client` | Bearer | `{}` → `{whepUrl, turn}` |
| Speak | `POST /v1/avatar-session/{sessionId}/say-audio` | Bearer | multipart: `turnId`, `duration` (seconds), `audio` (file) |
| Barge-in | `POST /v1/avatar-session/{sessionId}/interrupt` | Bearer | `{}` |
| Keep alive | `POST /v1/avatar-session/{sessionId}/keep-alive` | Bearer | `{}` |
| End | `POST /v1/avatar-session/{sessionId}/end` | Bearer | `{}` |

`say-audio` is the ONLY speech-injection mechanism this backend exposes (verified live). There is
no text-in: a sibling `say-text` route accepts the request but the server answers `503 Service
temporarily unavailable` on every call, and a bare `say` route 404s — neither is wrapped by the
SDK. Generate the audio yourself with any TTS provider (this backend has none of its own), measure
its duration (e.g. `ffprobe` — the server has no duration probe of its own and an inaccurate value
just desyncs the mouth from the audio, it doesn't error), and pass both to `say-audio`. The call
itself is async/queued: it resolves in roughly 100ms once the server accepts the turn, not once
playback finishes — call `interrupt` to cut off whatever's currently playing.

`set-emotion`, `queue-status`, `status`, and `session-status` all 404 on the current deployment and
are not wrapped.

```js
import { Management } from '@kaltura/intelligent-agents/management';

const mgmt = new Management({ partnerId, adminSecret });
const admin = await mgmt.sessions.createAdminToken();

const session = await mgmt.avatarSessions.create({ visualConfig: { id: avatarId } }, admin.ks);
const { whepUrl, turn } = await mgmt.avatarSessions.initClient(session);
// send only { whepUrl, turn } to the browser — never `session`/`session.token`

const mp3 = await ttsProvider.synthesize('Hello there.');
const duration = await measureDurationSeconds(mp3);          // your own probe, e.g. ffprobe
await mgmt.avatarSessions.say(session, mp3, { duration });

await mgmt.avatarSessions.end(session);
```

Browser side, `KalturaScriptedVideoSession` renders the video/audio downlink from `{whepUrl, turn}`
— it has no `speak()` of its own on purpose (that would need the Bearer token in the browser):

```js
import { KalturaScriptedVideoSession } from '@kaltura/intelligent-agents/experience';

const view = new KalturaScriptedVideoSession({ whepUrl, turn, videoEl });
await view.connect();
// ...call your own server endpoint, which calls mgmt.avatarSessions.say()...
view.disconnect();
```

See the runnable example: [`examples/scripted-video-session.mjs`](examples/scripted-video-session.mjs) + [`examples/scripted-video-session.html`](examples/scripted-video-session.html).

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

`agent/getEmbedScript` replies `{"objectType":"Object","html":"<script…>"}` — a ready-to-paste `<script type='module'>` snippet that loads Kaltura's embeds loader and renders the agent's chat widget (`apis.genieChat.<embedType>(…)`). `embedType` is a closed enum; anything else 400s. SDK: `mgmt.agents.getEmbedScript(agentId, embedType, ks)` unwraps to the html string.

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

A standalone, partner-level reusable-instruction entity — `{id (uuid), name, description, instructions}`. All five operations verified live. SDK: `mgmt.skills`. A Skill's `name` is checked against your partner id OR partner `0` (a shared global pool), so a name can collide with a global-pool Skill in ways invisible from a partner-scoped `list()` — the same nuance applies to Tools below.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/skill/list` | `{"filter":{"objectType":"SkillListFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/skill/get` | `{"id":"SKILL_UUID"}` |
| Add | `POST /v1/skill/add` | `{"name":"...", "description":"...", "instructions"?}` |
| Update | `POST /v1/skill/update` | `{"id":"SKILL_UUID", "name"?, "description"?, "instructions"?}` — idempotent; renames re-check the same partner-unique-name constraint as Add (409 on conflict) |
| Delete | `POST /v1/skill/delete` | `{"id":"SKILL_UUID"}` — replies `{id}`; a follow-up get 404s |

Before deleting a Skill, `mgmt.skills.delete` lists every intellect and refuses with a typed `skill_in_use` error naming each one still referencing the id in `skill_ids`, unless called with `{confirmPermanent:true, force:true}`. Tools' `mgmt.tools.delete` carries the identical `tool_in_use` guard.

### Knowledge records — `https://genie.nvp1.ovp.kaltura.com`

Full record lifecycle (all verified live). SDK: `mgmt.knowledge`. Linkage to an intellect is via `knowledge_ids` (Path A — see § Ground the Agent).

| Operation | Endpoint | Body |
|-----------|----------|------|
| Add | `POST /v1/knowledge/add` | `{"name":"..."}` |
| Get | `POST /v1/knowledge/get` | `{"id":2049}` |
| Update | `POST /v1/knowledge/update` | `{"id":2049, ...fields}` |
| Delete | `POST /v1/knowledge/delete` | `{"id":2049}` — HTTP 200, body `null`; a follow-up get 404s |

`mgmt.knowledge.isIndexed(id, ks)` wraps Get and reads `status`/`config.sources[].indexers[].index_position` — see § Ground the Agent for why this, not `search()`/`corpusStatus()`/`indexStatus()`, is the real indexing-completion check.

Deleting a record does **not** unlink it — an intellect's `knowledge_ids` keeps the dangling id; clear it via `mgmt.intellectConfig.setKnowledgeIds(configId, [], ks)`.

A record with more than one `sources` entry (e.g. `internal` + `web` together) reliably 500s on Delete on the current deployment (verified live, reproduced 3x; single-source records delete cleanly) — see README.md's Honest limits. It becomes an orphan; its backing category/entries can still be torn down separately.

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

A "what can you build" catalog of all 13 use cases (UC-1 through UC-13) and composition patterns,
each mapped to its key mechanism and a runnable script/SDK entry point, has moved to its own file:
see [docs/USE-CASES.md](docs/USE-CASES.md).

---

## Quick Reference

The full `Management` method surface (this doc's endpoints, wrapped) is listed in
[`README.md`](README.md) → Management. Two common lookups:

```js
import { Management } from '@kaltura/intelligent-agents/management';
const mgmt = new Management({ partnerId, adminSecret });
const ks = await mgmt.sessions.createAdminToken();

console.log(await mgmt.agents.list(ks).all());
console.log(await mgmt.intellects.list(ks).all());
```
