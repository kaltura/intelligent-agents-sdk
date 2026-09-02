[← Back to the API Reference index](../../API-REFERENCE.md)

# Phase 4 — Operate

## Converse

```
POST https://genie.nvp1.ovp.kaltura.com/assistant/converse
```

Requires a conversation KS:

```bash
CONV_KS=$(curl -s -X POST "https://www.kaltura.com/api_v3/service/session/action/start" \
  -d "format=1" -d "secret=$AGENTIC_ADMIN_SECRET" \
  -d "partnerId=$AGENTIC_PARTNER_ID" -d "type=2" -d "expiry=86400" \
  -d "privileges=geniegpcid:1389" | tr -d '"')
```

```json
{
  "userMessage": "How do I fix video buffering?",
  "threadId": null,
  "sse": false
}
```

| Field | Notes |
|-------|-------|
| `userMessage` | Required |
| `threadId` | Omit for new conversation; pass previous value for memory |
| `sse` | `false` = NDJSON (default); `true` = SSE |
| `model_type` | `"fast"` for cheaper/faster model |
| `force_experience` | Hint only — not a guarantee |
| `request_vars` | `{{var}}` interpolation values; needs `allow_client_variables:true` on the intellect. Values **persist on the thread** (the server merges each message's map into what's stored — send only deltas; a new thread starts clean) and interpolate into both prompt blocks and server-side `api`-tool templates. Reserved `sys__*` keys (including `sys__user_id`) are server-injected and rejected if you try to set them yourself — see § Bind a session to a real end-user identity above for how `sys__user_id` gets populated. Semantics in depth: [docs/DYNAMIC-DATA-INJECTION.md](../DYNAMIC-DATA-INJECTION.md). |
| `capabilities` | Per-message capability override |

**Enabling `allow_client_variables`:** `mgmt.intellects.setClientVariablesEnabled(configId, true, adminKs)` (WRITE, admin KS; also exposed as `mgmt.intellectConfig.setClientVariablesEnabled`). With it off, the rejection is **silent on every path**: the turn streams back empty — no HTTP error on `converse`, no socket error. The server's 403 fires inside its streaming pipeline after the response has already opened, so it never reaches the wire. Both session classes (`KalturaAvatarSession`, `KalturaChatSession`) detect the pattern and emit a once-per-session `warning` event (`code: 'empty_turn_with_request_vars'`, variable names only, never values); the management converse helpers keep a defensive remap to a typed `client_variables_disabled` error for the pre-stream case, should the server ever start rejecting before the stream opens.

**Stream segments** (each line is a JSON object):

| `type` | Meaning |
|--------|---------|
| `"think"` | Processing (show spinner) |
| `"text"` | Response content — concatenate `content` fields |
| `"tool"` / `"tool_response"` | Server tool call + result; `content` carries client commands |
| `"unisphere-tool"` | GenUI widget — `metadata.runtimeName` names the widget |
| `"error"` | Brain error |
| `"user-interruption"` | User barged in |

Key envelope fields: `threadId` (save for follow-ups), `messageId` (save for feedback), `isFinal:true` (stream done).

**Abort a running turn:**

```
POST https://genie.nvp1.ovp.kaltura.com/assistant/abort
{ "threadId": "154a05c4-..." }
```

---

## Reserved Template Variables (`sys__*`)

The server sets these on every turn. They're available to `{{ ... }}` interpolation in `base_directive` / `prompts[].value` / `glossary` (see [Configure an Intellect](build.md#configure-an-intellect)) regardless of `allow_client_variables`. The SDK's own `request_vars` pre-flight guard rejects a client-supplied value for 5 of these 8 names before any network call — `sys__thread_id`, `sys__message_id`, `sys__user_id`, `sys__user_message`, `secrets` (see `request_vars` above) — since those collide with a server-managed variable; it does not yet name-check `sys__ks`, `sys__is_new_thread`, or `sys__user_obj.*` the same way:

| Variable | Resolves to | Notes |
|----------|-------------|-------|
| `sys__thread_id` | Current conversation thread id | |
| `sys__message_id` | Current message id | |
| `sys__user_id` | The bound end-user id | Empty by default (an anonymous KS). Bind a real identity with `Sessions.createConversationToken({ userId })` (or `createAdminToken({ userId })`) so this resolves server-side instead of always being empty — see § Bind a session to a real end-user identity above. |
| `sys__user_message` | The current turn's user text | |
| `sys__is_new_thread` | `true` on the first turn of a new thread, `false` otherwise | |
| `sys__ks` | The raw Kaltura Session token for the current request | ⚠️ **Security warning: never reference `sys__ks` in a prompt whose output could be echoed back to a user or logged.** It is a live credential — rendering it as plain text in a model response, chat transcript, or log turns that surface into a credential leak. See [SECURITY.md](../../SECURITY.md#ks-kaltura-session-guidance-for-agents-ac-3--ac-6--ia-2). |
| `sys__user_obj.first_name` / `.last_name` / `.title` / `.company` / `.gender` / `.email` | Attributes of the bound-user object | Verify these resolve with `intellects.previewPrompt()` before shipping a prompt — the rendered preview flags unresolved references with a `reserved_user_attr_unresolved` warning. |
| `secrets.<NAME>` | A named secret configured on the intellect | Write-only — see [§ Secrets](build.md#secrets-write-only). |

---

## Check Status

```
GET https://genie.nvp1.ovp.kaltura.com/assistant/status
```

Returns `{aiConsent, avatar, identifiedUser}`. `avatar` is non-null when the agent has an avatar configured.

---

## Threads

All thread endpoints require an **admin KS** (`disableentitlement`). Pager: `{"pageIndex":1,"pageSize":30}`.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST .../v1/thread/list` | `{"filter":{"objectType":"ListThreadFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST .../v1/thread/get` | `{"id":"UUID"}` |
| Rename | `POST .../v1/thread/update` | `{"id":"UUID","title":"New name"}` |
| Delete | `POST .../v1/thread/delete` | `{"thread_ids":["UUID"]}` |
| Transcript | `POST .../v1/thread/get_transcripts` | `{"id":"UUID"}` |

`...` = `https://genie.nvp1.ovp.kaltura.com`

**Thread list response** fields per object: `id`, `title`, `created_at`, `updated_at`, `status`.

**Transcript response:** `{"status":"success","data":"human: …\nai: …"}` — plain text, one turn per line.

**Delete** returns `{totalCount, objects[]}` — a soft delete, followed by a scheduled infra-level purge of the underlying data.

SDK: `mgmt.threads.{list, get, rename, delete, transcript}`.

> **Compliance note.** `threads.delete()` soft-deletes immediately; a scheduled infra-level purge erases the underlying data later. See [SECURITY.md](../../SECURITY.md#shared-responsibility-control-matrix-nist-800-53) for what the SDK provides versus what the operator must configure.

## Session-Completion Signal

Unlike the admin-KS thread endpoints above, this one is called from the browser client itself, with the same **conversation KS** (`geniegpcid`) used for every other client-facing call — it mints nothing new and needs no elevated privilege.

| Operation | Endpoint | Body | Auth |
|-----------|----------|------|------|
| Session completed | `POST {genieUrl}/thread/session_completed` | `{"id":"<threadId>"}` | `Authorization: KS <conversation ks>` |

`{genieUrl}` defaults to `https://genie.nvp1.ovp.kaltura.com` (no `/v1` prefix — a different route family from the thread CRUD above). Idempotent (a repeat call for the same thread is a no-op server-side); no rate limit; can block up to ~10s on a backend publish-ack, so a client must never await it on a page-unload path.

Tell the backend a conversation is genuinely over the moment it happens, instead of waiting for the ~10-minute idle scanner — so end-of-conversation lifecycle rules (summaries, insights, CRM pushes) fire in seconds. SDK: `KalturaAvatarSession`/`KalturaChatSession`/`KalturaAgentSession` call this automatically on `disconnect()` (`sessionCompleteOnEnd`, default `true`) and on tab-close/backgrounding/bfcache — see [README.md § Ending a conversation cleanly](../../README.md#ending-a-conversation-cleanly-session_completed-signal) for the full config surface, and [WIRE-PROTOCOL.md](../WIRE-PROTOCOL.md) for the exact request shape.

## Thread History and Per-Turn Cost

There is no documented cap on how long a thread's history can grow. The full transcript is sent as model context on every turn, so per-turn cost grows with thread length — plan long-running threads accordingly: start a fresh thread per task, and delete threads you no longer need.

---

## Feedback and Follow-ups (SDK)

Feedback and follow-up suggestions route through internal Genie paths — use the SDK rather than calling them directly.

- `mgmt.feedback.add({message_id, is_positive, comment?}, convKs)` — thumbs up/down on a message. `message_id` comes from the converse stream.
- `mgmt.followups.getSuggested(ks)` — pre-configured starter questions. Per-answer follow-ups stream inline as `unisphere-tool` segments when `capabilities.generate_followup_questions:"on"`.

---

## Usage Analytics

Partner-scoped read-only CSV — contains end-user IDs and verbatim questions (treat as PII).

SDK: `mgmt.messages.report(ks)` (raw CSV) / `mgmt.messages.reportSummary(ks)` (volume + feedback ratio + top questions, with a `_meta` provenance receipt).

---

## Knowledge Search (MCP)

```
POST https://genie.nvp1.ovp.kaltura.com/mcp/search
{ "query": "adaptive bitrate streaming" }
```

Returns `{status, data}`. A partner with no indexed content returns a `"couldn't find relevant information"` error response. SDK: `mgmt.knowledge.search(query, ks)`.
