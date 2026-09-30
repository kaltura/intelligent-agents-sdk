[← Back to Wire Protocol](../WIRE-PROTOCOL.md)

# 7. `clientConfiguration` fields (per-session agent config)

These flags shape runtime behavior:

| Field | Value | Meaning |
|---|---|---|
| `languageCode` | `"en"` | conversation language |
| `interruptionsEnabled` | `true` | barge-in allowed (user can talk over the avatar) |
| `isTapToTalk` | `false` | push-to-talk vs open-mic. A fixed, per-agent config choice, not a live per-session toggle. Exposed read-only via `KalturaAvatarSession#capabilities.tapToTalk`, and gates `startTapToTalk()`/`endTapToTalk()` client-side (see the `tapToTalkStart`/`tapToTalkEnd` row in the [events catalog](events-catalog.md) for why mixing modes is unsafe) |
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

> **Scope:** the structured-experience behavior below is what you get on the **HTTP `/assistant/converse`** path (headless/text integrations). The live avatar socket does not produce flashcards or summarization. See [Two delivery paths](../genui/model-and-runtimes.md#two-delivery-paths-this-is-the-1-gotcha).

`force_experience` on `converse` (e.g. `"flashcards"`) is a **hint, not a guarantee**. The brain decides which structured widget(s) to emit based on the prompt and the intellect (the agent's brain configuration — its prompts, tools, and capabilities). Each comes back as `unisphere-tool` segments. The first carries `metadata:{ widgetName, runtimeName }`, then the content streams as a YAML-ish block (e.g. `title:` / `questions:`). For example:

- `force_experience:"flashcards"` + a teachable prompt ("Teach me about video codecs") → **both** `flashcards-tool` and `followups-tool` runtimes in one turn (`widgetName:"unisphere.widget.genie"`).
- The same `force_experience` + a vague prompt ("show me something interesting") → **only** `followups-tool`.
- So: render whatever `runtimeName` arrives; don't assume `force_experience` maps 1:1 to a widget. `capabilities.generate_followup_questions:"on"` independently yields the `followups-tool`.

## Related docs

| Doc | Covers |
|---|---|
| [events-catalog.md](events-catalog.md) | The `join`/`clientConfiguration` events these fields ride on |
| [../WIRE-PROTOCOL.md](../WIRE-PROTOCOL.md) | Back to the index |
