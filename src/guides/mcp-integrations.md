---
layout: base.njk
title: "MCP Integrations"
description: "How to connect a Kaltura agent to an MCP server so it can use the server's whole tool set, with per-attendee credentials and request variables."
eyebrow: How-to Guide
---

# MCP Integrations

How to wire a Kaltura agent to an [MCP](https://modelcontextprotocol.io) server — a standard way to expose a set of tools (and, per the spec, prompts/resources) over HTTP, without writing a custom `api` tool per operation.

This is the peer of [External API Integrations](/guides/external-api-integrations/): that doc wires one REST endpoint at a time via `tools.api()`; this doc wires a whole MCP server's tool surface at once via `intellectConfig.setMcpServers()`. Read that doc first if you also need a single custom REST call — the two mechanisms compose (an intellect can carry both `tool_ids` and `mcp_servers`).

## The building block

```js
await mgmt.intellectConfig.setMcpServers(configId, {
  docs: { url: 'https://mcp.example.com/mcp' },
}, adminKs);
```

`setMcpServers` (`src/management/intellect-config.js`) writes the intellect's `mcp_servers` map in one call — WRITE, idempotent, no read-modify-write step needed. Pass `{}` to clear every server. Each key is a server name of your choosing (used for [namespacing](#multiple-servers-no-collision-risk) below); each value is an entry:

| Field | Required | Shape |
|---|---|---|
| `url` | Yes | `http(s)://…` — the server's MCP endpoint |
| `transport` | No | `'streamable_http'` (default) or `'sse'` — prefer `streamable_http`; `sse` is a legacy MCP transport the spec itself has moved past, kept only for servers that haven't upgraded |
| `headers` | No | `Record<string,string>` — sent on every call to this server; see [authenticating a server](#authenticating-a-server) below |
| `allowedTools` | No | `string[]` — restrict the model to only these tool names |
| `allowedPrompts` | No | `string[]`. Accepted and stored; the model cannot use them (see [current limits](#current-limits)) |
| `allowedResources` | No | `string[]` — same current limit as `allowedPrompts` |

`allowedTools` is enforced **pre-exposure**: a tool outside the list is never shown to the model, not filtered after the fact. So a restrictive `allowedTools` list is a real security boundary, not just a hint.

Reading a server back after writing it, its entry comes back normalized: expanded with `type:'mcp'` and a `transport` (defaulted to `'streamable_http'` if you didn't set one). The backend echoes `allowedTools`/`allowedPrompts`/`allowedResources` back as the real value you set; `headers` is the one field the SDK itself collapses to a boolean on read, so a header value (which can carry a `{{secrets.X}}` template) never round-trips back out through `describe()`. Don't diff a `get`/`describe()` result against your input byte-for-byte — check `intellectConfig.describe(configId, ks).editable.mcp_servers` instead, which reports `transport` plus `hasHeaders: boolean` alongside the real `allowedTools`/`allowedPrompts`/`allowedResources` arrays.

## Authenticating a server

A header value can reference a secret or a per-attendee request variable, exactly like an `api` tool's `request.headers` (see [External API Integrations § Authenticating the call](/guides/external-api-integrations/#authenticating-the-call)):

### One credential for every attendee

```js
await mgmt.intellects.secrets.set(configId, { DOCS_MCP_TOKEN: process.env.DOCS_MCP_TOKEN }, adminKs);

await mgmt.intellectConfig.setMcpServers(configId, {
  docs: {
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer {{secrets.DOCS_MCP_TOKEN}}' },
  },
}, adminKs);
```

`{{secrets.DOCS_MCP_TOKEN}}` resolves server-side at call time — the plaintext value never round-trips back to your app. Run `mgmt.intellects.secrets.validate(configId, adminKs)` after wiring headers: it scans tool, prompt, **and MCP server header** values for a reference to a secret name that doesn't exist, and for the non-resolving `{{variables.secrets.X}}` prefix mistake (only the bare `{{secrets.X}}` form resolves).

### A different credential per attendee

```js
await mgmt.intellectConfig.setMcpServers(configId, {
  crm: {
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer {{CRM_TOKEN}}' },
  },
}, adminKs);

// per attendee, at join time or mid-session:
session.updateRequestVars({ CRM_TOKEN: thisAttendeesToken });
```

`{{CRM_TOKEN}}` is a bare request-var reference (no `secrets.` prefix), resolved from the session's own `request_vars` map — the same map `session.updateRequestVars()`/the `requestVars` join option feed everywhere else in the SDK. This works identically in a text (`KalturaChatSession`) and an avatar/voice (`KalturaAvatarSession`) session — the templating happens the same way regardless of transport.

This needs the intellect's `allow_client_variables` gate ON, same as any other `request_vars` use. It is on by default. Pin it with `intellects.setClientVariablesEnabled(configId, true, adminKs)`. See [Dynamic Data Injection § The gate](/guides/dynamic-data-injection/#the-gate-allow_client_variables). With the gate off, `updateRequestVars()` is rejected wholesale and the turn comes back empty. There is no error, and no `CRM_TOKEN` value ever reaches the header.

Give each attendee their own KS bound to a real identity: mint `createAgentToken({ agentId, userId })` on your server, call `appInit` with it, and send the returned KS to that attendee's browser (see [Widget & Runtime Init § Per-visitor browser path](/reference/api/deploy/#per-visitor-browser-path)). One real `userId` per attendee, not reused for anyone else, keeps each attendee's `{{CRM_TOKEN}}` isolated to them. A widget token is the same string for every visitor, so per-attendee credentials can't work on the widget path.

## Multiple servers, no collision risk

Every tool a server exposes is renamed `<serverKey>__<toolName>` before the model ever sees it — `jira` mounting a `search` tool means the model calls `jira__search`, never bare `search`. This is why two servers can each expose a tool with the same name with no collision:

```js
await mgmt.intellectConfig.setMcpServers(configId, {
  jira: { url: 'https://jira-mcp.example.com/mcp', headers: { Authorization: 'Bearer {{secrets.JIRA_TOKEN}}' } },
  linear: { url: 'https://linear-mcp.example.com/mcp', headers: { Authorization: 'Bearer {{secrets.LINEAR_TOKEN}}' } },
}, adminKs);
```

If both servers expose a `search` tool, the model reaches them as `jira__search` and `linear__search` — there's no shared flat namespace where the second registration would shadow the first.

Anywhere you tell the model *how* to call a tool — a prompt rule, a few-shot example, troubleshooting a "tool not available" reply — use the namespaced form (`<serverKey>__<toolName>`), not the bare tool name the server itself advertises. `allowedTools` is the one exception: pass the **bare** name there (`allowedTools: ['search']`), since it's matched against each server's own tool list before namespacing is applied.

## Restricting a server's surface

```js
await mgmt.intellectConfig.setMcpServers(configId, {
  jira: {
    url: 'https://jira-mcp.example.com/mcp',
    headers: { Authorization: 'Bearer {{secrets.JIRA_TOKEN}}' },
    allowedTools: ['search_issues', 'get_issue'],
  },
}, adminKs);
```

Only `search_issues` and `get_issue` are ever shown to the model — every other tool the server advertises (e.g. a `create_issue` or `delete_issue`) is invisible, not merely blocked after being offered.

## OAuth-gated servers

An MCP server that requires end-user consent (DCR + PKCE) uses the exact same wire mechanism as an `api` tool's OAuth2 flow. See [External API Integrations § When you need OAuth2 (authorization-code flow)](/guides/external-api-integrations/#when-you-need-oauth2-authorization-code-flow) for the full authorization-code/refresh lifecycle. In both cases, the first call with no cached consent comes back as a `type:"interruption"` segment with `metadata.subtype:"oauth_required"` and a consent-redirect `content.auth_url`. This is documented in full in [Wire Protocol · Events Catalog § OAuth consent redirect](/reference/wire-protocol/events-catalog/#oauth-consent-redirect-interruption--subtypeoauth_required).

Parse it with `parseOAuthRequired(seg)`, or register `session.onOAuthRequired(handler)` — available on `KalturaAvatarSession`, `KalturaChatSession`, and the `KalturaAgentSession` facade, one handler shape for either transport:

```js
session.onOAuthRequired(({ authUrl, toolName, toolDisplayName }) => {
  // open authUrl for the viewer to complete consent — e.g. render it with the
  // show-link GenUI widget (see the events-catalog section above)
});
```

This works identically in a text and an avatar/voice session — same event, same handler, no mode-specific caveat. Once the viewer completes consent, later calls to the same server succeed with no further redirect — until the access token expires. Unlike an `api` tool's OAuth2 flow, an MCP server's token is never silently refreshed: expiry surfaces a brand-new `oauth_required` interruption (full consent redirect again), not a background refresh. Keep `onOAuthRequired` registered for the life of the session, not just for the first call.

## Current limits

- **Config changes are not always live on the next turn.** A change to a server's `headers` or allow-lists can take time to apply. Allow for that delay in any test or rollout you script.
- **An unreachable or erroring server doesn't fail the conversation.** The agent proceeds with that server's tools absent from the model's view. Check a server's health yourself (a plain HTTP check against its endpoint). A working conversation is not proof that a given server is reachable.
- **`allowedPrompts`/`allowedResources` have no effect.** They validate and store, but the model can only call tools. It cannot invoke a prompt or read a resource.
- **Only one `oauth_required` surfaces per turn.** If a turn touches several OAuth-gated servers with no cached consent, only the first one raises `oauth_required`. Resolve it and send another turn to trigger the next one.

## Related docs

| Doc | What it adds |
|---|---|
| [External API Integrations](/guides/external-api-integrations/) | The single-REST-endpoint peer of this doc — same secret/OAuth mechanisms, one tool at a time instead of a whole server |
| [Wire Protocol · Events Catalog](/reference/wire-protocol/events-catalog/#oauth-consent-redirect-interruption--subtypeoauth_required) | The exact `interruption`/`oauth_required` wire shape this doc's OAuth section builds on |
| [GenUI · Per-Runtime Widget Detail](/reference/genui/widgets/#6-show-link-rendershowlink--links) | The `show-link` widget, a reasonable default for rendering an OAuth consent link |

