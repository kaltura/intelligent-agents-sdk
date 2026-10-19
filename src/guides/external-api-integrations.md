---
layout: base.njk
title: "External API Integrations"
description: "How to wire a Kaltura agent to call an external REST API, including the backend-verified OAuth2 flow for endpoints that require it."
eyebrow: How-to Guide
---

# External API Integrations

How to let a Kaltura agent call an external REST API: write a support ticket, update a booking system, look up inventory, capture a CRM lead, or call any other HTTP endpoint. Includes the OAuth2 flow for endpoints that need it.

Every integration is an `api` tool (`tools.api()`) that the model can call. The same three steps apply to a CRM, a support desk, a booking system or a MAM (media asset management) API.

To forward the *viewer's own submitted form data*, read [Structured Data Forms](/guides/structured-data-forms/) first. `session.submitStructuredDataForm()` alone does not give you durable, retrievable data. A tool call the model makes lands the data on infrastructure you control.

## The building blocks

An external API integration is a custom `api` tool linked to your intellect through `tool_ids`. Three steps, in this order:

1. **Store the credential as a secret.** `mgmt.intellects.secrets.set(configId, {NAME: value}, adminKs)`. Secrets are write-only. Every read masks values as `"***"`.
2. **Build and register the tool.** `tools.api({..., request: {..., headers: {Authorization: 'Bearer {{secrets.NAME}}'}}})`, then `mgmt.tools.add(tool, adminKs)`. A tool is its own partner-level entity, not part of the intellect.
3. **Link it.** `mgmt.intellectConfig.setToolIds(configId, [toolId], adminKs)`.

- **Secret references use one exact syntax.** Write `{{secrets.<name>}}` inside any string field of the `request` block. Do not write `{{variables.secrets.<name>}}`.
- **Validate after wiring.** `mgmt.intellectConfig.audit(configId, adminKs)` checks secret references in the linked tools, the prompts and the MCP server headers. It reports a missing secret as `secret_ref_unresolved`, the wrong prefix as `secret_ref_bad_prefix`, and an OAuth2 tool saved with the bare `secrets.NAME` as `secret_ref_bare`.

To run your own page-side JavaScript instead of a server-side HTTP call, use a `type: "client"` tool (`tools.client()`) and `session.onToolCall(name, handler)`. See [Client-Side Commands](/guides/client-commands/). Everything below assumes a server-side `api` tool.

## Authenticating the call

`tools.api()` supports two authentication shapes in its `request` block:

- **Static bearer token or API key.** A secret you mint once (a private-app token, a personal access token, a long-lived key), injected as a header. You own rotation.

  ```js
  request: { headers: { Authorization: 'Bearer {{secrets.API_TOKEN}}' } }
  ```
- **OAuth2 authorization-code flow.** For providers that need viewer consent and issue an expiring, refreshable token. See the next section.

## When you need OAuth2 (authorization-code flow)

The `authentication` block supports the authorization-code flow only. The viewer grants consent through an `auth_url` your app opens. Pass the block instead of a static bearer header. All four fields are required: `client_id`, `client_secret` (`{{secrets.NAME}}`), `token_url` and `auth_url`. There is no `flow` or `scopes` option.

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
      client_secret: '{{secrets.EXAMPLE_CLIENT_SECRET}}',
      token_url: 'https://auth.example.com/oauth/token',
      auth_url: 'https://auth.example.com/oauth/authorize',
    },
    body: { email: '{email}' },
  },
  responseMapping: { result: 'result' },
});
```

</div>

The SDK validates the block before any network call. `type` is optional, and must be `'oauth2'` if set. Unknown keys are rejected. `token_url` and `auth_url` must be http(s) URLs. `client_secret` must be `{{secrets.NAME}}`. A plaintext secret is rejected, so it never lands in a tool config.

What to build for:

- **First call, no token yet: handle the consent redirect.** The call comes back as an `interruption` stream segment (`metadata.subtype:"oauth_required"`) with an `auth_url`. Parse it with `parseOAuthRequired` or `session.onOAuthRequired`. See [Wire Protocol · Events Catalog](/reference/wire-protocol/events-catalog/#oauth-consent-redirect-interruption--subtypeoauth_required) for the shape. Open the URL in a new tab so the viewer can finish the provider's consent screen. MCP servers behind OAuth use the same mechanism: [MCP Integrations](/guides/mcp-integrations/#oauth-gated-servers).
- **After consent, later calls just work.** The viewer is not asked again.
- **Refresh is automatic.** An expired token is refreshed with no redirect. Only when the refresh fails does another `interruption` send the viewer back through consent. Do not assume a fixed validity window. Treat every call as one that can return a fresh `auth_url`.

With a static bearer token you own rotation but never show a consent link. With OAuth2 the platform handles consent and refresh, and your app must handle the `interruption` segment.

## Don't skip `kaltura_genie_experiences: 'off'`

Any intellect that references `tool_ids` (an external-API tool is no exception) must set `capabilities: {kaltura_genie_experiences: 'off'}` **at creation time**.

The default-on capability adds an experiences instruction. It competes with your tool for the same decision about what to do with a turn. `mgmt.tools.clientToolReadiness(body)` is a pure lint you can run over a create or update body. It warns when tools are referenced but the capability is not explicitly off. `intellects.create()` and `intellects.update()` run this lint and log its warnings.

Set the capability at creation. Flipping it on an existing intellect does not apply right away.

## Verifying the wiring

Run both checks after setup and before you rely on the integration:

- `mgmt.intellectConfig.audit(configId, adminKs)` flags missing secrets and the wrong prefix in tools, prompts and MCP headers.
- A live test conversation where you supply the field values yourself. Confirm the tool fires (`collectConverse(...).toolCalls` headless, or the `type:"tool"` segment on a live session) and that the target API shows the expected write. A tool config can validate and still fail at the HTTP layer: wrong URL, expired token, wrong field names.

## Example: CRM / marketing-automation integration

The SDK ships three builders for the common CRM writes. They are pure config builders. They make no network call and hold no secret value. Each throws a typed error for a missing `secretName` or `instanceUrl` before anything is written.

| Builder | CRM object | What the call does |
|---|---|---|
| `salesforceLeadUpsert` | Lead | Upsert on a key (default `Email`). `LastName` and `Company` are required. |
| `salesforceContactUpsert` | Contact | Upsert on a key (default `Email`). |
| `hubspotContactUpsert` | Contact | Create only. HubSpot rejects the call with a conflict if the email exists. |

| Your situation | Use |
|---|---|
| Visitor is a new prospect and sales works Leads | `salesforceLeadUpsert` |
| The person is already an account contact, or your org has no Lead workflow | `salesforceContactUpsert` |
| HubSpot | `hubspotContactUpsert`, new contacts only |

### HubSpot

`hubspotContactUpsert()` creates a contact with a HubSpot **private-app token** sent as a static bearer token. These tokens are long-lived, so no OAuth2 flow is needed. It is a create, not an upsert. Use it for new-lead capture, not to update a contact.

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

Every `propertiesToCapture` entry becomes a tool argument and a field in the request body. Only `email` is required. On success the tool returns `contact_id`.

### Salesforce

```js
import { salesforceLeadUpsert } from '@kaltura/intelligent-agents/management';

const tool = salesforceLeadUpsert({
  secretName: 'SF_TOKEN',
  instanceUrl: 'https://yourorg.my.salesforce.com',
});
await mgmt.intellects.secrets.set(configId, { SF_TOKEN: accessToken }, adminKs);
const { id } = await mgmt.tools.add(tool, adminKs);
await mgmt.intellectConfig.setToolIds(configId, [id], adminKs);
```

`instanceUrl` must be an `https:` origin with no path, query or credentials. The table lists the Lead defaults. `salesforceContactUpsert` takes `externalIdField` and `fieldsToCapture` (default `Email, FirstName, LastName`) and has no consent arg, `LeadSource` or `Description`.

| Item | Default | Option |
|---|---|---|
| Captured fields | `FirstName, LastName, Company, Email, Phone, Country` | `fieldsToCapture` (must keep `LastName`, `Company` and the key) |
| Upsert key | `Email` | `externalIdField` (a custom External ID field needs field access for the integration user) |
| `LeadSource` | `Web` | `leadSource` (must be a valid value in your org) |
| `Description` | `Captured by a Kaltura AI agent. Thread: <thread id>. Consent to be contacted: <answer>.` | not configurable |
| Consent | A required boolean `consent` arg. The agent calls the tool only after the visitor agrees. | `requireConsent: false` |
| API version | `v68.0` | `apiVersion` |

Salesforce has no standard Lead consent field, so consent is recorded in `Description`. `Country` takes the full name, such as `United States`. An org with country picklists rejects a code such as `US` with `FIELD_INTEGRITY_EXCEPTION`.

#### What the agent can say

The tool maps `result` (the record id) and `success`. The default description tells the agent what to say.

| Salesforce answer | Tool result | Agent says |
|---|---|---|
| `201` with an id (new record) | `success: true`, `result` is the id | Saved |
| `200` with an id (existing record) | `success: true`, `result` is the id | Saved |
| Any error status (missing field, invalid email, expired token, `300`) | No mapped values. The agent gets only the generic error line. | Could not save |

An empty result is never treated as saved. A custom `description` replaces the default guidance, so keep these rules in it.

If two or more Leads share the email, an `Email`-keyed upsert is ambiguous. Salesforce answers `300` and changes nothing. Merge or delete the duplicates.

Two argument rules apply to every `api` tool:

- Percent-encode any value you put in a URL (`@` as `%40`, `+` as `%2B`, `/` as `%2F`). The recipe prompts already tell the agent to do this for the upsert key.
- Mark an arg `required` when the call cannot work without it. The recipe prompts ask the agent to send an empty string for optional args. Do the same in your own tools. An arg sent without `required` is saved as required (`tools.get` shows `required: true`), so pass `required: false` for an optional one.

Placeholder rules for args: [Tools and Secrets](/reference/api/build/tools-and-secrets/#api-tool). Headers take `{{secrets.NAME}}` and request variables such as `{{ sys__thread_id }}`.

#### Access tokens

These builders use a static secret, not the OAuth2 block. A Salesforce access token expires, and after that Salesforce answers `401` and the agent reports a failed save. Pick one option:

| Option | How | Use when |
|---|---|---|
| **Customer endpoint (recommended)** | The agent calls your own HTTPS endpoint. It holds the Salesforce credentials, refreshes the token and does the upsert. The tool holds only a long-lived secret for your endpoint. | Production. Kaltura never holds a Salesforce token. |
| Scheduled refresh | Your server refreshes the token and calls `mgmt.intellects.secrets.set(...)` again before it expires. The SDK does not ship this job. | You want the agent to call Salesforce directly and can run the refresh well inside the token lifetime. |

The direct tools put the visitor's email into the request URL, and the visitor controls that text. Use them for a quick start and for dev orgs. In production, your endpoint validates and encodes the email before it calls Salesforce.

A customer endpoint is a plain `api` tool. It takes the fields as JSON and answers `200` with `{ "saved": true, "lead_id": "..." }` or `{ "saved": false }`. A `4xx` or `5xx` reaches the agent only as the generic error line, so use `200` with `saved: false` for failures the agent should handle:

```js
import { tools } from '@kaltura/intelligent-agents/management';

const tool = tools.api({
  name: 'save_lead',
  description: 'Save the visitor as a sales lead after they agree to be contacted. Say it is saved ONLY if the result has saved true. Otherwise say you could not save it.',
  args: {
    LastName: { type: 'str', prompt: 'Last name', required: true },
    Company: { type: 'str', prompt: 'Company', required: true },
    Email: { type: 'str', prompt: 'Email', required: true },
  },
  request: {
    url: 'https://your-server.example.com/leads',
    method: 'POST',
    headers: { Authorization: 'Bearer {{secrets.LEADS_ENDPOINT_TOKEN}}', 'Content-Type': 'application/json' },
    body: { LastName: '{LastName}', Company: '{Company}', Email: '{Email}', threadId: '{{ sys__thread_id }}' },
  },
  responseMapping: { saved: 'saved', lead_id: 'lead_id' },
});
```

Your endpoint must authenticate every request itself. See the security note in [Agent Components · Tools and Secrets](/reference/api/build/tools-and-secrets/).

### Marketo: two integration paths

- **Forms submission with no token (Munchkin).** Marketo's embeddable forms submit leads through a public POST endpoint tied to a Munchkin account ID. To capture a lead only, build a `client` tool (`tools.client()`). Your `session.onToolCall` handler does the `fetch()` to that endpoint. No secret is needed.
- **REST API (updating a lead, triggering a campaign).** Marketo uses a client-credentials token, which the `authentication` block does not support. Use one of these:
  - **Bearer secret.** Get a token from Marketo's `identity/oauth/token` endpoint, store it with `mgmt.intellects.secrets.set()`, and send `Authorization: 'Bearer {{secrets.MARKETO_TOKEN}}'` from an `api` tool. You refresh the secret before it expires.
  - **Client tool.** The handler in `session.onToolCall` calls your own server, which holds the Marketo credentials.

Use Munchkin to get a lead into Marketo with no secret management. Use the REST API when the model must do more than submit a form.

### Other targets

Each is a plain `api` tool with the same three steps:

- **Airtable.** A personal access token as a `Bearer` header. `POST` to `https://api.airtable.com/v0/{baseId}/{tableName}` with `body: {fields: {...}}`. Declare `baseId` and `tableName` as tool args, because the tool fills `{baseId}` and `{tableName}` in the url from declared args.
- **Google Sheets.** The Sheets API requires OAuth2. Viewer consent fits the `authentication` block. A service account does not.
- **Google Forms.** Forms has no lead-write REST endpoint. Use a `client` tool that opens a pre-filled Forms URL (`viewform?usp=pp_url&entry.<id>=<value>`) for the viewer. This is a UX handoff, not a server-side write.
- **Any other REST API.** A static secret in the `Authorization` header, or the OAuth2 block for the authorization-code flow.

## Related docs

| Doc | What it adds |
|---|---|
| [Structured Data Forms](/guides/structured-data-forms/) | Collecting the values you forward with these tools |
| [Dynamic Data Injection](/guides/dynamic-data-injection/) | Feeding data *into* the conversation, the opposite direction |
| [Client-Side Commands](/guides/client-commands/) | Driving your UI from the agent with a client-side tool |
| [MCP Integrations](/guides/mcp-integrations/) | Wiring a whole MCP server's tools at once |

