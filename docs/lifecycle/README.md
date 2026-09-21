[← Back to the API Reference index](../../API-REFERENCE.md)

# Lifecycle Rules: Event-Driven Rules

Today, "summarize every ended session and email the account owner" means polling for finished threads yourself. Lifecycle removes the polling: create a **rule** once, and the backend fires its **action** automatically every time a matching event happens, server-side. Mounted at `mgmt.lifecycle`.

This page is the field-by-field reference. New to Lifecycle? [`recipes.md`](recipes.md) is a hands-on walkthrough of the action types you actually create, with a runnable example. It links back here instead of repeating this reference.

---

## Rule shape

A rule is `{name, systemName, eventType, objectType, eventConditions?, action}`:

- `name`: a required, human-readable label.
- `systemName`: a required, caller-chosen identifier (e.g. `auto_summary_v1`), filterable via `list`'s `systemNameEqual`.
- `eventType`: e.g. `session_ended`, `analysis_updated`.
- `objectType`: currently only `thread`.
- `eventConditions[]`: `{field, operator, value}` matchers, e.g. `{field:'object.agent_id', operator:'eq', value:'<uuid>'}`, `{field:'changed_keys', operator:'has_all', value:[...]}`. `field` is a dot-path into the event payload (see [Discovery and dry-run testing](#discovery-and-dry-run-testing) for which paths exist per event). A `{path, op}` shaped entry is rejected with a 400.
- `action`: a plain object, passed straight through, not built by the SDK. See [The action types](#the-action-types) below.

---

## The action types

The backend recognizes three `actionType` values you can create. A fourth, internal-only value powers the built-in summary preset described [below](#every-session-already-gets-a-summary-for-free). You never construct it yourself.

| `actionType` | What it does | Why / when you'd use it |
|---|---|---|
| `triggerInsightSettingsKai` | Runs an LLM over the conversation and writes back the insights named in `insightSettingsIds`. Each id points at a reusable [`InsightSettings`](#insightsettings-reusable-insight-definitions) entity you defined ahead of time | Whenever you need a specific piece of structured data pulled out of a conversation: a topic tag for a dashboard, a lead-quality score, a recommended next step. |
| `sendInsightEmail` | Sends an email to a Kaltura user, filling an email template from the thread's already-extracted insight values | Whenever a human needs to know the moment a specific insight is ready, e.g. alert a support lead as soon as a conversation's analysis lands. |
| `triggerDtcKai` | Takes no fields of your own. Turns each of the target intellect's configured lead-capture form fields (`intellectConfig.user_properties_forms`, e.g. name/company/email) into its own insight; automatically skipped if none are configured | Whenever you already collect lead-capture fields on an intellect and want each one to also land as a conversation insight, with no per-field setup. |

**`triggerInsightSettingsKai`** takes `{ insightSettingsIds: string[] }`, up to 20 ids, each referencing an `InsightSettings` entity created via `mgmt.insightSettings.create()`. An id that doesn't exist, or isn't owned by your partner, is rejected at rule create/update time with a 400. At dispatch time, only ids whose insight setting currently has `status:'active'` actually resolve into an extraction. A `disabled` one is silently skipped.

**`sendInsightEmail`** mails a rendered insight summary to `recipients`. These are Kaltura user ids, not raw email addresses. The messaging service resolves the actual email from that user's Kaltura profile. Use either an explicit `templateId` or an auto-created `presetType` template; the template's `subject`/`body` reference single-brace tokens declared in `msgParamsMap`, e.g. `{SUMMARY}` or `{recipient.firstName}`. This action only fires on `eventType:'analysis_updated'`. Attaching it to a `session_ended` rule is a server-side no-op.

A `templateId` is more durable than a `presetType`. It points at a template you created yourself via [`mgmt.emailTemplates`](#emailtemplates-managing-the-templates-sendinsightemail-references) (see below). A `presetType`, instead, depends on the backend finding or creating a preset template on first dispatch.

```js
const sentiment = await mgmt.insightSettings.create({
  key: 'sentiment', title: 'Sentiment', prompt: 'Was the caller’s overall sentiment positive, neutral, or negative?', valueType: 'string',
}, ks);
const topic = await mgmt.insightSettings.create({
  key: 'topic', title: 'Topic', prompt: 'What was the main topic of this conversation, in 1-3 words?', valueType: 'string',
}, ks);

await mgmt.lifecycle.create({
  name: 'Summarize on session end',
  systemName: 'auto_summary_v1',
  eventType: 'session_ended',
  objectType: 'thread',
  action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: [sentiment.id, topic.id] },
}, ks);
```

Every conversation gets a structured recap the moment it ends, with zero app-side code. The built-in summary insight is deliberately not requested here. Every partner already has an always-on preset rule that produces one for free. It merges into the same batch as this rule's own insights.

### `InsightSettings`: reusable insight definitions

An `InsightSettings` entity is `{id, key, title, prompt, valueType, status}`, a named, reusable definition of one thing to extract. Mounted at `mgmt.insightSettings`, on its own `insight-settings/*` routes (same `{offset,limit}` pager as `mgmt.lifecycle`):

```js
const setting = await mgmt.insightSettings.create({ key, title, prompt, valueType }, ks); // WRITE, not idempotent
await mgmt.insightSettings.get(setting.id, ks);                                          // READ
await mgmt.insightSettings.list(ks, { filter: { statusEqual: 'active' } });               // READ
await mgmt.insightSettings.update(setting.id, { status: 'disabled' }, ks);                // WRITE, idempotent
await mgmt.insightSettings.delete(setting.id, ks, { confirmPermanent: true });            // WRITE, destructive
```

`valueType` is one of `'string'`/`'number'`/`'boolean'`/`'arrayString'`/`'arrayNumber'`/`'arrayBoolean'`. `prompt` is required. There's no built-in fallback prompt for any key name. `status` (`'active'`/`'disabled'`) controls whether a lifecycle rule referencing this id actually extracts it the next time it fires. Deleting the entity instead just leaves any referencing rule's `insightSettingsIds` dangling. That id is simply skipped going forward.

### `EmailTemplates`: managing the templates `sendInsightEmail` references

An email template is `{id, appGuid, name, subject, body, toAttributePath, msgParamsMap, status, ...}` on the Kaltura Messaging API, a separate host from the rest of this SDK. Mounted at `mgmt.emailTemplates`:

```js
const template = await mgmt.emailTemplates.create({
  appGuid: '<your-app-guid>',
  name: 'Conversation insight alert',
  subject: 'New insight on {recipient.firstName}\'s conversation',
  body: '<p>{SUMMARY}</p>',
  toAttributePath: '{recipient.email}',
  msgParamsMap: { recipient: { type: 'User' }, SUMMARY: { type: 'String' } },
}, ks); // WRITE, not idempotent

await mgmt.lifecycle.create({
  name: 'Email support lead when this agent\'s analysis updates',
  systemName: 'analysis_alert_v1',
  eventType: 'analysis_updated',
  objectType: 'thread',
  eventConditions: [{ field: 'object.agent_id', operator: 'eq', value: '<agent-uuid>' }],
  action: { actionType: 'sendInsightEmail', recipients: ['<support-lead-kaltura-user-id>'], templateId: template.id },
}, ks);
```

`appGuid`, `name`, `subject`, `body`, `toAttributePath`, and `msgParamsMap` are required. `body`/`subject`/`fromName` can reference the tokens declared in `msgParamsMap` (e.g. `{recipient.firstName}`). The rest of the CRUD surface (`get`/`list`/`update`/`delete`) is in the [method table](#full-crud--discovery-method-table) below.

This is the one resource in this SDK that authenticates with a plain `Authorization: Bearer <KS>` header instead of the `Authorization: KS <ks>` scheme every other resource uses. It's the same admin KS, but a different header, because it's a different backend.

---

## Scoping a rule to one agent

`eventConditions` can only filter on fields [`describeFields`](#discovery-and-dry-run-testing) actually reports. For `thread`/`analysis_updated` today that's `object.agent_id`, `object.thread_id`, `object.user_id`, and `changed_keys` (which insight keys were updated). It does **not** include an insight's computed value. There is no `object.sentiment` field to filter on. A sentiment score only exists as the *output* of a `triggerInsightSettingsKai` action, not an input `eventConditions` can inspect.

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

**A rule filtering on `object.agent_id` only matches threads created with an agent-scoped KS.** Mint the conversation token with `mgmt.sessions.createAgentToken({ agentId })` (`agentid:<agentId>`), not `createConversationToken({ configId })` (`geniegpcid:<configId>`). The latter has no agent claim at all, so the resulting thread's `agent_id` is `"default"` and can never match a rule scoped to a real agent uuid.

This applies whether the conversation happens over `mgmt.conversations.send()`/`.stream()` or a real avatar/socket session. The agent binding lives entirely in the KS's privilege claim, not in the call itself. See [`createAgentToken`](../../src/core/session.js) for details.

---

## Every session already gets a SUMMARY, for free

A system-seeded rule, `preset__summary_on_session_ended`, produces one fixed summary insight on every `session_ended` event, for every agent, with no opt-out and no customization lever. There's no field on any entity you can set to change its prompt.

Here's the mechanic that matters: **every rule whose action extracts insights on the same event gets merged into one batch, one LLM call, not one call per rule.** Create your own `triggerInsightSettingsKai` rule on `session_ended`, and it runs in the *same batch* as this preset. The result is one combined `thread_metadata.analysis` containing the preset's summary plus whatever your `insightSettingsIds` asked for.

Give your own insight settings distinct `key`s from the built-in summary to avoid any ambiguity about which one's result lands where.

None of this pushes the conversation transcript through the rule itself. `triggerInsightSettingsKai` (and the other action types) send the backend's insight service a `threadId` and the schema of what to extract. That service fetches the transcript itself. You're only ever specifying *what to extract*, never *what to extract from*.

---

## Discovery and dry-run testing

The 4 discovery methods let a UI populate its own dropdowns instead of hardcoding enums that will drift from the backend:

```js
await mgmt.lifecycle.listObjects(ks);                              // [{ objectType: 'thread', description: '...' }]
await mgmt.lifecycle.listEvents('thread', ks);                     // { objectType: 'thread', events: [{ eventType: 'session_ended', description: '...' }, ...] }
await mgmt.lifecycle.describeFields('thread', 'session_ended', ks); // { objectType, eventType, fields: [{ path, type, description }, ...] }
```

**Dry-run a rule before a real event fires it**: `match(objectType, eventType, eventData, ks)`, where `eventData` is `{ object?, changed_keys? }` (not a bare `object` field). For `objectType:'thread'`, `object` is validated server-side: `agent_id`, `thread_id`, and `user_id` are all required strings. Omitting any one 400s live:

```js
const { matchedRules } = await mgmt.lifecycle.match(
  'thread', 'session_ended',
  { object: { agent_id: 'agent-1', thread_id: 'thread-1', user_id: 'user-1' } },
  ks,
);
```

**Production already ships a system-seeded preset rule**: `match` can return rules you never created. Every partner has a preset rule by default, with `id: "preset__summary_on_session_ended"`. Its `action.actionType` is internal-only, so you never send or construct it yourself. This preset matches every `session_ended`/`thread` event. `matchedRules[]` groups related rules under a shared `groupKey` with `isGrouped:true`. Don't mistake a grouped preset for something you configured:

```js
{
  matchedRules: [
    {
      rules: [
        { id: 'preset__summary_on_session_ended', action: { actionType: '<system-internal>' } },
        { id: 'rule-you-created', action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: ['<your-insight-setting-id>'] } },
      ],
      isGrouped: true,
      groupKey: '_default_all_kai_triggers',
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
| `lifecycle.list(ks, opts)` | `POST /v1/lifecycle/list` | READ | `{offset,limit}` pager; `opts.filter` (`eventTypeEqual`, `statusEqual`, `systemNameEqual`) and `opts.orderBy` (`+createdAt`/`-createdAt`) pass through 1:1 |
| `lifecycle.update(id, patch, ks)` | `POST /v1/lifecycle/update` | WRITE, idempotent | mirrors `Tools#update` |
| `lifecycle.delete(id, ks, confirm)` | `POST /v1/lifecycle/delete` | WRITE, destructive | `requireConfirm` gate; response is `{removed, success, _meta}`. The deleted id comes back as `removed`, not `id` |
| `lifecycle.match(objectType, eventType, eventData, ks)` | `POST /v1/lifecycle/match` | READ (dry-run) | see [Discovery and dry-run testing](#discovery-and-dry-run-testing) |
| `lifecycle.listObjects(ks)` | `POST /v1/lifecycle/listObjects` | READ | |
| `lifecycle.listEvents(objectType, ks)` | `POST /v1/lifecycle/listEvents` | READ | |
| `lifecycle.describeFields(objectType, eventType, ks)` | `POST /v1/lifecycle/describeFields` | READ | |

`InsightSettings`, SDK: `mgmt.insightSettings`:

| Method | Endpoint | Kind | Notes |
|---|---|---|---|
| `insightSettings.create(body, ks)` | `POST /v1/insight-settings/create` | WRITE, not idempotent | |
| `insightSettings.get(id, ks)` | `POST /v1/insight-settings/get` | READ | |
| `insightSettings.list(ks, opts)` | `POST /v1/insight-settings/list` | READ | `{offset,limit}` pager; `opts.filter` (`statusEqual`, `idsIn`) and `opts.orderBy` pass through 1:1 |
| `insightSettings.update(id, patch, ks)` | `POST /v1/insight-settings/update` | WRITE, idempotent | |
| `insightSettings.delete(id, ks, confirm)` | `POST /v1/insight-settings/delete` | WRITE, destructive | `requireConfirm` gate; response is `{removed, success, _meta}`. The deleted id comes back as `removed`, not `id`; does not cascade, see [`InsightSettings`](#insightsettings-reusable-insight-definitions) |

`EmailTemplates`, SDK: `mgmt.emailTemplates`. Kaltura Messaging API, not Agentic. Uses `Authorization: Bearer <KS>`, not `Authorization: KS <ks>`:

| Method | Endpoint | Kind | Notes |
|---|---|---|---|
| `emailTemplates.create(template, ks)` | `POST email-template/add` | WRITE, not idempotent | returns the full created template, including its generated `id` |
| `emailTemplates.get(id, ks)` | `POST email-template/get` | READ | |
| `emailTemplates.list(ks, opts)` | `POST email-template/list` | READ | `{offset,limit}` pager; `opts.filter` (`idIn`, `appGuidIn`, `nameEq`, `status`, ...) passes through 1:1 |
| `emailTemplates.update(id, patch, ks)` | `POST email-template/update` | WRITE, idempotent | server increments `version` on every call |
| `emailTemplates.delete(id, ks, confirm)` | `POST email-template/delete` | WRITE, destructive | `requireConfirm` gate; soft-delete (`status:'deleted'`); a rule still pinning this id as `templateId` silently stops sending, see [`EmailTemplates`](#emailtemplates-managing-the-templates-sendinsightemail-references) |

---

## Related docs

| Doc | What it adds |
|---|---|
| [`recipes.md`](recipes.md) | Hands-on walkthrough of `triggerInsightSettingsKai` + `sendInsightEmail` chained together, common pitfalls, and a runnable example |
| [`docs/api/management-operations.md`](../api/management-operations.md) | Where Lifecycle sits alongside the other CRUD entities (agents, avatars, intellects, tools, skills, knowledge) |
