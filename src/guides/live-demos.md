---
layout: base.njk
title: "Live Demos"
description: "The runnable browser demos and server scripts in the SDK examples folder, and how to start them against your own agent."
eyebrow: How-to Guide
---

# Live Demos

The `examples/` folder has four browser demos, four server scripts and an MCP server. They run on your machine against your own agent. They are not hosted.

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
| [browser-experience.html](https://github.com/kaltura/intelligent-agents-sdk/blob/main/examples/browser-experience.html) | The smallest live avatar: type or speak, and watch transcript, disclosure, thinking and barge-in events |
| [deck-presenter.html](https://github.com/kaltura/intelligent-agents-sdk/blob/main/examples/deck-presenter.html) | The avatar walking a slide deck with the `Presenter` helper |
| [chroma-key-avatar.html](https://github.com/kaltura/intelligent-agents-sdk/blob/main/examples/chroma-key-avatar.html) | The avatar video chroma-keyed with `attachChromaKeyAvatar`, so it sits over your own page |
| [event-timing.html](https://github.com/kaltura/intelligent-agents-sdk/blob/main/examples/event-timing.html) | Every SDK event with a timestamp since `connect()` |

## Server scripts

| File | Shows |
|---|---|
| [server-token.mjs](https://github.com/kaltura/intelligent-agents-sdk/blob/main/examples/server-token.mjs) | Provision an agent from a one-line brief, mint a conversation token and run a headless smoke test |
| [request-vars-live-context.mjs](https://github.com/kaltura/intelligent-agents-sdk/blob/main/examples/request-vars-live-context.mjs) | Live app context sent to the agent as request variables |
| [lifecycle-insights-and-email.mjs](https://github.com/kaltura/intelligent-agents-sdk/blob/main/examples/lifecycle-insights-and-email.mjs) | Summarize every conversation and email a human when the summary is ready |
| [genui-graded-question.mjs](https://github.com/kaltura/intelligent-agents-sdk/blob/main/examples/genui-graded-question.mjs) | The `graded-question` GenUI widget, multiple-choice and free-text |
| [mcp-live-showcase/server.mjs](https://github.com/kaltura/intelligent-agents-sdk/blob/main/examples/mcp-live-showcase/server.mjs) | A reference MCP server, open and OAuth-protected, to try `mcp_servers` against a live agent. See [MCP integrations](/guides/mcp-integrations/) |

Related: [Getting started](/getting-started/) and the [Presenter](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md#presenter) reference.

