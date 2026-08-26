---
layout: base.njk
title: "API · Authentication & Services"
description: "KS types and minting, userId identity binding, and the five backend services with their base URLs."
eyebrow: Reference
---

[← API Reference index](/reference/api-reference/)

# Authentication

Every call requires a Kaltura Session (KS) token in the `Authorization` header.

**Mint an admin KS:**

```bash
KS=$(curl -s -X POST "https://www.kaltura.com/api_v3/service/session/action/start" \
  -d "format=1" \
  -d "secret=$AGENTIC_ADMIN_SECRET" \
  -d "partnerId=$AGENTIC_PARTNER_ID" \
  -d "type=2" \
  -d "expiry=86400" \
  -d "privileges=disableentitlement" | tr -d '"')
```

**Pass it on every call:** `Authorization: KS <token>`

| KS type | `privileges` | Use |
|---------|-------------|-----|
| Admin | `disableentitlement` | Management — create/update/delete (server-only) |
| Conversation | `geniegpcid:<configId>` | Talking to the AI — entitlement ON |
| Agent | `agentid:<agentId>` | Agent-scoped calls targeting a specific agent |
| Widget | auto-derived from `widgetId` | End-user embed — no admin secret in the browser |

**Keep `disableentitlement` server-side, for management/admin operations only.** The SDK can't detect or stop a `disableentitlement` KS from being handed to a conversation/end-user session — a real KS's privileges are encrypted and unreadable client-side — so nothing will warn you if you do this by mistake. See [Security](/reference/security/#ks-kaltura-session-guidance-for-agents-ac-3--ac-6--ia-2) and Kaltura's own [KS/privilege reference](https://kaltura.md/KALTURA_SESSION_GUIDE/).

**Bind a session to a real end-user identity (`userId`).** By default every minted KS is anonymous — the reserved `{{ sys__user_id }}` template variable (see [Converse](/reference/api/operate/#converse)) resolves to an empty string in every prompt/converse call. Pass `userId` to bind the KS to a real end-user id instead — the value flows straight through to `session/start`'s own `userId` field, per-call only (never cached), so it makes `sys__user_id` resolve server-side and lets converse-side memory/analytics attribute the turn to a real user:

```js
import { Management } from '@kaltura/intelligent-agents/management';

const mgmt = new Management({ partnerId, adminSecret });

// Any conversation/admin token can carry a real user identity.
const conv = await mgmt.sessions.createConversationToken({ configId, userId: 'learner-123' });
const reply = await mgmt.converseOnce(configId, 'What have we covered so far?', {}, conv);
```

Raw wire equivalent:

```bash
CONV_KS=$(curl -s -X POST "https://www.kaltura.com/api_v3/service/session/action/start" \
  -d "format=1" -d "secret=$AGENTIC_ADMIN_SECRET" -d "partnerId=$AGENTIC_PARTNER_ID" \
  -d "userId=learner-123" -d "type=2" -d "expiry=1800" \
  -d "privileges=geniegpcid:1389" | tr -d '"')
```

`userId` is optional on both `createAdminToken()` and `createConversationToken()` — omit it and behavior is unchanged (anonymous, exactly as before).

## The five services

An agent is built from five services that layer on top of each other. All calls use `POST` with JSON (`GET /assistant/status` is the one exception).

| Service | Role | Base URL |
|---------|------|----------|
| **Catalog** | Preset visuals and voices — the wardrobe | `api.avatar.us.kaltura.ai/v1/catalog-item/` |
| **Avatar** | Pairs a face with a voice — the character | `api.avatar.us.kaltura.ai/v1/avatar/` |
| **Knowledge** | Indexed content for RAG — the reference library | `genie.nvp1.ovp.kaltura.com/v1/knowledge/` |
| **Intellect** | AI brain config (prompts, tools, capabilities) — the personality | `genie.nvp1.ovp.kaltura.com/v1/intellect/` |
| **Agent** | Combines Avatar + Intellect — the deployed actor | `api.avatar.us.kaltura.ai/v1/agent/` |

Once deployed, the **conversation surface** (`/assistant/converse`, `/v1/thread/`, `/mcp/`) lives on `genie.nvp1.ovp.kaltura.com`. Utility endpoints (`/application/`) for widget resolution and runtime init are on `api.avatar.us.kaltura.ai`.

To embed a live avatar in a browser, go to [Phase 3 — Deploy](/reference/api/deploy/) or jump straight to [UC-12 Anonymous End-User Embed](/reference/use-cases/).

