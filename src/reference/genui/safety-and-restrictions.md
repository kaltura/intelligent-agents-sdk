---
layout: base.njk
title: "GenUI · Safety and Restrictions"
description: "The OWASP LLM05 safety model every widget passes through before it reaches the DOM."
eyebrow: Reference
---

# GenUI Safety & Restrictions

[← Back to GenUI Reference](/reference/genui-reference/)


## Safety model (OWASP LLM05: every widget passes through this)

`src/core/safety.js`:

- `safeText(s, max=2000)`: coerces to string, strips ASCII control chars (the C0 range `U+0000`-`U+001F` plus `U+007F` DEL), length-clamps.
- `safeUrl(url, {allow})`: returns the URL only if its scheme is allow-listed (default `https|http|mailto|tel`). It blocks `javascript:`, `data:`, `vbscript:`, and unknown schemes. A relative path (`/foo`, `foo/bar`) is allowed, but an **authority-relative URL (`//host`, `\\host`) is rejected** (open-redirect / embed-hijack vector). An absolute URL with embedded userinfo (`https://user:pass@host/...`) is also rejected (phishing / link-spoofing vector). `external-video` additionally requires an absolute http(s) URL.
- `renderSafeLink(info, opts)`: builds a real `<a>` via `createElement`, `textContent`, and a scheme-checked `href` (never `innerHTML`). Sets `target=_blank` and `rel=noopener noreferrer`. Returns `null` outside a browser or for an unsafe URL.
- `sanitizeJson(v)`: drops `__proto__`/`constructor`/`prototype` (used by `submitStructuredDataForm` and `setDynamicPrompt`). `clampInbound(s)` clamps inbound text.
- No renderer emits HTML. The host renders the `{kind, data}` descriptor with `textContent` / DOM APIs. A `summary`'s markdown is the host's responsibility to sanitize.

## Restrictions & gotchas (read before you build)

- **Delivery paths and `force_experience`**: see [Two delivery paths](/reference/genui/model-and-runtimes/#two-delivery-paths-this-is-the-1-gotcha).
- **Runtimes outside this set** are NOT in `RUNTIMES`. The renderer routes them to `{kind:'unknown'}` and `onUnhandled` rather than faking a known kind.
- **`sources` needs a knowledge base to cite from.** Ground a new agent via `knowledge.addRecord` and `knowledge_ids` (ungated; see [Ground the Agent in Your Content](/reference/api/build/knowledge-rag/#ground-the-agent-in-your-content-rag)). `sources` then renders the real retrieved citations.
- **`entryId` playback needs the Kaltura player.** `video-gallery` preserves `entryId`. When `embedUrl` is present (it requires `partnerId`; `uiConfId` is optional and only pins a specific player uiConf), the SDK renders an inline player of the whole entry. It does not apply `startTime` or `endTime`; to play only the clip, seek in the host from the `'play'` action payload. Without `embedUrl`, the host renders by `entryId`.

## Related docs

| Doc | Covers |
|---|---|
| [GenUI · Per-Runtime Widget Detail](/reference/genui/widgets/) | Per-runtime model keys, constraints, and descriptor shapes |
| [GenUI · Authoring and Consuming Widgets](/reference/genui/authoring-and-consuming/) | Capability gating and `ExperienceRenderer`/`mountWidget` consumption |
| [GenUI Reference](/reference/genui-reference/) | Back to the index |

