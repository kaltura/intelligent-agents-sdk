---
layout: base.njk
title: "Agent Components · Preview a Prompt"
description: "Render the assembled system prompt client-side before shipping an edit, using mgmt.intellects.previewPrompt."
eyebrow: Reference
---

# Preview a Prompt (client-side)

[← Back to Agent Components](/reference/api/build/)


**SDK:** `mgmt.intellects.previewPrompt(configId, ks, opts)`. Requires an **admin KS**. This call only reads data and never writes.

The SDK renders the returned `text` on the client. It is a replica of the author layer (`prompts[]`, `base_directive` and `glossary`). Use it to check a prompt template before shipping it.

By default, it fetches and renders the intellect's *current stored* config. Pass `draftPrompts`/`draftBaseDirective`/`draftGlossary` to preview an unsaved edit instead.

```js
const p = await mgmt.intellects.previewPrompt(configId, adminKs, {
  requestVars: { sys__user_id: 'learner-123', topic: 'billing' },
});
p.text;                // the assembled system prompt, `{{var}}` interpolated
p.unresolvedVariables; // names left literal because no value was supplied
p.warnings;             // present ONLY when a reserved variable is unresolved (see below)
```

It is **not byte-exact** with the live prompt. Blocks the server adds at run time are not included. The `sys__*` values you pass via `requestVars` only *simulate* what the server sets per turn. They are not a live read.

**Reserved variables** (`sys__*`, `secrets.*`) are listed in [Conversation & Analytics § Reserved Template Variables](/reference/api/operate/#reserved-template-variables-sys__). `secrets.NAME` is write-only: `previewPrompt()` never has the raw value, so it cannot confirm that a secret is set. A prompt that references one of the `sys__user_obj.*` attributes gets a `reserved_user_attr_unresolved` warning when the preview has no bound value for it. Bind every variable the prompt uses before shipping.

**Unresolvable reserved-variable warnings:** say a prompt references one of the variables above, and no value is available in the simulated context (no `requestVars` entry, or an explicit `null`/`undefined`). In that case `previewPrompt()` returns a `warnings[]` entry naming the variable and explaining why, instead of rendering the placeholder as empty text.

`warnings` is an **additive** field. It appears only when there is something to report.

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
//              requestVars. Bind every variable the prompt uses: bind a user
//              (Sessions.createConversationToken({ configId, userId })) or supply
//              "sys__user_obj.first_name" in requestVars to simulate the bound case
//              before shipping this prompt.'
// }]
```

Supplying the value in `requestVars` (e.g. `{ 'sys__user_obj.first_name': 'Jane' }`, or `{ sys__user_id: 'learner-123' }`) simulates the bound case and clears the warning.

| Warning `code` | Fires for |
|---|---|
| `reserved_var_unresolved` | A scalar `sys__*` variable |
| `reserved_user_attr_unresolved` | A `sys__user_obj.*` attribute. `lintPrompts` flags unbound variables. Bind every variable the prompt uses |
| `reserved_secret_unresolved` | A `secrets.*` reference. `previewPrompt()` can't verify these: it only ever sees the rendered text, never the raw secret value |

---

## Related docs

| Doc | What it adds |
|---|---|
| [Agent Components · Create and Configure an Intellect](/reference/api/build/intellect/) | The `prompts[]`/`base_directive`/`glossary` fields this preview renders |
| [Agent Components](/reference/api/build/) | The Agent Components index |

