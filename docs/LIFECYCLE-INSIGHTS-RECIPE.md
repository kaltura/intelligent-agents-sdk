# Recipe — Summarize Every Conversation and Email the Results, Automatically

How to turn "someone has to read every transcript and decide what matters" into "the backend tells you, automatically, the moment a conversation ends." Two lifecycle rules, zero polling, zero app-side glue: one rule extracts a summary and topic the instant a session ends, a second rule emails a human the instant that extraction finishes. This recipe is the hands-on walkthrough; [`docs/api/build.md` § Lifecycle](api/build.md#lifecycle-event-driven-rules) is the terse field-by-field reference this recipe links back to instead of repeating.

---

## The mental model

Three pieces, always in this order:

| Piece | What it is | Example |
|---|---|---|
| **Event** | Something the backend already noticed happened to a `thread` | `session_ended` (a conversation just ended), `analysis_updated` (an insight just got written) |
| **Rule** | `{eventType, objectType, eventConditions?, action}` you create once via `mgmt.lifecycle.create()` | "when a `session_ended` fires, run this action" |
| **Action** | What runs automatically, server-side, when the rule matches | `triggerInsight` (extract structured data with an LLM) or `sendInsightEmail` (email a human) |

The two actions chain naturally: `triggerInsight` writes its results into the thread's `thread_metadata.analysis`, and that write is itself an `analysis_updated` event — which a second rule can react to. That's the whole recipe below: rule 1 reacts to `session_ended` and produces analysis, rule 2 reacts to `analysis_updated` and emails it.

---

## Recipe A — Extract a summary the moment a session ends

```js
await mgmt.lifecycle.create({
  name: 'Summarize on session end',
  systemName: 'auto_summary_v1',
  eventType: 'session_ended',
  objectType: 'thread',
  action: {
    actionType: 'triggerInsight',
    insights: [
      { insightKey: 'SUMMARY', valueType: 'string' },
      { insightKey: 'TOPIC', valueType: 'string' },
    ],
  },
}, adminKs);
```

`SUMMARY`, `SENTIMENT`, and `TOPIC` are the only insight keys with a built-in prompt — ask for any other key and you must supply your own `prompt`:

```js
{ insightKey: 'NEXT_STEP', valueType: 'string', prompt: 'One actionable next step for the support team, or "none".' }
```

`valueType` is required on **every** insight, including the built-in ones — omit it and the create call 400s. Every conversation now gets a structured recap with zero app-side code: no cron job polling for "threads that just ended," no app server involved at all.

---

## Recipe B — Email a human the moment that analysis lands

```js
await mgmt.lifecycle.create({
  name: 'Email support lead on analysis update',
  systemName: 'analysis_alert_v1',
  eventType: 'analysis_updated',
  objectType: 'thread',
  action: {
    actionType: 'sendInsightEmail',
    recipients: ['support-lead-kaltura-user-id'],
    presetType: 'conversationInsightExample',
  },
}, adminKs);
```

Three things about this action that aren't obvious from the field names:

1. **It only fires on `analysis_updated`.** Attach it to a `session_ended` rule and it's a silent server-side no-op — nothing errors, nothing sends.
2. **`recipients` are Kaltura user IDs, not raw email addresses.** The messaging service resolves the actual email from that user's Kaltura profile (`{USER.email}`). If your account's convention is to use the email address itself as the Kaltura user ID — common on many accounts — a recipient string that looks like an email works, but only because it's also a valid user ID there, not because this field accepts arbitrary email strings.
3. **`presetType: 'conversationInsightExample'` is the zero-setup path** — the backend auto-creates its email template on first use. There is no SDK surface for authoring your own template from scratch; an explicit `templateId` (instead of `presetType`) means a template that already exists in Kaltura's messaging service, managed outside this SDK.

### The gotcha that will bite you first: token mismatch

`conversationInsightExample`'s template needs three insight values by name: **`SUMMARY`, `TOPIC`, and `CUSTOM`** (exactly those keys, case-sensitive). `AGENTNAME`, `CTAURL`, and `USER` are filled in automatically — you never provide those. If your `triggerInsight` rule (Recipe A) doesn't produce all three of `SUMMARY`/`TOPIC`/`CUSTOM`, the email send is skipped — logged as an error server-side, but nothing surfaces back to your app or the SDK. To use this preset, Recipe A's insights array needs all three:

```js
insights: [
  { insightKey: 'SUMMARY', valueType: 'string' },
  { insightKey: 'TOPIC', valueType: 'string' },
  { insightKey: 'CUSTOM', valueType: 'string', prompt: 'One actionable next step for the support team, or "none".' },
]
```

`CUSTOM` isn't a built-in key (only `SUMMARY`/`SENTIMENT`/`TOPIC` are), so it needs its own `prompt` — pick whatever prompt fits your use case, the key name `CUSTOM` is what the preset template looks for, not the prompt text.

---

## Scoping the alert to one agent

`eventConditions` lets Recipe B fire only for a specific agent instead of every agent on the partner:

```js
eventConditions: [{ field: 'object.agent_id', operator: 'eq', value: '<agent-uuid>' }]
```

This only works if the conversation itself was started with an **agent-scoped** KS. A plain conversation token (`mgmt.sessions.createConversationToken({configId})`) leaves every thread's `agent_id` as `"default"`, so it can never match. Mint with `mgmt.sessions.createAgentToken({agentId})` instead — see [`build.md`'s Lifecycle section](api/build.md#lifecycle-event-driven-rules) for the full explanation.

---

## Reading the results back

Once `triggerInsight` finishes (it runs asynchronously — expect a short delay, not instant), the values land in the thread's `thread_metadata.analysis`:

```js
const thread = await mgmt.conversations.threads.get(threadId, adminKs);
console.log(thread.thread_metadata.analysis); // { SUMMARY: '...', TOPIC: '...', CUSTOM: '...' }
```

You only need this for a dashboard or a "show me the recap" UI. If all you want is the email, Recipe B already handles delivery — you don't need to read this back yourself.

---

## Test both rules in seconds, without waiting for a real event

Waiting for a real conversation to end and a real analysis to land is not how you iterate on rule design. `mgmt.lifecycle.match()` answers "if this event happened right now, which rules would fire?" against data you make up, instantly, with no thread and no waiting:

```js
const { matchedRules } = await mgmt.lifecycle.match(
  'thread', 'session_ended',
  { object: { agent_id: 'agent-1', thread_id: 'thread-1', user_id: 'user-1' } },
  adminKs,
);
```

`object.agent_id`, `object.thread_id`, and `object.user_id` are all required strings for `objectType:'thread'` — omit one and it 400s naming the missing path. Expect to see your own rule in `matchedRules[]` alongside `preset__overridable_summary_on_session_ended` — every partner has that preset rule by default; it's not something you configured. Run this after creating each rule to confirm it matches before you ever touch a real conversation.

---

## Minimal runnable example

[`examples/lifecycle-insights-and-email.mjs`](../examples/lifecycle-insights-and-email.mjs) creates both rules above, dry-run tests each with `match()`, lists and inspects them, then cleans up — all against the real API, no waiting for a real session to end:

```bash
export AGENTIC_PARTNER_ID=1234567
export AGENTIC_ADMIN_SECRET=your_admin_secret_here
node examples/lifecycle-insights-and-email.mjs
```

---

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `lifecycle.create` 400s: `action.insights.0.valueType must be one of...` | `valueType` omitted on an insight | Add `valueType` to every insight, even `SUMMARY`/`SENTIMENT`/`TOPIC` |
| `sendInsightEmail` rule never sends anything, no error anywhere | The paired `triggerInsight` rule doesn't produce every token the preset needs | Match Recipe A's insight keys to the preset's requirements exactly (see the gotcha above) |
| A `sendInsightEmail` rule attached to `session_ended` does nothing | That action only fires on `analysis_updated` | Change `eventType` to `analysis_updated` |
| `eventConditions` on `object.agent_id` never matches | The thread was created with a plain conversation token, not an agent-scoped one | Mint with `mgmt.sessions.createAgentToken({agentId})` |
| `lifecycle.match` 400s: `eventData.object.user_id: Invalid input...` | A required field missing from the dry-run `object` | Always pass `agent_id`, `thread_id`, and `user_id` together |
| A custom `insightKey` 400s or silently produces nothing | No `prompt` supplied | Every key outside `SUMMARY`/`SENTIMENT`/`TOPIC` needs its own `prompt` |

---

## Related docs

| Doc | What it adds |
|---|---|
| [`docs/api/build.md` § Lifecycle](api/build.md#lifecycle-event-driven-rules) | The full field-by-field reference: every rule shape, both action types, the full CRUD + discovery method table |
| [`examples/lifecycle-insights-and-email.mjs`](../examples/lifecycle-insights-and-email.mjs) | The runnable example this recipe walks through |
| [`GETTING-STARTED.md`](../GETTING-STARTED.md) | Where `configId`/`agentId` and the admin token in the examples above come from |
