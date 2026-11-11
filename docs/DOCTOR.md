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

Categories: `lifecycle`, `intellect`, `orphans`, `agent`, `avatar`, `language`.

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

```js
await mgmt.doctor(adminKs, { thresholds: { minConversationSeconds: 120 } });
```

## Languages

The SDK has no list of languages the platform supports. The doctor compares values only: it treats `he`, `iw`, `he-IL` and `Hebrew` as one language and skips any value it does not recognize. For the codes the SDK accepts, see [Languages](LANGUAGES.md).
