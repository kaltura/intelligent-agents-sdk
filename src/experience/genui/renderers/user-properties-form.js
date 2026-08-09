/**
 * Default renderer for the `user-properties-form` runtime
 * (UNISPHERE_TOOLS["user_properties_form"] → `user-properties-form-tool`). A
 * structured-data form the model emits per `user_properties_forms`. Each field
 * is `{key, type, label, knownValue}` (the model may pre-fill a `known_value` it
 * already extracted). The host renders inputs, collects, and reports back via
 * `session.submitStructuredDataForm`. Framework-agnostic `{kind:'user-properties-form', data}`.
 */
import { safeText } from '../../../core/safety.js';

const FIELD_TYPES = new Set(['str', 'int', 'float', 'bool', 'list', 'dict', 'email', 'phone', 'text']);

/**
 * @param {Record<string, unknown>} model
 * @returns {{kind:'user-properties-form', data:{title:string, fields:Array<{key:string,type:string,label:string,knownValue:string,required:boolean,description:string}>}}}
 */
export function renderUserPropertiesForm(model = {}) {
  if (!model || typeof model !== 'object') model = {};   // total over null/scalars
  const src = Array.isArray(model.fields) ? model.fields
    : Array.isArray(model.properties) ? model.properties
      : Array.isArray(model.items) ? model.items
        : [];
  const fields = src.map((f) => {
    const o = (f && typeof f === 'object') ? /** @type {Record<string,unknown>} */ (f) : { key: f };
    const key = safeText(o.key ?? o.name ?? '', 200);
    const rawType = safeText(o.type ?? 'str', 50).toLowerCase();
    return {
      key,
      type: FIELD_TYPES.has(rawType) ? rawType : 'str',
      label: safeText(o.label ?? o.prompt ?? key, 300),
      knownValue: safeText(o.knownValue ?? o.known_value ?? '', 1000),
      // a11y contract: lets a host wire aria-required / aria-describedby / inputmode
      required: o.required === true,
      description: safeText(o.description ?? o.help ?? '', 500),
    };
  }).filter((f) => f.key);
  return { kind: 'user-properties-form', data: { title: safeText(model.title ?? '', 300), fields } };
}
