[← Back to the API Reference index](../../API-REFERENCE.md)

# Lifecycle Rules: Event-Driven Rules

Lifecycle removes the need to poll for finished threads when you want to "summarize every ended session and email the account owner": create a **rule** once, and its **action** fires automatically every time a matching event happens. Mounted at `mgmt.lifecycle`.

This page is the field-by-field reference. New to Lifecycle? [`recipes.md`](recipes.md) is a hands-on walkthrough of the action types you actually create, with a runnable example. It links back here instead of repeating this reference.

---

## Rule shape

A rule is `{name, systemName, eventType, objectType, eventConditions?, action}`:

- `name`: a required, human-readable label.
- `systemName`: a required, caller-chosen identifier (e.g. `auto_summary_v1`), filterable via `list`'s `systemNameEqual`.
- `eventType`: e.g. `session_ended`, `analysis_updated`.
- `objectType`: only `thread`. A `thread` rule must be scoped to an agent, see [Scope every rule to an agent](#scope-every-rule-to-an-agent).
- `eventConditions[]`: `{field, operator, value}` matchers, e.g. `{field:'object.agent_id', operator:'eq', value:'<uuid>'}`, `{field:'changed_keys', operator:'has_all', value:[...]}`. `field` is a dot-path into the event payload (see [Discovery and dry-run testing](#discovery-and-dry-run-testing) for which paths exist per event). A `{path, op}` shaped entry is rejected with a 400.
- `action`: a plain object, passed straight through, not built by the SDK. See [The action types](#the-action-types) below.

---

## The action types

You can create three `actionType` values. `match` output can also list a preset rule whose action type you cannot create, described [below](#every-session-already-gets-a-summary-for-free).

| `actionType` | What it does | Why / when you'd use it |
|---|---|---|
| `triggerInsightSettingsKai` | Runs an LLM over the conversation and writes back the insights named in `insightSettingsIds`. Each id points at a reusable [`InsightSettings`](#insightsettings-reusable-insight-definitions) entity you defined ahead of time | Whenever you need a specific piece of structured data pulled out of a conversation: a topic tag for a dashboard, a lead-quality score, a recommended next step. |
| `sendInsightEmail` | Sends an email to a Kaltura user, filling an email template from the thread's already-extracted insight values | Whenever a human needs to know the moment a specific insight is ready, e.g. alert a support lead as soon as a conversation's analysis lands. |
| `triggerDtcKai` | Takes no fields of your own. Turns each of the target intellect's configured lead-capture form fields (`intellectConfig.user_properties_forms`, e.g. name/company/email) into its own insight. It does nothing when none are configured | Whenever you already collect lead-capture fields on an intellect and want each one to also land as a conversation insight, with no per-field setup. |

**`triggerInsightSettingsKai`** takes `{ insightSettingsIds: string[] }`, up to 20 ids, each referencing an `InsightSettings` entity created via `mgmt.insightSettings.create()`. An id that doesn't exist, or isn't owned by your partner, is rejected on create/update with a 400. Only ids whose insight setting has `status:'active'` produce an insight. A `disabled` one is skipped.

**`sendInsightEmail`** mails a rendered insight summary to `recipients`. These are Kaltura user ids, not raw email addresses. Use either an explicit `templateId` or an auto-created `presetType` template; the template's `subject`/`body` reference single-brace tokens declared in `msgParamsMap`, e.g. `{SUMMARY}` or `{recipient.firstName}`. This action only fires on `eventType:'analysis_updated'`. On a `session_ended` rule it does nothing.

A `templateId` is more durable than a `presetType`. It points at a template you created yourself via [`mgmt.emailTemplates`](#emailtemplates-managing-the-templates-sendinsightemail-references) (see below). A `presetType` uses a preset template instead.

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
  eventConditions: [{ field: 'object.agent_id', operator: 'eq', value: '<agent-uuid>' }],
  action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: [sentiment.id, topic.id] },
}, ks);
```

Every conversation with that agent gets a structured recap the moment it ends, with zero app-side code. The built-in summary insight is deliberately not requested here. Every partner already has an always-on preset rule that produces one for free. Its summary lands in the same analysis as this rule's own insights.

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

An email template is `{id, appGuid, name, subject, body, toAttributePath, msgParamsMap, status, ...}` on its own host, separate from the rest of this SDK. Mounted at `mgmt.emailTemplates`:

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
  eventConditions: [{ field: 'object.agent_id', operator: 'eq', value: '<agent-uuid>' }, { field: 'changed_keys', operator: 'has_all', value: ['SUMMARY'] }],
  action: { actionType: 'sendInsightEmail', recipients: ['<support-lead-kaltura-user-id>'], templateId: template.id },
}, ks);
```

`appGuid`, `name`, `subject`, `body`, `toAttributePath`, and `msgParamsMap` are required. `body`/`subject`/`fromName` can reference the tokens declared in `msgParamsMap` (e.g. `{recipient.firstName}`). The rest of the CRUD surface (`get`/`list`/`update`/`delete`) is in the [method table](#full-crud--discovery-method-table) below.

This is the one resource in this SDK that authenticates with a plain `Authorization: Bearer <KS>` header instead of the `Authorization: KS <ks>` scheme every other resource uses. It's the same admin KS, sent in a different header because this resource lives on a different host.

---

## Scope every rule to an agent

A rule with no agent condition runs for every agent on the partner. So `create` and `update` refuse an unscoped `thread` rule by default. Add an `object.agent_id` condition: operator `eq` with an agent id, or `in` with a non-empty array of agent ids. An empty or blank value does not count:

```js
eventConditions: [{ field: 'object.agent_id', operator: 'eq', value: '<agent-uuid>' }]
```

Without it, the call throws `KalturaError` with `code: 'lifecycle_unscoped'` before any request. To run on every agent on purpose, pass `{ partnerWide: true }` as the last argument:

```js
await mgmt.lifecycle.create(rule, ks, { partnerWide: true });
await mgmt.lifecycle.update(id, { eventConditions: [] }, ks, { partnerWide: true });
```

`update` checks only a patch that includes `eventConditions`. It treats the rule as a `thread` rule unless the patch sets another `objectType`. Send the full `eventConditions` list in the patch, not only the new condition.

### Email rules need `changed_keys`

A `sendInsightEmail` rule on `analysis_updated` sends on every analysis update unless it names the insight keys it waits for. So `create` and `update` refuse one without a `changed_keys` condition (operator `has_all` or `has_any`, with a non-empty array of keys). The call throws `KalturaError` with `code: 'lifecycle_email_unfiltered'` before any request:

```js
eventConditions: [
  { field: 'object.agent_id', operator: 'eq', value: '<agent-uuid>' },
  { field: 'changed_keys', operator: 'has_all', value: ['SUMMARY', 'TOPIC', 'CUSTOM'] },
]
```

To send on every update on purpose, pass `{ emailOnEveryUpdate: true }` as the last argument. On `update`, the check runs when the patch sets a `sendInsightEmail` `action` together with `eventConditions`.

---

## Scoping a rule to one agent

`eventConditions` can only filter on fields [`describeFields`](#discovery-and-dry-run-testing) actually reports. For `thread`/`analysis_updated` that's `object.agent_id`, `object.thread_id`, `object.user_id`, and `changed_keys` (which insight keys were updated). It does **not** include an insight's computed value. There is no `object.sentiment` field to filter on. A sentiment score only exists as the *output* of a `triggerInsightSettingsKai` action, not an input `eventConditions` can inspect.

```js
await mgmt.lifecycle.create({
  name: 'Email support lead when this agent\'s analysis updates',
  systemName: 'analysis_alert_v1',
  eventType: 'analysis_updated',
  objectType: 'thread',
  eventConditions: [{ field: 'object.agent_id', operator: 'eq', value: '<agent-uuid>' }, { field: 'changed_keys', operator: 'has_all', value: ['SUMMARY', 'TOPIC', 'CUSTOM'] }],
  action: { actionType: 'sendInsightEmail', recipients: ['<support-lead-kaltura-user-id>'], presetType: 'conversationInsightExample' },
}, ks);
```

**A rule filtering on `object.agent_id` only matches threads created with an agent id on the token.** A token minted without one leaves the thread's `agent_id` as `"default"`, which never matches a rule scoped to a real agent uuid. Mint with `createAgentToken({ agentId, userId })`, or `createConversationToken` with `agentId`. See [Conversation token or agent token?](../api/authentication.md#conversation-token-or-agent-token).

This applies whether the conversation happens over `mgmt.conversations.send()`/`.stream()` or a real avatar/socket session. The agent binding lives in the KS, not in the call.

---

## Every session already gets a SUMMARY, for free

A system-seeded rule, `preset__summary_on_session_ended`, produces one fixed summary insight on every `session_ended` event, for every agent. It has no opt-out, and no field lets you change its prompt. `match` returns it (see [Discovery and dry-run testing](#discovery-and-dry-run-testing)).

When you create your own `triggerInsightSettingsKai` rule on `session_ended`, the result is one combined `thread_metadata.analysis` containing the preset's summary plus whatever your `insightSettingsIds` asked for.

Give your own insight settings distinct `key`s from the built-in summary to avoid any ambiguity about which one's result lands where.

---

## Discovery and dry-run testing

The discovery methods let a UI populate its own dropdowns instead of hardcoding enums:

```js
await mgmt.lifecycle.listObjects(ks);                              // [{ objectType: 'thread', description: '...' }]
await mgmt.lifecycle.listEvents('thread', ks);                     // { objectType: 'thread', events: [{ eventType: 'session_ended', description: '...' }, ...] }
await mgmt.lifecycle.describeFields('thread', 'session_ended', ks); // { objectType, eventType, fields: [{ path, type, description }, ...] }
```

**Dry-run a rule before a real event fires it**: `match(objectType, eventType, eventData, ks)`, where `eventData` is `{ object?, changed_keys? }` (not a bare `object` field). For `objectType:'thread'`, `object` needs `agent_id`, `thread_id`, and `user_id`, all strings. Where `describeFields` lists `object.origin`, pass `origin: 0` (a number, standard) too. Omitting any required field returns a 400:

```js
const { matchedRules } = await mgmt.lifecycle.match(
  'thread', 'session_ended',
  { object: { agent_id: 'agent-1', thread_id: 'thread-1', user_id: 'user-1' } },
  ks,
);
```

**`match` can return rules you never created.** Every partner has a system-seeded preset rule with `id: "preset__summary_on_session_ended"`. You cannot create its `action.actionType`. This preset matches every `session_ended`/`thread` event. `matchedRules[]` groups related rules under a shared `groupKey` with `isGrouped:true`. Don't mistake a grouped preset for something you configured:

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

## Audit your rules

A rule can be valid when you save it and still do nothing later. An insight setting gets deleted, a template is removed, an agent is deleted. The backend never says so. `lifecycle.audit` reads your rules and what they point at, and lists the problems. It changes nothing.

```js
const report = await mgmt.lifecycle.audit(ks, { agentIds: ['<agent-uuid>'] }); // agentIds is optional
// { findings: [{ severity, code, ruleId, message, fix }], summary: { error, warn, info }, checked: { rules, ... }, skipped: [] }
```

`agentIds` limits the check to those agents and the rules that run for them. Rules with no agent scope are always included.

| Code | Severity | Meaning |
|---|---|---|
| `unscoped_rule` | warn | A `thread` rule has no agent condition, so it runs for every agent |
| `agent_not_found` | warn | The rule names an agent id the partner does not have |
| `duplicate_agent_ids` | info | The same agent id appears twice in the rule's conditions |
| `insight_setting_missing` | warn | `insightSettingsIds` holds an id with no insight setting. The id is skipped |
| `insight_setting_disabled` | warn | A listed insight setting is `disabled`. It is skipped |
| `too_many_insight_settings` | error | More than 20 `insightSettingsIds` |
| `email_on_session_ended` | error | `sendInsightEmail` only fires on `analysis_updated` |
| `email_unfiltered` | warn | A `sendInsightEmail` rule on `analysis_updated` has no `changed_keys` filter |
| `changed_keys_unproduced` | warn | The `changed_keys` filter waits for a key no active rule on those agents writes |
| `template_missing_or_deleted` | error | The pinned `templateId` does not exist or is deleted |
| `template_tokens_unproduced` | warn | The template or preset needs a key no active rule on those agents writes |
| `dtc_without_forms` | warn | `triggerDtcKai` on an agent whose intellect has no `user_properties_forms` |
| `rule_disabled` | info | The rule is not active. It gets no other finding |

The key checks (`changed_keys_unproduced`, `template_tokens_unproduced`) are skipped for agents covered by an active `triggerDtcKai` rule, because the keys it writes are not documented.

Templates live on the Messaging host. If the target has none, the template checks are skipped and the report says `skipped: ['templates']`.

`mgmt.doctor(ks, opts?)` runs the same check, then audits the intellect of each agent with `mgmt.intellectConfig.audit(configId, ks)`. It also reports `orphan_insight_setting` and `orphan_email_template` (both `info`) for entities no rule uses. It skips the orphan checks when you pass `agentIds`.

| Intellect code | Severity | Meaning |
|---|---|---|
| `external_intellect` | info | An external intellect has no brain config, so nothing else is checked |
| `invalid_user_properties_forms` | error | The forms fail the same validation `setUserPropertiesForms` applies |
| `secret_ref_unresolved` | error | `{{secrets.NAME}}` names a secret the intellect does not have |
| `secret_ref_bad_prefix` | error | `{{variables.secrets.NAME}}` renders empty. Write `{{secrets.NAME}}` |
| `prompt_<code>` | per finding | A prompt lint finding, for example `prompt_duplicate_key` |
| `capabilities_invalid` | warn | The capability map holds an unknown name or state |
| `client_tools_not_ready` | warn | The client tool setup would not work |
| `knowledge_ids_over_cap` | error | `knowledge_ids` holds more than one record |
| `tool_not_found` | error | `tool_ids` or `thread_start_tools` names a tool that does not exist |
| `skill_not_found` | error | `skill_ids` names a skill that does not exist |
| `intellect_not_found` | error | `doctor` only. An agent points at an intellect that does not exist |

The pure functions `auditLifecycleRules(rules, ctx)` and `auditIntellectConfig(config, ctx)` are exported from `./management` if you already hold the data.

To run it from a terminal or CI, use `npm run audit:lifecycle`. It exits 0 when nothing reaches `--fail-on`, 1 when something does, and 2 on a usage, auth or request error. Flags are in [`scripts/README.md`](../../scripts/README.md#lifecycle-audit-cli).

---

## Full CRUD + discovery method table

All against `https://api.avatar.us.kaltura.ai`. SDK: `mgmt.lifecycle`.

| Method | Endpoint | Kind | Notes |
|---|---|---|---|
| `lifecycle.create(body, ks, opts?)` | `POST /v1/lifecycle/create` | WRITE, not idempotent | mirrors `Tools#add`. `opts.partnerWide`, `opts.emailOnEveryUpdate`: see [Scope every rule to an agent](#scope-every-rule-to-an-agent) |
| `lifecycle.get(id, ks)` | `POST /v1/lifecycle/get` | READ | |
| `lifecycle.list(ks, opts)` | `POST /v1/lifecycle/list` | READ | `{offset,limit}` pager; `opts.filter` (`eventTypeEqual`, `statusEqual`, `systemNameEqual`) and `opts.orderBy` (`+createdAt`/`-createdAt`) pass through 1:1 |
| `lifecycle.update(id, patch, ks, opts?)` | `POST /v1/lifecycle/update` | WRITE, idempotent | mirrors `Tools#update`. `opts.partnerWide`, `opts.emailOnEveryUpdate`: see [Scope every rule to an agent](#scope-every-rule-to-an-agent) |
| `lifecycle.delete(id, ks, confirm)` | `POST /v1/lifecycle/delete` | WRITE, destructive | `requireConfirm` gate; response is `{removed, success, _meta}`. The deleted id comes back as `removed`, not `id` |
| `lifecycle.match(objectType, eventType, eventData, ks)` | `POST /v1/lifecycle/match` | READ (dry-run) | see [Discovery and dry-run testing](#discovery-and-dry-run-testing) |
| `lifecycle.listObjects(ks)` | `POST /v1/lifecycle/listObjects` | READ | |
| `lifecycle.listEvents(objectType, ks)` | `POST /v1/lifecycle/listEvents` | READ | |
| `lifecycle.describeFields(objectType, eventType, ks)` | `POST /v1/lifecycle/describeFields` | READ | |
| `lifecycle.audit(ks, opts?)` | reads only: lists rules, insight settings and agents, gets each pinned template and each `triggerDtcKai` intellect | READ | see [Audit your rules](#audit-your-rules). `opts.agentIds`, `opts.pageSize`. Admin KS |
| `doctor(ks, opts?)` | reads only | READ | rules, intellects, and unused settings and templates. See [Audit your rules](#audit-your-rules) |

`InsightSettings`, SDK: `mgmt.insightSettings`:

| Method | Endpoint | Kind | Notes |
|---|---|---|---|
| `insightSettings.create(body, ks)` | `POST /v1/insight-settings/create` | WRITE, not idempotent | |
| `insightSettings.get(id, ks)` | `POST /v1/insight-settings/get` | READ | |
| `insightSettings.list(ks, opts)` | `POST /v1/insight-settings/list` | READ | `{offset,limit}` pager; `opts.filter` (`statusEqual`, `idsIn`) and `opts.orderBy` pass through 1:1 |
| `insightSettings.update(id, patch, ks)` | `POST /v1/insight-settings/update` | WRITE, idempotent | |
| `insightSettings.delete(id, ks, confirm)` | `POST /v1/insight-settings/delete` | WRITE, destructive | `requireConfirm` gate; response is `{removed, success, _meta}`. The deleted id comes back as `removed`, not `id`; does not cascade, see [`InsightSettings`](#insightsettings-reusable-insight-definitions) |

`EmailTemplates`, SDK: `mgmt.emailTemplates`. Separate host from the rest of this SDK. Uses `Authorization: Bearer <KS>`, not `Authorization: KS <ks>`:

| Method | Endpoint | Kind | Notes |
|---|---|---|---|
| `emailTemplates.create(template, ks)` | `POST email-template/add` | WRITE, not idempotent | returns the full created template, including its generated `id` |
| `emailTemplates.get(id, ks)` | `POST email-template/get` | READ | |
| `emailTemplates.list(ks, opts)` | `POST email-template/list` | READ | `{offset,limit}` pager; `opts.filter` (`idIn`, `appGuidIn`, `nameEq`, `status`, ...) passes through 1:1 |
| `emailTemplates.update(id, patch, ks)` | `POST email-template/update` | WRITE, idempotent | `version` increments on every call |
| `emailTemplates.delete(id, ks, confirm)` | `POST email-template/delete` | WRITE, destructive | `requireConfirm` gate; soft-delete (`status:'deleted'`); a rule still pinning this id as `templateId` silently stops sending, see [`EmailTemplates`](#emailtemplates-managing-the-templates-sendinsightemail-references) |

---

## Related docs

| Doc | What it adds |
|---|---|
| [`recipes.md`](recipes.md) | Hands-on walkthrough of `triggerInsightSettingsKai` + `sendInsightEmail` chained together, common pitfalls, and a runnable example |
| [`scripts/README.md`](../../scripts/README.md#lifecycle-audit-cli) | The `audit:lifecycle` command and its exit codes |
| [`docs/api/management-operations.md`](../api/management-operations.md) | Where Lifecycle sits alongside the other CRUD entities (agents, avatars, intellects, tools, skills, knowledge) |
