# GenUI — Complete Capabilities Reference

Everything an agent can put **on screen** beyond spoken text: the `unisphere-tool` runtimes (flashcards, summaries, sources, forms, Kaltura/external video, images, links) the brain emits as `type:"unisphere-tool"` stream segments, and the SDK renders natively via `ExperienceRenderer`.

This is the authoritative map — every runtime, its enabling capability, the exact wire shape, the SDK function/keys that parse and render it, and the restrictions that bite in practice.

> **Naming note.** `unisphere-tool` and `unisphere.widget.genie` below are the brain's literal, on-the-wire constant values. They're carried over from a naming decision made outside this SDK, and preserved verbatim here because changing them would break real interoperability. They are unrelated to "GenUI," this doc's own name for the feature. Don't read them as a reference to a different product.

| Doc | Covers |
|---|---|
| [genui/model-and-runtimes.md](genui/model-and-runtimes.md) | The model in one paragraph, the first-class runtime catalog, the data-flow pipeline, the two delivery paths, `force_experience` |
| [genui/widgets.md](genui/widgets.md) | Per-runtime model keys, constraints, and descriptor shapes — all 10 widgets |
| [genui/authoring-and-consuming.md](genui/authoring-and-consuming.md) | Which capability gates which widget; `ExperienceRenderer`/`mountWidget` consumption; `screen_share_analysis` |
| [genui/analytics.md](genui/analytics.md) | Reporting widget interactions to KAVA without double-counting |
| [genui/safety-and-restrictions.md](genui/safety-and-restrictions.md) | The OWASP LLM05 safety model; restrictions and gotchas to read before you build |

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
| Wire segment shape + `force_experience` | [wire-protocol/events-catalog.md §4e](wire-protocol/events-catalog.md#4e-agent_raw_textdelta--the-brain-stream-parsed), [wire-protocol/client-configuration.md §7](wire-protocol/client-configuration.md#7-clientconfiguration-fields-per-session-agent-config) |
