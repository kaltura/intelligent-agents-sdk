# Authentication & Services

[← Back to the API Reference index](../../API-REFERENCE.md)

## Authentication

Every call requires a Kaltura Session (KS) token in the `Authorization` header.

**Mint an admin KS:**

```bash
KS=$(curl -s -X POST "https://www.kaltura.com/api_v3/service/session/action/start" \
  -d "format=1" \
  -d "secret=$AGENTIC_ADMIN_SECRET" \
  -d "partnerId=$AGENTIC_PARTNER_ID" \
  -d "userId=admin@example.com" \
  -d "type=2" \
  -d "expiry=86400" \
  -d "privileges=disableentitlement" | tr -d '"')
```

**Pass it on every call:** `Authorization: KS <token>`

Every admin-type KS needs a `userId`: the person or service acting. The server makes it the owner of anything the token creates (entries, uploads), so a KS without one leaves that content with an empty owner. The SDK enforces this: `createAdminToken()` without a `userId` throws `bad_request` before any network call, and so do `createConversationToken()` and `createAgentToken()` with `sessionType: 'admin'`.

```js
const admin = await mgmt.sessions.createAdminToken({ userId: 'admin@example.com' });
```

| KS type | Session type | `privileges` | Use |
|---------|--------------|-------------|-----|
| Admin | 2 (admin) | `disableentitlement` | Management: create/update/delete (server-only) |
| Conversation | 0 (user) | `geniegpcid:<configId>,setrole:PLAYBACK_BASE_ROLE` | Talking to the AI. Entitlement ON |
| Agent | 0 (user) | `agentid:<agentId>,geniegpcid:<configId>,setrole:PLAYBACK_BASE_ROLE` | Talking as one agent. Entitlement ON |
| Widget | n/a | auto-derived from `widgetId` | End-user embed. No admin secret in the browser |

Conversation and agent tokens are **user sessions** by default. Pass `sessionType: 'admin'` to get an admin-level session (type 2, no forced role) instead. It reaches everything its `role` and privileges allow, so mint it on your server only. `restrictions.role` is only allowed with `sessionType: 'admin'`. A second `setrole`, `agentid` or `geniegpcid` in `extraPrivileges` throws `bad_request`. What each token kind can reach: [SECURITY.md § Session type](../../SECURITY.md#session-type).

### Conversation token or agent token?

Both mint the same kind of token: a user session (KS type 0, `setrole:PLAYBACK_BASE_ROLE`, entitlement ON). `userId`, `sessionType`, `ttlSeconds` and `restrictions` work the same on both. They differ in the id you start from.

| | `createConversationToken` | `createAgentToken` |
|---|---|---|
| You start from | `configId` (the intellect) | `agentId` |
| Token `kind` | `conversation` | `agent` |
| Required | `configId` | `agentId` |
| Optional | `agentId` | `configId` |
| Privileges | `geniegpcid:<configId>`, plus `agentid:<agentId>` if you pass `agentId` | `agentid:<agentId>` and `geniegpcid:<configId>` |
| `configId` missing | Throws `bad_request` | `Management` reads it from the agent on every mint: a 60 s admin token plus one `agents.get` call, no cache. Throws `intellect_not_found` if the agent has no numeric intellect id. A standalone `Sessions` can't look it up and mints `agentid` only, which answers with the default persona |
| `agentId` missing | Threads get `agent_id: "default"`. Lifecycle rules on `object.agent_id` never match them | Not possible |

`geniegpcid` picks the persona. `agentid` labels threads with the agent id, and `appInit` requires it. Pass both ids to either method and you get the same privileges.

**Which one do I use?** You have an `agentId`: `createAgentToken` (add `configId` to skip the lookup). You only have a `configId`, with no agent: `createConversationToken`.

`converse()` and `converseOnce()` mint a conversation token for you. Pass `{ agentId, userId }` to label the thread with the agent.

```js
import { Management } from '@kaltura/intelligent-agents/management';

const mgmt = new Management({ partnerId, adminSecret });
const agentToken = await mgmt.sessions.createAgentToken({ agentId: '1_abc123', userId: 'learner-123' });
```

Raw wire equivalent:

```bash
AGENT_KS=$(curl -s -X POST "https://www.kaltura.com/api_v3/service/session/action/start" \
  -d "format=1" -d "secret=$AGENTIC_ADMIN_SECRET" -d "partnerId=$AGENTIC_PARTNER_ID" \
  -d "userId=learner-123" -d "type=0" -d "expiry=1800" \
  -d "privileges=agentid:1_abc123,geniegpcid:1389,setrole:PLAYBACK_BASE_ROLE" | tr -d '"')
```

**Keep `disableentitlement` server-side, for management/admin operations only.** A minted `Token` records its kind, and the SDK rejects a token of the wrong kind before any network call. A raw KS string is encrypted and unreadable client-side, so the SDK passes it through and the server enforces its scope. Never hand an admin KS string to an end-user session. See [SECURITY.md](../../SECURITY.md#ks-kaltura-session-guidance-for-agents-ac-3--ac-6--ia-2) and Kaltura's own [KS/privilege reference](https://kaltura.md/KALTURA_SESSION_GUIDE/).

**Bind a session to a real end-user identity (`userId`).** The reserved `{{ sys__user_id }}` template variable (see § Converse) resolves to an empty string unless the KS carries a real identity.

Pass `userId` to bind the KS to a real end-user id. The value flows straight through to `session/start`'s own `userId` field, per-call only, never cached. It makes `sys__user_id` resolve server-side, lets converse-side memory/analytics attribute the turn to a real user, and gives that user their own threads:

```js
import { Management } from '@kaltura/intelligent-agents/management';

const mgmt = new Management({ partnerId, adminSecret });

const conv = await mgmt.sessions.createConversationToken({ configId, agentId, userId: 'learner-123' });
const reply = await mgmt.converseOnce(configId, 'What have we covered so far?', {}, conv);
```

Raw wire equivalent:

```bash
CONV_KS=$(curl -s -X POST "https://www.kaltura.com/api_v3/service/session/action/start" \
  -d "format=1" -d "secret=$AGENTIC_ADMIN_SECRET" -d "partnerId=$AGENTIC_PARTNER_ID" \
  -d "userId=learner-123" -d "type=0" -d "expiry=1800" \
  -d "privileges=geniegpcid:1389,setrole:PLAYBACK_BASE_ROLE" | tr -d '"')
```

Always pass a per-user `userId`.

`mgmt.converse(configId, ...)` and `mgmt.converseOnce(configId, msg, { agentId, userId })` pass `agentId` and `userId` to the token they mint for you.

**Widget tokens** (`createWidgetToken`) need no secret. Every visitor gets the same token. Reach and limits: [SECURITY.md § Session type](../../SECURITY.md#session-type). To separate users, use the [per-visitor path](deploy.md#per-visitor-browser-path).

**Revoke a token.** `mgmt.sessions.revoke(tokenOrKs)` ends the session (`session/end`). Tokens minted with the same `restrictions.sessionGroupId` are revoked together.

**Restrictions.** `restrictions` compiles to KS privileges: `ipRestrict`, `uriRestrict`, `sessionGroupId`, `role` (admin sessions only) and `actionsLimit`. `actionsLimit` is a positive integer. Use it only for sessions that run a known, fixed number of API actions. Each string value is one `key:value` privilege in a comma-separated list, so it must not contain a comma or whitespace (`bad_request`). `:` and `/` are fine inside a value, and so is a `*` wildcard where the privilege supports it.

---

## The Five Services

An agent is built from five services that layer on top of each other. All calls use `POST` with JSON (`GET /assistant/status` is the one exception).

| Service | Role | Base URL |
|---------|------|----------|
| **Catalog** | Preset visuals and voices — the wardrobe | `api.avatar.us.kaltura.ai/v1/catalog-item/` |
| **Avatar** | Pairs a face with a voice — the character | `api.avatar.us.kaltura.ai/v1/avatar/` |
| **Knowledge** | Indexed content for RAG — the reference library | `genie.nvp1.ovp.kaltura.com/v1/knowledge/` |
| **Intellect** | AI brain config (prompts, tools, capabilities) — the personality | `genie.nvp1.ovp.kaltura.com/v1/intellect/` |
| **Agent** | Combines Avatar + Intellect — the deployed actor | `api.avatar.us.kaltura.ai/v1/agent/` |

Once deployed, the **conversation surface** (`/assistant/converse`, `/v1/thread/`, `/mcp/`) lives on `genie.nvp1.ovp.kaltura.com`. Utility endpoints (`/application/`) for widget resolution and runtime init are on `api.avatar.us.kaltura.ai`.

To embed a live avatar in a browser, go to [Widget & Runtime Init](deploy.md#widget--runtime-init) or jump straight to [UC-12 Anonymous End-User Embed](../USE-CASES.md).
