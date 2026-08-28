[← Back to the API Reference index](../../API-REFERENCE.md)

# Management Operations

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
| Add | `POST /v1/knowledge/add` | `{"name":"..."}` |
| Get | `POST /v1/knowledge/get` | `{"id":2049}` |
| Update | `POST /v1/knowledge/update` | `{"id":2049, ...fields}` |
| Delete | `POST /v1/knowledge/delete` | `{"id":2049}` — HTTP 200, body `null`; a follow-up get 404s |
| Per-entry status *(not yet GA — coming ~early Sept 2026)* | `POST /v1/knowledge/entry_status` | `{"knowledge_id":2049, "entry_ids":["0_abc123"]}` |

`mgmt.knowledge.isIndexed(id, ks)` wraps Get and reads `status`/`config.sources[].indexers[].index_position` — `status` is the record's own container-lifecycle flag, not an indexing-completion signal (see § Ground the Agent). `mgmt.knowledge.entryStatus(knowledgeId, entryIds, ks)` wraps the new per-entry endpoint above and is the real indexing-completion check, once generally available.

Deleting a record does **not** unlink it — an intellect's `knowledge_ids` keeps the dangling id; clear it via `mgmt.intellectConfig.setKnowledgeIds(configId, [], ks)`.
