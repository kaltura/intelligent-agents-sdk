[← Back to the API Reference index](../../API-REFERENCE.md)

# Phase 2 — Build

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

**Don't guess at `key`/`headerTemplate` values** — `mgmt.application.getCustomPrompts(ks)` returns the backend's own live schema for this block: a 5-entry array (`goal`, `targetAudience`, `restrictedTopics`, `name`, `knowledge`), each `{key, label, headerTemplate, objectType}`. Render a "describe your agent" form straight from this call and the labels/instruction text you show always match what the backend actually splices into the system prompt — no hardcoded copy to keep in sync by hand. READ, no ids, no side effects, works with any KS kind (partner-agnostic, not partner data).

```js
const fields = await mgmt.application.getCustomPrompts(ks);
// [{ key: 'goal', label: 'Goal', headerTemplate: 'The agent\'s goal is: {{value}}', objectType: 'Object' }, ...]
```

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
| `sys__ks` | The raw session token. **Never reference this in a prompt that could be echoed back to a user or logged.** It is a live credential. |
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

Tools are a standalone, PARTNER-LEVEL entity with their own CRUD (`/v1/tool/add|get|list|update|delete`, Genie host) — **not** embedded in an intellect. An intellect only carries the `tool_ids` (an array of tool uuid strings) it may call. **SDK:** `import { tools } from '@kaltura/intelligent-agents/management'` builds and validates a tool's `config` before any network call; `mgmt.tools` is the CRUD surface; `mgmt.intellectConfig.setToolIds` (or `tool_ids` passed straight to `intellects.create`/`update`) links a tool to an intellect.

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

Returns a `Tool` — `{id, name, config, partner_id, created_at, updated_at}`. Link its `id` into an intellect:

```json
{ "id": 42, "type": "internal", "status": 2, "tool_ids": ["<the returned id>"] }
```

sent to `POST /v1/intellect/update`.

`response_mapping`, `response_template`, and `response_chapters` are mutually exclusive. Reference secrets as `"secrets.NAME"` — never plaintext.

**Security note:** an `api` tool's `request` fires server-to-server, outside the SDK's reach. The model/system-prompt scoping that led to the call is not a security boundary — your endpoint must independently authenticate and authorize each request (validate the caller's Kaltura Session and permissions), the same way you would for any other server-to-server API call. Treat interpolated `request_vars` (client-suppliable when `allow_client_variables:true` — see [Converse](operate.md#converse)) as untrusted input, never as an authorization claim.

**`csv` tool** — inline lookup table:

```json
{ "name": "tier_lookup", "config": { "type": "csv", "description": "Map account to tier", "csv": "account,tier\n42,gold" } }
```

**`code` tool** — Python in a server sandbox:

```json
{ "name": "fx_rate", "config": { "type": "code", "description": "Convert currency", "code": "def main(request_config):\n    return 'ok'" } }
```

**`client` tool** — a native function-calling tool that makes NO server-side call at all. The model calls it, the backend emits a silent `type:"tool"` segment (see [WIRE-PROTOCOL.md](../WIRE-PROTOCOL.md)), and that's the entire contract — no `request` block, no echo endpoint, no response shaper:

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

**Don't already know the id?** `mgmt.knowledge.list(ks, opts)` discovers a partner's existing records — pass `opts.filter.nameLike` to search by name. Use it to build a "pick an existing knowledge base" picker instead of hardcoding ids: a common Agent Factory flow is letting a user attach a knowledge base they created earlier to a brand-new agent. Distinct from `knowledge.listCategoryEntries(categoryId, ks)`, which lists KMS *entries* inside one category, not Knowledge *record* containers.

```js
const page = await mgmt.knowledge.list(ks, { pageSize: 20, filter: { nameLike: 'Product' } });
page[0]; // { id: 42, name: 'Product Documentation', status: 'READY', config: { sources: [...] }, ... }
```

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

**Step 3 — Upload content into a KMS category:** `knowledge.uploadDocument()` (SDK) or the Kaltura OVP media ingest APIs put the actual media entries into a KMS category — `knowledge.createCategory()` creates that category if you don't already have one. A category is just a container; on its own it's not connected to the knowledge record from Step 1.

**Step 4 — Point the record at that category:** `knowledge.addSource(id, { type: 'internal', categoryIds: [String(categoryId)] }, ks)`. This is the step that actually makes the uploaded content retrievable — a knowledge record with no `config.sources[]` entry has nothing to search, even with `knowledge_ids` linked and `use_knowledge_base: "on"`. `knowledge.removeSource(id, source, ks)` is the inverse. Both read-merge-write one entry of `config.sources[]` without disturbing the others, and are idempotent. Don't hand-assemble `config.sources` via `updateRecord({config}, ks)` directly unless you intend a full replace: the backend overwrites the entire `config` on that field.

| Modality | Source |
|----------|--------|
| `caption` | Video captions (SRT) |
| `ocr` | On-screen text |
| `document` | PDF / Markdown attachments |

**SDK, full sequence:** `knowledge.addRecord()` → `knowledge.createCategory()` (or reuse an existing category) → `knowledge.uploadDocument()` → `knowledge.addSource()` → `intellectConfig.setKnowledgeIds()` → `knowledge.setEnabled(configId, true, ks)` (equivalent to the `capabilities.use_knowledge_base` write in Step 2). Skipping `addSource` is the most common way to end up with a linked, enabled, but silently empty knowledge base. Re-pointing an EXISTING intellect to a new or different knowledge record works the same way — call `setKnowledgeIds()` again with the new id. It's a normal `v1/intellect/update` write, no separate linking call, no gate.

**Checking whether indexing has finished:** `knowledge.isIndexed(id, ks)` reads `knowledge.getRecord(id, ks).status`. But `status` is the knowledge record's own container-lifecycle flag (`"READY"`/`"DELETED"`), not an indexing-completion signal. It reads `"READY"` immediately once the record exists, before any entry has been indexed, because a knowledge base is open-ended (you can always add more entries), so there's no single "fully indexed" state for the record as a whole. Don't treat `isIndexed()` returning `ready:true` as proof your content is searchable yet.

Don't use `knowledge.search()` as a substitute either. Its "couldn't find relevant information" reply fires alike for an unindexed KB, an indexed KB with `use_knowledge_base:'off'`, or a genuine no-match query, so it can't signal indexing status. `knowledge.corpusStatus()` only counts entries that exist in the category, not whether they've finished embedding.

`knowledge.entryStatus(knowledgeId, entryIds, ks)` is the official per-entry indexing-status check, and the correct way to verify specific uploaded content has finished indexing. Poll it instead of guessing with a fixed wait:

```js
async function pollUntilIndexed(mgmt, knowledgeId, entryIds, ks, { intervalMs = 5000, timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(entryIds);
  while (pending.size && Date.now() < deadline) {
    const { entries } = await mgmt.knowledge.entryStatus(knowledgeId, [...pending], ks);
    // entries omits an id until it's finished indexing, then reports its documents' status.
    for (const entry of entries) {
      if (entry.documents?.every((d) => d.status)) pending.delete(entry.entry_id);
    }
    if (pending.size) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return pending.size === 0; // false means the timeout ran out before every entry confirmed
}
```

Resolve that poll **before** you create or update the intellect, and send `use_knowledge_base:'on'` in that same `intellectConfig` call alongside `knowledge_ids`, not as a follow-up capability patch. Partner config is Redis-cached for up to 24h server-side (see [CLIENT-COMMANDS.md's Gotcha 2](../CLIENT-COMMANDS.md#gotcha-2--partner-config-is-cached-24h-set-capabilities-at-creation-not-after)). A two-step create-then-flip risks the cache latching onto the transient `off` value from step one and never seeing step two's `on`. A single write after the poll avoids that race entirely for a fresh create.

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

**Faster path — pick a curated preset instead of assembling voice+visual by hand:** `mgmt.avatars.listTemplates(ks, opts)` lists ready-made `{voice, face}` bundles (dozens of curated presets — "Adam", "Amir", "Ben", ...). Useful for a fleet product that spins up many agents fast (one avatar per sales rep, a demo generator) and wants a "pick a good-looking preset" step instead of a build-your-own-face-plus-voice wizard every time.

```js
const templates = await mgmt.avatars.listTemplates(ks, { pageSize: 10 });
const t = templates[0]; // { id, name: 'Adam', voice: { id }, face: { id, imageUrl } }
await mgmt.avatars.create({ voice: t.voice, visual: { id: t.face.id }, openingPhrase: 'Hi!' }, ks);
```

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

## Brain-Model & Rate-Limit Fields (not in the public API)

`agent_llm`, `agent_fast_llm`, `agent_avatar_llm`, `run_quota_check`, `web_search_config`, and the four rate-limit fields (`rate_limit_per_minute`, `rate_limit_per_hour`, `anonymous_rate_limit_per_minute`, `anonymous_rate_limit_per_hour`) exist on the backend intellect record, but no public route reads or writes them — `intellect/get`/`intellect/update` never expose or accept them, and there is no separate endpoint that does. They're set by internal tooling only.

**SDK:** `mgmt.intellectConfig.describe(configId, ks)` lists every one of these under its `readOnly` map, each with a short note, so a UI can render them as informational without hardcoding the list:

```js
const { readOnly } = await mgmt.intellectConfig.describe(configId, ks);
readOnly.agent_llm; // { value: <whatever intellect/get returns for this key, if anything>, note: 'set by internal tooling only, not writable via the public API' }
```

---

## Lifecycle (event-driven rules)

Today, "summarize every ended session and email the account owner" means polling for finished threads yourself. Lifecycle removes the polling: create a **rule** once, and the backend fires its **action** automatically every time a matching event happens, server-side. Mounted at `mgmt.lifecycle`.

New to this? [`docs/LIFECYCLE-INSIGHTS-RECIPE.md`](../LIFECYCLE-INSIGHTS-RECIPE.md) is a hands-on walkthrough of the two action types below, with a runnable example — this section is the field-by-field reference it links back to.

A rule is `{eventType, objectType, eventConditions, action}`:

- `eventType` — e.g. `session_ended`, `analysis_updated`.
- `objectType` — currently only `thread`.
- `eventConditions[]` — `{field, operator, value}` matchers, e.g. `{field:'object.agent_id', operator:'eq', value:'<uuid>'}`, `{field:'changed_keys', operator:'has_all', value:[...]}`. `field` is a dot-path into the event payload (see `describeFields` below for which paths exist per event) — confirmed live: a `{path, op}` shaped entry 400s.
- `action` — a plain object, one of two shapes today. Passed straight through, not built by the SDK:
- `{ actionType: 'triggerInsight', insights: [{ insightKey, valueType, prompt? }, ...] }` — fires up to 20 named LLM insight generations against the thread. `valueType` (`'string'`/`'number'`/`'boolean'`/`'arrayString'`/`'arrayNumber'`/`'arrayBoolean'`) is **required on every insight, even built-in keys** — omitting it 400s live. `SUMMARY`/`SENTIMENT`/`TOPIC` have built-in prompts; a custom `insightKey` needs an explicit `prompt`.
- `{ actionType: 'sendInsightEmail', recipients: string[], templateId?: string, presetType?: string }` — mails a rendered insight summary to `recipients` (supports `{{template}}` placeholders like `{{object.user_id}}`), using either an explicit `templateId` or an auto-created `presetType` template. Only fires on `eventType:'analysis_updated'` — attaching it to a `session_ended` rule is a server-side no-op.

**Business use-case 1 — auto-summarize every ended session:**

```js
await mgmt.lifecycle.create({
  name: 'Summarize on session end',
  systemName: 'auto_summary_v1',
  eventType: 'session_ended',
  objectType: 'thread',
  action: { actionType: 'triggerInsight', insights: [{ insightKey: 'SUMMARY', valueType: 'string' }, { insightKey: 'SENTIMENT', valueType: 'string' }, { insightKey: 'TOPIC', valueType: 'string' }] },
}, ks);
```

Every conversation gets a structured recap the moment it ends, with zero app-side code.

**Business use-case 2 — alert a human when a specific agent's analysis updates:**

`eventConditions` can only filter on fields `describeFields` actually reports. For `thread`/`analysis_updated` today that's `object.agent_id`, `object.thread_id`, `object.user_id`, and `changed_keys` (which insight keys were updated), **not** an insight's computed value. For example, there is no `object.sentiment` field to filter on: a sentiment score only exists as the *output* of a `triggerInsight` action, not an input `eventConditions` can inspect. Scope a rule to one agent instead:

```js
await mgmt.lifecycle.create({
  name: 'Email support lead when this agent\'s analysis updates',
  systemName: 'analysis_alert_v1',
  eventType: 'analysis_updated',
  objectType: 'thread',
  eventConditions: [{ field: 'object.agent_id', operator: 'eq', value: '<agent-uuid>' }],
  action: { actionType: 'sendInsightEmail', recipients: ['support-lead@example.com'], presetType: 'conversationInsightExample' },
}, ks);
```

A support lead gets emailed every time this specific agent's conversation analysis updates, without polling.

**A rule filtering on `object.agent_id` only matches threads created with an agent-scoped KS.** Mint the conversation token with `mgmt.sessions.createAgentToken({ agentId })` (`agentid:<agentId>`), not `createConversationToken({ configId })` (`geniegpcid:<configId>`) — the latter has no agent claim at all, so the resulting thread's `agent_id` is `"default"` and can never match a rule scoped to a real agent uuid. This applies whether the conversation happens over `mgmt.conversations.send()`/`.stream()` or a real avatar/socket session — the agent binding lives entirely in the KS's privilege claim, not in the call itself. See [`createAgentToken`](../../src/core/session.js) for details.

**Business use-case 3 — power a no-code rule editor:** the 4 discovery methods let a UI populate its own dropdowns instead of hardcoding enums that will drift from the backend:

```js
await mgmt.lifecycle.listObjects(ks);                              // [{ objectType: 'thread', description: '...' }]
await mgmt.lifecycle.listEvents('thread', ks);                     // { objectType: 'thread', events: [{ eventType: 'session_ended', description: '...' }, ...] }
await mgmt.lifecycle.describeFields('thread', 'session_ended', ks); // { objectType, eventType, fields: [{ path, type, description }, ...] }
```

**Dry-run a rule before a real event fires it** — `match(objectType, eventType, eventData, ks)`, where `eventData` is `{ object?, changed_keys? }` (not a bare `object` field). For `objectType:'thread'`, `object` is validated server-side: `agent_id`, `thread_id`, and `user_id` are all required strings — omitting any one 400s live:

```js
const { matchedRules } = await mgmt.lifecycle.match(
  'thread', 'session_ended',
  { object: { agent_id: 'agent-1', thread_id: 'thread-1', user_id: 'user-1' } },
  ks,
);
```

**Production already ships a system-seeded preset rule** — `match` can return rules you never created. Every partner, by default, has a preset rule (`id: "preset__overridable_summary_on_session_ended"`, `action.actionType: "triggerOverridableSummaryInsight"`) that matches every `session_ended`/`thread` event. `matchedRules[]` groups related rules under a shared `groupKey` with `isGrouped:true` — don't mistake a grouped preset for something you configured:

```js
{
  matchedRules: [
    {
      rules: [
        { id: 'preset__overridable_summary_on_session_ended', action: { actionType: 'triggerOverridableSummaryInsight' } },
        { id: 'rule-you-created', action: { actionType: 'triggerInsight', insights: [{ insightKey: 'SUMMARY', valueType: 'string' }] } },
      ],
      isGrouped: true,
      groupKey: '_system_grouped_kai_insights',
    },
  ],
}
```

**Full CRUD + discovery surface:**

| Method | Kind | Notes |
|---|---|---|
| `lifecycle.create(body, ks)` | WRITE, not idempotent | mirrors `Tools#add` |
| `lifecycle.get(id, ks)` | READ | |
| `lifecycle.list(ks, opts)` | READ | `{offset,limit}` pager (`PagerDto`); `opts.filter` (`eventTypeEqual`, `statusEqual`, `systemNameEqual`) and `opts.orderBy` (`+createdAt`/`-createdAt`) pass through 1:1 |
| `lifecycle.update(id, patch, ks)` | WRITE, idempotent | mirrors `Tools#update` |
| `lifecycle.delete(id, ks, confirm)` | WRITE, destructive | `requireConfirm` gate; response is `{success}`, not `{id}` |
| `lifecycle.match(objectType, eventType, eventData, ks)` | READ (dry-run) | see above |
| `lifecycle.listObjects(ks)` | READ | |
| `lifecycle.listEvents(objectType, ks)` | READ | |
| `lifecycle.describeFields(objectType, eventType, ks)` | READ | |
