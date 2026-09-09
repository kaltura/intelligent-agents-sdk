[← Back to Architecture Reference](../ARCHITECTURE-REFERENCE.md)

# SDK Module Map & Data Flow

This section is the **source-of-truth map** of the SDK's internals: how a call flows from a typed method to the right backend, and the routing/data-flow rules README doesn't cover.

### Two entry points, one shared core

- **`./management`** (`Management`, `src/management/client.js`) — the REST control plane. Holds the admin secret, mints tokens, routes to the two REST hosts (Agentic API + brain API) and OVP, and enforces the two-KS guard via `assertAdmin`/`assertConversation` (`assertKind` in `client.js`) **before any network call**. Resource namespaces hang off it: `sessions`, `agents`, `avatars`, `catalog`, `application`, `intellects`, `intellectConfig`, `tools`, `conversations`, `threads`, `messages`, `feedback`, `followups`, `knowledge`. `tools` is a standalone, partner-level entity — an intellect only references it via `tool_ids`. One sub-resource mounts on `intellects`: `intellects.secrets`.
- **`./experience`** (`KalturaAvatarSession`, `src/experience/session.js`) — the live socket+WHEP runtime from [ARCHITECTURE.md's "Video Runtime Protocol"](../ARCHITECTURE.md#video-runtime-protocol--the-big-picture). Takes only a short-lived conversation token; socket.io is INJECTED (`socketFactory`), never bundled. Two optional plugin subpaths hang off this same live runtime without loading into apps that don't need them: `./experience/presenter` (the `Presenter` deck helper) and `./experience/genui` (the `ExperienceRenderer` GenUI layer).
- **`src/core/*`** — the shared leaf layer both fronts depend on: `http.js` (transport), `errors.js` (`KalturaError`, RFC 9457), `session.js` (`Sessions` token-minter + `makeAuditEmitter`), `stream.js` (converse NDJSON/SSE parser + `collectConverse`/`segmentKind`/`GENUI_RUNTIMES` — the closed enum of GenUI runtime names the brain's `unisphere-tool` segments can carry), `redact.js`, `safety.js`, `ids.js` (`meta()` receipts), `knowledge-enums.js` (`CHAPTER_TYPE`/`STRATEGY`/`EMBED`/`MODALITIES`/`normalizeModality`/`buildIndexerObjects`). Core never imports from `management/` or `experience/` (stays a leaf).

> **Branch security on the minted `Token`, never on `inspectKs(realKs).kind`.** The public `inspectKs` export (`@kaltura/intelligent-agents/management`, `src/management/ks-inspect.js`) decodes only a KSv2 token's **plaintext header**: it reliably returns `{partnerId}`, but a real encrypted KS's privileges are AES-encrypted, so it returns `kind:'opaque'`, `disableEntitlement:null`, `encrypted:true`. `kind`/`disableEntitlement` are populated **only** for unencrypted test tokens. To decide what a token may do, read the `.kind` of the minted `Token` object (it records what it was minted with: `admin`/`conversation`/`agent`/`widget`), not `inspectKs` of an opaque production KS.

### Management modules (what each does, where it writes)

| Module (`src/management/`) | Exposes | Backend the writes hit |
|---|---|---|
| `intellects.js` | `Intellects` — DTO CRUD (`add`/`get`/`update`/`delete`), prompt authoring (`setPrompts`/`previewPrompt`/`snapshot`/`restore`/`diffSnapshots`), capabilities (`getCapabilities`/`setCapability`/`setCapabilities`/`resolveCapabilities`), `setClientVariablesEnabled`. Mounts `secrets` (tools are a separate top-level resource — see `tools.js`). | the brain `v1/intellect/*` |
| `intellect-config.js` | `IntellectConfig` (`mgmt.intellectConfig`): the ONE shared `patch(configId, patch\|fn, ks)` primitive + typed field setters incl. `setToolIds` (the intellect-side `tool_ids` reference list), `setSkillIds`, `setThreadStartTools`, `setModelConfiguration`, `setOpeningPhrase`, `setAvatarSummaryConfig` + `describe()` (every `EDITABLE_FIELDS` value). Exports the closed enums `SKILL_MODES`, `MODEL_IDS`, `THINKING_LEVELS`, `SUMMARY_CONTENT_TYPES`. `buildUserPropertiesForms`. | the brain `v1/intellect/update` (read-modify-write, full-replace dicts; `tool_ids` is a plain array write) |
| `set-forced-language.js` | `setForcedLanguage` (`mgmt.setForcedLanguage`): forces the reply language by writing `force_language` on the intellect (via `intellectConfig.patch`; the backend enforces it at runtime) and the agent's `asr.language` (via `agents.update`) in one idempotent call. Strips the marker block older SDK versions appended to `base_directive`. `LANGUAGE_NAMES` (ISO 639-1 code → display name). | the brain `v1/intellect/update` + Agentic API `agent/update` |
| `capabilities.js` | `CAPABILITIES`/`CAPABILITY_STATE`/`CAPABILITY_DEFAULTS`/`CAPABILITY_INFO`, `assertCapability`/`assertCapabilityState`/`validateCapabilities`, `resolveCapabilities` (pure layered resolver), `mergeCapabilityWrite`. Re-exported from BOTH entry points. | pure — no network |
| `tools.js` | `tools.api`/`csv`/`code` builders + `tools.client` (authors a native, silent client-side command tool with NO server-side call — requires `kaltura_genie_experiences:'off'`; see [CLIENT-COMMANDS.md](../CLIENT-COMMANDS.md)) + `tools.clientToolReadiness` + `tools.validate`, `class Tools` (`mgmt.tools`: `add`/`get`/`list`/`update`/`remove` over the standalone Tool entity), `applyResponseMapping`. | the brain `v1/tool/*` (partner-level entity CRUD — NOT `intellect/update`; link via `intellectConfig.setToolIds`'s `tool_ids`) |
| `secrets.js` | `IntellectSecrets` (`mgmt.intellects.secrets`: `listNames`/`has`/`set`/`remove`/`replaceAll`/`validate`), `validateSecretRefs`. Write-only values; name-only read contract (no `redact()` reliance). | the brain `v1/intellect/update` `config.secrets` (mask-and-keep merge) |
| `prompt-lint.js` | pure: `lintPrompts`/`validatePromptVars`/`lintGlossary`/`assembleSystemPrompt`/`SYS_VARS`. Client-side prompt-preview replica (author layer only). | pure — no network |
| `conversations.js` | `Conversations` (`stream`/`send`, `assertRequestVars`), `Threads`/`Messages`/`Feedback`/`Followups`, `Knowledge` (`addRecord` + `knowledge_ids` linkage, ungated; `uploadDocument`, `createCategory`/`findOrCreateCategory` (plain entry containers), `corpusStatus`, `getLinkage`, `setEnabled`, `search`, `isIndexed`, `entryStatus`). | the brain's `assistant/converse` (converse); the brain's `v1/knowledge/add` + intellect `knowledge_ids` (ungated); OVP `category/*`+upload (containers) |
| `provision.js` | `provision()` — the agent factory; optional `knowledge`/`tools`/`capabilities` blocks layer after the core create (`tools` creates each Tool entity via `mgmt.tools.add`, then links the successful ids in one `intellectConfig.setToolIds` write). | both hosts |

The top-level headless converse surface lives on the `Management` class itself: `converse(configId, message, opts?, ks?)` (AsyncGenerator over `conversations.stream`) and `converseOnce(...)` (delegates to `conversations.send`). Both auto-mint a conversation token from `configId` when `ks` is omitted, so the admin secret never leaves the server. `opts` carries `{threadId, sse, model_type, force_experience, request_vars, capabilities, recoverFromSpiral}`; `assertRequestVars` rejects reserved keys + non-scalar values before the wire. `opts.capabilities` is a per-message `{name:state}` override validated client-side, but the server-side **DISABLED veto still wins** — a stored/env-disabled capability cannot be turned on per message (e.g. `converse(cfg, msg, {capabilities:{use_web_search:'on'}})` is honored only if `use_web_search` is not disabled by a stored layer). `opts.recoverFromSpiral:true` on `conversations.send`/`converseOnce` sends one same-thread nudge retry (`SPIRAL_RECOVERY_PREFIX`) when the first attempt comes back `spiralStopped:true` with empty text — see `stream.js`'s `collectConverse` entry above for what it's recovering from.

> **Scope-guard timing on the streaming path.** `conversations.stream(...)` is an **async generator**, so its `assertConversation(ks)` scope check fires on the **first** `.next()`/iteration — NOT at call time. `const g = k.conversations.stream(opts, adminKs)` without iterating gets no guard yet (despite the client's "before any network call" framing, which holds for the non-generator methods). For **eager** scope validation, use `conversations.send(...)`/`converseOnce(...)` — they assert the token kind synchronously before returning. The non-generator reads (`conversations.status`, all `agents`/`avatars`/`catalog` calls) guard at call time as documented.

### `resolveCapabilities` return shape (the 16 names are nested, not top-level)

`resolveCapabilities(layers)` (`src/management/capabilities.js`) returns a **two-key** object, `{ capabilities, _meta }`, so `Object.keys(result).length === 2`. The 16 `AssistantCapability` states live **under `.capabilities`**, keyed by name, NOT at the top level:

```js
const { capabilities, _meta } = k.intellects.resolveCapabilities({
  partnerConfig: stored,                       // from intellects.getCapabilities
  request: { use_web_search: 'off' },          // per-turn override to model
});
capabilities.avatar.state;          // 'on' | 'off' | 'disabled'
capabilities.avatar.resolvedFrom;   // which layer won
```

Each per-name entry is `{ state, resolvedFrom, vetoed, layers }`:

- `resolvedFrom` is one of `request | partner_config | env | default | disabled_veto`. **`default` only appears when you pass an explicit empty `env: {}`**. When `env` is **omitted**, the resolver supplies `CAPABILITY_DEFAULTS` *as the env layer*, so an unset capability resolves `resolvedFrom:'env'` (e.g. `resolveCapabilities({}).capabilities.avatar.resolvedFrom === 'env'`).
- `vetoed:true` (with `resolvedFrom:'disabled_veto'`, `state:'off'`) when `env` OR `partnerConfig` marks the capability `disabled` — a hard override no per-request `on` can lift.

A **freshly created** intellect returns an **empty `capabilities {}`** from `getCapabilities` (nothing stored yet), so every name then resolves from the env/default layer until you `setCapability`/`setCapabilities`.

### Experience GenUI layer

`src/experience/genui/` turns brain `unisphere-tool` segments into framework-agnostic render descriptors:

- `parse.js` — pure: `normalizeRuntime` (strips the wire `-tool` suffix), `RUNTIMES` (the nine first-class widgets), `parseWidget`/`parseContent` (forgiving JSON-then-line parser; unknown keys → `.raw`, never throws), `isKnownRuntime`.
- `segments.js` — `SegmentAssembler`: buffers deltas and flushes a complete widget on `runtimeName`/`speechId` change or turn end.
- `renderer.js` — `ExperienceRenderer`: **dual-mode**. LIVE `start()` subscribes to `session.on('brainSegment')`; HEADLESS `render(runtime, widget)` is fed from `Management.conversations.stream()` (the reliable widget path, since the live runtime hardcodes `force_experience:'avatar_only'`). Unknown runtimes yield a safe `{kind:'unknown'}` fallback + `onUnhandled` — never thrown, never faked.
- `renderers/*.js` — one default renderer per runtime, each routing untrusted LLM output through `core/safety.js` (`safeText`/`safeUrl`, no `innerHTML`).

`session.js` wires the **guardrail gate**: each `agent_raw_text` delta is classified by `classifyAgentAction` (`wire.js` — reads `seg.metadata.runtimeName`/`widgetName` + the adapter-normalized `seg.type` with `-tool` stripped) and, when a capability policy or `onAgentAction` hook is present, run through `_gateAgentAction` BEFORE `emit('brainSegment', d)` (default-allow so existing nav/GenUI flows are untouched; a veto emits `agentActionDenied` + an `agent.action.deny` audit event). `Presenter` exposes `covered`/`questions`/`lastNav` (`{target, reason, at}`); `session.micEnabled` is a read getter.

### Routing rule: the intellect DTO is the whole writable surface

The intellect DTO (`v1/intellect/*`) is the one real door for every writable field: `prompts`, `base_directive`, `glossary`, `capabilities`, `tool_ids`, `skill_ids`, `thread_start_tools`, `secrets`, `user_properties_forms`, `mcp_servers`, `allow_client_variables`, `knowledge_ids`, `avatar_summary_config`, `force_language`, `opening_phrase`, `model_configuration`, `name`/`description`/`tags`/`status`. Writable with a **partner admin KS**, ungated. **Knowledge linkage rides this same door**: first call `POST /v1/knowledge/add` on the brain host (returns an `{id,...}` record), then pass the returned id as `knowledge_ids` in the intellect create/update DTO. Linkage + `use_knowledge_base:'on'` persist with no separate linking call. It is a `model_fields_set` PATCH (omitted TOP-LEVEL fields are preserved), but `capabilities`/`secrets` are **full-replace sub-dicts**, so the SDK read-merge-writes them (via `mergeCapabilityWrite` / the secrets mask-and-keep guard); `IntellectConfig.patch` is the one place that logic lives.

`EDITABLE_FIELDS` in `intellect-config.js` is the exact list of keys `v1/intellect/get` echoes and `v1/intellect/update` accepts for a partner admin KS. `patch()` rejects any other key before the network call, and `describe()` returns exactly these keys. When adding a field setter, first confirm the key round-trips through `intellect/update` and `intellect/get` with a partner admin KS, then add it to `EDITABLE_FIELDS`.

### Honest limits surfaced by the SDK

[README.md's "Honest limits"](../../README.md#honest-limits) covers the writable-surface rule, no-verbatim-speech, and the `force_experience`/`model_type` hint caveats. Read that first. The rest are architecture-level limits not covered there:

- **External (BYO-LLM) intellects are not supported.** `intellects.create` rejects a body containing `url`/`protocol` with a typed `bad_request`.
- **Secrets are write-only** — values never read back; the no-leak guarantee is the name-only response contract, not `redact()`. Client-side encryption / BYOK is server-managed (not buildable).
- **`previewPrompt`/`snapshot`/`restore` are client-side** — a replica of the author layer only (server-injected capability-conditional prompt blocks are not reproducible) and a browser-local history (the server has no versioning).
- **`agent/list` filter keys are narrow.** `filter` is forwarded as-is; the server accepts only `agentId`, `adminTagsIn`, `adminTagsNotIn`, `searchValue` and 400s on anything else. Tag the **agent** with `adminTags` at create time to group; avatars carry no tag field, but `avatar/create` accepts+stores it silently (never echoed back) while `avatar/update` 400s on it — see `Avatars.create`'s JSDoc.

The SDK's own `node:test` suite (`test/`) exercises every one of these surfaces against the real backend and against injected fakes — see `README.md` for the full command list.

## Related docs

| Doc | Covers |
|---|---|
| [resilience-and-failure-handling.md](resilience-and-failure-handling.md) | Failure modes, TURN/relay, and the tool-call-spiral breaker touched on above |
| [../ARCHITECTURE-REFERENCE.md](../ARCHITECTURE-REFERENCE.md) | Back to the index |
