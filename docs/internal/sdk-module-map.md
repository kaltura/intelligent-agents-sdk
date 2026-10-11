> **Internal SDK development doc.** For people changing the SDK, not for app builders. Published in this repository only, never on the docs site. [Index](README.md).

# SDK Module Map

Where each part of the SDK lives, and which backend host each management module writes to. Public behavior is in [README.md](../../README.md) and [API-REFERENCE.md](../../API-REFERENCE.md).

## Two entry points, one shared core

- **`./management`** (`Management`, `src/management/client.js`): the REST control plane. It holds the admin secret, mints tokens, and routes to the two REST hosts (Agentic API and brain API) and OVP. It enforces the token-kind guard via `assertAdmin`/`assertConversation` (`assertKind` in `client.js`) **before any network call**. Resource namespaces hang off it: `sessions`, `agents`, `avatars`, `avatarSessions`, `catalog`, `application`, `intellects`, `intellectConfig`, `tools`, `skills`, `conversations`, `threads`, `messages`, `feedback`, `followups`, `knowledge`, `lifecycle`, `insightSettings`. `tools` and `skills` are standalone, partner-level entities. An intellect only references them via `tool_ids`/`skill_ids`. One sub-resource mounts on `intellects`: `intellects.secrets`.
- **`./experience`** (`KalturaAvatarSession`, `src/experience/session.js`): the live socket+WHEP runtime from [ARCHITECTURE.md § Video Runtime Protocol](../ARCHITECTURE.md#video-runtime-protocol--the-big-picture). It takes only an enriched conversation KS from `application.appInit` (short-lived, non-admin). socket.io is INJECTED (`socketFactory`), never bundled. Two optional plugin subpaths hang off this same live runtime without loading into apps that don't need them: `./experience/presenter` (the `Presenter` deck helper) and `./experience/genui` (the `ExperienceRenderer` GenUI layer).
- **`src/core/*`**: the shared leaf layer both fronts depend on.
  - `http.js` (transport)
  - `errors.js` (`KalturaError`, RFC 9457)
  - `session.js` (`Sessions` token-minter + `makeAuditEmitter`)
  - `stream.js` (converse NDJSON/SSE parser + `collectConverse`/`segmentKind`/`GENUI_RUNTIMES`, the closed enum of GenUI runtime names the brain's `unisphere-tool` segments can carry)
  - `redact.js`
  - `safety.js`
  - `ids.js` (`meta()` receipts)
  - `knowledge-enums.js` (`CHAPTER_TYPE`/`STRATEGY`/`EMBED`/`MODALITIES`/`normalizeModality`/`buildIndexerObjects`)

  Core never imports from `management/` or `experience/`. It stays a leaf.

## Management modules

| Module (`src/management/`) | Exposes | Backend the writes hit |
|---|---|---|
| `intellects.js` | `Intellects`: DTO CRUD (`add`/`get`/`update`/`delete`), prompt authoring (`setPrompts`/`previewPrompt`/`snapshot`/`restore`/`diffSnapshots`), capabilities (`getCapabilities`/`setCapability`/`setCapabilities`/`resolveCapabilities`), `setClientVariablesEnabled`. Mounts `secrets` (tools are a separate top-level resource; see `tools.js`). | the brain `v1/intellect/*` |
| `intellect-config.js` | `IntellectConfig` (`mgmt.intellectConfig`): the ONE shared `patch(configId, patch\|fn, ks)` primitive + typed field setters incl. `setToolIds` (the intellect-side `tool_ids` reference list), `setSkillIds`, `setThreadStartTools`, `setModelConfiguration`, `setOpeningPhrase`, `setAvatarSummaryConfig` + `describe()` (every `EDITABLE_FIELDS` value). Exports the closed enums `SKILL_MODES`, `MODEL_IDS`, `THINKING_LEVELS`, `SUMMARY_CONTENT_TYPES`. `buildUserPropertiesForms`. | the brain `v1/intellect/update` (read-modify-write, full-replace dicts; `tool_ids` is a plain array write) |
| `set-forced-language.js` | `setForcedLanguage` (`mgmt.setForcedLanguage`): forces the reply language by writing `force_language` on the intellect (via `intellectConfig.patch`; the backend enforces it at runtime) and the agent's `asr.language` (via `agents.update`) in one idempotent call. Strips the marker block older SDK versions appended to `base_directive`. `LANGUAGE_NAMES` (ISO 639-1 code → display name). | the brain `v1/intellect/update` + Agentic API `agent/update` |
| `capabilities.js` | `CAPABILITIES`/`CAPABILITY_STATE`/`CAPABILITY_DEFAULTS`/`CAPABILITY_INFO`, `assertCapability`/`assertCapabilityState`/`validateCapabilities`, `resolveCapabilities` (pure layered resolver), `mergeCapabilityWrite`. Re-exported from BOTH entry points. | pure, no network |
| `tools.js` | `tools.api`/`csv`/`code` builders + `tools.client` (authors a native, silent client-side command tool with no server-side call, requires `kaltura_genie_experiences:'off'`; see [CLIENT-COMMANDS.md](../CLIENT-COMMANDS.md)) + `tools.clientToolReadiness` + `tools.validate`, `class Tools` (`mgmt.tools`: `add`/`get`/`list`/`update`/`remove` over the standalone Tool entity), `applyResponseMapping`. | the brain `v1/tool/*` (partner-level entity CRUD, **not** `intellect/update`; link via `intellectConfig.setToolIds`'s `tool_ids`) |
| `skills.js` | `Skills` (`mgmt.skills`: `add`/`get`/`update`/`list`/`delete` over the standalone, partner-level Skill entity; `delete` checks for intellects still referencing the id before acting). | the brain `v1/skill/*` (partner-level entity CRUD, **not** `intellect/update`; link via `intellectConfig.setSkillIds`'s `skill_ids`) |
| `secrets.js` | `IntellectSecrets` (`mgmt.intellects.secrets`: `listNames`/`has`/`set`/`remove`/`replaceAll`/`validate`), `validateSecretRefs`. Write-only values; name-only read contract (no `redact()` reliance). | the brain `v1/intellect/update` `config.secrets` (mask-and-keep merge) |
| `prompt-lint.js` | pure: `lintPrompts`/`validatePromptVars`/`lintGlossary`/`assembleSystemPrompt`/`SYS_VARS`. Client-side prompt-preview replica (author layer only). | pure, no network |
| `conversations.js` | `Conversations` (`stream`/`send`, `assertRequestVars`), `Threads`/`Messages`/`Feedback`/`Followups`, `Knowledge` (`addRecord` + `knowledge_ids` linkage, ungated; `uploadDocument`, `createCategory`/`findOrCreateCategory` (plain entry containers), `corpusStatus`, `getLinkage`, `setEnabled`, `search`, `isIndexed`, `entryStatus`). | the brain's `assistant/converse` (converse); the brain's `v1/knowledge/add` + intellect `knowledge_ids` (ungated); OVP `category/*`+upload (containers) |
| `lifecycle.js` | `Lifecycle` (`mgmt.lifecycle`: `create`/`get`/`update`/`delete`/`list` over event-driven rules `{eventType, objectType, eventConditions, action}`, plus read-only `match`/`listObjects`/`listEvents`/`describeFields`). A rule's `action` can trigger an insight extraction, an insight email, or the built-in lead-capture insight. | the Agentic API's `lifecycle/*` |
| `insight-settings.js` | `InsightSettings` (`mgmt.insightSettings`: `create`/`get`/`update`/`delete`/`list` over reusable `{key, title, prompt, valueType, status}` insight definitions). Referenced by a `lifecycle` rule's `action.insightSettingsIds`, not embedded in the rule itself. | the Agentic API's `insight-settings/*` |
| `provision.js` | `provision()`: the agent factory; optional `knowledge`/`tools`/`capabilities` blocks layer after the core create (`tools` creates each Tool entity via `mgmt.tools.add`, then links the successful ids in one `intellectConfig.setToolIds` write). | both hosts |

## Experience GenUI layer

`src/experience/genui/` turns brain `unisphere-tool` segments into framework-agnostic render descriptors:

- `parse.js`: pure. `normalizeRuntime` (strips the wire `-tool` suffix), `RUNTIMES` (the nine first-class widgets), `parseWidget`/`parseContent` (forgiving JSON-then-line parser; unknown keys map to `.raw`, never throws), `isKnownRuntime`.
- `segments.js`: `SegmentAssembler` buffers deltas and flushes a complete widget on `runtimeName`/`speechId` change or turn end.
- `renderer.js`: `ExperienceRenderer`, **dual-mode**. LIVE `start()` subscribes to `session.on('brainSegment')`. HEADLESS `render(runtime, widget)` is fed from `Management.conversations.stream()` (the reliable widget path, since the live runtime hardcodes `force_experience:'avatar_only'`). Unknown runtimes yield a safe `{kind:'unknown'}` fallback plus `onUnhandled`, never thrown, never faked.
- `renderers/*.js`: one default renderer per runtime, each routing untrusted LLM output through `core/safety.js` (`safeText`/`safeUrl`, no `innerHTML`).

`session.js` wires the **guardrail gate**. Each `agent_raw_text` delta is classified by `classifyAgentAction` (`wire.js`, reading `seg.metadata.runtimeName`/`widgetName` plus the adapter-normalized `seg.type` with `-tool` stripped). When a capability policy or `onAgentAction` hook is present, the delta runs through `_gateAgentAction` before `emit('brainSegment', d)`. This is default-allow, so existing nav/GenUI flows are untouched; a veto emits `agentActionDenied` plus an `agent.action.deny` audit event. `Presenter` exposes `covered`/`questions`/`lastNav` (`{target, reason, at}`). `session.micEnabled` is a read getter.

## Write routing: the intellect DTO

The intellect DTO (`v1/intellect/*`) is the only write path for every writable field: `prompts`, `base_directive`, `glossary`, `capabilities`, `tool_ids`, `skill_ids`, `thread_start_tools`, `secrets`, `user_properties_forms`, `mcp_servers`, `allow_client_variables`, `knowledge_ids`, `avatar_summary_config`, `force_language`, `opening_phrase`, `model_configuration`, `name`/`description`/`tags`/`status`. It's writable with a **partner admin KS**, ungated.

**Knowledge linkage uses the same path.** First call `POST /v1/knowledge/add` on the brain host, which returns an `{id,...}` record. Then pass the returned id as `knowledge_ids` in the intellect create/update DTO. Linkage plus `use_knowledge_base:'on'` persist with no separate linking call.

Omitted top-level fields are preserved on update. But `capabilities`/`secrets` are **full-replace sub-dicts**, so the SDK read-merge-writes them, via `mergeCapabilityWrite` or the secrets mask-and-keep guard. `IntellectConfig.patch` is the one place that logic lives.

`EDITABLE_FIELDS` in `intellect-config.js` is the exact list of keys `v1/intellect/get` echoes and `v1/intellect/update` accepts for a partner admin KS. `patch()` rejects any other key before the network call, and `describe()` returns exactly these keys. When adding a field setter, first confirm the key round-trips through `intellect/update` and `intellect/get` with a partner admin KS. Then add it to `EDITABLE_FIELDS`.

