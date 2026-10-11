#!/usr/bin/env node
/**
 * Audit a partner's lifecycle rules (and with --doctor, its agents and intellects).
 * READ only: it lists and gets, it never writes.
 *
 *   node scripts/lifecycle-audit.mjs [--agent <id>]... [--doctor] [--json] [--fail-on warn|error]
 *
 *   --agent <id>        Check only that agent and the rules that run for it. Repeatable.
 *   --doctor            Also audit each agent's intellect and look for unused insight settings and templates.
 *   --json              Print the report as JSON.
 *   --fail-on <level>   Exit 1 on a finding at this level or worse. Default: error.
 *
 * Exit codes: 0 nothing at or above --fail-on, 1 findings at or above it, 2 usage, auth or request error.
 * Target: TARGET=prod (default) or <name>[:<account>], see scripts/lib/target.mjs. Credentials come
 * from the environment or a .env file. Secret values are never printed.
 */
import { parseArgs } from 'node:util';
import { redact } from '../src/management/index.js';
import { resolveTarget, managementFor } from './lib/target.mjs';

const USAGE = 'usage: node scripts/lifecycle-audit.mjs [--agent <id>]... [--doctor] [--json] [--fail-on warn|error]';
const LEVELS = { info: 0, warn: 1, error: 2 };

/** @param {string} msg @returns {never} */
function usageError(msg) {
  console.error(`${msg}\n${USAGE}`);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      agent: { type: 'string', multiple: true },
      doctor: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'fail-on': { type: 'string', default: 'error' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  }));
} catch (e) {
  usageError(/** @type {Error} */ (e).message);
}
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const failOn = /** @type {string} */ (values['fail-on']);
if (failOn !== 'warn' && failOn !== 'error') usageError(`--fail-on must be warn or error, got "${failOn}".`);
const agentIds = values.agent;
if (agentIds?.some((a) => !a.trim())) usageError('--agent needs a non-empty agent id.');

const target = resolveTarget(process.env.TARGET ?? 'prod', 'TARGET', 2);
const kaltura = managementFor(target);

let report;
try {
  const admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-lifecycle-audit' });
  const opts = agentIds ? { agentIds } : {};
  report = values.doctor ? await kaltura.doctor(admin.ks, opts) : await kaltura.lifecycle.audit(admin.ks, opts);
} catch (e) {
  const err = /** @type {any} */ (e);
  console.error(`audit failed (${err?.code ?? err?.status ?? 'error'}): ${redact(String(err?.detail ?? err?.message ?? err))}`);
  process.exit(2);
}

if (values.json) {
  console.log(JSON.stringify({ target: target.name, ...report }, null, 2));
} else {
  for (const f of report.findings) {
    const where = [f.ruleId && `rule ${f.ruleId}`, f.systemName, f.agentId && `agent ${f.agentId}`, f.configId !== undefined && `intellect ${f.configId}`].filter(Boolean).join(', ');
    console.log(`[${f.severity.toUpperCase()}] ${f.code}${where ? ` (${where})` : ''}\n  ${f.message}\n  fix: ${f.fix}`);
  }
  const { error, warn, info } = report.summary;
  console.log(`${report.findings.length ? '\n' : ''}target ${target.name}: ${error} error, ${warn} warn, ${info} info.`);
  console.log(`checked: ${Object.entries(report.checked).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing'}`);
  if (report.skipped.length) console.log(`skipped: ${report.skipped.join(', ')}`);
}

const worst = report.findings.reduce((n, f) => Math.max(n, LEVELS[f.severity] ?? 0), 0);
process.exit(worst >= LEVELS[failOn] ? 1 : 0);
