---
layout: base.njk
title: "GenUI · Safety and Restrictions"
description: "The OWASP LLM05 safety model every widget passes through before it reaches the DOM."
eyebrow: Reference
---

# GenUI Safety & Restrictions

**On this page:** [Safety model (OWASP LLM05 — every widget passes through this)](#safety-model-owasp-llm05--every-widget-passes-through-this) · [Restrictions & gotchas (read before you build)](#restrictions--gotchas-read-before-you-build) · [Related docs](#related-docs)
## Safety model (OWASP LLM05 — every widget passes through this)

`src/core/safety.js`:

- `safeText(s, max=2000)` — coerces to string, strips ASCII control chars (the C0 range `U+0000`-`U+001F` plus `U+007F` DEL), length-clamps.
- `safeUrl(url, {allow})` — returns the URL only if its scheme is allow-listed (default `https|http|mailto|tel`); blocks `javascript:`/`data:`/`vbscript:`/unknown. A scheme-relative path (`/foo`, `foo/bar`) is allowed, but an **authority-relative URL (`//host`, `\\host`) is rejected** (open-redirect / embed-hijack vector). `external-video` additionally requires an absolute http(s) URL.
- `renderSafeLink(info, opts)` — builds a real `<a>` via `createElement` + `textContent` + scheme-checked `href` (never `innerHTML`); `target=_blank` + `rel=noopener noreferrer`; returns `null` outside a browser or for an unsafe URL.
- `sanitizeJson(v)` — drops `__proto__`/`constructor`/`prototype` (used by `submitStructuredDataForm` + `setDynamicPrompt`). `clampInbound(s)` — inbound text clamp.
- No renderer emits HTML; the host renders the `{kind, data}` descriptor with `textContent` / DOM APIs. A `summary`'s markdown is the host's responsibility to sanitize.

## Restrictions & gotchas (read before you build)

- **Live socket rarely emits widgets** — `force_experience:'avatar_only'` is hardcoded on the avatar join (`wire.js`). Use the HTTP converse path for reliable widgets.
- **`force_experience` is a hint** — never assume the requested experience arrived; the renderer parses whatever shows up.
- **`followups-tool`, `flashcards-tool`, and `show-link-tool` are confirmed against real backend output** — including the `followups-tool`/`show-link-tool` boundary flush (a different runtime arriving mid-stream closes the prior widget correctly), end to end through `SegmentAssembler` → `ExperienceRenderer` → `mountWidget` → click → `KavaAnalytics.buttonClicked()` (see [GenUI · Widget Analytics](/reference/genui/analytics/)). The other six runtimes are still **INFERRED** (unit-tested red/green, not yet confirmed against real backend output). Source: `genui/segments.js` header.
- **RAG-driven vs. config-driven emission is unverified** — whether `video_gallery` / `external_video` / `show_link` fire from RAG hits or pure prompt tuning is **not documented**; the author-time lever is the capability + prompt, but the trigger is the brain's discretion.
- **Backend may add runtimes outside this set** — e.g. `gen-ui-composer-tool`, `gen-ui-components-tool`, `kaltura-video-player-tool`. They are NOT in `RUNTIMES`; the renderer routes them to `{kind:'unknown'}` + `onUnhandled` rather than faking a known kind.
- **`sources` needs a knowledge base to cite from** — ground a new agent via `knowledge.addRecord` + `knowledge_ids` (ungated; see API-REFERENCE.md § Ground the Agent). `sources` then renders the brain's real retrieved citations.
- **`entryId` playback needs the Kaltura player** — `video-gallery` preserves `entryId`; when `embedUrl` is present (requires `partnerId`; `uiConfId` is optional and only pins a specific player uiConf), the SDK renders an inline player; without it the host renders by `entryId`.

## Related docs

| Doc | Covers |
|---|---|
| [GenUI · Per-Runtime Widget Detail](/reference/genui/widgets/) | Per-runtime model keys, constraints, and descriptor shapes |
| [GenUI · Authoring and Consuming Widgets](/reference/genui/authoring-and-consuming/) | Capability gating + `ExperienceRenderer`/`mountWidget` consumption |
| [GenUI Reference](/reference/genui-reference/) | Back to the index |

