[← Back to Phase 2 — Build](../build.md)

# Preview a Prompt (client-side)

**SDK:** `mgmt.intellects.previewPrompt(configId, ks, opts)`. READ — no write. The returned `text` is rendered client-side, a replica of the author layer (`prompts[]` + `base_directive` + `glossary`) assembled the same way the server's `get_partner_prompts()`/`get_system_prompt()` do, so you can check a prompt template before shipping it. By default it fetches and renders the intellect's *current stored* config; pass `draftPrompts`/`draftBaseDirective`/`draftGlossary` to preview an unsaved edit instead.

```js
const p = await mgmt.intellects.previewPrompt(configId, adminKs, {
  requestVars: { sys__user_id: 'learner-123', topic: 'billing' },
});
p.text;                // the assembled system prompt, `{{var}}` interpolated
p.unresolvedVariables; // names left literal because no value was supplied
p.warnings;             // present ONLY when a reserved variable is unresolved (see below)
```

It is **not byte-exact** with the live prompt — server-injected capability-conditional blocks (`video_gallery`/`avatar_show_content`/`web_search_enabled`/`user_properties`) are not reproduced, and `sys__*` values you pass via `requestVars` are a *simulation* of what the server sets per turn, not a live read.

**Reserved variables** the server sets per turn (always available to `{{...}}` regardless of `allow_client_variables`):

| Variable | Notes |
|----------|-------|
| `sys__thread_id` | Current conversation thread id |
| `sys__message_id` | Current message id |
| `sys__user_id` | Bound end-user id — see `Sessions.createConversationToken({userId})` |
| `sys__user_message` | The user's current turn text |
| `sys__is_new_thread` | `true` on the first turn of a thread |
| `sys__ks` | The raw session token. **Never reference this in a prompt that could be echoed back to a user or logged.** It is a live credential. |
| `sys__user_obj.first_name` / `.last_name` / `.title` / `.company` / `.gender` / `.email` | Attributes of the bound-user object. The rendered preview from `previewPrompt()` carries a `reserved_user_attr_unresolved` warning when a prompt references these — treat it as a hard stop before shipping. |
| `secrets.NAME` | A named secret configured on the intellect (write-only — `previewPrompt()` never has access to the raw value, so it cannot confirm one is set) |

**Unresolvable-reserved-variable warnings (hardening):** if a prompt references one of the variables above and no value is available in the simulated context (no `requestVars` entry, or an explicit `null`/`undefined`), `previewPrompt()` returns a `warnings[]` entry naming the variable and why — instead of the placeholder being silently rendered as literal/empty text as if the prompt were safe to ship. `warnings` is an **additive** field: it is present only when non-empty, so a fully-resolved preview's return shape is unchanged from before this hardening.

```js
const p = await mgmt.intellects.previewPrompt(configId, adminKs, {
  draftPrompts: [{ key: 'greet', headerTemplate: 'Greeting', value: 'Hi {{sys__user_obj.first_name}}', type: 'custom' }],
  draftBaseDirective: 'You are Ron.',
  draftGlossary: '',
  requestVars: {}, // no bound user simulated
});
p.warnings;
// [{
//   severity: 'warning',
//   code: 'reserved_user_attr_unresolved',
//   message: '`{{sys__user_obj.first_name}}` has no bound value in this preview\'s
//              requestVars. previewPrompt flags this as reserved_user_attr_unresolved —
//              bind a user (Sessions.createConversationToken({userId}))
//              or supply "sys__user_obj.first_name" in requestVars to simulate
//              the bound case before shipping this prompt.'
// }]
```

Supplying the value in `requestVars` (e.g. `{ 'sys__user_obj.first_name': 'Jane' }`, or `{ sys__user_id: 'learner-123' }`) simulates the bound case and clears the warning. Warning `code`s: `reserved_var_unresolved` (a scalar `sys__*` variable), `reserved_user_attr_unresolved` (a `sys__user_obj.*` attribute — the class of reference that can crash a live turn), `reserved_secret_unresolved` (a `secrets.*` reference `previewPrompt()` cannot verify, since only the rendered text is ever available to it, never a raw secret value).

---

## Related docs

| Doc | What it adds |
|---|---|
| [`intellect.md`](intellect.md) | The `prompts[]`/`base_directive`/`glossary` fields this preview renders |
| [`../build.md`](../build.md) | The Phase 2 — Build index |
