---
layout: base.njk
title: "GenUI Reference"
description: "Reference for the GenUI widget runtimes the SDK renders natively, including their wire shapes, gating capabilities, and rendering functions."
eyebrow: Reference
---

# GenUI — Complete Capabilities Reference

GenUI is everything an agent can put **on screen** beyond spoken text: flashcards, summaries, sources, forms, Kaltura/external video, images, and links. The brain emits each of these as a `unisphere-tool` runtime, a stream segment with `type:"unisphere-tool"`. The SDK renders these natively via `ExperienceRenderer`.

This page is the authoritative map. For each runtime, it covers the enabling capability, the exact wire shape, the SDK function and keys that parse and render it, and the restrictions that bite in practice.

> **Naming note.** `unisphere-tool` and `unisphere.widget.genie` below are the brain's literal, on-the-wire constant values. A naming decision made outside this SDK set them, and they're preserved verbatim here because changing them would break real interoperability. They are unrelated to "GenUI," this doc's own name for the feature. Don't read them as a reference to a different product.

| Doc | Covers |
|---|---|
| [GenUI · Model and Runtimes](/reference/genui/model-and-runtimes/) | The model in one paragraph, the first-class runtime catalog, the data-flow pipeline, the two delivery paths, `force_experience` |
| [GenUI · Per-Runtime Widget Detail](/reference/genui/widgets/) | Per-runtime model keys, constraints, and descriptor shapes — all 10 widgets |
| [GenUI · Authoring and Consuming Widgets](/reference/genui/authoring-and-consuming/) | Which capability gates which widget; `ExperienceRenderer`/`mountWidget` consumption; `screen_share_analysis` |
| [GenUI · Widget Analytics](/reference/genui/analytics/) | Reporting widget interactions to KAVA without double-counting |
| [GenUI · Safety and Restrictions](/reference/genui/safety-and-restrictions/) | The OWASP LLM05 safety model; restrictions and gotchas to read before you build |

## Pointers (source of truth)

| Topic | File |
|---|---|
| Runtime catalog, normalize, and parse | `src/experience/genui/parse.js` |
| The 9 default renderers | `src/experience/genui/renderers/*.js` (and `index.js` map, `WIDGET_KINDS`) |
| `graded-question` (host-registered 10th runtime) | `src/experience/genui/renderers/graded-question.js` (and its `mountWidget` builder); runnable example: `examples/genui-graded-question.mjs` |
| DOM mount helper (`mountWidget` and `kgenui` classes) | `src/experience/genui/renderers/mount.js` |
| Multi-fragment assembly | `src/experience/genui/segments.js` |
| Dispatch, dual-mode, and fallback | `src/experience/genui/renderer.js` |
| Wire enums (`GENUI_RUNTIMES`, `segmentKind`, `collectConverse`) | `src/core/stream.js` |
| `force_experience` (`EXPERIENCES`) and join hardcode | `src/experience/wire.js` |
| HTTP converse and validation | `src/management/conversations.js` |
| Capability gating (`CAPABILITY_INFO`) | `src/management/capabilities.js` |
| Safety primitives | `src/core/safety.js` |
| `submitStructuredDataForm` / `sendScreenShot` | `src/experience/session.js` |
| Widget-interaction analytics (`KavaAnalytics.buttonClicked`) | `src/experience/analytics.js` |
| Wire segment shape and `force_experience` | [Wire Protocol · Events Catalog §4e](/reference/wire-protocol/events-catalog/#4e-agent_raw_textdelta--the-brain-stream-parsed), [Wire Protocol · Client Configuration §7](/reference/wire-protocol/client-configuration/#clientconfiguration-fields-per-session-agent-config) |

