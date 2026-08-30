---
layout: base.njk
title: "API · Management Operations"
description: "CRUD endpoints for agents, avatars, intellects, tools, skills, knowledge records, and Lifecycle rules."
eyebrow: Reference
---

[← API Reference index](/reference/api-reference/)

# Management operations

All use the **admin KS**.

## Agents — `https://api.avatar.us.kaltura.ai`

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/agent/list` | `{"filter":{},"pager":{"offset":0,"limit":30}}` |
| Get | `POST /v1/agent/get` | `{"agentId":"UUID"}` |
| Embed snippet | `POST /v1/agent/getEmbedScript` | `{"agentId":"UUID","embedType":"contained\|page\|floater"}` |
| Update | `POST /v1/agent/update` | `{"agentId":"UUID", ...fields}` |
| Delete | `POST /v1/agent/delete` | `{"agentId":"UUID"}` |

`agent/list` has no server-side filtering — always send `"filter":{}` and filter client-side.

`agent/getEmbedScript` replies `{"objectType":"Object","html":"<script…>"}` — a ready-to-paste `<script type='module'>` snippet that loads Kaltura's embeds loader and renders the agent's chat widget (`apis.genieChat.<embedType>(…)`). `embedType` is a closed enum; anything else 400s. SDK: `mgmt.agents.getEmbedScript(agentId, embedType, ks)` unwraps to the html string.

## Avatars — `https://api.avatar.us.kaltura.ai`

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/avatar/list` | `{"pager":{"offset":0,"limit":30}}` |
| Get | `POST /v1/avatar/get` | `{"id":"24-char-hex"}` |
| Update | `POST /v1/avatar/update` | `{"id":"24-char-hex", ...fields}` |
| Clone | `POST /v1/avatar/clone` | `{"id":"24-char-hex"}` |
| Delete | `POST /v1/avatar/delete` | `{"id":"24-char-hex"}` |
| List templates | `POST /v1/avatar-template/list` | `{"pager":{"offset":0,"limit":30}}` — curated `{voice,face}` presets ([§ Create an Avatar](/reference/api/build/#create-an-avatar)). SDK: `mgmt.avatars.listTemplates(ks, opts)`. |

## Intellects — `https://genie.nvp1.ovp.kaltura.com`

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/intellect/list` | `{"filter":{},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/intellect/get` | `{"id":1389}` |
| Update | `POST /v1/intellect/update` | See § Configure an Intellect |
| Delete | `POST /v1/intellect/delete` | `{"id":1389}` |

Deleting an agent does **not** delete its avatar or intellect.

## Tools — `https://genie.nvp1.ovp.kaltura.com`

A standalone, partner-level entity (see [§ Tools](/reference/api/build/#tools-api--csv--code)) — not embedded in an intellect.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/tool/list` | `{"filter":{"objectType":"ToolListFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/tool/get` | `{"id":"TOOL_UUID"}` |
| Add | `POST /v1/tool/add` | `{"name":"...", "config":{...}}` |
| Update | `POST /v1/tool/update` | `{"id":"TOOL_UUID", "name"?, "config"?}` |
| Delete | `POST /v1/tool/delete` | `{"id":"TOOL_UUID"}` |

Deleting a Tool does **not** cascade — an intellect that still lists the id in `tool_ids` keeps a dangling reference; drop it first via `mgmt.intellectConfig.setToolIds`.

## Skills — `https://genie.nvp1.ovp.kaltura.com`

A standalone, partner-level reusable-instruction entity — `{id (uuid), name, description, instructions}`. All five operations verified live. SDK: `mgmt.skills`. A Skill's `name` is checked against your partner id OR partner `0` (a shared global pool), so a name can collide with a global-pool Skill in ways invisible from a partner-scoped `list()` — the same nuance applies to Tools below.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/skill/list` | `{"filter":{"objectType":"SkillListFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST /v1/skill/get` | `{"id":"SKILL_UUID"}` |
| Add | `POST /v1/skill/add` | `{"name":"...", "description":"...", "instructions"?}` |
| Update | `POST /v1/skill/update` | `{"id":"SKILL_UUID", "name"?, "description"?, "instructions"?}` — idempotent; renames re-check the same partner-unique-name constraint as Add (409 on conflict) |
| Delete | `POST /v1/skill/delete` | `{"id":"SKILL_UUID"}` — replies `{id}`; a follow-up get 404s |

Before deleting a Skill, `mgmt.skills.delete` lists every intellect and refuses with a typed `skill_in_use` error naming each one still referencing the id in `skill_ids`, unless called with `{confirmPermanent:true, force:true}`. Tools' `mgmt.tools.delete` carries the identical `tool_in_use` guard.

## Knowledge records — `https://genie.nvp1.ovp.kaltura.com`

Full record lifecycle (all verified live). SDK: `mgmt.knowledge`. Linkage to an intellect is via `knowledge_ids` (Path A — see § Ground the Agent).

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST /v1/knowledge/list` | `{"filter":{},"pager":{"pageIndex":1,"pageSize":30}}` — discover records without knowing ids up front. SDK: `mgmt.knowledge.listRecords(ks, opts)`. Distinct from `mgmt.knowledge.list(categoryId, ks)`, which lists KMS entries inside a category (Path A), not Knowledge record containers. |
| Add | `POST /v1/knowledge/add` | `{"name":"..."}` |
| Get | `POST /v1/knowledge/get` | `{"id":2049}` |
| Update | `POST /v1/knowledge/update` | `{"id":2049, ...fields}` |
| Delete | `POST /v1/knowledge/delete` | `{"id":2049}` — HTTP 200, body `null`; a follow-up get 404s |
| Per-entry status *(not yet GA — coming ~early Sept 2026)* | `POST /v1/knowledge/entry_status` | `{"knowledge_id":2049, "entry_ids":["0_abc123"]}` |

`mgmt.knowledge.isIndexed(id, ks)` wraps Get and reads `status`/`config.sources[].indexers[].index_position` — `status` is the record's own container-lifecycle flag, not an indexing-completion signal (see § Ground the Agent). `mgmt.knowledge.entryStatus(knowledgeId, entryIds, ks)` wraps the new per-entry endpoint above and is the real indexing-completion check, once generally available.

Deleting a record does **not** unlink it — an intellect's `knowledge_ids` keeps the dangling id; clear it via `mgmt.intellectConfig.setKnowledgeIds(configId, [], ks)`.

## Lifecycle — `https://api.avatar.us.kaltura.ai`

An event-driven rule engine ([§ Lifecycle](/reference/api/build/#lifecycle-event-driven-rules)) — not embedded in an intellect. SDK: `mgmt.lifecycle`.

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

Production ships a system-seeded preset rule (`preset__overridable_summary_on_session_ended`) that matches every `session_ended`/`thread` event for every partner by default — `match`'s response can include it grouped alongside your own rules (see [§ Lifecycle](/reference/api/build/#lifecycle-event-driven-rules) for a worked example).

