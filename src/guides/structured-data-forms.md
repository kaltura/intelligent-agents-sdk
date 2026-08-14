---
layout: base.njk
title: "Structured Data Forms"
description: "How to make an agent ask a viewer for structured, typed data mid-conversation, how the SDK renders that request, and where the submitted values actually go."
eyebrow: How-to Guide
---

# Collecting structured data from a viewer (`user_properties_forms`)

How to make an agent ask the viewer for structured, typed data mid-conversation — a support
ticket's category and urgency, a booking's preferred date, a survey rating, a sales lead's email
and phone, or any other shape of data your use case needs — how the SDK renders that request, and
where the submitted values actually go.

`user_properties_forms` is a general-purpose "collect typed fields from the viewer" primitive: the
fields, prompt injection, rendering, and reporting all work identically no matter what the fields
represent. The one place this shows up in the SDK's own surface is naming: the method you call to
report values back is `session.submitStructuredDataForm()`, over a wire event named
`setFormLeadInfo` — both named after the feature's most common use case, not its only one.

All claims below are anchored to source: the Genie brain backend (the conversational AI backend
service) and this repo's SDK (`src/`).

## What it is — and isn't

You configure it once, at intellect creation or update, as a list of "stages":

<div data-nova-target="structured-data-forms-example" data-nova-label="Configure structured data forms example">

```js
await mgmt.intellectConfig.setUserPropertiesForms(configId, [
  { callStage: 'middle', properties: [
    { key: 'issueCategory', type: 'str' },
    { key: 'urgency', type: 'str' },
  ] },
], adminKs);
```

</div>

`callStage` is one of `start` / `middle` / `end` (`CALL_STAGES` in `src/management/intellect-config.js`).
Each property is `{key, type}`, where `type` is one of the six argument types the platform supports —
`str`, `int`, `float`, `bool`, `list`, `dict` (`ARG_TYPES`, re-exported from `core/stream.js`'s
`ARG_TYPE_NAMES`, the single source of truth). The renderer additionally recognizes `email`/`phone`/`text`
as presentation hints (see "Rendering" below) — the wire/backend schema itself only stores the six base
types. `buildUserPropertiesForms()` validates all of this purely, before any network call, and throws a
typed `bad_request` on an invalid stage, an empty `properties` array, or an unknown type.

You can pass one form object or an array of several — each stage gets its own field set, so you
could ask for a booking date early in the conversation and a payment preference later, or an email
early and a phone number later, in the same conversation.

## How the brain is made aware of the schema

This isn't a passive schema the model infers — it's an explicit, mandatory prompt injection.
The Genie brain backend's system-prompt builder walks every configured stage and renders the
`sys_prompt_user_properties` template with that stage's exact field list:

```text
MANDATORY: At the {call_stage} stage of the conversation, you MUST output a
user_properties_form code block enclosed in triple backtick fences exactly as shown below.
This block is REQUIRED in addition to your main response and must NEVER be omitted.
For each field, if you can extract its value from the conversation, add a known_value property.
```

Two things follow directly from this wording, verified against the live template:

- **It's a hard instruction, not a soft hint.** The prompt says "MUST" and "MANDATORY," not
  "consider asking." In practice the model interprets `call_stage` loosely (a `start` stage can
  fire on the very first turn), but it is not free to skip the block once its stage arrives.
- **Pre-fill is real.** If the model has already seen a value for a configured field elsewhere in
  the conversation (e.g. the viewer mentioned their preferred date in passing), it can attach a
  `known_value` to that field, and your form should pre-fill it rather than ask again.

The backend DTO (`UserPropertiesCollectionConfig`, in the Genie brain backend) also
carries a `title` and `secondary_title` with sensible defaults ("A few details about you" /
"Tell me a bit about yourself so I can guide you with content that fits your needs"). **The SDK's
`buildUserPropertiesForms()` does not currently expose either field** — it only accepts
`callStage`/`properties`. If you need a custom title (e.g. "Tell us about your issue" for a
support form), you'd have to bypass the builder and patch `user_properties_forms` directly with
the extra keys; today's SDK surface always falls back to the backend defaults.

## What's possible / what's not

**Possible:**

- Multiple stages (`start`/`middle`/`end`), each with its own field list — and each list can be any
  shape of structured data, not just contact info.
- Six field types (`str`/`int`/`float`/`bool`/`list`/`dict`), plus `email`/`phone`/`text` as
  renderer-side presentation hints.
- A `required` flag and a `description` per field, both consumed by the default renderer for
  `aria-required`/`aria-describedby`.
- Model-side pre-fill (`known_value`) from information already in the transcript.
- Reporting the collected values back over the wire via `session.submitStructuredDataForm(values)` —
  it works identically for any field shape.

**Not possible / not designed for:**

- No conditional logic beyond the model's own judgment — there's no "only ask if X wasn't already
  provided" you can express declaratively.
- No precise timing control. `call_stage` is an instruction the model interprets, not a
  deterministic trigger pinned to a specific turn number.
- Not a general dynamic-form builder — it's a flat list of typed fields per stage, not richer
  patterns (multi-step wizards, validation rules, fields dependent on other fields).
- Editable only through the SDK/`intellect/*` surface — `user_properties_forms` is not in the
  `partner-config/*` DTO at all, so it's authored once at provisioning time via the SDK/Genie
  host, not tunable per-session through that other management surface.

## How the SDK handles it — two observation points, one descriptor

The model's form emission reaches your app through **one of two equivalent paths**, both
normalized to the same shape by the SDK:

1. **The tool-call path** — the model's first emission of the form arrives as a `show_widget`-style
   tool call with `kind: "user_properties_form"`, parsed via `collectConverse()`/`parseToolCall`
   (headless/HTTP converse).
2. **The unisphere-tool segment path** — on the live avatar socket, it arrives as a
   `unisphere-tool` segment with `metadata.runtimeName: "user-properties-form-tool"` (one of the
   nine backend tool keys — see [GENUI-REFERENCE.md](/reference/genui-reference/)).

Both are routed to `ExperienceRenderer` (`src/experience/genui/renderer.js`), which
`normalizeRuntime()`s the runtime name (stripping a trailing `-tool`) and calls the registered
renderer — by default `renderUserPropertiesForm()`
(`src/experience/genui/renderers/user-properties-form.js`). That function is pure and
defensive: it accepts `fields`/`properties`/`items` interchangeably, coerces an unrecognized type
to `'str'`, runs every string through `safeText` (XSS-safe truncation), and drops any field with no
key. The output is a framework-agnostic descriptor:

```js
{ kind: 'user-properties-form', data: { title, fields: [
  { key, type, label, knownValue, required, description }
] } }
```

## How the form is rendered

If you hand `mountWidget` (`src/experience/genui/renderers/mount.js`) a real DOM element as the
mount target, it builds the whole thing for you: one `<form class="kgenui__form">`, one
`<div class="kgenui__field">` per field with a `<label>` and an `<input>` — the input `type` is
inferred from the field type (`email`/`phone`→`tel`/checkbox/etc. via `htmlInputType()`) — wired
`aria-required`/`aria-describedby`, pre-filled from `knownValue`, and a submit button. It never uses
`innerHTML`, so brain-supplied text can't inject markup. On submit, it calls your
`opts.onAction('submit', {values})` callback.

Nothing about the general `user_properties_forms` mechanism described above is the only option.
An app can instead reach the same `user-properties-form` widget through a different path: keep
`kaltura_genie_experiences` off, and expose the widget as one enum value of your own native
`show_widget` **client** tool, with the brain deciding when to call it from your own prompt-level
timing rules — no `call_stage`-driven mandatory injection required.

## How to customize or style the form

Two independent axes:

- **Behavior / DOM structure.** Override the whole renderer function via `ExperienceRenderer`'s
  `renderers` config or its `.register()` method:

  ```js
  renderer.register('user-properties-form', (model) => ({
    kind: 'user-properties-form',
    data: myOwnShape(model),
  }));
  ```

  Or skip the SDK's default DOM builder entirely by passing a mount **function** instead of an
  `Element` — you get the descriptor and build any UI you want (React, a modal, whatever), calling
  `session.submitStructuredDataForm(values)` yourself when the viewer submits.
- **Visual styling.** The default DOM path emits plain, unstyled class names only —
  `.kgenui__form`, `.kgenui__field`, `.kgenui__label`, `.kgenui__input`, `.kgenui__help`,
  `.kgenui__submit`. The SDK ships **zero CSS** — any consumer styles the same class names in
  their own stylesheet.

## Where the submitted data actually goes

`session.submitStructuredDataForm(info)` (`src/experience/session.js`) is a fire-and-forget socket emit —
`this._socket.emit('setFormLeadInfo', sanitizeJson(info))` — with no acknowledgment payload, and no
endpoint on the Genie/agentic management plane reads it back as structured `{key: value}` data. The
conversation transcript is persisted to Postgres by the Genie brain backend (a `Message` table) and
exposed read-only via `POST /thread/get_transcripts` — exactly what this repo's `tools/genie.mjs
thread-transcripts` wraps. That reconstructs a plain-text transcript from `USER`-type message rows;
it does **not** carry the structured form field values, only what the viewer said/typed and the
model's replies — a paraphrase, not the raw object.

**If you need durable, retrievable access to what the viewer submitted, don't rely on
`submitStructuredDataForm`/`setFormLeadInfo`.** Capture-and-forward via your own tool instead — see
[EXTERNAL-API-INTEGRATIONS.md](/guides/external-api-integrations/) for wiring a durable write (a CRM, a
support system, a spreadsheet, or any other external API) directly from the model's own tool call.
That path is a genuine server-side HTTP request the agent makes on your behalf, not a client-side
socket emit, so the data lands wherever you point the tool — no dependence on any surface outside
the Genie/agentic management and conversation planes this toolkit talks to.

A worked pattern: keep the submitted values in browser memory for the current session, but do the
durable write via your own brain-called, server-side `api` tool that posts to whatever external
system you point it at — rather than `setFormLeadInfo`. See
[EXTERNAL-API-INTEGRATIONS.md](/guides/external-api-integrations/) for the general pattern this
specializes.

## Related: `kaltura_genie_experiences` — a different, unrelated capability

If your intellect also uses custom `tool_ids` (e.g. a closed set of client commands like
`navigate_to_slide`/`show_widget`), you'll likely set `capabilities: { kaltura_genie_experiences:
'off' }` or `'disabled'` — see [EXTERNAL-API-INTEGRATIONS.md § Don't skip `kaltura_genie_experiences: 'off'`](/guides/external-api-integrations/#dont-skip-kaltura_genie_experiences-off)
for what that capability does and why.

**This does not touch `user_properties_forms` at all.** The two mechanisms are independent code
paths — `kaltura_genie_experiences` governs backend tool-key families like `flashcards`/
`summarization`/`followups`/`sources`/`gallery_slides`; `user_properties_forms` has its own
dedicated DTO field and its own dedicated prompt injection (`sys_prompt_user_properties`),
unrelated to the experiences capability. Verified live: with `kaltura_genie_experiences: 'disabled'`,
an agent still fires a genuine `show_widget` call with `kind: "user_properties_form"` and a genuine
`user-properties-form-tool` segment. Disabling experiences only removes Genie's own competing
navigation/formatting instinct — it has no effect on structured-data-form logic.

## Related docs

| Doc | What it adds |
|-----|---------------|
| [EXTERNAL-API-INTEGRATIONS.md](/guides/external-api-integrations/) | Wiring a durable, server-side write for the values this doc's forms collect |
| [DYNAMIC-DATA-INJECTION.md](/guides/dynamic-data-injection/) | The opposite direction — feeding data *into* the conversation instead of collecting it |
| [CLIENT-COMMANDS.md](/guides/client-commands/) | The avatar-driving-your-UI channel, a different silent mechanism from this doc's forms |
| [GENUI-REFERENCE.md](/reference/genui-reference/) | The full GenUI runtime map this form is one entry in |
