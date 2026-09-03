---
layout: base.njk
title: "GenUI Reference"
description: "Reference for the GenUI widget runtimes the SDK renders natively, including their wire shapes, gating capabilities, and rendering functions."
eyebrow: Reference
---

# GenUI — Complete Capabilities Reference

Everything an agent can put **on screen** beyond spoken text: the `unisphere-tool` runtimes (flashcards, summaries, sources, forms, Kaltura/external video, images, links) the brain emits as `type:"unisphere-tool"` stream segments, and the SDK renders natively via `ExperienceRenderer`.

This is the authoritative map — every runtime, its enabling capability, the exact wire shape, the SDK function/keys that parse and render it, the backend code flow it rides, and the restrictions that bite in practice.

All claims here are anchored to repo source (`src/...`) and `WIRE-PROTOCOL.md`; where a behavior is inferred rather than live-captured, it is marked **INFERRED**.

> **Naming note.** `unisphere-tool` and `unisphere.widget.genie` below are the brain's literal, on-the-wire constant values. They're carried over from a naming decision made outside this SDK, and preserved verbatim here because changing them would break real interoperability. They are unrelated to "GenUI," this doc's own name for the feature. Don't read them as a reference to a different product.

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
| Wire segment shape + `force_experience` | [Wire Protocol · Events Catalog §4e](/reference/wire-protocol/events-catalog/#4e-agent_raw_textdelta--the-brain-stream-parsed), [Wire Protocol · Client Configuration §7](/reference/wire-protocol/client-configuration/#clientconfiguration-fields-per-session-agent-config) |

