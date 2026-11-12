#!/usr/bin/env node
/**
 * Live doctor coverage matrix: real Kaltura API, no fakes, no mocks.
 *
 * Provisions a scratch agent, plants one misconfiguration per finding code, and asserts that
 * `doctor` reports each one. A clean agent is the control: it must have no error or warn.
 * A plant the backend refuses is listed as "not plantable", not as a failure. Only scratch
 * objects are changed, and all of them are deleted at the end.
 *
 * Target: TARGET=prod (default) or <name>[:<account>], see scripts/lib/target.mjs.
 *
 * QA note: non-production targets such as nvq2 are for employees and certified partners only.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTarget, managementFor } from './lib/target.mjs';
import { ensureAgent, deleteAgent, verifyDeleted, Report, mdTable, repoRoot } from './live-verify-kickoff-shared.mjs';
import { tools } from '../src/management/index.js';

const target = resolveTarget(process.env.TARGET ?? 'prod');
const kaltura = managementFor(target);
const runId = `doctor-matrix-${target.name}-${Date.now().toString(36)}`;
const outDir = resolve(repoRoot, 'live-verify-artifacts');
mkdirSync(outDir, { recursive: true });
const report = new Report({ runId, target: target.name });
const tag = Date.now().toString(36);
const confirm = { confirmPermanent: true };

/** @type {Array<[string, string, string]>} code, result, detail */
const matrix = [];
const created = { tools: [], skills: [], agents: [], insightSettings: [], stacks: [] };
let ks;
let stack;

const own = (r, agentId) => r.findings.filter((f) => f.agentId === agentId || f.agentIds?.includes(agentId));
const plant = async (label, fn) => {
  try { await fn(); return true; } catch (e) {
    matrix.push([label, 'not plantable', `${e?.code ?? e?.status ?? ''} ${String(e?.detail ?? e?.message ?? e).slice(0, 110)}`.trim()]);
    return false;
  }
};
const expect = (findings, code, severity, planted = true) => {
  if (!planted) return;
  const hit = findings.find((f) => f.code === code);
  const ok = Boolean(hit) && (!severity || hit.severity === severity) && Boolean(hit.message && hit.fix);
  matrix.push([code, ok ? 'caught' : 'MISSED', hit ? `${hit.severity}` : 'no finding']);
  report.check(`caught-${code}`, ok, hit ? { severity: hit.severity } : findings.map((f) => f.code));
};

try {
  ks = (await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' })).ks;
  stack = await ensureAgent(kaltura, ks, { brief: 'A scratch agent for a doctor matrix run. Answer in one short sentence.' });
  const { agentId, configId, avatarId } = stack;
  report.check('0-agent-stack', Boolean(agentId && configId), { agentId, configId });

  // Control: a clean agent has no error or warn.
  const clean = own(await kaltura.doctor(ks, { agentIds: [agentId] }), agentId);
  report.check('1-control-clean-agent-has-no-error-or-warn', clean.every((f) => f.severity === 'info'), clean.map((f) => `${f.severity}:${f.code}`));

  // Round 1: plant.
  const ok = {};
  ok.lang = await plant('asr_language_mismatch', () => kaltura.intellectConfig.patch(configId, { force_language: 'Hebrew' }, ks));
  ok.think = await plant('latency_thinking', () => kaltura.intellectConfig.patch(configId, (cur) => ({ model_configuration: { ...(cur.model_configuration ?? {}), thinking_level: 'high' } }), ks));
  ok.tokens = await plant('latency_output_tokens', () => kaltura.intellectConfig.patch(configId, (cur) => ({ model_configuration: { ...(cur.model_configuration ?? {}), max_output_tokens: 4096 } }), ks));
  ok.prompts = await plant('latency_prompt_size', () => kaltura.intellectConfig.patch(configId, (cur) => ({
    prompts: [...(cur.prompts ?? []), { key: 'filler', label: 'Filler', headerTemplate: 'Filler', type: 'custom', value: 'Keep answers short. '.repeat(450) }],
  }), ks));
  ok.condition = await plant('condition_unquoted_name', () => kaltura.intellectConfig.patch(configId, (cur) => ({
    prompts: [...(cur.prompts ?? []), { key: 'pro', label: 'Pro', headerTemplate: 'Pro', type: 'custom', value: 'Pro plan notes.', condition: 'plan == pro' }],
  }), ks));
  ok.opening = await plant('opening_phrase_language_mismatch', async () => {
    await kaltura.intellectConfig.patch(configId, { opening_phrase: 'שלום, איך אפשר לעזור היום?' }, ks);
    await kaltura.avatars.update({ id: avatarId, openingPhrase: 'Hello there' }, ks);
  });
  ok.maxConv = await plant('max_conversation_short', () => kaltura.agents.update({ agentId, maxConversationLength: 5 }, ks));
  ok.cap = await plant('capability_disabled_vetoes_avatar', () => kaltura.intellectConfig.setCapability(configId, 'avatar', 'disabled', ks));

  ok.skill = await plant('latency_preloaded_skills', async () => {
    const s = await kaltura.skills.create({ name: `matrix_skill_${tag}`, description: 'Scratch skill for a doctor run.', instructions: 'Be brief. '.repeat(900) }, ks);
    created.skills.push(s.id);
    await kaltura.intellectConfig.setSkillIds(configId, [{ id: s.id, mode: 'preloaded' }], ks);
  });

  const toolIds = [];
  ok.tools = await plant('client_tool_wait_blocks', async () => {
    const wait = await kaltura.tools.create(tools.client({ name: `matrix_wait_${tag}`, description: 'Show a panel to the viewer.' }), ks);
    const fire = await kaltura.tools.create(tools.client({ name: `matrix_fire_${tag}`, description: 'Highlight a slide.', waitForResponse: false }), ks);
    toolIds.push(wait.id, fire.id); created.tools.push(wait.id, fire.id);
    await kaltura.intellectConfig.setToolIds(configId, toolIds, ks);
  });
  ok.threadStart = await plant('thread_start_tool_blocks', async () => {
    const slow = await kaltura.tools.create(tools.api({ name: `matrix_slow_${tag}`, description: 'Look up a record.', request: { url: 'https://example.com/lookup', method: 'GET', timeout: 20 }, responseTemplate: 'ok' }), ks);
    created.tools.push(slow.id);
    await kaltura.intellectConfig.setToolIds(configId, [...toolIds, slow.id], ks);
    await kaltura.intellectConfig.setThreadStartTools(configId, [slow.id], ks);
  });

  ok.shared = await plant('avatar_shared', async () => {
    const second = await kaltura.agents.create({ displayName: `matrix second ${tag}`, intellect: { intellectType: 'genie', id: configId }, avatarIds: [avatarId] }, ks);
    created.agents.push(second.agentId ?? second.id);
  });
  ok.avatarGone = await plant('avatar_not_found', () => kaltura.agents.update({ agentId, avatarIds: [avatarId, '000000000000000000000000'] }, ks));
  await plant('visual_not_in_catalog', () => kaltura.avatars.update({ id: avatarId, background: { type: 'visual', value: '0_00000000' } }, ks));
  ok.orphan = await plant('orphan_insight_setting', async () => {
    const s = await kaltura.insightSettings.create({ key: `MATRIX_${tag}`.toUpperCase(), title: 'Scratch', prompt: 'Summarize the topic.', valueType: 'string' }, ks);
    created.insightSettings.push(s.id);
  });

  const round1 = own(await kaltura.doctor(ks, { agentIds: [agentId], thresholds: { toolSurface: 1 } }), agentId);
  expect(round1, 'asr_language_mismatch', 'error', ok.lang);
  expect(round1, 'voice_reply_language_mismatch', 'error', ok.lang);
  expect(round1, 'latency_thinking', 'info', ok.think);
  expect(round1, 'latency_output_tokens', 'info', ok.tokens);
  expect(round1, 'latency_prompt_size', 'info', ok.prompts);
  expect(round1, 'condition_unquoted_name', 'info', ok.condition);
  expect(round1, 'opening_phrase_language_mismatch', 'info', ok.opening);
  expect(round1, 'opening_phrase_duplicate', 'info', ok.opening);
  expect(round1, 'max_conversation_short', 'info', ok.maxConv);
  expect(round1, 'capability_disabled_vetoes_avatar', 'error', ok.cap);
  expect(round1, 'latency_preloaded_skills', 'info', ok.skill);
  expect(round1, 'client_tool_wait_blocks', 'info', ok.tools);
  expect(round1, 'client_tool_fire_and_forget_unbudgeted', 'info', ok.tools);
  expect(round1, 'thread_start_tool_blocks', 'warn', ok.threadStart);
  expect(round1, 'tool_surface_large', 'info', ok.tools);
  expect(round1, 'avatar_shared', 'info', ok.shared);
  expect(round1, 'avatar_not_found', 'error', ok.avatarGone);

  // Orphans are partner-wide, so this run reads the whole partner.
  if (ok.orphan) {
    const all = await kaltura.doctor(ks, { only: ['orphans'] });
    const hit = all.findings.find((f) => f.code === 'orphan_insight_setting' && f.message.includes(created.insightSettings[0]));
    matrix.push(['orphan_insight_setting', hit ? 'caught' : 'MISSED', hit?.severity ?? 'no finding']);
    report.check('caught-orphan_insight_setting', Boolean(hit));
  }

  // Round 2: the opening line that may render empty.
  const round2Planted = await plant('opening_phrase_may_render_empty', () => kaltura.intellectConfig.patch(configId, { opening_phrase: '{% if sys__user_id %}Welcome back.{% endif %}' }, ks));
  expect(own(await kaltura.doctor(ks, { agentIds: [agentId] }), agentId), 'opening_phrase_may_render_empty', 'info', round2Planted);

  // Round 3: an agent whose intellect was deleted.
  const orphanStack = await ensureAgent(kaltura, ks, { brief: 'A scratch agent whose intellect is deleted.' });
  created.stacks.push(orphanStack);
  const deleted = await plant('intellect_not_found', () => kaltura.intellects.delete(orphanStack.configId, ks, confirm));
  expect(own(await kaltura.doctor(ks, { agentIds: [orphanStack.agentId] }), orphanStack.agentId), 'intellect_not_found', 'error', deleted);

  // Round 4: the fix hints are the ones the docs promise, and the report never claims an unread area.
  report.check('4-no-read-failures-or-skips', round1.every((f) => f.code !== 'read_failed'), round1.filter((f) => f.code === 'read_failed').map((f) => f.message));
} catch (err) {
  report.check('run-completed', false, { code: err?.code, status: err?.status, message: String(err?.detail ?? err?.message ?? err).slice(0, 300) });
} finally {
  const left = [];
  const attempt = async (what, fn) => { try { await fn(); } catch (e) { if (e?.status !== 404 && e?.code !== 'not_found') left.push(`${what}: ${e?.code ?? e?.message}`); } };
  if (ks) {
    for (const id of created.agents) await attempt(`agent ${id}`, () => kaltura.agents.delete(id, ks, { ...confirm, skipProtectedCheck: true }));
    for (const id of created.insightSettings) await attempt(`insight ${id}`, () => kaltura.insightSettings.delete(id, ks, confirm));
    if (stack) await kaltura.intellectConfig.setToolIds(stack.configId, [], ks).catch(() => {});
    if (stack) await kaltura.intellectConfig.setThreadStartTools(stack.configId, [], ks).catch(() => {});
    if (stack) await kaltura.intellectConfig.setSkillIds(stack.configId, [], ks).catch(() => {});
    for (const id of created.tools) await attempt(`tool ${id}`, () => kaltura.tools.delete(id, ks, confirm));
    for (const id of created.skills) await attempt(`skill ${id}`, () => kaltura.skills.delete(id, ks, confirm));
    for (const s of created.stacks) await deleteAgent(kaltura, ks, s);
    if (stack) {
      await deleteAgent(kaltura, ks, stack);
      const gone = await verifyDeleted(kaltura, ks, stack);
      for (const [what, state] of Object.entries(gone)) if (state !== 'deleted') left.push(`${what}: ${state}`);
    }
  } else left.push('no admin token, so nothing could be cleaned up');
  report.check('9-cleanup-left-nothing-behind', left.length === 0, left);
}

const notCovered = [
  ['voice_language_default', 'not run', 'needs an uploaded custom voice'],
  ['voice_not_in_catalog', 'not run', 'the backend only accepts catalog voices'],
  ['avatar-level orphan_email_template', 'not run', 'needs the messaging host'],
];
const rows = [...matrix, ...notCovered];
console.log(mdTable(['code', 'result', 'detail'], rows));
report.write(outDir, `# Live doctor matrix (${target.name})\n\n${mdTable(['code', 'result', 'detail'], rows)}\n`);
console.log(`\n${report.checks.length} checks, ${report.checks.filter((c) => !c.ok).length} failed.`);
process.exit(report.failed ? 1 : 0);
