---
layout: base.njk
title: "API Reference"
description: "Index of every Kaltura Agentic Avatars API endpoint, split into focused pages by lifecycle phase, plus common errors and a quick reference."
eyebrow: Reference
---

# API Reference — Kaltura Agentic Avatars

Every endpoint, the full agent lifecycle, and a verified use-case catalog — copy-paste ready.
This page is the index; the reference itself lives in focused pages, one per lifecycle phase.

**New here?** Start with [Getting Started](/getting-started/). Runtime details live in [Platform Architecture](/explanation/architecture/). The zero-dependency SDK is in [SDK Reference](/reference/sdk-reference/).

**Credentials** — all examples need `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` ([Rich Media CMS → Settings → Integration Settings](https://kmc.kaltura.com/index.php/kmcng/settings/integrationSettings)). Set them in a local `.env` (copy `.env.example`) or pass inline. Never hardcode the secret.

Every endpoint is shown as a raw HTTP call plus its SDK wrapper. The SDK is what ships in
this repo — see [SDK Reference](/reference/sdk-reference/) for the full `Management` method list.

---

## Contents

| Page | Covers |
|------|--------|
| [Authentication & Services](/reference/api/authentication/) | KS types and minting, `userId` identity binding, the five services and their base URLs |
| [Phase 1 — Design](/reference/api/design/) | Browse the catalog, generate an agent profile, custom voice (clone), provider voice import, custom visual (portrait), end-to-end portrait recipe |
| [Phase 2 — Build](/reference/api/build/) | Intellects (create/configure/preview), tools, secrets, RAG grounding, avatars, agents, brain configuration |
| [Phase 3 — Deploy](/reference/api/deploy/) | Resolve a widget ID, initialize the browser runtime |
| [Phase 4 — Operate](/reference/api/operate/) | Converse, reserved `sys__*` variables, threads and history cost, feedback, usage analytics, knowledge search |
| [Scripted Video (STV)](/reference/api/scripted-video/) | Scripted-video-only sessions: auth, lifecycle, `say-audio` speech injection |
| [Management Operations](/reference/api/management-operations/) | CRUD endpoints for agents, avatars, intellects, tools, skills, knowledge records |
| [Use-Case Catalog](/reference/use-cases/) | All 13 use cases (UC-1 through UC-13), each mapped to its key mechanism |

---

**What can you build?** A concierge with memory (UC-2/UC-3), a GenUI-driven product demo (UC-4),
a slide-deck walkthrough avatar (UC-10), a self-serve custom-voice/custom-portrait agent
(UC-9/UC-13), an anonymous embeddable widget (UC-12), or a fleet of A/B-tested personas (UC-5) —
see the full [Use-Case Catalog](/reference/use-cases/) for all 13, each mapped to its key mechanism
and a runnable script/tool.

---

## Common errors

| Status | Code / Detail | Fix |
|--------|--------------|-----|
| 400 | `bad_request` | Malformed JSON or missing field |
| 403 | Forbidden | Wrong KS type — admin KS for management, `geniegpcid` for conversations |
| 400 | `AGENT_NOT_FOUND` | Check the `agentId` |
| 400 | `AGENT_PARTNER_CONFIG_NOT_FOUND` | Create the intellect first |
| 405 | Method Not Allowed | Use `GET` for `/assistant/status`; everything else is `POST` |

---

## Quick reference

<div data-nova-target="api-reference-quickref" data-nova-label="Quick Reference example">

The full `Management` method surface (this reference's endpoints, wrapped) is listed in
[SDK Reference](/reference/sdk-reference/) → Management. Two common lookups:

```js
import { Management } from '@kaltura/intelligent-agents/management';
const mgmt = new Management({ partnerId, adminSecret });
const ks = await mgmt.sessions.createAdminToken();

console.log(await mgmt.agents.list(ks).all());
console.log(await mgmt.intellects.list(ks).all());
```

</div>

---

## Related docs

| Doc | What it adds |
|-----|---------------|
| [Getting Started](/getting-started/) | First working agent in about five minutes |
| [Platform Architecture](/explanation/architecture/) | How these endpoints fit into the backend services and runtime protocol as a whole |
| [SDK Reference](/reference/sdk-reference/) | The full `Management`/`Experience` method surface each endpoint wraps |
| [Use-Case Catalog](/reference/use-cases/) | All 13 use cases, each mapped to its key mechanism and a runnable script |
| [Security](/reference/security/) | The control matrix and KS-handling guidance behind [Authentication & Services](/reference/api/authentication/) |
