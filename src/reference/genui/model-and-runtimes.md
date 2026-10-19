---
layout: base.njk
title: "GenUI · Model and Runtimes"
description: "How the brain emits a GenUI widget as a unisphere-tool stream segment, and the first-class runtime keys the SDK dispatches on."
eyebrow: Reference
---

# GenUI Model & Runtimes

[← Back to GenUI Reference](/reference/genui-reference/)


## The model in one paragraph

The agent shows a **GenUI widget** by sending a stream segment of `type:"unisphere-tool"`, shaped `{ type, content, metadata:{ widgetName, runtimeName }, speechId?, threadId? }`. **All widgets share `widgetName:"unisphere.widget.genie-tools"`** (`GENUI_WIDGET_NAME`). Pick a renderer from `metadata.runtimeName` (stripping the `-tool` suffix), not `widgetName`.

The SDK turns each segment into a framework-agnostic descriptor `{kind, data}` that your app maps to DOM. Nothing here emits HTML. Every string and URL is run through `core/safety.js` first.

## The first-class runtimes

Wire `runtimeName` → normalized dispatch key (the renderer registry key). Source: `src/core/stream.js` `GENUI_RUNTIMES`; `src/experience/genui/parse.js` `RUNTIMES` (derived from `GENUI_RUNTIMES`, so the two can never drift).

<div data-nova-target="genui-runtimes-table" data-nova-label="The first-class GenUI runtimes">

| # | Wire `runtimeName` | Normalized | Purpose |
|---|---|---|---|
| 1 | `flashcards-tool` | `flashcards` | Study Q/A cards |
| 2 | `followups-tool` | `followups` | Suggested next-question chips |
| 3 | `sources-tool` | `sources` | Source cards (a URL or an entry id) |
| 4 | `summary-tool` | `summary` | Text/markdown summary and bullets |
| 5 | `video-gallery-tool` | `video-gallery` | Gallery of **Kaltura** clips (by `entryId`) |
| 6 | `show-link-tool` | `show-link` | A single link card |
| 7 | `external-video-tool` | `external-video` | Embed a **non-Kaltura** video |
| 8 | `user-properties-form-tool` | `user-properties-form` | Structured data-collection form |
| 9 | `content-gallery-tool` | `content-gallery` | Gallery of content slides/cards (with **images**) |

</div>

`normalizeRuntime(name)` (`parse.js`) strips a trailing `-tool` and trims; it tolerates an already-normalized name and a non-string (→ `''`). It also maps the alias `video-tool` (or `video`) to `external-video`: that widget renders with the external-video renderer, `onAgentAction` sees `runtime:'external-video'`, and `runtimeName` keeps the wire value. A renderer registered under `video` replaces the external-video one. `isKnownRuntime(name)` tests membership in this set. Any other runtime is NOT in this set and falls through to a safe fallback (see [GenUI · Safety and Restrictions](/reference/genui/safety-and-restrictions/)).

## How a widget reaches your screen (the data flow)

1. **Author.** At intellect creation (the agent's configuration), enable the gating capability (see [GenUI · Authoring and Consuming Widgets](/reference/genui/authoring-and-consuming/)). The capability lets the agent show that widget.
2. **Emit.** The agent sends a widget with `widgetName:"unisphere.widget.genie-tools"` and a `runtimeName`. It arrives as a `unisphere-tool` segment.
3. **Stream.** Segments arrive as `agent_raw_text` deltas (live socket) or SSE/NDJSON lines (HTTP converse). A single widget can span **multiple fragments**.
4. **Assemble.** `SegmentAssembler` (`genui/segments.js`) buffers fragments and flushes a complete widget on a boundary change (different `runtime`, `speechId` or `segmentNumber`, a new `segmentStart`, or turn end). Two widgets of the same runtime in a row stay separate. If that boundary change interrupts a JSON body before it finishes writing, the fragment is flagged malformed (`onMalformed`) instead of flushed as a widget. `ExperienceRenderer` then mounts the same typed `{kind:'error', data:{runtime, message}}` fallback it uses for a throwing custom renderer.
5. **Parse.** `parseWidget(segment)` (`parse.js`) returns `{widgetName, runtimeName, runtime, model}`. `parseContent` is forgiving and never throws: object content is used as-is; string content is JSON-parsed first, else parsed as a YAML subset (block maps and lists, flow `[]`/`{}`, quoted and block scalars; no YAML 1.1 coercions, so `yes` or `1_000` stay strings). Lines it can't read go to `.raw`.
6. **Render.** The renderer dispatches `model` to the runtime's renderer and returns `{kind, data, runtime, runtimeName, _meta}`. Your `mount(descriptor)` turns it into DOM.

## Two delivery paths (this is the #1 gotcha)

- **HTTP converse (`Management.conversations.stream`/`send`)**. The widget path that supports every runtime. You pass `force_experience` and read widgets off the segment stream. `collectConverse()` (`core/stream.js`) separates them: `experiences` (keyed by wire `runtimeName`, one entry per widget, with the fragments of a streamed widget joined into one `content`), `experiencesList` (the same entries in arrival order), and `kindCounts.experience` (a count of raw segments). `segmentKind(seg)` classifies a `unisphere-tool` segment as `'experience'` (vs `'spoken'` for `text`/`avatar`/`avatar-filler`).
- **Live avatar socket (`KalturaAvatarSession`)**: the SDK joins with `force_experience:'avatar_only'` (`src/experience/wire.js`, `EXPERIENCES` join). Flashcards and summarization widgets are not produced there. Widgets that come from the agent's tools (followups, show-link, video-gallery, external-video, content-gallery, user-properties-form, sources) still arrive as `unisphere-tool` segments when the agent has those tools or capabilities enabled. Use the HTTP converse path when you need flashcards or summarization. `ExperienceRenderer.start()` subscribes to `brainSegment` and tolerates zero widgets.

## `force_experience`: a hint, not a contract

- Valid values (single source of truth, `src/experience/wire.js` `EXPERIENCES`): **`'markdown'`, `'summarization'`, `'flashcards'`, `'avatar_only'`**.
- Parameters are validated on the **first iteration** (entering `for await`) in `conversations.stream` (`conversations.js`), NOT at call time. An invalid value throws a typed `validation_error`.
- It is a **HINT**: the agent decides which widget(s) to actually emit, based on the prompt and the intellect. Asking for `flashcards` may yield `flashcards-tool` **and** `followups-tool`, or neither. The renderer renders whatever `runtimeName` arrives.

## Related docs

| Doc | Covers |
|---|---|
| [GenUI · Per-Runtime Widget Detail](/reference/genui/widgets/) | Per-runtime model keys, constraints, and descriptor shapes |
| [GenUI · Authoring and Consuming Widgets](/reference/genui/authoring-and-consuming/) | Capability gating and `ExperienceRenderer`/`mountWidget` consumption |
| [GenUI Reference](/reference/genui-reference/) | Back to the index |

