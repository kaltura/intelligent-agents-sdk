---
layout: base.njk
title: "Wire Protocol · Client Configuration"
description: "The clientConfiguration fields and structured experiences (force_experience + unisphere-tool)."
eyebrow: Reference
---

# clientConfiguration fields (per-session agent config)

[← Back to Wire Protocol](/reference/wire-protocol/)

**On this page:** [Structured experiences (`force_experience` + `unisphere-tool`)](#structured-experiences-force_experience--unisphere-tool) · [Related docs](#related-docs)


These flags shape runtime behavior:

| Field | Value | Meaning |
|---|---|---|
| `languageCode` | `"en"` | conversation language |
| `interruptionsEnabled` | `true` | barge-in allowed (user can talk over the avatar) |
| `isTapToTalk` | `false` | push-to-talk vs open-mic — a fixed, per-agent config choice (not a live per-session toggle); exposed read-only via `KalturaAvatarSession#capabilities.tapToTalk` and gates `startTapToTalk()`/`endTapToTalk()` client-side (see the `tapToTalkStart`/`tapToTalkEnd` row in the [events catalog](/reference/wire-protocol/events-catalog/) for why mixing modes is unsafe) |
| `showTranscription` | `false` | surface live captions in UI |
| `isWebSearchEnabled` | `false` | gates real web-search tools (→ `tool`/`tool_response` deltas). **When `false`, the agent can still *say* it will "look that up" but no `tool` segment fires** — the search doesn't happen. |
| `isScreenShareEnabled` / `isCameraAnalysisEnabled` | `false` | screen-share / camera-vision features |
| `audioMode` / `phoneMode` | `false` | audio-only / telephony modes |
| `pauseConversationEnabled` | `false` | can pause the conversation |
| `shouldAggregateCurrentTurn` | `false` | turn-aggregation behavior |
| `forwardLoopMode` / `imaginativeAiMode` | `false` | server-side conversation modes |
| `initialHtml`, `youtubeUrl`, `visualPhotos[]`, `visualVideos[]` | empty | initial GenUI content the agent ships with |
| `agentPersonaName`, `userName` | `null` | display names |
| `configuration`, `nluFeatures` | `{}` | extension buckets |

## Structured experiences (`force_experience` + `unisphere-tool`)

> **Scope:** the structured-experience behavior below applies to the **HTTP `/assistant/converse`** path (headless/text integrations). The **avatar runtime does not use it** — the session server's brain-bridge hardcodes `force_experience: 'avatar_only'` and `model_type: 'fast'`, so a live avatar session never emits flashcards/summarization widgets. Use the HTTP converse path (or a custom client) to drive structured experiences.

`force_experience` on `converse` (e.g. `"flashcards"`) is a **hint, not a guarantee** — the brain decides which structured widget(s) to emit based on the prompt + intellect. Each comes back as `unisphere-tool` segments: the first carries `metadata:{ widgetName, runtimeName }`, then the content streams (a YAML-ish block, e.g. `title:` / `questions:`). For example:

- `force_experience:"flashcards"` + a teachable prompt ("Teach me about video codecs") → **both** `flashcards-tool` and `followups-tool` runtimes in one turn (`widgetName:"unisphere.widget.genie"`).
- The same `force_experience` + a vague prompt ("show me something interesting") → **only** `followups-tool`.
- So: render whatever `runtimeName` arrives; don't assume `force_experience` maps 1:1 to a widget. `capabilities.generate_followup_questions:"on"` independently yields the `followups-tool`.

## Related docs

| Doc | Covers |
|---|---|
| [Wire Protocol · Events Catalog](/reference/wire-protocol/events-catalog/) | The `join`/`clientConfiguration` events these fields ride on |
| [Wire Protocol](/reference/wire-protocol/) | Back to the index |

