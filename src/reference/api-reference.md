---
layout: base.njk
title: "Backend API Reference"
description: "Index of every Kaltura Agentic Avatars API endpoint, split into focused pages by lifecycle phase, plus common errors and a quick reference."
eyebrow: Reference
---

# Backend API Reference — Kaltura Agentic Avatars

Every endpoint, the full agent lifecycle, and a verified use-case catalog — copy-paste ready. This page is the index; the reference itself lives in focused files under [`docs/api/`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/docs/api/).

**New here?** Start with [Getting Started](/getting-started/). Runtime details live in [Platform Overview](/explanation/architecture/). The zero-dependency SDK is in [`README.md`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md).

**Credentials** — all examples need `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` ([Rich Media CMS → Settings → Integration Settings](https://kmc.kaltura.com/index.php/kmcng/settings/integrationSettings)). Set them in a local `.env` file, or pass them inline. To use a `.env` file, create it in the repo root with `AGENTIC_PARTNER_ID=...` and `AGENTIC_ADMIN_SECRET=...` on their own lines — `.gitignore` already excludes it. Never hardcode the secret.

Every endpoint is shown as a raw HTTP call plus its SDK wrapper. The SDK is what ships in this repo — see [`README.md`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md) for the full `Management` method list.

---

## Contents

| File | Covers |
|------|--------|
| [Authentication & Services](/reference/api/authentication/) | KS types and minting (`agentId`, `userId`, `sessionType`), `userId` binding, the five services and their base URLs, regions (`region`, `REGIONS`) |
| [Catalog & Assets](/reference/api/design/) | Browse the catalog, custom voice (clone), provider voice import, custom visual (portrait, photo spec), custom face/background, end-to-end portrait recipe |
| [Agent Components](/reference/api/build/) | Generate an agent profile, create/configure an intellect, preview a prompt, tools (`api`/`csv`/`code`), secrets, ground in your content (RAG), create an avatar, create an agent |
| [Widget & Runtime Init](/reference/api/deploy/) | Resolve widget ID, initialize the browser runtime |
| [Conversation & Analytics](/reference/api/operate/) | Converse (headless HTTP), reserved `sys__*` template variables, status, threads, feedback and follow-ups, usage analytics, knowledge search (MCP) |
| [Scripted-Video (STV-only) Sessions](https://github.com/kaltura/intelligent-agents-sdk/blob/main/docs/api/scripted-video.md) | Deprecated. Pre-authored speech sessions — auth, lifecycle, `say-audio` |
| [Management Operations](/reference/api/management-operations/) | CRUD tables for agents, avatars, intellects, tools, skills, threads, messages/feedback/followups, knowledge records, lifecycle |
| [Lifecycle Rules](/reference/lifecycle/) | Event-driven rules + InsightSettings (reusable custom-insight definitions) + EmailTemplates (`sendInsightEmail`'s `templateId`) — reference + [recipe](/guides/lifecycle-recipes/) |
| [External API Integrations](/guides/external-api-integrations/) | Wiring a brain-called tool to a durable write against your own external API (CRM, spreadsheet, ticketing), including the backend-managed OAuth2 flow |
| [MCP Integrations](/guides/mcp-integrations/) | Wiring a whole [MCP](https://modelcontextprotocol.io) server's tool surface at once — auth, multi-server namespacing, OAuth-gated servers |
| [Use-Case Catalog](/reference/use-cases/) | All 13 use cases (UC-1 through UC-13) mapped to mechanisms and runnable scripts |
| [Site navigation](/guides/site-navigation/) | Fire-and-forget `go_to` tool, compact SITE MAP prompt, `sections.json` manifest, browser `SiteNavigator` plugin |

**Section shorthand.** Docs and source comments cite sections as `API-REFERENCE.md § <name>` — find the section in the table above. Common ones:

- § Tools, § Secrets, § Ground the Agent, § Configure an Intellect — [Agent Components](/reference/api/build/)
- § Converse, § Threads — [Conversation & Analytics](/reference/api/operate/)
- § Initialize the Runtime — [Widget & Runtime Init](/reference/api/deploy/)

---

**What can you build?** A few examples:

- A concierge with memory (UC-2/UC-3)
- A GenUI-driven product demo (UC-4)
- A slide-deck walkthrough avatar (UC-10)
- A self-serve custom-voice/custom-portrait agent (UC-9/UC-13)
- An anonymous embeddable widget (UC-12)
- A fleet of A/B-tested personas (UC-5)

See the full [Use-Case Catalog](/reference/use-cases/) for all 13, each mapped to its key mechanism and a runnable script/tool.

---

## Common Errors

The SDK wraps every error into a `KalturaError` with a stable `err.code`. Branch on that, not on prose or the raw upstream body.

| Status | `err.code` | Fix |
|--------|-----|-----|
| 400 | `bad_request` | Fix the request body |
| 403 | `forbidden` | Wrong KS type: admin KS for management, `geniegpcid` for conversations. Also: a user session without `userId` on thread get, list or delete. A user session asking for another user's thread gets 404 instead. See [Security & Compliance § Session type](/reference/security/#session-type) |
| 405 | `method_not_allowed` | Use `GET` for `/assistant/status`; everything else is `POST` |

Upstream error text is also normalized to a stable `err.code`, regardless of the HTTP status the backend returned it with:

| Upstream detail contains | `err.code` | Fix |
|---|-----|-----|
| `AGENT_NOT_FOUND` | `agent_not_found` | Check the `agentId` |
| `AGENT_PARTNER_CONFIG_NOT_FOUND` | `intellect_not_found` | Create the intellect first |

### Response headers (debugging and log search)

The SDK keeps the tracing headers of every response: `x-*` (minus browser-hardening ones), `via`, `server`, `age`, `retry-after`, `traceparent`, `tracestate`. Names are lowercase. Values are redacted. Headers whose name suggests a credential (token, key, secret, auth, cookie, `ks`) and client-IP headers are dropped.

| Where | How |
|---|---|
| A failed call | `err.headers` (also in `err.toJSON()`). `undefined` when the response had none. |
| Every `Management` HTTP response, success or failure | `onResponse` hook on `new Management({ onResponse })`. |
| Every converse response | `onResponse` hook on `new KalturaChatSession({ onResponse })`. Tool-result posts are not reported. |
| Debug log | The `logger` receives a `⋯ <status> <path> headers` line. |

```js
const mgmt = new Management({
  partnerId, adminSecret,
  onResponse: ({ method, path, status, attempt, requestId, headers }) =>
    log.info({ method, path, status, attempt, requestId, headers }),
});

try { await mgmt.agents.get(agentId, ks); }
catch (err) { log.error({ code: err.code, requestId: err.requestId, headers: err.headers }); }
```

`onResponse` fires once per attempt, so a retried call shows every try. A hook that throws is ignored. `requestId` is the server's id when it sends one, else an id the SDK makes up (empty on streamed converse calls). Quote the header ids, not a made-up `requestId`, when you ask Kaltura support to trace a call.

In a browser, `fetch` only exposes the headers the server lists in `Access-Control-Expose-Headers`, so `headers` may be sparse there.

Base URL config errors are thrown before any request:

| `err.code` | Fix |
|---|-----|
| `region_unavailable` | The `region` does not offer that service. Pass its URL explicitly. See [Regions and base URLs](/reference/api/authentication/#regions-and-base-urls) |
| `insecure_transport` | Use an `https://` base URL |

---

## Quick Reference

<div data-nova-target="api-reference-quickref" data-nova-label="Quick Reference example">

The full `Management` method surface (this doc's endpoints, wrapped) is listed in [`README.md`](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md) → Management. Two common lookups:

```js
import { Management } from '@kaltura/intelligent-agents/management';
const mgmt = new Management({ partnerId, adminSecret });
const ks = await mgmt.sessions.createAdminToken({ userId: 'admin@example.com' });

console.log(await mgmt.agents.list(ks).all());
console.log(await mgmt.intellects.list(ks).all());
```

</div>

