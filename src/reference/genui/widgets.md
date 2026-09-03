---
layout: base.njk
title: "GenUI · Per-Runtime Widget Detail"
description: "Every renderer's model keys, constraints, and returned descriptor shape, runtime by runtime."
eyebrow: Reference
---

# Per-runtime detail (model keys → descriptor)

Each renderer lives in `src/experience/genui/renderers/<name>.js`, takes `(model, ctx)`, and returns `{kind, data}`. `ctx.urlPolicy` (`{allow:[schemes]}`) is threaded from the `ExperienceRenderer`. Every renderer accepts **multiple input key aliases** (the model is untrusted LLM output) and clamps text via `safeText(str, max)` and URLs via `safeUrl(url, policy)`.

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

Descriptor: `{kind:'followups', data:{questions:[string]}}`. Server-side `add_to_history:false` — chips are suggestions, not replayed into history.

### 3. sources (`renderSources`)

Items come from `model.sources`, `model.items`, or `model.citations`. Each item:

| Field | Source keys (model) | Constraint |
|---|---|---|
| `title` | `title`, `name`, `label` | ≤500 chars |
| `url` | `url`, `link`, `href` (via `safeUrl`) | unsafe scheme → `''` |
| `snippet` | `snippet`, `text`, `content` | ≤2000 chars |
| `score` | `score`, `relevance`, `similarity` | forward-compatible passthrough — omitted when absent/non-numeric, never `0` |

Descriptor: `{kind:'sources', data:{sources:[{title, url, snippet, score?}]}}`. RAG-driven emission is unverified, so `score`'s presence is NOT a claimed backend guarantee.

### 4. summary (`renderSummary`)

| Field | Source keys (model) | Constraint |
|---|---|---|
| `summary` | `summary`, `text`, `content`, `raw` | ≤8000 chars; via `safeSource` — preserves `\n`/`\r`/`\t` so markdown structure survives |
| `bullets` | `bullets`, `points`, `items` | ≤1000 chars per item |
| `title` | `title` | ≤300 chars |

Descriptor: `{kind:'summary', data:{title, summary, bullets:[string]}}`. The summary stays untrusted (LLM output); by default `mountWidget` renders it as flat escaped text. Pass `mountWidget(descriptor, el, {markdown:true})` to opt into a first-party, allow-listed markdown-to-DOM renderer instead — see [GenUI · Authoring and Consuming Widgets § Markdown rendering (opt-in)](/reference/genui/authoring-and-consuming/#markdown-rendering-opt-in). The SDK never emits raw HTML either way.

### 5. video-gallery (`renderVideoGallery`) — Kaltura clips

Items come from `model.videos`, `model.entries`, or `model.items`. Each item:

| Field | Source keys (model) | Constraint |
|---|---|---|
| `entryId` | `entryId`, `entry_id`, `id` | ≤100 chars, preserved verbatim — host plays via the Kaltura player |
| `title` | `title`, `name` | — |
| `thumbnailUrl` | `thumbnailUrl`, `thumbnail`, `thumb` | via `safeUrl` |
| `url` | `url`, `playUrl`, `link` | via `safeUrl` |
| `embedUrl` | *(output — derived, not read from the model)* | `playerEmbedUrl(entryId, partnerId, {uiConfId})` (`core/kaltura-media.js`) when the render ctx has `partnerId`; `''` otherwise |
| `duration` | `duration`, `length` | string-kept, ≤40 chars, to tolerate `"1:23"` or a seconds count |
| `description` | `description` | ≤2000 chars |
| `alt` | `alt`, `title` | ≤300 chars — the image's accessible name |

Descriptor: `{kind:'video-gallery', data:{title, videos:[{entryId, title, thumbnailUrl, url, embedUrl, duration, description, alt}]}}`. This is the **in-platform video** widget: the host renders the Kaltura player against `entryId`.

### 6. show-link (`renderShowLink`) — links

| Field | Source keys (model) | Constraint |
|---|---|---|
| `url` | `url`, `linkUrl`, `link`, `href`, `mediaUrl` | via `safeUrl` |
| `label` | `label`, `linkText`, `title`, `text` | ≤300 chars; falls back to the URL |
| `description` | `description` | ≤2000 chars |

Descriptor: `{kind:'show-link', data:{url, label, description, safe}}` where **`safe:!!url`** — an unsafe scheme yields `url:''` + `safe:false` so the host drops it (mirrors the earnings app's `renderSafeLink` null-drop).

### 7. external-video (`renderExternalVideo`) — non-Kaltura video embeds

| Field | Source keys (model) | Constraint |
|---|---|---|
| `url` | `url`, `videoUrl`, `mediaUrl`, `src`, `embedUrl` | **requires an ABSOLUTE http(s) URL** — a non-`https?://` value (relative path, `//host`, `mailto`) yields `url:''`; this is an iframe/`<video src>` surface |
| `embedUrl` | *(output — derived from `url`)* | `externalEmbedUrl()` (`core/kaltura-media.js`) promotes a recognized YouTube/Vimeo URL to a real iframe-embed URL (`youtube-nocookie.com/embed/…`, `player.vimeo.com/video/…`); any other host → `''` so the host falls back to a plain link |
| `provider` | `provider`, `source` | ≤100 chars; when absent, auto-filled from the embed match (`'YouTube'` / `'Vimeo'`) |
| `poster` | `poster`, `thumbnail`, `thumbnailUrl` | via `safeUrl` — a still to show before play |
| `description` | `description` | ≤2000 chars |

Descriptor: `{kind:'external-video', data:{url, embedUrl, title, provider, poster, description, safe}}`, `safe:!!url`. The client check is **defense-in-depth**; the server-side media-URL validator is the primary guard (**INFERRED** — server validator not in this repo).

### 8. user-properties-form (`renderUserPropertiesForm`) — structured data collection

Fields come from `model.fields`, `model.properties`, or `model.items`. A field without a `key` is dropped. Each field:

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
- **Report back:** the default (`user_properties_forms`-configured) path has the host call **`session.submitStructuredDataForm(info)`** (`session.js`), which `sanitizeJson`s the object and emits the socket event **`setFormLeadInfo`** — a fire-and-forget emit with no durable server-side read-back. An app can instead take a different, durable path: never configure `user_properties_forms` at all, and reach this same `user-properties-form` widget purely as one enum value of its own `show_widget` **client** tool (`kaltura_genie_experiences` OFF), rendering the widget into its own dedicated host UI and, on submit, bridging the collected values into `request_vars` so the brain itself can call a server-side **api** tool that persists them wherever you point it — see [Structured Data Forms](/guides/structured-data-forms/).
- For the full picture — configuration, the exact mandatory prompt injection, where `setFormLeadInfo` actually persists server-side, and how to deliver the collected data somewhere durable — see [Structured Data Forms](/guides/structured-data-forms/) and [External API Integrations](/guides/external-api-integrations/).

### 9. content-gallery (`renderContentGallery`) — image/content cards

Items come from `model.items`, `model.slides`, or `model.cards`. Each item:

| Field | Source keys (model) | Constraint |
|---|---|---|
| `id` | `id`, `slideId`, `key` | ≤100 chars, addressable — slides are ordered, mirrors `entryId` |
| `title` | `title`, `name`, `heading` | — |
| `description` | `description`, `text`, `body` | ≤2000 chars |
| `imageUrl` | `imageUrl`, `image`, `thumbnail` | via `safeUrl` |
| `url` | `url`, `link`, `href` | via `safeUrl` |
| `alt` | `alt`, `title` | ≤300 chars — the image's accessible name |

Descriptor: `{kind:'content-gallery', data:{title, items:[{id, title, description, imageUrl, url, alt}]}}`. This is the **image-bearing** widget (a deck/gallery of cards with thumbnails). Note the backend key is `gallery_slides`, and the `video_gallery` capability summary says it permits both `video-gallery-tool` **and** `content-gallery-tool`.
- **Multi-item only.** The renderer always wraps `items` in a CSS grid sized for several thumbnails (`.kgenui__gallery`, `repeat(auto-fill, minmax(120px,1fr))`). It does not branch on item count. So a single, image-less item stretches to the grid's full row width inside the widget's full-slot frame and reads as an oversized, awkward card. A `:has(> .kgenui__gallery > li:only-child)` CSS rule can give that case a flex/centered treatment instead, and a `show_widget` tool description can steer the brain toward `summary` for a single text-only point. Prefer `content-gallery` for 2+ image-bearing items, and `summary` for one.

### 10. graded-question (`renderGradedQuestion`) — a host-registered "10th runtime"

Unlike sections 1–9, this is **not** one of the nine backend `unisphere-tool` runtimes — there is no brain tool that emits `graded-question-tool`. It's a comprehension-check widget you register yourself, via the exact "10th runtime" extensibility seam described in [GenUI · Authoring and Consuming Widgets § Registration, fallback, and provenance](/reference/genui/authoring-and-consuming/#registration-fallback-and-provenance) (`.register()` / `cfg.renderers`): a prompt with either multiple-choice options or a free-text answer, an optional answer key, and an optional explanation, graded client-side.

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

Because it isn't backend-emitted, the LLM itself never authors this widget's model over the wire — your app supplies `data` directly (e.g. from your own quiz content). `renderGradedQuestion` still accepts a handful of common source-key aliases for convenience/forward-compat, and every field is run through `safeText` twice — once in the renderer, once again in `mountWidget`'s DOM builder — so a hand-built descriptor that skips the renderer entirely is exactly as safe.

| Field | Source keys (model) | Constraint |
|---|---|---|
| `questionId` | `questionId`, `id`, `key` | ≤200 chars; falls back to a slug derived from the prompt |
| `variant` | *(derived)* `'choice'` when `options` is non-empty, else `'text'` | not settable directly |
| `prompt` | `prompt`, `question`, `text` | ≤2000 chars |
| `options` | `options`, `choices`, `answers` — each `{id?, text}` | ≤8 options; each `text` ≤500 chars; a missing `id` gets a stable slug fallback |
| `correctOptionId` | `correctOptionId`, `correctId`, `answerId`, `correct` | must name a real option's `id`, else `null` (choice variant only) |
| `acceptedAnswers` | `acceptedAnswers`, `answer`, `correctText`, `expectedAnswer`/`expectedAnswers` (string or array) | each entry ≤500 chars, case-insensitive/trimmed match (text variant only) |
| `explanation` | `explanation`, `feedback`, `rationale` | ≤2000 chars — revealed after answering |

Descriptor: `{kind:'graded-question', data:{questionId, variant, prompt, options:[{id,text}], correctOptionId, acceptedAnswers, explanation}}`.

**Grading is client-side, not tamper-proof.** The answer key (`correctOptionId`/`acceptedAnswers`) travels inside the descriptor itself — the same trust model every other GenUI widget's model data already uses. Treat this as a comprehension-check for a cooperative learner (e.g. a knowledge-check after a video chapter), not a proctored or high-stakes assessment primitive.

**`correct` is nullable by design.** `null` means "no answer key was authored" (an open-ended, ungraded question) — distinct from `false` (a definitively wrong answer). A choice question with no `correctOptionId`, or a free-text question with no `acceptedAnswers`, always grades `null`.

**Interaction event.** Once the learner submits (one answer per mount — a second submit is a no-op), `mountWidget`'s builder calls:

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

A listening integration branches conversation flow off `correct`/`questionId` — e.g. `session.speak(...)` a hint on `correct:false`, or advance a lesson plan on `correct:true`. See `examples/genui-graded-question.mjs` for a full runnable walkthrough of both variants, including the exact `onAction` payloads for a right answer, a wrong answer, and an ungraded (open-ended) one.

## Related docs

| Doc | Covers |
|---|---|
| [GenUI · Model and Runtimes](/reference/genui/model-and-runtimes/) | Runtime catalog, data flow, delivery paths, `force_experience` |
| [GenUI · Authoring and Consuming Widgets](/reference/genui/authoring-and-consuming/) | Capability gating + `ExperienceRenderer`/`mountWidget` consumption |
| [GenUI Reference](/reference/genui-reference/) | Back to the index |

