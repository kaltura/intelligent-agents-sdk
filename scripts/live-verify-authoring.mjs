#!/usr/bin/env node
/**
 * Live authoring-contract verification: conditions, prompt types, `var` tools
 * and `{arg}` placeholders, against the real Kaltura API. No fakes, no mocks.
 *
 *   1  client-side guards      templated conditions, bad `var` args and bad
 *                              placeholders are rejected before any call
 *   2  prompt types/condition  `custom|system|knowledge` and `condition` round-trip
 *   3  skill condition         a bare condition gates the skill at run time
 *   4  var tool                a value set on one turn is visible to a prompt
 *                              condition on the next turn of the same thread,
 *                              and does not leak into a new thread
 *   5  tool condition          a tool with a false condition is never offered,
 *                              the same tool with a true condition is called
 *   5b tool_ids shape          lists read back as {id, condition}; the setters,
 *                              audit and delete guard accept it; a per-attachment
 *                              condition gates the tool
 *   6  {arg} placeholder       the model's arg fills an api tool's url and the
 *                              string values of its object body
 *   6b {arg} extras            nested object and list values are filled, a header
 *                              is not, and request.params is never sent
 *   7  shared skills           listed with partner_id 0, attachable, read back by
 *                              audit, refused by skills.get/update/delete, and an
 *                              unknown id is a 403
 *   8  doctor                  intellectConfig.audit flags a saved templated
 *                              skill condition
 *   9  server contract         a templated condition (skill, prompt, tool) gets an
 *                              empty reply from the server: the reason the SDK
 *                              rejects it before the write; audit flags all three
 *  10  null round trip         an unset condition reads back as null, and a tool
 *                              or skill list read from the server is accepted
 *                              again by tools.update / setSkillIds
 *
 *  11  condition grammar       one throwaway intellect per expression: a match
 *                              shows the marker, a no-match gives a normal reply
 *                              without it, a blank-turn form gives an empty reply
 *                              (and the SDK warns about it before the write)
 *  12  var types and readers   an int var compares as a number, the later call wins,
 *                              and a skill or tool condition reads a var
 *
 * Throwaway resources only (intellects, tools, one skill), removed in `finally`.
 * Model-dependent checks retry once. Credentials: see scripts/lib/target.mjs.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';
import { tools } from '../src/management/tools.js';
import { lintPrompts } from '../src/management/prompt-lint.js';
import { conditionWarnings } from '../src/management/condition.js';
import { resolveTarget } from './lib/target.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = resolveTarget(process.env.TARGET ?? 'prod');
const startedAt = new Date().toISOString();
const runId = `ci-live-verify-authoring-${Date.now()}`;
const TAG = `au${Date.now().toString(36)}`;
const MARK = `ZEBRA${Date.now().toString(36).toUpperCase()}`;
const artifact = { runId, startedAt, partnerId: target.partnerId, steps: [] };

function record(step, ok, detail) {
  artifact.steps.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${step}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}
let failed = false;
function check(step, ok, detail) {
  if (!ok) failed = true;
  record(step, ok, detail);
}
const errOf = (e) => ({ code: e?.code, message: (e?.detail || e?.message || String(e)).slice(0, 300) });
const hasMark = (r) => (r?.text ?? '').includes(MARK);
const nonEmpty = (r) => (r?.text ?? '').trim() !== '';

const kaltura = new Management(target);
const made = { intellects: [], tools: [], skills: [] };
let admin;

/** Run `fn` up to twice; the second try only runs when the first result fails `ok`. Model output varies. */
async function tryTwice(fn, ok) {
  let result = await fn();
  if (!ok(result)) result = await fn();
  return result;
}
async function newIntellect(prompts) {
  const i = await kaltura.intellects.add({ type: 'internal', status: 2, prompts }, admin);
  made.intellects.push(i.id);
  return i;
}
const baseRules = (value) => ({ key: 'rules', label: 'Rules', headerTemplate: 'Rules:', type: 'custom', value });

try {
  admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
  record('admin-token-mint', true, { target: target.name });

  // 1: client-side guards (no network)
  const rejected = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const skillErr = await kaltura.intellectConfig.setSkillIds(1, [{ id: 's', mode: 'adhoc', condition: '{{ sys__avatar_enabled }}' }], admin).then(() => null, (e) => e);
  check('1-skill-template-condition-rejected', skillErr?.code === 'bad_request' && /bare expression/.test(skillErr.detail), errOf(skillErr));
  const toolErr = rejected(() => tools.client({ name: 'x', description: 'd', condition: '{% if a %}b{% endif %}' }));
  check('1-tool-template-condition-rejected', toolErr?.code === 'bad_request', errOf(toolErr));
  const lint = lintPrompts([{ key: 'k', headerTemplate: 'H', type: 'custom', value: 'v', condition: '{{ a }}' }]);
  check('1-lint-bad-condition-local', lint.findings.some((f) => f.code === 'bad_condition'), { ok: lint.ok });
  const badBlock = [{ key: 'k', headerTemplate: 'H', type: 'custom', value: 'v', condition: '{{ a }}' }];
  const addErr = await kaltura.intellects.add({ type: 'internal', status: 2, prompts: badBlock }, admin).then(() => null, (e) => e);
  check('1-intellects-add-bad-prompt-condition-rejected', addErr?.code === 'bad_request' && /prompts\[0\]\.condition/.test(addErr.detail), errOf(addErr));
  const setErr = await kaltura.intellects.setPrompts(1, badBlock, admin).then(() => null, (e) => e);
  check('1-setPrompts-bad-prompt-condition-lint-failed', setErr?.code === 'prompt_lint_failed', errOf(setErr));
  check('1-suspect-condition-warns', ['a AND b', 'plan = "pro"', 'visits > 2'].every((c) => conditionWarnings(c).length > 0) && conditionWarnings("plan == 'pro'").length === 0);
  const varErr = rejected(() => tools.var({ name: 'v', description: 'd', args: { sys__x: { prompt: 'p', type: 'str' } } }));
  check('1-var-reserved-arg-rejected', varErr?.code === 'bad_request', errOf(varErr));
  const phErr = rejected(() => tools.api({ name: 'a', description: 'd', request: { url: 'https://example.com/?c={nope}', method: 'GET' }, responseMapping: { x: 'a' } }));
  check('1-undeclared-placeholder-rejected', phErr?.code === 'bad_placeholder', errOf(phErr));
  const bodyErr = rejected(() => tools.api({ name: 'a', description: 'd', request: { url: 'https://example.com/', method: 'POST', body: { a: { b: ['{nope}'] } } }, responseMapping: { x: 'a' } }));
  check('1-undeclared-placeholder-in-object-body-rejected', bodyErr?.code === 'bad_placeholder' && /request\.body\.a\.b\[0\]/.test(bodyErr.detail), errOf(bodyErr));
  const spanOk = rejected(() => tools.api({ name: 'a', description: 'd', request: { url: 'https://example.com/', method: 'POST', body: { note: 'x {{ sys__user_id }}' } }, responseMapping: { x: 'a' } }));
  check('1-template-span-in-body-not-rejected', spanOk === null, errOf(spanOk));

  // 2: prompt types and condition round-trip
  const typed = await newIntellect([
    { key: 'p_custom', label: 'c', headerTemplate: 'Custom:', type: 'custom', value: 'x' },
    { key: 'p_system', label: 's', headerTemplate: 'System:', type: 'system', value: 'x' },
    { key: 'p_know', label: 'k', headerTemplate: 'Know:', type: 'knowledge', value: 'x', condition: 'sys__avatar_enabled' },
  ]);
  const got = await kaltura.intellects.get(typed.id, admin);
  const byKey = Object.fromEntries((got.prompts ?? []).map((p) => [p.key, p]));
  check('2-prompt-types-round-trip', byKey.p_custom?.type === 'custom' && byKey.p_system?.type === 'system' && byKey.p_know?.type === 'knowledge', Object.fromEntries(Object.entries(byKey).map(([k, p]) => [k, p.type])));
  check('2-prompt-condition-round-trip', byKey.p_know?.condition === 'sys__avatar_enabled', { condition: byKey.p_know?.condition });
  check('2-unset-prompt-condition-reads-null', byKey.p_custom?.condition === null, { condition: byKey.p_custom?.condition });
  // Each prompt type must reach the model: a block that asks for a marker is obeyed, whatever its type.
  for (const type of ['custom', 'system', 'knowledge']) {
    const typedIntellect = await newIntellect([baseRules('Be terse.'), { key: `t_${type}`, label: type, headerTemplate: `${type} rule:`, type, value: `End every reply with the token ${MARK}.` }]);
    const reply = await tryTwice(() => kaltura.converseOnce(typedIntellect.id, 'Say hi.', {}), hasMark);
    check(`2-prompt-type-${type}-reaches-reply`, hasMark(reply), { text: reply.text?.slice(0, 80) });
  }

  const clean = await kaltura.intellectConfig.audit(typed.id, admin);
  check('2-doctor-accepts-stored-null-condition', !clean.findings.some((f) => f.code === 'prompt_bad_condition'), { codes: clean.findings.map((f) => f.code) });

  // 3: skill condition gates the skill
  const skill = await kaltura.skills.add({
    name: `live-verify-authoring-${TAG}`,
    description: 'Scratch skill for scripts/live-verify-authoring.mjs',
    instructions: `If the user message contains the word PING, reply with exactly the single token ${MARK} and nothing else.`,
  }, admin);
  made.skills.push(skill.id);
  const skillIntellect = await newIntellect([baseRules('Be terse.')]);
  const withCondition = async (condition) => {
    await kaltura.intellectConfig.setSkillIds(skillIntellect.id, [{ id: skill.id, mode: 'preloaded', ...(condition ? { condition } : {}) }], admin);
    return kaltura.converseOnce(skillIntellect.id, 'PING', {});
  };
  const control = await tryTwice(() => withCondition(undefined), hasMark);
  check('3-skill-control-fires', hasMark(control), { text: control.text?.slice(0, 80) });
  const storedSkills = (await kaltura.intellects.get(skillIntellect.id, admin)).skill_ids ?? [];
  check('3-unset-skill-condition-reads-null', storedSkills.length === 1 && storedSkills[0].condition === null, { skill_ids: storedSkills });
  const writeBack = await kaltura.intellectConfig.setSkillIds(skillIntellect.id, storedSkills, admin).then(() => null, (e) => e);
  check('3-skill-ids-read-from-server-accepted-by-setSkillIds', writeBack === null, writeBack ? errOf(writeBack) : { skill_ids: storedSkills.length });
  const on = await tryTwice(() => withCondition('not sys__avatar_enabled'), hasMark);
  check('3-skill-true-condition-fires', hasMark(on), { text: on.text?.slice(0, 80) });
  const off = await withCondition('sys__avatar_enabled');
  check('3-skill-false-condition-silences', !hasMark(off) && nonEmpty(off), { text: off.text?.slice(0, 80) });

  // 4: var tool, same-thread visibility, no leak into a new thread
  const varCfg = tools.var({
    name: `live_verify_set_mode_${TAG}`,
    description: 'Switch the reply mode. Call it with the mode name the user asks for.',
    args: { au_mode: { prompt: 'Mode name, lowercase', type: 'str', required: true } },
    condition: 'not sys__avatar_enabled',
  });
  const varTool = await kaltura.tools.add(varCfg, admin);
  made.tools.push(varTool.id);
  check('4-var-tool-stored', (await kaltura.tools.get(varTool.id, admin)).config?.type === 'var', { id: varTool.id });
  const varIntellect = await newIntellect([
    baseRules('Be terse. When the user asks to switch mode, call the mode tool, then reply "done".'),
    { key: 'zmode', label: 'z', headerTemplate: 'Mode rule:', type: 'custom', value: `End every reply with the token ${MARK}.`, condition: "au_mode == 'zebra'" },
  ]);
  await kaltura.intellectConfig.setToolIds(varIntellect.id, [varTool.id], admin);
  const conv = await kaltura.sessions.createConversationToken({ configId: varIntellect.id });
  const sameThread = await tryTwice(async () => {
    const t1 = await kaltura.converseOnce(varIntellect.id, 'Switch mode to zebra.', {}, conv);
    const t2 = await kaltura.converseOnce(varIntellect.id, 'Say hi.', { threadId: t1.threadId }, conv);
    return { t1, t2 };
  }, (r) => hasMark(r.t2));
  check('4-var-tool-called', (sameThread.t1.toolCalls ?? []).length > 0, { calls: (sameThread.t1.toolCalls ?? []).map((c) => c.name) });
  check('4-var-visible-next-turn-same-thread', hasMark(sameThread.t2), { text: sameThread.t2.text?.slice(0, 80) });
  const fresh = await kaltura.converseOnce(varIntellect.id, 'Say hi.', {});
  check('4-var-does-not-leak-to-new-thread', !hasMark(fresh) && nonEmpty(fresh), { text: fresh.text?.slice(0, 80) });

  // 5: a tool with a false condition is never offered; the same tool with a true condition is called
  const modeTool = (suffix, condition) => kaltura.tools.add(tools.var({
    name: `live_verify_${suffix}_${TAG}`,
    description: 'Switch the reply mode. Call it with the mode name the user asks for.',
    args: { au_gated: { prompt: 'Mode name, lowercase', type: 'str', required: true } },
    condition,
  }), admin);
  const modeIntellect = async (tool) => {
    const intellect = await newIntellect([baseRules('Be terse. When the user asks to switch mode, call the mode tool, then reply "done".')]);
    await kaltura.intellectConfig.setToolIds(intellect.id, [tool.id], admin);
    return intellect;
  };
  const openTool = await modeTool('open', 'not sys__avatar_enabled');
  const gatedTool = await modeTool('gated', 'sys__avatar_enabled');
  made.tools.push(openTool.id, gatedTool.id);
  const openIntellect = await modeIntellect(openTool);
  const gatedIntellect = await modeIntellect(gatedTool);
  const called = (r) => (r.toolCalls ?? []).length > 0;
  const open = await tryTwice(() => kaltura.converseOnce(openIntellect.id, 'Switch mode to zebra.', {}), called);
  check('5-true-tool-condition-offers-tool', called(open), { calls: (open.toolCalls ?? []).map((c) => c.name) });
  // The model could skip a tool by chance, so the gated tool is asked twice and must stay uncalled both times.
  const gatedRuns = [await kaltura.converseOnce(gatedIntellect.id, 'Switch mode to zebra.', {}), await kaltura.converseOnce(gatedIntellect.id, 'Please switch the mode to zebra now.', {})];
  check('5-false-tool-condition-hides-tool', gatedRuns.every((r) => !called(r) && nonEmpty(r)), { calls: gatedRuns.map((r) => (r.toolCalls ?? []).map((c) => c.name)) });

  // 5b: tool_ids and thread_start_tools read back as {id, condition} objects, and a per-attachment condition gates the tool
  const refIntellect = await modeIntellect(openTool);
  const refsRead = (await kaltura.intellects.get(refIntellect.id, admin)).tool_ids ?? [];
  check('5b-tool_ids-reads-back-as-objects', refsRead.length === 1 && refsRead[0]?.id === openTool.id && refsRead[0].condition == null, { refsRead });
  await kaltura.intellectConfig.setToolIds(refIntellect.id, refsRead, admin);
  check('5b-read-back-shape-round-trips', (await kaltura.intellects.get(refIntellect.id, admin)).tool_ids?.[0]?.id === openTool.id);
  await kaltura.intellectConfig.setThreadStartTools(refIntellect.id, [{ id: openTool.id, condition: null }], admin);
  check('5b-thread_start_tools-object-form-accepted', (await kaltura.intellects.get(refIntellect.id, admin)).thread_start_tools?.[0]?.id === openTool.id);
  await kaltura.intellectConfig.setThreadStartTools(refIntellect.id, [], admin);
  const refAudit = await kaltura.intellectConfig.audit(refIntellect.id, admin);
  check('5b-audit-finds-tool-stored-as-object', !refAudit.findings.some((f) => f.code === 'tool_not_found'), { codes: refAudit.findings.map((f) => f.code) });
  const inUse = await kaltura.tools.delete(openTool.id, admin, { confirmPermanent: true }).then(() => null, (e) => e);
  check('5b-delete-guard-sees-object-reference', inUse?.code === 'tool_in_use', errOf(inUse));
  await kaltura.intellectConfig.setToolIds(refIntellect.id, [{ id: openTool.id, condition: 'sys__avatar_enabled' }], admin);
  check('5b-attachment-condition-stored', (await kaltura.intellects.get(refIntellect.id, admin)).tool_ids?.[0]?.condition === 'sys__avatar_enabled');
  const attachGated = [await kaltura.converseOnce(refIntellect.id, 'Switch mode to zebra.', {}), await kaltura.converseOnce(refIntellect.id, 'Please switch the mode to zebra now.', {})];
  check('5b-false-attachment-condition-hides-tool', attachGated.every((r) => !called(r) && nonEmpty(r)), { calls: attachGated.map((r) => (r.toolCalls ?? []).map((c) => c.name)) });
  await kaltura.intellectConfig.setToolIds(refIntellect.id, [{ id: openTool.id, condition: 'not sys__avatar_enabled' }], admin);
  const attachOpen = await tryTwice(() => kaltura.converseOnce(refIntellect.id, 'Switch mode to zebra.', {}), called);
  check('5b-true-attachment-condition-offers-tool', called(attachOpen), { calls: (attachOpen.toolCalls ?? []).map((c) => c.name) });

  // 6: {arg} placeholder fills the url and the string values of an object body.
  // The prefixes exist only in the tool, so seeing them in the reply proves the server filled the arg
  // and the model did not just repeat the city from the user message.
  const argTool = await kaltura.tools.add(tools.api({
    name: `live_verify_city_${TAG}`,
    description: 'Look up a city. Call it with the city name.',
    args: { city: { prompt: 'City name', type: 'str', required: true } },
    request: { url: `https://httpbin.org/anything?c=URL${MARK}-{city}`, method: 'POST', body: { note: `BODY${MARK}-{city}`, count: 1 } },
    responseMapping: { from_url: 'args.c', from_body: 'json.note', count: 'json.count' },
  }), admin);
  made.tools.push(argTool.id);
  const argIntellect = await newIntellect([baseRules('Call the tool for the city asked. Then print the tool result exactly, nothing else.')]);
  await kaltura.intellectConfig.setToolIds(argIntellect.id, [argTool.id], admin);
  const filledOk = (r) => (r.text ?? '').includes(`URL${MARK}-Paris`) && (r.text ?? '').includes(`BODY${MARK}-Paris`);
  const filled = await tryTwice(() => kaltura.converseOnce(argIntellect.id, 'Look up Paris.', {}), filledOk);
  const filledText = (filled.text ?? '').replace(/\s+/g, ' ');
  check('6-arg-placeholder-filled-in-url', filledText.includes(`URL${MARK}-Paris`), { text: filledText.slice(0, 200) });
  check('6-arg-placeholder-filled-in-body', filledText.includes(`BODY${MARK}-Paris`) && !/\{city\}/.test(filledText), { text: filledText.slice(0, 200) });

  // 6b: nested object and list values are filled; a header is not; request.params is never sent.
  const extraTool = await kaltura.tools.add(tools.api({
    name: `live_verify_extras_${TAG}`,
    description: 'Look up a city. Call it with the city name.',
    args: { city: { prompt: 'City name', type: 'str', required: true } },
    request: {
      url: `https://httpbin.org/anything?u=URL${MARK}-{city}`, method: 'POST',
      headers: { 'X-Probe': 'HDR{city}' }, params: { p: `PARAM${MARK}` },
      body: { deep: { list: [`NEST${MARK}-{city}`] } },
    },
    responseMapping: { all_args: 'args', all_headers: 'headers', nested: 'json.deep.list.0' },
  }), admin);
  made.tools.push(extraTool.id);
  const extraIntellect = await newIntellect([baseRules('Call the tool for the city asked. Then print EVERY field of the tool result (all_args, all_headers, nested) exactly as returned, nothing else.')]);
  await kaltura.intellectConfig.setToolIds(extraIntellect.id, [extraTool.id], admin);
  const extras = await tryTwice(() => kaltura.converseOnce(extraIntellect.id, 'Look up Paris.', {}), (r) => (r.text ?? '').includes(`NEST${MARK}-Paris`) && (r.text ?? '').includes('HDR'));
  const extrasText = (extras.text ?? '').replace(/\s+/g, ' ');
  check('6b-nested-object-and-list-values-filled', extrasText.includes(`NEST${MARK}-Paris`), { text: extrasText.slice(0, 240) });
  check('6b-header-placeholder-not-filled', extrasText.includes('HDR{city}') && !extrasText.includes('HDRParis'), { text: extrasText.slice(0, 240) });
  check('6b-params-never-sent', extrasText.includes(`URL${MARK}-Paris`) && !extrasText.includes(`PARAM${MARK}`), { text: extrasText.slice(0, 240) });

  // 7: shared skills in skills.list
  const all = await kaltura.skills.list(admin).all();
  const foreign = all.filter((s) => String(s.partner_id) !== String(target.partnerId));
  check('7-foreign-skills-are-shared-partner-0', foreign.every((s) => s.partner_id === 0), { total: all.length, shared: foreign.length });
  check('7-a-shared-skill-exists-on-this-target', foreign.length > 0, { shared: foreign.length });
  if (foreign.length) {
    const shared = foreign[0];
    const getErr = await kaltura.skills.get(shared.id, admin).then(() => null, (e) => e);
    check('7-shared-skill-get-not-found', getErr?.code === 'not_found', errOf(getErr));
    const updErr = await kaltura.skills.update(shared.id, { description: 'live-verify must never change a shared skill' }, admin).then(() => null, (e) => e);
    check('7-shared-skill-update-not-found', updErr?.code === 'not_found', errOf(updErr));
    // No force: the delete must be refused before it removes anything.
    const delErr = await kaltura.skills.delete(shared.id, admin, { confirmPermanent: true }).then(() => null, (e) => e);
    check('7-shared-skill-delete-refused', delErr !== null && ['not_found', 'skill_in_use'].includes(delErr.code), errOf(delErr));
    const stillThere = (await kaltura.skills.list(admin).all()).some((s2) => s2.id === shared.id);
    check('7-shared-skill-still-listed-after-refused-delete', stillThere, { id: shared.id });
    const sharedIntellect = await newIntellect([baseRules('Be terse.')]);
    await kaltura.intellectConfig.setSkillIds(sharedIntellect.id, [{ id: shared.id, mode: 'adhoc' }], admin);
    const attached = (await kaltura.intellects.get(sharedIntellect.id, admin)).skill_ids ?? [];
    check('7-shared-skill-attaches-and-reads-back', attached.some((e) => e.id === shared.id), { skill_ids: attached });
    const sharedAudit = await kaltura.intellectConfig.audit(sharedIntellect.id, admin);
    check('7-audit-accepts-attached-shared-skill', !sharedAudit.findings.some((f) => f.code === 'skill_not_found'), { codes: sharedAudit.findings.map((f) => f.code) });
  }
  const unknownErr = await kaltura.intellectConfig.setSkillIds(skillIntellect.id, [{ id: `no-such-skill-${TAG}`, mode: 'adhoc' }], admin).then(() => null, (e) => e);
  check('7-unknown-skill-id-is-403-forbidden', unknownErr?.code === 'forbidden', errOf(unknownErr));

  // 8: doctor flags a saved templated skill condition
  await kaltura.intellectConfig.patch(skillIntellect.id, { skill_ids: [{ id: skill.id, mode: 'preloaded', condition: '{{ sys__avatar_enabled }}' }] }, admin);
  const report = await kaltura.intellectConfig.audit(skillIntellect.id, admin);
  check('8-doctor-flags-template-condition', report.findings.some((f) => f.code === 'skill_condition_template') && !report.findings.some((f) => f.code === 'prompt_bad_condition'), { codes: report.findings.map((f) => f.code) });

  // 9: what the server does with a templated condition (the reason the SDK refuses to write one).
  // The skill intellect still holds the templated condition from step 8. The SDK blocks a templated prompt
  // or tool condition, so those two are posted straight to the Genie endpoint, as a client that bypasses
  // the SDK would.
  const emptyReply = (r) => (r.text ?? '').trim() === '' && !hasMark(r);
  const templatedSkill = await kaltura.converseOnce(skillIntellect.id, 'PING', {});
  check('9-server-empty-reply-for-templated-skill-condition', emptyReply(templatedSkill), { text: templatedSkill.text?.slice(0, 80) });
  // intellects.add now refuses a templated prompt condition, so this one is posted straight to the endpoint.
  const rawPrompts = [
    baseRules('Be terse.'),
    { key: 'tp', label: 't', headerTemplate: 'T:', type: 'custom', value: `End the reply with ${MARK}.`, condition: '{{ not sys__avatar_enabled }}' },
  ];
  const rawIntellectResp = await target.fetch(`${target.genieUrl}/v1/intellect/add`, {
    method: 'POST', headers: { Authorization: `KS ${admin.ks}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'internal', status: 2, prompts: rawPrompts }),
  });
  const rawIntellect = await rawIntellectResp.json().catch(() => ({}));
  check('9-templated-prompt-condition-posted-without-sdk', rawIntellectResp.ok && rawIntellect.id != null, { status: rawIntellectResp.status });
  const templatedPromptIntellect = { id: rawIntellect.id };
  made.intellects.push(rawIntellect.id);
  const templatedPrompt = await kaltura.converseOnce(templatedPromptIntellect.id, 'Say hi.', {});
  check('9-server-empty-reply-for-templated-prompt-condition', emptyReply(templatedPrompt), { text: templatedPrompt.text?.slice(0, 80) });
  const rawTool = {
    type: 'var', name: `live_verify_templated_${TAG}`, description: 'Switch the reply mode. Call it with the mode name the user asks for.',
    args: { au_templated: { prompt: 'Mode name, lowercase', type: 'str', required: true } }, condition: '{{ not sys__avatar_enabled }}',
  };
  const rawResp = await target.fetch(`${target.genieUrl}/v1/tool/add`, {
    method: 'POST', headers: { Authorization: `KS ${admin.ks}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: rawTool.name, config: rawTool }),
  });
  const rawBody = await rawResp.json().catch(() => ({}));
  check('9-templated-tool-condition-posted-without-sdk', rawResp.ok && typeof rawBody.id === 'string', { status: rawResp.status });
  if (rawBody.id) {
    made.tools.push(rawBody.id);
    const templatedToolIntellect = await modeIntellect(rawBody);
    const templatedTool = await kaltura.converseOnce(templatedToolIntellect.id, 'Switch mode to zebra.', {});
    check('9-server-empty-reply-for-templated-tool-condition', emptyReply(templatedTool) && !called(templatedTool), { text: templatedTool.text?.slice(0, 80), calls: (templatedTool.toolCalls ?? []).length });
    const toolReport = await kaltura.intellectConfig.audit(templatedToolIntellect.id, admin);
    check('9-doctor-flags-template-tool-condition', toolReport.findings.some((f) => f.code === 'tool_condition_template'), { codes: toolReport.findings.map((f) => f.code) });
  }
  const promptReport = await kaltura.intellectConfig.audit(templatedPromptIntellect.id, admin);
  check('9-doctor-flags-template-prompt-condition', promptReport.findings.some((f) => f.code === 'prompt_bad_condition'), { codes: promptReport.findings.map((f) => f.code) });

  // 10: a tool read back from the server is accepted by tools.update, and an unset condition stays null
  const roundTrip = async (id) => {
    const before = await kaltura.tools.get(id, admin);
    const err = await kaltura.tools.update(id, { config: before.config }, admin).then(() => null, (e) => e);
    const after = await kaltura.tools.get(id, admin);
    return { before, err, after };
  };
  const setCond = await roundTrip(varTool.id);
  check('10-tool-with-condition-round-trips', setCond.err === null && setCond.after.config.condition === 'not sys__avatar_enabled', { err: setCond.err && errOf(setCond.err), condition: setCond.after.config.condition });
  const unsetCond = await roundTrip(argTool.id);
  check('10-unset-tool-condition-reads-null-and-round-trips', unsetCond.before.config.condition === null && unsetCond.err === null && unsetCond.after.config.condition === null, { err: unsetCond.err && errOf(unsetCond.err), before: unsetCond.before.config.condition, after: unsetCond.after.config.condition });
  // The server echoes null for every field a tool leaves unset (display_name, request.authentication,
  // the two response shapers not chosen, ...). Each tool type must accept its own read-back.
  const templateTool = await kaltura.tools.add(tools.api({
    name: `live_verify_template_${TAG}`, description: 'Echo a value. Not called by this script.',
    request: { url: 'https://httpbin.org/anything', method: 'POST', headers: { 'X-Live-Verify': TAG }, params: { q: '1' }, body: { n: 1 } },
    responseTemplate: 'value: {{ json.n }}',
  }), admin);
  const clientTool = await kaltura.tools.add(tools.client({ name: `live_verify_client_${TAG}`, description: 'Client-side tool. Not called by this script.' }), admin);
  made.tools.push(templateTool.id, clientTool.id);
  for (const [label, id] of [['api-template', templateTool.id], ['client', clientTool.id]]) {
    const r = await roundTrip(id);
    check(`10-${label}-tool-read-back-accepted-by-update`, r.err === null, { err: r.err && errOf(r.err) });
  }

  // 11: condition grammar. One intellect per expression, so one reply says exactly what the server did.
  // 'match' = the gated block's marker shows. 'nomatch' = a normal reply without it.
  // 'blank' = the whole turn comes back empty. `warn` = the SDK warns before the write.
  const GRAMMAR = [
    ['match', "plan == 'pro'"], ['match', 'plan == "pro"'], ['match', "plan != 'free'"],
    ['match', "plan in ['pro', 'team']"], ['match', "plan not in ['free']"],
    ['match', "plan == 'pro' and not sys__avatar_enabled"], ['match', "plan == 'x' or plan == 'pro'"],
    ['match', "(plan == 'pro')"], ['match', "plan.startswith('p')"], ['match', "plan|upper == 'PRO'"],
    ['match', 'plan is defined'], ['match', 'nothing_here is not defined'], ['match', 'not unknown_name'], ['match', "n > '5'"],
    ['nomatch', 'unknown_name'], ['nomatch', 'plan == pro', true, false], ['nomatch', 'plan == true', true, true],
    ['blank', "plan == 'pro' AND not sys__avatar_enabled", true, true], ['blank', 'NOT sys__avatar_enabled', true, true],
    ['blank', "plan == 'pro' && n", true, true], ['blank', "plan == 'pro' || n", true, true], ['blank', '!sys__avatar_enabled', true, true],
    ['blank', "plan = 'pro'", true, true], ['blank', 'plan is "pro"', true, true], ['blank', 'len(plan) > 1', true, true],
    ['blank', 'int(n) > 5', true, true], ['blank', 'n > 5', true, true], ['blank', 'unset_name > 2', true, true],
    ['blank', 'unset_name.x == 1', true, false],
  ];
  const grammarRow = async ([expect, expr, , warn = false]) => {
    const intellect = await kaltura.intellects.add({
      type: 'internal', status: 2, allow_client_variables: true,
      prompts: [baseRules('Be terse. Greet the user in one short sentence.'), { key: 'gate', label: 'g', headerTemplate: 'Gate rule:', type: 'custom', value: `End the reply with the token ${MARK}.`, condition: expr }],
    }, admin);
    made.intellects.push(intellect.id);
    const run = () => kaltura.converseOnce(intellect.id, 'Say hi.', { request_vars: { plan: 'pro', n: '7' } });
    const reply = expect === 'match' ? await tryTwice(run, hasMark) : await run();
    const got = hasMark(reply) ? 'match' : nonEmpty(reply) ? 'nomatch' : 'blank';
    const warned = conditionWarnings(expr).length > 0;
    check(`11-grammar-${expect}: ${expr}`, got === expect && warned === warn, { got, warned, text: reply.text?.slice(0, 60) });
  };
  for (let i = 0; i < GRAMMAR.length; i += 5) await Promise.all(GRAMMAR.slice(i, i + 5).map(grammarRow));

  // 12: var types, set-twice, and skill/tool conditions that read a var
  const countTool = await kaltura.tools.add(tools.var({
    name: `live_verify_set_count_${TAG}`, description: 'Store the number the user gives. Call it with that number.',
    args: { au_count: { prompt: 'The number', type: 'int', required: true } },
  }), admin);
  made.tools.push(countTool.id);
  const countIntellect = await newIntellect([
    baseRules('Be terse. When the user gives a number, call the number tool, then reply "done".'),
    { key: 'big', label: 'b', headerTemplate: 'Big rule:', type: 'custom', value: `End every reply with the token ${MARK}.`, condition: 'au_count is defined and au_count > 2' },
  ]);
  await kaltura.intellectConfig.setToolIds(countIntellect.id, [countTool.id], admin);
  const countConv = await kaltura.sessions.createConversationToken({ configId: countIntellect.id });
  const turn = (message, threadId) => kaltura.converseOnce(countIntellect.id, message, { threadId }, countConv);
  const big = await tryTwice(async () => {
    const t1 = await turn('The number is 7.');
    return { t1, t2: await turn('Say hi.', t1.threadId) };
  }, (r) => hasMark(r.t2));
  check('12-int-var-compares-as-number', hasMark(big.t2), { calls: (big.t1.toolCalls ?? []).map((c) => c.name), text: big.t2.text?.slice(0, 80) });
  const small = await turn('The number is 1.', big.t1.threadId);
  const after = await turn('Say hi.', big.t1.threadId);
  check('12-later-var-value-wins', (small.toolCalls ?? []).length > 0 && !hasMark(after) && nonEmpty(after), { calls: (small.toolCalls ?? []).length, text: after.text?.slice(0, 80) });

  const readerSkill = await kaltura.skills.add({
    name: `live-verify-reader-${TAG}`, description: 'Scratch skill gated by a var, for scripts/live-verify-authoring.mjs',
    instructions: `If the user message contains the word PING, reply with exactly the single token ${MARK} and nothing else.`,
  }, admin);
  made.skills.push(readerSkill.id);
  const modeVar = await kaltura.tools.add(tools.var({
    name: `live_verify_set_mode2_${TAG}`, description: 'Switch the reply mode. Call it with the mode name the user asks for.',
    args: { au_mode2: { prompt: 'Mode name, lowercase', type: 'str', required: true } },
  }), admin);
  made.tools.push(modeVar.id);
  const readerIntellect = await newIntellect([baseRules('Be terse. When the user asks to switch mode, call the mode tool, then reply "done". If the user message contains PING, reply PONG.')]);
  await kaltura.intellectConfig.setToolIds(readerIntellect.id, [modeVar.id], admin);
  await kaltura.intellectConfig.setSkillIds(readerIntellect.id, [{ id: readerSkill.id, mode: 'preloaded', condition: "au_mode2 == 'zebra'" }], admin);
  const readerConv = await kaltura.sessions.createConversationToken({ configId: readerIntellect.id });
  const gatedBefore = await kaltura.converseOnce(readerIntellect.id, 'PING', {}, readerConv);
  check('12-skill-condition-closed-before-var-is-set', !hasMark(gatedBefore), { text: gatedBefore.text?.slice(0, 80) });
  const readerRun = await tryTwice(async () => {
    const t1 = await kaltura.converseOnce(readerIntellect.id, 'Switch mode to zebra.', {}, readerConv);
    return { t1, t2: await kaltura.converseOnce(readerIntellect.id, 'PING', { threadId: t1.threadId }, readerConv) };
  }, (r) => hasMark(r.t2));
  check('12-skill-condition-reads-var-next-turn', hasMark(readerRun.t2), { text: readerRun.t2.text?.slice(0, 80) });

  const gatedVar = await kaltura.tools.add(tools.var({
    name: `live_verify_record_${TAG}`, description: 'Record the value the user gives. Call it with that value.',
    args: { au_other: { prompt: 'The value', type: 'str', required: true } }, condition: "au_mode2 == 'zebra'",
  }), admin);
  made.tools.push(gatedVar.id);
  const toolReaderIntellect = await newIntellect([baseRules('Be terse. When the user asks to switch mode, call the mode tool. When the user gives a value to record, call the record tool. Then reply "done".')]);
  await kaltura.intellectConfig.setToolIds(toolReaderIntellect.id, [modeVar.id, gatedVar.id], admin);
  const toolReaderConv = await kaltura.sessions.createConversationToken({ configId: toolReaderIntellect.id });
  const recordCalled = (r) => (r.toolCalls ?? []).some((c) => c.name === gatedVar.name || /record/.test(c.name ?? ''));
  const recordBefore = await kaltura.converseOnce(toolReaderIntellect.id, 'Record the value 5.', {}, toolReaderConv);
  check('12-tool-condition-closed-before-var-is-set', !recordCalled(recordBefore) && nonEmpty(recordBefore), { calls: (recordBefore.toolCalls ?? []).map((c) => c.name) });
  const recordRun = await tryTwice(async () => {
    const t1 = await kaltura.converseOnce(toolReaderIntellect.id, 'Switch mode to zebra.', {}, toolReaderConv);
    return { t1, t2: await kaltura.converseOnce(toolReaderIntellect.id, 'Record the value 5.', { threadId: t1.threadId }, toolReaderConv) };
  }, (r) => recordCalled(r.t2));
  check('12-tool-condition-reads-var-next-turn', recordCalled(recordRun.t2), { calls: (recordRun.t2.toolCalls ?? []).map((c) => c.name) });
} catch (err) {
  failed = true;
  record('live-verify-authoring', false, errOf(err));
} finally {
  const adm = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' }).catch(() => null);
  if (adm) {
    for (const id of made.intellects) {
      try { await kaltura.intellects.delete(id, adm, { confirmPermanent: true }); record('cleanup-intellect', true, { id }); } catch (e) { failed = true; record('cleanup-intellect', false, { id, ...errOf(e) }); }
    }
    for (const id of made.tools) {
      try { await kaltura.tools.delete(id, adm, { confirmPermanent: true, force: true }); record('cleanup-tool', true, { id }); } catch (e) { failed = true; record('cleanup-tool', false, { id, ...errOf(e) }); }
    }
    for (const id of made.skills) {
      try { await kaltura.skills.delete(id, adm, { confirmPermanent: true, force: true }); record('cleanup-skill', true, { id }); } catch (e) { failed = true; record('cleanup-skill', false, { id, ...errOf(e) }); }
    }
  }
}

artifact.finishedAt = new Date().toISOString();
artifact.ok = !failed;
mkdirSync(resolve(__dirname, '../live-verify-artifacts'), { recursive: true });
const outPath = resolve(__dirname, `../live-verify-artifacts/${runId}.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written: ${outPath}`);
process.exit(failed ? 1 : 0);
