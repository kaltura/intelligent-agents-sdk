#!/usr/bin/env node
/**
 * Live lifecycle-audit verification: real Kaltura API, no fakes, no mocks.
 *
 * Provisions a throwaway agent, then creates insight settings and lifecycle
 * rules, some with planted defects. Asserts that `lifecycle.audit` reports
 * exactly the expected finding codes for each rule, that a clean set reports
 * none, that `doctor` and `intellectConfig.audit` run, and that
 * `scripts/lifecycle-audit.mjs` exits 0, 1 or 2 as documented. Every rule is
 * scoped to the throwaway agent, or can never match (the one partner-wide rule
 * filters on a user id that does not exist), so no real conversation is touched.
 *
 *   1  setup               agent stack, 4 insight settings
 *   2  clean set           producer rule + email rule: no findings on either
 *   3  planted defects     one rule per code: unscoped_rule, email_on_session_ended, email_unfiltered,
 *                          changed_keys_unproduced, insight_setting_disabled, insight_setting_missing,
 *                          agent_not_found, duplicate_agent_ids, template_tokens_unproduced,
 *                          rule_disabled, dtc_without_forms, template_missing_or_deleted
 *   4  agentIds filter     rules of other agents drop out
 *   5  doctor              orphans and the template check (or the region_unavailable skip)
 *   6  intellectConfig     audit of the scratch intellect
 *   7  CLI                 exit codes against the same fixtures
 *   8  cleanup             everything deleted, then read back as gone
 *
 * `too_many_insight_settings` cannot be planted: the backend refuses more than 20 ids when a rule is saved.
 * Templates: a target with no messaging host must skip them with `skipped: ['templates']`.
 * Target: TARGET=prod (default) or <name>[:<account>], see scripts/lib/target.mjs.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isNotFound } from '../src/management/audit-report.js';
import { resolveTarget, managementFor } from './lib/target.mjs';
import { ensureAgent, deleteAgent, verifyDeleted, Report, mdTable, repoRoot } from './live-verify-kickoff-shared.mjs';

const target = resolveTarget(process.env.TARGET ?? 'prod');
const kaltura = managementFor(target);
const hasMessaging = target.name === 'prod' || Boolean(target.messagingUrl);
const tag = Date.now().toString(36);
const runId = `lifecycle-audit-${target.name}-${tag}`;
const outDir = resolve(repoRoot, 'live-verify-artifacts');
mkdirSync(outDir, { recursive: true });
const report = new Report({ runId, target: target.name });
const KEY = (n) => `LVA${n}${tag.toUpperCase()}`;

/** @type {{rules:string[], settings:string[]}} */
const created = { rules: [], settings: [] };
/** @type {Map<string,string>} rule id -> the label used in the report */
const labels = new Map();
let stack;
let admin;

const isGone = isNotFound;
const sorted = (xs) => [...xs].sort();
const scope = (...ids) => [{ field: 'object.agent_id', operator: ids.length === 1 ? 'eq' : 'in', value: ids.length === 1 ? ids[0] : ids }];
const changed = (...keys) => ({ field: 'changed_keys', operator: 'has_all', value: keys });
const preset = { actionType: 'sendInsightEmail', recipients: [`lva-${tag}`], presetType: 'conversationInsightExample' };

/** Create a rule and remember it for cleanup. @param {string} label @param {object} body @param {object} [opts] */
async function mk(label, body, opts) {
  const rule = await kaltura.lifecycle.create({ name: `LVA ${label} ${tag}`, systemName: `lva_${tag}_${label}`, objectType: 'thread', ...body }, admin.ks, opts);
  created.rules.push(rule.id);
  labels.set(rule.id, label);
  return rule;
}
/** Codes the report holds for one rule id, sorted. */
const codesOn = (findings, id) => sorted(findings.filter((f) => f.ruleId === id).map((f) => f.code));
/** Assert exact codes per rule label. @param {string} step @param {any[]} findings @param {Record<string,{id:string, expect:string[]}>} want */
function expectCodes(step, findings, want) {
  for (const [label, { id, expect }] of Object.entries(want)) {
    const got = codesOn(findings, id);
    report.check(`${step}: ${label}`, JSON.stringify(got) === JSON.stringify(sorted(expect)), { expect: sorted(expect), got });
  }
}

try {
  admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
  report.check('admin-token', Boolean(admin.ks));

  // 1: setup
  stack = await ensureAgent(kaltura, admin.ks, { brief: 'A scratch agent for a lifecycle audit check. Never talk to it.' });
  const agentId = stack.agentId;
  report.check('1-agent-stack', Boolean(agentId && stack.configId), { agentId, configId: stack.configId });
  const mkSetting = async (key, title) => {
    const s = await kaltura.insightSettings.create({ key, title, prompt: 'One short phrase, or "none".', valueType: 'string' }, admin.ks);
    created.settings.push(s.id);
    return s;
  };
  const sTopic = await mkSetting('TOPIC', `LVA topic ${tag}`);
  const sCustom = await mkSetting('CUSTOM', `LVA custom ${tag}`);
  const sOther = await mkSetting(KEY('O'), `LVA other ${tag}`);
  const sOrphan = await mkSetting(KEY('P'), `LVA orphan ${tag}`);
  const sDisabled = await mkSetting(KEY('D'), `LVA disabled ${tag}`);
  const sGone = await mkSetting(KEY('G'), `LVA gone ${tag}`);
  report.check('1-insight-settings', created.settings.length === 6, { count: created.settings.length });

  // 2: clean set
  const okInsight = await mk('ok_insight', { eventType: 'session_ended', eventConditions: scope(agentId), action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: [sTopic.id, sCustom.id] } });
  const okEmail = await mk('ok_email', { eventType: 'analysis_updated', eventConditions: [...scope(agentId), changed('SUMMARY', 'TOPIC', 'CUSTOM')], action: preset });
  const clean = await kaltura.lifecycle.audit(admin.ks, { agentIds: [agentId] });
  report.check('2-clean-report-shape', Array.isArray(clean.findings) && typeof clean.summary.error === 'number' && clean.checked.rules >= 2, { checked: clean.checked, skipped: clean.skipped });
  expectCodes('2-clean', clean.findings, { ok_insight: { id: okInsight.id, expect: [] }, ok_email: { id: okEmail.id, expect: [] } });

  // 3: planted defects
  const want = {};
  const plant = async (label, body, expect, opts) => {
    try { want[label] = { id: (await mk(label, body, opts)).id, expect }; } catch (e) {
      report.note(`3-plant ${label}: the backend refused this rule, so it is not asserted`, { code: e?.code, status: e?.status });
    }
  };
  const insight = (...ids) => ({ actionType: 'triggerInsightSettingsKai', insightSettingsIds: ids });
  await plant('unscoped', { eventType: 'session_ended', eventConditions: [{ field: 'object.user_id', operator: 'eq', value: `lva-never-${tag}` }], action: insight(sOther.id) }, ['unscoped_rule'], { partnerWide: true });
  await plant('email_ended', { eventType: 'session_ended', eventConditions: scope(agentId), action: preset }, ['email_on_session_ended']);
  await plant('email_unfiltered', { eventType: 'analysis_updated', eventConditions: scope(agentId), action: preset }, ['email_unfiltered'], { emailOnEveryUpdate: true });
  await plant('keys_unproduced', { eventType: 'analysis_updated', eventConditions: [...scope(agentId), changed('SUMMARY', 'TOPIC', 'CUSTOM', KEY('N'))], action: preset }, ['changed_keys_unproduced']);
  await plant('agent_ghost', { eventType: 'session_ended', eventConditions: scope(agentId, `lva-ghost-${tag}`), action: insight(sTopic.id) }, ['agent_not_found']);
  await plant('agent_dup', { eventType: 'session_ended', eventConditions: scope(agentId, agentId), action: insight(sTopic.id) }, ['duplicate_agent_ids']);
  await plant('no_producer', { eventType: 'analysis_updated', eventConditions: [...scope(`lva-ghost2-${tag}`), changed('SUMMARY')], action: preset }, ['agent_not_found', 'template_tokens_unproduced']);
  await plant('setting_disabled', { eventType: 'session_ended', eventConditions: scope(agentId), action: insight(sDisabled.id) }, ['insight_setting_disabled']);
  await plant('setting_gone', { eventType: 'session_ended', eventConditions: scope(agentId), action: insight(sGone.id) }, ['insight_setting_missing']);
  await plant('rule_off', { eventType: 'session_ended', eventConditions: scope(agentId), action: insight(sTopic.id) }, ['rule_disabled']);
  await plant('template_gone', { eventType: 'analysis_updated', eventConditions: [...scope(agentId), changed('SUMMARY', 'TOPIC', 'CUSTOM')], action: { actionType: 'sendInsightEmail', recipients: [`lva-${tag}`], templateId: `lva-no-such-template-${tag}` } }, hasMessaging ? ['template_missing_or_deleted'] : []);

  // A rule can only name a setting that exists when it is saved, so these two are changed afterwards.
  await kaltura.insightSettings.update(sDisabled.id, { status: 'disabled' }, admin.ks);
  await kaltura.insightSettings.delete(sGone.id, admin.ks, { confirmPermanent: true });
  created.settings = created.settings.filter((id) => id !== sGone.id);
  if (want.rule_off) await kaltura.lifecycle.update(want.rule_off.id, { status: 'disabled' }, admin.ks);
  if (want.rule_off) {
    const stored = await kaltura.lifecycle.get(want.rule_off.id, admin.ks);
    report.note('3-rule status after update(status:"disabled")', { status: stored.status });
  }
  // A target with no messaging host cannot read the template, so nothing is asserted about it.
  const planted = await kaltura.lifecycle.audit(admin.ks);
  expectCodes('3-planted', planted.findings, { ok_insight: { id: okInsight.id, expect: [] }, ok_email: { id: okEmail.id, expect: [] }, ...want });
  // A DTC rule may write any key, so key checks on its agent are skipped. It goes in after the key checks above.
  // It only flags an intellect with no forms. A fresh scratch intellect has none.
  const intellect = await kaltura.intellects.get(stack.configId, admin.ks);
  const hasForms = Array.isArray(intellect.user_properties_forms) && intellect.user_properties_forms.length > 0;
  await plant('dtc', { eventType: 'session_ended', eventConditions: scope(agentId), action: { actionType: 'triggerDtcKai' } }, hasForms ? [] : ['dtc_without_forms']);
  const withDtc = await kaltura.lifecycle.audit(admin.ks, { agentIds: [agentId] });
  if (want.dtc) expectCodes('3-planted', withDtc.findings, { dtc: want.dtc });
  report.check('3-summary-counts-the-findings', planted.summary.error + planted.summary.warn + planted.summary.info === planted.findings.length, planted.summary);
  report.check('3-every-finding-has-severity-code-fix', planted.findings.every((f) => ['error', 'warn', 'info'].includes(f.severity) && f.code && f.message && f.fix));
  const templatesSkipped = planted.skipped.includes('templates');
  report.check('3-templates-skip-matches-the-target', templatesSkipped === !hasMessaging, { hasMessaging, skipped: planted.skipped });

  // 4: agentIds filter
  const scoped = await kaltura.lifecycle.audit(admin.ks, { agentIds: [agentId] });
  report.check('4-agentIds-drops-other-agents-rules', !want.no_producer || codesOn(scoped.findings, want.no_producer.id).length === 0);
  report.check('4-agentIds-keeps-this-agents-rules', !want.email_ended || codesOn(scoped.findings, want.email_ended.id).includes('email_on_session_ended'));

  // 5: doctor
  const doctor = await kaltura.doctor(admin.ks);
  report.check('5-doctor-finds-the-orphan-setting', doctor.findings.some((f) => f.code === 'orphan_insight_setting' && f.message.includes(sOrphan.id)));
  report.check('5-doctor-template-check-matches-the-target', doctor.skipped.includes('templates') === !hasMessaging, { skipped: doctor.skipped });
  report.check('5-doctor-audited-the-scratch-intellect', doctor.checked.agentIntellects >= 1, doctor.checked);
  const mine = await kaltura.doctor(admin.ks, { agentIds: [agentId] });
  report.check('5-doctor-agentIds-skips-orphans', !mine.findings.some((f) => f.code.startsWith('orphan_')) && mine.checked.agentIntellects === 1, mine.checked);

  // 6: intellect audit
  const cfg = await kaltura.intellects.get(stack.configId, admin.ks);
  const first = (cfg.prompts ?? [])[0];
  const clean6 = await kaltura.intellectConfig.audit(stack.configId, admin.ks);
  report.check('6-intellect-audit-report-shape', clean6.checked.intellects === 1 && Array.isArray(clean6.findings), { summary: clean6.summary });
  if (first) {
    try {
      await kaltura.intellectConfig.patch(stack.configId, { prompts: [...cfg.prompts, { ...first }] }, admin.ks);
      const dup = await kaltura.intellectConfig.audit(stack.configId, admin.ks);
      report.check('6-intellect-audit-flags-a-duplicate-prompt-key', dup.findings.some((f) => f.code === 'prompt_duplicate_key'), dup.findings.map((f) => f.code));
    } catch (e) {
      report.note('6-duplicate prompt key: the backend refused the edit, so it is not asserted', { code: e?.code, status: e?.status });
    }
  }

  // 7: CLI
  const cli = (args, env = {}) => {
    const r = spawnSync(process.execPath, [resolve(repoRoot, 'scripts/lifecycle-audit.mjs'), ...args], { env: { ...process.env, TARGET: process.env.TARGET ?? 'prod', ...env }, encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const json = cli(['--json', '--agent', agentId, '--fail-on', 'error']);
  const doc = json.stdout ? JSON.parse(json.stdout) : { findings: [] };
  report.check('7-cli-json-matches-the-method', json.stdout !== '' && doc.target === target.name && codesOn(doc.findings, okEmail.id).length === 0, { exit: json.code });
  if (want.email_ended) report.check('7-cli-exit-1-with-an-error-finding', json.code === 1 && codesOn(doc.findings, want.email_ended.id).includes('email_on_session_ended'), { exit: json.code });
  report.check('7-cli-fail-on-warn-exits-1', cli(['--agent', agentId, '--fail-on', 'warn']).code === 1);
  report.check('7-cli-text-output-names-the-fix', /\[ERROR\] email_on_session_ended[\s\S]*fix: /.test(cli(['--agent', agentId]).stdout));
  report.check('7-cli-usage-error-exits-2', cli(['--fail-on', 'nope']).code === 2);
  report.check('7-cli-missing-target-credentials-exit-2', cli([], { TARGET: 'lvaabsent' }).code === 2);
  report.check('7-cli-never-prints-the-secret', !(json.stdout + json.stderr).includes(target.adminSecret));
  // Now fix everything planted and run again: the set is clean, so the exit code follows only what else is on the partner.
  for (const id of created.rules.filter((r) => ![okInsight.id, okEmail.id].includes(r))) {
    await kaltura.lifecycle.delete(id, admin.ks, { confirmPermanent: true });
    created.rules = created.rules.filter((x) => x !== id);
  }
  const after = cli(['--json', '--agent', agentId, '--fail-on', 'warn']);
  const afterDoc = JSON.parse(after.stdout);
  const mineAfter = afterDoc.findings.filter((f) => labels.has(f.ruleId));
  report.check('7-cli-clean-set-has-no-findings-on-our-rules', mineAfter.length === 0, mineAfter.map((f) => f.code));
  const rest = afterDoc.findings.filter((f) => f.severity !== 'info').length;
  report.check('7-cli-exit-code-follows-the-findings', after.code === (rest > 0 ? 1 : 0), { exit: after.code, nonInfoFindings: rest });
} catch (err) {
  report.check('run-completed', false, { code: err?.code, status: err?.status, message: String(err?.detail ?? err?.message ?? err).slice(0, 300) });
} finally {
  // 8: cleanup. Each delete runs on its own, then everything is read back.
  const leftovers = [];
  if (!admin) leftovers.push('no admin token, so nothing could be cleaned up');
  for (const id of admin ? created.rules : []) {
    try { await kaltura.lifecycle.delete(id, admin.ks, { confirmPermanent: true }); } catch (e) { if (!isGone(e)) leftovers.push(`rule ${id}`); }
  }
  for (const id of created.settings) {
    try { await kaltura.insightSettings.delete(id, admin.ks, { confirmPermanent: true }); } catch (e) { if (!isGone(e)) leftovers.push(`insight setting ${id}`); }
  }
  if (stack) await deleteAgent(kaltura, admin.ks, stack);
  const readBack = [];
  for (const id of [...created.rules]) readBack.push(kaltura.lifecycle.get(id, admin.ks).then(() => leftovers.push(`rule ${id}`), (e) => { if (!isGone(e)) leftovers.push(`rule ${id} (${e?.code})`); }));
  for (const id of created.settings) readBack.push(kaltura.insightSettings.get(id, admin.ks).then(() => leftovers.push(`insight setting ${id}`), (e) => { if (!isGone(e)) leftovers.push(`insight setting ${id} (${e?.code})`); }));
  await Promise.all(readBack);
  if (stack) {
    const gone = await verifyDeleted(kaltura, admin.ks, stack);
    for (const [what, state] of Object.entries(gone)) if (state !== 'deleted') leftovers.push(`${what}: ${state}`);
  }
  // Last, scan the whole partner for anything this run named.
  try {
    const rules = await kaltura.lifecycle.list(admin.ks).all();
    for (const r of rules) if (String(r.systemName ?? '').startsWith(`lva_${tag}_`)) leftovers.push(`rule ${r.id} (found by name)`);
  } catch (e) { leftovers.push(`rule scan failed (${e?.code})`); }
  report.check('8-cleanup-left-nothing-behind', leftovers.length === 0, leftovers);
}

const rows = report.checks.map((c) => [c.ok ? 'ok' : 'FAIL', c.name]);
report.write(outDir, `# Live lifecycle audit (${target.name})\n\n${mdTable(['result', 'check'], rows)}\n`);
console.log(`\n${report.checks.length} checks, ${report.checks.filter((c) => !c.ok).length} failed.`);
process.exit(report.failed ? 1 : 0);
