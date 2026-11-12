# Doctor: find what is wrong with your agents

`mgmt.doctor(ks)` reads your agents, intellects, avatars, voices and lifecycle rules, and reports what is misconfigured. It changes nothing. Use it when an agent behaves oddly, and before you ship one.

```js
import { Management } from '@kaltura/intelligent-agents/management';

const mgmt = new Management({ partnerId, adminSecret });
const { ks: adminKs } = await mgmt.sessions.createAdminToken({ userId: 'admin@example.com' });
const report = await mgmt.doctor(adminKs);

for (const f of report.findings) console.log(f.severity, f.code, f.message, '\n  fix:', f.fix);
```

The token must be an admin token. Any other token throws `wrong_token_scope` before a request is sent.

## Read a report

| Field | Meaning |
|---|---|
| `findings` | Sorted by severity (`error`, `warn`, `info`), then `code`, then id. The order is the same on every run |
| `summary` | `{ error, warn, info }` counts. `suppressed` is added when you pass `ignore` |
| `checked` | How much was read, for example `agents`, `rules`, `agentIntellects`, `avatars` |
| `skipped` | Areas that could not be read. Checks that need them did not run |

A finding has `severity`, `code`, `message` and `fix`. It also carries the ids it is about: `agentId`, `agentIds`, `configId`, `ruleId` and `field`. A finding about an intellect that several agents share carries `agentIds`, not `agentId`.

| Severity | Meaning |
|---|---|
| `error` | Something does not work as configured |
| `warn` | Likely a mistake. Check it |
| `info` | Worth knowing. Often fine |

A value the doctor does not recognize is skipped. It is never reported as an error.

The doctor reads stored config. Problems that show only in a live conversation, such as a reply with no audio or a slow turn, are session warnings. See [Turn warnings](architecture-reference/resilience-and-failure-handling.md#turn-warnings).

## Options

| Option | Use |
|---|---|
| `agentIds` | Check only these agents, and the rules that run for them. Orphan checks are skipped |
| `only` | Run only these checks. A name is a check id or a category |
| `skip` | Do not run these. Wins over `only` |
| `ignore` | Hide findings. Each item is `{ code, agentId?, configId?, ruleId?, field? }` and every key you set must match |
| `thresholds` | Limits for the hint checks. See [Thresholds](#thresholds) |
| `pageSize` | Page size of every list read |
| `concurrency` | Most reads in flight at once. Default 4 |

Categories: `lifecycle`, `intellect`, `orphans`, `agent`, `avatar`, `language`, `speed`.

```js
// Only the language checks, for one agent.
await mgmt.doctor(adminKs, { agentIds: [agentId], only: ['language'] });

// Accept a bilingual agent on purpose.
await mgmt.doctor(adminKs, { ignore: [{ code: 'voice_reply_language_mismatch', agentId }] });
```

## Finding codes

Codes the doctor defines. The rule and intellect codes are in [Audit your rules](lifecycle/README.md#audit-your-rules).

### Language

| Code | Severity | Meaning |
|---|---|---|
| `asr_language_mismatch` | error or warn | `asr.language` differs from the language replies are forced to (`error`) or from the voice language (`warn`). Callers who speak that language are recognized as the ASR language |
| `voice_reply_language_mismatch` | error | The intellect forces replies in one language and an avatar voice is made for another. The voice speaks, but the audio is not intelligible |
| `voice_language_default` | info | A custom voice kept the default language `en` on an agent that works in another language |
| `opening_phrase_language_mismatch` | info | The opening line is written in a script the voice does not speak |

The fix for `voice_reply_language_mismatch` is a voice made for the reply language. The API shows a voice's provider and language, not its speech model.

### Agent and avatar

| Code | Severity | Meaning |
|---|---|---|
| `intellect_not_found` | error | The agent points at an intellect that does not exist |
| `avatar_not_found` | error | The agent lists an avatar that does not exist |
| `voice_not_in_catalog` | warn | An avatar uses a voice that is not in the catalog. A raw provider voice id can be valid |
| `visual_not_in_catalog` | warn | An avatar uses a visual that is not in the catalog |
| `opening_phrase_duplicate` | info | The avatar and the intellect both set an opening line. The intellect's line is spoken |
| `max_conversation_short` | info | `maxConversationLength` is under the limit, so the conversation ends mid-exchange |
| `capability_disabled_vetoes_avatar` | error | The intellect stores the `avatar` capability as `disabled` and the agent has avatars. A per-request `on` does not turn it back on |
| `avatar_shared` | info | Several agents use one avatar. A change to it changes all of them |

### Speed and tools

These read the config, not a real turn. They show what makes slow or looping turns likely. Measure a real turn before you change anything. A finding about an intellect carries `agentIds`.

| Code | Severity | Meaning |
|---|---|---|
| `latency_thinking` | info | `thinking_level` is `medium` or `high`, `include_thoughts` is true, or `think_process` is on, on an agent with an avatar. Reasoning time is silence before speech |
| `latency_output_tokens` | info | `max_output_tokens` is above the limit. Long replies mean long speech |
| `latency_preloaded_skills` | info | The `preloaded` skills add more characters than the limit to the system prompt on every turn |
| `latency_prompt_size` | info | The prompt blocks hold more characters than the limit |
| `thread_start_tool_blocks` | warn | A `thread_start_tools` api tool waits for its response and its `request.timeout` is over 10 s. The first turn waits for it |
| `tool_surface_large` | info | Tools, `adhoc` skills, MCP servers and built-in tools that are on add up to more than the limit. More choices raise the risk of repeated tool calls |
| `client_tool_wait_blocks` | info | A client tool leaves `wait_for_response` unset. Unset means the turn waits for your app, 30 s by default |
| `client_tool_fire_and_forget_unbudgeted` | info | A client tool has `wait_for_response: false` and its description does not say it is called once per turn |

An external intellect has no brain config, so these are skipped for it.

### Prompts and openings

| Code | Severity | Meaning |
|---|---|---|
| `condition_unquoted_name` | info | A condition compares with a bare word, such as `plan == pro`. A name is read as a variable, not as text. Ignore it if the word is a variable |
| `opening_phrase_may_render_empty` | info | The whole opening sits in one `{% if %}` with no `{% else %}`. When it is false the agent speaks its default greeting |

### Run

| Code | Severity | Meaning |
|---|---|---|
| `read_failed` | info | A read failed (403, 5xx). The checks that need it were skipped and `skipped` names the area |
| `check_failed` | info | A check threw. The rest ran. Open an issue with the message |
| `orphan_insight_setting` | info | No rule uses the insight setting |
| `orphan_email_template` | info | No rule uses the email template |

An expired or non-admin token (401, `wrong_token_scope`) stops the run. Every other failed read becomes `read_failed`. If the Messaging host is not available in your region, the template checks are skipped and the report says `skipped: ['templates']`.

## Thresholds

| Key | Default | Used by |
|---|---|---|
| `minConversationSeconds` | 60 | `max_conversation_short` |
| `maxOutputTokens` | 1024 | `latency_output_tokens` |
| `promptChars` | 8000 | `latency_prompt_size`, `latency_preloaded_skills` |
| `toolSurface` | 8 | `tool_surface_large` |

```js
await mgmt.doctor(adminKs, { thresholds: { minConversationSeconds: 120 } });
```

## Languages

The SDK has no list of languages the platform supports. The doctor compares values only: it treats `he`, `iw`, `he-IL` and `Hebrew` as one language and skips any value it does not recognize. For the codes the SDK accepts, see [Languages](LANGUAGES.md).
