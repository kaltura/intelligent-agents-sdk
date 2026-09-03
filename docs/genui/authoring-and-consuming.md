# Authoring & Consuming Widgets

## Authoring — which capability turns each widget on

Capabilities are set **at intellect creation** (partner config caches ~24h; set them up front). Source of truth: `src/management/capabilities.js` (`CAPABILITY_INFO`, `CAPABILITY_DEFAULTS`, `OFF_BY_DEFAULT`). `kind` is `tool` | `segment` | `mode` | `prompt`. This only names the mechanism that gates the capability on/off, not whether its *content* is persona-steerable. `avatar_filler` (`kind: 'prompt'`) is the exception to watch for. Its filler phrasing is server-generated per turn and NOT reliably steerable via `base_directive`, even though it streams as a "spoken" segment alongside `avatar`/`text` (see [../wire-protocol/events-catalog.md § 4e](../wire-protocol/events-catalog.md#4e-agent_raw_textdelta--the-brain-stream-parsed)). Disable the capability if the default phrasing doesn't fit your persona.

| Capability | Default | Kind | Gates runtime | Notes |
|---|---|---|---|---|
| `kaltura_genie_experiences` | **ON** | mode | (master) | Master switch for structured GenUI. Leaving it on injects a competing instruction that out-competes a custom tool — turn it OFF for command-only agents; see [../EXTERNAL-API-INTEGRATIONS.md § Don't skip `kaltura_genie_experiences: 'off'`](../EXTERNAL-API-INTEGRATIONS.md#dont-skip-kaltura_genie_experiences-off) |
| `generate_followup_questions` | **ON** | segment | `followups` | — |
| `include_sources` | **ON** | segment | `sources` | Pairs with `use_knowledge_base` (RAG) |
| `video_gallery` | **OFF** | segment | `video-gallery` (+ `content-gallery`) | — |
| `external_video` | **OFF** | segment | `external-video` | — |
| `show_link` | **OFF** | segment | `show-link` | — |
| `avatar_show_content` | **OFF** | prompt | (avatar visual push) | — |
| `use_knowledge_base` | **ON** | tool | (feeds `sources`) | `async_search_knowledge_base` RAG |

The structured data-collection form (`user-properties-form`) is configured via the intellect's `user_properties_forms` (a LIST of `{call_stage, properties:[{key,type}]}` forms — the server rejects a bare object with 422), not a boolean capability. The eight `OFF_BY_DEFAULT` capabilities are: `avatar`, `avatar_filler`, `avatar_show_content`, `video_gallery`, `external_video`, `show_link`, `use_web_search`, `screen_share_analysis`.

## Consuming widgets in your app

**The 2-line happy path** — pass a DOM Element as `mount` and the SDK renders for you, live:

```js
import { ExperienceRenderer } from '@kaltura/intelligent-agents/experience/genui';
new ExperienceRenderer({ session, mount: document.getElementById('widgets'), onAction }).start();
```

`mountWidget` (`genui/renderers/mount.js`, exported from `./experience/genui`) is the SDK's last-mile descriptor→DOM renderer — zero-dep, isomorphic (returns `null` with no DOM), **never `innerHTML`**, accessible by construction, and ships **zero styling** (it emits the `kgenui` / `kgenui__*` class contract for you to theme). Call it directly — `mountWidget(descriptor, targetEl, { replace?, onAction? })` — or let `ExperienceRenderer` call it when `mount` is an Element (or `target`).

### `ExperienceRenderer` options

`new ExperienceRenderer({ session?, mount, target?, onAction?, renderers?, replace?, onUnhandled?, urlPolicy?, partnerId?, uiConfId?, clearOnTurnStart?, maxRendered? })` (`genui/renderer.js`). `partnerId` alone enables `video-gallery` to build a player-embed iframe URL from each `entryId`. `uiConfId` (string or number) is optional and pins a specific player uiConf in that URL. `mount` is a `(descriptor)=>void` function (full control) **or** a DOM Element (auto-rendered via `mountWidget`). `maxRendered` (default `100`) caps the `rendered` history. The oldest descriptor is dropped when the cap is exceeded, so a long-lived session can't grow memory unboundedly.

### Live vs. headless dispatch

In the live socket runtime, `.start()` subscribes to `session.on('brainSegment')` and flushes on `turnEnd`/`avatarStopTalking`, resetting on `interrupted`. `clearOnTurnStart` (default `true`) also resets the assembler and `clear()`s `rendered`/`last` on the session's `turnStart` event (re-emitted from the raw `agent_start_speech` socket event). So a widget from turn N never lingers into turn N+1, matching the reset the platform's own client applies when a new turn starts speaking. Set `false` for intentional cross-turn persistence.

Headless, call `.render(runtimeName, widget)` (or `.render(segment)`) per segment from a `conversations.stream()` feed — the reliable path.

### Registration, fallback, and provenance

- `.register(runtimeName, fn)` adds/overrides a renderer (name normalized); `.has`, `.runtimes`, `.last`, `.rendered`, `.clear()`. `replace:true` keeps only the latest widget per turn.
- An unknown runtime renders `{kind:'unknown', data:{runtime, model}}` and fires `onUnhandled` (never throws). A throwing custom renderer degrades to `{kind:'error', ...}`.
- `_meta` receipt stamps `{partnerId, source:'experience/genui', scope:'conversation (geniegpcid, entitlement ON)', known, firstClass}` — `known` = this instance has a renderer (a registered 10th runtime is `known:true`); `firstClass` = one of the built-in set.
- `graded-question` ([widgets.md § 10](widgets.md#10-graded-question-rendergradedquestion--a-host-registered-10th-runtime)) is a concrete, shipped example of a registered 10th runtime — it's exported (`renderGradedQuestion`) but deliberately excluded from `DEFAULT_RENDERERS`/`RUNTIMES`, so it stays `known:false` until a host explicitly registers it.

### `onAction`, `WIDGET_KINDS`, and the hand-rolled escape hatch

`onAction(action, payload)` surfaces interactions `mountWidget` can't fulfil itself: `'followup'` `{question}` (→ `session.speak`), `'submit'` `{values}` (→ `session.submitStructuredDataForm`), `'play'` `{entryId,url,embedUrl}`, `'open'` `{url}`, `'answer'` `{questionId, variant, correct, value, explanation, optionId?}` (a `graded-question` was answered — see [widgets.md § 10](widgets.md#10-graded-question-rendergradedquestion--a-host-registered-10th-runtime) above).

`WIDGET_KINDS` (exported) is the frozen list of every `kind` (the nine first-class GenUI runtimes + `unknown` + `error`) — use it for an exhaustive host switch or a parity test.

You can still read `seg.metadata.runtimeName` and build DOM yourself (use `renderSafeLink`/`safeText`/`safeUrl` so nothing un-sanitized hits the DOM). Prefer `mountWidget` — the hand-rolled path is for a fully custom design system only.

### Markdown rendering (opt-in)

`mountWidget(descriptor, el, {markdown:true})` parses a `summary` widget's text (`genui/renderers/markdown.js`, `renderMarkdown`) as markdown instead of flat text: headings (`#`-`######`), **bold**/__bold__, *italic*/_italic_, inline `` `code` ``, `[link](url)`, unordered/ordered lists, fenced code blocks (with a `language-<token>` class), and GFM tables. A markdown table renders through the `tableEl` builder (`genui/renderers/dom-helpers.js`), one shared, safe `<table>` construction path with no duplicate table logic. This is markdown-**in**-plain-text rendering, not a new wire segment type. The underlying descriptor is still `{kind:'summary', data:{summary, ...}}`; only the render path changes. It is `never innerHTML`. Every text run is built via `textContent`/`createTextNode`, so a raw `<script>` tag in the LLM output is inert text, not markup. Every extracted URL goes through `safeUrl` too (a `javascript:`/unsafe-scheme link degrades to plain safe text, never a dead/unsafe `href`). Default behavior (no `opts.markdown`) is unchanged: flat escaped text, so no existing app regresses by upgrading.

### Theming + a11y contract (`kgenui` classes)

`mountWidget` emits semantic, accessible DOM and these stable classes (theme them in your CSS — the SDK ships none): root `kgenui kgenui--{kind}` (`role="group"`, `aria-label`); `kgenui__title`, `kgenui__text`, `kgenui__list`, `kgenui__chip`, `kgenui__card`, `kgenui__flip`, `kgenui__back`, `kgenui__link`, `kgenui__img`, `kgenui__gallery`, `kgenui__form`, `kgenui__field`, `kgenui__label`, `kgenui__input`, `kgenui__help`, `kgenui__submit`, `kgenui__sr-only`. Built-in a11y: flashcards are `<button aria-pressed>` flip toggles. Followups are `<button>` chips in a labeled list. Links carry a visually-hidden "(opens in a new tab)" cue + `rel=noopener noreferrer` and are **dropped** when `safe:false`. Images always have `alt`. Form fields are real `<label for>`+`<input>` with `type`/`inputmode` from the field type and `aria-required`/`aria-describedby` from `required`/`description`. The SDK ships zero CSS for these class names. Style the `.kgenui__*` block in your own stylesheet.

## `screen_share_analysis` / `sendScreenShot(data)`

`screen_share_analysis` is the capability that lets an agent receive and reason about a still image of the user's screen. Turn it on via `mgmt.intellects.setCapability(configId, 'screen_share_analysis', 'on', ks)` (it's `OFF_BY_DEFAULT` — see above). On a live session, call `session.sendScreenShot(data)` (`data` is an `ArrayBuffer`/`Uint8Array` image capture) to push one still for vision analysis; it throws unless the server's `clientConfiguration.isScreenShareEnabled` is true, which only happens once the capability is on for that intellect.

## Related docs

| Doc | Covers |
|---|---|
| [model-and-runtimes.md](model-and-runtimes.md) | Runtime catalog, data flow, delivery paths, `force_experience` |
| [widgets.md](widgets.md) | Per-runtime model keys, constraints, and descriptor shapes |
| [analytics.md](analytics.md) | Reporting widget interactions to KAVA without double-counting |
| [../GENUI-REFERENCE.md](../GENUI-REFERENCE.md) | Back to the index |
