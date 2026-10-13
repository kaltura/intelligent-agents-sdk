[← Back to Agent Components](../build.md)

# Create and Configure an Intellect

An intellect is the config object that drives your agent. It holds the prompts, model settings, tools, knowledge base links, and feature capabilities that shape how the agent behaves. This page shows how to create one and configure its main fields.

## Generate an Agent Profile

Optional first step: turn a one-line description into the prompt values an intellect needs.

```
POST https://api.avatar.us.kaltura.ai/v1/application/generateAgentProfile
```

```json
{ "userDescription": "A friendly technical support agent for a video platform" }
```

Returns `{goal, targetAudience, restrictedTopics, name, openingPhrase}`. Nothing is saved: pass `goal`, `targetAudience` and `restrictedTopics` into the intellect's prompts and `openingPhrase` into the intellect's `opening_phrase` (§ Configure an Intellect, below). Leave the avatar's own `openingPhrase` unset ([avatar-and-agent.md](avatar-and-agent.md)).

---

## Create an Intellect

```
POST https://genie.nvp1.ovp.kaltura.com/v1/intellect/add
```

```json
{ "type": "internal", "status": 2 }
```

Returns the full intellect object. **Save `id`**. It is your `configId`.

| `status` | Meaning |
|----------|---------|
| `2` | Active |
| `1` | Pending |
| `0` | Marked for deletion |

**External LLM (BYO-LLM).** It is possible, but not self-serve. Ask your Kaltura Account Manager to set it up. `intellects.create` rejects a body that contains `url` or `protocol` with a typed `bad_request`.

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

**Prompts.** Each block adds a section to the system prompt:

| Field | Purpose |
|-------|---------|
| `key` | Any string that labels the block. Common: `goal`, `targetAudience`, `restrictedTopics`, `name` |
| `headerTemplate` | Prepended before the value in the system prompt |
| `type` | One of `"custom"`, `"system"` or `"knowledge"`. Use `"custom"` for your own instructions. The model follows all three |
| `value` | Your content |
| `condition` | Optional. The block applies only while this [condition](#conditions) is true |

Call `mgmt.application.getCustomPrompts(ks)` to get the `key` and `headerTemplate` values. It returns the current schema for this block: a 5-entry array (`goal`, `targetAudience`, `restrictedTopics`, `name`, `knowledge`), each shaped as `{key, label, headerTemplate, type}` (every entry returned has `type: "custom"`; your own blocks can use any of the three `type` values above).

Use this call to render a "describe your agent" form. The labels and instructions you show always match the current prompt blocks, so you do not keep hardcoded copy in sync by hand.

This call only reads data and has no side effects. It works with any kind of session token.

```js
const fields = await mgmt.application.getCustomPrompts(ks);
// [{ key: 'goal', label: 'Goal', headerTemplate: 'The agent\'s goal is: {{value}}', type: 'custom' }, ...]
```

**Top-level fields:**

| Field | Purpose |
|-------|---------|
| `base_directive` | Global system instruction |
| `force_language` | Display name of the forced reply language (e.g. `"Hebrew"`). Replies come back in that language whatever the user writes or speaks. `null` or `""` clears it. Set it via `mgmt.setForcedLanguage`, which also sets the agent's `asr.language` so speech recognition matches |
| `opening_phrase` | The line spoken as the first turn of every avatar session, a template rendered once per session. The intellect owns it. `null` clears it; `SILENT_OPENING` makes the opening silent so the browser sends the first turn with `kickoff`. Set via `intellectConfig.setOpeningPhrase`. Guide: [START-THE-CONVERSATION.md § Personalize the opening](../../START-THE-CONVERSATION.md#personalize-the-opening) |
| `model_configuration` | `{ model_id?, max_output_tokens?, thinking_level?, temperature? }`; every key optional, `null` uses the defaults. `model_id` is one of `MODEL_IDS`, `thinking_level` one of `THINKING_LEVELS` (`low`/`high`, Gemini only, Claude ignores it), `temperature` 0..1. Set via `intellectConfig.setModelConfiguration`. Which models answer depends on your partner's region: verify with `converseOnce` after switching |
| `thread_start_tools` | Tool ids that run once when a thread starts, before the first turn. Use `api` and `code` tools. The result feeds the model and is not surfaced as a `tool` segment. Set via `intellectConfig.setThreadStartTools`; `[]` clears |
| `avatar_summary_config` | `{ prompt?, analysis?, template?, content_type? }` for the end-of-session summary of avatar sessions. `analysis` maps output keys to descriptions, `template` is a template over those keys, `content_type` is one of `SUMMARY_CONTENT_TYPES` (`text`/`html`/`html_with_js`). The summary is stored on the thread as a `summary` message. `null` restores defaults. Set via `intellectConfig.setAvatarSummaryConfig` |
| `glossary` | Domain terms (e.g. `"HLS: HTTP Live Streaming"`) |
| `capabilities` | Enable or disable features. See the table below |
| `allow_client_variables` | Allow `{{vars}}` injection per request. On by default for a new intellect |
| `knowledge_ids` | Knowledge record IDs for RAG. Create them with `POST /v1/knowledge/add` |
| `name` / `description` / `tags` | Labels for organizing intellects |
| `tool_ids` | Tool entity uuid references. Create and list the entities themselves via [Tools](../build/tools-and-secrets.md#tools-api--csv--code--client--var) (`mgmt.tools`), then link the ids here via `intellectConfig.setToolIds` |
| `skill_ids` | Skill references `{ id, mode, condition? }`. `mode` is one of `SKILL_MODES` (`adhoc`, `adhoc-save`, `preloaded`); `condition` is an optional [condition](#conditions) (e.g. `sys__avatar_enabled`). Partner-level Skill CRUD lives at `mgmt.skills`; link via `intellectConfig.setSkillIds`. `skills.list` also returns shared skills (`partner_id: 0`) that you can link but not read with `skills.get`. A skill id you cannot use is rejected with 403 `forbidden` |
| `mcp_servers` | MCP server configs the intellect can call. Set via `intellectConfig.setMcpServers`. See [MCP-INTEGRATIONS.md](../../MCP-INTEGRATIONS.md) |
| `secrets` | Named secrets for tool OAuth (write-only, masked on read) |
| `user_properties_forms` | Lead-capture form fields |

### Conditions

A `condition` switches a skill, a prompt block or a tool on only while it is true. It is a **bare expression** over thread variables:

| Where | Set with |
|---|---|
| Skill | `condition` in a `skill_ids` entry |
| Prompt block | `condition` in a `prompts[]` block |
| Tool | `condition` in the tool config, e.g. `tools.api({ ..., condition })` |

```js
await mgmt.intellectConfig.setSkillIds(configId, [
  { id: skill.id, mode: 'preloaded', condition: 'sys__avatar_enabled and not sys__avatar_share_screen_enabled' },
], ks);
```

Do not wrap it in `{{ }}` or `{% %}`. The server answers a template-style condition with an empty reply and no error. The SDK rejects it with `bad_request` on write, `lintPrompts` reports `bad_condition`, and `intellectConfig.audit` flags a saved one.

Variables you can use: the `sys__*` variables in [Reserved Template Variables](../operate.md#reserved-template-variables-sys__), and any variable a [`var` tool](tools-and-secrets.md#var-tool) has set earlier in the same thread.

**Capabilities.** Each is `"on"` / `"off"` / `"disabled"`:

| Key | Default | What it does |
|-----|---------|-------------|
| `avatar` | OFF | Enable avatar video conversation |
| `avatar_filler` | OFF | Avatar speaks filler while thinking. The server generates the phrasing. `base_directive` and persona text do not change it |
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

> When you set `capabilities` directly, send the full dict. To change one key, use `mgmt.intellects.setCapability`. It reads the current dict and re-sends it with your change.

**Note:** `force_experience` is not an intellect field. It is a per-call option on `converse()` (values `"markdown"`, `"summarization"`, `"flashcards"`, `"avatar_only"`; a hint, not a guarantee). See [Converse](../operate.md#converse).

---

## Related docs

| Doc | What it adds |
|---|---|
| [`preview-prompt.md`](preview-prompt.md) | Preview the assembled system prompt before shipping an edit |
| [`../build.md`](../build.md) | The Agent Components index |
