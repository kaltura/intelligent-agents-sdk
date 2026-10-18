[← Back to the API Reference index](../../API-REFERENCE.md)

# Conversation & Analytics

## Converse

```
POST https://genie.nvp1.ovp.kaltura.com/assistant/converse
```

Requires a conversation KS (see [Authentication](authentication.md#authentication)):

```bash
CONV_KS=$(curl -s -X POST "https://www.kaltura.com/api_v3/service/session/action/start" \
  -d "format=1" -d "secret=$AGENTIC_ADMIN_SECRET" \
  -d "partnerId=$AGENTIC_PARTNER_ID" -d "userId=learner-123" -d "type=0" -d "expiry=86400" \
  -d "privileges=geniegpcid:1389,setrole:PLAYBACK_BASE_ROLE" | tr -d '"')
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
| `model_type` | Optional. `fast` or `smart`, lowercase. Omit it to use the default, `fast`. |
| `force_experience` | Must be one of `markdown`, `summarization`, `flashcards`, `avatar_only`. Anything else throws a `validation_error` before any network call. A hint about which experience to render, not a guaranteed outcome. |
| `request_vars` | `{{var}}` interpolation values. Needs `allow_client_variables:true` on the intellect. It is on by default (see [Authentication § The Five Services](authentication.md#the-five-services) for what an intellect is). They interpolate into prompts and `api` tool templates. Reserved `sys__*` keys (including `sys__user_id`) are set by the server. The SDK rejects a client-supplied value for them. For how `sys__user_id` gets its value, see [Authentication § Bind a session to a real end-user identity](authentication.md#authentication). Semantics in depth: [docs/DYNAMIC-DATA-INJECTION.md](../DYNAMIC-DATA-INJECTION.md). |
| `capabilities` | Per-message capability override |
| `context_id` | Optional. The id of the category or entry the turn is about, as a string. With `context_type: 'entry'` it must look like `0_abcd1234`. |
| `context_type` | Optional. `entry`, `category`, `ancestor_category` or `global`. |
| `preload_entry_ids` | Optional. Array of entry ids to add to the turn's context. |
| `exclude_entry_ids` | Optional. Array of entry ids to keep out of the turn's context. |
| `metadata` | Optional. `{ voice_start_time, voice_end_time }`, both numbers. Saved with the user's message. |

The SDK checks `context_type`, `context_id`, both entry id lists and `metadata` before it sends the converse request, and throws `validation_error` for a bad value. It sends only the fields in this table.

**`allow_client_variables`** must be on to send `request_vars`. It is on by default. Pin it with `mgmt.intellects.setClientVariablesEnabled(configId, true, adminKs)` (WRITE, admin KS; also exposed as `mgmt.intellectConfig.setClientVariablesEnabled`).

With it off, the turn streams back empty on the streaming paths. There is no HTTP error on `converse` and no socket error.

Both session classes (`KalturaAvatarSession`, `KalturaChatSession`) detect the pattern and emit a once-per-session `warning` event (`code: 'empty_turn_with_request_vars'`, variable names only, never values). The management converse helpers map a 403 that reports disabled client variables to a typed `client_variables_disabled` error. `KalturaChatSession.sendText()` can fail either way when it sends request variables: the empty turn with the warning, or a rejected promise with `client_variables_disabled`.

**Stream segments** (each line is a JSON object):

| `type` | Meaning |
|--------|---------|
| `"think"` | Processing (show spinner) |
| `"text"` | Response content. Concatenate `content` fields. On an avatar-enabled intellect, spoken content streams as `"avatar"` (and `"avatar-filler"`) instead, accumulated the same way. |
| `"tool"` / `"tool_response"` | Server tool call + result; `content` carries client commands |
| `"unisphere-tool"` | GenUI widget. `metadata.runtimeName` names the widget |
| `"error"` | The server refused or failed the turn. See [Refusals that arrive with HTTP 200](#refusals-that-arrive-with-http-200). |
| `"user-interruption"` | User barged in |

Key envelope fields: `threadId` (save for follow-ups), `messageId` (save for feedback), `isFinal:true` (stream done).

**Token-kind check timing.** `conversations.send(...)` and `converseOnce(...)` check the token kind before they return. `conversations.stream(...)` is an async generator, so its check runs on the first iteration. Iterate it, or use `send`, to get the check up front.

### Refusals that arrive with HTTP 200

The server reports some refusals in the stream, not in the HTTP status. The status is 200 and the body holds one `"error"` segment. The common case is a `threadId` that belongs to a different user: the segment reads `No permission for thread`, nothing is written, and the turn has no text.

The SDK raises these as a `KalturaError` so an empty reply is never mistaken for success:

| Where | Default | Opt out |
|---|---|---|
| `conversations.send`, `converseOnce` | Throws | `onErrorSegment: 'return'`. The result carries the segments in `errors`. |
| `KalturaChatSession.sendText` | Rejects and emits `error` | `onErrorSegment: 'warn'` in the constructor. Emits `warning` and resolves. |
| `converse` stream, `collectConverse` | Yields every segment and returns them in `errors`. You decide. | n/a |

| `error.code` | Meaning | What to do |
|---|---|---|
| `thread_access_denied` | The `threadId` belongs to a different user. | Start without that `threadId`, or mint the token with the `userId` that created the thread. |
| `stream_error` | Any other `error` segment. | Read `error.detail` and `error.body.errors`. |
| `empty_reply` | The reply had no segments (`conversations.send`, `converseOnce` only). | If you sent `context_id`, check it. `onErrorSegment: 'return'` returns the empty result. |

`error.body` holds `errors` (the segments), `threadId`, and `partial` (the text, `threadId` and `messageId` that arrived before the refusal). For `empty_reply`, `error.body` holds `segments`. A stream line that is not JSON, such as a proxy error page, becomes an `error` segment too, so it is never dropped.

The same rule applies to every HTTP call. A 200 reply whose body is an error is thrown, with the server text in `error.detail`. The SDK throws for an exception object, `{error: "..."}`, `{success: false}`, and a body with only status and message keys and a status of 400 or above. A 200 reply that starts like JSON but does not parse throws `invalid_response`. A failed call inside a Kaltura multirequest throws `ovp_error` naming the call.

**Stop a running turn:**

| Session | Call |
|---|---|
| `KalturaAvatarSession` | `session.interrupt()` sends a barge-in so the avatar yields the turn. It does not cancel a running turn on the server, and the SDK has no call that does. It throws `invalid_state` when the session is not connected or a tap-to-talk capture is open. |
| `KalturaChatSession` | Pass `signal` to `sendText(text, { signal })` and abort it. The request is cancelled and the turn rejects with code `aborted`. |

---

## Reserved Template Variables (`sys__*`)

The server sets these on every turn. They're available to `{{ ... }}` interpolation in `base_directive` / `prompts[].value` / `glossary` (see [Configure an Intellect](build/intellect.md#configure-an-intellect)) and in the `instructions` of a skill attached with mode `'preloaded'` (see [§ Skills](management-operations.md#skills)), regardless of `allow_client_variables`.

Before any network call, the SDK's own `request_vars` pre-flight guard rejects a client-supplied value for any key in the table below, plus `secrets` (see `request_vars` above):

| Variable | Resolves to | Notes |
|----------|-------------|-------|
| `sys__thread_id` | Current conversation thread id | |
| `sys__message_id` | Current message id | |
| `sys__user_id` | The bound end-user id | Empty by default (a KS with no `userId`). Bind a real identity with `Sessions.createConversationToken({ configId, userId })` or `createAgentToken({ agentId, userId })` (or `createAdminToken({ userId })`) so this variable resolves to a real id instead of staying empty. See [Authentication § Bind a session to a real end-user identity](authentication.md#authentication). |
| `sys__user_message` | The current turn's user text | |
| `sys__is_new_thread` | `true` on the first turn of a new thread, `false` otherwise | |
| `sys__avatar_enabled` | Whether the current thread has a live avatar attached | Used in a skill, prompt block or tool `condition` to gate it to avatar-only sessions, as a bare expression with no `{{ }}`, e.g. `condition: 'sys__avatar_enabled'`. See [Conditions](build/intellect.md#conditions). Not set yet when a thread-start tool's `condition` runs: there `sys__avatar_enabled` never passes and `not sys__avatar_enabled` always passes. |
| `sys__avatar_share_screen_enabled` | True while the avatar session has a screen share running. The agent needs `screenShare.enabled` ([agent fields](build/avatar-and-agent.md)). False in plain conversations that never share | Also usable in a skill, prompt block or tool `condition`, e.g. `sys__avatar_enabled and not sys__avatar_share_screen_enabled` to gate a skill to avatar sessions that are NOT sharing a screen. Same limit for thread-start tool conditions. |
| `sys__context_id` | The category/entry id the current context (and its knowledge base, if any) is scoped to | Set via `KalturaAvatarSession`'s `contextId` constructor option, sent on the live socket `join` payload. See [connection-and-handshake.md § The `join` payload](../architecture-reference/connection-and-handshake.md#the-join-payload-step-2-carries-the-agent-config). Empty when no context was set at join. On HTTP converse, set it with `context_id`. |
| `sys__context_type` | The type of that context (e.g. an `entry` vs. a `category`) | Set via `KalturaAvatarSession`'s `contextType` constructor option, alongside `contextId`; empty when no context was set at join. On HTTP converse, set it with `context_type`. |
| `sys__ks` | The raw KS (Kaltura Session) for the current request | ⚠️ **Security warning: never reference `sys__ks` in a prompt whose output could be echoed back to a user or logged.** It is a live credential. Rendering it as plain text in a model response, chat transcript, or log can leak that credential. See [SECURITY.md](../../SECURITY.md#ks-kaltura-session-guidance-for-agents-ac-3--ac-6--ia-2). |
| `sys__user_obj.first_name` / `.last_name` / `.title` / `.company` / `.gender` / `.email` | Attributes of the bound-user object | Verify these resolve with `intellects.previewPrompt()` before shipping a prompt. The rendered preview flags unresolved references with a `reserved_user_attr_unresolved` warning. |
| `secrets.<NAME>` | A named secret configured on the intellect | Write-only. See [§ Secrets](build/tools-and-secrets.md#secrets-write-only). |

---

## Check Status

```
GET https://genie.nvp1.ovp.kaltura.com/assistant/status
```

Returns `{aiConsent, avatar, identifiedUser}`. `avatar` is non-null when the agent has an avatar configured.

---

## Threads

In this SDK, `threads.list`, `get`, `rename`, `delete`, `transcript`, `setAnalysis`, `clearAnalysis`, `messages.list`, `get`, `share`, `followups.getSuggested` and `knowledge.search` accept an admin, conversation or agent token. A widget token is rejected with `wrong_token_scope` before any request. How raw KS strings are checked: [Authentication](authentication.md#authentication). What each token reaches: [SECURITY.md § Session type](../../SECURITY.md#session-type). `threads.push`, `messages.report`, `messages.reportSummary`, `feedback.list` and `followups.list` need an admin token. Pager: `{"pageIndex":1,"pageSize":30}`.

| Operation | Endpoint | Body |
|-----------|----------|------|
| List | `POST .../v1/thread/list` | `{"filter":{"objectType":"ListThreadFilter"},"pager":{"pageIndex":1,"pageSize":30}}` |
| Get | `POST .../v1/thread/get` | `{"id":"UUID"}` |
| Rename | `POST .../v1/thread/update` | `{"id":"UUID","title":"New name"}` |
| Delete | `POST .../v1/thread/delete` | `{"thread_ids":["UUID"]}` |
| Transcript | `POST .../v1/thread/get_transcripts` | `{"id":"UUID"}` |

`...` = `https://genie.nvp1.ovp.kaltura.com`

**Thread list response** fields per object: `id`, `title`, `created_at`, `updated_at`, `status`, `origin`, `agent_id`.

**Origin.** Every thread has a numeric `origin`. The list returns only `origin: 0` unless the filter names an origin.

| `origin` | Thread | How it is made |
|---|---|---|
| 0 | Standard | Default |
| 1 | Preview | A token minted with `extraPrivileges: 'threadOrigin:preview'` or `'preview:true'` |
| 2 | Evaluation | A token minted with `extraPrivileges: 'threadOrigin:evaluation'` |

Filter with `originEquals: 2` or `originIn: [0, 2]`. `originIn: [0, 1, 2, 3, 4]` returns threads of all origins.

**What a user token lists.** A conversation or agent token with a `userId` reaches that user's threads with the agent named in the token. The table covers standard threads (`origin: 0`).

| Token | `threads.list` returns | `threads.get` of a thread from another agent or user |
|---|---|---|
| Admin | Every user and agent | Found |
| `userId` + `agentId` | That user's threads with that agent | 404 |
| Same `userId`, other `agentId` | None of the first agent's threads | 404 |
| `userId`, no `agentId` | None of that user's agent threads | 404 |

**Thread record** (`threads.get`, `threads.rename`): the list fields plus `user_id`, `partner_id`, `agent_id`, `context_id`, `origin` and `thread_metadata`. Renaming to a very long title (300 characters, for example) fails with `server_error` and leaves the stored title unchanged.

**Thread origin.** Mint the token with `extraPrivileges: 'threadOrigin:preview'` or `'threadOrigin:evaluation'` to mark the threads it starts (origin `1` or `2`). Those threads are hidden from the default `threads.list`; list them with `originIn`. A number, such as `threadOrigin:3` or `threadOrigin:1`, gives origin `0`, a standard conversation.

**Transcript response:** `{"status":"success","data":"human: …\nai: …"}`. Plain text, one turn per line.

**Delete** returns `{totalCount, objects[]}`: the threads it actually deleted. Any id it did not delete (one that does not exist, or another user's thread under a user session) is left out, and the status is still 200. So check `objects`, not the status: `totalCount: 0` means nothing was deleted.

SDK: `mgmt.threads.{list, get, rename, delete, transcript}`. Three more write operations live only on the SDK (`setAnalysis`, `clearAnalysis`, `push`); see [management-operations.md § Threads](management-operations.md#threads) for their request shapes.

> **Compliance note.** See [SECURITY.md](../../SECURITY.md#shared-responsibility-control-matrix-nist-800-53) for what the SDK provides versus what the operator must configure.

## Session-Completion Signal

Unlike the admin-token thread endpoints above, this one is called from the browser client itself, with the same **conversation KS** (`geniegpcid`) used for every other client-facing call. It mints nothing new and needs no elevated privilege.

| Operation | Endpoint | Body | Auth |
|-----------|----------|------|------|
| Session completed | `POST {genieUrl}/thread/session_completed` | `{"id":"<threadId>"}` | `Authorization: KS <conversation ks>` |

`{genieUrl}` is the session's `genieUrl` option, else the `region` entry (default `nvp1`: `https://genie.nvp1.ovp.kaltura.com`). It has no `/v1` prefix (a different route family from the thread CRUD above). Send it once at the end. Never await it on a page-unload path.

Call this the moment a conversation is genuinely over, so end-of-conversation lifecycle rules (summaries, insights, CRM pushes) fire right away.

`KalturaAvatarSession`/`KalturaChatSession`/`KalturaAgentSession` call this automatically on `disconnect()` (`sessionCompleteOnEnd`, default `true`) and on tab-close/backgrounding/bfcache. See [README.md § Ending a conversation cleanly](../../README.md#ending-a-conversation-cleanly-session_completed-signal) for the full config surface.

## Thread History and Context Size

The full transcript is sent as model context on every turn, so each turn carries more context as the thread grows. For long-running work, start a fresh thread per task and delete threads you do not need.

---

## Feedback and Follow-ups (SDK)

Use the SDK for feedback and follow-up suggestions. It handles the routes for you.

- `mgmt.feedback.add({message_id, is_positive, comment?}, convKs)`: thumbs up/down on a message. `message_id` comes from the converse stream.
- `mgmt.feedback.list(ks, opts)`: admin-only feedback listing, filterable by `messageIdEquals`/`messageIdsIn`/`threadIdEquals`/`agentIdEquals`/`isPositiveEquals`. ⚠️ SENSITIVE: contains end-user ids/names + verbatim question/feedback text. Treat as PII; scope and redact before sharing.
- `mgmt.followups.getSuggested(ks, { contextId?, contextType? })`: starter questions for the partner or agent. The set can differ between calls. Per-answer follow-ups stream inline as `unisphere-tool` segments when `capabilities.generate_followup_questions:"on"`.
- `mgmt.followups.list(ks, opts)`: raw partner-wide follow-up and starter question records (distinct from `getSuggested`'s per-agent shortlist).

---

## Usage Analytics

Partner-scoped read-only CSV. It contains end-user IDs and verbatim questions (treat as PII).

SDK: `mgmt.messages.report(ks)` (raw CSV) / `mgmt.messages.reportSummary(ks)` (volume, feedback ratio and top questions, with a `_meta` provenance receipt). Messages pushed into a thread are not counted as messages.

`mgmt.messages.get(id, ks)` (`POST {genieUrl}/message/get`) fetches one message record directly, without paging through `messages.list()`. A message that does not exist, or that the token cannot read, throws a typed `not_found` error.

---

## Knowledge Search (MCP)

Your indexed content is available over the [MCP](https://modelcontextprotocol.io) protocol at this one endpoint. This is separate from [MCP-INTEGRATIONS.md](../MCP-INTEGRATIONS.md), which wires an intellect to *external* MCP servers via `intellectConfig.setMcpServers`.

```
POST https://genie.nvp1.ovp.kaltura.com/mcp/search
{ "query": "adaptive bitrate streaming" }
```

Returns `{status, data}`. A partner with no indexed content returns a `"couldn't find relevant information"` error response. SDK: `mgmt.knowledge.search(query, ks, opts)`.

`opts` passes through five optional tuning params:

| Param | Default |
|---|---|
| `top_n` | 5 |
| `with_line_numbers` | none |
| `margins_in_seconds` | 15 |
| `include_sources` | none |
| `entry_description` | none |

`include_sources:true` changes the success shape's `chapters` from `null` to an array, and `text` to `null`.
