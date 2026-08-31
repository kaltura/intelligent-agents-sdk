---
layout: base.njk
title: "API · Phase 4 — Operate"
description: "Converse, reserved template variables, threads and history cost, feedback, usage analytics, and knowledge search."
eyebrow: Reference
---

[← API Reference index](/reference/api-reference/)

# Phase 4 — operate

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
| `request_vars` | Per-message `{{var}}` interpolation; needs `allow_client_variables:true` on the intellect. Reserved `sys__*` keys (including `sys__user_id`) are server-injected and rejected if you try to set them yourself — see [§ Bind a session to a real end-user identity](/reference/api/authentication/) for how `sys__user_id` gets populated. |
| `capabilities` | Per-message capability override |

**Stream segments** (each line is a JSON object). This is the common subset you'll see over HTTP; for the complete catalog — including the fence-tag-driven open-ended types — see [Wire Protocol §4e](/reference/wire-protocol/#4e-agent_raw_textdelta--the-brain-stream-parsed):

| `type` | Meaning |
|--------|---------|
| `"think"` | Processing (show spinner) |
| `"text"` | Response content — concatenate `content` fields |
| `"tool"` / `"tool_response"` | Server tool call + result; `content` carries client commands |
| `"unisphere-tool"` | GenUI widget — `metadata.runtimeName` names the widget |
| `"avatar"` | Spoken response content (avatar-driven experiences) |
| `"share"` | Shareable content block |
| `"error"` | Brain error |

Key envelope fields: `threadId` (save for follow-ups), `messageId` (save for feedback), `isFinal:true` (stream done).

**Cancelling a running turn:** there is no `/assistant/abort` HTTP endpoint — abort the client-side request instead (e.g. an `AbortSignal` passed into your fetch/stream call). Genie's actual interruption mechanism (`interruption`/`user-interruption`, tied to a WebSocket `abort` frame) exists only on the live-socket path, not HTTP converse — see the "Abort on interruption" bullet in [Wire Protocol §8](/reference/wire-protocol/#8-end-to-end-turn-what-fires-in-order).

---

## Reserved Template Variables (`sys__*`)

The server sets these on every turn. They're available to `{{ ... }}` interpolation in
`base_directive` / `prompts[].value` / `glossary` (see [Configure an Intellect](/reference/api/build/#configure-an-intellect))
regardless of `allow_client_variables`. The SDK's own `request_vars` pre-flight guard rejects a
client-supplied value for 5 of these 8 names before any network call — `sys__thread_id`,
`sys__message_id`, `sys__user_id`, `sys__user_message`, `secrets` (see `request_vars` above) —
since those collide with a server-managed variable; it does not yet name-check `sys__ks`,
`sys__is_new_thread`, or `sys__user_obj.*` the same way:

| Variable | Resolves to | Notes |
|----------|-------------|-------|
| `sys__thread_id` | Current conversation thread id | |
| `sys__message_id` | Current message id | |
| `sys__user_id` | The bound end-user id | Empty by default (an anonymous KS). Bind a real identity with `Sessions.createConversationToken({ userId })` (or `createAdminToken({ userId })`) so this resolves server-side instead of always being empty — see [§ Bind a session to a real end-user identity](/reference/api/authentication/). |
| `sys__user_message` | The current turn's user text | |
| `sys__is_new_thread` | `true` on the first turn of a new thread, `false` otherwise | |
| `sys__ks` | The raw Kaltura Session token for the current request | ⚠️ **Security warning: never reference `sys__ks` in a prompt whose output could be echoed back to a user or logged.** It is a live credential — rendering it as plain text in a model response, chat transcript, or log turns that surface into a credential leak. See [Security](/reference/security/#ks-kaltura-session-guidance-for-agents-ac-3--ac-6--ia-2). |
| `sys__user_obj.first_name` / `.last_name` / `.title` / `.company` / `.gender` / `.email` | Attributes of the bound-user object | Verify these resolve with `intellects.previewPrompt()` before shipping a prompt — the rendered preview flags unresolved references with a `reserved_user_attr_unresolved` warning. |
| `secrets.<NAME>` | A named secret configured on the intellect | Write-only — see [§ Secrets](/reference/api/build/#secrets-write-only). |

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

> **Compliance note.** `threads.delete()` soft-deletes immediately; a scheduled infra-level purge
> erases the underlying data later. See
> [Security](/reference/security/#shared-responsibility-control-matrix-nist-800-53) for what the SDK
> provides versus what the operator must configure.

## Thread History and Per-Turn Cost

There is no documented cap on how long a thread's history can grow. The full transcript is sent
as model context on every turn, so per-turn cost grows with thread length — plan long-running
threads accordingly: start a fresh thread per task, and delete threads you no longer need.

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

