import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYS_VARS,
  SYS_NAMESPACES,
  SERVER_DEFAULT_DIRECTIVE_MARKER,
  RESERVED_USER_OBJ_ATTRS,
  validatePromptVars,
  lintPrompts,
  lintGlossary,
  lintPersonaIdentity,
  assembleSystemPrompt,
  PAGE_CONTEXT_PROMPT,
} from '../../src/management/prompt-lint.js';

/** Pure prompt-authoring lint/preview helpers. No network, no KS. */

const hasFinding = (findings, code) => findings.some((f) => f.code === code);

test('SYS_VARS / SYS_NAMESPACES are the documented frozen reserved sets', () => {
  assert.deepEqual([...SYS_VARS], ['sys__thread_id', 'sys__message_id', 'sys__user_id', 'sys__user_message']);
  assert.deepEqual([...SYS_NAMESPACES], ['secrets']);
  assert.throws(() => { SYS_VARS.push('x'); });
});

test('validatePromptVars separates system, namespace and client vars', () => {
  const r = validatePromptVars('Hi {{sys__user_id}} re {{secrets.API_KEY}} and {{topic}}');
  assert.equal(r.ok, true); // client vars allowed by default → warnings only
  assert.deepEqual(r.systemVariables, ['sys__user_id', 'secrets.API_KEY']);
  assert.deepEqual(r.clientVariables, ['topic']);
  assert.deepEqual(r.variables, ['sys__user_id', 'secrets.API_KEY', 'topic']);
  assert.equal(hasFinding(r.findings, 'unknown_variable'), true);
});

test('validatePromptVars: knownVars suppresses the unknown_variable warning', () => {
  const r = validatePromptVars('Hello {{topic}}', { knownVars: ['topic'] });
  assert.equal(r.findings.length, 0);
  assert.deepEqual(r.clientVariables, ['topic']);
});

test('validatePromptVars: client var with allow_client_variables off is an ERROR (silent-empty-turn gate)', () => {
  const r = validatePromptVars('Hello {{topic}}', { allowClientVariables: false });
  assert.equal(r.ok, false);
  assert.equal(hasFinding(r.findings, 'client_variable_not_allowed'), true);
  // Failure mode: the gate does NOT return HTTP 403 — the turn
  // completes empty with no error. The message must say so, not claim a 403.
  const f = r.findings.find((x) => x.code === 'client_variable_not_allowed');
  assert.match(f.message, /SILENT EMPTY TURN/);
  assert.doesNotMatch(f.message, /403/);
});

test('validatePromptVars: system vars stay allowed even when client vars are off', () => {
  const r = validatePromptVars('Hi {{sys__user_message}} {{secrets.K}}', { allowClientVariables: false });
  assert.equal(r.ok, true);
  assert.equal(r.clientVariables.length, 0);
});

test('validatePromptVars flags malformed and empty references', () => {
  const unclosed = validatePromptVars('start {{oops');
  assert.equal(unclosed.ok, false);
  assert.equal(hasFinding(unclosed.findings, 'malformed_variable'), true);

  const empty = validatePromptVars('a {{}} b');
  assert.equal(hasFinding(empty.findings, 'empty_variable'), true);

  const bad = validatePromptVars('a {{1bad}} b');
  assert.equal(hasFinding(bad.findings, 'malformed_variable'), true);
});

test('validatePromptVars flags an earlier unclosed {{ even when a later {{...}} is closed', () => {
  const r = validatePromptVars('{{oops unclosed and then {{valid}} elsewhere');
  assert.equal(r.ok, false);
  assert.equal(hasFinding(r.findings, 'malformed_variable'), true);
  assert.deepEqual(r.variables, ['valid'], 'the closed reference is still extracted');

  // The mirror case — closed first, unclosed after — was already caught; keep it pinned.
  const trailing = validatePromptVars('{{valid}} and then {{oops unclosed');
  assert.equal(trailing.ok, false);
  assert.equal(hasFinding(trailing.findings, 'malformed_variable'), true);

  // No false positive: two well-formed references and stray SINGLE braces are fine.
  const clean = validatePromptVars('{{a}} mid {text} {{b.c}}');
  assert.equal(hasFinding(clean.findings, 'malformed_variable'), false);
});

test('validatePromptVars deduplicates repeated references', () => {
  const r = validatePromptVars('{{topic}} and again {{topic}}');
  assert.deepEqual(r.variables, ['topic']);
});

test('validatePromptVars throws KalturaError on non-string before any work', () => {
  assert.throws(() => validatePromptVars(42), (e) => e.name === 'KalturaError' && e.code === 'bad_request');
});

test('validatePromptVars carries a _meta receipt', () => {
  const r = validatePromptVars('hi');
  assert.equal(r._meta.source, 'prompt-lint');
  assert.equal(r._meta.scope, 'prompt-vars');
  assert.match(r._meta.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('lintPrompts: well-formed list is clean', () => {
  const r = lintPrompts([
    { key: 'goal', label: 'Goal', headerTemplate: 'Your goal:', type: 'custom', value: 'Help users.' },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.skippedKeys, []);
});

test('lintPrompts: empty value/headerTemplate → renderer_skip warning + skippedKeys', () => {
  const r = lintPrompts([
    { key: 'a', headerTemplate: 'H', type: 'custom', value: '' },
    { key: 'b', headerTemplate: '   ', type: 'custom', value: 'x' },
  ]);
  assert.equal(r.summary.warnings >= 2, true);
  assert.equal(hasFinding(r.findings, 'renderer_skip'), true);
  assert.deepEqual(r.skippedKeys, ['a', 'b']);
});

test('lintPrompts: missing key and wrong type are ERRORS', () => {
  const r = lintPrompts([
    { headerTemplate: 'H', type: 'custom', value: 'v' },
    { key: 'x', headerTemplate: 'H', type: 'system', value: 'v' },
  ]);
  assert.equal(r.ok, false);
  assert.equal(hasFinding(r.findings, 'missing_key'), true);
  assert.equal(hasFinding(r.findings, 'bad_type'), true);
});

test('lintPrompts: duplicate keys warn', () => {
  const r = lintPrompts([
    { key: 'dup', headerTemplate: 'H', type: 'custom', value: 'v' },
    { key: 'dup', headerTemplate: 'H2', type: 'custom', value: 'v2' },
  ]);
  assert.equal(hasFinding(r.findings, 'duplicate_key'), true);
});

test('lintPrompts: variables found in headers and values, var rules honored', () => {
  const r = lintPrompts([
    { key: 'k', headerTemplate: 'Hi {{sys__user_id}}', type: 'custom', value: 'Topic {{topic}}' },
  ], { allowClientVariables: false });
  assert.equal(r.ok, false);
  assert.equal(hasFinding(r.findings, 'client_variable_not_allowed'), true);
  assert.deepEqual(r.variables.sort(), ['sys__user_id', 'topic']);
});

test('lintPrompts: non-array throws KalturaError', () => {
  assert.throws(() => lintPrompts('nope'), (e) => e.name === 'KalturaError' && e.code === 'bad_request');
});

// ─── §4a.3: gate/placeholder mismatch + the canonical page-context block ───

test('lintPrompts: gate explicitly ON with no client {{var}} anywhere → vars_gate_unreferenced warning', () => {
  const r = lintPrompts([
    { key: 'goal', headerTemplate: 'Goal', type: 'custom', value: 'Help users. {{sys__user_id}}' },
  ], { allowClientVariables: true });
  assert.equal(hasFinding(r.findings, 'vars_gate_unreferenced'), true);
  assert.equal(r.ok, true, 'a warning, never an error');
  assert.deepEqual(r.clientVariables, []);
});

test('lintPrompts: default gate (unspecified) with no client vars stays silent — no noise on plain prompt sets', () => {
  const r = lintPrompts([{ key: 'goal', headerTemplate: 'Goal', type: 'custom', value: 'Help users.' }]);
  assert.equal(hasFinding(r.findings, 'vars_gate_unreferenced'), false);
  assert.deepEqual(r.findings, []);
});

test('lintPrompts: gate ON with a client var referenced → no vars_gate_unreferenced', () => {
  const r = lintPrompts([
    { key: 'ctx', headerTemplate: 'Context', type: 'custom', value: '{{page_context}}' },
  ], { allowClientVariables: true, knownVars: ['page_context'] });
  assert.equal(hasFinding(r.findings, 'vars_gate_unreferenced'), false);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.clientVariables, ['page_context']);
});

test('lintPrompts: a knownVar never referenced by any block → known_var_unreferenced (sent every call, silently ignored)', () => {
  const r = lintPrompts([
    { key: 'ctx', headerTemplate: 'Context', type: 'custom', value: '{{tier}}' },
  ], { knownVars: ['tier', 'page_context'] });
  const f = r.findings.filter((x) => x.code === 'known_var_unreferenced');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /page_context/);
  assert.equal(f[0].severity, 'warning');
});

test('PAGE_CONTEXT_PROMPT: frozen canonical block, references {{page_context}}, lints clean with the gate on', () => {
  assert.equal(PAGE_CONTEXT_PROMPT.key, 'page_context');
  assert.equal(PAGE_CONTEXT_PROMPT.type, 'custom');
  assert.match(PAGE_CONTEXT_PROMPT.value, /\{\{page_context\}\}/);
  assert.throws(() => { PAGE_CONTEXT_PROMPT.value = 'x'; });
  const r = lintPrompts([PAGE_CONTEXT_PROMPT], { allowClientVariables: true, knownVars: ['page_context'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('PAGE_CONTEXT_PROMPT: with the gate OFF the same block is the client_variable_not_allowed error (mismatch, other direction)', () => {
  const r = lintPrompts([PAGE_CONTEXT_PROMPT], { allowClientVariables: false });
  assert.equal(r.ok, false);
  assert.equal(hasFinding(r.findings, 'client_variable_not_allowed'), true);
});

test('lintGlossary: detects json vs text vs empty', () => {
  assert.equal(lintGlossary('').format, 'empty');
  assert.equal(lintGlossary('ARR = annual recurring revenue').format, 'text');
  const j = lintGlossary('{"ARR":"annual recurring revenue"}');
  assert.equal(j.format, 'json');
  assert.equal(hasFinding(j.findings, 'glossary_format'), true);
});

test('lintGlossary: malformed-json-looking text stays text with a format note', () => {
  const r = lintGlossary('{not valid json');
  assert.equal(r.format, 'text');
  assert.equal(hasFinding(r.findings, 'glossary_format'), true);
});

test('lintGlossary: scans for variables', () => {
  const r = lintGlossary('Region: {{region}}', { knownVars: ['region'] });
  assert.deepEqual(r.variables, ['region']);
  assert.equal(r.findings.length, 0);
});

test('lintGlossary: non-string throws KalturaError', () => {
  assert.throws(() => lintGlossary(null), (e) => e.name === 'KalturaError');
});

test('assembleSystemPrompt: renders blocks as "## header\\nvalue" joined, base prepended', () => {
  const r = assembleSystemPrompt({
    baseDirective: 'You are Assistant.',
    prompts: [
      { key: 'goal', headerTemplate: 'Your goal:', value: 'Help.' },
      { key: 'tone', headerTemplate: 'Tone:', value: 'Warm.' },
    ],
    glossary: 'ARR = annual recurring revenue',
  });
  assert.equal(
    r.text,
    'You are Assistant.\n\n## Your goal:\nHelp.\n\n## Tone:\nWarm.\n\nARR = annual recurring revenue',
  );
  assert.equal(r.usedDefaultDirective, false);
  assert.deepEqual(r.skippedKeys, []);
});

test('assembleSystemPrompt: empty value/header blocks are skipped (renderer parity)', () => {
  const r = assembleSystemPrompt({
    baseDirective: 'Base.',
    prompts: [
      { key: 'keep', headerTemplate: 'H', value: 'V' },
      { key: 'skipval', headerTemplate: 'H2', value: '   ' },
      { key: 'skiphdr', headerTemplate: '', value: 'V3' },
    ],
  });
  assert.equal(r.text, 'Base.\n\n## H\nV');
  assert.deepEqual(r.skippedKeys, ['skipval', 'skiphdr']);
});

test('assembleSystemPrompt: empty base_directive renders the server-default MARKER, not a fabricated string', () => {
  const r = assembleSystemPrompt({ baseDirective: '', prompts: [{ key: 'k', headerTemplate: 'H', value: 'V' }] });
  assert.equal(r.usedDefaultDirective, true);
  assert.equal(r.text.startsWith(SERVER_DEFAULT_DIRECTIVE_MARKER), true);
});

test('assembleSystemPrompt: interpolates when requestVars supplied, tracks unresolved', () => {
  const r = assembleSystemPrompt({
    baseDirective: 'Hi {{sys__user_id}} about {{topic}} and {{missing}}',
    prompts: [],
    requestVars: { sys__user_id: 'u-7', topic: 'Q1' },
  });
  assert.equal(r.text, 'Hi u-7 about Q1 and {{missing}}');
  assert.deepEqual(r.unresolvedVariables, ['missing']);
});

test('assembleSystemPrompt: interpolate:false keeps placeholders literal even with vars', () => {
  const r = assembleSystemPrompt({
    baseDirective: 'Hi {{topic}}',
    requestVars: { topic: 'X' },
    interpolate: false,
  });
  assert.equal(r.text, 'Hi {{topic}}');
});

test('assembleSystemPrompt: _meta marks it a client-side replica with the honest note', () => {
  const r = assembleSystemPrompt({ baseDirective: 'b' });
  assert.equal(r._meta.renderer, 'client-side-replica');
  assert.equal(r._meta.scope, 'system-prompt');
  assert.match(r._meta.note, /Author layer only/);
});

test('assembleSystemPrompt: bad shapes throw KalturaError before rendering', () => {
  assert.throws(() => assembleSystemPrompt({ prompts: 'no' }), (e) => e.name === 'KalturaError');
  assert.throws(() => assembleSystemPrompt({ baseDirective: 5 }), (e) => e.name === 'KalturaError');
  assert.throws(() => assembleSystemPrompt(7), (e) => e.name === 'KalturaError');
});

// Persona-name consistency across openingPhrase/base_directive/prompts[]

test('lintPersonaIdentity: consistent name across all fields → no warning', () => {
  const r = lintPersonaIdentity({
    name: 'Nova',
    openingPhrase: "Hi! I'm Nova, your friendly guide.",
    baseDirective: 'You are Nova. Be concise and helpful.',
    prompts: [{ key: 'name', value: 'Nova' }],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
  assert.equal(r.detectedName, 'Nova');
});

test('lintPersonaIdentity: openingPhrase renamed, base_directive/prompts still say the old name → warnings fire', () => {
  const r = lintPersonaIdentity({
    name: 'Nova',
    openingPhrase: "Hi! I'm Luna, ready to help!",
    baseDirective: 'You are Nova. Be concise and helpful.',
    prompts: [{ key: 'name', value: 'Nova' }],
  });
  // warnings never flip ok to false in this file's convention (see lintPrompts'
  // renderer_skip warning tests) — only errors do, and this lint never errors.
  assert.equal(r.ok, true);
  assert.equal(r.detectedName, 'Luna');
  assert.equal(hasFinding(r.findings, 'persona_name_mismatch'), true);
  assert.equal(hasFinding(r.findings, 'persona_name_drift'), true);
});

test('lintPersonaIdentity: possessive form is still detected', () => {
  const r = lintPersonaIdentity({
    name: 'Nova',
    openingPhrase: 'Nova’s here to help you today!',
    baseDirective: 'You are Nova. Be concise and helpful.',
    prompts: [],
  });
  assert.equal(r.detectedName, 'Nova');
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('lintPersonaIdentity: no proper name present in openingPhrase → no false warning', () => {
  const r = lintPersonaIdentity({
    name: 'Nova',
    openingPhrase: 'Hello! How can I help you today?',
    baseDirective: 'You are Nova. Be concise and helpful.',
    prompts: [],
  });
  assert.equal(r.detectedName, null);
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

// see PR #21 Copilot review — extractProperName()'s self-introduction match
// must respect GREETING_STOPWORDS too, not just the possessive/generic paths.
test('lintPersonaIdentity: self-intro on a stopword ("I\'m Ready") is not mistaken for a name', () => {
  const r = lintPersonaIdentity({
    name: 'Nova',
    openingPhrase: "I'm Ready to help you today!",
    baseDirective: 'You are Nova. Be concise and helpful.',
    prompts: [],
  });
  assert.equal(r.detectedName, null);
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('lintPersonaIdentity: self-intro on a stopword ("my name is Happy") is not mistaken for a name', () => {
  const r = lintPersonaIdentity({
    name: 'Nova',
    openingPhrase: 'my name is Happy to assist you.',
    baseDirective: 'You are Nova. Be concise and helpful.',
    prompts: [],
  });
  assert.equal(r.detectedName, null);
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});

test('lintPersonaIdentity: empty baseDirective/prompts haystack skips the drift check (no false positive on minimal input)', () => {
  const r = lintPersonaIdentity({ name: 'Nova', openingPhrase: "I'm Nova." });
  assert.equal(r.detectedName, 'Nova');
  assert.equal(hasFinding(r.findings, 'persona_name_drift'), false);
});

// persona_name_drift must fire off a declared `name` alone,
// not only when openingPhrase yields a parseable detectedName.

test('lintPersonaIdentity: declared-name drift fires with no openingPhrase at all', () => {
  const r = lintPersonaIdentity({
    name: 'Nova',
    baseDirective: 'You are a friendly assistant.',
    prompts: [{ key: 'goal', value: 'Help users find docs.' }],
  });
  assert.equal(r.detectedName, null);
  assert.equal(hasFinding(r.findings, 'persona_name_drift'), true);
});

test('lintPersonaIdentity: no drift finding when the declared name is mentioned, still no openingPhrase', () => {
  const r = lintPersonaIdentity({
    name: 'Nova',
    baseDirective: 'You are Nova, a friendly assistant.',
    prompts: [{ key: 'goal', value: 'Help users find docs.' }],
  });
  assert.equal(hasFinding(r.findings, 'persona_name_drift'), false);
  assert.equal(r.ok, true);
});

test('lintPersonaIdentity: matches Nova\'s real shape — name declared via prompts[], openingPhrase has no parseable name', () => {
  const r = lintPersonaIdentity({
    name: 'Nova',
    openingPhrase: '<break time="1s"/>', // SSML silence-tag crash workaround, never a real name
    baseDirective: 'You are a documentation assistant.',
    prompts: [{ key: 'name', value: 'You are Nova, the docs assistant.' }],
  });
  assert.equal(r.detectedName, null);
  assert.equal(hasFinding(r.findings, 'persona_name_drift'), false);
  assert.equal(r.ok, true);
});

test('lintPersonaIdentity: persona_name_mismatch still requires an openingPhrase-derived detectedName (unchanged)', () => {
  const noOpeningPhrase = lintPersonaIdentity({
    name: 'Nova',
    baseDirective: 'You are Luna, a friendly assistant.',
    prompts: [],
  });
  assert.equal(hasFinding(noOpeningPhrase.findings, 'persona_name_mismatch'), false);
});

test('lintPersonaIdentity: declaredName === detectedName does not double-fire drift for the same rename', () => {
  const r = lintPersonaIdentity({
    name: 'Nova',
    openingPhrase: "I'm Nova, ready to help!",
    baseDirective: 'You are a friendly assistant.', // never mentions Nova
    prompts: [],
  });
  const driftFindings = r.findings.filter((f) => f.code === 'persona_name_drift');
  assert.equal(driftFindings.length, 1);
});

test('lintPersonaIdentity: non-object throws KalturaError', () => {
  assert.throws(() => lintPersonaIdentity('nope'), (e) => e.name === 'KalturaError' && e.code === 'bad_request');
});

test('lintPersonaIdentity: carries a _meta receipt', () => {
  const r = lintPersonaIdentity({});
  assert.equal(r._meta.source, 'prompt-lint');
  assert.equal(r._meta.scope, 'persona-identity');
});

test('assembleSystemPrompt: prototype-pollution-safe requestVars lookup', () => {
  const r = assembleSystemPrompt({ baseDirective: '{{toString}}', requestVars: { x: 1 } });
  // `toString` is on Object.prototype but not an own key → left unresolved, not coerced.
  assert.equal(r.text, '{{toString}}');
  assert.deepEqual(r.unresolvedVariables, ['toString']);
});

// Flag unresolvable reserved-variable references instead of
// silently rendering literal/empty output.

test('assembleSystemPrompt: fully-resolved prompt has NO warnings key (regression — unchanged from today)', () => {
  const r = assembleSystemPrompt({
    baseDirective: 'Thread {{sys__thread_id}}, user {{sys__user_id}}',
    prompts: [{ key: 'k', headerTemplate: 'H', value: 'Hi {{sys__user_message}}' }],
    requestVars: { sys__thread_id: 't-1', sys__user_id: 'u-1', sys__user_message: 'hello' },
  });
  assert.equal('warnings' in r, false);
  assert.deepEqual(r.unresolvedVariables, []);
});

test('assembleSystemPrompt: a prompt with NO reserved-variable references has no warnings', () => {
  const r = assembleSystemPrompt({ baseDirective: 'Hello {{topic}}', requestVars: {} });
  assert.equal('warnings' in r, false);
  assert.deepEqual(r.unresolvedVariables, ['topic']);
});

test('assembleSystemPrompt: unresolved scalar reserved var (sys__ks) is flagged, name only, not the value', () => {
  const r = assembleSystemPrompt({ baseDirective: 'Token: {{sys__ks}}', requestVars: {} });
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'reserved_var_unresolved');
  assert.match(r.warnings[0].message, /sys__ks/);
  // no value was ever supplied, but assert defensively that even a hypothetical
  // token-shaped string could never appear — the message is built from `name` only.
  assert.equal(/djJ8|ks-[a-z0-9]/i.test(r.warnings[0].message), false);
  assert.equal(r.text, 'Token: {{sys__ks}}', 'literal placeholder unchanged (backward compatible)');
});

test('assembleSystemPrompt: unresolved sys__user_obj.* attribute is flagged distinctly', () => {
  assert.ok(RESERVED_USER_OBJ_ATTRS.includes('first_name'));
  const r = assembleSystemPrompt({ baseDirective: 'Hi {{sys__user_obj.first_name}}', requestVars: {} });
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'reserved_user_attr_unresolved');
  assert.match(r.warnings[0].message, /sys__user_obj\.first_name/);
});

test('assembleSystemPrompt: sys__user_obj.* resolves cleanly (no warning) once bound via requestVars', () => {
  const r = assembleSystemPrompt({
    baseDirective: 'Hi {{sys__user_obj.first_name}}',
    requestVars: { 'sys__user_obj.first_name': 'Jane' },
  });
  assert.equal('warnings' in r, false);
  assert.equal(r.text, 'Hi Jane');
});

test('assembleSystemPrompt: an unrecognized sys__user_obj.* attribute is not flagged as reserved (unknown client-shaped var)', () => {
  const r = assembleSystemPrompt({ baseDirective: 'Hi {{sys__user_obj.nickname}}', requestVars: {} });
  assert.equal('warnings' in r, false);
});

test('assembleSystemPrompt: unresolved secrets.* reference is flagged (preview cannot read secret values)', () => {
  const r = assembleSystemPrompt({ baseDirective: 'Key: {{secrets.API_KEY}}', requestVars: {} });
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'reserved_secret_unresolved');
  assert.match(r.warnings[0].message, /API_KEY/);
});

test('assembleSystemPrompt: a reserved var with an explicit null value in requestVars still warns (no value available)', () => {
  const r = assembleSystemPrompt({ baseDirective: 'User {{sys__user_id}}', requestVars: { sys__user_id: null } });
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'reserved_var_unresolved');
  // existing text/unresolved behavior for a present-but-null value is unchanged: renders empty, not "unresolved".
  assert.equal(r.text, 'User ');
  assert.deepEqual(r.unresolvedVariables, []);
});

test('assembleSystemPrompt: multiple distinct reserved-var references each warn once, deduplicated on repeat', () => {
  const r = assembleSystemPrompt({
    baseDirective: 'A {{sys__ks}} B {{sys__is_new_thread}} C {{sys__ks}}',
    requestVars: {},
  });
  assert.equal(r.warnings.length, 2);
  assert.deepEqual(r.warnings.map((w) => w.code).sort(), ['reserved_var_unresolved', 'reserved_var_unresolved']);
});
