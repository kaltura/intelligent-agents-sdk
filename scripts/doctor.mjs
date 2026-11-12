#!/usr/bin/env node
/**
 * Find what is misconfigured on a partner's agents. Reads only, unless you pass --fix --apply.
 *
 *   node scripts/doctor.mjs [--agent <id>]... [--only <name>]... [--skip <name>]...
 *                           [--ignore-file <path>] [--fail-on warn|error] [--json | --format text|markdown]
 *                           [--fix [--apply --code <code>...]]
 *
 *   --agent <id>        Check only that agent and the rules that run for it. Repeatable.
 *   --only, --skip      Run only, or leave out, these check ids or categories. Repeatable.
 *   --ignore-file       JSON file: an array of { code, agentId?, configId?, ruleId?, field? }. Hidden findings are counted.
 *   --fail-on <level>   Exit 1 on a finding at this level or worse. Default: error.
 *   --json              Print { schemaVersion, target, report, fix? } as JSON.
 *   --format <f>        text (default) or markdown.
 *   --fix               Also plan the guided fixes (dry run). Writes nothing.
 *   --apply --code <c>  With --fix: write the fixes for these finding codes. Repeatable.
 *
 * Exit codes: 0 nothing at or above --fail-on, 1 findings at or above it, 2 usage, auth or request error.
 * The exit code comes from the report, not from the fixes. Run the doctor again after --apply.
 * Target: TARGET=prod (default) or <name>[:<account>], see scripts/lib/target.mjs. Credentials come
 * from the environment or a .env file. Secret values are never printed.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { redact } from '../src/management/index.js';
import { resolveTarget, managementFor } from './lib/target.mjs';

const USAGE = 'usage: node scripts/doctor.mjs [--agent <id>]... [--only <name>]... [--skip <name>]... [--ignore-file <path>] [--fail-on warn|error] [--json | --format text|markdown] [--fix [--apply --code <code>...]]';
const LEVELS = { info: 0, warn: 1, error: 2 };
/** Bump when the --json shape changes. */
const SCHEMA_VERSION = 1;

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
      only: { type: 'string', multiple: true },
      skip: { type: 'string', multiple: true },
      'ignore-file': { type: 'string' },
      'fail-on': { type: 'string', default: 'error' },
      json: { type: 'boolean', default: false },
      format: { type: 'string', default: 'text' },
      fix: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      code: { type: 'string', multiple: true },
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
if (values.format !== 'text' && values.format !== 'markdown') usageError(`--format must be text or markdown, got "${values.format}".`);
if (values.json && values.format !== 'text') usageError('--json and --format cannot be combined.');
for (const [flag, list] of [['--agent', values.agent], ['--only', values.only], ['--skip', values.skip], ['--code', values.code]]) {
  if (list?.some((v) => !v.trim())) usageError(`${flag} needs a non-empty value.`);
}
if (values.apply && !values.fix) usageError('--apply needs --fix.');
if (values.apply && !values.code?.length) usageError('--apply needs at least one --code, for example --code asr_language_mismatch.');
if (values.code?.length && !values.fix) usageError('--code needs --fix.');

/** @type {object[]|undefined} */
let ignore;
if (values['ignore-file']) {
  try {
    const parsed = JSON.parse(readFileSync(values['ignore-file'], 'utf8'));
    ignore = Array.isArray(parsed) ? parsed : parsed?.ignore;
  } catch (e) {
    usageError(`--ignore-file could not be read as JSON: ${/** @type {Error} */ (e).message}`);
  }
  if (!Array.isArray(ignore)) usageError('--ignore-file must hold a JSON array of ignore items, or { "ignore": [...] }.');
}

const target = resolveTarget(process.env.TARGET ?? 'prod', 'TARGET', 2);
const kaltura = managementFor(target);

let report;
let fix;
try {
  const admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-doctor' });
  report = await kaltura.doctor(admin.ks, {
    ...(values.agent ? { agentIds: values.agent } : {}),
    ...(values.only ? { only: values.only } : {}),
    ...(values.skip ? { skip: values.skip } : {}),
    ...(ignore ? { ignore } : {}),
  });
  if (values.fix) fix = await kaltura.doctorFix(admin.ks, report, values.apply ? { apply: true, codes: values.code } : {});
} catch (e) {
  const err = /** @type {any} */ (e);
  console.error(`doctor failed (${err?.code ?? err?.status ?? 'error'}): ${redact(String(err?.detail ?? err?.message ?? err))}`);
  process.exit(2);
}

/** @param {any} f */
const where = (f) => [
  f.ruleId && `rule ${f.ruleId}`, f.systemName,
  f.agentId && `agent ${f.agentId}`, f.agentIds && `agents ${f.agentIds.join(' ')}`,
  f.configId !== undefined && `intellect ${f.configId}`,
].filter(Boolean).join(', ');

/** @param {any} r */
const fixLine = (r) => `${r.status}: agent ${r.agentId} asr.language ${r.before.language ?? '?'} -> ${r.after.language}${r.reason ? ` (${r.reason})` : ''}`;

/** @param {any} r @returns {string} */
function counts(r) {
  const { error, warn, info, suppressed } = r.summary;
  return `${error} error, ${warn} warn, ${info} info${suppressed !== undefined ? `, ${suppressed} ignored` : ''}`;
}

if (values.json) {
  console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, target: target.name, report, ...(fix ? { fix } : {}) }, null, 2));
} else if (values.format === 'markdown') {
  const lines = [`# Doctor report: ${target.name}`, '', `${counts(report)}.`, ''];
  if (report.findings.length) {
    lines.push('| Severity | Code | Where | Message | Fix |', '|---|---|---|---|---|');
    const cell = (/** @type {string} */ s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    for (const f of report.findings) lines.push(`| ${f.severity} | \`${f.code}\` | ${cell(where(f))} | ${cell(f.message)} | ${cell(f.fix)} |`);
    lines.push('');
  }
  if (report.skipped.length) lines.push(`Skipped: ${report.skipped.join(', ')}`, '');
  if (fix) lines.push('## Fixes', '', ...(fix.results.length ? fix.results.map((r) => `- ${fixLine(r)}`) : ['None available.']), '');
  console.log(lines.join('\n').trimEnd());
} else {
  for (const f of report.findings) console.log(`[${f.severity.toUpperCase()}] ${f.code}${where(f) ? ` (${where(f)})` : ''}\n  ${f.message}\n  fix: ${f.fix}`);
  console.log(`${report.findings.length ? '\n' : ''}target ${target.name}: ${counts(report)}.`);
  console.log(`checked: ${Object.entries(report.checked).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing'}`);
  if (report.skipped.length) console.log(`skipped: ${report.skipped.join(', ')}`);
  if (fix) {
    console.log(fix.results.length ? `\nfixes${values.apply ? '' : ' (dry run, nothing written)'}:` : '\nfixes: none available.');
    for (const r of fix.results) console.log(`  ${fixLine(r)}`);
  }
}

const worst = report.findings.reduce((n, f) => Math.max(n, LEVELS[f.severity] ?? 0), 0);
process.exitCode = worst >= LEVELS[failOn] ? 1 : 0;
