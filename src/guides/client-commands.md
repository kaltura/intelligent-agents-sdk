---
layout: base.njk
title: "Client-Side Commands"
description: "How a Kaltura avatar silently triggers actions in your app, such as navigating a deck, rendering a widget, or drawing a chart, by calling a client-side tool you define."
eyebrow: How-to Guide
---

# Client-Side Commands — how the avatar drives your UI

How a Kaltura avatar silently triggers actions in *your* app: navigate a deck, render a widget, draw a chart, by calling a tool you defined. The [agentic backend](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md#architecture) decides *when* to act. The page decides *what happens*.

This is the mechanism that lets an app drive client commands (`navigate_to_slide`/`show_widget`/`highlight_chart`/`open_filing`) off a single live avatar. See [`../examples/deck-presenter.html`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/examples/deck-presenter.html) for a self-contained slide-navigation demo.

If you only read one thing: a "client command" is **not a special protocol feature**. It is a native `type:"client"` tool that makes **no server-side call at all**. The *product* is the silent `type:"tool"` segment the server streams when the LLM calls it. Your page captures that segment and runs whatever JS it wants.

---

## Why it exists

Without this channel, an avatar can only *talk*. With it, the avatar drives a live experience the way a human presenter would:

- It jumps to the relevant slide when you ask a question.
- It generates a new slide for an off-curriculum topic.
- It shows a chart.
- It switches tracks.

Two other SDK mechanisms can't do this. The built-in structured-widget system (flashcards, sources, forms, and the other GenUI widgets; see [GenUI Reference](/reference/genui-reference/)) has no client-command surface. The togglable-capabilities enum (e.g. `use_knowledge_base`, `avatar`, `kaltura_genie_experiences`) has no way for the agent to invoke a page-defined function. This SDK ships that mechanism, documented and tested, in `tools.client` + `session.onToolCall`.

---

## The mechanism, end to end

Three pieces. Author the command, the agent calls it, the page captures it.

### 1. Author the command (management plane)

`tools.client({name, description, args?, waitForResponse?, timeout?, responseMapping?, responseTemplate?, responseChapters?, variablesMapping?})` builds a native `type:"client"` tool. Unlike the `api`/`csv`/`code` tool types, it has no `request` block and no echo endpoint. For the response fields, see [Tools and Secrets](/reference/api/build/tools-and-secrets/#client-tool). The model calls it and the server emits the `type:"tool"` segment. That is the entire contract.

<div data-nova-target="client-commands-example" data-nova-label="Author a client command example">

```js
import { Management, tools } from '@kaltura/intelligent-agents/management';

const nav = tools.client({
  name: 'navigate_to_slide',
  description: 'Navigate the on-screen deck. Call whenever the user asks about a topic the deck covers, passing the most relevant slide number.',
  args: { slide_num: { prompt: 'The slide number to show (1-N).', type: 'int', required: true } },
  waitForResponse: false,   // fire-and-forget. Omitting this BLOCKS (default is true)
});

// Tools are a SEPARATE, partner-level entity. Create it, then reference its id.
const { id } = await mgmt.tools.add(nav, adminKs);

await mgmt.intellects.create({
  capabilities: { kaltura_genie_experiences: 'off' },   // critical, see Gotcha 1
  tool_ids: [id],
  prompts: [/* … */],
}, adminKs);
```

</div>

The intellect stores only the tool ids in `tool_ids`. The tool body lives on its own entity (`mgmt.tools`). To link a tool to an existing intellect, call `mgmt.intellects.update({ id, type, tool_ids }, adminKs)`.

`navigate_to_slide`'s description asks the agent to pass "the most relevant slide number". The agent can only resolve a topic to a slide number from something in its context. If you're using the [`Presenter`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md#presenter) helper, pass `deckOutline: true` to its constructor instead of hand-rolling a topic→slide mapping into `BASE_DIRECTIVE`. This flag:

- Adds a full-deck `{slide_num, title}[]` outline to every per-slide context payload (the `page_context` request variable).
- Stays correct after a runtime `appendSlide()`. A static `BASE_DIRECTIVE` outline does not.
- Disambiguates duplicate slide titles automatically.

`waitForResponse` controls whether the model's turn blocks on a real client-supplied result. **Omitting it is not the same as passing `false`.** An omitted value blocks, so pass it explicitly.

| Value | Behavior |
|---|---|
| `false` | Fire-and-forget dispatch. The model's turn continues immediately; nothing waits on your handler. |
| `true` | The turn waits up to `timeout` seconds (integer 1 to 120, default 30) for your reply. Your app sends it with `session.respondToTool(call.toolMetadata.id, response)`. |

### 2. The agent calls it, the server streams a silent segment

When the model invokes the tool, the server streams a `type:"tool"` segment. Its `content` is the wire form `"<toolName> <json-args>"`:

```text
navigate_to_slide {"slide_num": 4}
```

Crucially, `type:"tool"` is **not in the TTS audio gate** (only `avatar`, `avatar-filler`, and `text` segments are spoken). So the command streams **silently**. The voice track stays clean while the structured command drives your UI. This is why the avatar can switch slides mid-sentence without narrating "let me change the slide." See [Wire Protocol](/reference/wire-protocol/).

### 3. The page captures it (experience plane)

**Live (socket runtime):** register one handler per command with `session.onToolCall(name, handler)`. The SDK parses the segment into `{name, args, raw, toolMetadata}` and dispatches it to your handler.

```js
session.onToolCall('navigate_to_slide', ({ slide_num }) => deck.goTo(slide_num));
session.onToolCall('create_slide',       (slide)      => deck.append(slide));
```

**Chat (text-only) transport:** `KalturaChatSession` (and the mode-switching `KalturaAgentSession`) carries the identical `onToolCall(name, handler, argsSchema?)` contract: same parsing, same semantic dedup, same guardrail order. It dispatches mid-stream while a `sendText()` turn is being read. `respondToTool(call.toolMetadata.id, response)` ACKs a `waitForResponse:true` tool over HTTPS with the session's own conversation KS; the model receives the result and speaks it in the *same* turn. One tool definition works unmodified on both transports (the wire ACK is one shared contract, see [Wire Protocol](/reference/wire-protocol/)). On `KalturaAgentSession`, register handlers once on the facade. They re-attach automatically across mode switches.

**Headless / SSE:** read `collectConverse(...).toolCalls`, a flat array of `{name,args,raw}` for every tool segment in the turn, or call `parseToolCall(seg)` yourself while iterating a stream.

```js
import { parseToolCall } from '@kaltura/intelligent-agents/experience';

for await (const seg of session) {
  const call = parseToolCall(seg);
  if (call?.name === 'navigate_to_slide') deck.goTo(call.args.slide_num);
}
```

**Validating args yourself:** `validateToolArgs(args, schema)` (`@kaltura/intelligent-agents/experience`) is the runtime check both `onToolCall`'s optional `argsSchema` param and `collectConverse`'s `toolArgSchemas` option run internally. Call it directly when you parse segments by hand via `parseToolCall`. `schema` is a `Record<string, ToolArgSchema>` (same shape you already pass to `tools.client({args})`): each key has an optional `type` (`'str'|'int'|'float'|'bool'|'list'|'dict'`), `required`, and `enum`. Returns `{ok:true}` or `{ok:false, errors:string[]}`.

```js
import { parseToolCall, validateToolArgs } from '@kaltura/intelligent-agents/experience';

const call = parseToolCall(seg);
const check = validateToolArgs(call.args, { slide_num: { type: 'int', required: true } });
if (!check.ok) { /* check.errors */ }
```

`onToolCall` fires **after** the `onAgentAction` guardrail, so a vetoed or allow-listed-out command never dispatches. It also fires **at most once per turn** per identical call. The same segment can re-arrive on the live socket, so the SDK dedups semantically: it matches on tool name plus sorted-key JSON of the args, via `canonicalJson`. That catches an LLM retry of the identical logical call even when the JSON key order isn't deterministic, which raw-string dedup would miss. This dedup resets each turn.

Multiple handlers for one name all run in registration order. A throwing handler is isolated (logged, others still run). `onToolCall` returns an unsubscribe function.

A handler's return value (or thrown/rejected error) is captured and re-emitted as `'toolCallResult'` (`{call, ok, value|error}`). This is **local/app-observable only** unless the tool was built with `waitForResponse:true`. Only then does `session.respondToTool(call.toolMetadata.id, response)` actually carry a result back to the model.

`respondToTool` resolves `{ok:true}` when the ACK POST returns 2xx. Otherwise it resolves `{ok:false, reason}`. See the [result table](/reference/wire-protocol/events-catalog/#the-wait_for_response-ack-one-wire-contract-two-transports) for every `reason`.

A network failure throws. A disconnected session throws `invalid_state`.

---

## Limits and gotchas

These are author-time rules. `tools.clientToolReadiness()` lints the first and `intellects.create().warnings` surfaces it.

### Gotcha 1: `kaltura_genie_experiences` out-competes your tool. Turn it OFF.

On any command-driven intellect, set `capabilities: { kaltura_genie_experiences: 'off' }` at creation. See [External API Integrations § Don't skip `kaltura_genie_experiences: 'off'`](/guides/external-api-integrations/#dont-skip-kaltura_genie_experiences-off) for why it competes with your tool and why creation time matters.

RAG and client commands coexist with this off: knowledge retrieval ON, experiences OFF, commands win.

### Gotcha 2: set capabilities at creation, not after

Capabilities are read when the intellect is created. Always pass `capabilities` to `intellects.create()`. Do not create, then update.

### Native tools work where prompt-only instructions fail

Do not try to get a custom command to fire by asking for it in a prompt block alone, with no real tool behind it. That approach is unreliable: the model can simply decline to emit free-form output an instruction asks for.

A `tools.client` tool is different because it is *bound to the LLM* as a real function-calling tool. Calling it is normal agent behavior, not a text-generation request the model can decline. That's why `tools.client` works where a prompt-only instruction doesn't.

### Tool spirals starve the voice: budget tools per turn

A tool-eager agent can loop the *same* command many times in one turn. When a turn spirals to 5-8+ calls with duplicates, the spoken `avatar` segments get starved and the turn returns **empty text**: a silent avatar, often on the most important question. Defend on both sides.

#### Author side: put a budget in the system prompt

Put three rules in the system prompt:

- A hard TOOL-CALL BUDGET, e.g. max one `create_slide` and one `show_widget` per turn; on a build/show request, pick ONE tool then speak.
- An explicit "ALWAYS SPEAK" rule: every turn ends with 1-3 spoken sentences; a silent turn is a failure.
- A "never narrate a tool failure that isn't happening" rule. Without it, the agent apologizes for "trouble pulling up that widget" when nothing failed.

#### Tool side: fire-and-forget has zero result signal

**Root cause.** A `tools.client` tool built with `waitForResponse:false` carries no response channel back to the model at all: no fixed success literal, no field, nothing. So a same-turn duplicate call looks, from the model's side, identical to the first. Nothing in the tool's own (non-existent) result tells it to stop and speak.

**Mitigation.** Fold an explicit stop-and-speak instruction directly into the tool's `description` field (e.g. `'... This tool has no reply to wait for. Call it EXACTLY ONCE per turn, then immediately narrate it out loud in the SAME turn. Never call it again to confirm or retry.'`). It is the one LLM-facing channel a fire-and-forget `client` tool still has.

**Ready-made pattern.** Site navigation ships this whole shape: `goToTool()` carries the stop-and-speak wording in its description, `SITE_NAV_RULES_PROMPT` repeats it as prompt rules, and the browser-side `SiteNavigator` enforces `oncePerTurn` so a second same-turn call is dropped even when the model ignores both. Use it as the template for any other fire-and-forget UI command. See [Site Navigation with go_to](/guides/site-navigation/).

#### SDK side (headless): dedup, cap, and recover with one follow-up turn

`collectConverse()` dedupes semantically: it matches on tool name plus `canonicalJson` of args, the same key shape the live session's `onToolCall` dispatch uses, so a non-deterministic JSON key order on an LLM retry doesn't defeat it. It also caps per-tool, and stops reading once a spiral threshold is crossed, returning the good content gathered so far plus `spiralStopped: true`. So a headless turn yields the valid first widget instead of blocking to the request timeout.

| Option | Default | What it does |
|---|---|---|
| `maxPerTool` | 3 | Caps repeats of any single tool name before treating it as spiraling |
| `maxToolCalls` | 8 (pass `Infinity` to disable) | Total tool-call budget for the turn before `collectConverse()` stops reading and returns `spiralStopped: true` |

But a spiral can exhaust the segment budget before the agent ever reaches a spoken sentence, leaving `text: ''` with nothing to fall back to in that same turn.

Headless HTTP has no live socket to interrupt or rebuild (that is the live-session mechanism in [Tool-call spiral](/reference/architecture-reference/resilience-and-failure-handling/#tool-call-spiral)). The only lever is a new turn. Pass `recoverFromSpiral: true` to `conversations.send()` or `converseOnce()` to send one follow-up turn that asks for a spoken answer. See [README.md § Management](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md#management).

#### SDK side (live session)

`collectConverse()`'s guard does not run on the live socket path. `KalturaAvatarSession` streams `agent_raw_text` directly, so a spiral there doesn't block a request (there is none to time out). `KalturaAvatarSession` instead runs a stall watchdog plus a two-tier tool-call-spiral circuit breaker (soft signal, then a hard cold-reconnect recovery). The steps, events and limits are in [Tool-call spiral](/reference/architecture-reference/resilience-and-failure-handling/#tool-call-spiral). This doc covers only what an app author needs to configure (the budget above) and the headless equivalent (previous section).

### The LLM has no real-time clock

The system prompt injects the date but not the time-of-day, so any `sentAt`-style time argument the model passes is a guess. If you need accurate timing, have the **page** stamp the receive time, or inject time via request variables. Never trust a time the model put in the args.

### Security defaults: guardrail and arg scrubbing

`onToolCall` dispatch runs through the `onAgentAction` guardrail with a least-privilege allow-list. Configure it at session construction:

```js
// Block ALL client commands:
const session = new KalturaAvatarSession({ /* …other config… */ agentActions: { toolCall: false } });
// Or allow-list specific names:
const session = new KalturaAvatarSession({ /* …other config… */ agentActions: { toolCall: ['navigate_to_slide', 'show_widget'] } });
```

A command not on the allow-list is denied before any handler runs (audited as `agent.action.deny`). The SDK does **not** scrub tool-call args before they reach your handler. Treat `args` as untrusted LLM output:

- Don't feed them into a naive deep-merge or `Object.assign` onto a shared object. A `__proto__`/`constructor` key could pollute a prototype.
- Don't put unsanitized end-user free text, secrets, or authorization data into command args.

See [Security & Compliance](/reference/security/).

---

## Related docs

| Doc | What it adds |
|-----|--------------|
| [README.md](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md) | The SDK how-to: `tools.client` → `onToolCall` → `parseToolCall`, the builders (`tools.api`/`csv`/`code`), and the deployment gotcha in context. |
| [Wire Protocol](/reference/wire-protocol/) | The exact `type:"tool"` segment wire shape and why it is outside the TTS gate. |
| [GenUI Reference](/reference/genui-reference/) | The nine GenUI widgets `show_widget` can render. |
| [Pause for Video/Interactive Content, Then Resume](/guides/pause-resume/) | The sibling mechanism for the other direction: *you* pausing the avatar (e.g. while a client command shows a video) instead of the avatar driving your UI. |
| [Site Navigation with go_to](/guides/site-navigation/) | The fire-and-forget `go_to` navigation tool: the complete, tested instance of the pattern above, reusable on any site. |

