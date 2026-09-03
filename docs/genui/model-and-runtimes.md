# GenUI Model & Runtimes

## The model in one paragraph

The brain emits a **GenUI widget** by writing a fenced block carrying a `widgetName`. The brain backend's `message_service` converts that into a stream segment of `type:"unisphere-tool"` shaped `{ type, content, metadata:{ widgetName, runtimeName }, speechId?, threadId? }`. **All widgets share `widgetName:"unisphere.widget.genie"`** — the host keys off `metadata.runtimeName` (stripping the `-tool` suffix) to pick a renderer. The SDK turns each segment into a framework-agnostic descriptor `{kind, data}` your app maps to DOM. Nothing here emits HTML; every string/URL is run through `core/safety.js` first.

## The first-class runtimes

Backend tool key (defined server-side) → wire `runtimeName` → normalized dispatch key (the renderer registry key). Source: `src/core/stream.js` `GENUI_RUNTIMES`; `src/experience/genui/parse.js` `RUNTIMES` (derived from `GENUI_RUNTIMES`, so the two can never drift).

| # | Backend key | Wire `runtimeName` | Normalized | Purpose |
|---|---|---|---|---|
| 1 | `flashcards` | `flashcards-tool` | `flashcards` | Study Q/A cards |
| 2 | `followups` | `followups-tool` | `followups` | Suggested next-question chips |
| 3 | `sources` | `sources-tool` | `sources` | RAG citation cards (with URLs) |
| 4 | `summarization` | `summary-tool` | `summary` | Text/markdown summary + bullets |
| 5 | `video_gallery` | `video-gallery-tool` | `video-gallery` | Gallery of **Kaltura** clips (by `entryId`) |
| 6 | `show_link` | `show-link-tool` | `show-link` | A single link card |
| 7 | `external_video` | `external-video-tool` | `external-video` | Embed a **non-Kaltura** video |
| 8 | `user_properties_form` | `user-properties-form-tool` | `user-properties-form` | Structured data-collection form |
| 9 | `gallery_slides` | `content-gallery-tool` | `content-gallery` | Gallery of content slides/cards (with **images**) |

`normalizeRuntime(name)` (`parse.js`) strips a trailing `-tool` and trims; it tolerates an already-normalized name and a non-string (→ `''`). `isKnownRuntime(name)` tests membership in this set. Any other runtime (e.g. the backend's `gen-ui-composer-tool`, `gen-ui-components-tool`, `kaltura-video-player-tool` — see [safety-and-restrictions.md](safety-and-restrictions.md)) is NOT in this set and falls through to a safe fallback.

## How a widget reaches your screen (the data flow)

1. **Author** — at intellect creation, enable the gating capability (see [authoring-and-consuming.md](authoring-and-consuming.md)). The capability injects a Jinja block into the system prompt telling the model when to emit that fenced widget.
2. **Emit** — the brain writes a fenced block with `widgetName:"unisphere.widget.genie"` + `runtimeName`. `message_service` turns it into a `unisphere-tool` segment.
3. **Stream** — segments arrive as `agent_raw_text` deltas (live socket) or SSE/NDJSON lines (HTTP converse). A single widget can span **multiple fragments**.
4. **Assemble** — `SegmentAssembler` (`genui/segments.js`) buffers fragments and flushes a complete widget on a boundary change (different `runtime` or `speechId`, or turn end). If that boundary change interrupts a JSON body before it finishes writing, the fragment is flagged malformed (`onMalformed`) instead of flushed as a widget — `ExperienceRenderer` mounts the same typed `{kind:'error', data:{runtime, message}}` fallback it uses for a throwing custom renderer.
5. **Parse** — `parseWidget(segment)` (`parse.js`) → `{widgetName, runtimeName, runtime, model}`. `parseContent` is forgiving: object content is used as-is; a string is JSON-parsed, else parsed as a loose `key: value` block, else preserved under `.raw`. Never throws.
6. **Render** — `ExperienceRenderer._renderWidget` dispatches `model` to the runtime's renderer → `{kind, data, runtime, runtimeName, _meta}`. Your `mount(descriptor)` turns it into DOM.

## Two delivery paths (this is the #1 gotcha)

- **HTTP converse (`Management.conversations.stream`/`send`)** — the **reliable** widget path. You pass `force_experience` and read widgets off the segment stream. `collectConverse()` (`core/stream.js`) separates them: `experiences` (keyed by wire `runtimeName`), `experiencesList` (arrival order), and `kindCounts.experience`. `segmentKind(seg)` classifies a `unisphere-tool` segment as `'experience'` (vs `'spoken'` for `text`/`avatar`/`avatar-filler`).
- **Live avatar socket (`KalturaAvatarSession`)** — the join payload **hardcodes `force_experience:'avatar_only'`** (`src/experience/wire.js`, `EXPERIENCES` join). So the socket emits structured widgets **rarely**. `ExperienceRenderer.start()` subscribes to `brainSegment` and tolerates zero widgets. Don't rely on rich widgets on the live face path. Drive visuals yourself via the client-command channel, or read widgets from the HTTP path.

## `force_experience` — a hint, not a contract

- Valid values (single source of truth, `src/experience/wire.js` `EXPERIENCES`): **`'markdown'`, `'summarization'`, `'flashcards'`, `'avatar_only'`**.
- Parameters are validated on the **first iteration** (entering `for await`) in `conversations.stream` (`conversations.js`), NOT at call time — an invalid value throws a typed `validation_error`.
- It is a **HINT**: the brain decides which widget(s) to actually emit from the prompt + intellect. Asking for `flashcards` may yield `flashcards-tool` **and** `followups-tool`, or neither. The renderer renders whatever `runtimeName` arrives. Tests are lenient by design.

## Related docs

| Doc | Covers |
|---|---|
| [widgets.md](widgets.md) | Per-runtime model keys, constraints, and descriptor shapes |
| [authoring-and-consuming.md](authoring-and-consuming.md) | Capability gating + `ExperienceRenderer`/`mountWidget` consumption |
| [../GENUI-REFERENCE.md](../GENUI-REFERENCE.md) | Back to the index |
