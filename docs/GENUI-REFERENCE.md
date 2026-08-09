# Genie GenUI — Complete Capabilities Reference

Everything an agent can put **on screen** beyond spoken text: the `unisphere-tool`
runtimes (flashcards, summaries, sources, forms, Kaltura/external video, images, links)
the Genie brain emits as `type:"unisphere-tool"` stream segments, and the SDK renders
natively via `ExperienceRenderer`.

This is the authoritative map — every runtime, its enabling capability, the exact wire
shape, the SDK function/keys that parse and render it, the backend code flow it rides, and the
restrictions that bite in practice.

All claims here are anchored to repo source (`sdk/src/...`) and `WIRE-PROTOCOL.md`; where a
behavior is inferred rather than live-captured, it is marked **INFERRED**.

## The model in one paragraph

The brain emits a **GenUI widget** by writing a fenced block carrying a `widgetName`. Genie's
`message_service` (backend, the Genie brain backend) converts that into a stream segment of
`type:"unisphere-tool"` shaped `{ type, content, metadata:{ widgetName, runtimeName }, speechId?,
threadId? }`. **All widgets share `widgetName:"unisphere.widget.genie"`** — the host keys off
`metadata.runtimeName` (stripping the `-tool` suffix) to pick a renderer. The SDK turns each
segment into a framework-agnostic descriptor `{kind, data}` your app maps to DOM. Nothing here
emits HTML; every string/URL is run through `core/safety.js` first.

## The first-class runtimes

Backend key (`UNISPHERE_TOOLS`, defined in the Genie brain backend's experience-definitions module) → wire `runtimeName` → normalized
dispatch key (the renderer registry key). Source: `sdk/src/core/stream.js` `UNISPHERE_RUNTIMES`;
`sdk/src/experience/genui/parse.js` `RUNTIMES` (derived from `UNISPHERE_RUNTIMES`, so the two can
never drift).

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

`normalizeRuntime(name)` (`parse.js` lines 54–58) strips a trailing `-tool` and trims; it tolerates
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
  `force_experience:'avatar_only'`** (`sdk/src/experience/wire.js`, `EXPERIENCES` join), so the socket emits
  structured widgets **rarely**. `ExperienceRenderer.start()` subscribes to `brainSegment` and
  tolerates zero widgets. Don't rely on rich widgets on the live face path — drive visuals yourself
  via the client-command channel, or read widgets from the HTTP path.

## `force_experience` — a hint, not a contract

- Valid values (single source of truth, `sdk/src/experience/wire.js` line 17;
  `EXPERIENCES`): **`'markdown'`, `'summarization'`, `'flashcards'`, `'avatar_only'`**.
- Parameters are validated on the **first iteration** (entering `for await`) in `conversations.stream`
  (`conversations.js` lines 120–121), NOT at call time — an invalid value throws a typed `validation_error`.
- It is a **HINT**: the brain decides which widget(s) to actually emit from the prompt + intellect.
  Asking for `flashcards` may yield `flashcards-tool` **and** `followups-tool`, or neither. The
  renderer renders whatever `runtimeName` arrives; tests are lenient by design.

## Per-runtime detail (model keys → descriptor)

Each renderer lives in `sdk/src/experience/genui/renderers/<name>.js`, takes `(model, ctx)`, and
returns `{kind, data}`. `ctx.urlPolicy` (`{allow:[schemes]}`) is threaded from the
`ExperienceRenderer`. Every renderer accepts **multiple input key aliases** (the model is untrusted
LLM output) and clamps text via `safeText(str, max)` and URLs via `safeUrl(url, policy)`.

### 1. flashcards (`renderFlashcards`)

- Cards from `model.cards` | `model.items` | `model.flashcards`.
- Each card: `front` ← `front|question|term` (≤1000 chars); `back` ← `back|answer|definition`
  (≤4000). Title ← `model.title` (≤300).
- Descriptor: `{kind:'flashcards', data:{title, cards:[{front, back, label}]}}` — `label` ←
  `label|front` (≤120) is the flip toggle's accessible name.

### 2. followups (`renderFollowups`)

- Questions from `model.questions` | `model.followups` | `model.items`; each item is a string or
  `{text|question}` (≤500 chars), empties filtered.
- Descriptor: `{kind:'followups', data:{questions:[string]}}`.
- Server-side `add_to_history:false` — chips are suggestions, not replayed into history.

### 3. sources (`renderSources`)

- Items from `model.sources` | `model.items` | `model.citations`.
- Each: `title` ← `title|name|label` (≤500); **`url` ← `url|link|href` via `safeUrl`** (unsafe scheme
  → `''`); `snippet` ← `snippet|text|content` (≤2000).
- Descriptor: `{kind:'sources', data:{sources:[{title, url, snippet, score?}]}}` — `score` ←
  `score|relevance|similarity` is a **forward-compatible passthrough** (omitted when absent/non-numeric,
  never `0`); RAG-driven emission is unverified, so it is NOT a claimed backend guarantee.

### 4. summary (`renderSummary`)

- `summary` ← `summary|text|content|raw` (≤8000, **`safeSource`** — preserves `\n`/`\r`/`\t` so
  markdown structure survives); `bullets` ← `bullets|points|items` (each ≤1000); title ≤300.
- Descriptor: `{kind:'summary', data:{title, summary, bullets:[string]}}`. The summary stays
  untrusted (LLM output); by default `mountWidget` renders it as flat escaped text. Pass
  `mountWidget(descriptor, el, {markdown:true})` (issue #27) to opt into a first-party, allow-listed
  markdown-to-DOM renderer instead — see "Markdown rendering" below. The SDK never emits raw HTML
  either way.

### 5. video-gallery (`renderVideoGallery`) — Kaltura clips

- Items from `model.videos` | `model.entries` | `model.items`.
- Each: **`entryId` ← `entryId|entry_id|id`** (≤100, preserved verbatim — host plays via the Kaltura
  player); `title` ← `title|name`; `thumbnailUrl` ← `thumbnailUrl|thumbnail|thumb` (**`safeUrl`**);
  `url` ← `url|playUrl|link` (**`safeUrl`**); `embedUrl` ← `embedUrl|embed_url|embedLink` (**`safeUrl`**);
  `duration` ← `duration|length` (string-kept, ≤40, to
  tolerate `"1:23"` or a seconds count); `description` ≤2000; `alt` ← `alt|title` (≤300, the image's
  accessible name).
- Descriptor: `{kind:'video-gallery', data:{title, videos:[{entryId, title, thumbnailUrl, url, embedUrl, duration, description, alt}]}}`.
- This is the **in-platform video** widget: the host renders the Kaltura player against `entryId`.

### 6. show-link (`renderShowLink`) — links

- `url` ← `url|linkUrl|link|href|mediaUrl` via `safeUrl`; `label` ← `label|linkText|title|text`
  (falls back to the URL, ≤300); `description` ≤2000.
- Descriptor: `{kind:'show-link', data:{url, label, description, safe}}` where **`safe:!!url`** — an
  unsafe scheme yields `url:''` + `safe:false` so the host drops it (mirrors the earnings app's
  `renderSafeLink` null-drop).

### 7. external-video (`renderExternalVideo`) — non-Kaltura video embeds

- `url` ← `url|videoUrl|mediaUrl|src|embedUrl`. **Requires an ABSOLUTE http(s) URL** — a non-`https?://`
  value (relative path, `//host`, `mailto`) yields `url:''` (this is an iframe/`<video src>` surface).
  `provider` ← `provider|source` (≤100); `poster` ← `poster|thumbnail|thumbnailUrl` (**`safeUrl`**, a
  still to show before play); `description` ≤2000.
- Descriptor: `{kind:'external-video', data:{url, title, provider, poster, description, safe}}`, `safe:!!url`.
- The client check is **defense-in-depth**; the server-side media-URL validator is the primary
  guard (**INFERRED** — server validator not in this repo).

### 8. user-properties-form (`renderUserPropertiesForm`) — structured data collection

- Fields from `model.fields` | `model.properties` | `model.items`.
- Each: `key` ← `key|name`; `type` ← `type` lowercased, validated against
  **`{str,int,float,bool,list,dict,email,phone,text}`** (unknown → `'str'`); `label` ←
  `label|prompt|key`; `knownValue` ← `knownValue|known_value` (a value the model already extracted,
  for pre-fill); `required` ← `required === true`; `description` ← `description|help` (≤500). The
  `required`/`description` fields let a host wire `aria-required`/`aria-describedby`/`inputmode`.
  Fields without a `key` are dropped.
- Descriptor: `{kind:'user-properties-form', data:{title, fields:[{key, type, label, knownValue, required, description}]}}`.
- **Report back:** the default (`user_properties_forms`-configured) path has the host call
  **`session.submitStructuredDataForm(info)`** (`session.js`), which `sanitizeJson`s the object
  and emits the socket event **`setFormLeadInfo`** — a fire-and-forget emit with no durable
  server-side read-back. `apps/earnings-avatar-q2` takes a different, durable path instead: it
  never configures `user_properties_forms` at all, and reaches this same `user-properties-form`
  widget purely as one enum value of its own `show_widget` **client** tool
  (`kaltura_genie_experiences` is OFF). Its host (`public/genui.js`'s `renderLeadCaptureForm`)
  renders the widget into a dedicated full-screen blocking modal rather than a peer region, and
  on submit bridges the collected values into `request_vars` (`{{ lead_email }}`/
  `{{ lead_phone }}`) so the brain itself can call a server-side `save_lead_to_sheet` **api**
  tool — see [STRUCTURED-DATA-FORMS.md](STRUCTURED-DATA-FORMS.md)'s "reference app" note.
- For the full picture — configuration, the exact mandatory prompt injection, where
  `setFormLeadInfo` actually persists server-side, and how to deliver the collected data somewhere
  durable — see [STRUCTURED-DATA-FORMS.md](STRUCTURED-DATA-FORMS.md) and
  [EXTERNAL-API-INTEGRATIONS.md](EXTERNAL-API-INTEGRATIONS.md).

### 9. content-gallery (`renderContentGallery`) — image/content cards

- Items from `model.items` | `model.slides` | `model.cards`.
- Each: `id` ← `id|slideId|key` (≤100, addressable — slides are ordered, mirrors `entryId`);
  `title` ← `title|name|heading`; `description` ← `description|text|body` (≤2000); **`imageUrl`
  ← `imageUrl|image|thumbnail` (`safeUrl`)**; `url` ← `url|link|href` (`safeUrl`); `alt` ← `alt|title`
  (≤300, the image's accessible name).
- Descriptor: `{kind:'content-gallery', data:{title, items:[{id, title, description, imageUrl, url, alt}]}}`.
- This is the **image-bearing** widget (a deck/gallery of cards with thumbnails). Note the backend
  key is `gallery_slides`, and the `video_gallery` capability summary says it permits both
  `video-gallery-tool` **and** `content-gallery-tool`.
- **Multi-item only.** The renderer always wraps `items` in a CSS grid sized for several
  thumbnails (`.kgenui__gallery`, `repeat(auto-fill, minmax(120px,1fr))`) — it does not branch
  on item count, so a single, image-less item stretches to the grid's full row width inside the
  widget's full-slot frame and reads as an oversized, awkward card (live-observed on the Q2
  earnings app). `apps/earnings-avatar-q2/public/styles.css`'s `:has(> .kgenui__gallery >
  li:only-child)` rule gives that case `.chart-card`'s flex/centered treatment instead, and the
  app's `show_widget` tool description steers the brain toward `summary` for a single text-only
  point. Prefer `content-gallery` for 2+ image-bearing items; use `summary` for one.

## Authoring — which capability turns each widget on

Capabilities are set **at intellect creation** (partner config caches ~24h; set them up front).
Source of truth: `sdk/src/management/capabilities.js` (`CAPABILITY_INFO`, `CAPABILITY_DEFAULTS`,
`OFF_BY_DEFAULT`). `kind` is `tool` | `segment` | `mode` | `prompt`.

| Capability | Default | Kind | Gates runtime | Notes |
|---|---|---|---|---|
| `kaltura_genie_experiences` | **ON** | mode | (master) | Master switch for structured GenUI; turn OFF for command-only agents |
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

- **`ExperienceRenderer`** `({ session?, mount, target?, onAction?, renderers?, replace?, onUnhandled?,
  urlPolicy?, partnerId?, uiConfId?, clearOnTurnStart? })` (`genui/renderer.js`). `uiConfId` (string or
  number) enables `video-gallery` to build a player-embed iframe URL (requires `partnerId`). `mount` is a
  `(descriptor)=>void` function (full control) **or** a DOM Element (auto-rendered via `mountWidget`).
  - LIVE: `.start()` subscribes to `session.on('brainSegment')` + flushes on `turnEnd` /
    `avatarStopTalking`, resets on `interrupted`. `clearOnTurnStart` (default `true`, issue #28) also
    resets the assembler + `clear()`s `rendered`/`last` on the session's `turnStart` event (re-emitted
    from the raw `agent_start_speech` socket event), so a widget from turn N never lingers into turn
    N+1 — mirrors Genie's own web client nulling content on `AgentStartSpeechReceived`. Set `false` for
    intentional cross-turn persistence.
  - HEADLESS: `.render(runtimeName, widget)` (or `.render(segment)`) called per segment from a
    `conversations.stream()` feed — the reliable path.
  - `.register(runtimeName, fn)` adds/overrides a renderer (name normalized); `.has`, `.runtimes`,
    `.last`, `.rendered`, `.clear()`. `replace:true` keeps only the latest widget per turn.
  - Unknown runtime → `{kind:'unknown', data:{runtime, model}}` + fires `onUnhandled` (never throws).
    A throwing custom renderer degrades to `{kind:'error', ...}`.
  - `_meta` receipt stamps `{partnerId, source:'experience/genui', scope:'conversation (geniegpcid,
    entitlement ON)', known, firstClass}` — `known` = this instance has a renderer (a registered
    10th runtime is `known:true`); `firstClass` = one of the built-in set.
- **`onAction(action, payload)`** surfaces interactions `mountWidget` can't fulfil itself: `'followup'`
  `{question}` (→ `session.speak`), `'submit'` `{values}` (→ `session.submitStructuredDataForm`), `'play'`
  `{entryId,url,embedUrl}`, `'open'` `{url}`.
- **`WIDGET_KINDS`** (exported) is the frozen list of every `kind` (the first-class Genie
  runtimes + `unknown` + `error`) — use it for an exhaustive host switch or a parity test.
- **Escape hatch (hand-rolled):** you can still read `seg.metadata.runtimeName` and build DOM yourself
  (use `renderSafeLink`/`safeText`/`safeUrl` so nothing un-sanitized hits the DOM). Prefer `mountWidget`
  — the hand-rolled path is for a fully custom design system only.

### Markdown rendering (opt-in, issue #27)

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
`kgenui__input`, `kgenui__help`, `kgenui__submit`, `kgenui__sr-only`. Built-in a11y: flashcards are
`<button aria-pressed>` flip toggles; followups are `<button>` chips in a labeled list; links carry a
visually-hidden "(opens in a new tab)" cue + `rel=noopener noreferrer` and are **dropped** when
`safe:false`; images always have `alt`; form fields are real `<label for>`+`<input>` with
`type`/`inputmode` from the field type and `aria-required`/`aria-describedby` from `required`/`description`.
`apps/earnings-avatar-q2/public/styles.css` (the `.kgenui__*` block) is a complete reference theme.

## Safety model (OWASP LLM05 — every widget passes through this)

`sdk/src/core/safety.js`:

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
- **Only `followups-tool` + `flashcards-tool` are live-captured** — the other seven runtimes and the
  multi-fragment `SegmentAssembler` boundary rules are **INFERRED** (unit-tested red/green, not
  live-verified). Source: `genui/segments.js` header.
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
  `embedUrl` is present (requires `partnerId`+`uiConfId`), the SDK renders an inline player; without
  those the host renders by `entryId`.

## Pointers (source of truth)

| Topic | File |
|---|---|
| Runtime catalog + normalize + parse | `sdk/src/experience/genui/parse.js` |
| The 9 default renderers | `sdk/src/experience/genui/renderers/*.js` (+ `index.js` map + `WIDGET_KINDS`) |
| DOM mount helper (`mountWidget` + `kgenui` classes) | `sdk/src/experience/genui/renderers/mount.js` |
| Multi-fragment assembly | `sdk/src/experience/genui/segments.js` |
| Dispatch + dual-mode + fallback | `sdk/src/experience/genui/renderer.js` |
| Wire enums (`UNISPHERE_RUNTIMES`, `segmentKind`, `collectConverse`) | `sdk/src/core/stream.js` |
| `force_experience` (`EXPERIENCES`) + join hardcode | `sdk/src/experience/wire.js` |
| HTTP converse + validation | `sdk/src/management/conversations.js` |
| Capability gating (`CAPABILITY_INFO`) | `sdk/src/management/capabilities.js` |
| Safety primitives | `sdk/src/core/safety.js` |
| `submitStructuredDataForm` / `sendScreenShot` | `sdk/src/experience/session.js` |
| Wire segment shape + `force_experience` | `WIRE-PROTOCOL.md` §4e, §7 |
