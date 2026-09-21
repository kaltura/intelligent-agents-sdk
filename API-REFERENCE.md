# API Reference — Kaltura Agentic Avatars

Every endpoint, the full agent lifecycle, and a verified use-case catalog — copy-paste ready. This page is the index; the reference itself lives in focused files under [`docs/api/`](docs/api/).

**New here?** Start with [GETTING-STARTED.md](GETTING-STARTED.md). Runtime details live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The zero-dependency SDK is in [`README.md`](README.md).

**Credentials** — all examples need `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` ([Rich Media CMS → Settings → Integration Settings](https://kmc.kaltura.com/index.php/kmcng/settings/integrationSettings)). Set them in a local `.env` file, or pass them inline. To use a `.env` file, create it in the repo root with `AGENTIC_PARTNER_ID=...` and `AGENTIC_ADMIN_SECRET=...` on their own lines — `.gitignore` already excludes it. Never hardcode the secret.

Every endpoint is shown as a raw HTTP call plus its SDK wrapper. The SDK is what ships in this repo — see [`README.md`](README.md) for the full `Management` method list.

---

## Contents

| File | Covers |
|------|--------|
| [Authentication & Services](docs/api/authentication.md) | KS types and minting, `userId` binding, the five services and their base URLs |
| [Catalog & Assets](docs/api/design.md) | Browse the catalog, custom voice (clone), provider voice import, custom visual (portrait, photo spec), custom face/background, end-to-end portrait recipe |
| [Agent Components](docs/api/build.md) | Generate an agent profile, create/configure an intellect, preview a prompt, tools (`api`/`csv`/`code`), secrets, ground in your content (RAG), create an avatar, create an agent |
| [Widget & Runtime Init](docs/api/deploy.md) | Resolve widget ID, initialize the browser runtime |
| [Conversation & Analytics](docs/api/operate.md) | Converse (headless HTTP), reserved `sys__*` template variables, status, threads, feedback and follow-ups, usage analytics, knowledge search (MCP) |
| [Scripted-Video (STV-only) Sessions](docs/api/scripted-video.md) | Pre-authored speech sessions — auth, lifecycle, `say-audio` |
| [Management Operations](docs/api/management-operations.md) | CRUD tables for agents, avatars, intellects, tools, skills, threads, messages/feedback/followups, knowledge records, lifecycle |
| [Lifecycle Rules](docs/lifecycle/README.md) | Event-driven rules + InsightSettings (reusable custom-insight definitions) + EmailTemplates (`sendInsightEmail`'s `templateId`) — reference + [recipe](docs/lifecycle/recipes.md) |
| [Use-Case Catalog](docs/USE-CASES.md) | All 13 use cases (UC-1 through UC-13) mapped to mechanisms and runnable scripts |
| [Site navigation](docs/SITE-NAV.md) | Fire-and-forget `go_to` tool, compact SITE MAP prompt, `sections.json` manifest, browser `SiteNavigator` plugin |

**Section shorthand.** Docs and source comments cite sections as `API-REFERENCE.md § <name>` — find the section in the table above. Common ones:

- § Tools, § Secrets, § Ground the Agent, § Configure an Intellect — [Agent Components](docs/api/build.md)
- § Converse, § Threads — [Conversation & Analytics](docs/api/operate.md)
- § Initialize the Runtime — [Widget & Runtime Init](docs/api/deploy.md)

---

**What can you build?** A few examples:

- A concierge with memory (UC-2/UC-3)
- A GenUI-driven product demo (UC-4)
- A slide-deck walkthrough avatar (UC-10)
- A self-serve custom-voice/custom-portrait agent (UC-9/UC-13)
- An anonymous embeddable widget (UC-12)
- A fleet of A/B-tested personas (UC-5)

See the full [Use-Case Catalog](docs/USE-CASES.md) for all 13, each mapped to its key mechanism and a runnable script/tool.

---

## Common Errors

The SDK wraps every error into a `KalturaError` with a stable `err.code`. Branch on that, not on prose or the raw upstream body.

| Status | `err.code` | Fix |
|--------|-----|-----|
| 400 | `bad_request` | Fix the request body |
| 403 | `forbidden` | Wrong KS type: admin KS for management, `geniegpcid` for conversations |
| 405 | `method_not_allowed` | Use `GET` for `/assistant/status`; everything else is `POST` |

Upstream error text is also normalized to a stable `err.code`, regardless of the HTTP status the backend returned it with:

| Upstream detail contains | `err.code` | Fix |
|---|-----|-----|
| `AGENT_NOT_FOUND` | `agent_not_found` | Check the `agentId` |
| `AGENT_PARTNER_CONFIG_NOT_FOUND` | `intellect_not_found` | Create the intellect first |

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
