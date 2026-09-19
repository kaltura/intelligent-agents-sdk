[← Back to the API Reference index](../../API-REFERENCE.md)

# Management Operations

All use the **admin KS**.

## Agents — `https://api.avatar.us.kaltura.ai`

| Operation | Endpoint | Body |
|-----------|----------|------|
| Create | `POST /v1/agent/create` | `{"displayName":"...", "intellect":{...}, "avatarIds":["24-char-hex"], "adminTags"?:["..."]}` |
| List | `POST /v1/agent/list` | `{"filter":{},"pager":{"offset":0,"limit":30}}` |
| Get | `POST /v1/agent/get` | `{"agentId":"UUID"}` |
| Update | `POST /v1/agent/update` | `{"agentId":"UUID", ...fields}` |
| Delete | `POST /v1/agent/delete` | `{"agentId":"UUID"}` |

Filter keys: `agentId`, `adminTagsIn`, `adminTagsNotIn`, `searchValue` (case-insensitive substring match on `displayName`/`agentId`). An unrecognized key 400s.

The request also takes a top-level `orderBy` (`+createdAt`, `-createdAt`, `+updatedAt`, `-updatedAt`; anything else 400s) — a separate field from `filter`. This differs from Threads/Messages below, where `orderBy` nests inside `filter`. SDK: `mgmt.agents.list(ks, opts)` passes `opts.filter` through as-is and does not take `orderBy`.

`mgmt.agents.delete` refuses to delete an agent whose `adminTags` match a production marker (`prod`, `production`, `keep`, `do-not-delete`, `live` — see `PROTECTED_TAGS` in `src/management/agents.js`). It only proceeds when called with `{confirmPermanent:true, allowProtected:true}`. This guards against an automated cleanup-by-tag sweep deleting a real, in-use agent.

## Avatars — `https://api.avatar.us.kaltura.ai`

| Operation | Endpoint | Body |
|-----------|----------|------|
| Create | `POST /v1/avatar/create` | `{"voice":{"id":"...","speed"?:1.0}, "visual"?:{"id":"...","motionControl"?:{...}}, "face"?:{"id":"..."}, "background"?:{"type":"color"\|"visual","value"?:"..."}, "templateId"?:"...", "name"?:"...", "openingPhrase"?:"..."}` (`openingPhrase` non-empty; `SILENT_OPENING` for no spoken opening). Visual resolution rules: [build/avatar-and-agent.md § Three ways to get a visual](build/avatar-and-agent.md#three-ways-to-get-a-visual). |
| List | `POST /v1/avatar/list` | `{"pager":{"offset":0,"limit":30}}` |
| Get | `POST /v1/avatar/get` | `{"id":"24-char-hex"}` |
| Update | `POST /v1/avatar/update` | `{"id":"24-char-hex", ...fields}` — PATCH semantics (omitted fields are preserved); `templateId` is create-only (400 on update) |
| Delete | `POST /v1/avatar/delete` | `{"id":"24-char-hex"}` |
| List templates | `POST /v1/avatar-template/list` | `{"pager":{"offset":0,"limit":30}}` — curated presets, each pairing a `voice` with either a ready `visual` or a `face`/`background` pair ([build/avatar-and-agent.md § Three ways to get a visual](build/avatar-and-agent.md#three-ways-to-get-a-visual)). SDK: `mgmt.avatars.listTemplates(ks, opts)`. |

**Recomposing on update is asymmetric, unlike create** (where `face`/`background` must travel together). The rule depends on the avatar's existing state:

- `background` alone recomposes against the avatar's current face — a valid "just change the background" update.
- `face` alone is accepted but silently a no-op: there's nothing to pair it with, so the existing visual is left untouched.

`avatars.update` does NOT reject either half alone.

`avatar/create` accepts and stores `adminTags`, and `avatar/list adminTagsIn` finds it. But no read path ever returns it, and `avatar/update` genuinely rejects it (no tag field on that request body). The SDK throws pre-network on either path rather than let you rely on a write-only field — tag the parent **agent** instead.

## Intellects — `https://genie.nvp1.ovp.kaltura.com`

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/intellect/list` | `{"filter":{},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/intellect/get` | `{"id":1389}` |
| Update | `POST /v1/intellect/update` | See § Configure an Intellect |
| Delete | `POST /v1/intellect/delete` | `{"id":1389}` |

Deleting an agent does **not** delete its avatar or intellect.

`mgmt.setForcedLanguage({ configId, agentId, language }, ks)` forces the reply language. It sets `force_language` on the intellect (the backend enforces it at runtime) and the agent's `asr.language` in one call. Idempotent; `language: null` clears both. See [README § Forcing the reply language](../../README.md#forcing-the-reply-language-setforcedlanguage).

Typed setters on `mgmt.intellectConfig` for the other single-purpose fields, all `(configId, value, ks)` and idempotent:

| Setter | Field | Clear with |
|---|---|---|
| `setModelConfiguration` | `model_configuration` (`model_id` in `MODEL_IDS`, `max_output_tokens`, `thinking_level` in `THINKING_LEVELS`, `temperature`) | `null` |
| `setOpeningPhrase` | `opening_phrase` (Jinja2 over `request_vars`, avatar sessions; overrides the avatar's `openingPhrase`; `SILENT_OPENING` for no spoken opening, see [START-THE-CONVERSATION.md](../START-THE-CONVERSATION.md)) | `null` |
| `setThreadStartTools` | `thread_start_tools` (tool ids run once at thread start) | `[]` |
| `setAvatarSummaryConfig` | `avatar_summary_config` (`prompt`, `analysis`, `template`, `content_type` in `SUMMARY_CONTENT_TYPES`) | `null` |
| `setSkillIds` | `skill_ids` (`{ id, mode, condition? }`, `mode` in `SKILL_MODES`) | `[]` |

Each validates client-side and throws `bad_request` before any network call. See [build/intellect.md](build/intellect.md) for field semantics.

## Tools — `https://genie.nvp1.ovp.kaltura.com`

A standalone, partner-level entity (see § Tools above) — not embedded in an intellect.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/tool/list` | `{"filter":{"objectType":"ToolListFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/tool/get` | `{"id":"TOOL_UUID"}` |
| Add | `POST /v1/tool/add` | `{"name":"...", "config":{...}}` |
| Update | `POST /v1/tool/update` | `{"id":"TOOL_UUID", "name"?, "config"?}` |
| Delete | `POST /v1/tool/delete` | `{"id":"TOOL_UUID"}` |

Deleting a Tool does **not** cascade: an intellect that still lists the id in `tool_ids` keeps a dangling reference. Drop it first via `mgmt.intellectConfig.setToolIds`.

## Skills — `https://genie.nvp1.ovp.kaltura.com`

A standalone, partner-level reusable-instruction entity — `{id (uuid), name, description, instructions}`. SDK: `mgmt.skills`. A Skill's `name` is checked against your partner id OR partner `0` (a shared global pool), so a name can collide with a global-pool Skill in ways invisible from a partner-scoped `list()`. The same nuance applies to Tools below.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/skill/list` | `{"filter":{"objectType":"SkillListFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/skill/get` | `{"id":"SKILL_UUID"}` |
| Add | `POST /v1/skill/add` | `{"name":"...", "description":"...", "instructions"?}` |
| Update | `POST /v1/skill/update` | `{"id":"SKILL_UUID", "name"?, "description"?, "instructions"?}` — idempotent; renames re-check the same partner-unique-name constraint as Add (409 on conflict) |
| Delete | `POST /v1/skill/delete` | `{"id":"SKILL_UUID"}` — replies `{id}`; a follow-up get 404s |

Before deleting a Skill, `mgmt.skills.delete` lists every intellect and refuses with a typed `skill_in_use` error naming each one still referencing the id in `skill_ids`. It only proceeds when called with `{confirmPermanent:true, force:true}`. Tools' `mgmt.tools.delete` carries the identical `tool_in_use` guard.

## Threads — `https://genie.nvp1.ovp.kaltura.com`

All thread endpoints require an **admin KS** (`disableentitlement`). SDK: `mgmt.threads.{list, get, rename, setAnalysis, clearAnalysis, push, delete, transcript}`.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/thread/list` | `{"filter":{"objectType":"ListThreadFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/thread/get` | `{"id":"UUID"}` |
| Rename | `POST /v1/thread/update` | `{"id":"UUID","title":"New name"}` |
| Set analysis | `POST /v1/thread/update` | `{"id":"UUID","thread_metadata":{"analysis":{...}}}` — shallow merge one level under `analysis`; a changed key fires the lifecycle `analysis_updated` event. SDK: `mgmt.threads.setAnalysis(id, patch, ks)`. |
| Clear analysis | `POST /v1/thread/update` | `{"id":"UUID","thread_metadata":{}}` — wipes `analysis` (the only field `ThreadMetadata` has). SDK: `mgmt.threads.clearAnalysis(id, ks)`. |
| Push | `POST /thread/push` (no `v1/` prefix on this route) | `{"id":"UUID","content":"...","request_vars"?:{...},"system_message"?:"..."}` — `delivered:false` in the reply means no live socket is attached. The message still persists: it shows up in Messages list as `type:4` (`MessageType.EXTERNAL_PUSH`). `content` over a server-side, partner-configurable length cap returns `413 content exceeds max_message_length` — not checked client-side. SDK: `mgmt.threads.push({id,content,request_vars?,system_message?}, ks)`. |
| Delete | `POST /v1/thread/delete` | `{"thread_ids":["UUID"]}` — soft delete, followed by a scheduled infra-level purge |
| Transcript | `POST /v1/thread/get_transcripts` | `{"id":"UUID"}` |

**Filter fields (list):** `agentIdEquals`, `contextIdEqual`, `createdAtGreaterThanOrEqual`, `createdAtLessThanOrEqual`, `idEquals`, `idsIn`, `isEverywhere`, `orderBy`, `partnerIdEquals`, `statusEquals`, `statusIn`, `updatedAtGreaterThanOrEqual`, `updatedAtLessThanOrEqual`, `userIdEquals`.

Rules to know:

- `orderBy` goes INSIDE `filter` (one of `+createdAt`, `-createdAt`, `+updatedAt`, `-updatedAt`). A top-level `orderBy` 422s.
- `statusEquals`/`statusIn` take `0`/`1`. A numeric string (`"0"`) is silently coerced and accepted, but a non-numeric string 422s.
- An unknown filter key 422s. `partnerIdIn` always 422s.
- Pager is `{pageIndex, pageSize}` (1-based) — `{offset, limit}` is ignored and returns the default page of 30.
- `pageSize` is capped server-side at 500; a higher value 422s. This applies to every Genie-backed list/report pager in this section (Threads, Messages, Feedback, Followups).

SDK: `mgmt.threads.list(ks, opts)` merges `opts.filter` under the fixed `objectType`, so it can't be overridden. It translates `agentIdEquals` to the server's own agent-scoping filter key on the wire. There's no server-side "in" equivalent for it: `agentIdIn` throws a `validation_error` before any network call rather than being silently dropped.

`request_vars` on `push` is validated by the SDK's own reserved-name guard before any network call, identically to `converse` — see [operate.md § Reserved Template Variables](operate.md#reserved-template-variables-sys__).

See [operate.md § Threads](operate.md#threads) for response shapes and the compliance note on delete's soft-delete/purge timing.

## Messages, Feedback & Followups — `https://genie.nvp1.ovp.kaltura.com`

SDK: `mgmt.messages`, `mgmt.feedback`, `mgmt.followups`.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List messages | `POST /message/list` | `{"filter":{"objectType":"GenieListMessageFilter"},"pager":{"pageIndex":1,"pageSize":50}}` — `opts.threadId` is sugar for `filter.threadIdEquals` and wins if both are given. |
| Share a message | `POST /message/share` | `{"id":"MSG_ID","newTitle":"..."}` → `{newMessageId}` |
| Message report (CSV) | `POST /message/report` | `{"filter":{"objectType":"GenieListMessageFilter"}}` — ⚠️ SENSITIVE: contains end-user ids/names + verbatim question/feedback text. SDK: `mgmt.messages.report(ks, opts)` (raw CSV) / `reportSummary(ks, opts)` (parsed, with a `_meta` provenance receipt) — `reportSummary` defaults `pageSize` to 500 (the server-side max) when omitted. |
| Add feedback | `POST /feedback/add` | `{"schemaVersion":1,"data":{"message_id":"...","is_positive":true,"comment"?:"..."}}` — idempotent for a given `(message_id, is_positive)` pair. Any KS (conversation or admin). Writes `is_positive`/`comment` onto the rated message itself, which is why `mgmt.feedback.list` (below) can read feedback back from `mgmt.messages`. |
| List feedback | *(sourced from `/message/list`, not a dedicated endpoint)* | `mgmt.feedback.list(ks, opts)` — see below for details. |
| Suggested followups | `POST /followup/get-suggested-questions?new_response=true` | `{}` — starter questions for the partner/agent, NOT thread-scoped. The returned set can vary between calls — don't assume a stable, fixed list; `[]` when none configured. Distinct from per-answer followups (`capabilities.generate_followup_questions:on` on converse). SDK: `mgmt.followups.getSuggested(ks)`. |
| List followup records | `POST /followup/list` | `{"filter":{"objectType":"GenieListQuestionFilter"},"pager":{"pageIndex":1,"pageSize":30}}` — the raw partner-wide record listing, not the shortlist above. |

**List feedback in depth.** `mgmt.feedback.list(ks, opts)` is the correct, permanent way to read feedback, not a stopgap. It queries `POST /message/list` (and, for `filter.agentIdEquals`, `POST /v1/thread/list` first) and returns only the messages carrying a rating.

Filter: `messageIdEquals`, `messageIdsIn`, `threadIdEquals`, `agentIdEquals`, `isPositiveEquals`. `agentIdEquals` only matches threads opened via `sessions.createAgentToken`, and costs one thread query per matching thread. With none of `messageIdEquals`/`messageIdsIn`/`threadIdEquals`/`agentIdEquals` set, it walks every message for the partner — scope it.

Row shape: `{message_id, thread_id, genie_id, user_id, is_positive, comment, created_at, updated_at}`. ⚠️ SENSITIVE: comments are end-user-entered text.

Messages filter fields: `createdAtGreaterThanOrEqual`, `createdAtLessThanOrEqual`, `genieIdEquals`, `idEquals`, `idsIn`, `isPositiveEquals`, `isPositiveIn`, `orderBy`, `threadIdEquals`, `updatedAtGreaterThanOrEqual`, `updatedAtLessThanOrEqual`, `userIdEquals`. Unlike Threads, an unknown key here is silently ignored (200), not rejected. Only `filter.orderBy` sorts — a top-level `orderBy` is accepted but has no effect.

`threads.list`/`messages.list`/`followups.list` merge `opts.filter` under a fixed, mandatory `objectType` the caller can't override. `feedback.list` has its own filter shape (above), not that pattern.

## Knowledge records — `https://genie.nvp1.ovp.kaltura.com`

Full record lifecycle. SDK: `mgmt.knowledge`. Linkage to an intellect is via `knowledge_ids` — see § Ground the Agent.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/knowledge/list` | `{"filter":{},"pager":{"pageIndex":1,"pageSize":30}}` — discover records without knowing ids up front. SDK: `mgmt.knowledge.list(ks, opts)`. Distinct from `mgmt.knowledge.listCategoryEntries(categoryId, ks)`, which lists KMS entries inside one category, not Knowledge record containers. |
| Add | `POST /v1/knowledge/add` | `{"name":"..."}` |
| Get | `POST /v1/knowledge/get` | `{"id":2049}` |
| Update | `POST /v1/knowledge/update` | `{"id":2049, ...fields}` — `config` is accepted but is a FULL REPLACE on the backend; use `addSource`/`removeSource` below instead of hand-assembling `config.sources` |
| Delete | `POST /v1/knowledge/delete` | `{"id":2049}` — HTTP 200, body `null`; a follow-up get 404s |
| Per-entry status | `POST /v1/knowledge/entry_status` | `{"knowledge_id":2049, "entry_ids":["0_abc123"]}`. SDK: `mgmt.knowledge.entryStatus(id, entryIds, ks)`. |

`mgmt.knowledge.isIndexed(id, ks)` wraps Get and reads `status`/`config.sources[].indexers[].index_position`. `status` is the record's own container-lifecycle flag, not an indexing-completion signal: see [build/knowledge-rag.md § Ground the Agent](build/knowledge-rag.md#ground-the-agent-in-your-content-rag) for why, and for the real indexing-completion check.

`mgmt.knowledge.addSource(id, source, ks)` / `removeSource(id, source, ks)` read-merge-write one source into/out of `config.sources` without disturbing the others. Both skip the write (`applied:false`) when an identical source object is already present / already absent.

Before deleting a record, `mgmt.knowledge.deleteRecord` lists every intellect and refuses with a typed `knowledge_in_use` error naming each one still carrying the id in `knowledge_ids`. It only proceeds when called with `{confirmPermanent:true, force:true}` — the same guard `mgmt.tools.delete`/`mgmt.skills.delete` run for their own entities.

## Lifecycle — `https://api.avatar.us.kaltura.ai`

An event-driven rule engine, not embedded in an intellect. SDK: `mgmt.lifecycle`. Full reference (rule shape, all 4 action types, CRUD + discovery methods) and a worked recipe: **[docs/lifecycle/README.md](../lifecycle/README.md)**.

## Insight Settings — `https://api.avatar.us.kaltura.ai`

Reusable custom-insight definitions (`key`/`title`/`prompt`/`valueType`), referenced by id from a lifecycle rule's `triggerInsightSettingsKai` action — not embedded in an intellect. SDK: `mgmt.insightSettings`. See [docs/lifecycle/README.md](../lifecycle/README.md).

| Operation | Endpoint | Body |
|-----------|----------|------|
| Create | `POST /v1/insight-settings/create` | `{"key":"NEXT_STEP","title":"Next step","prompt":"...","valueType":"string"}` — all 4 fields required |
| Get | `POST /v1/insight-settings/get` | `{"id":"<id>"}` |
| List | `POST /v1/insight-settings/list` | `{"filter":{"statusEqual":"active"},"pager":{"offset":0,"limit":30}}` |
| Update | `POST /v1/insight-settings/update` | `{"id":"<id>", ...fields}` — any of `key`/`title`/`prompt`/`valueType`/`status` |
| Delete | `POST /v1/insight-settings/delete` | `{"id":"<id>"}` — succeeds even while a lifecycle rule still references the id; that rule keeps firing and just skips the deleted id, with no error anywhere |

Full reference and a worked recipe: **[docs/lifecycle/README.md § InsightSettings](../lifecycle/README.md#insightsettings-reusable-insight-definitions)**.
