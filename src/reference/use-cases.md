---
layout: base.njk
title: "Use-Case Catalog"
description: "A catalog of use cases for orienting a new integration, mapping each to its runnable script or SDK entry point."
eyebrow: Reference
---

# Use-Case Catalog

A "what can you build" catalog for orienting a new integration — read it once, then use
[API Reference](/reference/api-reference/) for the mechanism details behind each entry. Each use
case maps to a runnable script/example in this repo, or the equivalent SDK call. UC-1 has a
quickstart script; UC-7/12 use the browser example app; UC-13 is exercised by an integration test.

<div data-nova-target="use-case-catalog-table" data-nova-label="Use-Case Catalog: all 13 use cases mapped to SDK entry points">

| # | Use case | Key mechanism | Script / SDK entry point |
|---|----------|--------------|--------|
| UC-1 | **Agent Factory** | `generateAgentProfile` → `intellect/add` → configure → `avatar/create` → `agent/create` → `resolveWidgetId` | `node quickstart/create-agent.mjs "Your brief"` |
| UC-2 | **Personalized Concierge** | Prompts with `{{firstName}}`/`{{plan}}` + `allow_client_variables:true`; pass `request_vars` per message | `mgmt.converse(configId, msg, { request_vars })` |
| UC-3 | **Memory Chatbot** | First `converse` returns `threadId`; pass it back. `v1/thread/get_transcripts` for the full record | `mgmt.converse(...)` + `mgmt.threads.list`/`transcript` |
| UC-4 | **GenUI Experiences** | `force_experience` hint + `capabilities`; render `unisphere-tool` segments by `metadata.runtimeName` | `mgmt.converse(...)` + `./experience/genui` |
| UC-5 | **Avatar Fleet / A-B Personas** | `avatar/create` variants (reuse the same `voice.id`/`visual.id` to fork a persona), `agent/update avatarIds` to swap | `mgmt.avatars.create(...)` |
| UC-6 | **Quality / Feedback Loop** | Capture `messageId` from converse → `mgmt.feedback.add()` → `reportSummary` | `mgmt.feedback.add(...)` + `mgmt.messages.reportSummary(ks)` |
| UC-7 | **Interactive Video Avatar** | `resolveWidgetId` → widget KS → `appInit` → socket.io + WHEP runtime | `examples/browser-experience.html` |
| UC-8 | **Headless Streaming Text** | `assistant/converse` (`sse:true` or NDJSON); stream `type:"text"` chunks; persist `threadId` server-side | `mgmt.converse(...)` (or `mgmt.conversations.stream(opts, ks)` directly) |
| UC-9 | **Custom Voice Clone** | `catalog-item/create` (multipart, `~6 s+` audio) → `itemId` → `avatar/create voice.id` | `mgmt.catalog.createVoice(...)` |
| UC-10 | **Slide-Deck Walkthrough** | Deck talking points in prompts; deterministic `navigate_to_slide` client-command tool call for nav; optional GenUI widget via `show_widget` | `examples/deck-presenter.html` |
| UC-11 | **Usage Analytics** | Aggregated client-side; includes `_meta` provenance receipt | `mgmt.messages.reportSummary(ks)` |
| UC-12 | **Anonymous End-User Embed** | `resolveWidgetId` once (server) → `sessions.createWidgetToken` (browser, no secret) → `appInit` → enriched KS | `examples/browser-experience.html` |
| UC-13 | **Custom Portrait Avatar** | `catalog-item/create` with portrait JPEG → `catalogItemId` → `avatar/create visual.id` → `appInit` → `KalturaAvatarSession` connects with the portrait animating live | [§ End-to-end recipe](/reference/api/design/#end-to-end-custom-portrait-avatar-server-to-browser) + `test/integration/avatars-catalog.test.js` |

</div>

## Composition patterns

| Pattern | Built from |
|---------|-----------|
| Knowledge-grounded support bot | UC-3 + `capabilities.use_knowledge_base:on` + [§ Ground the Agent](/reference/api/build/#ground-the-agent-in-your-content-rag) |
| Multi-brand personas | UC-5 (voice) + UC-2 (`{{locale}}` var) |
| Lead-capture avatar | UC-7 + `user_properties_forms` |
| Scheduled / proactive avatar | UC-7 + your scheduler calls `speak()` on the socket |
