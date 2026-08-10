# Client-Side Commands — how the avatar drives your UI

How a Kaltura avatar silently triggers actions in *your* app — navigate a deck, render a widget, draw a chart — by calling a tool you defined. The brain decides *when*; the page decides *what happens*. This is the SDK's sharpest differentiator — apps built on it can drive client commands (`navigate_to_slide`/`show_widget`/`highlight_chart`/`open_filing`) off a single live avatar; see `examples/deck-presenter.html` for a self-contained slide-navigation demo.

If you only read one thing: a "client command" is **not a special protocol feature**. It is a native Genie `type:"client"` tool that makes **no server-side call at all** — the *product* is the silent `type:"tool"` segment Genie streams when the LLM calls it. Your page captures that segment and runs whatever JS it wants.

---

## Why it exists

Without this channel, an avatar can only *talk*. With it, the avatar drives a live experience the way a human presenter would: it jumps to the relevant slide when you ask a question, generates a new slide for an off-curriculum topic, shows a chart, switches tracks. The Unisphere Platform Runtimes do not expose a client-command surface — `GenieCapabilities` has no mechanism for the brain to invoke a page-defined function. This SDK ships it, documented and tested, in `tools.client` + `session.onToolCall`.

---

## The mechanism, end to end

Three pieces. Author the command, the brain calls it, the page captures it.

### 1. Author the command (management plane)

`tools.client({name, description, args?, waitForResponse?, timeout?})` builds a native `type:"client"` tool. Unlike the `api`/`csv`/`code` tool types, it has no `request` block, no echo endpoint, and no response shaper — the model calls it, the backend emits the `type:"tool"` segment, and that's the entire server-side contract.

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

`tool_ids` is in the Genie intellect DTO allow-list, so linking a tool persists through **`v1/intellect/update`** (Genie host, admin token) — **not** `partner-config/update`, so there is no 403. The tool BODY itself lives on the separate `/v1/tool/*` entity (`mgmt.tools`), not inside the intellect config.

`waitForResponse` controls whether the model's turn blocks on a real client-supplied result. **Omitting it is not the same as passing `false`** — the backend's own wire default for an absent `wait_for_response` field is `true` (blocking), so pass it explicitly. `false` gives fire-and-forget dispatch (confirmed live: ~2.9s full turn); `true` makes the backend poll up to `timeout` seconds (default 30) for an ACK via `POST /assistant/tool_response` — the host app supplies that ACK with `session.respondToTool(call.toolMetadata.id, response)`.

### 2. The brain calls it → Genie streams a silent segment

When the model invokes the tool, Genie streams a `type:"tool"` segment. Its `content` is the wire form `"<toolName> <json-args>"`:

```text
navigate_to_slide {"slide_num": 4}
```

Crucially, `type:"tool"` is **not in the TTS audio gate** (only `avatar`, `avatar-filler`, and `text` segments are spoken). So the command streams **silently** — the voice track stays clean while the structured command drives your UI. This is why the avatar can switch slides mid-sentence without narrating "let me change the slide." See [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md).

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

## Critical findings for API + SDK development

These are the lessons that cost real debugging time. None of them is enforced server-side — they are author-time discipline. The first is linted by `tools.clientToolReadiness()` and surfaced as `intellects.create().warnings`, but you should know *why*.

### Gotcha 1 — `kaltura_genie_experiences` out-competes your tool. Turn it OFF.

The default-on `kaltura_genie_experiences` capability injects a forceful "Flashcards is your DEFAULT — you MUST call `get_experience_instructions`" instruction into the system prompt. It **out-competes** custom tool calls: the model reaches for the GenUI experience path instead of your command. On any command-driven intellect, set `capabilities: { kaltura_genie_experiences: 'off' }`.

RAG and client commands coexist fine with this off — the teaching avatar proves it (knowledge retrieval ON, experiences OFF, commands win).

### Gotcha 2 — partner config is cached ~24h. Set capabilities at CREATION, not after.

Partner config is Redis-cached server-side for ~24h. Flipping a capability on an *existing* intellect will **not** take effect at converse time until that cache expires. A freshly created intellect has no cache entry, so it loads clean immediately. Always pass `capabilities` to `intellects.create()` — do not create-then-update.

### Native tools work where the GenUI escape-hatch fails

Do not try to ride the `unisphere-tool:<custom-name>` experiences path for custom commands. That path is real in the backend but lives in the lower-priority partner `prompts[]`, which the locked base Genie identity (`sys_prompt_base_directive`) overrides — so the agent refuses to emit it. A partner-configured `tool` is *bound to the LLM*, so calling it is normal agent behavior and does **not** trip the "I'm a knowledge assistant, I can't run JavaScript" refusal reflex. This is the whole reason `tools.client` works: a native tool call is normal agent behavior, not a text-generation request the model can decline.

### Tool spirals starve the voice — budget tools per turn

A tool-eager brain can loop the *same* command many times in one turn (we observed `show_widget` re-emitted 25×). When a turn spirals to 5-8+ calls with duplicates, the spoken `avatar` segments get starved and the turn returns **empty text** — a silent avatar, often on the most important question (23% of turns in a deep multi-persona live test, before the fix). Defend on both sides:

- **Author side:** put a hard TOOL-CALL BUDGET in the system prompt — e.g. max one `create_slide` and one `show_widget` per turn; on a build/show request pick ONE tool then speak — plus an explicit "ALWAYS SPEAK: every turn ends with 1-3 spoken sentences; a silent turn is a failure" rule. This took empty-text from 23% to 0% on the worst prompts. Also add a "never narrate a tool failure that isn't happening" rule (the brain otherwise apologizes for "trouble pulling up that widget" when nothing failed).
- **Tool side (fire-and-forget has ZERO result signal):** the root cause research behind the Q2 earnings avatar's spiral incident traced it upstream to the Genie brain backend, which runs an effectively-unbounded LangChain/LangGraph tool loop for client tools (no `ToolCallLimitMiddleware`, unlike its own `async_search_knowledge_base` tool). A `tools.client` tool built with `waitForResponse:false` carries no response channel back to the model at all — there is no fixed success literal, no field, nothing — so a same-turn duplicate call looks, from the model's side, identical to the first: nothing in the tool's own (non-existent) result tells it to stop and speak. The available mitigation is to fold an explicit stop-and-speak instruction directly into the tool's `description` field (e.g. `'... This tool has no reply to wait for — call it EXACTLY ONCE per turn, then immediately narrate it out loud in the SAME turn; never call it again to confirm or retry.'`) — the one LLM-facing channel a fire-and-forget `client` tool still has.
- **SDK side (headless):** `collectConverse()` already dedupes semantically (tool name + `canonicalJson` of args — the same key shape the live session's `onToolCall` dispatch uses, so a non-deterministic JSON key order on an LLM retry doesn't defeat it), caps per-tool (`maxPerTool`, default 3), and stops reading once a spiral threshold is crossed (`maxToolCalls`, default 8), returning the good content gathered so far plus `spiralStopped: true` — so a headless turn yields the valid first widget instead of blocking to the request timeout. Pass `{ maxToolCalls: Infinity }` to disable. But a spiral can exhaust the segment budget before the brain ever reaches a spoken sentence, leaving `text: ''` with nothing to fall back to in that same turn — live-verified on the Q2 earnings avatar: a two-metric guidance question made the brain re-emit an already-successful `show_widget` call repeatedly with zero spoken segments ever, confirmed via a 90-second/150+-segment uncapped read that the loop does not self-resolve given more time. Headless HTTP has no live-socket `interrupt()`/`_coldReconnect()` to fall back on (that's the live-session mechanism described below) — the only proven lever is a new turn. `conversations.send({..., recoverFromSpiral: true})` (or `converseOnce(cfg, msg, {recoverFromSpiral: true})`) opts into exactly that: when the first attempt comes back `spiralStopped:true` with empty text, it sends ONE follow-up turn on the same thread, prefixing the original message with `SPIRAL_RECOVERY_PREFIX` ("Please answer in words only this turn, without calling any tool. ") — live-verified to reliably break the loop and produce a correct, properly-caveated spoken answer. The result carries `spiralRecovered` (boolean) and `firstAttempt: {toolCalls, spiralStopped}` for diagnostics; never retries more than once; off by default (back-compat).
- **SDK side (live session):** `collectConverse()`'s guard does not run on the live socket path — `KalturaAvatarSession` streams `agent_raw_text` directly, so a spiral there doesn't block a request (there is none to time out). Three mechanisms now cover it, two soft and one hard. First, the brain-liveness watchdog (`session.js`'s `agent_raw_text`/`agent_start_speech` handlers): `type:"tool"`/`"tool_response"`/`"think"` segments are silent to the viewer by themselves, so none of them — not even the first call of the turn — clear it; only spoken/avatar content or a rendered GenUI widget does. `agent_start_speech` (the "preparing to answer…" think-phase marker at the top of every turn) only **re-arms** it with a fresh window rather than clearing it outright, and the watchdog **repeats** every `brainStallMs` (not single-fire) for as long as nothing perceivable follows, so a multi-minute spiral keeps surfacing `brainStalled` (with an incrementing `count`) instead of going stale after one warning. Second, a soft circuit breaker: once a *turn* accumulates `toolSpiralLimit` (default 10) raw `type:"tool"` segments — counted before dedup, since a spiral IS the same call repeating — the SDK emits `toolSpiralDetected` once. **This is signal only — it no longer calls `interrupt()`.** An earlier version called `interrupt()` (`tapToTalkStart`/`tapToTalkEnd`) here to try to yield the runaway turn back to the client. Two live incidents killed that: first, a repro proved it has no observable effect on a spiral already running server-side (the identical `show_widget` call kept repeating for 5+ minutes past the soft trip, including through a server-pushed idle "wake-up" turn whose `agent_start_speech` reset the *per-turn* counter and let the soft breaker "detect" and interrupt() again, while the spiral underneath never actually stopped, until the socket itself died — `transport close` → `JoinRoomTimeout`). Second, and worse, a follow-up incident showed `interrupt()` was actively harmful: per `WIRE-PROTOCOL.md`'s documented barge-in semantics, a mid-turn `tapToTalkStart` forces an early `stvFinishedTalking` with **truncated** `agentContent` — so the soft trip was silently cutting the turn's own narration (`avatarStopTalking` fired with empty text) with no mechanism to reopen the talking channel once the brain went on to stream a complete, correct spoken answer for that same turn. The default limit was also raised from 6 to 10, because a legitimate turn can double its raw tool-segment count when `speak()`'s barge-in branch (still-playing TTS audio from a prior turn) spawns a parallel tap-to-talk stream for the same question — a 3-tool turn duplicating into 6 raw segments this way previously tripped the breaker on an ordinary turn, not a real spiral. Third, the actual fix for stopping a spiral: a **session-scoped hard counter** (`hardToolSpiralLimit`, default `toolSpiralLimit * 3`) that counts raw tool segments since the last perceivable output and is immune to turn-boundary resets — an idle wake-up nudge mid-spiral cannot hide it. Once it's crossed, the SDK emits `toolSpiralRecovering` and forces `_coldReconnect()` — the same full media rebuild already used for a dead media channel, replaying `threadId` so brain memory continues — turning the eventual uncontrolled `JoinRoomTimeout` (observed live: `show_widget` retried 438× over 9 minutes with zero narration) into a deliberate, bounded, self-healing reconnect instead. Unlike the media-recovery escalation path, this call fires while the control socket is still fully connected — the server's `join` handler is idempotent-guarded per-connection (see `WIRE-PROTOCOL.md`'s `join` note), so re-`join`-ing that same live socket is a silent server-side no-op and `clientConfiguration`/`joinComplete` never arrive (reproduced live as `JoinRoomTimeout`). `_coldReconnect()` detects this (`this.state !== 'reconnecting'` at entry means the socket never actually dropped) and opens a genuinely new socket via the same factory `connect()` uses, mirroring its bootstrap, before re-`join`-ing on it. The one path that safely reuses the existing socket is the genuine-transport-disconnect case (`_wireSocket`'s own `connect` handler, reached only after a real drop already set `state` to `'reconnecting'`) — there the server has already discarded that session, so it's a real new server-side connection and re-`join`-ing it is not a no-op. The hard counter and its `_hardSpiralRecovering` guard **re-arm on a successful cold reconnect**, not just on perceivable output — a spiral by definition never produces spoken/GenUI content, so that's the only reset path that can actually fire while one is running; without this re-arm a SECOND spiral later in the same session (a real, easily-triggered scenario, not a corner case — live-verified) found the guard permanently latched from the first recovery and hung indefinitely, reproducing the original bug's exact symptom just delayed to the 2nd occurrence. All three thresholds are configurable at construction (`brainStallMs`, `toolSpiralLimit`, `hardToolSpiralLimit`; `0` disables any of them) and pair with the author-side budget above, which is what stops the brain from wanting to spiral in the first place.
- **SDK side (root cause of one class of spiral):** the `agent_start_speech` handler used to clear the tool-call dedup set (`_firedToolCalls`) and promote the new `speechId` as current unconditionally, on every event — not gated on `isNewTurn` like every other consumer of that flag (`presenter.js`, `avatar-session.js`, and now `ExperienceRenderer`'s `turnStart` handler). A duplicate turn (`isNewTurn:false`, the same CM-side `tap-to-talk` retrigger described above for the soft-limit default) wiped out the first turn's already-fired calls, so an already-successful `show_widget` replayed as if new — directly feeding a spiral rather than merely tripping its detectors. The handler now clears/promotes state only when `isNewTurn` is true.

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

A command not on the allow-list is denied before any handler runs (audited as `agent.action.deny`). Tool-call args are also scrubbed for prototype-pollution keys (`__proto__`/`constructor`) before they reach your handler. Note that is **object-injection** defense, not **prompt-injection** defense — do not put unsanitized end-user free text, secrets, or authorization data into command args. See [SECURITY.md](../SECURITY.md).

---

## Related docs

| Doc | What it adds |
|-----|--------------|
| [README.md](../README.md) | The SDK how-to: `tools.client` → `onToolCall` → `parseToolCall`, the builders (`tools.api`/`csv`/`code`), and the deployment gotcha in context. |
| [WIRE-PROTOCOL.md](WIRE-PROTOCOL.md) | The exact `type:"tool"` segment wire shape and why it is outside the TTS gate. |
| [GENUI-REFERENCE.md](GENUI-REFERENCE.md) | The nine GenUI widgets `show_widget` can render. |
