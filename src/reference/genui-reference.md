---
layout: base.njk
title: "GenUI Reference"
description: "Reference for the GenUI widget runtimes the SDK renders natively, including their wire shapes, gating capabilities, and rendering functions."
eyebrow: Reference
---

# GenUI — Complete Capabilities Reference

Everything an agent can put **on screen** beyond spoken text: the `unisphere-tool`
runtimes (flashcards, summaries, sources, forms, Kaltura/external video, images, links)
the Genie brain backend emits as `type:"unisphere-tool"` stream segments, and the SDK renders
natively via `ExperienceRenderer`.

This is the authoritative map — every runtime, its enabling capability, the exact wire
shape, the SDK function/keys that parse and render it, the backend code flow it rides, and the
restrictions that bite in practice.

All claims here are anchored to repo source (`src/...`) and `WIRE-PROTOCOL.md`; where a
behavior is inferred rather than live-captured, it is marked **INFERRED**.

**On this page:** [The model](#the-model-in-one-paragraph) · [Quick start](#quick-start) · [Runtimes](#the-first-class-runtimes) · [Data flow](#how-a-widget-reaches-your-screen-the-data-flow) · [Two delivery paths](#two-delivery-paths-this-is-the-1-gotcha) · [`force_experience`](#force_experience--a-hint-not-a-contract) · [Per-runtime detail](#per-runtime-detail-model-keys--descriptor) · [Authoring](#authoring--which-capability-turns-each-widget-on) · [Consuming](#consuming-widgets-in-your-app) · [Analytics](#widget-interaction-analytics-avoiding-double-counting) · [Safety](#safety-model-owasp-llm05--every-widget-passes-through-this) · [Restrictions](#restrictions--gotchas-read-before-you-build) · [Pointers](#pointers-source-of-truth)

> **Naming note.** `unisphere-tool` and `unisphere.widget.genie` below are the Genie brain's
> literal, on-the-wire constant values — carried over from a naming decision made outside this
> SDK, and preserved verbatim here because changing them would break real interoperability. They
> are unrelated to "GenUI," this doc's own name for the feature; don't read them as a reference to
> a different product.

## The model in one paragraph

The brain emits a **GenUI widget** by writing a fenced block carrying a `widgetName`. The SDK
turns each one into a framework-agnostic descriptor `{kind, data}` your app maps to DOM.

- The Genie brain backend's `message_service` converts the fenced block into a stream segment of
  `type:"unisphere-tool"` shaped `{ type, content, metadata:{ widgetName, runtimeName },
  speechId?, threadId? }`.
- **All widgets share `widgetName:"unisphere.widget.genie"`** — the host keys off
  `metadata.runtimeName` (stripping the `-tool` suffix) to pick a renderer.
- Nothing here emits HTML; every string/URL is run through `core/safety.js` first.

## Quick start

Two lines put every first-class widget on screen with the SDK's built-in DOM renderer:

```js
import { ExperienceRenderer } from '@kaltura/intelligent-agents/experience/genui';
new ExperienceRenderer({ session, mount: document.getElementById('widgets'), onAction }).start();
```

Everything below is the detail behind those two lines — the runtimes, wire shapes, and options.
For the consuming-side API surface, jump to [Consuming widgets in your app](#consuming-widgets-in-your-app).

## The first-class runtimes

Backend tool key (defined in the Genie brain backend's experience-definitions module) → wire `runtimeName` → normalized
dispatch key (the renderer registry key). Source: `src/core/stream.js` `GENUI_RUNTIMES`;
`src/experience/genui/parse.js` `RUNTIMES` (derived from `GENUI_RUNTIMES`, so the two can
never drift).

<div data-nova-target="genui-runtimes-table" data-nova-label="The first-class GenUI runtimes">

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

</div>

`normalizeRuntime(name)` (`parse.js`) strips a trailing `-tool` and trims; it tolerates
an already-normalized name and a non-string (→ `''`). `isKnownRuntime(name)` tests membership in this set.
Any other runtime (e.g. the backend's `gen-ui-composer-tool`, `gen-ui-components-tool`,
`kaltura-video-player-tool` — see **Restrictions**) is NOT in this set and falls through to a safe
fallback.

## How a widget reaches your screen (the data flow)

1. **Author** — at intellect creation, enable the gating capability (table below). The capability
   injects a Jinja block into the system prompt telling the model when to emit that fenced widget.
2. **Emit** — the brain writes a fenced block with `widgetName:"unisphere.widget.genie"` +
   `runtimeName`. `message_service` turns it into a `unisphere-tool` segment.
3. **Stream** — segments arrive as `agent_raw_text` deltas (live socket) or SSE/NDJSON lines (HTTP
   converse). A single widget can span **multiple fragments**.
4. **Assemble** — `SegmentAssembler` (`genui/segments.js`) buffers fragments and flushes a complete
   widget on a boundary change (different `runtime` or `speechId`, or turn end). If that boundary
   change interrupts a JSON body before it finishes writing, the fragment is flagged malformed
   (`onMalformed`) instead of flushed as a widget — `ExperienceRenderer` mounts the same typed
   `{kind:'error', data:{runtime, message}}` fallback it uses for a throwing custom renderer.
5. **Parse** — `parseWidget(segment)` (`parse.js`) → `{widgetName, runtimeName,
   runtime, model}`. `parseContent` is forgiving: object content is used as-is; a string is
   JSON-parsed, else parsed as a loose `key: value` block, else preserved under `.raw`. Never throws.
6. **Render** — `ExperienceRenderer._renderWidget` dispatches `model` to the runtime's renderer →
   `{kind, data, runtime, runtimeName, _meta}`. Your `mount(descriptor)` turns it into DOM.

## Two delivery paths (this is the #1 gotcha)

- **HTTP converse (`Management.conversations.stream`/`send`)** — the **reliable** widget path. You
  pass `force_experience` and read widgets off the segment stream. `collectConverse()`
  (`core/stream.js`) separates them: `experiences` (keyed by wire `runtimeName`),
  `experiencesList` (arrival order), and `kindCounts.experience`. `segmentKind(seg)` classifies a
  `unisphere-tool` segment as `'experience'` (vs `'spoken'` for `text`/`avatar`/`avatar-filler`).
- **Live avatar socket (`KalturaAvatarSession`)** — the join payload **hardcodes
  `force_experience:'avatar_only'`** (`src/experience/wire.js`, `EXPERIENCES` join), so the socket emits
  structured widgets **rarely**. `ExperienceRenderer.start()` subscribes to `brainSegment` and
  tolerates zero widgets. Don't rely on rich widgets on the live face path — drive visuals yourself
  via the client-command channel, or read widgets from the HTTP path.

## `force_experience` — a hint, not a contract

- Valid values (single source of truth, `src/experience/wire.js`,
  `EXPERIENCES`): **`'markdown'`, `'summarization'`, `'flashcards'`, `'avatar_only'`**.
- Parameters are validated on the **first iteration** (entering `for await`) in `conversations.stream`
  (`conversations.js`), NOT at call time — an invalid value throws a typed `validation_error`.
- It is a **HINT**: the brain decides which widget(s) to actually emit from the prompt + intellect.
  Asking for `flashcards` may yield `flashcards-tool` **and** `followups-tool`, or neither. The
  renderer renders whatever `runtimeName` arrives; tests are lenient by design.

## Per-runtime detail (model keys → descriptor)

Each renderer lives in `src/experience/genui/renderers/<name>.js`, takes `(model, ctx)`, and
returns `{kind, data}`. `ctx.urlPolicy` (`{allow:[schemes]}`) is threaded from the
`ExperienceRenderer`. Every renderer accepts **multiple input key aliases** (the model is untrusted
LLM output) and clamps text via `safeText(str, max)` and URLs via `safeUrl(url, policy)`.

### 1. flashcards (`renderFlashcards`)

Cards come from `model.cards`, `model.items`, or `model.flashcards`. Each card:

| Field | Source keys (model) | Constraint |
|---|---|---|
| `front` | `front`, `question`, `term` | ≤1000 chars |
| `back` | `back`, `answer`, `definition` | ≤4000 chars |
| `title` | `title` | ≤300 chars |
| `label` | `label`, `front` | ≤120 chars — the flip toggle's accessible name |

Descriptor: `{kind:'flashcards', data:{title, cards:[{front, back, label}]}}`.

### 2. followups (`renderFollowups`)

| Field | Source keys (model) | Constraint |
|---|---|---|
| `questions` | `questions`, `followups`, `items` — each item a string or `{text\|question}` | ≤500 chars per item; empty items filtered |

Descriptor: `{kind:'followups', data:{questions:[string]}}`. Server-side `add_to_history:false` —
chips are suggestions, not replayed into history.

### 3. sources (`renderSources`)

Items come from `model.sources`, `model.items`, or `model.citations`. Each item:

| Field | Source keys (model) | Constraint |
|---|---|---|
| `title` | `title`, `name`, `label` | ≤500 chars |
| `url` | `url`, `link`, `href` (via `safeUrl`) | unsafe scheme → `''` |
| `snippet` | `snippet`, `text`, `content` | ≤2000 chars |
| `score` | `score`, `relevance`, `similarity` | forward-compatible passthrough — omitted when absent/non-numeric, never `0` |

Descriptor: `{kind:'sources', data:{sources:[{title, url, snippet, score?}]}}`. RAG-driven emission
is unverified, so `score`'s presence is NOT a claimed backend guarantee.

### 4. summary (`renderSummary`)

| Field | Source keys (model) | Constraint |
|---|---|---|
| `summary` | `summary`, `text`, `content`, `raw` | ≤8000 chars; via `safeSource` — preserves `\n`/`\r`/`\t` so markdown structure survives |
| `bullets` | `bullets`, `points`, `items` | ≤1000 chars per item |
| `title` | `title` | ≤300 chars |

Descriptor: `{kind:'summary', data:{title, summary, bullets:[string]}}`. The summary stays
  untrusted (LLM output); by default `mountWidget` renders it as flat escaped text. Pass
  `mountWidget(descriptor, el, {markdown:true})` to opt into a first-party, allow-listed
  markdown-to-DOM renderer instead — see "Markdown rendering" below. The SDK never emits raw HTML
  either way.

### 5. video-gallery (`renderVideoGallery`) — Kaltura clips

Items come from `model.videos`, `model.entries`, or `model.items`. Each item:

| Field | Source keys (model) | Constraint |
|---|---|---|
| `entryId` | `entryId`, `entry_id`, `id` | ≤100 chars, preserved verbatim — host plays via the Kaltura player |
| `title` | `title`, `name` | — |
| `thumbnailUrl` | `thumbnailUrl`, `thumbnail`, `thumb` | via `safeUrl`; when unset AND the render ctx has `partnerId`, falls back to a derived CDN thumbnail — `thumbnailUrl(entryId, partnerId, {width:480})` (`core/kaltura-media.js`) — so the gallery still shows a real image from just an `entryId` |
| `url` | `url`, `playUrl`, `link` | via `safeUrl` |
| `embedUrl` | *(output — derived, not read from the model)* | `playerEmbedUrl(entryId, partnerId, {uiConfId})` (`core/kaltura-media.js`) when the render ctx has `partnerId`; `''` otherwise |
| `duration` | `duration`, `length` | string-kept, ≤40 chars, to tolerate `"1:23"` or a seconds count |
| `description` | `description` | ≤2000 chars |
| `alt` | `alt`, `title` | ≤300 chars — the image's accessible name |

Descriptor: `{kind:'video-gallery', data:{title, videos:[{entryId, title, thumbnailUrl, url, embedUrl, duration, description, alt}]}}`.
This is the **in-platform video** widget: the host renders the Kaltura player against `entryId`.

### 6. show-link (`renderShowLink`) — links

| Field | Source keys (model) | Constraint |
|---|---|---|
| `url` | `url`, `linkUrl`, `link`, `href`, `mediaUrl` | via `safeUrl` |
| `label` | `label`, `linkText`, `title`, `text` | ≤300 chars; falls back to the URL |
| `description` | `description` | ≤2000 chars |

Descriptor: `{kind:'show-link', data:{url, label, description, safe}}` where **`safe:!!url`** — an
unsafe scheme yields `url:''` + `safe:false` so the host drops it (mirrors the earnings app's
`renderSafeLink` null-drop).

### 7. external-video (`renderExternalVideo`) — non-Kaltura video embeds

| Field | Source keys (model) | Constraint |
|---|---|---|
| `url` | `url`, `videoUrl`, `mediaUrl`, `src`, `embedUrl` | **requires an ABSOLUTE http(s) URL** — a non-`https?://` value (relative path, `//host`, `mailto`) yields `url:''`; this is an iframe/`<video src>` surface |
| `embedUrl` | *(output — derived from `url`)* | `externalEmbedUrl()` (`core/kaltura-media.js`) promotes a recognized YouTube/Vimeo URL to a real iframe-embed URL (`youtube-nocookie.com/embed/…`, `player.vimeo.com/video/…`); any other host → `''` so the host falls back to a plain link |
| `title` | `title`, `name` | ≤500 chars |
| `provider` | `provider`, `source` | ≤100 chars; when absent, auto-filled from the embed match (`'YouTube'` / `'Vimeo'`) |
| `poster` | `poster`, `thumbnail`, `thumbnailUrl` | via `safeUrl` — a still to show before play |
| `description` | `description` | ≤2000 chars |

Descriptor: `{kind:'external-video', data:{url, embedUrl, title, provider, poster, description, safe}}`,
`safe:!!url`. The client check is **defense-in-depth**; the server-side media-URL validator is the
primary guard (**INFERRED** — server validator not in this repo).

### 8. user-properties-form (`renderUserPropertiesForm`) — structured data collection

Fields come from `model.fields`, `model.properties`, or `model.items`. A field without a `key` is
dropped. Each field:

| Field | Source keys (model) | Constraint |
|---|---|---|
| `key` | `key`, `name` | — |
| `type` | `type` (lowercased) | validated against `{str,int,float,bool,list,dict,email,phone,text}`; unknown → `'str'` |
| `label` | `label`, `prompt`, `key` | — |
| `knownValue` | `knownValue`, `known_value` | a value the model already extracted, for pre-fill |
| `required` | `required` | `true` only when `required === true` |
| `description` | `description`, `help` | ≤500 chars |

`required`/`description` let a host wire `aria-required`/`aria-describedby`/`inputmode`.

Descriptor: `{kind:'user-properties-form', data:{title, fields:[{key, type, label, knownValue, required, description}]}}`.
- **Report back:** the default (`user_properties_forms`-configured) path has the host call
  **`session.submitStructuredDataForm(info)`** (`session.js`), which `sanitizeJson`s the object
  and emits the socket event **`setFormLeadInfo`** — a fire-and-forget emit with no durable
  server-side read-back. An app can instead take a different, durable path: never configure
  `user_properties_forms` at all, and reach this same `user-properties-form` widget purely as
  one enum value of its own `show_widget` **client** tool (`kaltura_genie_experiences` OFF),
  rendering the widget into its own dedicated host UI and, on submit, bridging the collected
  values into `request_vars` so the brain itself can call a server-side **api** tool that
  persists them wherever you point it — see
  [Structured Data Forms](/guides/structured-data-forms/).
- For the full picture — configuration, the exact mandatory prompt injection, where
  `setFormLeadInfo` actually persists server-side, and how to deliver the collected data somewhere
  durable — see [Structured Data Forms](/guides/structured-data-forms/) and
  [External API Integrations](/guides/external-api-integrations/).

### 9. content-gallery (`renderContentGallery`) — image/content cards

Items come from `model.items`, `model.slides`, or `model.cards`. Each item:

| Field | Source keys (model) | Constraint |
|---|---|---|
| `id` | `id`, `slideId`, `key` | ≤100 chars, addressable — slides are ordered, mirrors `entryId` |
| `title` | `title`, `name`, `heading` | — |
| `description` | `description`, `text`, `body` | ≤2000 chars |
| `imageUrl` | `imageUrl`, `image`, `thumbnail` | via `safeUrl` |
| `url` | `url`, `link`, `href` | via `safeUrl` |
| `alt` | `alt` ?? `title` ?? `description` (3-level fallback) | ≤300 chars — the image's accessible name |

Descriptor: `{kind:'content-gallery', data:{title, items:[{id, title, description, imageUrl, url, alt}]}}`.
This is the **image-bearing** widget (a deck/gallery of cards with thumbnails). Note the backend
  key is `gallery_slides`, and the `video_gallery` capability summary says it permits both
  `video-gallery-tool` **and** `content-gallery-tool`.
- **Multi-item only.** The renderer always wraps `items` in a CSS grid sized for several
  thumbnails (`.kgenui__gallery`, `repeat(auto-fill, minmax(120px,1fr))`) — it does not branch
  on item count, so a single, image-less item stretches to the grid's full row width inside the
  widget's full-slot frame and reads as an oversized, awkward card. A `:has(> .kgenui__gallery >
  li:only-child)` CSS rule can give that case a flex/centered treatment instead, and a
  `show_widget` tool description can steer the brain toward `summary` for a single text-only
  point. Prefer `content-gallery` for 2+ image-bearing items; use `summary` for one.

### 10. graded-question (`renderGradedQuestion`) — a host-registered "10th runtime"

Unlike sections 1–9, this is **not** one of the nine backend `unisphere-tool` runtimes — there is
no Genie brain tool that emits `graded-question-tool`. It's a comprehension-check widget you
register yourself, via the exact "10th runtime" extensibility seam described below
(`.register()` / `cfg.renderers`): a prompt with either multiple-choice options or a free-text
answer, an optional answer key, and an optional explanation, graded client-side.

```js
import { ExperienceRenderer, renderGradedQuestion } from '@kaltura/intelligent-agents/experience/genui';

const renderer = new ExperienceRenderer({
  mount: document.getElementById('widgets'),
  renderers: { 'graded-question': renderGradedQuestion },
  onAction: (action, payload) => {
    if (action === 'answer') console.log(payload.questionId, payload.correct, payload.value);
  },
});

// however your app decides to show a check-in question — e.g. after a video chapter —
// render + mount it, same as any custom widget:
renderer.render('graded-question', {
  questionId: 'q1',
  prompt: 'Which HTTP method is idempotent?',
  options: [{ id: 'a', text: 'POST' }, { id: 'b', text: 'PUT' }],
  correctOptionId: 'b',
  explanation: 'PUT replaces a resource; calling it twice has the same effect as once.',
});
```

Because it isn't backend-emitted, the LLM itself never authors this widget's model over the wire —
your app supplies `data` directly (e.g. from your own quiz content). `renderGradedQuestion` still
accepts a handful of common source-key aliases for convenience/forward-compat, and every field is
run through `safeText` twice — once in the renderer, once again in `mountWidget`'s DOM builder — so
a hand-built descriptor that skips the renderer entirely is exactly as safe.

| Field | Source keys (model) | Constraint |
|---|---|---|
| `questionId` | `questionId`, `id`, `key` | ≤200 chars; falls back to a slug derived from the prompt |
| `variant` | *(derived)* `'choice'` when `options` is non-empty, else `'text'` | not settable directly |
| `prompt` | `prompt`, `question`, `text` | ≤2000 chars |
| `options` | `options`, `choices`, `answers` — each `{id?, text}`, with per-option `text` from `text`/`label`/`value` and `id` from `id`/`key` | ≤8 options; each `text` ≤500 chars; a missing `id` gets a stable slug fallback |
| `correctOptionId` | `correctOptionId`, `correctId`, `answerId`, `correct` | must name a real option's `id`, else `null` (choice variant only) |
| `acceptedAnswers` | `acceptedAnswers`, `answer`, `correctText`, `expectedAnswer`/`expectedAnswers` (string or array) | each entry ≤500 chars, case-insensitive/trimmed match (text variant only) |
| `explanation` | `explanation`, `feedback`, `rationale` | ≤2000 chars — revealed after answering |

Descriptor: `{kind:'graded-question', data:{questionId, variant, prompt, options:[{id,text}], correctOptionId, acceptedAnswers, explanation}}`.

**Grading is client-side, not tamper-proof.** The answer key (`correctOptionId`/`acceptedAnswers`)
travels inside the descriptor itself — the same trust model every other GenUI widget's model data
already uses. Treat this as a comprehension-check for a cooperative learner (e.g. a knowledge-check
after a video chapter), not a proctored or high-stakes assessment primitive.

**`correct` is nullable by design.** `null` means "no answer key was authored" (an open-ended,
ungraded question) — distinct from `false` (a definitively wrong answer). A choice question with no
`correctOptionId`, or a free-text question with no `acceptedAnswers`, always grades `null`.

**Interaction event.** Once the learner submits (one answer per mount — a second submit is a
no-op), `mountWidget`'s builder calls:

```js
onAction('answer', {
  questionId,          // string — the descriptor's questionId
  variant,              // 'choice' | 'text'
  correct,               // boolean | null — null = no answer key authored
  value,                  // the chosen option's text (choice) or the sanitized free-text answer (text)
  explanation,             // string — '' if none was authored
  optionId,                 // string — present only for the 'choice' variant (the chosen option's id)
});
```

A listening integration branches conversation flow off `correct`/`questionId` — e.g.
`session.speak(...)` a hint on `correct:false`, or advance a lesson plan on `correct:true`. See
`examples/genui-graded-question.mjs` for a full runnable walkthrough of both variants, including the
exact `onAction` payloads for a right answer, a wrong answer, and an ungraded (open-ended) one.

## Authoring — which capability turns each widget on

Capabilities are set **at intellect creation** (partner config caches ~24h; set them up front).
Source of truth: `src/management/capabilities.js` (`CAPABILITY_INFO`, `CAPABILITY_DEFAULTS`,
`OFF_BY_DEFAULT`). `kind` is `tool` | `segment` | `mode` | `prompt` — this only names the
mechanism that gates the capability on/off, not whether its *content* is persona-steerable.
`avatar_filler` (`kind: 'prompt'`) is the exception to watch for: its filler phrasing is
server-generated per turn and NOT reliably steerable via `base_directive`, even though it
streams as a "spoken" segment alongside `avatar`/`text` (see
[Wire Protocol § 4e](/reference/wire-protocol/#4e-agent_raw_textdelta--the-brain-stream-parsed)) —
disable the capability if the default phrasing doesn't fit your persona.

| Capability | Default | Kind | Gates runtime | Notes |
|---|---|---|---|---|
| `kaltura_genie_experiences` | **ON** | mode | (master) | Master switch for structured GenUI. Leaving it on injects a competing instruction that out-competes a custom tool — turn it OFF for command-only agents; see [External API Integrations § Don't skip `kaltura_genie_experiences: 'off'`](/guides/external-api-integrations/#dont-skip-kaltura_genie_experiences-off) |
| `generate_followup_questions` | **ON** | segment | `followups` | — |
| `include_sources` | **ON** | segment | `sources` | Pairs with `use_knowledge_base` (RAG) |
| `video_gallery` | **OFF** | segment | `video-gallery` (+ `content-gallery`) | — |
| `external_video` | **OFF** | segment | `external-video` | — |
| `show_link` | **OFF** | segment | `show-link` | — |
| `avatar_show_content` | **OFF** | prompt | (avatar visual push) | — |
| `use_knowledge_base` | **ON** | tool | (feeds `sources`) | `async_search_knowledge_base` RAG |

The structured data-collection form (`user-properties-form`) is configured via the intellect's
`user_properties_forms` (a LIST of `{call_stage, properties:[{key,type}]}` forms — the server rejects a bare object with 422), not a boolean
capability. The eight `OFF_BY_DEFAULT` capabilities are: `avatar`, `avatar_filler`,
`avatar_show_content`, `video_gallery`, `external_video`, `show_link`, `use_web_search`,
`screen_share_analysis`.

## Consuming widgets in your app

**The 2-line happy path** — pass a DOM Element as `mount` and the SDK renders for you, live:

```js
import { ExperienceRenderer } from '@kaltura/intelligent-agents/experience/genui';
new ExperienceRenderer({ session, mount: document.getElementById('widgets'), onAction }).start();
```

`mountWidget` (`genui/renderers/mount.js`, exported from `./experience/genui`) is the SDK's last-mile
descriptor→DOM renderer — zero-dep, isomorphic (returns `null` with no DOM), **never `innerHTML`**,
accessible by construction, and ships **zero styling** (it emits the `kgenui` / `kgenui__*` class
contract for you to theme). Call it directly — `mountWidget(descriptor, targetEl, { replace?, onAction? })`
— or let `ExperienceRenderer` call it when `mount` is an Element (or `target`).

### `ExperienceRenderer` options

`new ExperienceRenderer({ session?, mount, target?, onAction?, renderers?, replace?, onUnhandled?,
urlPolicy?, partnerId?, uiConfId?, clearOnTurnStart?, maxRendered? })` (`genui/renderer.js`).
`partnerId` alone enables `video-gallery` to build a player-embed iframe URL from each `entryId`;
`uiConfId` (string or number) is optional and pins a specific player uiConf in that URL. `mount` is a
`(descriptor)=>void` function (full control) **or** a DOM Element (auto-rendered via `mountWidget`).
`maxRendered` (default `100`) caps the `rendered` history — the oldest descriptor is dropped when
the cap is exceeded, so a long-lived session can't grow memory unboundedly.

### Live vs. headless dispatch

In the live socket runtime, `.start()` subscribes to `session.on('brainSegment')` and flushes on
`turnEnd`/`avatarStopTalking`, resetting on `interrupted`. `clearOnTurnStart` (default `true`) also
resets the assembler and `clear()`s `rendered`/`last` on the session's `turnStart` event (re-emitted
from the raw `agent_start_speech` socket event), so a widget from turn N never lingers into turn
N+1 — mirrors the Genie brain backend's own web client nulling content on `AgentStartSpeechReceived`.
The reset only fires when that `turnStart` payload has `isNewTurn:true`; a duplicate/barge-in
`turnStart` (`isNewTurn:false`) leaves widgets alone, same gate every other `turnStart` consumer in
the SDK uses. Set `false` for intentional cross-turn persistence.

Headless, call `.render(runtimeName, widget)` (or `.render(segment)`) per segment from a
`conversations.stream()` feed — the reliable path.

### Registration, fallback, and provenance

- `.register(runtimeName, fn)` adds/overrides a renderer (name normalized); `.has`, `.runtimes`,
  `.last`, `.rendered`, `.clear()`. `replace:true` keeps only the latest widget per turn.
- An unknown runtime renders `{kind:'unknown', data:{runtime, model}}` and fires `onUnhandled`
  (never throws). A throwing custom renderer degrades to `{kind:'error', ...}`.
- `_meta` receipt stamps `{partnerId, source:'experience/genui', scope:'conversation (geniegpcid,
  entitlement ON)', known, firstClass}` — `known` = this instance has a renderer (a registered
  10th runtime is `known:true`); `firstClass` = one of the built-in set.
- `graded-question` (§ 10 above) is a concrete, shipped example of a registered 10th runtime — it's
  exported (`renderGradedQuestion`) but deliberately excluded from `DEFAULT_RENDERERS`/`RUNTIMES`,
  so it stays `known:false` until a host explicitly registers it.

### `onAction`, `WIDGET_KINDS`, and the hand-rolled escape hatch

`onAction(action, payload)` surfaces interactions `mountWidget` can't fulfil itself: `'followup'`
`{question}` (→ `session.speak`), `'submit'` `{values}` (→ `session.submitStructuredDataForm`), `'play'`
`{entryId,url,embedUrl}`, `'open'` `{url}`, `'answer'` `{questionId, variant, correct, value,
explanation, optionId?}` (a `graded-question` was answered — see § 10 above).

`WIDGET_KINDS` (exported) is the frozen list of every `kind` (the nine first-class GenUI runtimes +
`unknown` + `error`) — use it for an exhaustive host switch or a parity test.

You can still read `seg.metadata.runtimeName` and build DOM yourself (use
`renderSafeLink`/`safeText`/`safeUrl` so nothing un-sanitized hits the DOM). Prefer `mountWidget` —
the hand-rolled path is for a fully custom design system only.

### Markdown rendering (opt-in)

`mountWidget(descriptor, el, {markdown:true})` parses a `summary` widget's text
(`genui/renderers/markdown.js`, `renderMarkdown`) as markdown instead of flat text — headings
(`#`-`######`), **bold**/__bold__, *italic*/_italic_, inline `` `code` ``, `[link](url)`, unordered/
ordered lists, fenced code blocks (with a `language-<token>` class), and GFM tables. A markdown
table renders through the `tableEl` builder (`genui/renderers/dom-helpers.js`) — one shared,
safe `<table>` construction path, no duplicate table logic. This is
markdown-**in**-plain-text rendering, not a new wire segment type: the underlying descriptor is
still `{kind:'summary', data:{summary, ...}}`; only the render path changes. It is `never
innerHTML` — every text run is built via `textContent`/`createTextNode` (so a raw `<script>` tag in
the LLM output is inert text, not markup) and every extracted URL goes through `safeUrl` (a
`javascript:`/unsafe-scheme link degrades to plain safe text, never a dead/unsafe `href`). Default
behavior (no `opts.markdown`) is unchanged — flat escaped text — so no existing app regresses by
upgrading.

### Theming + a11y contract (`kgenui` classes)

`mountWidget` emits semantic, accessible DOM and these stable classes (theme them in your CSS — the
SDK ships none): root `kgenui kgenui--{kind}` (`role="group"`, `aria-label`); `kgenui__title`,
`kgenui__text`, `kgenui__list`, `kgenui__chip`, `kgenui__card`, `kgenui__flip`, `kgenui__back`,
`kgenui__link`, `kgenui__img`, `kgenui__gallery`, `kgenui__form`, `kgenui__field`, `kgenui__label`,
`kgenui__input`, `kgenui__help`, `kgenui__submit`, `kgenui__sr-only`. The full class surface also
covers: `kgenui__bullet`, `kgenui__chips`, `kgenui__source`, `kgenui__score`, `kgenui__snippet`,
`kgenui__muted`, `kgenui__meta`, `kgenui__player`, `kgenui__play`, `kgenui__play-glyph`,
`kgenui__embed`, `kgenui__prompt`, `kgenui__feedback` (+ `--correct`/`--incorrect`/`--neutral`
modifiers), `kgenui__explanation`, `kgenui__options-group`, `kgenui__option-label`, `kgenui__radio`,
`kgenui__options`, `kgenui__answer-echo`, `kgenui--unknown`, `kgenui--error`, `kgenui__table`,
`kgenui__markdown`, `kgenui__md-p`, `kgenui__md-h`, `kgenui__md-code`, `kgenui__md-pre`,
`kgenui__md-link`, `kgenui__md-list`. Built-in a11y: flashcards are
`<button aria-pressed>` flip toggles; followups are `<button>` chips in a labeled list; links carry a
visually-hidden "(opens in a new tab)" cue + `rel=noopener noreferrer` and are **dropped** when
`safe:false`; images always have `alt`; form fields are real `<label for>`+`<input>` with
`type`/`inputmode` from the field type and `aria-required`/`aria-describedby` from `required`/`description`.
The SDK ships zero CSS for these class names — style the `.kgenui__*` block in your own stylesheet.

## Widget-interaction analytics (avoiding double-counting)

A recipe for reporting GenUI widget interactions — which widget the learner acted on, what they
picked — to KAVA via `KavaAnalytics.buttonClicked()` (`./experience/analytics`), without
duplicating anything the platform already tracks server-side.

### What not to report (read this first)

The backend (conversation-manager + the Genie brain) already reports its own server-side KAVA
events for every session a `KalturaAvatarSession` connects to — the 80000-range "Immersive
Agents" events: `callStarted`, `callEnded`, `messageResponse` (message delivery), and
`messageFeedbackSent` (feedback). `KavaAnalytics` has no code path that can send any of these (see
the module docblock in `src/experience/analytics.js`) — that is deliberate, not a gap to fill. Do
**not** build client-side reporting for:

| Already server-tracked (80000-range) | Don't re-report client-side as... |
|---|---|
| A message was delivered to the user | A `buttonClicked`/`pageLoad` for "message shown" |
| The user thumbs-up/down'd a reply (`mgmt.feedback.add`) | A `buttonClicked` for "feedback given" |
| A call/session started or ended | A `buttonClicked`/`pageLoad` for "session start/end" |

A GenUI widget rendering on screen isn't itself one of those signals — the widget's *arrival* rides
the same message-delivery event the server already counted. What's safe to report (because it has
no server-side equivalent) is the **client-only choice the learner makes on that widget** — which
chip they clicked, which link they opened, which answer they picked. That choice is the only thing
this recipe reports.

### The recipe: two widget interaction types, two distinguishable events

Wire each widget's `onAction` intent (see
["onAction, WIDGET_KINDS, and the hand-rolled escape hatch"](#onaction-widget_kinds-and-the-hand-rolled-escape-hatch)
above) straight into one `buttonClicked()` call. Construct one `KavaAnalytics` per page/session
(same pattern as README's
[KAVA analytics](/reference/sdk-reference/#kava-analytics-opt-in-client-only-application-events) section) and
call it from the same `onAction` handler you already pass to `ExperienceRenderer`:

```js
import { ExperienceRenderer } from '@kaltura/intelligent-agents/experience/genui';
import { KavaAnalytics } from '@kaltura/intelligent-agents/experience/analytics';

const analytics = new KavaAnalytics({
  partnerId: AGENTIC_PARTNER_ID,
  sessionId: session.threadId,   // ties the event to this conversation without re-reporting the conversation itself
  hostingKalturaApplication: 25, // HOSTING_APPLICATIONS.agents
});

new ExperienceRenderer({
  session,
  mount: document.getElementById('widgets'),
  onAction(action, payload) {
    if (action === 'followup') {
      // Interaction type 1: a followups-tool suggested-question chip was clicked.
      analytics.buttonClicked({
        buttonType: 'Select',
        buttonName: 'genui-followup-chip',
        buttonValue: payload.question,   // which chip — makes this event distinguishable per question
        buttonInfo: 'GenUI followups widget — suggested-question chip clicked',
      });
      session.speak(payload.question);
    } else if (action === 'open') {
      // Interaction type 2: a show-link-tool (or sources/content-gallery) link card was opened.
      analytics.buttonClicked({
        buttonType: 'Open',
        buttonName: 'genui-show-link-card',
        buttonValue: payload.url,
        buttonInfo: 'GenUI show-link widget — link card opened',
      });
    }
  },
}).start();
```

Two rules keep the two events distinguishable and non-duplicated:

- **A different `buttonName` per widget/interaction type** (`genui-followup-chip` vs.
  `genui-show-link-card`) — this is what a KAVA dashboard groups and filters on. Don't reuse one
  generic name across widget kinds.
- **`buttonValue` carries the specific choice** (the exact question text, the exact URL) rather
  than a boolean or the widget kind — the kind already lives in `buttonName`. Two clicks on two
  different chips inside the SAME `followups` widget still produce two distinct, non-duplicate
  rows, because each carries a different `buttonValue`.

Apply the same two-line pattern to any other `onAction` intent with no server-side equivalent:
`'play'` (`{entryId, url, embedUrl}` — a video-gallery clip opened) and `'submit'` (`{values}` — a
`user-properties-form` was submitted; report only that it happened and which fields were filled,
not the raw values if they're personal data — see
[Structured Data Forms](/guides/structured-data-forms/) for where that data durably belongs instead).

### Live-verified

Both `followups-tool` and `show-link-tool` (the second requires enabling the `show_link`
capability — OFF by default, see the capability table above) were captured firing in the same
real turn against a live agent over the HTTP converse path, assembled with `SegmentAssembler`,
and run through the two `buttonClicked()` calls above with an injected transport so no test rows
landed on production KAVA. The two resulting payloads shared the same `partnerId`/`sessionId`
(same conversation) but differed in `buttonName`/`buttonType`/`buttonValue` — two distinguishable,
non-duplicated events tied to one conversation, not two copies of the same one.

## Safety model (OWASP LLM05 — every widget passes through this)

`src/core/safety.js`:

- `safeText(s, max=2000)` — coerces to string, strips ASCII control chars (the C0 range
  `U+0000`-`U+001F` plus `U+007F` DEL), length-clamps.
- `safeUrl(url, {allow})` — returns the URL only if its scheme is allow-listed (default
  `https|http|mailto|tel`); blocks `javascript:`/`data:`/`vbscript:`/unknown. A scheme-relative path
  (`/foo`, `foo/bar`) is allowed, but an **authority-relative URL (`//host`, `\\host`) is rejected**
  (open-redirect / embed-hijack vector). `external-video` additionally requires an absolute http(s) URL.
- `renderSafeLink(info, opts)` — builds a real `<a>` via `createElement` + `textContent` +
  scheme-checked `href` (never `innerHTML`); `target=_blank` + `rel=noopener noreferrer`; returns
  `null` outside a browser or for an unsafe URL.
- `sanitizeJson(v)` — drops `__proto__`/`constructor`/`prototype` (used by `submitStructuredDataForm` +
  `setDynamicPrompt`). `clampInbound(s)` — inbound text clamp.
- No renderer emits HTML; the host renders the `{kind, data}` descriptor with `textContent` / DOM
  APIs. A `summary`'s markdown is the host's responsibility to sanitize.

## Restrictions & gotchas (read before you build)

- **Live socket rarely emits widgets** — `force_experience:'avatar_only'` is hardcoded on the avatar
  join (`wire.js`). Use the HTTP converse path for reliable widgets.
- **`force_experience` is a hint** — never assume the requested experience arrived; the renderer
  parses whatever shows up.
- **`followups-tool`, `flashcards-tool`, and `show-link-tool` are live-captured** — including the
  `followups-tool`/`show-link-tool` boundary flush (a different runtime arriving mid-stream closes
  the prior widget correctly) live-verified end to end through real `SegmentAssembler` →
  `ExperienceRenderer` → `mountWidget` → click → `KavaAnalytics.buttonClicked()` (see
  [Widget-interaction analytics](#widget-interaction-analytics-avoiding-double-counting)). The
  other six runtimes are still **INFERRED** (unit-tested red/green, not live-verified). Source:
  `genui/segments.js` header.
- **RAG-driven vs. config-driven emission is unverified** — whether `video_gallery` /
  `external_video` / `show_link` fire from RAG hits or pure prompt tuning is **not documented**;
  the author-time lever is the capability + prompt, but the trigger is the brain's discretion.
- **Backend may add runtimes outside this set** — e.g. `gen-ui-composer-tool`,
  `gen-ui-components-tool`, `kaltura-video-player-tool`. They are NOT in `RUNTIMES`; the
  renderer routes them to `{kind:'unknown'}` + `onUnhandled` rather than faking a known kind.
- **`sources` needs a knowledge base to cite from** — ground a new agent via `knowledge.addRecord`
  + `knowledge_ids` (ungated; see API-REFERENCE.md § Ground the Agent). `sources` then renders the
  brain's real retrieved citations.
- **`entryId` playback needs the Kaltura player** — `video-gallery` preserves `entryId`; when
  `embedUrl` is present (requires `partnerId`; `uiConfId` is optional and only pins a specific
  player uiConf), the SDK renders an inline player; without it the host renders by `entryId`.

## Pointers (source of truth)

| Topic | File |
|---|---|
| Runtime catalog + normalize + parse | `src/experience/genui/parse.js` |
| The 9 default renderers | `src/experience/genui/renderers/*.js` (+ `index.js` map + `WIDGET_KINDS`) |
| `graded-question` (host-registered 10th runtime) | `src/experience/genui/renderers/graded-question.js` (+ its `mountWidget` builder); runnable example: `examples/genui-graded-question.mjs` |
| DOM mount helper (`mountWidget` + `kgenui` classes) | `src/experience/genui/renderers/mount.js` |
| Multi-fragment assembly | `src/experience/genui/segments.js` |
| Dispatch + dual-mode + fallback | `src/experience/genui/renderer.js` |
| Wire enums (`GENUI_RUNTIMES`, `segmentKind`, `collectConverse`) | `src/core/stream.js` |
| `force_experience` (`EXPERIENCES`) + join hardcode | `src/experience/wire.js` |
| HTTP converse + validation | `src/management/conversations.js` |
| Capability gating (`CAPABILITY_INFO`) | `src/management/capabilities.js` |
| Safety primitives | `src/core/safety.js` |
| `submitStructuredDataForm` / `sendScreenShot` | `src/experience/session.js` |
| Widget-interaction analytics (`KavaAnalytics.buttonClicked`) | `src/experience/analytics.js` |
| Wire segment shape + `force_experience` | `WIRE-PROTOCOL.md` §4e, §7 |
