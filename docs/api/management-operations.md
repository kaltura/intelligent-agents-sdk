[← Back to the API Reference index](../../API-REFERENCE.md)

# Management Operations

Endpoint and request reference for every `Management` operation: agents, avatars, intellects, tools, skills, threads, messages, knowledge, lifecycle and insight settings.

All operations use the **admin KS** (`createAdminToken`), except where a section says otherwise. Agents, Avatars, Lifecycle and Insight Settings call the management host (`https://api.avatar.us.kaltura.ai`). Everything else calls the conversation host (`https://genie.nvp1.ovp.kaltura.com`). Hosts for other regions: [Regions and base URLs](authentication.md#regions-and-base-urls).

## Agents

| Operation | Endpoint | Body |
|-----------|----------|------|
| Create | `POST /v1/agent/create` | `{"displayName":"...", "intellect":{...}, "avatarIds":["24-char-hex"], "adminTags"?:["..."]}` |
| List | `POST /v1/agent/list` | `{"filter":{},"orderBy"?:"-updatedAt","pager":{"offset":0,"limit":30}}` |
| Get | `POST /v1/agent/get` | `{"agentId":"UUID"}` |
| Update | `POST /v1/agent/update` | `{"agentId":"UUID", ...fields}` |
| Delete | `POST /v1/agent/delete` | `{"agentId":"UUID"}` |

Filter keys: `agentId`, `adminTagsIn`, `adminTagsNotIn`, `searchValue` (case-insensitive substring match on `displayName`/`agentId`). An unrecognized key 400s.

The request also takes a top-level `orderBy`, next to `filter`, not inside it. `-createdAt` and `-updatedAt` sort newest first. `+createdAt` is ignored. `+updatedAt` cannot be told apart from no `orderBy`. Any other value returns `bad_request` (400), and the error lists the four accepted values. Threads and Messages below take `orderBy` inside `filter`. SDK: `mgmt.agents.list(ks, { filter, orderBy })` sends both as-is.

`mgmt.agents.delete` refuses to delete an agent whose `adminTags` match a production marker (`prod`, `production`, `keep`, `do-not-delete`, `live`; the exported `PROTECTED_TAGS`). Pass `{confirmPermanent:true, allowProtected:true}` to delete it anyway. This stops a cleanup-by-tag sweep from deleting an agent that is in use. The SDK reads the agent first. If that read fails (other than the agent not existing), the delete is refused with that error. `{skipProtectedCheck:true}` skips the read and the guard.

## Avatars

| Operation | Endpoint | Body |
|-----------|----------|------|
| Create | `POST /v1/avatar/create` | `{"voice":{"id":"...","speed"?:1.0}, "visual"?:{"id":"...","motionControl"?:{...}}, "face"?:{"id":"..."}, "background"?:{"type":"color"\|"visual","value"?:"..."}, "templateId"?:"...", "name"?:"...", "openingPhrase"?:"..."}` (leave `openingPhrase` unset. The intellect's `opening_phrase` sets the opening line, see [START-THE-CONVERSATION.md](../START-THE-CONVERSATION.md#where-the-opening-phrase-lives).) Visual resolution rules: [build/avatar-and-agent.md § Three ways to get a visual](build/avatar-and-agent.md#three-ways-to-get-a-visual). |
| List | `POST /v1/avatar/list` | `{"pager":{"offset":0,"limit":30}}` |
| Get | `POST /v1/avatar/get` | `{"id":"24-char-hex"}`. A missing or unknown id throws `code:'api_exception'` with `title:'AVATAR_NOT_FOUND'`. Branch on `title`, not `code`. A malformed id throws `code:'bad_request'` |
| Update | `POST /v1/avatar/update` | `{"id":"24-char-hex", ...fields}`. Omitted fields are preserved. `templateId` is create-only (400 on update) |
| Delete | `POST /v1/avatar/delete` | `{"id":"24-char-hex"}` |
| List templates | `POST /v1/avatar-template/list` | `{"pager":{"offset":0,"limit":30}}`. Curated presets, each pairing a `voice` with either a ready `visual` or a `face`/`background` pair ([build/avatar-and-agent.md § Three ways to get a visual](build/avatar-and-agent.md#three-ways-to-get-a-visual)). SDK: `mgmt.avatars.listTemplates(ks, opts)`; `opts.idsIn` filters to specific template ids. |

**Changing the look on update.** On create, `face` and `background` travel together. On update:

- To change the background, send `background` alone. It applies to the avatar's current face.
- To change the face, send `face` and `background` together.

Avatars carry no `adminTags`. `avatars.create` and `avatars.update` throw `bad_request` before any network call if you pass it. Tag the parent **agent** instead.

## Intellects

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/intellect/list` | `{"filter":{},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/intellect/get` | `{"id":1389}` |
| Update | `POST /v1/intellect/update` | See § Configure an Intellect |
| Delete | `POST /v1/intellect/delete` | `{"id":1389}` |

Create (`POST /v1/intellect/add`) isn't listed here. See [build/intellect.md](build/intellect.md) for creating an intellect with the SDK's default-applying `mgmt.intellects.create()`.

Deleting an agent does **not** delete its avatar or intellect.

`mgmt.setForcedLanguage({ configId, agentId, language, languageName?, asrProvider? }, ks)` forces the reply language and the speech-recognition language in one idempotent call. Usage and options: [Languages](../LANGUAGES.md).

Typed setters on `mgmt.intellectConfig` for the other single-purpose fields, all `(configId, value, ks)` and idempotent:

| Setter | Field | Clear with |
|---|---|---|
| `setModelConfiguration` | `model_configuration` (`model_id`, `max_output_tokens`, `thinking_level` in `THINKING_LEVELS`, `include_thoughts`, `temperature`) | `null` |
| `setOpeningPhrase` | `opening_phrase` (the opening line of every avatar session; a template over `requestVars` and `sys__*`; `SILENT_OPENING` for no spoken opening, see [START-THE-CONVERSATION.md](../START-THE-CONVERSATION.md#personalize-the-opening)) | `null` |
| `setThreadStartTools` | `thread_start_tools`: unique tool ids run in order when a thread starts, before the first user turn[^1] | `[]` |
| `setAvatarSummaryConfig` | `avatar_summary_config` (`prompt`, `analysis`, `template`, `content_type` in `SUMMARY_CONTENT_TYPES`)[^2] | `null` |
| `setSkillIds` | `skill_ids` (`{ id, mode, condition? }`, `mode` in `SKILL_MODES`) | `[]` |

Each validates client-side and throws `bad_request` before any network call. See [build/intellect.md](build/intellect.md) for field semantics.

[^1]: Use `api` and `code` tools here. An `api` tool with `wait_for_response:false` runs without waiting; every other thread-start tool is waited for. The result is not given to the model. A failing tool does not fail the conversation. A thread-start tool never appears as a `tool` segment in the stream.

[^2]: `null` restores the defaults (`analysis: { summary }`, `template: '{{ summary }}'`, `content_type: 'text'`). Every `{{ key }}` in `template` must be an `analysis` key (or `summary` when `analysis` is unset). The SDK rejects a mismatch client-side. The summary is skipped entirely when the thread has no human messages.

## Tools

A standalone, partner-level entity, not embedded in an intellect. A name that is already in use returns 409. Skills below follow the same rule.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/tool/list` | `{"filter":{"objectType":"ToolListFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/tool/get` | `{"id":"TOOL_UUID"}` |
| Add | `POST /v1/tool/add` | `{"name":"...", "config":{...}}` |
| Update | `POST /v1/tool/update` | `{"id":"TOOL_UUID", "name"?, "config"?}` |
| Delete | `POST /v1/tool/delete` | `{"id":"TOOL_UUID"}` |

`mgmt.tools.delete` refuses by default with a typed `tool_in_use` error naming every intellect still listing the id in `tool_ids`. Pass `{confirmPermanent:true, force:true}` to delete anyway. Drop the id from each intellect's `tool_ids` first via `mgmt.intellectConfig.setToolIds`.

## Skills

A standalone, partner-level reusable-instruction entity: `{id (uuid), name, description, instructions, condition?}`. `condition` is a bare [condition](build/intellect.md#conditions) expression, checked before the call. A template form like `{{ x }}` throws `bad_request`. SDK: `mgmt.skills`. A name that is already in use returns 409. Tools above follow the same rule.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/skill/list` | `{"filter":{"objectType":"SkillListFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/skill/get` | `{"id":"SKILL_UUID"}` |
| Add | `POST /v1/skill/add` | `{"name":"...", "description":"...", "instructions"?, "condition"?}`. `name` may use only letters, digits, `_` and `-`. The SDK throws `bad_request` before the request otherwise. |
| Update | `POST /v1/skill/update` | `{"id":"SKILL_UUID", "name"?, "description"?, "instructions"?, "condition"?}`. Idempotent. `condition: ''` clears it. A rename to a name already in use returns 409 |
| Delete | `POST /v1/skill/delete` | `{"id":"SKILL_UUID"}`. Replies `{id}`. A follow-up get returns 404 |

**Variables in skills.** The `instructions` of a skill attached with mode `'preloaded'` render `{{ variable }}` placeholders and template tags, like prompt blocks. A literal `{{` or `{%` in instructions is read as template syntax, so avoid it in plain text.

**Shared skills.** A shared skill (`partner_id: 0`) appears in `skills.list` and can be attached with `setSkillIds`. `skills.get`, `skills.update` and `skills.delete` answer 404 `not_found` for it, so you cannot read, edit or delete it. `setSkillIds` rejects a skill id that does not exist or that you cannot use with 403 `forbidden`. `intellectConfig.audit` and `doctor` accept an attached shared skill.

Before deleting a Skill, `mgmt.skills.delete` lists every intellect and refuses with a typed `skill_in_use` error naming each one still referencing the id in `skill_ids`. Pass `{confirmPermanent:true, force:true}` to delete anyway. `mgmt.tools.delete` has the same guard with a `tool_in_use` error.

## Threads

Token rules per method: [operate.md § Threads](operate.md#threads). `threads.push` needs an admin token. Which threads a token can reach: [SECURITY.md § Session type](../../SECURITY.md#session-type). SDK: `mgmt.threads.{list, get, rename, setAnalysis, clearAnalysis, push, delete, transcript}`.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/thread/list` | `{"filter":{"objectType":"ListThreadFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/thread/get` | `{"id":"UUID"}` |
| Rename | `POST /v1/thread/update` | `{"id":"UUID","title":"New name"}` |
| Set analysis | `POST /v1/thread/update` | `{"id":"UUID","thread_metadata":{"analysis":{...}}}`. Shallow merge one level under `analysis`. A key whose value changes fires `analysis_updated`. A patch that changes nothing fires no event. SDK: `mgmt.threads.setAnalysis(id, patch, ks)`. |
| Clear analysis | `POST /v1/thread/update` | `{"id":"UUID","thread_metadata":{}}`. Clears `analysis`. SDK: `mgmt.threads.clearAnalysis(id, ks)`. |
| Push | `POST /thread/push` (no `v1/` prefix on this route) | `{"id":"UUID","content":"...","request_vars"?:{...},"system_message"?:"..."}`. `delivered:false` in the reply means no live socket is attached. The message is still saved and appears in the Messages list. SDK: `mgmt.threads.push({id,content,request_vars?,system_message?}, ks)`. A 403 that reports disabled client variables throws `client_variables_disabled`, as on converse. A body or `request_vars` over the server's size limit throws `payload_too_large`. |
| Delete | `POST /v1/thread/delete` | `{"thread_ids":["UUID"]}`. See [operate.md § Threads](operate.md#threads) for delete behavior |
| Transcript | `POST /v1/thread/get_transcripts` | `{"id":"UUID"}` |

**Filter fields (list):** `agentIdEquals`, `agentIdIn`, `contextIdEqual`, `createdAtGreaterThanOrEqual`, `createdAtLessThanOrEqual`, `idEquals`, `idsIn`, `isEverywhere`, `orderBy`, `originEquals`, `originIn`, `partnerIdEquals`, `statusEquals`, `statusIn`, `updatedAtGreaterThanOrEqual`, `updatedAtLessThanOrEqual`, `userIdEquals`. Origin values: [operate.md § Threads](operate.md#threads).

Rules to know:

- Put `orderBy` inside `filter` (one of `+createdAt`, `-createdAt`, `+updatedAt`, `-updatedAt`).
- Send `statusEquals`/`statusIn` as numbers, `0` or `1`.
- Use only the filter fields listed above. `partnerIdIn` is not supported.
- Pager is `{pageIndex, pageSize}` (1-based). Use `pageIndex`/`pageSize`, not `{offset, limit}`.
- `pageSize` is at most 500. This applies to every list and report pager in this section (Threads, Messages, Feedback).

SDK: `mgmt.threads.list(ks, opts)` merges `opts.filter` under the fixed `objectType`, so it can't be overridden. `agentIdEquals` filters by one agent, `agentIdIn` by several.

`request_vars` on `push` goes through the same reserved-name check as `converse`, before any network call. See [operate.md § Reserved Template Variables](operate.md#reserved-template-variables-sys__).

See [operate.md § Threads](operate.md#threads) for response shapes and delete behavior.

## Messages & Feedback

SDK: `mgmt.messages`, `mgmt.feedback`. `messages.list`, `get` and `share` accept an admin, conversation or agent token (see [operate.md § Threads](operate.md#threads)). `messages.report`, `messages.reportSummary` and `feedback.list` need an admin token.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List messages | `POST /message/list` | `{"filter":{"objectType":"GenieListMessageFilter"},"pager":{"pageIndex":1,"pageSize":50}}`. `opts.threadId` is sugar for `filter.threadIdEquals` and wins if both are given. |
| Share a message | `POST /message/share` | `{"id":"MSG_ID","newTitle":"..."}` → `{"status":"success","data":{"newMessageId":"..."}}`. SDK: `mgmt.messages.share(id, newTitle, ks)` unwraps this and returns `{newMessageId}`. It throws `server_error` if no id comes back. The clone is readable with `messages.get` and cannot be deleted. |
| Message report (CSV) | `POST /message/report` | `{"filter":{"objectType":"GenieListMessageFilter"}}`. ⚠️ SENSITIVE: contains end-user ids and names plus verbatim question and feedback text. SDK: `mgmt.messages.report(ks, opts)` (raw CSV) or `reportSummary(ks, opts)` (parsed, with a `_meta` provenance receipt). `reportSummary` uses `pageSize` 500 (the maximum) when you omit it. It reads one page only, so the totals cover at most `pageSize` rows. |
| Add feedback | `POST /feedback/add` | `{"schemaVersion":1,"data":{"message_id":"...","is_positive":true,"comment"?:"..."}}`. Idempotent for a given `(message_id, is_positive)` pair. Pass the conversation token of the user who sent the message. A token for any other user, admin included, can get `forbidden`. Read ratings back with `mgmt.feedback.list` (below). |
| List feedback | *(built on `/message/list`, no dedicated endpoint)* | `mgmt.feedback.list(ks, opts)`. Details below. |

**Message record** (`messages.list`, `messages.get`): `id`, `thread_id`, `genie_id`, `user_id`, `partner_id`, `created_at`, `updated_at`, `human` (the user text), `assistant` (a list of typed parts), `type`, `is_positive`, `comment`. `type` marks the kind of message, for example `0` for a normal turn and `4` for a message added with `threads.push`.

**List feedback in depth.** `mgmt.feedback.list(ks, opts)` reads feedback. It queries `POST /message/list` (and, for `filter.agentIdEquals`, `POST /v1/thread/list` first) and returns only the messages that carry a rating.

Filter: `messageIdEquals`, `messageIdsIn`, `threadIdEquals`, `agentIdEquals`, `isPositiveEquals`. `agentIdEquals` matches only threads opened with a token minted with that `agentId` (`createAgentToken`, or `createConversationToken` with `agentId`). It costs at least one message query per matching thread, and more for threads with many messages. Set at least one of `messageIdEquals`, `messageIdsIn`, `threadIdEquals` or `agentIdEquals`. With none set, it reads every message for the partner.

Unlike every other `list()` in this SDK, `await`ing `feedback.list(...)` collects **every** matching row across all underlying pages, not just the first page. Use a narrow filter.

Row shape: `{message_id, thread_id, genie_id, user_id, is_positive, comment, created_at, updated_at}`. ⚠️ SENSITIVE: comments are end-user-entered text.

Messages filter fields: `createdAtGreaterThanOrEqual`, `createdAtLessThanOrEqual`, `genieIdEquals`, `idEquals`, `idsIn`, `isPositiveEquals`, `isPositiveIn`, `orderBy`, `threadIdEquals`, `updatedAtGreaterThanOrEqual`, `updatedAtLessThanOrEqual`, `userIdEquals`. Send only the keys listed. Sort with `filter.orderBy`.

`threads.list` and `messages.list` merge `opts.filter` under a fixed `objectType` that you cannot override. `feedback.list` has its own filter shape (above).

## Knowledge records

Full record lifecycle. SDK: `mgmt.knowledge`. An intellect links to a record through `knowledge_ids`. See [build/knowledge-rag.md § Ground the Agent](build/knowledge-rag.md#ground-the-agent-in-your-content-rag).

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/knowledge/list` | `{"filter":{},"pager":{"pageIndex":1,"pageSize":30}}`. Finds records without knowing ids up front. SDK: `mgmt.knowledge.list(ks, opts)`. Distinct from `mgmt.knowledge.listCategoryEntries(categoryId, ks)`, which lists KMS entries inside one category, not Knowledge record containers. |
| Add | `POST /v1/knowledge/add` | `{"name":"..."}` |
| Get | `POST /v1/knowledge/get` | `{"id":2049}` |
| Update | `POST /v1/knowledge/update` | `{"id":2049, ...fields}`. Fields: `name`, `description`, `tags` (array of strings), `config`. When you send `config`, send the full config. To change sources, use `addSource`/`removeSource` below. |
| Delete | `POST /v1/knowledge/delete` | `{"id":2049}`. Returns HTTP 200 with body `null`. A follow-up get returns 404. |
| Per-entry status | `POST /v1/knowledge/entry_status` | `{"knowledge_id":2049, "entry_ids":["0_abc123"]}`. SDK: `mgmt.knowledge.entryStatus(id, entryIds, ks)`. |
| Upload | `POST /v1/knowledge/upload` | Starts an upload for a record and returns `{upload_token_id, entry_id, category_id}`. SDK: `mgmt.knowledge.upload(id, { fileName }, ks)`. Full usage: [build/knowledge-rag.md](build/knowledge-rag.md#ground-the-agent-in-your-content-rag). |

`mgmt.knowledge.isIndexed(id, ks)` wraps Get and reads `status`/`config.sources[].indexers[].index_position`. `status` does not tell you that indexing is complete. For the completion check, see [build/knowledge-rag.md § Ground the Agent](build/knowledge-rag.md#ground-the-agent-in-your-content-rag).

`mgmt.knowledge.addSource(id, source, ks)` / `removeSource(id, source, ks)` read-merge-write one source into/out of `config.sources` without disturbing the others. Both skip the write (`applied:false`) when an identical source object is already present / already absent. Call them one at a time for the same record id. Two overlapping calls can lose one of the changes.

Before deleting a record, `mgmt.knowledge.deleteRecord` lists every intellect and refuses with a typed `knowledge_in_use` error naming each one still carrying the id in `knowledge_ids`. Pass `{confirmPermanent:true, force:true}` to delete anyway. `mgmt.tools.delete` and `mgmt.skills.delete` use the same guard.

## Lifecycle

An event-driven rule engine, not embedded in an intellect. SDK: `mgmt.lifecycle`. Full reference (rule shape, action types, CRUD + discovery methods) and a worked recipe: **[docs/lifecycle/README.md](../lifecycle/README.md)**. To check existing rules, and a partner's agents and intellects, for mistakes, use `mgmt.lifecycle.audit`, `mgmt.intellectConfig.audit` and `mgmt.doctor`. They only read. See [Audit your rules](../lifecycle/README.md#audit-your-rules).

## Insight Settings

Reusable custom-insight definitions (`key`/`title`/`prompt`/`valueType`), referenced by id from a lifecycle rule's `triggerInsightSettingsKai` action. Not embedded in an intellect. SDK: `mgmt.insightSettings`. See [docs/lifecycle/README.md](../lifecycle/README.md).

| Operation | Endpoint | Body |
|-----------|----------|------|
| Create | `POST /v1/insight-settings/create` | `{"key":"NEXT_STEP","title":"Next step","prompt":"...","valueType":"string"}`. All 4 fields required |
| Get | `POST /v1/insight-settings/get` | `{"id":"<id>"}` |
| List | `POST /v1/insight-settings/list` | `{"filter":{"statusEqual":"active"},"pager":{"offset":0,"limit":30}}` |
| Update | `POST /v1/insight-settings/update` | `{"id":"<id>", ...fields}`. Any of `key`/`title`/`prompt`/`valueType`/`status` |
| Delete | `POST /v1/insight-settings/delete` | `{"id":"<id>"}`. Remove the id from every lifecycle rule that references it before you delete it |

Full reference and a worked recipe: **[docs/lifecycle/README.md § InsightSettings](../lifecycle/README.md#insightsettings-reusable-insight-definitions)**.
