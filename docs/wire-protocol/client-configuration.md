[← Back to Wire Protocol](../WIRE-PROTOCOL.md)

# 7. `clientConfiguration` fields (per-session agent config)

The server sends `clientConfiguration` once per connect. The SDK keeps it and exposes it read-only as `session.clientConfig`. These are the fields the SDK reads:

| Field | Example | What the SDK does with it |
|---|---|---|
| `isTapToTalk` | `false` | Push-to-talk vs open-mic, set per agent. Read as `capabilities.tapToTalk`. `setTapToTalkMode(enabled)` switches a live session and updates this value. `startTapToTalk()` throws `capability_disabled` when it is `false` (see the `tapToTalkStart`/`tapToTalkEnd` row in the [events catalog](events-catalog.md) for why mixing modes is unsafe). |
| `interruptionsEnabled` | `true` | Read as `capabilities.interruptions`. `false` means the user can't talk over the avatar. |
| `isWebSearchEnabled` | `false` | Read as `capabilities.webSearch`. Web-search tools produce `tool`/`tool_response` deltas only when it is `true`. When `false`, the agent can still say it will "look that up", but no `tool` segment fires. |
| `isScreenShareEnabled` | `false` | Read as `capabilities.screenShare`. `startScreenShare()` and `sendScreenShot()` throw `capability_disabled` when it is `false`. It becomes `true` when the agent's `screenShare` setting is on. |
| `isCameraAnalysisEnabled` | `false` | Read as `capabilities.cameraAnalysis`. |

The payload also carries `languageCode`, `showTranscription`, `audioMode`, `phoneMode`, `pauseConversationEnabled`, `shouldAggregateCurrentTurn`, `initialHtml`, `youtubeUrl`, `visualPhotos`, `visualVideos`, `agentPersonaName`, `userName`, `configuration` and `nluFeatures`. The SDK passes them through on `session.clientConfig` and does not act on them.

## Structured experiences (`force_experience` + `unisphere-tool`)

> **Scope:** the structured-experience behavior below is what you get on the **HTTP `/assistant/converse`** path (headless/text integrations). The live avatar socket does not produce flashcards or summarization. See [Two delivery paths](../genui/model-and-runtimes.md#two-delivery-paths-this-is-the-1-gotcha).

`force_experience` on `converse` (e.g. `"flashcards"`) is a **hint, not a guarantee**. The agent decides which structured widget(s) to emit based on the prompt and its intellect (the agent's configuration: prompts, tools and capabilities). Each comes back as `unisphere-tool` segments. The first carries `metadata:{ widgetName, runtimeName }`, then the content streams as a YAML body (e.g. `title:` / `questions:`), a subset that `parseContent` reads (see [model-and-runtimes.md](../genui/model-and-runtimes.md)). For example:

- `force_experience:"flashcards"` + a teachable prompt ("Teach me about video codecs") → **both** `flashcards-tool` and `followups-tool` runtimes in one turn (`widgetName:"unisphere.widget.genie-tools"`).
- The same `force_experience` + a vague prompt ("show me something interesting") → **only** `followups-tool`.
- So: render whatever `runtimeName` arrives; don't assume `force_experience` maps 1:1 to a widget. `capabilities.generate_followup_questions:"on"` independently yields the `followups-tool`.

## Related docs

| Doc | Covers |
|---|---|
| [events-catalog.md](events-catalog.md) | The `join`/`clientConfiguration` events these fields ride on |
| [../WIRE-PROTOCOL.md](../WIRE-PROTOCOL.md) | Back to the index |
