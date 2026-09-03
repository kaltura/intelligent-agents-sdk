---
layout: base.njk
title: "API Reference"
description: "Index of every Kaltura Agentic Avatars API endpoint, split into focused pages by lifecycle phase, plus common errors and a quick reference."
eyebrow: Reference
---

# API Reference — Kaltura Agentic Avatars

Every endpoint, the full agent lifecycle, and a verified use-case catalog — copy-paste ready. This page is the index; the reference itself lives in focused files under [`docs/api/`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/docs/api/).

**On this page:** [Contents](#contents) · [Common Errors](#common-errors) · [Quick Reference](#quick-reference)

**New here?** Start with [Getting Started](/getting-started/). Runtime details live in [Platform Architecture](/explanation/architecture/). The zero-dependency SDK is in [`README.md`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md).

**Credentials** — all examples need `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` ([Rich Media CMS → Settings → Integration Settings](https://kmc.kaltura.com/index.php/kmcng/settings/integrationSettings)). Set them in a local `.env` file (create it in the repo root with `AGENTIC_PARTNER_ID=...` and `AGENTIC_ADMIN_SECRET=...` on their own lines, already covered by `.gitignore`) or pass inline. Never hardcode the secret.

Every endpoint is shown as a raw HTTP call plus its SDK wrapper. The SDK is what ships in this repo — see [`README.md`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md) for the full `Management` method list.

---

## Contents

| File | Covers |
|------|--------|
| [Authentication & Services](/reference/api/authentication/) | KS types and minting, `userId` binding, the five services and their base URLs |
| [Phase 1 — Design](/reference/api/design/) | Browse the catalog, generate an agent profile, custom voice (clone), provider voice import, custom visual (portrait), end-to-end portrait recipe |
| [Phase 2 — Build](/reference/api/build/) | Create/configure an intellect, preview a prompt, tools (`api`/`csv`/`code`), secrets, ground in your content (RAG), create an avatar, create an agent, brain-model/rate-limit fields |
| [Phase 3 — Deploy](/reference/api/deploy/) | Resolve widget ID, initialize the browser runtime |
| [Phase 4 — Operate](/reference/api/operate/) | Converse (headless HTTP), reserved `sys__*` template variables, status, threads, feedback and follow-ups, usage analytics, knowledge search (MCP) |
| [Scripted-Video (STV-only) Sessions](/reference/api/scripted-video/) | Pre-authored speech sessions — auth, lifecycle, `say-audio` |
| [Management Operations](/reference/api/management-operations/) | CRUD tables for agents, avatars, intellects, tools, skills, knowledge records |
| [Lifecycle](/reference/lifecycle/) | Event-driven rules — reference + [recipe](/guides/lifecycle-recipes/) |
| [Use-Case Catalog](/reference/use-cases/) | All 13 use cases (UC-1 through UC-13) mapped to mechanisms and runnable scripts |

**Section shorthand.** Docs and source comments cite sections as `API-REFERENCE.md § <name>` — find the section in the table above. Common ones: § Tools, § Secrets, § Ground the Agent, § Configure an Intellect are all in [Phase 2 — Build](/reference/api/build/); § Converse and § Threads are in [Phase 4 — Operate](/reference/api/operate/); § Initialize the Runtime is in [Phase 3 — Deploy](/reference/api/deploy/).

---

**What can you build?** A concierge with memory (UC-2/UC-3), a GenUI-driven product demo (UC-4), a slide-deck walkthrough avatar (UC-10), a self-serve custom-voice/custom-portrait agent (UC-9/UC-13), an anonymous embeddable widget (UC-12), or a fleet of A/B-tested personas (UC-5) — see the full [Use-Case Catalog](/reference/use-cases/) for all 13, each mapped to its key mechanism and a runnable script/tool.

---

## Common Errors

| Status | Code / Detail | Fix |
|--------|--------------|-----|
| 400 | `bad_request` | Malformed JSON or missing field |
| 403 | Forbidden | Wrong KS type — admin KS for management, `geniegpcid` for conversations |
| 400 | `AGENT_NOT_FOUND` | Check the `agentId` |
| 400 | `AGENT_PARTNER_CONFIG_NOT_FOUND` | Create the intellect first |
| 405 | Method Not Allowed | Use `GET` for `/assistant/status`; everything else is `POST` |

---

## Quick Reference

<div data-nova-target="api-reference-quickref" data-nova-label="Quick Reference example">

The full `Management` method surface (this doc's endpoints, wrapped) is listed in [`README.md`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md) → Management. Two common lookups:

```js
import { Management } from '@kaltura/intelligent-agents/management';
const mgmt = new Management({ partnerId, adminSecret });
const ks = await mgmt.sessions.createAdminToken();

console.log(await mgmt.agents.list(ks).all());
console.log(await mgmt.intellects.list(ks).all());
```

</div>

