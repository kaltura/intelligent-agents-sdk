# Changelog

All notable changes to `@kaltura/intelligent-agents` are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versioning
follows [Semantic Versioning](https://semver.org/).

## [1.0.0]

First public release. Zero-dependency JavaScript SDK for Kaltura conversational
avatar agents, with two entry points:

- `@kaltura/intelligent-agents/management` — provision, configure, and measure
  agents over the Agentic + Genie REST backends (sessions, agents, avatars,
  catalog, intellects, tools, skills, conversations, threads, messages,
  feedback, followups, knowledge).
- `@kaltura/intelligent-agents/experience` — the live socket + WHEP runtime
  (`KalturaAvatarSession`), plus optional plugin subpaths for the `Presenter`
  deck-walkthrough experience, GenUI widget rendering, analytics, and noise
  suppression.

See [README.md](README.md) for the full API surface and how-tos.
