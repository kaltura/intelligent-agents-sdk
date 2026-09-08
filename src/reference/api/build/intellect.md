---
layout: base.njk
title: "API · Build · Create and Configure an Intellect"
description: "Create an Intellect, then configure prompts, base_directive, the capabilities table, and force_experience."
eyebrow: Reference
---

# Create and Configure an Intellect

[← Back to Phase 2 — Build](/reference/api/build/)

**On this page:** [Create an Intellect](#create-an-intellect) · [Configure an Intellect](#configure-an-intellect) · [Related docs](#related-docs)


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
| `force_language` | Display name of the forced reply language (e.g. `"Hebrew"`). The backend enforces it at runtime: replies come back in that language whatever the user writes or speaks. `null` or `""` clears it. Set it via `mgmt.setForcedLanguage`, which also sets the agent's `asr.language` so speech recognition matches |
| `opening_phrase` | Jinja2 template over `request_vars` (e.g. `"Hello {{ user_name }}!"`) the backend renders and speaks when an avatar session starts. Overrides the opening phrase the client sends at init; the rendered text comes back in the init response and is stored on the thread as an `opening` message. `null` clears it. Set via `intellectConfig.setOpeningPhrase` |
| `model_configuration` | `{ model_id?, max_output_tokens?, thinking_level?, temperature? }`; every key optional, `null` means backend defaults. `model_id` is one of `MODEL_IDS`, `thinking_level` one of `THINKING_LEVELS` (`low`/`high`, Gemini only), `temperature` 0..1. Set via `intellectConfig.setModelConfiguration`. Which models answer depends on your partner's region: verify with `converseOnce` after switching |
| `thread_start_tools` | Tool ids the backend runs once when a thread starts, before the first turn (only `api`/`code` tools run). Server-side only: the result feeds the model and is not surfaced as a `tool` segment. Set via `intellectConfig.setThreadStartTools`; `[]` clears |
| `avatar_summary_config` | `{ prompt?, analysis?, template?, content_type? }` for the end-of-session summary of avatar sessions. `analysis` maps output keys to descriptions, `template` is Jinja2 over those keys, `content_type` is one of `SUMMARY_CONTENT_TYPES` (`text`/`html`/`html_with_js`). The summary is stored on the thread as a `summary` message. `null` restores defaults. Set via `intellectConfig.setAvatarSummaryConfig` |
| `glossary` | Domain terms (e.g. `"HLS: HTTP Live Streaming"`) |
| `capabilities` | Enable/disable features — see table below |
| `allow_client_variables` | Allow `{{vars}}` injection per request |
| `knowledge_ids` | Knowledge record IDs for RAG — create with `POST /v1/knowledge/add` |
| `name` / `description` / `tags` | Labels for organizing intellects |
| `tool_ids` | Tool entity uuid references — create/list the entities themselves via [Tools](/reference/api/build/tools-and-secrets/#tools-api--csv--code) (`mgmt.tools`), then link the ids here via `intellectConfig.setToolIds` |
| `skill_ids` | Skill references `{ id, mode, condition? }`. `mode` is one of `SKILL_MODES` (`adhoc`, `adhoc-save`, `preloaded`); `condition` is an optional Jinja2 expression over thread variables (e.g. `{{ sys__avatar_enabled }}`). Partner-level Skill CRUD lives at `mgmt.skills`; link via `intellectConfig.setSkillIds`. A skill id from another partner is rejected with 403 `forbidden` |
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
| `think_process` | OFF | Stream the model's reasoning as `think` segments before the answer. When off, one short status placeholder `think` segment is still emitted |

> `capabilities` is a **full-replace** sub-dict. To change one key, read the current dict first and re-send it with your overlay. The SDK handles this automatically via `mgmt.intellects.setCapability`.

`force_experience` (a hint for default rendering): `"markdown"`, `"summarization"`, `"flashcards"`, `"avatar_only"`. Not a guarantee.

---

## Related docs

| Doc | What it adds |
|---|---|
| [API · Build · Preview a Prompt](/reference/api/build/preview-prompt/) | Preview the assembled system prompt before shipping an edit |
| [API · Phase 2 — Build](/reference/api/build/) | The Phase 2 — Build index |

