---
layout: base.njk
title: "Build with Claude Code and other coding agents"
description: "Install the Kaltura App Builder plugin so Claude Code builds an app with Kaltura AI agents for you. Other coding agents can start from llms.txt."
eyebrow: How-to Guide
---

# Build with Claude Code and other coding agents

> **TL;DR:** Install the `kaltura-app-builder` plugin, open an empty folder in
> Claude Code, and say "Add a Kaltura avatar to my app." The plugin walks you
> through credentials, setup and a first run. It reads this site live, so it is
> always current.

## Install

In Claude Code, run:

```bash
/plugin marketplace add kaltura/intelligent-agents-sdk
/plugin install kaltura-app-builder@kaltura-agents
```

## What you need

- A Kaltura account with the Agentic Avatar feature enabled.
- Your Partner ID and Admin Secret. The plugin shows you where to find them.
- Node.js 18 or newer.

## Try it

Open an empty folder in Claude Code and say one of these:

- "Add a Kaltura avatar to my app."
- "Make a support chat widget for my site."
- "Build an avatar that walks visitors through my slide deck."
- "Teach yourself the Kaltura agents SDK so you can help me."

Claude checks your setup, asks one question to pick the right path, installs
the SDK, and builds from the official examples. You type the Admin Secret into
a `.env` file yourself. It never goes into the chat.

## What the plugin does

| It does | It does not |
|---|---|
| Reads [llms.txt](/llms.txt) and the pages you need, live | Copy API details that go out of date |
| Installs the SDK from the latest 1.x release | Keep its own copy of the code |
| Adapts the official examples to your app | Put your Admin Secret in browser code |

## Update or remove

```bash
/plugin marketplace update kaltura-agents
/plugin uninstall kaltura-app-builder@kaltura-agents
```

## Other coding agents

Cursor, Codex and other agents can use the same docs. Give the agent this
address and ask it to read the pages it needs before it writes code:

```text
https://kaltura.github.io/intelligent-agents-sdk/llms.txt
```

To get the code, run this in your project:

```bash
npm install "github:kaltura/intelligent-agents-sdk#semver:^1"
```

Then read [Getting Started](/getting-started/) for the first agent, or the
[SDK Reference](/reference/sdk-reference/) for every class and option.
