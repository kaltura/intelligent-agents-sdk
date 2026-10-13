[← Back to Agent Components](../build.md)

# Tools and Secrets

## Tools (api / csv / code / client / var)

Tools are a standalone entity scoped to your whole partner account, with their own CRUD API (`/v1/tool/add|get|list|update|delete`, conversation host). They are **not** embedded in an intellect. An intellect only carries the `tool_ids` (an array of tool uuid strings) it may call. The server reads them back as `{id, condition}` objects and accepts either form on write.

**SDK:**
- `import { tools } from '@kaltura/intelligent-agents/management'` builds and validates a tool's `config` before any network call.
- `mgmt.tools` is the CRUD surface.
- `mgmt.intellectConfig.setToolIds` (or `tool_ids` passed straight to `intellects.create`/`update`) links a tool to an intellect.

### `api` tool

Calls an external HTTP endpoint. Put `{arg_name}` in the url or body to send an arg. An arg that no placeholder uses is never sent, and `intellectConfig.audit` warns `tool_arg_unused`. `POST /v1/tool/add`:

```json
{
  "name": "order_status",
  "config": {
    "type": "api",
    "description": "Look up an order by id",
    "args": { "order_id": { "prompt": "the order number", "type": "str", "required": true } },
    "request": {
      "url": "https://api.example.com/order?id={order_id}",
      "method": "GET",
      "timeout": 10,
      "authentication": {
        "type": "oauth2",
        "client_id": "id",
        "client_secret": "secrets.OAUTH_CLIENT_SECRET",
        "token_url": "https://api.example.com/token",
        "auth_url": "https://api.example.com/authorize"
      }
    },
    "response_mapping": { "status": "order.status" }
  }
}
```

Returns a `Tool`: `{id, name, config, partner_id, created_at, updated_at}`. Link its `id` into an intellect:

```json
{ "id": 42, "type": "internal", "status": 2, "tool_ids": ["<the returned id>"] }
```

sent to `POST /v1/intellect/update`.

The `authentication` block supports the OAuth2 authorization-code flow only (the viewer gives consent). It takes `client_id`, `client_secret` (a `secrets.<name>` reference), `token_url` and `auth_url`, all required. There is no `flow` or `scopes` option. Providers that use the client-credentials flow (for example the Marketo REST API) do not fit this block.

`response_mapping`, `response_template`, and `response_chapters` are mutually exclusive. Reference secrets as `"secrets.NAME"`, never as plaintext.

**Fill the request from the model's args.** `{arg}` is replaced with the value the model passed for that arg. This table is the single home for the placeholder rules:

| Where | `{arg}` for a declared arg | Other brace text |
|---|---|---|
| `request.url` | Filled | `bad_placeholder` |
| String `request.body` | Filled | `bad_placeholder` |
| Object `request.body` | Filled in every string value, at any depth (nested objects and lists included) | An undeclared `{name}` is `bad_placeholder`, and the message names the path, for example `request.body.a.b[0]`. Other brace text is left alone |
| `request.headers` | Not filled. The literal text is sent | Sent as written |
| `request.params` | Accepted, but the server does not send them. Put query values in the url | None |

The builder check skips `{{ ... }}` and `{% ... %}` spans in the url and in a string body. The server renders a `{{ name }}` span in a body value, and an unknown name renders empty.

```js
tools.api({
  name: 'city_weather',
  description: 'Get the weather for a city.',
  args: { city: { prompt: 'City name', type: 'str', required: true } },
  request: { url: 'https://api.example.com/weather?city={city}', method: 'GET' },
  responseMapping: { temperature: 'main.temp' },
});
```

Brace text in a string `url` or `body` that is not a declared `{arg}` makes the call fail at run time, so `tools.api` rejects it. Percent-encode braces in the url, and pass a JSON body as an object, not a string.

What the builder rejects:

| Input | Code |
|---|---|
| An undeclared `{name}` in the url or body | `bad_placeholder` |
| A url that starts with a placeholder, such as `{base}/x`. The url must parse as http(s) first | `invalid_url` |
| A hyphen in a `responseMapping` path. Paths are dot-separated names or list indices, so `headers.X-Request-Id` fails. Map `headers` as a whole, or use `responseTemplate` | `bad_jsonpath` |

**Security note:** an `api` tool's `request` fires server-to-server, outside the SDK's reach. The model or system prompt that led to the call is not a security boundary. Your endpoint must independently authenticate and authorize each request (validate the caller's Kaltura Session and permissions), the same way you would for any other server-to-server API call. Treat interpolated `request_vars` (client-suppliable when `allow_client_variables:true`, see [Converse](../operate.md#converse)) as untrusted input, never as an authorization claim.

### `csv` tool

Inline lookup table:

```json
{ "name": "tier_lookup", "config": { "type": "csv", "description": "Map account to tier", "csv": "account,tier\n42,gold" } }
```

### `code` tool

Python that runs on the server. Define `def main(...)`. Each declared arg is passed to it by name, so the parameter names must match the `args` keys. Whatever `main` returns goes back to the model:

```json
{
  "name": "fx_rate",
  "config": {
    "type": "code",
    "description": "Convert an amount between currencies",
    "args": { "amount": { "type": "float", "prompt": "Amount to convert", "required": true } },
    "code": "def main(amount):\n    return {'usd': round(amount * 1.08, 2)}"
  }
}
```

**You cannot create `csv` or `code` tools yourself.** `POST /v1/tool/add` returns HTTP 403 for a `csv` or `code` config. So does `/v1/tool/update` when its `config` is a `csv` or `code` config. No account setting changes this. Contact Kaltura support to have one set up. `api`, `client` and `var` tools have no such limit.

| Call | Result |
|---|---|
| `add` with a `csv` or `code` config | 403, nothing is created |
| `update` with a `csv` or `code` config | 403, the tool is unchanged |
| `update` with only `name` (no `config`) | works |
| `get`, `list`, `delete` | work on any tool type |

SDK: `tools.csv(...)`/`tools.code(...)` still validate and build the config locally. The 403 comes back from `mgmt.tools.add`/`update` as a `KalturaError` with `code: 'forbidden'`.

### `client` tool

A native function-calling tool that makes no server-side call. The model calls it, the server emits a `type:"tool"` segment (see [WIRE-PROTOCOL.md](../../WIRE-PROTOCOL.md)), and that is the whole contract. There is no `request` block, no echo endpoint and no response shaper:

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

`wait_for_response` (SDK: `waitForResponse`) controls whether the model's turn blocks on a real acknowledgment (ACK) from the client. **Omitting it blocks, the same as `true`.** Pass `false` explicitly for fire-and-forget dispatch. When `true`, the turn waits up to `timeout` seconds (default 30) for an ACK via `POST /assistant/tool_response` (SDK: `session.respondToTool(id, response)`).

### `var` tool

Sets conversation variables. The model calls it, and each arg's value is stored under the arg's own name. It makes no network call, and an admin can create it.

```js
tools.var({
  name: 'set_plan',
  description: 'Record the plan the user says they are on.',
  args: { plan: { prompt: 'The plan name, lowercase', type: 'str', required: true } },
});
```

- The variable is available to [conditions](intellect.md#conditions) and prompts from the next turn of the same thread. It does not carry over to a new thread.
- `{{plan}}` in prompt text renders whether `allow_client_variables` is on or off.
- Each arg name must be an identifier. It cannot start with `sys__` or be `secrets`. At least one arg is required.
- `lintPrompts` and `intellects.setPrompts` flag an unknown `{{plan}}` as the warning `unknown_variable`, or as the error `client_variable_not_allowed` when the gate is off. Pass the arg names as `toolVars` to clear it. `intellectConfig.audit` passes the linked `var` tools' arg names itself, so it reports nothing.

```js
lintPrompts(blocks, { toolVars: ['plan'] });
```

### Tool `condition`

Every tool type takes an optional `condition`. The model is offered the tool only while it is true. See [Conditions](intellect.md#conditions).

### Client-tool gotcha

This requirement applies at authoring time to any tool-referencing intellect (client, api, csv, or code): **`kaltura_genie_experiences` must be `'off'` at creation.** With the experiences capability on, the model can skip your custom tool calls. Set it to `'off'` when you call `intellect/add`. Changing it later does not take effect right away: see [CLIENT-COMMANDS.md § Gotcha 2](../../CLIENT-COMMANDS.md#gotcha-2-set-capabilities-at-creation-not-after).

Use `tools.client(...)` in the SDK, which validates the tool before any network call; `clientToolReadiness(body)` lints an intellect body's `tool_ids` + `capabilities` for this gotcha.

---

## Secrets (write-only)

`secrets` is a dict `{name: value}` on `config`. A read masks every value as `"***"`. A `"***"` value on update is preserved, so a read-modify-write never overwrites a sibling. Reference as `"secrets.NAME"` in tool configs or `{{secrets.NAME}}` in prompts.

**SDK:** `mgmt.intellects.secrets.{listNames, has, set, delete, replaceAll, validate}`. `delete(configId, name, ks, confirm)` is permanent and requires `confirm = { confirmPermanent: true }`.

---

## Related docs

| Doc | What it adds |
|---|---|
| [`intellect.md`](intellect.md) | Where `tool_ids`/`secrets` are linked onto an intellect |
| [`../build.md`](../build.md) | The Agent Components index |
