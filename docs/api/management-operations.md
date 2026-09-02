[← Back to the API Reference index](../../API-REFERENCE.md)

# Management Operations

All use the **admin KS**.

## Agents — `https://api.avatar.us.kaltura.ai`

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/agent/list` | `{"filter":{},"pager":{"offset":0,"limit":30}}` |
| Get | `POST /v1/agent/get` | `{"agentId":"UUID"}` |
| Update | `POST /v1/agent/update` | `{"agentId":"UUID", ...fields}` |
| Delete | `POST /v1/agent/delete` | `{"agentId":"UUID"}` |

`agent/list` has no server-side filtering — always send `"filter":{}` and filter client-side.

`mgmt.agents.delete` refuses to delete an agent whose `adminTags` match a production marker (`prod`, `production`, `keep`, `do-not-delete`, `live` — see `PROTECTED_TAGS` in `src/management/agents.js`), unless called with `{confirmPermanent:true, allowProtected:true}`. This guards against an automated cleanup-by-tag sweep deleting a real, in-use agent.

## Avatars — `https://api.avatar.us.kaltura.ai`

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/avatar/list` | `{"pager":{"offset":0,"limit":30}}` |
| Get | `POST /v1/avatar/get` | `{"id":"24-char-hex"}` |
| Update | `POST /v1/avatar/update` | `{"id":"24-char-hex", ...fields}` |
| Delete | `POST /v1/avatar/delete` | `{"id":"24-char-hex"}` |
| List templates | `POST /v1/avatar-template/list` | `{"pager":{"offset":0,"limit":30}}` — curated `{voice,face}` presets (§ Create an Avatar). SDK: `mgmt.avatars.listTemplates(ks, opts)`. |

## Intellects — `https://genie.nvp1.ovp.kaltura.com`

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/intellect/list` | `{"filter":{},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/intellect/get` | `{"id":1389}` |
| Update | `POST /v1/intellect/update` | See § Configure an Intellect |
| Delete | `POST /v1/intellect/delete` | `{"id":1389}` |

Deleting an agent does **not** delete its avatar or intellect.

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

All thread endpoints require an **admin KS** (`disableentitlement`). SDK: `mgmt.threads.{list, get, rename, delete, transcript}`.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/thread/list` | `{"filter":{"objectType":"ListThreadFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/thread/get` | `{"id":"UUID"}` |
| Rename | `POST /v1/thread/update` | `{"id":"UUID","title":"New name"}` |
| Delete | `POST /v1/thread/delete` | `{"thread_ids":["UUID"]}` — soft delete, followed by a scheduled infra-level purge |
| Transcript | `POST /v1/thread/get_transcripts` | `{"id":"UUID"}` |

See [operate.md § Threads](operate.md#threads) for response shapes and the compliance note on delete's soft-delete/purge timing.

## Knowledge records — `https://genie.nvp1.ovp.kaltura.com`

Full record lifecycle. SDK: `mgmt.knowledge`. Linkage to an intellect is via `knowledge_ids` — see § Ground the Agent.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/knowledge/list` | `{"filter":{},"pager":{"pageIndex":1,"pageSize":30}}` — discover records without knowing ids up front. SDK: `mgmt.knowledge.listRecords(ks, opts)`. Distinct from `mgmt.knowledge.list(categoryId, ks)`, which lists KMS entries inside a category, not Knowledge record containers. |
| Add | `POST /v1/knowledge/add` | `{"name":"..."}` |
| Get | `POST /v1/knowledge/get` | `{"id":2049}` |
| Update | `POST /v1/knowledge/update` | `{"id":2049, ...fields}` — `config` is accepted but is a FULL REPLACE on the backend; use `addSource`/`removeSource` below instead of hand-assembling `config.sources` |
| Delete | `POST /v1/knowledge/delete` | `{"id":2049}` — HTTP 200, body `null`; a follow-up get 404s |
| Per-entry status *(not yet GA on every deployment — check with your Kaltura account team)* | `POST /v1/knowledge/entry_status` | `{"knowledge_id":2049, "entry_ids":["0_abc123"]}` |

`mgmt.knowledge.isIndexed(id, ks)` wraps Get and reads `status`/`config.sources[].indexers[].index_position`. `status` is the record's own container-lifecycle flag, not an indexing-completion signal: see [build.md § Ground the Agent](build.md#ground-the-agent-in-your-content-rag) for why, and for the real indexing-completion check.

`mgmt.knowledge.addSource(id, source, ks)` / `removeSource(id, source, ks)` read-merge-write one source into/out of `config.sources` without disturbing the others — both idempotent (`applied:false` if the source is already present / already absent).

Before deleting a record, `mgmt.knowledge.deleteRecord` lists every intellect and refuses with a typed `knowledge_in_use` error naming each one still carrying the id in `knowledge_ids`, unless called with `{confirmPermanent:true, force:true}` — the same guard `mgmt.tools.delete`/`mgmt.skills.delete` run for their own entities.

## Lifecycle — `https://api.avatar.us.kaltura.ai`

An event-driven rule engine (§ Lifecycle in [Phase 2 — Build](build.md)) — not embedded in an intellect. SDK: `mgmt.lifecycle`.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/lifecycle/list` | `{"filter":{},"pager":{"offset":0,"limit":30}}` |
| Get | `POST /v1/lifecycle/get` | `{"id":"RULE_UUID"}` |
| Create | `POST /v1/lifecycle/create` | `{"name":"...", "systemName":"...", "eventType":"...", "objectType":"thread", "action":{...}}` |
| Update | `POST /v1/lifecycle/update` | `{"id":"RULE_UUID", ...fields}` — idempotent |
| Delete | `POST /v1/lifecycle/delete` | `{"id":"RULE_UUID"}` — replies `{success}`, not `{id}` |
| Match (dry-run) | `POST /v1/lifecycle/match` | `{"objectType":"thread", "eventType":"session_ended", "eventData":{"object":{...}}}` |
| List object types | `POST /v1/lifecycle/listObjects` | `{}` |
| List events for a type | `POST /v1/lifecycle/listEvents` | `{"objectType":"thread"}` |
| Describe filterable fields | `POST /v1/lifecycle/describeFields` | `{"objectType":"thread", "eventType":"session_ended"}` |

Production ships a system-seeded preset rule (`preset__overridable_summary_on_session_ended`) that matches every `session_ended`/`thread` event for every partner by default — `match`'s response can include it grouped alongside your own rules (see § Lifecycle for a worked example).
