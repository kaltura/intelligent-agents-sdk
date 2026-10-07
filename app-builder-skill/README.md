# Kaltura App Builder (Claude Code plugin)

Helps Claude Code build apps with Kaltura AI agents and avatars. It reads the [official docs](https://kaltura.github.io/intelligent-agents-sdk/) live, so it does not go out of date.

## Install

```bash
/plugin marketplace add kaltura/intelligent-agents-sdk
/plugin install kaltura-app-builder@kaltura-agents
```

## Use

Open an empty folder in Claude Code and say: `Add a Kaltura avatar to my app.`

You need a Kaltura account, your Partner ID and your Admin Secret. The skill walks you through it.

## Update and remove

```bash
/plugin marketplace update kaltura-agents
/plugin uninstall kaltura-app-builder@kaltura-agents
```

## Other coding agents

Point them at `https://kaltura.github.io/intelligent-agents-sdk/llms.txt`.

## Maintainers

Run `node tools/check-docs.mjs`. See `AGENTS.md`.
