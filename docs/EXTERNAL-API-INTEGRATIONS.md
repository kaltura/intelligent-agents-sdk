# External API Integrations

How to wire a Kaltura agent to call out to an external REST API — write a support ticket, update a booking system, look up inventory, upsert a CRM contact, or call anything else with an HTTP endpoint — including the real, backend-verified OAuth2 flow for endpoints that require it.

This is a general integration mechanism: any `api` tool (`src/management/tools.js`'s `tools.api()`) the model can call, wired to whatever HTTP endpoint you point it at. CRM/marketing writes (HubSpot, Salesforce, Marketo) are one common use case and get their own example section below, but the same three-step pattern applies equally to a support desk, a booking system, a MAM (media asset management) API, an inventory lookup, or any other REST integration.

If your use case is specifically getting the *viewer's own submitted data* (from a `user_properties_forms` prompt) onto external infrastructure, read [STRUCTURED-DATA-FORMS.md](STRUCTURED-DATA-FORMS.md) first — it explains why `session.submitStructuredDataForm()` alone does **not** get you durable, retrievable data with this toolkit's credentials, and everything here is the alternative: a **tool call** the model makes directly, landing on infrastructure you control.

## The building blocks

An external API integration is a custom `api` tool, linked to your intellect via `tool_ids`. Three pieces, always in this order:

1. **Store the credential as a secret** — `mgmt.intellects.secrets.set(configId, {NAME: value}, adminKs)` (`src/management/secrets.js`). Secrets are write-only: every read masks values as `"***"`, and there is no endpoint to read a plaintext value back — this is a genuine backend guarantee (server-encrypted at rest), not something the SDK layers on top.
2. **Build and register the tool** — `tools.api({..., request: {..., headers: {Authorization: 'Bearer {{secrets.NAME}}'}}})`, then `mgmt.tools.add(tool, adminKs)`. A tool is its own partner-level entity (`/v1/tool/*`), not embedded in the intellect.
3. **Link it** — `mgmt.intellectConfig.setToolIds(configId, [toolId], adminKs)`.

- **Secret references use one exact syntax.** Write `{{secrets.<name>}}` inside any string field of an `api` tool's `request` block — `buildAuth()` and every request field resolve this pattern server-side via Jinja-templating over `request_config.variables`.
- **A `{{variables.secrets.X}}` prefix is a silent no-op.** Only the bare `{{secrets.X}}` form resolves; the extra `variables.` prefix renders empty at runtime with no error — a real, discovered defect class to watch for.
- **Validate before you trust it.** Run `mgmt.intellects.secrets.validate(configId, adminKs)` after wiring a tool — it scans every tool/prompt for secret references and flags both the `badPrefix` mistake above and any reference to a secret name that doesn't exist yet.

If instead you want the model to trigger *your own page-side JS* rather than a server-side HTTP call — e.g. push data into a client SDK already loaded in the browser — use a `type: "client"` tool (`tools.client()`) and `session.onToolCall(name, handler)` instead. See [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md) for that path; everything below assumes a server-side `api` tool.

## Authenticating the call

Most external APIs need one of two authentication shapes, both supported directly by `tools.api()`'s `request` block:

- **Static bearer token / API key** — a secret you mint once (a private-app token, a personal access token, a long-lived API key) and inject as a header:

  ```js
  request: { headers: { Authorization: 'Bearer {{secrets.API_TOKEN}}' } }
  ```

  You own rotation for this credential — the platform doesn't refresh it.
- **OAuth2 authorization-code flow** — for providers that require viewer consent and issue an expiring, refreshable token. Covered in its own section below since it's a real, distinct backend-managed mechanism, not just a header.

## When you actually need OAuth2 — the real, backend-managed flow

If your target API requires a proper three-legged OAuth2 authorization-code flow (a viewer must grant consent; the resulting token expires and needs refreshing), the platform has that — it's implemented, real, and lives entirely on the backend. Pass an `authentication` block instead of a static bearer header in an `api` tool's `request`:

<!-- nova-target: external-api-oauth2-example | Real OAuth2 authorization-code flow example -->

```js
import { api } from '@kaltura/intelligent-agents/management';

const tool = api({
  name: 'update_marketo_lead',
  description: "Update the user's lead record in Marketo once you have their email.",
  args: { email: { type: 'str', prompt: "The user's email", required: true } },
  request: {
    url: 'https://123-ABC-456.mktorest.com/rest/v1/leads.json',
    method: 'POST',
    authentication: {
      type: 'oauth2',
      client_id: 'YOUR_MARKETO_CLIENT_ID',
      client_secret: 'secrets.MARKETO_CLIENT_SECRET',
      token_url: 'https://123-ABC-456.mktorest.com/identity/oauth/token',
      auth_url: 'https://123-ABC-456.mktorest.com/identity/oauth/authorize',
    },
    body: { action: 'updateOnly', input: [{ email: '{{args.email}}' }] },
  },
  responseMapping: { result: 'result' },
});
```
<!-- /nova-target -->

`buildAuth()` (`src/management/tools.js`) validates this block before any network call: `type` must be `'oauth2'` (the only scheme the backend supports today), and — the one hard rule — `client_secret` **must** be a `secrets.<name>` reference matching `/^secrets\.[A-Za-z_][A-Za-z0-9_]*$/`. A plaintext secret is rejected by construction, so there's no path for it to leak into a tool config at rest.

This is a genuine authorization-code exchange, not a pre-minted static token wearing an OAuth label. Here's what to build for and expect:

- **First call, no cached token: handle the consent redirect.** The backend raises an `OAuthRequiredException`, which the conversation layer turns into an `interruption` stream segment carrying a real `auth_url` — built with `response_type=code&client_id=...&redirect_uri=...&state=...`, where `state` is a sha256-derived value the backend verifies on callback. Your app must surface that URL to the viewer (open it in a new tab/window) so they can complete the provider's consent screen.
- **After consent: tokens are cached for you.** Once the provider redirects back with a `code`, the backend exchanges it for an access + refresh token pair and caches them in a server-side token cache keyed to the tool/intellect for **30 days** (`30 * 24 * 60 * 60` seconds).
- **Refresh is automatic.** On every subsequent call, if the cached access token is expired, the backend uses the `refresh_token` grant to get a new one — no viewer interaction, no redirect. Only if the refresh itself fails does it raise `OAuthRequiredException` again, sending the viewer back through consent.

Unlike a static-bearer-token tool (where *you* own token rotation), a tool wired through `authentication: {type: 'oauth2', ...}` gets consent and refresh handled for you by the platform. The tradeoff is the interruption/consent UX — your app has to handle the `interruption` segment and show the viewer a link, which a static bearer token never requires.

## Don't skip `kaltura_genie_experiences: 'off'`

Any intellect that references `tool_ids` (an external-API tool is no exception) should set `capabilities: {kaltura_genie_experiences: 'off'}` **at creation time**. `mgmt.tools.clientToolReadiness(body)` (`src/management/tools.js`) is a pure lint you can run over your create/update body before sending it: it warns when tools are referenced but this capability isn't explicitly off, because the default-on capability injects a "you MUST call `get_experience_instructions`" instruction that out-competes your tool for the same "what do I do with this turn" decision. `intellects.create()` and `intellects.update()` already run this lint automatically and log its warnings. But the fix (setting the capability) only takes effect immediately at **creation**. Flipping it on an existing intellect is defeated by the ~24h partner-config cache.

## Verifying the wiring before you rely on it

Two read-only checks, both worth running after setup and before believing an integration works:

- `mgmt.intellects.secrets.validate(configId, adminKs)` — cross-checks every `{{secrets.X}}` reference in your tools/prompts against the secrets actually stored, flagging both an unresolved reference (typo'd or never set) and the non-resolving `{{variables.secrets.X}}` prefix mistake.
- A live test conversation where you supply the field values yourself and confirm the tool actually fires (via `collectConverse(...).toolCalls` headless, or watching the `type:"tool"` segment on a live socket session) and that the target API shows the expected write/read result. A tool config that validates structurally can still fail at the HTTP layer (wrong URL, expired token, wrong field names) — only a real call proves the end-to-end path.

## Example: CRM / marketing-automation integration

A CRM or marketing-automation (MAM) write is a routine instance of the pattern above: the same secret → tool → link steps, pointed at a CRM's contact-upsert endpoint. The SDK ships two ready-made builders for the most common cases.

### HubSpot

`hubspotContactUpsert()` (`src/management/crm-recipes.js`) wraps HubSpot's Contacts v3 upsert endpoint (`POST /crm/v3/objects/contacts`) with a static bearer token (a HubSpot **private-app token**, not an OAuth2 flow — HubSpot's private-app tokens are long-lived and don't need refresh):

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

This is a pure config builder — no network call happens inside `hubspotContactUpsert()` itself; it just assembles and validates the `GenieToolConfig` that `mgmt.tools.add()` then registers. Every `propertiesToCapture` entry becomes both a tool argument (`{prompt: "Contact <prop>", type: 'str', required: prop === 'email'}`) and a field in the outgoing `properties` body — the model fills them from the conversation and calls the tool; the server executes the actual HTTP request.

### Salesforce

`salesforceContactUpsert()` (same file) wraps Salesforce's REST `sobjects` upsert-by-external-ID endpoint (`PATCH {instanceUrl}/services/data/v59.0/sobjects/Contact/{externalIdField}/{value}`), again using a static bearer token in the `Authorization` header:

```js
const tool = salesforceContactUpsert({
  secretName: 'SF_TOKEN',
  instanceUrl: 'https://yourorg.my.salesforce.com',
  externalIdField: 'Email',
  fieldsToCapture: ['Email', 'FirstName', 'LastName'],
});
```

One real Salesforce quirk this builder accounts for: an upsert-by-external-ID `PATCH` returns `201 {id: ...}` on insert but `204` with an **empty body** on update — there's no field guaranteed present on both, so its `responseMapping` only maps `result: 'id'` (present when it exists) rather than assuming a shape that breaks on the update path. The point of this tool is the side effect (the contact write), not what it echoes back.

**This builder authenticates with a static secret**, exactly like the HubSpot one — it does *not* use the OAuth2 `authentication` block described above. That's fine for a Salesforce Connected App access token you mint and rotate yourself, but it does mean *you* are responsible for refreshing that token before it expires; the platform won't refresh it for you unless you route through the real OAuth2 flow instead.

### Marketo — two valid integration paths

Marketo supports both connection models, and which one fits depends on how much you're allowed to ask of the visitor's session:

- **No-token forms submission (Munchkin).** Marketo's own embeddable JS forms submit leads through a public, unauthenticated POST endpoint tied to a Munchkin account ID — no admin REST API token required. If you only need to capture a lead (not read/update arbitrary Marketo objects), you can build a `client` tool (`tools.client()`) that the model calls, with your page-side handler (`session.onToolCall`) doing the actual `fetch()` to Marketo's forms endpoint using the account's public Munchkin ID — the same mechanism Marketo's own `<script>`-embedded forms use. This needs no secret at all.
- **Full REST API access (leads.json, campaigns, etc.).** Anything beyond a simple form submission — updating an existing lead by email, triggering a campaign — goes through Marketo's REST API, which does require a client-credentials OAuth2 token. Use the `api` tool + OAuth2 `authentication` block pattern shown above; Marketo's `identity/oauth/token` endpoint is a standard OAuth2 token endpoint that fits `buildAuth()`'s shape directly.

Pick the first path when you just need "get this lead into Marketo" and want zero secret management; reach for the second only when the model needs to do more than a one-shot form submission.

### Other DIY CRM/MAM/spreadsheet targets

None of these need a dedicated recipe — they're a plain `api` tool with a static bearer/API-key secret, following the exact same three-step pattern as HubSpot/Salesforce above:

- **Airtable** — a personal access token as a `Bearer` header, `POST` to `https://api.airtable.com/v0/{baseId}/{tableName}` with `body: {fields: {...}}`.
- **Google Sheets** — Google's Sheets API requires OAuth2 (a service account or viewer consent), so use the `authentication: {type: 'oauth2', ...}` pattern above rather than a static token.
- **Google Forms (prefill-and-submit link)** — Forms has no lead-write REST endpoint at all; the common workaround is a `client` tool that opens a pre-filled Forms URL (`viewform?usp=pp_url&entry.<id>=<value>`) for the viewer, which is a UX handoff, not a server-side write — decide whether that fits your flow before reaching for it.
- **Any other REST API** — same shape: static secret → `Authorization` header, or OAuth2 block if the provider requires it. This is exactly how you'd wire a MAM (media asset management) lookup, a support-ticketing system, a booking API, or anything else with an HTTP interface.

## Related docs

| Doc | What it adds |
|-----|---------------|
| [STRUCTURED-DATA-FORMS.md](STRUCTURED-DATA-FORMS.md) | Collecting the values this doc shows you how to forward durably |
| [DYNAMIC-DATA-INJECTION.md](DYNAMIC-DATA-INJECTION.md) | Feeding data *into* the conversation, the opposite direction from this doc |
| [CLIENT-COMMANDS.md](CLIENT-COMMANDS.md) | The avatar-driving-your-UI channel — a client-side, not server-side, mechanism |
