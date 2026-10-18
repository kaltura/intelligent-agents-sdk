# GenUI: Complete Capabilities Reference

GenUI is everything an agent can put **on screen** beyond spoken text: flashcards, summaries, sources, forms, Kaltura/external video, images, and links. The agentic backend emits each of these as a `unisphere-tool` runtime, a stream segment with `type:"unisphere-tool"`. The SDK renders these natively via `ExperienceRenderer`.

This page is the authoritative map. For each runtime, it covers the enabling capability, the exact wire shape, the SDK function and keys that parse and render it, and the restrictions that bite in practice.

> **Naming note.** `unisphere-tool` and `unisphere.widget.genie-tools` below are the agentic backend's literal, on-the-wire constant values. A naming decision made outside this SDK set them, and they're preserved verbatim here because changing them would break real interoperability. They are unrelated to "GenUI," this doc's own name for the feature. Don't read them as a reference to a different product.

| Doc | Covers |
|---|---|
| [genui/model-and-runtimes.md](genui/model-and-runtimes.md) | The model in one paragraph, the first-class runtime catalog, the data-flow pipeline, the two delivery paths, `force_experience` |
| [genui/widgets.md](genui/widgets.md) | Per-runtime model keys, constraints, and descriptor shapes, all 10 widgets |
| [genui/authoring-and-consuming.md](genui/authoring-and-consuming.md) | Which capability gates which widget; `ExperienceRenderer`/`mountWidget` consumption; `screen_share_analysis` |
| [genui/analytics.md](genui/analytics.md) | Reporting widget interactions to KAVA without double-counting |
| [genui/safety-and-restrictions.md](genui/safety-and-restrictions.md) | The OWASP LLM05 safety model; restrictions and gotchas to read before you build |

The wire shape of the segment and `force_experience` are in [wire-protocol/events-catalog.md](wire-protocol/events-catalog.md) and [wire-protocol/client-configuration.md](wire-protocol/client-configuration.md).
