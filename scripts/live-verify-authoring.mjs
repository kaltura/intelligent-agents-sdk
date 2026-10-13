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
 *   6  {arg} placeholder       the model's arg fills an api tool's url and the
 *                              string values of its object body
 *   7  shared skills           skills.list marks shared skills with partner_id 0
 *   8  doctor                  intellectConfig.audit flags a saved templated
 *                              skill condition
 *   9  server contract         a templated condition (skill, prompt, tool) gets an
 *                              empty reply from the server: the reason the SDK
 *                              rejects it before the write
 *  10  null round trip         an unset condition reads back as null, and a tool
 *                              or skill list read from the server is accepted
 *                              again by tools.update / setSkillIds
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
  check('1-lint-bad-condition', lint.findings.some((f) => f.code === 'bad_condition'), { ok: lint.ok });
  const varErr = rejected(() => tools.var({ name: 'v', description: 'd', args: { sys__x: { prompt: 'p', type: 'str' } } }));
  check('1-var-reserved-arg-rejected', varErr?.code === 'bad_request', errOf(varErr));
  const phErr = rejected(() => tools.api({ name: 'a', description: 'd', request: { url: 'https://example.com/?c={nope}', method: 'GET' }, responseMapping: { x: 'a' } }));
  check('1-undeclared-placeholder-rejected', phErr?.code === 'bad_placeholder', errOf(phErr));

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
  check('3-skill-false-condition-silences', !hasMark(off), { text: off.text?.slice(0, 80) });

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
  check('4-var-does-not-leak-to-new-thread', !hasMark(fresh), { text: fresh.text?.slice(0, 80) });

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
  check('5-false-tool-condition-hides-tool', gatedRuns.every((r) => !called(r)), { calls: gatedRuns.map((r) => (r.toolCalls ?? []).map((c) => c.name)) });

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

  // 7: shared skills in skills.list
  const all = await kaltura.skills.list(admin).all();
  const foreign = all.filter((s) => String(s.partner_id) !== String(target.partnerId));
  check('7-foreign-skills-are-shared-partner-0', foreign.every((s) => s.partner_id === 0), { total: all.length, shared: foreign.length });
  if (foreign.length) {
    const sharedErr = await kaltura.skills.get(foreign[0].id, admin).then(() => null, (e) => e);
    check('7-shared-skill-get-not-found', sharedErr?.code === 'not_found', errOf(sharedErr));
  }

  // 8: doctor flags a saved templated skill condition
  await kaltura.intellectConfig.patch(skillIntellect.id, { skill_ids: [{ id: skill.id, mode: 'preloaded', condition: '{{ sys__avatar_enabled }}' }] }, admin);
  const report = await kaltura.intellectConfig.audit(skillIntellect.id, admin);
  check('8-doctor-flags-template-condition', report.findings.some((f) => f.code === 'skill_condition_template') && !report.findings.some((f) => f.code === 'prompt_bad_condition'), { codes: report.findings.map((f) => f.code) });

  // 9: what the server does with a templated condition (the reason the SDK refuses to write one).
  // The skill intellect still holds the templated condition from step 8. A prompt condition goes through
  // intellects.add, which does not check it. The SDK blocks a templated tool condition, so that one is
  // posted straight to the Genie endpoint, as a client that bypasses the SDK would.
  const emptyReply = (r) => (r.text ?? '').trim() === '' && !hasMark(r);
  const templatedSkill = await kaltura.converseOnce(skillIntellect.id, 'PING', {});
  check('9-server-empty-reply-for-templated-skill-condition', emptyReply(templatedSkill), { text: templatedSkill.text?.slice(0, 80) });
  const templatedPromptIntellect = await newIntellect([
    baseRules('Be terse.'),
    { key: 'tp', label: 't', headerTemplate: 'T:', type: 'custom', value: `End the reply with ${MARK}.`, condition: '{{ not sys__avatar_enabled }}' },
  ]);
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
  }

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
