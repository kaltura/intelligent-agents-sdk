# Glossary

Short definitions of the terms the SDK docs use, and a table of which ID goes where.

## Terms

| Term | Meaning |
|---|---|
| Agent | The deployed actor. It combines one intellect with one or more avatars. Its id is `agentId` |
| Intellect | An agent's brain configuration: prompts, tools, capabilities and knowledge. Its id is `configId`. The API calls the same object a config |
| Brain | Informal word for what the intellect drives at runtime: the model that decides what the agent says and does. Docs use "brain" for the runtime and "intellect" for the configuration you edit |
| Avatar | The face and voice half of an agent. Its id is `avatarId` |
| Widget | A public, secret-free handle to one agent. Safe to ship in browser code. Its id is `widgetId` |
| Channel | One of the two live WebRTC connections of an avatar session: the microphone channel going up and the video channel coming down. See [Audio & Video Wiring](architecture-reference/channels.md) |
| Session | One live conversation between a user and an agent. The SDK has no separate "room" object. A session owns its channels |
| Thread | The stored history of a conversation. Its id is `threadId` |
| KS | Kaltura Session. The signed string that proves who is calling and what they may do. Every API call carries one. How to mint one: [Authentication](api/authentication.md#authentication) |
| Request variables | Values your app sends to the agent, read in prompts as `{{var}}`. See [Dynamic data injection](DYNAMIC-DATA-INJECTION.md) |

## Which ID where

| ID | Identifies | You get it from | You use it for |
|---|---|---|---|
| `configId` | The intellect (the brain) | `provision()`, or `intellects.create` | `converse()` and `converseOnce()`, `sessions.createConversationToken`, `intellectConfig` calls, `setForcedLanguage` |
| `agentId` | The agent | `provision()`, or `agents.create` | `sessions.createAgentToken`, `application.resolveWidgetId`, `agents.update`, labeling threads so [lifecycle rules](lifecycle/README.md#scoping-a-rule-to-one-agent) can match them, `setForcedLanguage` |
| `avatarId` | The avatar (a 24-character hex string) | `provision()`, or `avatars.create` | `avatarIds` when you create an agent, and `avatarSessions.create({ visualConfig: { id } })` for a brain-free avatar |
| `widgetId` | The public widget of one agent | `provision()`, or `application.resolveWidgetId(agentId, ks)` | `sessions.createWidgetToken({ widgetId })` for a browser embed with no secret |

`provision()` returns all four. Keep `configId` and `agentId` on your server. Hand the browser a token, or a `widgetId`, never an admin secret.
