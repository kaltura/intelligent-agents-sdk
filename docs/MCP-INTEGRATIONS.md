# MCP Integrations

How to wire a Kaltura agent to an [MCP](https://modelcontextprotocol.io) server. An MCP server exposes a set of tools over HTTP, so you do not write a custom `api` tool per operation.

This is the peer of [EXTERNAL-API-INTEGRATIONS.md](EXTERNAL-API-INTEGRATIONS.md). That doc wires one REST endpoint at a time via `tools.api()`. This doc wires a whole MCP server's tool surface at once via `intellectConfig.setMcpServers()`. The two compose: an intellect can carry both `tool_ids` and `mcp_servers`.

## The building block

```js
await mgmt.intellectConfig.setMcpServers(configId, {
  docs: { url: 'https://mcp.example.com/mcp' },
}, adminKs);
```

`setMcpServers` writes the intellect's `mcp_servers` map in one call. It is a WRITE and idempotent. Pass `{}` to clear every server. Each key is a server name of your choosing (letters, digits, `_` and `-`), used for [namespacing](#multiple-servers-no-collision-risk) below. Each value is an entry:

| Field | Required | Shape |
|---|---|---|
| `url` | Yes | `http(s)://…`, the server's MCP endpoint |
| `transport` | No | `'streamable_http'` (default) or `'sse'`. Use `streamable_http`. `sse` is for servers that have not upgraded |
| `headers` | No | `Record<string,string>`, sent on every call to this server. See [authenticating a server](#authenticating-a-server) below |
| `allowedTools` | No | `string[]`. The model sees only these tool names |
| `allowedPrompts` | No | `string[]`. The model cannot use prompts (see [current limits](#current-limits)) |
| `allowedResources` | No | `string[]`. Same limit as `allowedPrompts` |

To check what you wrote, call `intellectConfig.describe(configId, ks)` and read `editable.mcp_servers`. It reports `transport` and `hasHeaders: boolean` next to the real `allowedTools`, `allowedPrompts` and `allowedResources` arrays. Header values never come back, because they can carry a `{{secrets.X}}` template. Do not diff a raw `get` result against your input.

## Authenticating a server

A header value can reference a secret or a per-attendee request variable, like an `api` tool's `request.headers` (see [EXTERNAL-API-INTEGRATIONS.md § Authenticating the call](EXTERNAL-API-INTEGRATIONS.md#authenticating-the-call)).

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

`{{secrets.DOCS_MCP_TOKEN}}` is resolved when the call is made. The plaintext value never comes back to your app. Run `mgmt.intellects.secrets.validate(configId, adminKs)` after wiring headers. It scans tool, prompt, **and MCP server header** values for a reference to a secret name that does not exist. It also flags the `{{variables.secrets.X}}` prefix mistake. Only the bare `{{secrets.X}}` form resolves.

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

`{{CRM_TOKEN}}` is a bare request-var reference (no `secrets.` prefix). It takes its value from the session's `request_vars`, the same map that `session.updateRequestVars()` and the `requestVars` join option feed everywhere else in the SDK. It works the same in a text session (`KalturaChatSession`) and an avatar or voice session (`KalturaAvatarSession`).

This needs the intellect's `allow_client_variables` gate on. It is on by default. How to pin it, and what happens with it off: [api/operate.md § Converse](api/operate.md#converse).

Give each attendee their own KS bound to a real identity. Mint `createAgentToken({ agentId, userId })` on your server, call `appInit` with it, and send the returned KS to that attendee's browser (see [api/deploy.md § Per-visitor browser path](api/deploy.md#per-visitor-browser-path)). One real `userId` per attendee, not reused for anyone else, keeps each attendee's `{{CRM_TOKEN}}` isolated to them. A widget token is the same string for every visitor, so per-attendee credentials cannot work on the widget path.

## Multiple servers, no collision risk

The model calls every MCP tool as `<serverKey>__<toolName>`. A tool `search` on the `jira` server is `jira__search`. Two servers can each expose a tool with the same name:

```js
await mgmt.intellectConfig.setMcpServers(configId, {
  jira: { url: 'https://jira-mcp.example.com/mcp', headers: { Authorization: 'Bearer {{secrets.JIRA_TOKEN}}' } },
  linear: { url: 'https://linear-mcp.example.com/mcp', headers: { Authorization: 'Bearer {{secrets.LINEAR_TOKEN}}' } },
}, adminKs);
```

If both servers expose a `search` tool, the model reaches them as `jira__search` and `linear__search`.

Use the namespaced form (`<serverKey>__<toolName>`) wherever you tell the model how to call a tool: a prompt rule, a few-shot example, or troubleshooting a "tool not available" reply. `allowedTools` is the one exception. Pass the **bare** name there (`allowedTools: ['search']`).

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

The model sees only `search_issues` and `get_issue`. Every other tool the server advertises (for example `create_issue` or `delete_issue`) is hidden from it.

## OAuth-gated servers

An MCP server that requires end-user consent (DCR + PKCE) works like an `api` tool's OAuth2 flow. See [EXTERNAL-API-INTEGRATIONS.md § When you need OAuth2 (authorization-code flow)](EXTERNAL-API-INTEGRATIONS.md#when-you-need-oauth2-authorization-code-flow) for the full authorization-code and refresh lifecycle. In both cases, the first call with no cached consent comes back as a `type:"interruption"` segment with `metadata.subtype:"oauth_required"` and a consent-redirect `content.auth_url`. The wire shape is in [wire-protocol/events-catalog.md § OAuth consent redirect](wire-protocol/events-catalog.md#oauth-consent-redirect-interruption--subtypeoauth_required).

Parse it with `parseOAuthRequired(seg)`, or register `session.onOAuthRequired(handler)`. The handler is available on `KalturaAvatarSession`, `KalturaChatSession` and the `KalturaAgentSession` facade, with one shape for either transport:

```js
session.onOAuthRequired(({ authUrl, toolName, toolDisplayName }) => {
  // open authUrl for the viewer to complete consent, e.g. render it with the
  // show-link GenUI widget (see the events-catalog section above)
});
```

It works the same in a text and an avatar or voice session. Once the viewer completes consent, later calls to the same server succeed with no further redirect, until the access token expires. An MCP server's token is not refreshed in the background. Expiry raises a new `oauth_required` interruption with a full consent redirect. Keep `onOAuthRequired` registered for the life of the session, not just for the first call.

## Current limits

- **An unreachable or erroring server does not fail the conversation.** The agent proceeds without that server's tools. Check a server's health yourself with a plain HTTP check against its endpoint. A working conversation is not proof that a given server is reachable.
- **The model uses tools only.** It cannot invoke an MCP prompt or read an MCP resource, so `allowedPrompts` and `allowedResources` do not change what it can do.
- **Agents call MCP servers. The SDK cannot expose an agent as one.** No Management API publishes an agent or intellect as an MCP server. The one MCP endpoint the SDK documents is [knowledge search](api/operate.md#knowledge-search-mcp).

## Related docs

| Doc | What it adds |
|---|---|
| [EXTERNAL-API-INTEGRATIONS.md](EXTERNAL-API-INTEGRATIONS.md) | The single-REST-endpoint peer of this doc. Same secret and OAuth mechanisms, one tool at a time instead of a whole server |
| [wire-protocol/events-catalog.md](wire-protocol/events-catalog.md#oauth-consent-redirect-interruption--subtypeoauth_required) | The exact `interruption`/`oauth_required` wire shape this doc's OAuth section builds on |
| [genui/widgets.md](genui/widgets.md#6-show-link-rendershowlink-links) | The `show-link` widget, a default way to render an OAuth consent link |
