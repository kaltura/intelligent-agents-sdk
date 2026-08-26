---
layout: base.njk
title: "API · Phase 2 — Build"
description: "Intellects, prompts, tools, secrets, RAG grounding, avatars, agents, and brain configuration."
eyebrow: Reference
---

[← API Reference index](/reference/api-reference/)

# Phase 2 — build

## Create an Intellect

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

## Configure an Intellect

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
| `avatar_filler` | OFF | Avatar speaks filler while thinking — phrasing is server-generated, not steerable via `base_directive`/persona |
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

## Preview a Prompt (client-side)

**SDK:** `mgmt.intellects.previewPrompt(configId, ks, opts)`. READ — no write. The returned `text` is rendered client-side, a replica of the author layer (`prompts[]` + `base_directive` + `glossary`) assembled the same way the server's `get_partner_prompts()`/`get_system_prompt()` do, so you can check a prompt template before shipping it. By default it fetches and renders the intellect's *current stored* config; pass `draftPrompts`/`draftBaseDirective`/`draftGlossary` to preview an unsaved edit instead.

```js
const p = await mgmt.intellects.previewPrompt(configId, adminKs, {
  requestVars: { sys__user_id: 'learner-123', topic: 'billing' },
});
p.text;                // the assembled system prompt, `{{var}}` interpolated
p.unresolvedVariables; // names left literal because no value was supplied
p.warnings;             // present ONLY when a reserved variable is unresolved (see below)
```

It is **not byte-exact** with the live prompt — server-injected capability-conditional blocks (`video_gallery`/`avatar_show_content`/`web_search_enabled`/`user_properties`) are not reproduced, and `sys__*` values you pass via `requestVars` are a *simulation* of what the server sets per turn, not a live read.

**Reserved variables** the server sets per turn (always available to `{{...}}` regardless of `allow_client_variables`):

| Variable | Notes |
|----------|-------|
| `sys__thread_id` | Current conversation thread id |
| `sys__message_id` | Current message id |
| `sys__user_id` | Bound end-user id — see `Sessions.createConversationToken({userId})` |
| `sys__user_message` | The user's current turn text |
| `sys__is_new_thread` | `true` on the first turn of a thread |
| `sys__ks` | The raw session token. **Never reference this in a prompt that could be echoed back to a user or logged** — it is a live credential. |
| `sys__user_obj.first_name` / `.last_name` / `.title` / `.company` / `.gender` / `.email` | Attributes of the bound-user object. The rendered preview from `previewPrompt()` carries a `reserved_user_attr_unresolved` warning when a prompt references these — treat it as a hard stop before shipping. |
| `secrets.NAME` | A named secret configured on the intellect (write-only — `previewPrompt()` never has access to the raw value, so it cannot confirm one is set) |

**Unresolvable-reserved-variable warnings (hardening):** if a prompt references one of the variables above and no value is available in the simulated context (no `requestVars` entry, or an explicit `null`/`undefined`), `previewPrompt()` returns a `warnings[]` entry naming the variable and why — instead of the placeholder being silently rendered as literal/empty text as if the prompt were safe to ship. `warnings` is an **additive** field: it is present only when non-empty, so a fully-resolved preview's return shape is unchanged from before this hardening.

```js
const p = await mgmt.intellects.previewPrompt(configId, adminKs, {
  draftPrompts: [{ key: 'greet', headerTemplate: 'Greeting', value: 'Hi {{sys__user_obj.first_name}}', type: 'custom' }],
  draftBaseDirective: 'You are Ron.',
  draftGlossary: '',
  requestVars: {}, // no bound user simulated
});
p.warnings;
// [{
//   severity: 'warning',
//   code: 'reserved_user_attr_unresolved',
//   message: '`{{sys__user_obj.first_name}}` has no bound value in this preview\'s
//              requestVars. previewPrompt flags this as reserved_user_attr_unresolved —
//              bind a user (Sessions.createConversationToken({userId}))
//              or supply "sys__user_obj.first_name" in requestVars to simulate
//              the bound case before shipping this prompt.'
// }]
```

Supplying the value in `requestVars` (e.g. `{ 'sys__user_obj.first_name': 'Jane' }`, or `{ sys__user_id: 'learner-123' }`) simulates the bound case and clears the warning. Warning `code`s: `reserved_var_unresolved` (a scalar `sys__*` variable), `reserved_user_attr_unresolved` (a `sys__user_obj.*` attribute — the class of reference that can crash a live turn), `reserved_secret_unresolved` (a `secrets.*` reference `previewPrompt()` cannot verify, since only the rendered text is ever available to it, never a raw secret value).

---

## Tools (api / csv / code)

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

**Security note:** an `api` tool's `request` fires server-to-server, outside the SDK's reach. The model/system-prompt scoping that led to the call is not a security boundary — your endpoint must independently authenticate and authorize each request (validate the caller's Kaltura Session and permissions), the same way you would for any other server-to-server API call. Treat interpolated `request_vars` (client-suppliable when `allow_client_variables:true` — see [Converse](/reference/api/operate/#converse)) as untrusted input, never as an authorization claim.

**`csv` tool** — inline lookup table:

```json
{ "name": "tier_lookup", "config": { "type": "csv", "description": "Map account to tier", "csv": "account,tier\n42,gold" } }
```

**`code` tool** — Python in a server sandbox:

```json
{ "name": "fx_rate", "config": { "type": "code", "description": "Convert currency", "code": "def main(request_config):\n    return 'ok'" } }
```

**`client` tool** — a native function-calling tool that makes NO server-side call at all. The model calls it, the backend emits a silent `type:"tool"` segment (see [Wire Protocol](/reference/wire-protocol/)), and that's the entire contract — no `request` block, no echo endpoint, no response shaper:

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

## Secrets (write-only)

`secrets` is a dict `{name: value}` on `config`. A read masks every value as `"***"`. A `"***"` value on update is preserved server-side — read-modify-write never clobbers a sibling. Reference as `"secrets.NAME"` in tool configs or `{{secrets.NAME}}` in prompts.

**SDK:** `mgmt.intellects.secrets.{listNames, has, set, delete, replaceAll, validate}`. `delete(configId, name, ks, confirm)` is permanent and requires `confirm = { confirmPermanent: true }`.

---

## Ground the Agent in Your Content (RAG)

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

> **`knowledge_ids` is capped at ONE record** despite the plural array shape — the Genie validator (`at_most_one_knowledge_id`) rejects more. The SDK's `intellectConfig.setKnowledgeIds()` enforces this client-side with a typed `bad_request` before any network call. To ground one agent in several content sources, upload them all into a single knowledge record.

**Step 3 — Upload content** via `knowledge.uploadDocument()` (SDK) or the Kaltura OVP media ingest APIs.

| Modality | Source |
|----------|--------|
| `caption` | Video captions (SRT) |
| `ocr` | On-screen text |
| `document` | PDF / Markdown attachments |

**SDK:** `knowledge.addRecord()` + `knowledge.uploadDocument()` + `intellectConfig.setKnowledgeIds()` (Path A, verified live). Re-pointing an EXISTING intellect via the `partner-config/update` path (Path B — `knowledge.linkRecords()`, probed first with `knowledge.linkAvailable()`) is still gated (403s for a partner admin KS today) — prefer Path A for new agents; only reach for Path B if the intellect already exists and you can't recreate it.

**Checking whether indexing has finished:** use `knowledge.isIndexed(id, ks)` — reads `knowledge.getRecord(id, ks).status`, returning `{ready, status, indexPosition}`. Don't use `knowledge.search()` for this — its "couldn't find relevant information" reply fires for an unindexed KB, an indexed KB with `use_knowledge_base:'off'`, or a genuine no-match query alike, so it can't signal indexing status. `knowledge.corpusStatus()` only counts entries that exist in the category, not whether they've finished embedding. `knowledge.indexStatus()` (`partner-config/stats`) 403s for a partner admin KS on at least one deployment — the same privilege wall as the Path B write.

---

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

`voice.id` and `visual.id` come from the catalog (§ Browse the Catalog). Returns `id` (24-char hex). **No `adminTags`** — avatars reject unknown fields. Tag the parent agent instead.

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
| `intellect.intellectType` | Always `"genie"` |
| `intellect.id` | The intellect's configId, from intellect create — passed straight in, no discovery step |
| `avatarIds` | Optional — omit for a headless text-only agent |
| `maxConversationLength` | Seconds. Default 540, range 1–3600 |
| `widgetConfig.initialPage.title` | Max 30 chars |

Returns `agentId` (UUID). **Save this.**

---

## Configure the Brain (deployment-gated)

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

