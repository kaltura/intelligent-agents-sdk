---
layout: base.njk
title: "External API Integrations"
description: "How to wire a Kaltura agent to call an external REST API, including the backend-verified OAuth2 flow for endpoints that require it."
eyebrow: How-to Guide
---

# External API Integrations

How to wire a Kaltura agent to call out to an external REST API: write a support ticket, update a booking system, look up inventory, upsert a CRM contact, or call anything else with an HTTP endpoint, including the OAuth2 flow for endpoints that require it.

This is a general integration mechanism: any `api` tool (`src/management/tools.js`'s `tools.api()`) the model can call, wired to whatever HTTP endpoint you point it at. CRM/marketing writes (HubSpot, Salesforce, Marketo) are one common use case, and get their own example section below. But the same three-step pattern applies equally to a support desk, a booking system, a MAM (media asset management) API, an inventory lookup, or any other REST integration.

If your use case is specifically getting the *viewer's own submitted data* (from a `user_properties_forms` prompt) onto external infrastructure, read [Structured Data Forms](/guides/structured-data-forms/) first. It explains why `session.submitStructuredDataForm()` alone does **not** get you durable, retrievable data with this toolkit's credentials. Everything here is the alternative: a **tool call** the model makes directly, landing on infrastructure you control.

## The building blocks

An external API integration is a custom `api` tool, linked to your intellect via `tool_ids`. Three pieces, always in this order:

1. **Store the credential as a secret.** `mgmt.intellects.secrets.set(configId, {NAME: value}, adminKs)` (`src/management/secrets.js`). Secrets are write-only: every read masks values as `"***"`, and there is no endpoint to read a plaintext value back.
2. **Build and register the tool** — `tools.api({..., request: {..., headers: {Authorization: 'Bearer {{secrets.NAME}}'}}})`, then `mgmt.tools.add(tool, adminKs)`. A tool is its own partner-level entity (`/v1/tool/*`), not embedded in the intellect.
3. **Link it** — `mgmt.intellectConfig.setToolIds(configId, [toolId], adminKs)`.

- **Secret references use one exact syntax.** Write `{{secrets.<name>}}` inside any string field of an `api` tool's `request` block. The reference is resolved when the tool runs. The OAuth2 `client_secret` uses the bare form `secrets.<name>` (see below).
- **A `{{variables.secrets.X}}` prefix is a silent no-op.** Only the bare `{{secrets.X}}` form resolves; the extra `variables.` prefix renders empty at runtime with no error.
- **Validate before you trust it.** Run `mgmt.intellects.secrets.validate(configId, adminKs)` after wiring a tool — it scans every tool/prompt for secret references and flags both the `badPrefix` mistake above and any reference to a secret name that doesn't exist yet.

If instead you want the model to trigger *your own page-side JS* rather than a server-side HTTP call — e.g. push data into a client SDK already loaded in the browser — use a `type: "client"` tool (`tools.client()`) and `session.onToolCall(name, handler)` instead. See [Client-Side Commands](/guides/client-commands/) for that path; everything below assumes a server-side `api` tool.

## Authenticating the call

Most external APIs need one of two authentication shapes, both supported directly by `tools.api()`'s `request` block:

- **Static bearer token / API key** — a secret you mint once (a private-app token, a personal access token, a long-lived API key) and inject as a header:

  ```js
  request: { headers: { Authorization: 'Bearer {{secrets.API_TOKEN}}' } }
  ```

  You own rotation for this credential — the platform doesn't refresh it.
- **OAuth2 authorization-code flow.** For providers that require viewer consent and issue an expiring, refreshable token. Covered in its own section below. It is more than a header.

## When you need OAuth2 (authorization-code flow)

The `authentication` block supports the OAuth2 authorization-code flow only. The viewer grants consent through an `auth_url` your app opens. The agent handles the resulting token. Pass the block instead of a static bearer header in an `api` tool's `request`. All four fields are required: `client_id`, `client_secret` (a `secrets.<name>` reference), `token_url` and `auth_url`. There is no `flow` or `scopes` option.

<div data-nova-target="external-api-oauth2-example" data-nova-label="Real OAuth2 authorization-code flow example">

```js
import { api } from '@kaltura/intelligent-agents/management';

const tool = api({
  name: 'update_crm_contact',
  description: "Update the user's contact record once you have their email.",
  args: { email: { type: 'str', prompt: "The user's email", required: true } },
  request: {
    url: 'https://api.example.com/v1/contacts',
    method: 'POST',
    authentication: {
      type: 'oauth2',
      client_id: 'YOUR_CLIENT_ID',
      client_secret: 'secrets.EXAMPLE_CLIENT_SECRET',
      token_url: 'https://auth.example.com/oauth/token',
      auth_url: 'https://auth.example.com/oauth/authorize',
    },
    body: { email: '{email}' },
  },
  responseMapping: { result: 'result' },
});
```

</div>

`buildAuth()` (`src/management/tools.js`) validates this block before any network call. `type` is optional. If you set it, it must be `'oauth2'`. `client_id`, `client_secret`, `token_url` and `auth_url` are required. Unknown keys are rejected. `token_url` and `auth_url` must be http(s) URLs. `client_secret` **must** be a `secrets.<name>` reference matching `/^secrets\.[A-Za-z_][A-Za-z0-9_]*$/`. A plaintext secret is rejected, so it can't end up in a tool config.

What to build for:

- **First call, no cached token: handle the consent redirect.** The call comes back as an `interruption` stream segment (`metadata.subtype:"oauth_required"`) carrying a real `auth_url` (built with `response_type=code&client_id=...&redirect_uri=...&state=...`) — see [Wire Protocol · Events Catalog § OAuth consent redirect](/reference/wire-protocol/events-catalog/#oauth-consent-redirect-interruption--subtypeoauth_required) for the exact shape and the SDK's `parseOAuthRequired`/`session.onOAuthRequired` convenience for parsing it. Your app must surface that URL to the viewer (open it in a new tab/window) so they can complete the provider's consent screen. An MCP server's own OAuth-gated tools use this identical mechanism — see [MCP Integrations § OAuth-gated servers](/guides/mcp-integrations/#oauth-gated-servers).
- **After consent, later calls just work.** Once the provider redirects back with a `code` and the viewer's consent completes, subsequent calls to the same tool succeed without asking the viewer to consent again.
- **Refresh is automatic.** A later call can reuse and refresh an expired token with no viewer interaction and no redirect. Only when that refresh itself fails do you see another `interruption`/`auth_url`, sending the viewer back through consent. Don't hardcode an assumed validity window for cached consent — treat every call as one that might come back with a fresh `auth_url` and handle that path.

Unlike a static-bearer-token tool (where *you* own token rotation), a tool wired through `authentication: {type: 'oauth2', ...}` gets consent and refresh handled by the platform. The tradeoff is the interruption/consent UX: your app has to handle the `interruption` segment and show the viewer a link. A static bearer token never requires that.

## Don't skip `kaltura_genie_experiences: 'off'`

Any intellect that references `tool_ids` (an external-API tool is no exception) should set `capabilities: {kaltura_genie_experiences: 'off'}` **at creation time**.

The default-on capability adds an experiences instruction that competes with your tool for the same "what do I do with this turn" decision. `mgmt.tools.clientToolReadiness(body)` (`src/management/tools.js`) is a pure lint you can run over your create/update body before sending it: it warns when tools are referenced but this capability isn't explicitly off. `intellects.create()` and `intellects.update()` already run this lint automatically and log its warnings.

Set the capability at **creation**. Partner-config changes can take up to ~24 h to apply, so flipping it on an existing intellect is not immediate.

## Verifying the wiring before you rely on it

Two read-only checks, both worth running after setup and before believing an integration works:

- `mgmt.intellects.secrets.validate(configId, adminKs)` — cross-checks every `{{secrets.X}}` reference in your tools/prompts against the secrets actually stored, flagging both an unresolved reference (typo'd or never set) and the non-resolving `{{variables.secrets.X}}` prefix mistake.
- A live test conversation where you supply the field values yourself and confirm the tool actually fires (via `collectConverse(...).toolCalls` headless, or watching the `type:"tool"` segment on a live socket session) and that the target API shows the expected write/read result. A tool config that validates structurally can still fail at the HTTP layer (wrong URL, expired token, wrong field names) — only a real call proves the end-to-end path.

## Example: CRM / marketing-automation integration

A CRM or marketing-automation write is a routine instance of the pattern above: the same secret → tool → link steps, pointed at a CRM's contact-upsert endpoint. The SDK ships three ready-made builders for the most common cases: HubSpot contact create, Salesforce Contact upsert and Salesforce Lead upsert. The walkthrough, the Contact-or-Lead table and the token options are in the README section [AI-SDR / CRM lead capture](https://github.com/kaltura/intelligent-agents-sdk/blob/main/README.md#ai-sdr--crm-lead-capture).

### HubSpot

`hubspotContactUpsert()` (`src/management/crm-recipes.js`) wraps HubSpot's Contacts v3 create endpoint (`POST /crm/v3/objects/contacts`) with a static bearer token (a HubSpot **private-app token**, not an OAuth2 flow — HubSpot's private-app tokens are long-lived and don't need refresh). Despite the name, this is a create, not a true upsert: HubSpot rejects the call with a conflict if a contact with the same email already exists. Use it for new-lead capture, not for updating an existing contact.

```js
import { hubspotContactUpsert } from '@kaltura/intelligent-agents/management';

await mgmt.intellects.secrets.set(configId, { HUBSPOT_TOKEN: process.env.HUBSPOT_TOKEN }, adminKs);

const tool = hubspotContactUpsert({
  secretName: 'HUBSPOT_TOKEN',
  propertiesToCapture: ['email', 'firstname', 'lastname'],
});
const { id } = await mgmt.tools.add(tool, adminKs);
await mgmt.intellectConfig.setToolIds(configId, [id], adminKs);
```

This is a pure config builder. No network call happens inside `hubspotContactUpsert()` itself; it just assembles and validates the `GenieToolConfig` that `mgmt.tools.add()` then registers. Every `propertiesToCapture` entry becomes both a tool argument (`{prompt: "Contact <prop>", type: 'str', required: prop === 'email'}`) and a field in the outgoing `properties` body. The model fills them from the conversation and calls the tool. The server executes the actual HTTP request.

### Salesforce

`salesforceContactUpsert()` and `salesforceLeadUpsert()` (same file) wrap Salesforce's REST `sobjects` upsert-by-external-ID endpoint (`PATCH {instanceUrl}/services/data/{version}/sobjects/{Contact|Lead}/{externalIdField}/{value}`), again using a static bearer token in the `Authorization` header:

```js
const contactTool = salesforceContactUpsert({
  secretName: 'SF_TOKEN',
  instanceUrl: 'https://yourorg.my.salesforce.com',
  externalIdField: 'Email',
  fieldsToCapture: ['Email', 'FirstName', 'LastName'],
});

// A Lead needs LastName and Company. LeadSource and Description are set by the builder.
const leadTool = salesforceLeadUpsert({
  secretName: 'SF_TOKEN',
  instanceUrl: 'https://yourorg.my.salesforce.com',
});
```

One real Salesforce quirk these builders account for: an upsert-by-external-ID `PATCH` returns `201 {id, success}` on insert, `200 {id, success}` on update and an error status on failure. Their `responseMapping` maps `result` and `success`. An error status never reaches the mapping: the agent gets a generic "API returned error status" line. The default description tells the agent to say "saved" only when `success` or an id is present, and to say it could not confirm the save when the result is empty or the call failed. The upsert key is part of the URL and an unencoded `@` there makes the call fail, so the key arg prompt tells the agent to pass the key percent-encoded (`@` as `%40`, `+` as `%2B`, `/` as `%2F`). An omitted optional arg is written as the text "None" and an empty string as blank, so the optional arg prompts ask for an empty string. The Lead builder also writes a fixed `LeadSource`, and a `Description` with the thread id and the visitor's consent answer.

**These builders authenticate with a static secret**, exactly like the HubSpot one. They do *not* use the OAuth2 `authentication` block described above. A Salesforce access token expires (the default org session timeout is 2 hours), so *you* must refresh it, or route the call through your own endpoint that holds the Salesforce credentials. The README section above compares both options. The direct tools also put the visitor's email in the request URL, so production setups should prefer the customer endpoint, which validates and encodes it. The platform won't refresh the token for you unless you use the OAuth2 `authentication` block (authorization-code flow only).

### Marketo — two valid integration paths

Marketo supports both connection models, and which one fits depends on how much you're allowed to ask of the visitor's session:

- **No-token forms submission (Munchkin).** Marketo's own embeddable JS forms submit leads through a public, unauthenticated POST endpoint tied to a Munchkin account ID. No admin REST API token is required. If you only need to capture a lead, not read or update arbitrary Marketo objects, build a `client` tool (`tools.client()`) that the model calls. Your page-side handler (`session.onToolCall`) does the actual `fetch()` to Marketo's forms endpoint, using the account's public Munchkin ID, the same mechanism Marketo's own `<script>`-embedded forms use. This needs no secret at all.
- **Full REST API access (leads.json, campaigns, etc.).** Anything beyond a simple form submission (updating an existing lead by email, triggering a campaign) goes through Marketo's REST API. It uses a client-credentials token. The `authentication` block above does **not** fit it, because that block supports the authorization-code flow only. Handle it like HubSpot and Salesforce above, with a static secret:
  - **Secret-backed bearer header.** Get a token from Marketo's `identity/oauth/token` endpoint yourself, store it with `mgmt.intellects.secrets.set()`, and reference it as `Authorization: 'Bearer {{secrets.MARKETO_TOKEN}}'` in an `api` tool. You refresh it and re-set the secret before it expires.
  - **Client tool.** Use a `client` tool (`tools.client()`) and have your handler in `session.onToolCall` call your own server, which holds the Marketo credentials and calls the REST API.

Use the Munchkin path when you just need "get this lead into Marketo" and want zero secret management. Use the REST API only when the model needs to do more than a one-shot form submission.

### Other DIY CRM/MAM/spreadsheet targets

None of these need a dedicated recipe — they're a plain `api` tool with a static bearer/API-key secret, following the exact same three-step pattern as HubSpot/Salesforce above:

- **Airtable** — a personal access token as a `Bearer` header, `POST` to `https://api.airtable.com/v0/{baseId}/{tableName}` with `body: {fields: {...}}`.
- **Google Sheets.** Google's Sheets API requires OAuth2. Viewer consent fits the `authentication: {type: 'oauth2', ...}` pattern above. A service account does not fit that block.
- **Google Forms (prefill-and-submit link).** Forms has no lead-write REST endpoint at all. The common workaround is a `client` tool that opens a pre-filled Forms URL (`viewform?usp=pp_url&entry.<id>=<value>`) for the viewer. That's a UX handoff, not a server-side write.
- **Any other REST API.** Same shape: static secret → `Authorization` header, or the OAuth2 block if the provider uses the authorization-code flow. This is exactly how you'd wire a MAM (media asset management) lookup, a support-ticketing system, a booking API, or anything else with an HTTP interface.

## Related docs

| Doc | What it adds |
|-----|---------------|
| [Structured Data Forms](/guides/structured-data-forms/) | Collecting the values this doc shows you how to forward durably |
| [Dynamic Data Injection](/guides/dynamic-data-injection/) | Feeding data *into* the conversation, the opposite direction from this doc |
| [Client-Side Commands](/guides/client-commands/) | The avatar-driving-your-UI channel — a client-side, not server-side, mechanism |
| [MCP Integrations](/guides/mcp-integrations/) | Wiring a whole MCP server's tool surface at once, instead of one REST endpoint at a time |

