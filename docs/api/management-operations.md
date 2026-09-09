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

Filter keys: `agentId`, `adminTagsIn`, `adminTagsNotIn`, `searchValue` (case-insensitive substring match on `displayName`/`agentId`); an unrecognized key 400s. `adminTagsIn`/`adminTagsNotIn`/`searchValue` are accepted on NVQ2 today; PROD 400s them until it takes the backend deploy that adds them. The request also takes a top-level `orderBy` (`+createdAt`, `-createdAt`, `+updatedAt`, `-updatedAt`; anything else 400s) — a separate field from `filter`, unlike Threads/Messages below where `orderBy` nests inside `filter`. SDK: `mgmt.agents.list(ks, opts)` passes `opts.filter` through as-is; it does not yet expose `orderBy`.

`mgmt.agents.delete` refuses to delete an agent whose `adminTags` match a production marker (`prod`, `production`, `keep`, `do-not-delete`, `live` — see `PROTECTED_TAGS` in `src/management/agents.js`), unless called with `{confirmPermanent:true, allowProtected:true}`. This guards against an automated cleanup-by-tag sweep deleting a real, in-use agent.

## Avatars — `https://api.avatar.us.kaltura.ai`

| Operation | Endpoint | Body |
|-----------|----------|------|
| Create | `POST /v1/avatar/create` | `{"voice":{"id":"...","speed"?:1.0}, "visual"?:{"id":"...","motionControl"?:{...}}, "face"?:{"id":"..."}, "background"?:{"type":"color"\|"visual","value":"..."}, "templateId"?:"...", "name"?:"...", "openingPhrase"?:"..."}` — see § Compose a visual, below. |
| List | `POST /v1/avatar/list` | `{"pager":{"offset":0,"limit":30}}` |
| Get | `POST /v1/avatar/get` | `{"id":"24-char-hex"}` |
| Update | `POST /v1/avatar/update` | `{"id":"24-char-hex", ...fields}` — PATCH semantics (omitted fields are preserved); `templateId` is create-only (400 on update) |
| Delete | `POST /v1/avatar/delete` | `{"id":"24-char-hex"}` |
| List templates | `POST /v1/avatar-template/list` | `{"pager":{"offset":0,"limit":30}}` — curated `{voice,face}` presets (§ Create an Avatar). SDK: `mgmt.avatars.listTemplates(ks, opts)`. |

**Compose a visual** — `create`/`update` need exactly one of: (1) `visual:{id}` (wins if combined with `face`/`background`); (2) `face:{id}` + `background:{type,value}` composing a NEW visual (both required together, UNLESS `templateId` is also given — it supplies its own face); (3) `templateId` + a `background`/`visual` to resolve it (`templateId` alone is a domain failure). Full walkthrough, including `catalog.createFace`/`createBackground`: [build/avatar-and-agent.md § Three ways to get a visual](build/avatar-and-agent.md#three-ways-to-get-a-visual).

An incomplete/invalid `face`/`background` pairing is a HTTP-200 `KalturaAPIException` (`AVATAR_MISSING_VISUAL_RESOLUTION`, `AVATAR_FAILED_TO_COMPOSE_VISUAL`, `AVATAR_MISSING_VOICE`, `AVATAR_NOT_FOUND`) — the SDK's `avatars.create`/`update` catch the incomplete-pairing case pre-network. The composed result is reflected in `visual.composition` and a fresh raw `previewImageUrl`/`loadingVideoUrl` — inspect those to see what was actually built.

`avatar/create` accepts and stores `adminTags`, and `avatar/list adminTagsIn` finds it, but no read path ever returns it and `avatar/update` genuinely rejects it (no tag field on `UpdateAvatarDto`). The SDK throws pre-network on either path rather than let you rely on a write-only field — tag the parent **agent** instead.

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
| `setOpeningPhrase` | `opening_phrase` (Jinja2 over `request_vars`, avatar sessions) | `null` |
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

A standalone, partner-level reusable-instruction entity — `{id (uuid), name, description, instructions}`. SDK: `mgmt.skills`. A Skill's `name` is checked against your partner id OR partner `0` (a shared global pool), so a name can collide with a global-pool Skill in ways invisible from a partner-scoped `list()` — the same nuance applies to Tools below.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/skill/list` | `{"filter":{"objectType":"SkillListFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/skill/get` | `{"id":"SKILL_UUID"}` |
| Add | `POST /v1/skill/add` | `{"name":"...", "description":"...", "instructions"?}` |
| Update | `POST /v1/skill/update` | `{"id":"SKILL_UUID", "name"?, "description"?, "instructions"?}` — idempotent; renames re-check the same partner-unique-name constraint as Add (409 on conflict) |
| Delete | `POST /v1/skill/delete` | `{"id":"SKILL_UUID"}` — replies `{id}`; a follow-up get 404s |

Before deleting a Skill, `mgmt.skills.delete` lists every intellect and refuses with a typed `skill_in_use` error naming each one still referencing the id in `skill_ids`, unless called with `{confirmPermanent:true, force:true}`. Tools' `mgmt.tools.delete` carries the identical `tool_in_use` guard.

## Threads — `https://genie.nvp1.ovp.kaltura.com`

All thread endpoints require an **admin KS** (`disableentitlement`). SDK: `mgmt.threads.{list, get, rename, setAnalysis, clearAnalysis, push, delete, transcript}`.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/thread/list` | `{"filter":{"objectType":"ListThreadFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/thread/get` | `{"id":"UUID"}` |
| Rename | `POST /v1/thread/update` | `{"id":"UUID","title":"New name"}` |
| Set analysis | `POST /v1/thread/update` | `{"id":"UUID","thread_metadata":{"analysis":{...}}}` — shallow merge one level under `analysis`; a changed key fires the lifecycle `analysis_updated` event. SDK: `mgmt.threads.setAnalysis(id, patch, ks)`. |
| Clear analysis | `POST /v1/thread/update` | `{"id":"UUID","thread_metadata":{}}` — wipes `analysis` (the only field `ThreadMetadata` has). SDK: `mgmt.threads.clearAnalysis(id, ks)`. |
| Push | `POST /thread/push` (legacy Genie route, no `v1/` prefix — `v1/thread/push` does not exist) | `{"id":"UUID","content":"...","request_vars"?:{...},"system_message"?:"..."}` — `delivered:false` in the reply means no live socket is attached; the message still persists (shows up in Messages list as `type:4`, `MessageType.EXTERNAL_PUSH`). SDK: `mgmt.threads.push({id,content,request_vars?,system_message?}, ks)`. |
| Delete | `POST /v1/thread/delete` | `{"thread_ids":["UUID"]}` — soft delete, followed by a scheduled infra-level purge |
| Transcript | `POST /v1/thread/get_transcripts` | `{"id":"UUID"}` |

Filter fields (list): `agentIdEquals`, `agentIdIn`, `contextIdEqual`, `createdAtGreaterThanOrEqual`, `createdAtLessThanOrEqual`, `idEquals`, `idsIn`, `isEverywhere`, `orderBy`, `partnerIdEquals`, `statusEquals`, `statusIn`, `updatedAtGreaterThanOrEqual`, `updatedAtLessThanOrEqual`, `userIdEquals`. `orderBy` goes INSIDE `filter` (one of `+createdAt`, `-createdAt`, `+updatedAt`, `-updatedAt`); a top-level `orderBy` 422s. `statusEquals`/`statusIn` take `0`/`1` (a string 422s). An unknown filter key 422s; `partnerIdIn` always 422s. Pager is `{pageIndex, pageSize}` (1-based) — `{offset, limit}` is ignored and returns the default page of 30. SDK: `mgmt.threads.list(ks, opts)` merges `opts.filter` under the fixed `objectType` (so it can't be overridden).

`request_vars` on `push` runs through the same reserved-name guard as `converse` — see [operate.md § Reserved Template Variables](operate.md#reserved-template-variables-sys__).

See [operate.md § Threads](operate.md#threads) for response shapes and the compliance note on delete's soft-delete/purge timing.

## Messages, Feedback & Followups — `https://genie.nvp1.ovp.kaltura.com`

SDK: `mgmt.messages`, `mgmt.feedback`, `mgmt.followups`.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List messages | `POST /message/list` | `{"filter":{"objectType":"GenieListMessageFilter"},"pager":{"pageIndex":1,"pageSize":50}}` — `opts.threadId` is sugar for `filter.threadIdEquals` and wins if both are given. |
| Share a message | `POST /message/share` | `{"id":"MSG_ID","newTitle":"..."}` → `{newMessageId}` |
| Message report (CSV) | `POST /message/report` | `{"filter":{"objectType":"GenieListMessageFilter"}}` — ⚠️ SENSITIVE: contains end-user ids/names + verbatim question/feedback text. SDK: `mgmt.messages.report(ks, opts)` (raw CSV) / `reportSummary(ks, opts)` (parsed, with a `_meta` provenance receipt). |
| Add feedback | `POST /feedback/add` | `{"schemaVersion":1,"data":{"message_id":"...","is_positive":true,"comment"?:"..."}}` — idempotent for a given `(message_id, is_positive)` pair. Any KS (conversation or admin). |
| List feedback | `POST /feedback/list` | `{"filter":{"objectType":"GenieListFeedbackFilter"},"pager":{"pageIndex":1,"pageSize":30}}` — `filter:{}` alone (no `objectType`) 400s `invalid_filter`. |
| Feedback report (CSV) | `POST /feedback/report` | `{"filter":{"objectType":"GenieListFeedbackFilter"}}` — replies an empty body when the partner has none; the SDK returns `null` in that case rather than throwing. |
| Suggested followups | `POST /followup/get-suggested-questions?new_response=true` | `{}` — pre-configured starter questions for the partner/agent, NOT thread-scoped; `[]` when none configured. Distinct from per-answer followups (`capabilities.generate_followup_questions:on` on converse). SDK: `mgmt.followups.getSuggested(ks)`. |
| List followup records | `POST /followup/list` | `{"filter":{"objectType":"GenieListQuestionFilter"},"pager":{"pageIndex":1,"pageSize":30}}` — the raw partner-wide record listing, not the shortlist above. |

Messages filter fields: `createdAtGreaterThanOrEqual`, `createdAtLessThanOrEqual`, `genieIdEquals`, `idEquals`, `idsIn`, `isPositiveEquals`, `isPositiveIn`, `orderBy`, `threadIdEquals`, `updatedAtGreaterThanOrEqual`, `updatedAtLessThanOrEqual`, `userIdEquals`. Unlike Threads, an unknown key here is silently ignored (200), not rejected. Only `filter.orderBy` sorts — a top-level `orderBy` is accepted but has no effect.

All three `list()` methods merge `opts.filter` under a fixed, mandatory `objectType` the caller can't override.

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

Before deleting a record, `mgmt.knowledge.deleteRecord` lists every intellect and refuses with a typed `knowledge_in_use` error naming each one still carrying the id in `knowledge_ids`, unless called with `{confirmPermanent:true, force:true}` — the same guard `mgmt.tools.delete`/`mgmt.skills.delete` run for their own entities.

## Lifecycle — `https://api.avatar.us.kaltura.ai`

An event-driven rule engine, not embedded in an intellect. SDK: `mgmt.lifecycle`. Full reference (rule shape, all 4 action types, CRUD + discovery methods) and a worked recipe: **[docs/lifecycle/README.md](../lifecycle/README.md)**.
