#!/usr/bin/env node
/**
 * Live doctor verification: real Kaltura API, no fakes, no mocks.
 *
 * Provisions a throwaway agent, plants misconfigurations on it, and asserts that
 * `doctor`, `doctorFix`, `doctorProbe` and `scripts/doctor.mjs` report and repair them.
 * Only the scratch agent is changed. The probe sends one short message to it.
 *
 *   0  setup          scratch agent stack
 *   1  clean          no ASR language finding on the fresh agent
 *   2  planted        replies forced to Hebrew while ASR stays English: asr_language_mismatch (error) with autofix
 *                     max_output_tokens 4096: latency_output_tokens
 *   3  doctorFix      dry run writes nothing, apply sets ASR to Hebrew, a second run is already_applied, undo restores
 *   4  probe          one timed turn, numbers present, config in effect reported
 *   5  CLI            exit codes, --json shape, --fix dry run, --probe
 *   6  cleanup        everything deleted, then read back as gone
 *
 * Target: TARGET=prod (default) or <name>[:<account>], see scripts/lib/target.mjs.
 *
 * QA note: non-production targets such as nvq2 are for employees and certified partners only.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTarget, managementFor } from './lib/target.mjs';
import { ensureAgent, deleteAgent, verifyDeleted, Report, mdTable, repoRoot } from './live-verify-kickoff-shared.mjs';

const target = resolveTarget(process.env.TARGET ?? 'prod');
const kaltura = managementFor(target);
const runId = `doctor-${target.name}-${Date.now().toString(36)}`;
const outDir = resolve(repoRoot, 'live-verify-artifacts');
mkdirSync(outDir, { recursive: true });
const report = new Report({ runId, target: target.name });

let stack;
let admin;
const codes = (r, agentId) => r.findings.filter((f) => f.agentId === agentId || f.agentIds?.includes(agentId)).map((f) => `${f.severity}:${f.code}`);

try {
  admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
  report.check('admin-token', Boolean(admin.ks));

  stack = await ensureAgent(kaltura, admin.ks, { brief: 'A scratch agent for a doctor check. Answer in one short sentence.' });
  const { agentId, configId } = stack;
  report.check('0-agent-stack', Boolean(agentId && configId), { agentId, configId });

  // 1: clean
  const clean = await kaltura.doctor(admin.ks, { agentIds: [agentId] });
  report.check('1-clean-has-no-asr-language-finding', !clean.findings.some((f) => f.code === 'asr_language_mismatch'), codes(clean, agentId));
  report.check('1-clean-reads-the-agent-and-its-intellect', clean.checked.agents >= 1 && clean.checked.agentIntellects === 1, clean.checked);

  // 2: planted
  await kaltura.intellectConfig.patch(configId, { force_language: 'Hebrew' }, admin.ks);
  let outputTokensPlanted = true;
  try {
    await kaltura.intellectConfig.patch(configId, (cur) => ({ model_configuration: { ...(cur.model_configuration ?? {}), max_output_tokens: 4096 } }), admin.ks);
  } catch (e) {
    outputTokensPlanted = false;
    report.note('2-max_output_tokens: the backend refused the edit, so it is not asserted', { code: e?.code, status: e?.status });
  }
  const planted = await kaltura.doctor(admin.ks, { agentIds: [agentId] });
  const mismatch = planted.findings.find((f) => f.code === 'asr_language_mismatch' && f.agentId === agentId);
  report.check('2-asr-mismatch-is-an-error', mismatch?.severity === 'error', codes(planted, agentId));
  report.check('2-asr-mismatch-carries-an-autofix', mismatch?.autofix?.action === 'set_asr_language' && mismatch.autofix.to === 'he', mismatch?.autofix);
  if (outputTokensPlanted) report.check('2-latency-output-tokens', planted.findings.some((f) => f.code === 'latency_output_tokens' && f.agentIds?.includes(agentId)), codes(planted, agentId));
  report.check('2-every-finding-has-severity-code-message-fix', planted.findings.every((f) => ['error', 'warn', 'info'].includes(f.severity) && f.code && f.message && f.fix));

  // 3: doctorFix
  const before = (await kaltura.agents.get(agentId, admin.ks)).asr;
  const dry = await kaltura.doctorFix(admin.ks, planted);
  const planned = dry.results.find((r) => r.agentId === agentId);
  report.check('3-dry-run-plans-and-writes-nothing', planned?.status === 'planned' && (await kaltura.agents.get(agentId, admin.ks)).asr?.language === before?.language, planned);
  const applied = await kaltura.doctorFix(admin.ks, planted, { apply: true, codes: ['asr_language_mismatch'] });
  const done = applied.results.find((r) => r.agentId === agentId);
  const after = (await kaltura.agents.get(agentId, admin.ks)).asr;
  report.check('3-apply-sets-the-asr-language', applied.applied === true && done?.status === 'applied' && after?.language === 'he' && after?.provider === before?.provider, { status: done?.status, after });
  const again = await kaltura.doctorFix(admin.ks, planted, { apply: true, codes: ['asr_language_mismatch'] });
  report.check('3-second-apply-is-already-applied', again.results.find((r) => r.agentId === agentId)?.status === 'already_applied');
  const fixed = await kaltura.doctor(admin.ks, { agentIds: [agentId] });
  report.check('3-doctor-no-longer-reports-the-mismatch', !fixed.findings.some((f) => f.code === 'asr_language_mismatch' && f.agentId === agentId), codes(fixed, agentId));
  await kaltura.agents.update(done.undo, admin.ks);
  report.check('3-undo-restores-the-old-setting', (await kaltura.agents.get(agentId, admin.ks)).asr?.language === before?.language);

  // 4: probe
  const probeOpts = { agentId, message: 'Say hello in one short sentence.', timeoutMs: 90000 };
  const guarded = await kaltura.doctorProbe(admin.ks, probeOpts);
  report.check('4-probe-runs-only-when-no-rule-matches', guarded.ran === (guarded.rules.length === 0), { ran: guarded.ran, rules: guarded.rules.length });
  const probe = guarded.ran ? guarded : await kaltura.doctorProbe(admin.ks, { ...probeOpts, allowSideEffects: true });
  report.check('4-probe-ran-without-error', probe.ran && probe.error === null, { error: probe.error });
  report.check('4-probe-has-timings', Number.isFinite(probe.timings?.totalMs) && probe.timings.totalMs > 0, probe.timings);
  report.check('4-probe-reply-facts', probe.reply && typeof probe.reply.replyChars === 'number' && probe.reply.spiralStopped === false, probe.reply);
  report.check('4-probe-reports-the-config-in-effect', probe.configId === configId && (!outputTokensPlanted || probe.config?.maxOutputTokens === 4096), probe.config);
  report.check('4-probe-says-what-it-cannot-show', /no speech recognition/.test(probe.limits));

  // 5: CLI
  const cli = (args, env = {}) => {
    const r = spawnSync(process.execPath, [resolve(repoRoot, 'scripts/doctor.mjs'), ...args], { env: { ...process.env, TARGET: process.env.TARGET ?? 'prod', ...env }, encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const json = cli(['--agent', agentId, '--json', '--fix']);
  const doc = json.stdout ? JSON.parse(json.stdout) : {};
  report.check('5-cli-json-shape', doc.schemaVersion === 1 && doc.target === target.name && Array.isArray(doc.report?.findings), { exit: json.code });
  report.check('5-cli-dry-fix-plans-and-writes-nothing', doc.fix?.applied === false && doc.fix.results.some((r) => r.agentId === agentId && r.status === 'planned') && (await kaltura.agents.get(agentId, admin.ks)).asr?.language === before?.language, doc.fix);
  report.check('5-cli-usage-error-exits-2', cli(['--probe']).code === 2);
  report.check('5-cli-never-prints-the-secret', !(json.stdout + json.stderr).includes(target.adminSecret));
  const probed = cli(['--agent', agentId, '--only', 'orphans', '--probe', '--allow-side-effects']);
  report.check('5-cli-probe-prints-timings', probed.code === 0 && /first segment \d+ ms/.test(probed.stdout), { exit: probed.code });
} catch (err) {
  report.check('run-completed', false, { code: err?.code, status: err?.status, message: String(err?.detail ?? err?.message ?? err).slice(0, 300) });
} finally {
  const leftovers = [];
  if (!admin) leftovers.push('no admin token, so nothing could be cleaned up');
  if (stack && admin) {
    await deleteAgent(kaltura, admin.ks, stack);
    const gone = await verifyDeleted(kaltura, admin.ks, stack);
    for (const [what, state] of Object.entries(gone)) if (state !== 'deleted') leftovers.push(`${what}: ${state}`);
  }
  report.check('6-cleanup-left-nothing-behind', leftovers.length === 0, leftovers);
}

const rows = report.checks.map((c) => [c.ok ? 'ok' : 'FAIL', c.name]);
report.write(outDir, `# Live doctor (${target.name})\n\n${mdTable(['result', 'check'], rows)}\n`);
console.log(`\n${report.checks.length} checks, ${report.checks.filter((c) => !c.ok).length} failed.`);
process.exit(report.failed ? 1 : 0);
