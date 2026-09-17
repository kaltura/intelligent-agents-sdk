[← Back to GenUI Reference](../GENUI-REFERENCE.md)

# GenUI Safety & Restrictions

## Safety model (OWASP LLM05 — every widget passes through this)

`src/core/safety.js`:

- `safeText(s, max=2000)` — coerces to string, strips ASCII control chars (the C0 range `U+0000`-`U+001F` plus `U+007F` DEL), length-clamps.
- `safeUrl(url, {allow})` — returns the URL only if its scheme is allow-listed (default `https|http|mailto|tel`). It blocks `javascript:`, `data:`, `vbscript:`, and unknown schemes. A scheme-relative path (`/foo`, `foo/bar`) is allowed, but an **authority-relative URL (`//host`, `\\host`) is rejected** (open-redirect / embed-hijack vector). An absolute URL with embedded userinfo (`https://user:pass@host/...`) is also rejected (phishing / link-spoofing vector). `external-video` additionally requires an absolute http(s) URL.
- `renderSafeLink(info, opts)` — builds a real `<a>` via `createElement`, `textContent`, and a scheme-checked `href` (never `innerHTML`). Sets `target=_blank` and `rel=noopener noreferrer`. Returns `null` outside a browser or for an unsafe URL.
- `sanitizeJson(v)` — drops `__proto__`/`constructor`/`prototype` (used by `submitStructuredDataForm` and `setDynamicPrompt`). `clampInbound(s)` — inbound text clamp.
- No renderer emits HTML. The host renders the `{kind, data}` descriptor with `textContent` / DOM APIs. A `summary`'s markdown is the host's responsibility to sanitize.

## Restrictions & gotchas (read before you build)

- **Live socket rarely emits widgets** — `force_experience:'avatar_only'` is hardcoded on the avatar join (`wire.js`). Use the HTTP converse path for reliable widgets.
- **`force_experience` is a hint** — never assume the requested experience arrived; the renderer parses whatever shows up.
- **`followups-tool`, `flashcards-tool`, and `show-link-tool` have been exercised against real backend output**, end to end through `SegmentAssembler` → `ExperienceRenderer` → `mountWidget` → click → `KavaAnalytics.buttonClicked()` (see [analytics.md](analytics.md)). This includes the `followups-tool`/`show-link-tool` boundary flush, where a different runtime arriving mid-stream closes the prior widget correctly. The other six runtimes are implemented from the schema and have not yet been observed from the backend.
- **RAG-driven vs. config-driven emission is unverified.** Whether `video_gallery` / `external_video` / `show_link` fire from RAG hits or pure prompt tuning is **not documented**. The author-time lever is the capability and prompt, but the trigger is the brain's discretion.
- **Backend may add runtimes outside this set** — e.g. `gen-ui-composer-tool`, `gen-ui-components-tool`, `kaltura-video-player-tool`. They are NOT in `RUNTIMES`. The renderer routes them to `{kind:'unknown'}` and `onUnhandled` rather than faking a known kind.
- **`sources` needs a knowledge base to cite from** — ground a new agent via `knowledge.addRecord` and `knowledge_ids` (ungated; see API-REFERENCE.md § Ground the Agent). `sources` then renders the brain's real retrieved citations.
- **`entryId` playback needs the Kaltura player.** `video-gallery` preserves `entryId`. When `embedUrl` is present (it requires `partnerId`; `uiConfId` is optional and only pins a specific player uiConf), the SDK renders an inline player. Without it, the host renders by `entryId`.

## Related docs

| Doc | Covers |
|---|---|
| [widgets.md](widgets.md) | Per-runtime model keys, constraints, and descriptor shapes |
| [authoring-and-consuming.md](authoring-and-consuming.md) | Capability gating and `ExperienceRenderer`/`mountWidget` consumption |
| [../GENUI-REFERENCE.md](../GENUI-REFERENCE.md) | Back to the index |
