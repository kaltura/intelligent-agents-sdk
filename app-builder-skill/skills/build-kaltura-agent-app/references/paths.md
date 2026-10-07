# Paths

Read the docs pages first. Then adapt the example. Pages are under `https://kaltura.github.io/intelligent-agents-sdk`. Examples are under `node_modules/@kaltura/intelligent-agents/examples/`.

## A. Server agent

| Read | Why |
|---|---|
| `/getting-started/` | First agent end to end |
| `/reference/api/authentication/` | Tokens, regions |
| `/reference/api/build/` | Create the intellect, avatar and agent |
| `/reference/api/operate/` | Talk to the agent from code |

Example: `server-token.mjs`

## B. Chat widget

| Read | Why |
|---|---|
| `/guides/start-the-conversation/` | Opening a conversation |
| `/reference/sdk-reference/` | The chat session class (text only) |
| `/reference/api/deploy/` | Per-visitor tokens in the browser |
| `/reference/api/authentication/` | Tokens |

Example: none for chat. Build the token server from path A and the page from the SDK reference.

## C. Avatar

| Read | Why |
|---|---|
| `/guides/start-the-conversation/` | Opening a conversation |
| `/reference/sdk-reference/` | The avatar session class |
| `/guides/voice-input-modes/` | Open mic or push to talk |
| `/reference/api/deploy/` | Per-visitor tokens in the browser |

Example: `browser-experience.html`

## D. Deck presenter

| Read | Why |
|---|---|
| `/guides/client-commands/` | Tools the agent calls in the page |
| `/reference/api/build/tools-and-secrets/` | Client tools |
| `/reference/sdk-reference/` | The presenter plugin |

Example: `deck-presenter.html`

## Adding more

| Goal | Read |
|---|---|
| Knowledge from the user's documents | `/reference/api/build/knowledge-rag/` |
| Call the user's own API | `/guides/external-api-integrations/` |
| Forms and structured data | `/guides/structured-data-forms/` |
| Personalized greetings | `/guides/dynamic-data-injection/` |
| Widgets in the conversation | `/reference/genui-reference/` |
| Lifecycle actions and email | `/guides/lifecycle-recipes/` |
| Security review | `/reference/security/` |
