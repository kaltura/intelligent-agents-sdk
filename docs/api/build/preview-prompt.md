[← Back to Agent Components](../build.md)

# Preview a Prompt (client-side)

**SDK:** `mgmt.intellects.previewPrompt(configId, ks, opts)`. Requires an **admin KS**. This call only reads data and never writes.

The SDK renders the returned `text` on the client. It is a replica of the author layer (`prompts[]`, `base_directive` and `glossary`). Use it to check a prompt template before shipping it. The preview does not include skill instructions. Knowledge-typed prompt blocks render inline here, while a live turn places them in a separate context block.

By default, it fetches and renders the intellect's *current stored* config. Pass `draftPrompts`/`draftBaseDirective`/`draftGlossary` to preview an unsaved edit instead.

```js
const p = await mgmt.intellects.previewPrompt(configId, adminKs, {
  requestVars: { sys__user_id: 'learner-123', topic: 'billing' },
});
p.text;                // the assembled system prompt, `{{var}}` interpolated
p.unresolvedVariables; // names left literal because no value was supplied
p.warnings;             // present ONLY when a reserved variable is unresolved (see below)
p.conditionalKeys;     // keys of rendered blocks that carry a non-empty `condition`
p.skippedKeys;         // keys of blocks left out because `headerTemplate` or `value` is empty
```

The preview does not evaluate [conditions](intellect.md#conditions). Every non-empty block is rendered. `conditionalKeys` lists the rendered blocks that apply live only while their condition is true. A skipped block is never listed there, and neither is a block with `condition: ''` or `null`.

It is **not byte-exact** with the live prompt. Blocks the server adds at run time are not included. The `sys__*` values you pass via `requestVars` only *simulate* what the server sets per turn. They are not a live read.

**Reserved variables** (`sys__*`, `secrets.*`) are listed in [operate.md § Reserved Template Variables](../operate.md#reserved-template-variables-sys__). `secrets.NAME` is write-only: `previewPrompt()` never has the raw value, so it cannot confirm that a secret is set. A prompt that references one of the `sys__user_obj.*` attributes gets a `reserved_user_attr_unresolved` warning when the preview has no bound value for it. Bind every variable the prompt uses before shipping.

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
| [`intellect.md`](intellect.md) | The `prompts[]`/`base_directive`/`glossary` fields this preview renders |
| [`../build.md`](../build.md) | The Agent Components index |
