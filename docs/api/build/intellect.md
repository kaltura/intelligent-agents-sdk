[← Back to Agent Components](../build.md)

# Create and Configure an Intellect

An intellect is the config object behind your agent's brain. It holds the prompts, model settings, tools, knowledge base links, and feature capabilities that shape how the agent behaves. This page shows how to create one and configure its main fields.

## Generate an Agent Profile

Optional first step: turn a one-line description into the prompt values an intellect needs.

```
POST https://api.avatar.us.kaltura.ai/v1/application/generateAgentProfile
```

```json
{ "userDescription": "A friendly technical support agent for a video platform" }
```

Returns `{goal, targetAudience, restrictedTopics, name, openingPhrase}`. Takes 2–3 s. Nothing is saved: pass `goal`, `targetAudience` and `restrictedTopics` into the intellect's prompts (§ Configure an Intellect, below) and `openingPhrase` into `avatar/create` ([avatar-and-agent.md](avatar-and-agent.md)).

---

## Create an Intellect

```
POST https://genie.nvp1.ovp.kaltura.com/v1/intellect/add
```

```json
{ "type": "internal", "status": 2 }
```

Returns the full intellect object. **Save `id`** — this is your `configId`.

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

**Don't guess at `key`/`headerTemplate` values.** Call `mgmt.application.getCustomPrompts(ks)` instead. It returns the backend's own live schema for this block: a 5-entry array (`goal`, `targetAudience`, `restrictedTopics`, `name`, `knowledge`), each shaped as `{key, label, headerTemplate, objectType}`.

Use this call to render a "describe your agent" form. The labels and instructions you show always match what the backend splices into the system prompt, so you don't have to keep hardcoded copy in sync by hand.

This call only reads data — it has no side effects. It works with any kind of session token, since the schema itself isn't specific to any one partner.

```js
const fields = await mgmt.application.getCustomPrompts(ks);
// [{ key: 'goal', label: 'Goal', headerTemplate: 'The agent\'s goal is: {{value}}', objectType: 'Object' }, ...]
```

**Top-level fields:**

| Field | Purpose |
|-------|---------|
| `base_directive` | Global system instruction |
| `force_language` | Display name of the forced reply language (e.g. `"Hebrew"`). The backend enforces it at runtime: replies come back in that language whatever the user writes or speaks. `null` or `""` clears it. Set it via `mgmt.setForcedLanguage`, which also sets the agent's `asr.language` so speech recognition matches |
| `opening_phrase` | The line spoken as the first turn of every avatar session, a Jinja2 template rendered once per session. The intellect owns it. `null` clears it; `SILENT_OPENING` makes the opening silent so the browser sends the first turn with `kickoff`. Set via `intellectConfig.setOpeningPhrase`. Guide: [START-THE-CONVERSATION.md § Personalize the opening](../../START-THE-CONVERSATION.md#personalize-the-opening) |
| `model_configuration` | `{ model_id?, max_output_tokens?, thinking_level?, temperature? }`; every key optional, `null` means backend defaults. `model_id` is one of `MODEL_IDS`, `thinking_level` one of `THINKING_LEVELS` (`low`/`high`, Gemini only, Claude ignores it), `temperature` 0..1. With `avatar_show_content` on, the backend fills an unset `thinking_level` with `low` and `max_output_tokens` with `4096`. Set via `intellectConfig.setModelConfiguration`. Which models answer depends on your partner's region: verify with `converseOnce` after switching |
| `thread_start_tools` | Tool ids the backend runs once when a thread starts, before the first turn (only `api`/`code` tools run). Server-side only: the result feeds the model and is not surfaced as a `tool` segment. Set via `intellectConfig.setThreadStartTools`; `[]` clears |
| `avatar_summary_config` | `{ prompt?, analysis?, template?, content_type? }` for the end-of-session summary of avatar sessions. `analysis` maps output keys to descriptions, `template` is Jinja2 over those keys, `content_type` is one of `SUMMARY_CONTENT_TYPES` (`text`/`html`/`html_with_js`). The summary is stored on the thread as a `summary` message. `null` restores defaults. Set via `intellectConfig.setAvatarSummaryConfig` |
| `glossary` | Domain terms (e.g. `"HLS: HTTP Live Streaming"`) |
| `capabilities` | Enable/disable features — see table below |
| `allow_client_variables` | Allow `{{vars}}` injection per request |
| `knowledge_ids` | Knowledge record IDs for RAG — create with `POST /v1/knowledge/add` |
| `name` / `description` / `tags` | Labels for organizing intellects |
| `tool_ids` | Tool entity uuid references — create/list the entities themselves via [Tools](../build/tools-and-secrets.md#tools-api--csv--code) (`mgmt.tools`), then link the ids here via `intellectConfig.setToolIds` |
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

**Note:** `force_experience` is not an intellect field — it's a per-call option on `converse()` (values `"markdown"`, `"summarization"`, `"flashcards"`, `"avatar_only"`; a hint, not a guarantee). See [Converse](../operate.md#converse).

---

## Related docs

| Doc | What it adds |
|---|---|
| [`preview-prompt.md`](preview-prompt.md) | Preview the assembled system prompt before shipping an edit |
| [`../build.md`](../build.md) | The Agent Components index |
