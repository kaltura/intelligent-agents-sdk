# API Reference — Kaltura Agentic Avatars

Every endpoint, the full agent lifecycle, and a verified use-case catalog — copy-paste ready. This page is the index; the reference itself lives in focused files under [`docs/api/`](docs/api/).

**New here?** Start with [GETTING-STARTED.md](GETTING-STARTED.md). Runtime details live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The zero-dependency SDK is in [`README.md`](README.md).

**Credentials** — all examples need `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` ([Rich Media CMS → Settings → Integration Settings](https://kmc.kaltura.com/index.php/kmcng/settings/integrationSettings)). Set them in a local `.env` file (create it in the repo root with `AGENTIC_PARTNER_ID=...` and `AGENTIC_ADMIN_SECRET=...` on their own lines, already covered by `.gitignore`) or pass inline. Never hardcode the secret.

Every endpoint is shown as a raw HTTP call plus its SDK wrapper. The SDK is what ships in this repo — see [`README.md`](README.md) for the full `Management` method list.

---

## Contents

| File | Covers |
|------|--------|
| [Authentication & Services](docs/api/authentication.md) | KS types and minting, `userId` binding, the five services and their base URLs |
| [Phase 1 — Design](docs/api/design.md) | Browse the catalog, generate an agent profile, custom voice (clone), provider voice import, custom visual (portrait), end-to-end portrait recipe |
| [Phase 2 — Build](docs/api/build.md) | Create/configure an intellect, preview a prompt, tools (`api`/`csv`/`code`), secrets, ground in your content (RAG), create an avatar, create an agent, brain-model/rate-limit fields |
| [Phase 3 — Deploy](docs/api/deploy.md) | Resolve widget ID, initialize the browser runtime |
| [Phase 4 — Operate](docs/api/operate.md) | Converse (headless HTTP), reserved `sys__*` template variables, status, threads, feedback and follow-ups, usage analytics, knowledge search (MCP) |
| [Scripted-Video (STV-only) Sessions](docs/api/scripted-video.md) | Pre-authored speech sessions — auth, lifecycle, `say-audio` |
| [Management Operations](docs/api/management-operations.md) | CRUD tables for agents, avatars, intellects, tools, skills, knowledge records |
| [Lifecycle](docs/lifecycle/README.md) | Event-driven rules — reference + [recipe](docs/lifecycle/recipes.md) |
| [Use-Case Catalog](docs/USE-CASES.md) | All 13 use cases (UC-1 through UC-13) mapped to mechanisms and runnable scripts |

**Section shorthand.** Docs and source comments cite sections as `API-REFERENCE.md § <name>` — find the section in the table above. Common ones: § Tools, § Secrets, § Ground the Agent, § Configure an Intellect are all in [Phase 2 — Build](docs/api/build.md); § Converse and § Threads are in [Phase 4 — Operate](docs/api/operate.md); § Initialize the Runtime is in [Phase 3 — Deploy](docs/api/deploy.md).

---

**What can you build?** A concierge with memory (UC-2/UC-3), a GenUI-driven product demo (UC-4), a slide-deck walkthrough avatar (UC-10), a self-serve custom-voice/custom-portrait agent (UC-9/UC-13), an anonymous embeddable widget (UC-12), or a fleet of A/B-tested personas (UC-5) — see the full [Use-Case Catalog](docs/USE-CASES.md) for all 13, each mapped to its key mechanism and a runnable script/tool.

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

<!-- nova-target: api-reference-quickref | Quick Reference example -->
The full `Management` method surface (this doc's endpoints, wrapped) is listed in [`README.md`](README.md) → Management. Two common lookups:

```js
import { Management } from '@kaltura/intelligent-agents/management';
const mgmt = new Management({ partnerId, adminSecret });
const ks = await mgmt.sessions.createAdminToken();

console.log(await mgmt.agents.list(ks).all());
console.log(await mgmt.intellects.list(ks).all());
```
<!-- /nova-target -->
