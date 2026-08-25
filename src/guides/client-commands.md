---
layout: base.njk
title: "Client-Side Commands"
description: "How a Kaltura avatar silently triggers actions in your app, such as navigating a deck, rendering a widget, or drawing a chart, by calling a client-side tool you define."
eyebrow: How-to Guide
---

# Client-Side Commands — how the avatar drives your UI

How a Kaltura avatar silently triggers actions in *your* app — navigate a deck, render a widget, draw a chart — by calling a tool you defined. The brain decides *when*; the page decides *what happens*. This is the mechanism that lets an app drive client commands (`navigate_to_slide`/`show_widget`/`highlight_chart`/`open_filing`) off a single live avatar; see `examples/deck-presenter.html` for a self-contained slide-navigation demo.

---

## Why it exists

Without this channel, an avatar can only *talk*. With it, the avatar drives a live experience the way a human presenter would: it jumps to the relevant slide when you ask a question, generates a new slide for an off-curriculum topic, shows a chart, switches tracks. Prompt-only experience runtimes — the brain's built-in structured-widget system (flashcards, sources, forms, and the other GenUI widgets; see [GenUI Reference](/reference/genui-reference/)) — have no client-command surface, and **`GenieCapabilities`** (the enum of togglable brain behaviors, e.g. `use_knowledge_base`, `avatar`, `kaltura_genie_experiences`) has no mechanism for the brain to invoke a page-defined function. This SDK ships that mechanism, documented and tested, in `tools.client` + `session.onToolCall`.

---

If you only read one thing: a "client command" is **not a special protocol feature**. It is a native Genie `type:"client"` tool that makes **no server-side call at all** — the *product* is the silent `type:"tool"` segment Genie streams when the LLM calls it. Your page captures that segment and runs whatever JS it wants.

---

## The mechanism, end to end

Three pieces. Author the command, the brain calls it, the page captures it.

### 1. Author the command (management plane)

`tools.client({name, description, args?, waitForResponse?, timeout?})` builds a native `type:"client"` tool. Unlike the `api`/`csv`/`code` tool types, it has no `request` block, no echo endpoint, and no response shaper — the model calls it, the backend emits the `type:"tool"` segment, and that's the entire server-side contract.

<div data-nova-target="client-commands-example" data-nova-label="Author a client command example">

```js
import { Management, tools } from '@kaltura/intelligent-agents/management';

const nav = tools.client({
  name: 'navigate_to_slide',
  description: 'Navigate the on-screen deck. Call whenever the user asks about a topic the deck covers, passing the most relevant slide number.',
  args: { slide_num: { prompt: 'The slide number to show (1-N).', type: 'int', required: true } },
  waitForResponse: false,   // fire-and-forget — omitting this BLOCKS (backend default is true)
});

// tools are a SEPARATE, partner-level entity — create it, then reference its id.
const { id } = await mgmt.tools.add(nav, adminKs);

await mgmt.intellects.create({
  capabilities: { kaltura_genie_experiences: 'off' },   // critical — see Gotcha 1
  tool_ids: [id],
  prompts: [/* … */],
}, adminKs);
```

</div>

`tool_ids` is in the Genie intellect DTO allow-list, so linking a tool persists through **`v1/intellect/update`** (Genie host, admin token) — **not** `partner-config/update`, so there is no 403. The tool BODY itself lives on the separate `/v1/tool/*` entity (`mgmt.tools`), not inside the intellect config.

`navigate_to_slide`'s description asks the brain to pass "the most relevant slide number" — but the brain can only resolve a topic to a slide number from something in its context. If you're using the [`Presenter`](/reference/sdk-reference/#presenter) helper, pass `deckOutline: true` to its constructor instead of hand-rolling a topic→slide mapping into `BASE_DIRECTIVE`: it adds a full-deck `{slide_num, title}[]` outline to every Dynamic Prompt, stays correct after a runtime `appendSlide()` (a static `BASE_DIRECTIVE` outline does not), and disambiguates duplicate slide titles automatically.

`waitForResponse` controls whether the model's turn blocks on a real client-supplied result. **Omitting it is not the same as passing `false`** — the backend's own wire default for an absent `wait_for_response` field is `true` (blocking), so pass it explicitly. `false` gives fire-and-forget dispatch (confirmed live: ~2.9s full turn); `true` makes the backend poll up to `timeout` seconds (default 30) for an ACK via `POST /assistant/tool_response` — the host app supplies that ACK with `session.respondToTool(call.toolMetadata.id, response)`.

### 2. The brain calls it → Genie streams a silent segment

When the model invokes the tool, Genie streams a `type:"tool"` segment. Its `content` is the wire form `"<toolName> <json-args>"`:

```text
navigate_to_slide {"slide_num": 4}
```

Crucially, `type:"tool"` is **not in the TTS audio gate** (only `avatar`, `avatar-filler`, and `text` segments are spoken). So the command streams **silently** — the voice track stays clean while the structured command drives your UI. This is why the avatar can switch slides mid-sentence without narrating "let me change the slide." See [Wire Protocol](/reference/wire-protocol/).

### 3. The page captures it (experience plane)

**Live (socket runtime):** register one handler per command with `session.onToolCall(name, handler)`. The SDK parses the segment into `{name, args, raw, toolMetadata}` and dispatches it to your handler.

```js
session.onToolCall('navigate_to_slide', ({ slide_num }) => deck.goTo(slide_num));
session.onToolCall('create_slide',       (slide)      => deck.append(slide));
```

**Headless / SSE:** read `collectConverse(...).toolCalls` — a flat array of `{name,args,raw}` for every tool segment in the turn — or call `parseToolCall(seg)` yourself while iterating a stream.

```js
import { parseToolCall } from '@kaltura/intelligent-agents/experience';

for await (const seg of session) {
  const call = parseToolCall(seg);
  if (call?.name === 'navigate_to_slide') deck.goTo(call.args.slide_num);
}
```

`onToolCall` fires **after** the `onAgentAction` guardrail (a vetoed or allow-listed-out command never dispatches) and **at most once per turn** per identical call — the same segment can re-arrive on the live socket, so the SDK dedups semantically (tool name + sorted-key JSON of args, via `canonicalJson` — an LLM retry of the identical logical call can arrive with non-deterministic JSON key order, which raw-string dedup would miss) and resets each turn. Multiple handlers for one name all run in registration order; a throwing handler is isolated (logged, others still run). `onToolCall` returns an unsubscribe function.

A handler's return value (or thrown/rejected error) is captured and re-emitted as `'toolCallResult'` (`{call, ok, value|error}`), but this is **local/app-observable only** unless the tool was built with `waitForResponse:true` — only then does `session.respondToTool(call.toolMetadata.id, response)` actually carry a result back to the model.

---

## Limits and gotchas

These are the lessons that cost real debugging time. None of them is enforced server-side — they are author-time discipline. The first is linted by `tools.clientToolReadiness()` and surfaced as `intellects.create().warnings`, but you should know *why*.

### Gotcha 1 — `kaltura_genie_experiences` out-competes your tool. Turn it OFF.

On any command-driven intellect, set `capabilities: { kaltura_genie_experiences: 'off' }` at creation — see [External API Integrations § Don't skip `kaltura_genie_experiences: 'off'`](/guides/external-api-integrations/#dont-skip-kaltura_genie_experiences-off) for why it competes with your tool and why creation time matters.

RAG and client commands coexist fine with this off — the teaching avatar proves it (knowledge retrieval ON, experiences OFF, commands win).

### Gotcha 2 — partner config is cached ~24h. Set capabilities at CREATION, not after.

Partner config is Redis-cached server-side for ~24h. Flipping a capability on an *existing* intellect will **not** take effect at converse time until that cache expires. A freshly created intellect has no cache entry, so it loads clean immediately. Always pass `capabilities` to `intellects.create()` — do not create-then-update.

### Native tools work where the GenUI escape-hatch fails

Do not try to ride the `unisphere-tool:<custom-name>` experiences path for custom commands. That path is real in the backend but lives in the lower-priority partner `prompts[]`, which the locked base Genie identity (`sys_prompt_base_directive`) overrides — so the agent refuses to emit it. A partner-configured `tool` is *bound to the LLM*, so calling it is normal agent behavior and does **not** trip the "I'm a knowledge assistant, I can't run JavaScript" refusal reflex. This is the whole reason `tools.client` works: a native tool call is normal agent behavior, not a text-generation request the model can decline.

### Tool spirals starve the voice — budget tools per turn

A tool-eager brain can loop the *same* command many times in one turn (we observed `show_widget` re-emitted 25×). When a turn spirals to 5-8+ calls with duplicates, the spoken `avatar` segments get starved and the turn returns **empty text** — a silent avatar, often on the most important question (23% of turns in a deep multi-persona live test, before the fix). Defend on both sides.

#### Author side: put a budget in the system prompt

Put a hard TOOL-CALL BUDGET in the system prompt — e.g. max one `create_slide` and one `show_widget` per turn; on a build/show request pick ONE tool then speak — plus an explicit "ALWAYS SPEAK: every turn ends with 1-3 spoken sentences; a silent turn is a failure" rule. This took empty-text from 23% to 0% on the worst prompts. Also add a "never narrate a tool failure that isn't happening" rule (the brain otherwise apologizes for "trouble pulling up that widget" when nothing failed).

#### Tool side: fire-and-forget has zero result signal

**Root cause.** The backend does not cap the model's client-tool call loop. A `tools.client` tool
built with `waitForResponse:false` carries no response channel back to the model at all — there is
no fixed success literal, no field, nothing — so a same-turn duplicate call looks, from the model's
side, identical to the first: nothing in the tool's own (non-existent) result tells it to stop and
speak.

**Mitigation.** Fold an explicit stop-and-speak instruction directly into the tool's `description`
field (e.g. `'... This tool has no reply to wait for — call it EXACTLY ONCE per turn, then
immediately narrate it out loud in the SAME turn; never call it again to confirm or retry.'`) — the
one LLM-facing channel a fire-and-forget `client` tool still has.

#### SDK side (headless): dedup, cap, and recover with one follow-up turn

`collectConverse()` dedupes semantically (tool name + `canonicalJson` of args — the same key shape the live session's `onToolCall` dispatch uses, so a non-deterministic JSON key order on an LLM retry doesn't defeat it), caps per-tool, and stops reading once a spiral threshold is crossed, returning the good content gathered so far plus `spiralStopped: true` — so a headless turn yields the valid first widget instead of blocking to the request timeout.

| Option | Default | What it does |
|---|---|---|
| `maxPerTool` | 3 | Caps repeats of any single tool name before treating it as spiraling |
| `maxToolCalls` | 8 (pass `Infinity` to disable) | Total tool-call budget for the turn before `collectConverse()` stops reading and returns `spiralStopped: true` |

But a spiral can exhaust the segment budget before the brain ever reaches a spoken sentence, leaving `text: ''` with nothing to fall back to in that same turn — live-verified: a two-metric guidance question made the brain re-emit an already-successful `show_widget` call repeatedly with zero spoken segments ever, confirmed via a 90-second/150+-segment uncapped read that the loop does not self-resolve given more time. Headless HTTP has no live-socket `interrupt()`/`_coldReconnect()` to fall back on (that's the live-session mechanism in [Architecture Reference](/reference/architecture-reference/#tool-call-spiral-what-happened-and-how-its-mitigated)) — the only proven lever is a new turn. `conversations.send({..., recoverFromSpiral: true})` (or `converseOnce(cfg, msg, {recoverFromSpiral: true})`) opts into exactly that: when the first attempt comes back `spiralStopped:true` with empty text, it sends ONE follow-up turn on the same thread, prefixing the original message with `SPIRAL_RECOVERY_PREFIX` ("Please answer in words only this turn, without calling any tool. ") — live-verified to reliably break the loop and produce a correct, properly-caveated spoken answer. The result carries `spiralRecovered` (boolean) and `firstAttempt: {toolCalls, spiralStopped}` for diagnostics; never retries more than once; off by default (back-compat).

#### SDK side (live session): see Architecture Reference

`collectConverse()`'s guard does not run on the live socket path — `KalturaAvatarSession` streams `agent_raw_text` directly, so a spiral there doesn't block a request (there is none to time out). `KalturaAvatarSession` instead runs a brain-stall watchdog plus a two-tier tool-call-spiral circuit breaker (soft signal, then a hard cold-reconnect recovery). The full incident history, threshold table, and reconnect semantics are documented once, in [Architecture Reference's "Tool-call spiral: what happened and how it's mitigated"](/reference/architecture-reference/#tool-call-spiral-what-happened-and-how-its-mitigated) — read that for the mechanism; this doc covers only what an app author needs to configure (the budget above) and the headless equivalent (previous section).

#### Root cause of one class of spiral

A duplicate-turn edge case (`isNewTurn:false`) used to let an already-successful tool call replay as if new, directly feeding a spiral rather than merely tripping its detectors — see [Architecture Reference's "Tool-call spiral: what happened and how it's mitigated"](/reference/architecture-reference/#tool-call-spiral-what-happened-and-how-its-mitigated) for the full mechanism. The `agent_start_speech` handler now clears/promotes tool-call dedup state only when `isNewTurn` is true.

### The LLM has no real-time clock

The system prompt injects the date but not the time-of-day, so any `sentAt`-style time argument the model passes is a guess. If you need accurate timing, have the **page** stamp the receive time, or inject time via request variables — never trust a time the model put in the args.

### Security defaults — guardrail and arg scrubbing

`onToolCall` dispatch runs through the `onAgentAction` guardrail with a least-privilege allow-list. Configure it at session construction:

```js
// Block ALL client commands:
const session = new KalturaAvatarSession({ /* … */, agentActions: { toolCall: false } });
// Or allow-list specific names:
const session = new KalturaAvatarSession({ /* … */, agentActions: { toolCall: ['navigate_to_slide', 'show_widget'] } });
```

A command not on the allow-list is denied before any handler runs (audited as `agent.action.deny`). Tool-call args are also scrubbed for prototype-pollution keys (`__proto__`/`constructor`) before they reach your handler. Note that is **object-injection** defense, not **prompt-injection** defense — do not put unsanitized end-user free text, secrets, or authorization data into command args. See [Security](/reference/security/).

---

## Related docs

| Doc | What it adds |
|-----|--------------|
| [SDK Reference](/reference/sdk-reference/) | The SDK how-to: `tools.client` → `onToolCall` → `parseToolCall`, the builders (`tools.api`/`csv`/`code`), and the deployment gotcha in context. |
| [Wire Protocol](/reference/wire-protocol/) | The exact `type:"tool"` segment wire shape and why it is outside the TTS gate. |
| [GenUI Reference](/reference/genui-reference/) | The nine GenUI widgets `show_widget` can render. |
