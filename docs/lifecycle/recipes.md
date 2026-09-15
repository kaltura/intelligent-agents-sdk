[← Back to Lifecycle](README.md)

# Recipe — Email a Human the Moment a Conversation's Analysis Is Ready

How to turn "someone has to read every transcript and decide what matters" into "the backend tells you, automatically, the moment a conversation's analysis lands." One lifecycle rule, zero polling: it emails a human the instant a thread's `thread_metadata.analysis` is written. This recipe is the hands-on walkthrough; [`README.md`](README.md) is the terse field-by-field reference this recipe links back to instead of repeating.

---

## The mental model

Three pieces, always in this order:

| Piece | What it is | Example |
|---|---|---|
| **Event** | Something the backend already noticed happened to a `thread` | `session_ended` (a conversation just ended), `analysis_updated` (an insight just got written) |
| **Rule** | `{eventType, objectType, eventConditions?, action}` you create once via `mgmt.lifecycle.create()` | "when `analysis_updated` fires, run this action" |
| **Action** | What runs automatically, server-side, when the rule matches | `sendInsightEmail` (email a human) |

Every partner already gets a free `SUMMARY` written to `thread_metadata.analysis` on every `session_ended` event, with no rule of your own required (see [`README.md`](README.md#every-session-already-gets-a-summary-for-free)). That write is itself an `analysis_updated` event, which the rule below reacts to. If you want richer content in the notification than `SUMMARY` alone, write the extra fields yourself with `mgmt.threads.setAnalysis()` — that call also fires `analysis_updated`, chaining into the same rule.

---

## Recipe — Email a human once analysis lands

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

`conversationInsightExample`'s template needs three insight values by name: **`SUMMARY`, `TOPIC`, and `CUSTOM`** (exactly those keys, case-sensitive). `AGENTNAME`, `CTAURL`, and `USER` are filled in automatically — you never provide those. If the thread's analysis doesn't have all three of `SUMMARY`/`TOPIC`/`CUSTOM`, the email send is skipped — logged as an error server-side, but nothing surfaces back to your app or the SDK. `SUMMARY` comes free from the always-on system preset (see [`README.md`](README.md#every-session-already-gets-a-summary-for-free)); write `TOPIC` and `CUSTOM` yourself with `mgmt.threads.setAnalysis()` once your own app logic has something to say:

```js
await mgmt.threads.setAnalysis(threadId, { TOPIC: 'Billing', CUSTOM: 'Offer a plan downgrade.' }, adminKs);
```

---

## Scoping the alert to one agent

`eventConditions` lets the rule fire only for a specific agent instead of every agent on the partner:

```js
eventConditions: [{ field: 'object.agent_id', operator: 'eq', value: '<agent-uuid>' }]
```

This only works if the conversation itself was started with an **agent-scoped** KS. A plain conversation token (`mgmt.sessions.createConversationToken({configId})`) leaves every thread's `agent_id` as `"default"`, so it can never match. Mint with `mgmt.sessions.createAgentToken({agentId})` instead — see [`README.md`'s scoping section](README.md#scoping-a-rule-to-one-agent) for the full explanation.

---

## Reading the results back

The values land in the thread's `thread_metadata.analysis`:

```js
const thread = await mgmt.threads.get(threadId, adminKs);
console.log(thread.thread_metadata.analysis); // { SUMMARY: '...', TOPIC: '...', CUSTOM: '...' }
```

You only need this for a dashboard or a "show me the recap" UI. If all you want is the email, the rule above already handles delivery — you don't need to read this back yourself.

---

## Test the rule in seconds, without waiting for a real event

Waiting for a real analysis update is not how you iterate on rule design. `mgmt.lifecycle.match()` answers "if this event happened right now, which rules would fire?" against data you make up, instantly, with no thread and no waiting:

```js
const { matchedRules } = await mgmt.lifecycle.match(
  'thread', 'analysis_updated',
  { object: { agent_id: 'agent-1', thread_id: 'thread-1', user_id: 'user-1' }, changed_keys: ['SUMMARY', 'TOPIC', 'CUSTOM'] },
  adminKs,
);
```

`object.agent_id`, `object.thread_id`, and `object.user_id` are all required strings for `objectType:'thread'` — omit one and it 400s naming the missing path. Expect to see your own rule nested inside a grouped `matchedRules[]` entry's `rules[]` array, together with `preset__summary_on_session_ended` — every partner has that preset rule by default; it's not something you configured (see [`README.md`'s note on grouped matches](README.md#discovery-and-dry-run-testing)). Run this after creating the rule to confirm it matches before you ever touch a real conversation.

---

## Minimal runnable example

[`examples/lifecycle-insights-and-email.mjs`](../../examples/lifecycle-insights-and-email.mjs) creates the rule above, dry-run tests it with `match()`, then cleans up — all against the real API, no waiting for a real session to end:

```bash
export AGENTIC_PARTNER_ID=1234567
export AGENTIC_ADMIN_SECRET=your_admin_secret_here
node examples/lifecycle-insights-and-email.mjs
```

---

## Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `sendInsightEmail` rule never sends anything, no error anywhere | The thread's analysis doesn't have every token the preset needs | Write `TOPIC`/`CUSTOM` yourself with `mgmt.threads.setAnalysis()` (see the gotcha above) |
| A `sendInsightEmail` rule attached to `session_ended` does nothing | That action only fires on `analysis_updated` | Change `eventType` to `analysis_updated` |
| `eventConditions` on `object.agent_id` never matches | The thread was created with a plain conversation token, not an agent-scoped one | Mint with `mgmt.sessions.createAgentToken({agentId})` |
| `lifecycle.match` 400s: `eventData.object.user_id: Invalid input...` | A required field missing from the dry-run `object` | Always pass `agent_id`, `thread_id`, and `user_id` together |
| `lifecycle.create`/`update` throws `bad_request` mentioning `triggerInsight` | That action type is no longer supported | Use `sendInsightEmail` instead |
| A custom `SUMMARY` value written via `setAnalysis` is overwritten | Every partner has an always-on `SUMMARY` preset that fires on the same event and can win a later write | Set `agent.summaryOverridePrompt` instead of writing `SUMMARY` yourself (see [`README.md`](README.md#every-session-already-gets-a-summary-for-free)) |
| You create a `triggerOverridableSummaryInsight` or `triggerDataToCollectInsight` rule and nothing you configured takes effect | Both are system-internal — they ignore any fields you pass | Don't create them yourself; use `sendInsightEmail` for anything partner-driven |

---

## Related docs

| Doc | What it adds |
|---|---|
| [`README.md`](README.md) | The full field-by-field reference: every rule shape, all four action types, the full CRUD + discovery method table |
| [`examples/lifecycle-insights-and-email.mjs`](../../examples/lifecycle-insights-and-email.mjs) | The runnable example this recipe walks through |
| [`GETTING-STARTED.md`](../../GETTING-STARTED.md) | Where `configId`/`agentId` and the admin token in the examples above come from |
