/**
 * Default renderer for the `user-properties-form` runtime
 * (`user-properties-form-tool`). A
 * structured-data form the model emits per `user_properties_forms`. Each field
 * is `{key, type, label, knownValue}` (the model may pre-fill a `known_value` it
 * already extracted). The host renders inputs, collects, and reports back via
 * `session.submitStructuredDataForm`. `formId` (from `form_id`) identifies the
 * form and is passed back on submit. Framework-agnostic `{kind:'user-properties-form', data}`.
 */
import { safeText } from '../../../core/safety.js';
import { FORM_FIELD_TYPE_NAMES } from '../../../core/stream.js';

const FIELD_TYPES = new Set(FORM_FIELD_TYPE_NAMES);

/**
 * A form id is a non-negative integer (0 is valid). A digit string of 1 to 9
 * digits is accepted and converted. Anything else is null.
 * @param {unknown} v
 * @returns {number|null}
 */
function toFormId(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && /^\d{1,9}$/.test(v)) return Number(v);
  return null;
}

/**
 * @param {Record<string, unknown>} model
 * @returns {{kind:'user-properties-form', data:{title:string, secondaryTitle:string, formId:number|null, fields:Array<{key:string,type:string,label:string,knownValue:string,required:boolean,description:string}>}}}
 */
export function renderUserPropertiesForm(model = {}) {
  if (!model || typeof model !== 'object') model = {};   // total over null/scalars
  const src = Array.isArray(model.fields) ? model.fields
    : Array.isArray(model.properties) ? model.properties
      : Array.isArray(model.items) ? model.items
        : [];
  const fields = src.map((f) => {
    const o = /** @type {Record<string,unknown>} */ ((f && typeof f === 'object') ? f : { key: f });
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
  return {
    kind: 'user-properties-form',
    data: {
      title: safeText(model.title ?? '', 300),
      secondaryTitle: safeText(model.secondary_title ?? model.secondaryTitle ?? '', 300),
      formId: toFormId(model.form_id ?? model.formId),
      fields,
    },
  };
}
