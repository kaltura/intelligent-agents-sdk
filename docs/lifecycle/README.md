[← Back to the API Reference index](../../API-REFERENCE.md)

# Lifecycle — Event-Driven Rules

Today, "summarize every ended session and email the account owner" means polling for finished threads yourself. Lifecycle removes the polling: create a **rule** once, and the backend fires its **action** automatically every time a matching event happens, server-side. Mounted at `mgmt.lifecycle`.

This page is the field-by-field reference. New to Lifecycle? [`recipes.md`](recipes.md) is a hands-on walkthrough of the two action types you actually create, with a runnable example — it links back here instead of repeating this reference.

---

## Rule shape

A rule is `{eventType, objectType, eventConditions, action}`:

- `eventType` — e.g. `session_ended`, `analysis_updated`.
- `objectType` — currently only `thread`.
- `eventConditions[]` — `{field, operator, value}` matchers, e.g. `{field:'object.agent_id', operator:'eq', value:'<uuid>'}`, `{field:'changed_keys', operator:'has_all', value:[...]}`. `field` is a dot-path into the event payload (see [Discovery and dry-run testing](#discovery-and-dry-run-testing) for which paths exist per event) — confirmed live: a `{path, op}` shaped entry 400s.
- `action` — a plain object, passed straight through, not built by the SDK. See [The four action types](#the-four-action-types) below.

---

## The four action types

The backend recognizes four `actionType` values, not two. Two are meant for you to create; the other two only exist to power system preset rules — creating them yourself is accepted by the API but has no effect, because their behavior is hardcoded and ignores anything you pass.

| `actionType` | Who creates it | What it does | Why / when you'd use it |
|---|---|---|---|
| `triggerInsight` | You | Runs an LLM over the conversation and writes back exactly the fields you defined in `insights` — a built-in key (`SUMMARY`/`SENTIMENT`/`TOPIC`, each with a ready-made prompt) or any custom key name paired with your own `prompt` | Whenever you need a specific piece of structured data pulled out of a conversation: a topic tag for a dashboard, a lead-quality score, a recommended next step. |
| `sendInsightEmail` | You | Sends an email to a Kaltura user, filling an email template from the thread's already-extracted insight values | Whenever a human needs to know the moment a specific insight is ready — e.g. alert a support lead as soon as a conversation's analysis lands. |
| `triggerOverridableSummaryInsight` | Nobody — system preset only | Always produces one fixed insight, key `SUMMARY`, using a built-in prompt (or your agent's `summaryOverridePrompt`, if set) | Never create this yourself — every agent already gets it automatically, with no rule needed. Its only lever is `agents.update({agentId, summaryOverridePrompt})`, covered [below](#every-session-already-gets-a-summary-for-free). |
| `triggerDataToCollectInsight` | Nobody — powers a preset that's disabled for every account today | If ever enabled, would turn each of the intellect's configured lead-capture form fields (`intellectConfig.user_properties_forms` — the fields you'd ask a lead for, e.g. name/company/email) into its own insight | Not usable today under any account. Ignore it. |

**`triggerInsight`** fires up to 20 named LLM insight generations against the thread: `{ insights: [{ insightKey, valueType, prompt? }, ...] }`. `valueType` (`'string'`/`'number'`/`'boolean'`/`'arrayString'`/`'arrayNumber'`/`'arrayBoolean'`) is **required on every insight, even built-in keys** — omitting it 400s live. `SUMMARY`/`SENTIMENT`/`TOPIC` have built-in prompts; a custom `insightKey` needs an explicit `prompt`. Every rule extracting insights on the same event merges into one LLM batch — don't ask for `SUMMARY` yourself, see [below](#every-session-already-gets-a-summary-for-free).

**`sendInsightEmail`** mails a rendered insight summary to `recipients` (Kaltura user ids, not raw email addresses — the messaging service resolves the actual email from that user's Kaltura profile), using either an explicit `templateId` or an auto-created `presetType` template (supports `{{template}}` placeholders like `{{object.user_id}}`). Only fires on `eventType:'analysis_updated'` — attaching it to a `session_ended` rule is a server-side no-op.

```js
await mgmt.lifecycle.create({
  name: 'Summarize on session end',
  systemName: 'auto_summary_v1',
  eventType: 'session_ended',
  objectType: 'thread',
  action: { actionType: 'triggerInsight', insights: [{ insightKey: 'SENTIMENT', valueType: 'string' }, { insightKey: 'TOPIC', valueType: 'string' }] },
}, ks);
```

Every conversation gets a structured recap the moment it ends, with zero app-side code. `SUMMARY` is deliberately not requested — every partner already has an always-on preset rule producing one for free, merged into the same batch as this rule's own insights.

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
  action: { actionType: 'sendInsightEmail', recipients: ['support-lead@example.com'], presetType: 'conversationInsightExample' },
}, ks);
```

**A rule filtering on `object.agent_id` only matches threads created with an agent-scoped KS.** Mint the conversation token with `mgmt.sessions.createAgentToken({ agentId })` (`agentid:<agentId>`), not `createConversationToken({ configId })` (`geniegpcid:<configId>`) — the latter has no agent claim at all, so the resulting thread's `agent_id` is `"default"` and can never match a rule scoped to a real agent uuid. This applies whether the conversation happens over `mgmt.conversations.send()`/`.stream()` or a real avatar/socket session — the agent binding lives entirely in the KS's privilege claim, not in the call itself. See [`createAgentToken`](../../src/core/session.js) for details.

---

## Every session already gets a SUMMARY, for free

A system-seeded rule, `preset__overridable_summary_on_session_ended`, runs `triggerOverridableSummaryInsight` on every `session_ended` event, for every agent, with no opt-out.

Here's the mechanic that matters: **every rule whose action extracts insights on the same event gets merged into one batch, one LLM call — not one call per rule.** Create your own `triggerInsight` rule on `session_ended`, and it runs in the *same batch* as this preset. The result is one combined `thread_metadata.analysis` containing the preset's `SUMMARY` plus whatever you asked for.

Two consequences:

1. **Don't put `SUMMARY` in your own rule's `insights` array.** You already get it for free.
2. **If you ask for `SUMMARY` anyway, your prompt never takes effect.** The batch is built with your rule's insights first and the preset's insight appended after; when both name the same key, the later one wins. The preset's default prompt is what reaches the LLM, not yours — asking for `SUMMARY` yourself doesn't break anything, it's just a no-op.

Want a custom prompt for that default summary instead of the built-in one? That's an agent-level setting, not a lifecycle rule, because the preset runs whether you've configured lifecycle at all or not:

```js
await mgmt.agents.update({ agentId, summaryOverridePrompt: 'Summarize in one sentence, written for a support manager.' }, ks);
```

None of this pushes the conversation transcript through the rule itself. `triggerInsight` (and the two system actions) send the backend's insight service a `threadId` and the schema of what to extract; that service fetches the transcript itself. You're only ever specifying *what to extract*, never *what to extract from*.

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

**Production already ships a system-seeded preset rule** — `match` can return rules you never created. Every partner, by default, has a preset rule (`id: "preset__overridable_summary_on_session_ended"`, `action.actionType: "triggerOverridableSummaryInsight"`) that matches every `session_ended`/`thread` event. `matchedRules[]` groups related rules under a shared `groupKey` with `isGrouped:true` — don't mistake a grouped preset for something you configured:

```js
{
  matchedRules: [
    {
      rules: [
        { id: 'preset__overridable_summary_on_session_ended', action: { actionType: 'triggerOverridableSummaryInsight' } },
        { id: 'rule-you-created', action: { actionType: 'triggerInsight', insights: [{ insightKey: 'SUMMARY', valueType: 'string' }] } },
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
| `lifecycle.list(ks, opts)` | `POST /v1/lifecycle/list` | READ | `{offset,limit}` pager (`PagerDto`); `opts.filter` (`eventTypeEqual`, `statusEqual`, `systemNameEqual`) and `opts.orderBy` (`+createdAt`/`-createdAt`) pass through 1:1 |
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
| [`recipes.md`](recipes.md) | Hands-on walkthrough of `triggerInsight` + `sendInsightEmail` chained together, common pitfalls, and a runnable example |
| [`docs/api/management-operations.md`](../api/management-operations.md) | Where Lifecycle sits alongside the other CRUD entities (agents, avatars, intellects, tools, skills, knowledge) |
