> **Contributor doc.** For people changing the SDK, not for app builders. Public in this repository, not published on the docs site. [Index](README.md).

# SDK Module Map

Where each part of the SDK lives, and which endpoints each management module calls. Public behavior is in [README.md](../../README.md) and [API-REFERENCE.md](../../API-REFERENCE.md).

## Entry points

| Export | Source | Runs in | Role |
|---|---|---|---|
| `.` | `src/index.js` | both | Re-exports the shared names |
| `./management` | `src/management/client.js` (`Management`) | server | REST control plane. Holds the admin secret, mints tokens, calls `agenticUrl`, `genieUrl`, `ovpUrl` and `messagingUrl`. Checks the token kind (`assertAdmin`/`assertConversation`) before any network call |
| `./experience` | `src/experience/session.js` (`KalturaAvatarSession`) | browser | Live socket and WHEP runtime. Takes only a conversation KS from `application.appInit`. socket.io is injected (`socketFactory`), never bundled. See [ARCHITECTURE.md](../ARCHITECTURE.md#video-runtime-protocol-the-big-picture) |
| `./experience/presenter` | `presenter.js` | browser | `Presenter` deck helper |
| `./experience/site-nav` | `site-nav.js` | browser | Browser half of the `go_to` site navigation contract |
| `./experience/chroma-key` | `chroma-key.js` | browser | Attaches a transparent-background compositor to the avatar `<video>` |
| `./experience/genui` | `genui/index.js` | browser | `ExperienceRenderer` and the GenUI widgets |
| `./experience/noise-suppressor` | `noise-suppressor.js` | browser | `AudioWorklet` noise gate for `cfg.noiseProcessor` |
| `./experience/analytics` | `analytics.js` | browser | KAVA application events |

Namespaces on `Management`: `sessions`, `agents`, `avatars`, `avatarSessions`, `catalog`, `application`, `intellects` (with `intellects.secrets`), `intellectConfig`, `tools`, `skills`, `conversations`, `threads`, `messages`, `feedback`, `followups`, `knowledge`, `lifecycle`, `insightSettings`, `emailTemplates`. `tools` and `skills` are standalone, partner-level entities. An intellect references them through `tool_ids` and `skill_ids`.

## Core (`src/core/`)

The shared leaf layer. Core never imports from `management/` or `experience/`.

| File | Holds |
|---|---|
| `http.js` | Transport |
| `errors.js` | `KalturaError` (RFC 9457) |
| `session.js` | `Sessions` token minter, `makeAuditEmitter` |
| `endpoints.js` | `REGIONS` and `resolveEndpoints` |
| `transport-guard.js` | TLS check for transport URLs |
| `net-guard.js` | Private, loopback and link-local host detector |
| `stream.js` | Converse NDJSON/SSE parser, `collectConverse`, `segmentKind`, `GENUI_RUNTIMES` (the closed list of GenUI runtime names a segment can carry), `genuiRuntimeAlias` (maps a runtime alias such as `video` to its first-class runtime) |
| `redact.js` | Secret redaction |
| `safety.js` | `safeText`/`safeUrl` for untrusted output |
| `ids.js` | `meta()` receipts |
| `response-headers.js` | Response-header diagnostics kept on `KalturaError.headers` |
| `opening.js` | Silent opening phrase |
| `site-keys.js` | Compact site-map contract shared by the site build, `management/site-nav` and `experience/site-nav` |
| `kaltura-media.js` | Thumbnail, player-embed and iframe URL helpers |
| `knowledge-enums.js` | `CHAPTER_TYPE`/`STRATEGY`/`EMBED`/`MODALITIES`, `normalizeModality`, `buildIndexerObjects` |

## Management modules (`src/management/`)

| Module | Exposes | Endpoints called |
|---|---|---|
| `client.js` | `Management`, token-kind guard | none of its own |
| `agents.js` | `Agents` (`mgmt.agents`): agent CRUD | `agent/*` |
| `avatars.js` | `Avatars` (`mgmt.avatars`): avatar CRUD, template list | `avatar/*`, `avatar-template/list` |
| `avatar-sessions.js` | `AvatarSessions` (`mgmt.avatarSessions`): scripted-video sessions, `say()` | `avatar-session/*` |
| `catalog.js` | `Catalog` (`mgmt.catalog`): visual and voice presets, custom uploads | `catalog-item/*`, `catalog/clone-consent` |
| `application.js` | `Application` (`mgmt.application`): `appInit`, profile generation, widget resolution, custom prompts | `application/*` |
| `intellects.js` | `Intellects`: `add`/`get`/`update`/`delete`, prompt authoring (`setPrompts`/`previewPrompt`/`snapshot`/`restore`/`diffSnapshots`), capabilities (`getCapabilities`/`setCapability`/`setCapabilities`/`resolveCapabilities`), `setClientVariablesEnabled`. Mounts `secrets` | `v1/intellect/*` |
| `intellect-config.js` | `IntellectConfig`: the one `patch(configId, patch\|fn, ks)` primitive, `audit`, `describe`, `buildUserPropertiesForms`. Setters: `setCapabilities`, `setCapability`, `setToolIds`, `setSkillIds`, `setThreadStartTools`, `setModelConfiguration`, `setOpeningPhrase`, `setAvatarSummaryConfig`, `setSecrets`, `listSecretNames`, `setUserPropertiesForms`, `clearUserPropertiesForms`, `setAllowClientVariables`, `setMetadata`, `setKnowledgeIds`, `setMcpServers`. Enums: `SKILL_MODES`, `MODEL_IDS`, `THINKING_LEVELS`, `SUMMARY_CONTENT_TYPES`, `CALL_STAGES`, `FORM_FIELD_TYPES` | `v1/intellect/update` (read, merge, write) |
| `intellect-body.js` | Small helpers shared by `intellects.js`, `secrets.js` and `intellect-config.js` | none |
| `secrets.js` | `IntellectSecrets` (`mgmt.intellects.secrets`): `listNames`/`has`/`set`/`delete`/`replaceAll`/`validate`, `validateSecretRefs`. Values are write-only | `v1/intellect/update` |
| `tools.js` | Builders `tools.api`/`csv`/`code`/`client`/`var`, `clientToolReadiness`, `validate`, `Tools` (`add`/`get`/`list`/`update`/`delete`), `applyResponseMapping`. `tools.client` needs `kaltura_genie_experiences:'off'`, see [CLIENT-COMMANDS.md](../CLIENT-COMMANDS.md) | `v1/tool/*` |
| `skills.js` | `Skills` (`add`/`get`/`update`/`list`/`delete`). `delete` first checks for intellects that still reference the id | `v1/skill/*` |
| `capabilities.js` | `CAPABILITIES`, `CAPABILITY_STATE`, `CAPABILITY_DEFAULTS`, `CAPABILITY_INFO`, `assertCapability`, `validateCapabilities`, `resolveCapabilities`, `mergeCapabilityWrite`. Exported from both entry points | none |
| `condition.js` | `conditionProblem`, `assertCondition`. One bare-expression check shared by skill, prompt and tool conditions | none |
| `prompt-lint.js` | `lintPrompts`, `validatePromptVars`, `lintGlossary`, `assembleSystemPrompt`, `SYS_VARS`. Client-side prompt preview | none |
| `languages.js` | `LANGUAGE_CODES`: the ISO 639-1 codes `setForcedLanguage` accepts. Pure data | none |
| `set-forced-language.js` | `setForcedLanguage`: writes `force_language` on the intellect and `asr.language` on the agent in one idempotent call. `LANGUAGE_NAMES` | `v1/intellect/update`, `agent/update` |
| `conversations.js` | `Conversations` (`stream`/`send`), `Threads`, `Messages`, `Feedback`, `Followups`, `Knowledge` (`addRecord`, `upload`, `uploadDocument`, `createCategory`, `findOrCreateCategory`, `corpusStatus`, `getLinkage`, `setEnabled`, `search`, `isIndexed`, `entryStatus`) | `assistant/converse`, `v1/knowledge/add`, OVP `category/*` and upload |
| `lifecycle.js` | `Lifecycle`: rule CRUD, `match`, `listObjects`, `listEvents`, `describeFields`, `audit` | `lifecycle/*` |
| `lifecycle-rules.js` | Rule-condition predicates used by `Lifecycle` on create and update, and by the audit | none |
| `lifecycle-audit.js` | `auditLifecycleRules`: pure audit of existing rules | none |
| `insight-settings.js` | `InsightSettings`: reusable insight definitions. A rule references them through `action.insightSettingsIds` | `insight-settings/*` |
| `email-templates.js` | `EmailTemplates` (`mgmt.emailTemplates`): template CRUD. A rule references a template by `id` | `email-template/*` (messaging API) |
| `doctor.js` | `Doctor`: read-only health check over a partner's agents (lifecycle audit, then intellect audit per agent) | reads only |
| `audit-report.js` | Report shape shared by `lifecycle.audit`, `intellectConfig.audit` and `doctor` | none |
| `ks-inspect.js` | Local KS header decode, no network | none |
| `crm-recipes.js` | Validated `api` tool configs for common CRM lead and contact capture | none |
| `site-nav.js` | Builds the `go_to` client tool and the site-map prompt blocks | none |
| `paginate.js` | One pager shape over the two endpoint families | none |
| `provision.js` | `provision()`: the agent factory. The optional `knowledge`, `tools` and `capabilities` blocks run after the core create. `tools` creates each Tool with `mgmt.tools.add`, then links the ids in one `intellectConfig.setToolIds` write | all of the above |

## Experience modules (`src/experience/`)

| Module | Holds |
|---|---|
| `session.js` | `KalturaAvatarSession`: socket, ASR and WHEP state machine |
| `chat-session.js` | `KalturaChatSession`: text-only transport on the same thread |
| `agent-session.js` | `KalturaAgentSession`: one conversation, switchable transports |
| `scripted-video-session.js` | `KalturaScriptedVideoSession`: video and audio downlink for scripted-video sessions |
| `wire.js` | Pure builders for socket payloads and ICE config, `classifyAgentAction` |
| `whep.js` | WHEP POST with per-try timeout and bounded retries |
| `avatar-media.js` | Routes the downlink video and audio tracks to the app's elements |
| `ice-diagnostics.js` | Gathered-candidate summary and plain-words cause, with no addresses or credentials |
| `captions.js` | `CaptionService` |
| `transcript.js` | Transcript and barge-in tracker keyed by `speechId` |
| `session-complete.js` | `session_completed` POST |
| `fetch-timeout.js` | Fetch with a hard deadline for short control requests |
| `emitter.js` | Zero-dependency event emitter the sessions extend |
| `teardown.js` | Subscription tracker for classes that listen on a session |
| `slidenav.js` | Spoken slide-number parser |

## GenUI layer (`src/experience/genui/`)

Turns `unisphere-tool` segments into framework-agnostic render descriptors.

- `parse.js`: pure. `normalizeRuntime` (strips the wire `-tool` suffix and maps aliases), `RUNTIMES` (the first-class widgets), `parseWidget`/`parseContent` (forgiving parser; unparsed lines go to `.raw`, never throws), `isKnownRuntime`.
- `yaml.js`: pure, internal. The YAML subset `parseContent` uses for string bodies. Not exported.
- `segments.js`: `SegmentAssembler` buffers deltas and flushes a complete widget on `runtimeName` or `speechId` change, or at turn end.
- `renderer.js`: `ExperienceRenderer`, dual mode. Live `start()` subscribes to `session.on('brainSegment')`. Headless `render(runtime, widget)` is fed from `Management.conversations.stream()`. The live runtime sends `force_experience:'avatar_only'`, so headless is the reliable widget path. An unknown runtime yields `{kind:'unknown'}` and calls `onUnhandled`. It never throws.
- `renderers/*.js`: one default renderer per runtime. Each routes untrusted output through `core/safety.js` (`safeText`/`safeUrl`, no `innerHTML`).

`session.js` runs the guardrail gate. `classifyAgentAction` (`wire.js`) classifies each `agent_raw_text` delta from `seg.metadata.runtimeName`/`widgetName` and the normalized `seg.type`. When a capability policy or an `onAgentAction` hook is set, the delta passes `_gateAgentAction` before `emit('brainSegment', d)`. The default is allow. A veto emits `agentActionDenied` and an `agent.action.deny` audit event.

## Write routing: the intellect DTO

Every writable intellect field goes through `v1/intellect/*` with an admin token: `prompts`, `base_directive`, `glossary`, `capabilities`, `tool_ids`, `skill_ids`, `thread_start_tools`, `secrets`, `user_properties_forms`, `mcp_servers`, `allow_client_variables`, `knowledge_ids`, `avatar_summary_config`, `force_language`, `opening_phrase`, `model_configuration`, `name`, `description`, `tags`, `status`.

- **Knowledge**: call `POST /v1/knowledge/add`, then pass the returned id in `knowledge_ids` on the intellect create or update. Set `use_knowledge_base:'on'`. No separate link call exists.
- **Partial updates**: omitted top-level fields stay as they are. For `capabilities` and `secrets` the SDK reads the current value, merges your change and writes the whole object (`mergeCapabilityWrite`, the secrets merge). `IntellectConfig.patch` is the one place for this logic.
- **`EDITABLE_FIELDS`** in `intellect-config.js` lists the keys `patch()` accepts. `patch()` rejects any other key before the network call, and `describe()` returns exactly these keys. To add a field, confirm the key round-trips through `intellect/get` and `intellect/update`, then add it to `EDITABLE_FIELDS`.
