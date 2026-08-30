---
name: agentic-avatar
description: Create, configure, and run Kaltura Agentic Avatar agents (face + voice + brain) using the `@kaltura/intelligent-agents` SDK's `Management` class — no raw curl calls, no hand-built JSON bodies.
license: MIT
---

# Kaltura Agentic Avatar — SDK Skill

Build and operate conversational AI avatar agents entirely through the
`@kaltura/intelligent-agents` SDK's `Management` client. Every operation below
is a typed method call, not a curl command — the SDK owns argument validation,
KS-type enforcement, read-merge-write safety, and deployment-gate probing.

Ships as part of this repo (`kaltura/intelligent-agents-sdk`) — every file
path below is relative to the repo root. `docs-site-avatar` (Nova, a
reference app built on this SDK) is a separate sibling repo; see its own
`server/provision.mjs` for a complete real-world example of everything in
this skill.

## Setup

```bash
export AGENTIC_PARTNER_ID=...
export AGENTIC_ADMIN_SECRET=...
# or drop a .env in this repo root and load it yourself (no .env.example here — see GETTING-STARTED.md)
```

```js
import { Management } from '@kaltura/intelligent-agents/management';
// from inside this repo (no package install), use the relative path instead:
// import { Management } from '../src/management/index.js';

const kaltura = new Management({
  partnerId: process.env.AGENTIC_PARTNER_ID,
  adminSecret: process.env.AGENTIC_ADMIN_SECRET,
  // agenticUrl/genieUrl/ovpUrl default to US production — override for another region
});
```

One `Management` instance mounts every resource namespace: `sessions`,
`agents`, `avatars`, `catalog`, `application`, `intellects`, `intellectConfig`,
`tools`, `skills`, `conversations`, `threads`, `messages`, `feedback`,
`followups`, `knowledge` — plus top-level `converse`/`converseOnce`/`provision`
convenience methods. Full constructor options and every method's JSDoc:
`src/management/client.js`.

## KS (session token) types

Two backends, two KS shapes — never mix them. All minted via `kaltura.sessions`:

| Kind | Method | Privilege string | Entitlement | Use for |
|---|---|---|---|---|
| Admin | `sessions.createAdminToken({ttlSeconds?})` | `disableentitlement` | OFF | Management-plane calls (everything in this skill except the runtime) |
| Conversation | `sessions.createConversationToken({configId, ttlSeconds?, restrictions?})` | `geniegpcid:<configId>` | ON | Server-side chat with one intellect |
| Agent | `sessions.createAgentToken({agentId, ttlSeconds?, restrictions?})` | `agentid:<agentId>` | ON | Chat scoped to one agent, not a raw configId |
| Widget | `sessions.createWidgetToken({widgetId})` | (server-derived) | ON | Public, secret-free — safe to mint from a browser |

`sessions.revoke(tokenOrKs)` ends a token now. The SDK throws before any
network call if you try to mint a conversation/agent/widget token with
entitlement disabled — the two-KS-type invariant is enforced in code, not
just documentation.

## Quickstart: one call to a talking agent

```js
const admin = await kaltura.sessions.createAdminToken();
const agent = await kaltura.provision({
  brief: 'A friendly yoga-studio receptionist',
  ks: admin.ks,
});
// agent: { configId, agentId, widgetId, voiceId, visualId, profile, warnings? }

const reply = await kaltura.converseOnce(agent.configId, 'Hello, what can you help me with?');
console.log(reply.text);
```

`provision()` runs the full pipeline in one call: generate a persona profile
→ create the intellect → write its prompts → pick a preset voice + visual →
create the avatar → create the agent → resolve its widgetId. It also accepts
optional `voiceId`, `visualId`, `adminTags`, `maxConversationLength`,
`idempotencyKey`, `capabilities`, `tools`, `knowledge` — each applied in a
non-fatal, feature-detected post-configure step if present. Full option list
and internal sequence: `src/management/provision.js`.

`converse`/`converseOnce` mint their own conversation token from `configId` if
you don't pass one — pass an existing `ks` (object-form, from
`createConversationToken`) to reuse one across turns instead of re-minting.

## Building an agent step by step (when you need control `provision()` doesn't give you)

1. **Mint an admin token.** `const admin = await kaltura.sessions.createAdminToken();`
2. **Create the intellect (the brain).**

   ```js
   const intellect = await kaltura.intellects.create({
     name: 'Yoga Studio Receptionist',
     // type/status default; url/protocol rejected — see intellects.js JSDoc
   }, admin.ks);
   const configId = intellect.configId;
   ```
3. **Write its prompts.** `kaltura.intellects.setPrompts(configId, { goal, targetAudience, restrictedTopics }, admin.ks)` —
   lints by default (see Prompt authoring below).
4. **Pick a voice + visual from the catalog.**

   ```js
   const voices = await kaltura.catalog.list(admin.ks, { type: 'voice', pageSize: 1 });
   const visuals = await kaltura.catalog.list(admin.ks, { type: 'visual', pageSize: 1 });
   ```
   Note the argument order: **`ks` first, `opts` second** — this is the convention across
   nearly every `.list()` method in the SDK (`agents.list`, `avatars.list`, `intellects.list`,
   `tools.list`, `skills.list`, `threads.list`, `messages.list`).
5. **Create the avatar (face + voice binding).**
   `const avatar = await kaltura.avatars.create({ voiceId, visualId, name }, admin.ks);`
6. **Create the agent — needs only the intellect's configId.**

   ```js
   const agent = await kaltura.agents.create({
     intellect: { intellectType: 'genie', id: configId },
     avatarId: avatar.id,
   }, admin.ks);
   ```
   No discovery step required beforehand.
7. **Resolve its public widgetId.** `const { widgetId } = await kaltura.application.resolveWidgetId(agent.id, admin.ks);`
   Idempotent — call it again any time and you get the same id back.
8. **Talk to it.** `await kaltura.converseOnce(configId, 'Hello!');`

For the full endpoint/DTO reference behind every one of these calls (exact
payload shapes, defaults, validation rules), see `API-REFERENCE.md` — this
skill documents *how to call the SDK*, not the wire format underneath it.

## Configuring an existing intellect — `intellectConfig`

`IntellectConfig` is a facade over a single read-merge-write primitive
(`patch(configId, patchOrFn, ks)`) — every setter below is a thin, validated
wrapper around it, so a partial write never silently drops sibling fields.

| Method | Does |
|---|---|
| `patch(configId, patchOrFn, ks)` | Generic read-merge-write. `patchOrFn` is a partial object or a `(current) => partial` function. |
| `setCapabilities(configId, dict, ks)` | Full-replace-dict write, ALL-OR-NOTHING on the `disabled` veto (see Capabilities below). |
| `setCapability(configId, name, state, ks)` | One capability by name. |
| `setToolIds(configId, toolIds, ks)` | Attach standalone Tools (see Tools below) — `[]` detaches all. |
| `setSkillIds(configId, skillIds, ks)` | Attach standalone Skills, each `{id, mode}` with `mode` in `SKILL_MODES` (`'adhoc'`/`'preloaded'`). |
| `setSecrets(configId, entries, ks)` | Write-only; prior secrets round-trip as the mask sentinel so they're kept. |
| `listSecretNames(configId, ks)` | Names only — values are never returned. |
| `setUserPropertiesForms(configId, forms, ks)` / `clearUserPropertiesForms(configId, ks)` | Structured-data forms the agent emits (lead capture etc). |
| `setAllowClientVariables(configId, enabled, ks)` | Toggle the per-request `request_vars` gate. |
| `setMetadata(configId, {name?, description?, tags?}, ks)` | Row metadata. |
| `setKnowledgeIds(configId, knowledgeIds, ks)` | Ungated Path A knowledge linkage — capped at one id. |
| `setMcpServers(configId, servers, ks)` | Map of `{name: {url}}` — ungated. |
| `setBrainConfig(configId, cfg, ks)` / `brainConfigAvailable(ks)` | Deployment-gated (see below). |
| `describe(configId, ks)` | One-shot read of the whole editable surface, partitioned `editable`/`readOnly` with a note on every read-only field. |

`EDITABLE_FIELDS`: `prompts`, `base_directive`, `glossary`, `capabilities`,
`tool_ids`, `secrets`, `user_properties_forms`, `mcp_servers`,
`allow_client_variables`, `knowledge_ids`, `skill_ids`, `name`, `description`,
`tags`, `status`. `type` is immutable — `patch()` throws if you try to change
it. Everything else (`web_search_config`, `run_quota_check`,
`agent_avatar_llm`, `avatar_config`) is read-only; `describe()` surfaces why.

## Capabilities

15 named `AssistantCapability` flags, each `'on'`/`'off'`/`'disabled'`.
`disabled` is a hard veto — a partner/env-level disable overrides any
per-request `'on'`. `capabilities` is a **full-replace sub-dict** on
`v1/intellect/update` (a partial write drops siblings you omit), which is why
every SDK setter reads-merges-writes instead of sending a bare partial.

```js
await kaltura.intellects.setCapability(configId, 'use_web_search', 'on', admin.ks);
const resolved = await kaltura.intellects.resolveCapabilities(configId, admin.ks);
```

Full list and per-capability notes: `CAPABILITIES`/`CAPABILITY_INFO` in
`src/management/capabilities.js`.

## Tools and Skills (partner-level, referenced by id)

Tools and Skills are standalone entities at the partner level — an intellect
only *references* them via `tool_ids`/`skill_ids` (see `intellectConfig`
above). Build a tool body with the typed helpers in `src/management/tools.js`
(`tools.api`/`tools.csv`/`tools.code`) rather than a raw object.

```js
const tool = await kaltura.tools.add(
  tools.client('navigate_to_slide', { slide_num: { type: 'int', required: true } }),
  admin.ks,
);
await kaltura.intellectConfig.setToolIds(configId, [tool.id], admin.ks);
```

| Resource | `add` | `get` | `list` | `update` | `delete` |
|---|---|---|---|---|---|
| `tools` | `add(tool, ks)` | `get(id, ks)` | `list(ks, opts?)` | `update(id, patch, ks)` | `delete(id, ks, confirm)` |
| `skills` | `add(body, ks)` | `get(id, ks)` | `list(ks, opts?)` | `update(id, patch, ks)` | `delete(id, ks, confirm)` |

Both `update` methods are real — don't assume Skills lacks
one. Every `delete` takes an explicit `confirm` argument (destructive ops are
never a bare flag on a read call). Before creating a Tool, check for a
same-named one you should reuse instead of duplicate-erroring — `provision.js`'s
`applyTools` shows the upsert-by-name + reference-safety pattern (never mutate
a Tool another intellect still references without checking first).

## Secrets

Write-only, per-intellect, via `src/management/secrets.js` (also mirrored on
`intellectConfig.setSecrets`/`listSecretNames`): `listNames(configId, ks)`,
`has(configId, name, ks)`, `set(configId, entries, ks)`,
`delete(configId, name, ks, confirm)`, `replaceAll(configId, entries, ks, confirm)`,
`validate(configId, ks)` (checks that every `secrets.*` reference in the
prompts resolves to a stored name). Values are never echoed back on any read.

## Prompt authoring

`intellects.setPrompts(configId, prompts, ks)` lints by default —
`src/management/prompt-lint.js` exports `lintPrompts`/`assembleSystemPrompt`/`SYS_VARS`
for building and checking prompt bodies before you send them.
`intellects.previewPrompt(configId, ks, opts)` — **ks second, opts third** —
returns a client-side replica for a quick sanity check; it is not byte-exact
with what the server actually assembles, so don't assert on it in tests.

## Versioning a brain

`intellects.snapshot(configId, ks)` / `restore(snapshot, ks, opts)` /
`diffSnapshots(a, b)` — all client-side. `restore` takes the **full snapshot
object first** (it reads `configId` from `snapshot.configId` internally), ks
second.

## Deployment-gated writes — probe, never fake success

Two write paths route through `partner-config/update`, which 403s for a
partner admin KS on the current deployment. Both probe first and return a
typed, non-throwing receipt instead of pretending the write landed:

```js
const status = await kaltura.intellects.brainConfigAvailable(ks);   // {available:false, reason?}
if (status.available) await kaltura.intellects.setBrainConfig(configId, cfg, ks);

const linkStatus = await kaltura.knowledge.linkAvailable(ks);
```

`intellectConfig.setBrainConfig`/`brainConfigAvailable` just delegate to the
same `Intellects` methods — use whichever namespace you already have in
scope. Never call `setBrainConfig` without checking `brainConfigAvailable`
first in code you ship; the method itself won't throw on a 403, it returns
`{applied:false, reason}`.

## Knowledge — ground the agent on documents ("Path A", ungated)

Path A is fully SDK-native with zero 403s. Path B
(re-pointing an *existing* intellect via `partner-config/update` /
`knowledge.linkRecords`) is still gated — check `knowledge.linkAvailable(ks)`
before reaching for it.

```js
const category = await kaltura.knowledge.findOrCreateCategory({ name: 'Yoga Studio Docs' }, admin.ks);
const doc = await kaltura.knowledge.uploadMarkdown({
  categoryId: category.id,
  title: 'Class schedule',
  markdown: '# Schedule\n...',
}, admin.ks);
const record = await kaltura.knowledge.addRecord({ categoryId: category.id }, admin.ks);
await kaltura.intellectConfig.setKnowledgeIds(configId, [record.id], admin.ks);
// or pass knowledge_ids straight into intellects.create() for a brand-new agent
await kaltura.intellects.setCapability(configId, 'use_knowledge_base', 'on', admin.ks);
```

`knowledge_ids` is capped at one record per intellect (`setKnowledgeIds`
throws before any network call if you pass more than one). RAG retrieval
works only after async indexing completes — but
`kaltura.knowledge.isIndexed(record.id, admin.ks)` does NOT tell you that: its
`ready` flag reflects the knowledge record's own container-lifecycle status
(`ready:true` immediately on creation, before any entry has indexed), not
whether indexing has finished. Don't use `knowledge.corpusStatus` (counts
entries that exist, not whether they've finished embedding) or
`knowledge.search`'s "couldn't find relevant information" reply (fires
identically for an unindexed KB, an indexed KB with `use_knowledge_base` off,
or a genuine no-match query) as an indexing-status signal either. A per-entry
check (`kaltura.knowledge.entryStatus()`) is coming, with general rollout
expected in early September 2026 — don't build on it yet. Until then, budget a
fixed wait after upload before assuming content is searchable — see
API-REFERENCE.md § Ground the Agent.

## Talking to an agent — conversations, threads, messages

```js
const conv = await kaltura.sessions.createConversationToken({ configId, ttlSeconds: 3600 });
const reply = await kaltura.conversations.send({ userMessage: 'What are your hours?' }, conv.ks);
```

| Namespace | Key methods |
|---|---|
| `conversations` | `send(opts, ks)`, `status(ks)` |
| `threads` | `list(ks, opts?)`, `get(id, ks)`, `transcript(id, ks)`, `rename(id, title, ks)`, `delete(threadIds, ks, confirm)` |
| `messages` | `list(ks, opts?)`, `share(id, newTitle, ks)`, `report(ks, opts?)`, `reportSummary(ks, opts?)` |
| `feedback` | `add(opts, ks)` |
| `followups` | `getSuggested(ks)` |

`report`/`reportSummary` return parsed/aggregated results, not raw
passthroughs — both carry a `_meta.generatedAt` provenance receipt.

For a streaming/live-socket conversation instead of one-shot HTTP, use
`kaltura.converse(configId, message, opts, ks)` (an async generator) or the
Experience runtime below — HTTP `converse`/`conversations.send` never reaches
the speech engine.

## Discovering what's on the account

```js
const agents = await kaltura.agents.list(admin.ks).all();     // every list() returns a paginator
const avatars = await kaltura.avatars.list(admin.ks, { pageSize: 50 });
const intellects = await kaltura.intellects.list(admin.ks);
```

`list(ks, opts)` — ks first — is consistent across every resource. Use
`.all()` on the returned paginator to walk every page, or pass `pageSize`/page
cursors in `opts` to page manually.

## Cloning a custom voice

```js
const voice = await kaltura.catalog.createVoice(fileBufferOrPath, { name: 'Studio Voice' }, admin.ks);
// or import from a provider instead of uploading a sample:
const imported = await kaltura.catalog.importVoiceFromElevenLabs(providerVoiceId, admin.ks);
```

Custom visual images work the same way via `catalog.createVisual(file, attrs, ks)`.

## The Experience runtime (browser — live avatar sessions)

Everything above is server-side (`Management`). The live, in-browser
video/voice runtime is a separate entry point:

```js
import { KalturaAvatarSession } from '@kaltura/intelligent-agents/experience';
import { io } from 'socket.io-client';   // your own dependency — injected, never bundled

const session = new KalturaAvatarSession({
  token,                          // widget KS from appInit — must keep entitlement ON
  conversationManagerUrl, srsBaseUrl, turnServerUrl,   // from appInit
  videoEl: document.getElementById('avatar'),
  socketFactory: (url, opts) => io(url, opts),
  disclosureText: 'You are speaking with an AI-generated avatar.',
  requireDisclosureAck: true,     // gate the first turn on acknowledgeDisclosure() — EU AI Act Art. 50
});
session.on('transcript', ({ text, type }) => render(text, type));
await session.connect();
await session.speak('Hello! How can I help you today?');
```

Mint the browser-side token client-side with no server or secret:
`sessions.createWidgetToken({widgetId})` + `application.appInit(widgetKs)`
(the widget KS itself needs no admin secret — see `docs-site-avatar`'s
`public/avatar-session.js` for a real example, in the sibling repo).

The constructor does not police which KS kind `token` carries — a real KS's
privileges are encrypted and unreadable client-side, so that check would be
inert anyway. Mint a `geniegpcid`/`agentid`/widget token server-side for the
live runtime; see SECURITY.md's KS guidance for agents.

### Key session methods

| Method | Does |
|---|---|
| `connect()` / `disconnect()` | Open/close the socket + both WebRTC legs (ASR uplink, WHEP downlink). |
| `speak(text)` | Inject text as if spoken — reaches the speech engine (unlike HTTP `converse`). |
| `interrupt()` | Barge-in: stop the avatar mid-turn. |
| `startTapToTalk()` / `endTapToTalk()` | Push-to-talk mic control — see `docs/VOICE-INPUT-MODES.md` for open-mic vs push-to-talk tradeoffs. |
| `setDynamicPrompt(data)` | Serialize `data` into the `page_context` request variable — the "what's on screen" context the brain reads via `{{page_context}}` (pair with the `PAGE_CONTEXT_PROMPT` block from `./management`). |
| `updateRequestVars(vars)` | Merge `vars` into the `{{var}}` Jinja map — send only changed keys; values persist on the thread for the rest of the session. |
| `onToolCall(name, handler, argsSchema?)` | Register a handler for an agent-driven client-side command (navigate, render widget, …). Returns an unsubscribe function. |
| `respondToTool(id, response)` | ACK a `waitForResponse:true` tool call with a real result the brain can see. |
| `notifyHtmlElementClick(info)` / `submitStructuredDataForm(values)` | App-initiated signals back to the brain (ungated — these aren't agent-pushed actions). |
| `acknowledgeDisclosure()` | Clears the `requireDisclosureAck` gate. |
| `listDevices()` / `switchMic(deviceId)` / `setAudioOutput(deviceId)` | Device management. |
| `waitForCapacity(opts)` | Await capacity if the pool is full rather than failing immediately. |

Full method/event source: `src/experience/session.js` (2000+ lines — the
canonical reference; read it directly for anything not covered here).

### Event model

`session.on(event, handler)` / `off(event, handler)`. Every event the runtime
emits: `agentActionDenied`, `avatarStartTalking`, `avatarStopTalking`,
`brainSegment`, `brainStalled`, `capacityChanged`, `connectionQuality`,
`connectivityChanged`, `disclosure`, `ended`, `error`, `hardwareMuteChanged`,
`idleWarning`, `interrupted`, `localMicLevel`, `localSpeakingChanged`,
`mediaRecovered`, `mediaRecovering`, `reconnected`, `reconnecting`,
`responsePending`, `responseSettled`, `resumed`, `resumeReady`,
`smartTurnStatus`, `speechChunk`, `spiralRecovered`, `stateChange`,
`streamReady`, `tapToTalkEnded`, `tapToTalkStarted`, `timeExpired`,
`timeWarning`, `toolCall`, `toolCallInvalid`, `toolCallResult`,
`toolSpiralDetected`, `toolSpiralRecovering`, `transcript`, `turnEnd`,
`turnStart`, `userStartedTalking`. Exact payload shapes: `docs/WIRE-PROTOCOL.md`.

### Guardrails (constructor options, gate BEFORE effect)

- `onBeforeSend(text, ctx)` — inspect/transform/block outbound user text
  before it reaches the brain. Return a string to send that instead, `undefined`
  to send unchanged, `false`/throw to block the turn.
- `onAgentAction(action)` — gate agent-*initiated* actions (navigate,
  render-GenUI, lead capture, vision) before they take effect. Return
  `false`/throw to veto; sync or async.
- A tool-call spiral circuit breaker (`toolSpiralDetected` → session-scoped
  hard limit → automatic cold reconnect) guards against a runaway repeated
  tool call — see the `_checkHardToolSpiral` doc comment in `session.js` for
  the live incident (438 calls in 9 minutes) that motivated it. `recoverFromSpiral`
  (default `true`) auto-resends the abandoned turn after recovery.

### GenUI (agent-rendered widgets)

```js
import { ExperienceRenderer, mountWidget } from '@kaltura/intelligent-agents/experience/genui';
```

`ExperienceRenderer`, `SegmentAssembler`, `parseWidget`/`normalizeRuntime`,
`DEFAULT_RENDERERS`, `mountWidget` — the segment→widget layer for boards,
flashcards, galleries, forms, and the rest of the nine GenUI widgets. Full
per-widget wire shapes and rendering anchors: `docs/GENUI-REFERENCE.md`.

### Presenter (deck-walkthrough plugin)

For a "the avatar guides through a deck" app, `Presenter` wraps
`KalturaAvatarSession` and owns the per-slide context injection + navigation
glue every deck app otherwise hand-rolls:

```js
import { Presenter } from '@kaltura/intelligent-agents/experience/presenter';

const presenter = new Presenter({
  session,
  slides,                                        // [{title, talking_points, category, content}]
  context: { financials, guidance },              // merged into every context payload
  onSlideChange: (n, slide) => renderPdfPage(n),   // your renderer
  storage: window.localStorage,                    // optional — enables session memory
  oneNavPerTurn: true,                             // guards against a brain-restart double-nav
});
await session.connect();
await presenter.start();
```

Navigation runs through exactly one deterministic mechanism —
`session.onToolCall('navigate_to_slide', …)` — never speech-parsing, so an
ordinary narration mentioning a slide number can never misfire as a nav
command. `goTo(n, reason)`, `refreshContext()`, `saveMemory()`, `clearMemory()`,
`recordQuestion(text)`, `appendSlide(slide)` are the public control-surface
methods; `covered`/`questions`/`lastNav`/`lastContextSlide`/`secondsOnCurrentSlide`/
`navSuppressedThisTurn` are read-only getters for UI/analytics. App hooks
(`extendContext`, `extraMemory`/`restoreMemory`, `onTurnText`, `slideContext`) let a
non-default slide shape or extra per-app state plug into the same machinery
instead of re-implementing it. Full constructor JSDoc: `src/experience/presenter.js`.

## Design principles for a well-behaved agent

1. **Goal** — one clear objective in `prompts.goal`; vague goals produce
   rambling agents.
2. **Target audience** — `prompts.targetAudience` shifts tone/vocabulary; set
   it explicitly rather than relying on the model to infer it.
3. **Restricted topics** — `prompts.restrictedTopics` is enforced content, not
   a suggestion; use it for anything the agent must never discuss.
4. **Voice selection** — pick from `catalog.list(ks, {type:'voice'})` or clone
   one (`catalog.createVoice`/`importVoiceFrom*`); match voice to persona.
5. **Visual selection** — same for `type:'visual'`; `catalog.createVisual` for
   a custom image.
6. **Opening phrase** — pass a real scripted line, or `'<blank>'` (the SSML
   silence sentinel) if you want no opening line at all — never `''`, which
   crashes the session server on the very first turn (a known bug; see
   `avatars.create`'s JSDoc for the exact reasoning).
7. **Glossary** — `intellectConfig.patch(configId, {glossary}, ks)` for
   domain terms/pronunciations the brain should know verbatim.
8. **Motion control** — capabilities like `avatar_show_content` /
   `avatar_filler` shape how animated the avatar is between turns.
9. **Max conversation length** — `provision()`'s `maxConversationLength`
   option, or set it directly via the intellect's editable fields.
10. **Widget layouts** — plan `tool_ids` and GenUI widget usage together; a
    tool that renders a widget needs a matching `onToolCall`/`show_widget`
    handler on the Experience side (see GenUI above).

## Where to look for more depth

| Question | Read |
|---|---|
| Exact endpoint, full lifecycle, use-case catalog | `API-REFERENCE.md` |
| Zero to a talking agent, no prior knowledge | `GETTING-STARTED.md` |
| Backends, live-video runtime overview, scaling | `docs/ARCHITECTURE.md` |
| Exact socket event / payload field / WebRTC config | `docs/WIRE-PROTOCOL.md` |
| Every GenUI widget, wire shape, SDK function | `docs/GENUI-REFERENCE.md` |
| Open-mic vs push-to-talk | `docs/VOICE-INPUT-MODES.md` |
| The client-side command contract | `docs/CLIENT-COMMANDS.md` |
| A complete real app built on this SDK (sibling repo) | `docs-site-avatar/server/provision.mjs` + `docs-site-avatar/README.md` |
| SDK invariants every change must hold | `SDK_CONSTITUTION.md` |

Before committing any change that touches documented SDK behavior:

```bash
node tools/check-docs.mjs
```
