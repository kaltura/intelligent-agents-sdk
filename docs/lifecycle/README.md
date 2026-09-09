[← Back to the API Reference index](../../API-REFERENCE.md)

# Lifecycle — Event-Driven Rules

Today, "summarize every ended session and email the account owner" means polling for finished threads yourself. Lifecycle removes the polling: create a **rule** once, and the backend fires its **action** automatically every time a matching event happens, server-side. Mounted at `mgmt.lifecycle`.

This page is the field-by-field reference. New to Lifecycle? [`recipes.md`](recipes.md) is a hands-on walkthrough of the two action types you actually create, with a runnable example — it links back here instead of repeating this reference.

> **Gate: requires agentic-api `#364`.** This page describes the action model that shipped 2026-09-08 — live today on NVQ2, not yet on PROD. Probe readiness with `lifecycle.list(ks, {filter:{actionTypeIn:['sendInsightEmail']}})`: 400 `should not exist` on the old model, 200 once your account has `#364`.

---

## Rule shape

A rule is `{eventType, objectType, eventConditions, action}`:

- `eventType` — e.g. `session_ended`, `analysis_updated`.
- `objectType` — currently only `thread`.
- `eventConditions[]` — `{field, operator, value}` matchers, e.g. `{field:'object.agent_id', operator:'eq', value:'<uuid>'}`, `{field:'changed_keys', operator:'has_all', value:[...]}`. `field` is a dot-path into the event payload (see [Discovery and dry-run testing](#discovery-and-dry-run-testing) for which paths exist per event). A `{path, op}` shaped entry is rejected with a 400.
- `action` — a plain object, passed straight through, not built by the SDK. See [The four action types](#the-four-action-types) below.

---

## The four action types

The backend recognizes four `actionType` values, not two. Two are meant for you to create; the other two only exist to power system preset rules — creating them yourself is rejected client-side by the SDK (see below) and, if you bypass that, has no effect server-side either, because their behavior is hardcoded and ignores anything you pass.

| `actionType` | Who creates it | What it does | Why / when you'd use it |
|---|---|---|---|
| `triggerInsightSettingsKai` | You | Runs an LLM over the conversation and writes back exactly the fields defined by the [`InsightSettings`](#insightsettings--reusable-custom-insight-definitions) entities named in `insightSettingsIds` | Whenever you need a specific piece of structured data pulled out of a conversation: a topic tag for a dashboard, a lead-quality score, a recommended next step. |
| `sendInsightEmail` | You | Sends an email to a Kaltura user, filling an email template from the thread's already-extracted insight values | Whenever a human needs to know the moment a specific insight is ready — e.g. alert a support lead as soon as a conversation's analysis lands. |
| `_triggerKaiBase` | Nobody — system preset only | Always produces one fixed insight, key `SUMMARY`, using a built-in prompt | Never create this yourself — every agent already gets it automatically, with no rule needed. Covered [below](#every-session-already-gets-a-summary-for-free). |
| `triggerDtcKai` | Nobody — powers a preset that's disabled for every account today | If ever enabled, would turn each of the intellect's configured lead-capture form fields (`intellectConfig.user_properties_forms` — the fields you'd ask a lead for, e.g. name/company/email) into its own insight | Not usable today under any account. Ignore it. |

**`triggerInsightSettingsKai`** references 1 to 20 [`InsightSettings`](#insightsettings--reusable-custom-insight-definitions) entities by id: `{ insightSettingsIds: [id, id, ...] }`. Each `InsightSettings` entity — created once, reused across as many rules as you like — carries its own `key`, `title`, `prompt`, and `valueType` (`'string'`/`'number'`/`'boolean'`/`'arrayString'`/`'arrayNumber'`/`'arrayBoolean'`). An id that never existed for this partner is rejected immediately: `lifecycle.create`/`.update` throw `INVALID_INSIGHT_SETTINGS` naming the missing id (the agentic API replies HTTP 200 with a `KalturaAPIException` body, which the SDK surfaces as a thrown error, same as any other typed API error). A **dangling** reference — an id that existed when the rule was created but was deleted afterward — isn't caught the same way: `insightSettings.delete` runs no in-use scan, so the rule keeps pointing at a gone entity until it actually fires, and only then does that extraction fail. Every rule extracting insights on the same event merges into one LLM batch — don't create an insight-settings entity keyed `SUMMARY`, see [below](#every-session-already-gets-a-summary-for-free).

**`sendInsightEmail`** mails a rendered insight summary to `recipients` (Kaltura user ids, not raw email addresses — the messaging service resolves the actual email from that user's Kaltura profile), using either an explicit `templateId` or an auto-created `presetType` template (supports `{{template}}` placeholders like `{{object.user_id}}`). Only fires on `eventType:'analysis_updated'` — attaching it to a `session_ended` rule is a server-side no-op.

```js
const sentiment = await mgmt.insightSettings.create({ key: 'SENTIMENT', title: 'Sentiment', prompt: 'The caller\'s overall sentiment: positive, neutral, or negative.', valueType: 'string' }, ks);
const topic = await mgmt.insightSettings.create({ key: 'TOPIC', title: 'Topic', prompt: 'The main topic discussed, in 3 words or fewer.', valueType: 'string' }, ks);

await mgmt.lifecycle.create({
  name: 'Summarize on session end',
  systemName: 'auto_summary_v1',
  eventType: 'session_ended',
  objectType: 'thread',
  action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: [sentiment.id, topic.id] },
}, ks);
```

Every conversation gets a structured recap the moment it ends, with zero app-side code. `SUMMARY` is deliberately not requested — every partner already has an always-on preset rule producing one for free, merged into the same batch as this rule's own insights.

> **Old model, still on PROD:** `triggerInsight`/`insights:[{insightKey,valueType,prompt?}]`, `triggerDataToCollectInsight`, and `triggerOverridableSummaryInsight` were renamed in agentic-api `#364`. `mgmt.lifecycle.create`/`.update` reject the old names before any network call, naming the replacement — you'll see this if your account hasn't taken `#364` yet and you paste code from a newer example. See the gate note at the top of this page.

---

## InsightSettings — reusable custom-insight definitions

`mgmt.insightSettings` — five methods (`create`, `get`, `list`, `update`, `delete`) on the agentic host, admin KS, `{status, data}` unwrap (same shape as `mgmt.avatars`). Each entity is `{id, key, title, prompt, valueType, status}` and is referenced by id from a `triggerInsightSettingsKai` action — see [above](#the-four-action-types).

| Method | Endpoint | Kind | Notes |
|---|---|---|---|
| `insightSettings.create({key, title, prompt, valueType}, ks)` | `POST /v1/insight-settings/create` | WRITE, not idempotent | all 4 fields required |
| `insightSettings.get(id, ks)` | `POST /v1/insight-settings/get` | READ | |
| `insightSettings.list(ks, opts)` | `POST /v1/insight-settings/list` | READ | `{offset,limit}` pager; `opts.filter` (`statusEqual`, `idsIn`) and `opts.orderBy` (`+createdAt`/`-createdAt`) pass through 1:1 |
| `insightSettings.update(id, patch, ks)` | `POST /v1/insight-settings/update` | WRITE, idempotent | patch any of `key`/`title`/`prompt`/`valueType`/`status` (`'active'`\|`'disabled'`) |
| `insightSettings.delete(id, ks, confirm)` | `POST /v1/insight-settings/delete` | WRITE, destructive | `requireConfirm` gate. No in-use scan: a rule still referencing a deleted id fails loudly at match/trigger time (`INVALID_INSIGHT_SETTINGS`) rather than silently keeping a dangling reference. |

`id` is a Mongo ObjectId string; a malformed id 400s live (`id must be a mongodb id`) rather than being pre-validated client-side.

---

## Scoping a rule to one agent

`eventConditions` can only filter on fields [`describeFields`](#discovery-and-dry-run-testing) actually reports. For `thread`/`analysis_updated` today that's `object.agent_id`, `object.thread_id`, `object.user_id`, and `changed_keys` (which insight keys were updated), **not** an insight's computed value — there is no `object.sentiment` field to filter on, since a sentiment score only exists as the *output* of a `triggerInsight` action, not an input `eventConditions` can inspect.

```js
await mgmt.lifecycle.create({
  name: 'Email support lead when this agent\'s analysis updates',
  systemName: 'analysis_alert_v1',
  eventType: 'analysis_updated',
  objectType: 'thread',
  eventConditions: [{ field: 'object.agent_id', operator: 'eq', value: '<agent-uuid>' }],
  action: { actionType: 'sendInsightEmail', recipients: ['<support-lead-kaltura-user-id>'], presetType: 'conversationInsightExample' },
}, ks);
```

**A rule filtering on `object.agent_id` only matches threads created with an agent-scoped KS.** Mint the conversation token with `mgmt.sessions.createAgentToken({ agentId })` (`agentid:<agentId>`), not `createConversationToken({ configId })` (`geniegpcid:<configId>`) — the latter has no agent claim at all, so the resulting thread's `agent_id` is `"default"` and can never match a rule scoped to a real agent uuid. This applies whether the conversation happens over `mgmt.conversations.send()`/`.stream()` or a real avatar/socket session — the agent binding lives entirely in the KS's privilege claim, not in the call itself. See [`createAgentToken`](../../src/core/session.js) for details.

---

## Every session already gets a SUMMARY, for free

A system-seeded rule, `preset__summary_on_session_ended`, runs `_triggerKaiBase` on every `session_ended` event, for every agent, with no opt-out.

Here's the mechanic that matters: **every rule whose action extracts insights on the same event gets merged into one batch, one LLM call — not one call per rule.** Create your own `triggerInsightSettingsKai` rule on `session_ended`, and it runs in the *same batch* as this preset. The result is one combined `thread_metadata.analysis` containing the preset's `SUMMARY` plus whatever you asked for.

Two consequences:

1. **Don't create an `InsightSettings` entity keyed `SUMMARY`.** You already get it for free.
2. **If you do anyway, your prompt never takes effect.** The batch is built with your rule's insights first and the preset's insight appended after; when both name the same key, the later one wins. The preset's default prompt is what reaches the LLM, not yours — it's a no-op, not a break.

There's no per-agent override for that default summary prompt today — the preset always uses its built-in prompt. If you need a custom summary, create your own `InsightSettings` entity with a different key (e.g. `RECAP`) and reference it from your own rule; it runs alongside the free `SUMMARY`, not instead of it.

None of this pushes the conversation transcript through the rule itself. `triggerInsightSettingsKai` (and the two system actions) send the backend's insight service a `threadId` and the schema of what to extract; that service fetches the transcript itself. You're only ever specifying *what to extract*, never *what to extract from*.

---

## Discovery and dry-run testing

The 4 discovery methods let a UI populate its own dropdowns instead of hardcoding enums that will drift from the backend:

```js
await mgmt.lifecycle.listObjects(ks);                              // [{ objectType: 'thread', description: '...' }]
await mgmt.lifecycle.listEvents('thread', ks);                     // { objectType: 'thread', events: [{ eventType: 'session_ended', description: '...' }, ...] }
await mgmt.lifecycle.describeFields('thread', 'session_ended', ks); // { objectType, eventType, fields: [{ path, type, description }, ...] }
```

**Dry-run a rule before a real event fires it** — `match(objectType, eventType, eventData, ks)`, where `eventData` is `{ object?, changed_keys? }` (not a bare `object` field). For `objectType:'thread'`, `object` is validated server-side: `agent_id`, `thread_id`, and `user_id` are all required strings — omitting any one 400s live:

```js
const { matchedRules } = await mgmt.lifecycle.match(
  'thread', 'session_ended',
  { object: { agent_id: 'agent-1', thread_id: 'thread-1', user_id: 'user-1' } },
  ks,
);
```

**Production already ships a system-seeded preset rule** — `match` can return rules you never created. Every partner, by default, has a preset rule (`id: "preset__summary_on_session_ended"`, `action.actionType: "_triggerKaiBase"`) that matches every `session_ended`/`thread` event. `matchedRules[]` groups related rules under a shared `groupKey` with `isGrouped:true` — don't mistake a grouped preset for something you configured:

```js
{
  matchedRules: [
    {
      rules: [
        { id: 'preset__summary_on_session_ended', action: { actionType: '_triggerKaiBase' } },
        { id: 'rule-you-created', action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: ['68b0000000000000000000a1'] } },
      ],
      isGrouped: true,
      groupKey: '_system_grouped_kai_insights',
    },
  ],
}
```

---

## Full CRUD + discovery method table

All against `https://api.avatar.us.kaltura.ai`. SDK: `mgmt.lifecycle`.

| Method | Endpoint | Kind | Notes |
|---|---|---|---|
| `lifecycle.create(body, ks)` | `POST /v1/lifecycle/create` | WRITE, not idempotent | mirrors `Tools#add` |
| `lifecycle.get(id, ks)` | `POST /v1/lifecycle/get` | READ | |
| `lifecycle.list(ks, opts)` | `POST /v1/lifecycle/list` | READ | `{offset,limit}` pager (`PagerDto`); `opts.filter` (`statusEqual`, `systemNameEqual`, `actionTypeIn`, `eventCondition`) and `opts.orderBy` (`+createdAt`/`-createdAt`) pass through 1:1 |
| `lifecycle.update(id, patch, ks)` | `POST /v1/lifecycle/update` | WRITE, idempotent | mirrors `Tools#update` |
| `lifecycle.delete(id, ks, confirm)` | `POST /v1/lifecycle/delete` | WRITE, destructive | `requireConfirm` gate; response is `{success}`, not `{id}` |
| `lifecycle.match(objectType, eventType, eventData, ks)` | `POST /v1/lifecycle/match` | READ (dry-run) | see [Discovery and dry-run testing](#discovery-and-dry-run-testing) |
| `lifecycle.listObjects(ks)` | `POST /v1/lifecycle/listObjects` | READ | |
| `lifecycle.listEvents(objectType, ks)` | `POST /v1/lifecycle/listEvents` | READ | |
| `lifecycle.describeFields(objectType, eventType, ks)` | `POST /v1/lifecycle/describeFields` | READ | |

---

## Related docs

| Doc | What it adds |
|---|---|
| [`recipes.md`](recipes.md) | Hands-on walkthrough of `triggerInsightSettingsKai` + `sendInsightEmail` chained together, common pitfalls, and a runnable example |
| [`docs/api/management-operations.md`](../api/management-operations.md) | Where Lifecycle sits alongside the other CRUD entities (agents, avatars, intellects, tools, skills, knowledge) |
