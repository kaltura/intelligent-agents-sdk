---
layout: base.njk
title: "API · Build · Tools and Secrets"
description: "The api/csv/code/client tool types and their CRUD, plus how intellect secrets work."
eyebrow: Reference
---

# Tools and Secrets

[← Back to Phase 2 — Build](/reference/api/build/)

**On this page:** [Tools (api / csv / code)](#tools-api--csv--code) · [Secrets (write-only)](#secrets-write-only) · [Related docs](#related-docs)


## Tools (api / csv / code)

Tools are a standalone, PARTNER-LEVEL entity with their own CRUD (`/v1/tool/add|get|list|update|delete`, Genie host) — **not** embedded in an intellect. An intellect only carries the `tool_ids` (an array of tool uuid strings) it may call. **SDK:** `import { tools } from '@kaltura/intelligent-agents/management'` builds and validates a tool's `config` before any network call; `mgmt.tools` is the CRUD surface; `mgmt.intellectConfig.setToolIds` (or `tool_ids` passed straight to `intellects.create`/`update`) links a tool to an intellect.

**`api` tool** — calls an external HTTP endpoint. `POST /v1/tool/add`:

```json
{
  "name": "order_status",
  "config": {
    "type": "api",
    "description": "Look up an order by id",
    "args": { "order_id": { "prompt": "the order number", "type": "str", "required": true } },
    "request": {
      "url": "https://api.example.com/order",
      "method": "GET",
      "timeout": 10,
      "authentication": {
        "type": "oauth2",
        "client_id": "id",
        "client_secret": "secrets.OAUTH_CLIENT_SECRET",
        "token_url": "https://api.example.com/token"
      }
    },
    "response_mapping": { "status": "order.status" }
  }
}
```

Returns a `Tool` — `{id, name, config, partner_id, created_at, updated_at}`. Link its `id` into an intellect:

```json
{ "id": 42, "type": "internal", "status": 2, "tool_ids": ["<the returned id>"] }
```

sent to `POST /v1/intellect/update`.

`response_mapping`, `response_template`, and `response_chapters` are mutually exclusive. Reference secrets as `"secrets.NAME"` — never plaintext.

**Security note:** an `api` tool's `request` fires server-to-server, outside the SDK's reach. The model/system-prompt scoping that led to the call is not a security boundary — your endpoint must independently authenticate and authorize each request (validate the caller's Kaltura Session and permissions), the same way you would for any other server-to-server API call. Treat interpolated `request_vars` (client-suppliable when `allow_client_variables:true` — see [Converse](/reference/api/operate/#converse)) as untrusted input, never as an authorization claim.

**`csv` tool** — inline lookup table:

```json
{ "name": "tier_lookup", "config": { "type": "csv", "description": "Map account to tier", "csv": "account,tier\n42,gold" } }
```

**`code` tool** — Python in a server sandbox:

```json
{ "name": "fx_rate", "config": { "type": "code", "description": "Convert currency", "code": "def main(request_config):\n    return 'ok'" } }
```

**`client` tool** — a native function-calling tool that makes NO server-side call at all. The model calls it, the backend emits a silent `type:"tool"` segment (see [Wire Protocol](/reference/wire-protocol/)), and that's the entire contract — no `request` block, no echo endpoint, no response shaper:

```json
{
  "name": "navigate_to_slide",
  "config": {
    "type": "client",
    "description": "Navigate the on-screen deck. Call whenever the user asks about a topic the deck covers.",
    "args": { "slide_num": { "prompt": "The slide number to show (1-N).", "type": "int", "required": true } },
    "wait_for_response": false
  }
}
```

`wait_for_response` (SDK: `waitForResponse`) controls whether the model's turn blocks on a real client ACK. **Omitting it is not the same as `false`** — the backend's own wire default for an absent field is `true` (blocking); pass `false` explicitly for fire-and-forget dispatch. When `true`, the backend polls up to `timeout` seconds (default 30) for an ACK via `POST /assistant/tool_response` (SDK: `session.respondToTool(id, response)`).

**Client-tool gotcha** — a requirement that must be met at authoring time for ANY tool-referencing intellect (client, api, csv, or code): **`kaltura_genie_experiences` must be `'off'` at creation.** The experiences capability injects a system rule that out-competes custom tool calls. Set it to `'off'` when you call `intellect/add` — partner config is cached ~24 h server-side, so updating it later has no immediate effect.

Use `tools.client(...)` in the SDK, which validates the tool before any network call; `clientToolReadiness(body)` lints an intellect body's `tool_ids` + `capabilities` for this gotcha.

---

## Secrets (write-only)

`secrets` is a dict `{name: value}` on `config`. A read masks every value as `"***"`. A `"***"` value on update is preserved server-side — read-modify-write never clobbers a sibling. Reference as `"secrets.NAME"` in tool configs or `{{secrets.NAME}}` in prompts.

**SDK:** `mgmt.intellects.secrets.{listNames, has, set, delete, replaceAll, validate}`. `delete(configId, name, ks, confirm)` is permanent and requires `confirm = { confirmPermanent: true }`.

---

## Related docs

| Doc | What it adds |
|---|---|
| [API · Build · Create and Configure an Intellect](/reference/api/build/intellect/) | Where `tool_ids`/`secrets` are linked onto an intellect |
| [API · Phase 2 — Build](/reference/api/build/) | The Phase 2 — Build index |

