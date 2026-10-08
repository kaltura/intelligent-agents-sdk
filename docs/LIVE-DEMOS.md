# Live demos

The `examples/` folder has four browser demos, four server scripts and an MCP server. They are not hosted. Run them from a clone of the repo. The browser demos and three of the scripts run against your own agent, so they need your partner id and admin secret. `genui-graded-question.mjs` and the MCP server need no credentials.

## Run a browser demo

The demos fetch `/appInit` from a small local server. `examples/dev-server.mjs` is that server. It keeps your admin secret on the server and never sends it to the browser.

```bash
export AGENTIC_PARTNER_ID=…
export AGENTIC_ADMIN_SECRET=…
node examples/dev-server.mjs
```

With an admin secret and no `AGENTIC_WIDGET_ID`, the server provisions a throwaway agent on start. To use an existing agent, set `AGENTIC_WIDGET_ID` instead. Then open a demo from the list below at `http://127.0.0.1:8091/examples/<file>.html`. The server listens on loopback only.

## Browser demos

| File | Shows |
|---|---|
| [browser-experience.html](../examples/browser-experience.html) | The smallest live avatar: type or speak, and watch transcript, disclosure, thinking and barge-in events |
| [deck-presenter.html](../examples/deck-presenter.html) | The avatar walking a slide deck with the `Presenter` helper |
| [chroma-key-avatar.html](../examples/chroma-key-avatar.html) | The avatar video chroma-keyed with `attachChromaKeyAvatar`, so it sits over your own page |
| [event-timing.html](../examples/event-timing.html) | Every SDK event with a timestamp since `connect()` |

## Server scripts

Set your credentials once for the scripts that need them:

```bash
export AGENTIC_PARTNER_ID=…
export AGENTIC_ADMIN_SECRET=…
```

| Run | Needs credentials | Shows |
|---|---|---|
| [`node examples/server-token.mjs "A friendly yoga receptionist"`](../examples/server-token.mjs) | Yes | Provision an agent from a one-line brief (the argument is optional), mint a conversation token and run a headless smoke test |
| [`node examples/request-vars-live-context.mjs`](../examples/request-vars-live-context.mjs) | Yes | Live app context sent to the agent as request variables |
| [`node examples/lifecycle-insights-and-email.mjs`](../examples/lifecycle-insights-and-email.mjs) | Yes | Summarize every conversation and email a human when the summary is ready. Set `DEMO_RECIPIENT_USER_ID` to choose the recipient |
| [`node examples/genui-graded-question.mjs`](../examples/genui-graded-question.mjs) | No | The `graded-question` GenUI widget, multiple-choice and free-text. It prints the widget descriptor and the `onAction('answer', ...)` payloads. No network and no browser |

## MCP server

```bash
node examples/mcp-live-showcase/server.mjs --port 8877
```

[mcp-live-showcase/server.mjs](../examples/mcp-live-showcase/server.mjs) is a reference MCP server with an open mount (`/mcp`) and an OAuth-protected mount (`/mcp/oauth`). It needs no credentials. The port defaults to 8877 and can also come from `PORT`. To try `mcp_servers` against a live agent, the backend must reach the server, so put it behind an HTTPS tunnel that forwards the `Host` header. See [MCP integrations](MCP-INTEGRATIONS.md).

Related: [Getting started](../GETTING-STARTED.md) and the [Presenter](../README.md#presenter) reference.
