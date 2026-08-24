/**
 * Prompt-lint — PURE, client-side helpers for authoring the intellect's
 * prompt layer (`prompts[]` + `base_directive` + `glossary`) before it is
 * written via `intellects.update`/`setPrompts`. No network, no KS, no state:
 * every export is a deterministic function over plain data.
 *
 * The renderer these helpers mirror lives server-side in Genie (the
 * partner-prompt/system-prompt builder):
 *   - each prompt block renders as `## {headerTemplate}\n{value}`, joined;
 *   - blocks with an empty `value` OR empty `headerTemplate` are SKIPPED;
 *   - `base_directive` is prepended (server falls back to its built-in
 *     directive when empty — NOT reproducible client-side);
 *   - `glossary`, when set, is wrapped by `sys_prompt_glossary` and appended;
 *   - `{{var}}` placeholders are interpolated last (`apply_variables()`).
 *
 * LIMITATION: {@link assembleSystemPrompt} reproduces ONLY this author layer. It CANNOT
 * reproduce the capability-conditional Jinja blocks (video_gallery /
 * avatar_show_content / web_search_enabled / user_properties) that Genie
 * injects server-side, nor the server's built-in default base_directive. The
 * result is a `client-side-replica`, never byte-exact — callers must treat it
 * as a preview, not a contract.
 */
import { KalturaError } from '../core/errors.js';
import { meta } from '../core/ids.js';
import { RESERVED_VARS } from './conversations.js';

/**
 * Server-provided variable namespaces addressed by a dotted prefix (e.g.
 * `{{secrets.MY_KEY}}`). `secrets` is injected server-side as
 * `variables["secrets"]`, so a dotted reference under it is NOT a client
 * variable and never needs `allow_client_variables`.
 * @type {readonly string[]}
 */
export const SYS_NAMESPACES = Object.freeze(['secrets']);

/**
 * Reserved variable names the SERVER sets on every turn (always available to
 * `{{...}}` interpolation regardless of `allow_client_variables`). Derived
 * from {@link RESERVED_VARS} (the single source of truth, shared with
 * `assertRequestVars`'s request_vars collision check) minus the dotted
 * namespaces in {@link SYS_NAMESPACES}.
 * @type {readonly string[]}
 */
export const SYS_VARS = Object.freeze(RESERVED_VARS.filter((v) => !SYS_NAMESPACES.includes(v)));

const SYS_VAR_SET = new Set(SYS_VARS);
const SYS_NS_SET = new Set(SYS_NAMESPACES);
const SOURCE = 'prompt-lint';

/**
 * The two additional server-set scalar `sys__*` variables confirmed live but
 * not yet part of {@link RESERVED_VARS} (see issue #37) — `sys__ks` (the raw
 * session token) and `sys__is_new_thread`. Combined with {@link SYS_VARS} this
 * is the full known-reserved-scalar surface {@link assembleSystemPrompt} uses
 * to flag an unresolvable reference (see issue #45); it does NOT feed
 * `assertRequestVars`'s collision guard — that list is tracked separately in
 * `conversations.js` and extending it is out of scope here.
 * @type {readonly string[]}
 */
const RESERVED_EXTRA_SCALARS = Object.freeze(['sys__ks', 'sys__is_new_thread']);
const RESERVED_SCALAR_SET = new Set([...SYS_VARS, ...RESERVED_EXTRA_SCALARS]);

/** Dotted prefix for the reserved bound-user object (see issue #37). */
const RESERVED_USER_OBJ_PREFIX = 'sys__user_obj';

/**
 * Attributes of the reserved `sys__user_obj` variable confirmed live (see
 * issue #37). Referencing an unbound attribute in a live turn today causes a
 * silent turn failure, not an empty render — {@link assembleSystemPrompt}
 * flags this case explicitly rather than letting the preview look harmless.
 * @type {readonly string[]}
 */
export const RESERVED_USER_OBJ_ATTRS = Object.freeze(['first_name', 'last_name', 'title', 'company', 'gender', 'email']);

/**
 * Classify a `{{name}}` reference as one of the known reserved-variable kinds
 * simulated by {@link assembleSystemPrompt} (scalar `sys__*`, a `sys__user_obj.*`
 * attribute, or a `secrets.*` named secret), or `null` when it is an ordinary
 * client variable. PURE — no network, no state. @param {string} name
 * @returns {{kind:'scalar'}|{kind:'userObjAttr', attr:string}|{kind:'secret', secretName:string}|null}
 */
function classifyReservedVar(name) {
  if (RESERVED_SCALAR_SET.has(name)) return { kind: 'scalar' };
  if (name.startsWith(`${RESERVED_USER_OBJ_PREFIX}.`)) {
    const attr = name.slice(RESERVED_USER_OBJ_PREFIX.length + 1);
    if (RESERVED_USER_OBJ_ATTRS.includes(attr)) return { kind: 'userObjAttr', attr };
    return null;
  }
  if (name.startsWith('secrets.')) return { kind: 'secret', secretName: name.slice('secrets.'.length) };
  return null;
}

/**
 * Build the `LintFinding`-shaped warning for an unresolved reserved-variable
 * reference. Names the variable only — NEVER a value — even when one happens
 * to be present but falsy (relevant for `sys__ks`, a raw session token; see
 * issue #37). PURE. @param {string} name @param {{kind:string, attr?:string, secretName?:string}} info
 * @returns {LintFinding}
 */
function reservedVarWarning(name, info) {
  if (info.kind === 'userObjAttr') {
    return {
      severity: 'warning',
      code: 'reserved_user_attr_unresolved',
      message: `\`{{${name}}}\` has no bound value in this preview's requestVars. Referencing an unbound sys__user_obj.* attribute in a LIVE turn currently causes a silent turn failure, not an empty render (see issue #37) — bind a user (Sessions.createConversationToken({userId})) or supply "${name}" in requestVars to simulate the bound case before shipping this prompt.`,
    };
  }
  if (info.kind === 'secret') {
    return {
      severity: 'warning',
      code: 'reserved_secret_unresolved',
      message: `\`{{${name}}}\` has no value in this preview's requestVars. previewPrompt() cannot read secret values (write-only) to confirm "${info.secretName}" is configured — check intellects.secrets.listNames() before shipping; live-turn behavior for an unset secret is unconfirmed (not verified against a real backend) — treat "${info.secretName}" as unresolved rather than assuming it renders empty.`,
    };
  }
  return {
    severity: 'warning',
    code: 'reserved_var_unresolved',
    message: `\`{{${name}}}\` is a reserved system variable with no value in this preview's requestVars — it renders as an empty/literal placeholder here, which may not match its live behavior. Supply "${name}" in requestVars to simulate the value the server would set.`,
  };
}

/**
 * One finding from a lint pass.
 * @typedef {object} LintFinding
 * @property {'error'|'warning'} severity
 * @property {string} code            Stable machine-readable code.
 * @property {string} message         Human-readable explanation.
 * @property {string} [path]          Where it was found (e.g. `prompts[2].value`).
 */

/** @param {unknown} v */
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @param {LintFinding[]} findings */
function summarize(findings) {
  let errors = 0;
  let warnings = 0;
  for (const f of findings) {
    if (f.severity === 'error') errors++;
    else warnings++;
  }
  return { errors, warnings, ok: errors === 0 };
}

/**
 * Scan a string for `{{ ... }}` template references. Recognizes the two
 * documented syntaxes: a bare name (`{{user_name}}`) and a dotted namespace
 * reference (`{{secrets.MY_KEY}}`). Flags malformed `{{` that is never closed.
 *
 * @param {string} text
 * @param {{allowClientVariables?: boolean, knownVars?: string[], path?: string}} [opts]
 *   `allowClientVariables` (default `true`) mirrors the intellect's
 *   `allow_client_variables` gate: when `false`, any non-system variable is a
 *   `client_variable_not_allowed` ERROR (a converse call sending it gets HTTP
 *   403). `knownVars` are additional names you expect to inject at request
 *   time; an unknown client variable is a `unknown_variable` WARNING.
 * @returns {{
 *   ok: boolean,
 *   variables: string[],
 *   systemVariables: string[],
 *   clientVariables: string[],
 *   findings: LintFinding[],
 *   _meta: ReturnType<typeof meta>,
 * }}
 */
export function validatePromptVars(text, opts = {}) {
  if (typeof text !== 'string') {
    throw new KalturaError({
      type: 'about:blank',
      title: 'string required',
      code: 'bad_request',
      detail: `validatePromptVars(text) expects a string, got ${typeof text}.`,
    });
  }
  if (!isPlainObject(opts)) {
    throw new KalturaError({
      type: 'about:blank',
      title: 'object required',
      code: 'bad_request',
      detail: 'validatePromptVars opts must be an object.',
    });
  }
  const allow = opts.allowClientVariables !== false;
  const known = new Set(Array.isArray(opts.knownVars) ? opts.knownVars : []);
  const pathPrefix = typeof opts.path === 'string' && opts.path ? `${opts.path} ` : '';

  /** @type {LintFinding[]} */
  const findings = [];
  const all = [];
  const system = [];
  const client = [];
  const seen = new Set();

  // Detect malformed `{{` with no matching `}}` before the next `{{` / EOF.
  const malformed = /\{\{(?:(?!\}\})[\s\S])*$/.test(text) && text.lastIndexOf('{{') > text.lastIndexOf('}}');
  if (malformed) {
    findings.push({
      severity: 'error',
      code: 'malformed_variable',
      message: 'Unclosed `{{` — every variable reference must be closed with `}}`.',
      path: opts.path || undefined,
    });
  }

  const re = /\{\{\s*([^{}]*?)\s*\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    if (raw === '') {
      findings.push({
        severity: 'error',
        code: 'empty_variable',
        message: 'Empty `{{}}` reference — supply a variable name.',
        path: opts.path || undefined,
      });
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(raw)) {
      findings.push({
        severity: 'error',
        code: 'malformed_variable',
        message: `\`{{${raw}}}\` is not a valid variable name (expected \`name\` or \`namespace.name\`).`,
        path: opts.path || undefined,
      });
      continue;
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      all.push(raw);
    }

    const dot = raw.indexOf('.');
    const ns = dot >= 0 ? raw.slice(0, dot) : '';
    const isSystem = SYS_VAR_SET.has(raw) || (ns && SYS_NS_SET.has(ns));
    if (isSystem) {
      if (!system.includes(raw)) system.push(raw);
      continue;
    }

    // A client variable.
    if (!client.includes(raw)) client.push(raw);
    if (!allow) {
      findings.push({
        severity: 'error',
        code: 'client_variable_not_allowed',
        message: `\`{{${raw}}}\` is a client variable but allow_client_variables is off — a converse call sending it returns HTTP 403.`,
        path: opts.path || undefined,
      });
    } else if (!known.has(raw)) {
      findings.push({
        severity: 'warning',
        code: 'unknown_variable',
        message: `${pathPrefix}\`{{${raw}}}\` is not a system variable and is not in knownVars — it renders empty unless supplied as a request variable.`,
        path: opts.path || undefined,
      });
    }
  }

  const sum = summarize(findings);
  return {
    ok: sum.ok,
    variables: all,
    systemVariables: system,
    clientVariables: client,
    findings,
    _meta: meta({ source: SOURCE, scope: 'prompt-vars', renderer: 'client-side-replica' }),
  };
}

/**
 * Lint a `prompts[]` list (the `List[DynamicPrompt]` DTO). Each block must be
 * `{key, label, headerTemplate, type:"custom", value}`. Surfaces structural
 * errors (missing/empty key, wrong/missing `type`, duplicate keys) and
 * renderer-skip WARNINGS (empty `value` OR empty `headerTemplate` ⇒ the server
 * silently drops the block), plus every `{{var}}` finding per block.
 *
 * @param {Array<object>} prompts
 * @param {{allowClientVariables?: boolean, knownVars?: string[]}} [opts]
 * @returns {{
 *   ok: boolean,
 *   summary: {errors:number, warnings:number, ok:boolean},
 *   findings: LintFinding[],
 *   variables: string[],
 *   skippedKeys: string[],
 *   _meta: ReturnType<typeof meta>,
 * }}
 */
export function lintPrompts(prompts, opts = {}) {
  if (!Array.isArray(prompts)) {
    throw new KalturaError({
      type: 'about:blank',
      title: 'array required',
      code: 'bad_request',
      detail: 'lintPrompts(prompts) expects an array of prompt blocks (full-replace list).',
    });
  }
  if (!isPlainObject(opts)) {
    throw new KalturaError({
      type: 'about:blank',
      title: 'object required',
      code: 'bad_request',
      detail: 'lintPrompts opts must be an object.',
    });
  }

  /** @type {LintFinding[]} */
  const findings = [];
  const variables = [];
  const skippedKeys = [];
  const keySeen = new Map();

  prompts.forEach((block, i) => {
    const path = `prompts[${i}]`;
    if (!isPlainObject(block)) {
      findings.push({ severity: 'error', code: 'invalid_block', message: `${path} must be an object {key,label,headerTemplate,type:"custom",value}.`, path });
      return;
    }
    const key = block.key;
    if (typeof key !== 'string' || key.trim() === '') {
      findings.push({ severity: 'error', code: 'missing_key', message: `${path}.key is required and must be a non-empty string.`, path: `${path}.key` });
    } else {
      const prev = keySeen.get(key);
      if (prev !== undefined) {
        findings.push({ severity: 'warning', code: 'duplicate_key', message: `${path}.key "${key}" duplicates ${prev}.key — keys should be unique for stable editing/diffing.`, path: `${path}.key` });
      } else {
        keySeen.set(key, path);
      }
    }

    if (block.type !== undefined && block.type !== 'custom') {
      findings.push({ severity: 'error', code: 'bad_type', message: `${path}.type must be "custom" (got ${JSON.stringify(block.type)}).`, path: `${path}.type` });
    } else if (block.type === undefined) {
      findings.push({ severity: 'warning', code: 'missing_type', message: `${path}.type should be "custom" (the only DynamicPrompt type).`, path: `${path}.type` });
    }

    if (block.label !== undefined && typeof block.label !== 'string') {
      findings.push({ severity: 'error', code: 'bad_label', message: `${path}.label must be a string when present.`, path: `${path}.label` });
    }

    const header = typeof block.headerTemplate === 'string' ? block.headerTemplate : '';
    const value = typeof block.value === 'string' ? block.value : '';
    if (block.headerTemplate !== undefined && typeof block.headerTemplate !== 'string') {
      findings.push({ severity: 'error', code: 'bad_header', message: `${path}.headerTemplate must be a string when present.`, path: `${path}.headerTemplate` });
    }
    if (block.value !== undefined && typeof block.value !== 'string') {
      findings.push({ severity: 'error', code: 'bad_value', message: `${path}.value must be a string when present.`, path: `${path}.value` });
    }

    const skipped = header.trim() === '' || value.trim() === '';
    if (skipped) {
      if (typeof key === 'string' && key) skippedKeys.push(key);
      const why = header.trim() === '' && value.trim() === '' ? 'both headerTemplate and value are empty'
        : header.trim() === '' ? 'headerTemplate is empty'
          : 'value is empty';
      findings.push({ severity: 'warning', code: 'renderer_skip', message: `${path} will be SKIPPED by the renderer (${why}) — it contributes nothing to the system prompt.`, path });
    }

    // Variable scan over both the header and the value (both are interpolated).
    for (const [field, txt] of [['headerTemplate', header], ['value', value]]) {
      if (txt.indexOf('{{') < 0) continue;
      const v = validatePromptVars(txt, { allowClientVariables: opts.allowClientVariables, knownVars: opts.knownVars, path: `${path}.${field}` });
      for (const f of v.findings) findings.push({ ...f, path: f.path || `${path}.${field}` });
      for (const name of v.variables) if (!variables.includes(name)) variables.push(name);
    }
  });

  const summary = summarize(findings);
  return {
    ok: summary.ok,
    summary,
    findings,
    variables,
    skippedKeys,
    _meta: meta({ source: SOURCE, scope: 'prompts', renderer: 'client-side-replica' }),
  };
}

/**
 * Lint a glossary string. The glossary is a CLIENT HINT only — it is injected
 * verbatim (wrapped by `sys_prompt_glossary`) and is NOT a server contract, so
 * this only reports a detected `format` (`json` | `text`) and any `{{var}}`
 * findings. A glossary that PARSES as JSON but is not an object/array is
 * flagged as a `format` note (likely a stray value), never an error.
 *
 * @param {string} glossary
 * @param {{allowClientVariables?: boolean, knownVars?: string[]}} [opts]
 * @returns {{
 *   ok: boolean,
 *   format: 'json'|'text'|'empty',
 *   findings: LintFinding[],
 *   variables: string[],
 *   _meta: ReturnType<typeof meta>,
 * }}
 */
export function lintGlossary(glossary, opts = {}) {
  if (typeof glossary !== 'string') {
    throw new KalturaError({
      type: 'about:blank',
      title: 'string required',
      code: 'bad_request',
      detail: `lintGlossary(glossary) expects a string, got ${typeof glossary}.`,
    });
  }
  if (!isPlainObject(opts)) {
    throw new KalturaError({
      type: 'about:blank',
      title: 'object required',
      code: 'bad_request',
      detail: 'lintGlossary opts must be an object.',
    });
  }

  /** @type {LintFinding[]} */
  const findings = [];
  const variables = [];
  const trimmed = glossary.trim();

  /** @type {'json'|'text'|'empty'} */
  let format = 'text';
  if (trimmed === '') {
    format = 'empty';
  } else if (/^[[{]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isPlainObject(parsed) || Array.isArray(parsed)) {
        format = 'json';
        findings.push({ severity: 'warning', code: 'glossary_format', message: 'Glossary parses as JSON — note it is injected as a verbatim string hint, not parsed as a server-side map.' });
      }
    } catch {
      findings.push({ severity: 'warning', code: 'glossary_format', message: 'Glossary starts like JSON but does not parse — it will be injected verbatim as text.' });
    }
  }

  if (glossary.indexOf('{{') >= 0) {
    const v = validatePromptVars(glossary, { allowClientVariables: opts.allowClientVariables, knownVars: opts.knownVars, path: 'glossary' });
    for (const f of v.findings) findings.push({ ...f, path: f.path || 'glossary' });
    for (const name of v.variables) if (!variables.includes(name)) variables.push(name);
  }

  return {
    ok: summarize(findings).ok,
    format,
    findings,
    variables,
    _meta: meta({ source: SOURCE, scope: 'glossary', renderer: 'client-side-replica' }),
  };
}

// Common sentence-initial words that would otherwise be misread as a
// capitalized proper name (see issue #17 test case "no proper name present").
const GREETING_STOPWORDS = new Set([
  'Hi', 'Hello', 'Hey', 'Hiya', 'Welcome', 'Greetings', 'Good', 'Thanks', 'Thank',
  'You', 'Your', 'Yours', 'My', 'Please', 'Sure', 'Sorry', 'How', 'What', 'Why',
  'When', 'Where', 'Who', 'Can', 'Could', 'Would', 'Will', 'Let', 'Today', 'Here',
  'This', 'That', 'It', 'The', 'A', 'An', 'Ready', 'Happy', 'Excited', 'I',
]);

/** @param {string} word */
function bareName(word) {
  return word.replace(/(?:'s|’s)$/, '');
}

/**
 * Extract a proper name from free text (an `openingPhrase`), or `null` when
 * no plausible name is found — deliberately conservative, since a false
 * "detected name" would produce a false-positive warning downstream.
 * Recognizes, in priority order: (1) a self-introduction ("I'm X", "my name
 * is X"), (2) a possessive form ("X's"), (3) any other capitalized word not
 * in {@link GREETING_STOPWORDS} and not at the start of a sentence (sentence-
 * initial capitals — "How", "Thanks", or an exclamation like "Namaste!" — are
 * structurally common and not names; a name is only inferred mid-sentence).
 * @param {string} text
 * @returns {string|null}
 */
function extractProperName(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;

  const selfIntro = text.match(/\b(?:I'm|I am|my name is|this is)\s+([A-Z][a-zA-Z]*(?:'s|’s)?)/i);
  if (selfIntro && !GREETING_STOPWORDS.has(bareName(selfIntro[1]))) return bareName(selfIntro[1]);

  const possessive = text.match(/\b([A-Z][a-zA-Z]*(?:'s|’s))\b/);
  if (possessive && !GREETING_STOPWORDS.has(bareName(possessive[1]))) return bareName(possessive[1]);

  const tokens = text.split(/\s+/);
  let sentenceStart = true;
  for (const raw of tokens) {
    const word = raw.replace(/^[^A-Za-z]+|[^A-Za-z']+$/g, '');
    const isCapitalized = /^[A-Z][a-zA-Z]*$/.test(word);
    if (isCapitalized && !GREETING_STOPWORDS.has(word) && !sentenceStart) {
      return word;
    }
    sentenceStart = /[.!?]$/.test(raw);
  }
  return null;
}

/**
 * Lint persona-name consistency across `name` / `openingPhrase` /
 * `baseDirective` / `prompts[].value`. HEURISTIC (warning-only, never
 * blocking). Two independent checks, each with its own trigger:
 *   - `persona_name_mismatch`: only when {@link extractProperName} finds a
 *     name in `openingPhrase` (`detectedName`) AND a declared `name` is also
 *     given AND they disagree — needs both fields, since it is comparing one
 *     against the other.
 *   - `persona_name_drift`: neither `baseDirective` nor any `prompts[].value`
 *     mention a name that should be there. Runs once per name in play — off
 *     the declared `name` whenever one is given (independent of
 *     `openingPhrase`; see issue #32 — a caller with no `openingPhrase`, or
 *     one `extractProperName` can't parse a name out of, still gets a real
 *     check), and separately off `detectedName` when it differs from the
 *     declared name (skipped when they match, so a single rename shows one
 *     finding, not two).
 * Absence of a detectable name in `openingPhrase` never blocks the
 * `name`-based drift check, and never itself warns (avoids false positives
 * on a coincidence of phrasing rather than an actual rename). An empty
 * `baseDirective`+`prompts[]` haystack skips drift entirely — nothing to
 * compare against yet is not evidence of a rename.
 *
 * @param {{name?:string, openingPhrase?:string, baseDirective?:string, prompts?:Array<{value?:string}>}} input
 * @returns {{
 *   ok: boolean,
 *   summary: {errors:number, warnings:number, ok:boolean},
 *   findings: LintFinding[],
 *   detectedName: string|null,
 *   _meta: ReturnType<typeof meta>,
 * }}
 */
export function lintPersonaIdentity(input) {
  if (!isPlainObject(input)) {
    throw new KalturaError({
      type: 'about:blank',
      title: 'object required',
      code: 'bad_request',
      detail: 'lintPersonaIdentity(input) expects an object {name?, openingPhrase?, baseDirective?, prompts?}.',
    });
  }
  const { name, openingPhrase, baseDirective, prompts } = input;

  /** @type {LintFinding[]} */
  const findings = [];
  const detectedName = extractProperName(typeof openingPhrase === 'string' ? openingPhrase : '');
  const declaredName = typeof name === 'string' && name.trim() !== '' ? name.trim() : null;

  if (detectedName && declaredName && declaredName !== detectedName) {
    findings.push({
      severity: 'warning',
      code: 'persona_name_mismatch',
      message: `openingPhrase names "${detectedName}" but the declared persona name is "${declaredName}" — a persona rename may be incomplete.`,
      path: 'openingPhrase',
    });
  }

  const promptValues = Array.isArray(prompts)
    ? prompts.filter((p) => isPlainObject(p) && typeof p.value === 'string').map((p) => p.value)
    : [];
  const haystack = [typeof baseDirective === 'string' ? baseDirective : '', ...promptValues].join(' ');

  if (declaredName && haystack.trim() !== '' && !haystack.includes(declaredName)) {
    findings.push({
      severity: 'warning',
      code: 'persona_name_drift',
      message: `Declared persona name "${declaredName}" is not mentioned in base_directive/prompts[] — a persona rename may be incomplete.`,
      path: 'name',
    });
  }
  if (detectedName && detectedName !== declaredName && haystack.trim() !== '' && !haystack.includes(detectedName)) {
    findings.push({
      severity: 'warning',
      code: 'persona_name_drift',
      message: `openingPhrase names "${detectedName}" but base_directive/prompts[] never mention it — a persona rename may be incomplete.`,
      path: 'openingPhrase',
    });
  }

  const summary = summarize(findings);
  return {
    ok: summary.ok,
    summary,
    findings,
    detectedName,
    _meta: meta({ source: SOURCE, scope: 'persona-identity' }),
  };
}

/** Marker rendered in place of the server's built-in default directive. */
export const SERVER_DEFAULT_DIRECTIVE_MARKER = '<<server default directive>>';

/**
 * Assemble a CLIENT-SIDE REPLICA of the AUTHOR layer of the system prompt.
 * Renders each non-skipped prompt block as `## {headerTemplate}\n{value}`,
 * joins them with a blank line, prepends `base_directive`, and appends the
 * glossary — mirroring `get_partner_prompts()`/`get_system_prompt()`.
 *
 * LIMITATIONS:
 *   - This is `client-side-replica`, NOT byte-exact. It does NOT reproduce the
 *     server's capability-conditional Jinja blocks (video_gallery /
 *     avatar_show_content / web_search_enabled / user_properties), which are
 *     injected server-side and are not reproducible here.
 *   - When `base_directive` is empty, the server falls back to its built-in
 *     directive; rather than fabricate it, this renders
 *     {@link SERVER_DEFAULT_DIRECTIVE_MARKER}.
 *   - `{{var}}` placeholders are interpolated ONLY when you pass `requestVars`
 *     (system vars too); otherwise they are left literal. `sys__*` values you
 *     pass are a SIMULATION of what the server sets per turn.
 *   - HARDENING (issue #45): a reference to a known reserved variable
 *     (`sys__thread_id`/`sys__message_id`/`sys__user_id`/`sys__user_message`/
 *     `sys__ks`/`sys__is_new_thread`, a `sys__user_obj.*` attribute, or a
 *     `secrets.*` name) with no value in `requestVars` is flagged in the
 *     returned `warnings[]` — distinct from an ordinary unresolved client
 *     variable, since the same reference would misbehave live (for
 *     `sys__user_obj.*`, a silent whole-turn failure — see issue #37).
 *     `warnings` is present ONLY when non-empty, so a fully-resolved preview's
 *     return shape is unchanged from before this hardening.
 *
 * @param {{
 *   prompts?: Array<object>,
 *   baseDirective?: string,
 *   glossary?: string,
 *   requestVars?: Record<string, unknown>,
 *   interpolate?: boolean,
 * }} subset
 *   A subset of the intellect config: `prompts` (camelCase blocks),
 *   `baseDirective` (the `base_directive`/`sys_prompt_base_directive` string),
 *   `glossary`. `requestVars` supply interpolation values (set `interpolate`
 *   false to keep `{{...}}` literal even when vars are provided).
 * @returns {{
 *   text: string,
 *   skippedKeys: string[],
 *   usedDefaultDirective: boolean,
 *   unresolvedVariables: string[],
 *   warnings?: LintFinding[],
 *   _meta: ReturnType<typeof meta>,
 * }}
 */
export function assembleSystemPrompt(subset = {}) {
  if (!isPlainObject(subset)) {
    throw new KalturaError({
      type: 'about:blank',
      title: 'object required',
      code: 'bad_request',
      detail: 'assembleSystemPrompt expects a config subset object {prompts?,baseDirective?,glossary?,requestVars?}.',
    });
  }
  const prompts = subset.prompts === undefined ? [] : subset.prompts;
  if (!Array.isArray(prompts)) {
    throw new KalturaError({
      type: 'about:blank',
      title: 'array required',
      code: 'bad_request',
      detail: 'assembleSystemPrompt prompts must be an array when present.',
    });
  }
  if (subset.baseDirective !== undefined && typeof subset.baseDirective !== 'string') {
    throw new KalturaError({
      type: 'about:blank',
      title: 'string required',
      code: 'bad_request',
      detail: 'assembleSystemPrompt baseDirective must be a string when present.',
    });
  }
  if (subset.glossary !== undefined && typeof subset.glossary !== 'string') {
    throw new KalturaError({
      type: 'about:blank',
      title: 'string required',
      code: 'bad_request',
      detail: 'assembleSystemPrompt glossary must be a string when present.',
    });
  }

  const baseDirective = typeof subset.baseDirective === 'string' ? subset.baseDirective : '';
  const glossary = typeof subset.glossary === 'string' ? subset.glossary : '';
  const usedDefaultDirective = baseDirective.trim() === '';

  const parts = [];
  parts.push(usedDefaultDirective ? SERVER_DEFAULT_DIRECTIVE_MARKER : baseDirective.trim());

  const skippedKeys = [];
  for (const block of prompts) {
    const header = isPlainObject(block) && typeof block.headerTemplate === 'string' ? block.headerTemplate : '';
    const value = isPlainObject(block) && typeof block.value === 'string' ? block.value : '';
    if (header.trim() === '' || value.trim() === '') {
      if (isPlainObject(block) && typeof block.key === 'string' && block.key) skippedKeys.push(block.key);
      continue;
    }
    parts.push(`## ${header}\n${value}`);
  }

  if (glossary.trim() !== '') parts.push(glossary);

  let text = parts.join('\n\n');

  // Interpolation (last step, mirroring apply_variables()).
  const unresolved = [];
  const warnings = [];
  const warnedReserved = new Set();
  const interpolate = subset.interpolate !== false && isPlainObject(subset.requestVars);
  const vars = isPlainObject(subset.requestVars) ? subset.requestVars : {};
  text = text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g, (whole, name) => {
    // HARDENING (issue #45): flag a known reserved variable with no value
    // available in this simulated context — independent of `interpolate`
    // (a caller who set interpolate:false but DID supply a value still has a
    // resolvable simulation; only an ABSENT/null/undefined value warrants a
    // warning).
    const hasValue = Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== null && vars[name] !== undefined;
    if (!hasValue && !warnedReserved.has(name)) {
      const reserved = classifyReservedVar(name);
      if (reserved) {
        warnedReserved.add(name);
        warnings.push(reservedVarWarning(name, reserved));
      }
    }
    if (interpolate && Object.prototype.hasOwnProperty.call(vars, name)) {
      const v = vars[name];
      return v === null || v === undefined ? '' : String(v);
    }
    if (!unresolved.includes(name)) unresolved.push(name);
    return whole;
  });

  return {
    text,
    skippedKeys,
    usedDefaultDirective,
    unresolvedVariables: unresolved,
    ...(warnings.length ? { warnings } : {}),
    _meta: meta({
      source: SOURCE,
      scope: 'system-prompt',
      renderer: 'client-side-replica',
      rendererBasis: 'get_partner_prompts/get_system_prompt (author layer only)',
      note: 'Author layer only — server-injected capability-conditional Jinja blocks and the built-in default directive are NOT reproduced; not byte-exact.',
    }),
  };
}
