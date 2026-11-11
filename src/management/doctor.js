/**
 * Doctor: one read-only health check over a partner's agents. Runs the
 * lifecycle audit, the intellect audit for each intellect, a registry of
 * checks over each agent and its avatars, and looks for insight settings and
 * email templates that no rule uses. Reached through `mgmt.doctor(ks, opts)`.
 * Finding codes: docs/DOCTOR.md.
 */
import { redact } from '../core/redact.js';
import { KalturaError } from '../core/errors.js';
import { auditReport } from './audit-report.js';
import { CHECKS, runChecks, selectChecks } from './doctor/checks/index.js';
import { gather, isTokenError } from './doctor/gather.js';
import { DEFAULT_THRESHOLDS } from './doctor/model.js';

/** @typedef {import('./audit-report.js').AuditFinding} AuditFinding */

/**
 * A finding to hide. Every key you set must match. `agentId` also matches a
 * finding about several agents that includes it.
 * @typedef {object} DoctorIgnore
 * @property {string} code
 * @property {string} [agentId]
 * @property {number} [configId]
 * @property {string} [ruleId]
 * @property {string} [field]
 */

/**
 * Options of {@link Doctor#run}.
 * @typedef {object} DoctorOptions
 * @property {string[]} [agentIds] Limit the check to these agents, plus the rules that run for them.
 * @property {number} [pageSize] Page size of every list read.
 * @property {string[]} [only] Run only these checks. A name is a check id or a category: `lifecycle`, `intellect`, `orphans`, `agent`, `avatar`, `language`.
 * @property {string[]} [skip] Do not run these. Wins over `only`.
 * @property {DoctorIgnore[]} [ignore] Findings to hide. The report counts them in `summary.suppressed`.
 * @property {import('./doctor/model.js').DoctorThresholds} [thresholds] Limits the hint checks compare against.
 * @property {number} [concurrency] Most reads in flight at once. Default 4.
 */

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };
const IGNORE_KEYS = /** @type {const} */ (['code', 'agentId', 'configId', 'ruleId', 'field']);

/** @param {unknown} ignore @returns {DoctorIgnore[]} */
function checkedIgnore(ignore) {
  if (ignore === undefined) return [];
  if (!Array.isArray(ignore) || ignore.some((r) => !r || typeof r !== 'object' || typeof r.code !== 'string' || !r.code)) {
    throw new KalturaError({ type: 'about:blank', title: 'invalid ignore list', code: 'bad_request', detail: 'doctor: ignore must be an array of { code, agentId?, configId?, ruleId?, field? } objects, each with a code.' });
  }
  return ignore;
}

/** True when `rule` hides `finding`. @param {DoctorIgnore} rule @param {AuditFinding} finding */
function ignores(rule, finding) {
  return IGNORE_KEYS.every((key) => {
    if (rule[key] === undefined) return true;
    if (key === 'agentId') return finding.agentId === rule.agentId || (finding.agentIds?.includes(rule.agentId ?? '') ?? false);
    return finding[key] === rule[key];
  });
}

/** Order: severity, then code, then the id the finding is about. @param {AuditFinding} a @param {AuditFinding} b */
function byImportance(a, b) {
  const key = (/** @type {AuditFinding} */ f) => String(f.agentId ?? f.agentIds?.[0] ?? f.configId ?? f.ruleId ?? '');
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.code.localeCompare(b.code) || key(a).localeCompare(key(b)) || (a.field ?? '').localeCompare(b.field ?? '') || a.message.localeCompare(b.message);
}

/** A short, safe description of a failed read. @param {any} e */
function describe(e) {
  const head = [e?.status ? `HTTP ${e.status}` : '', e?.code].filter(Boolean).join(' ');
  return head || String(e?.message ?? e).slice(0, 200);
}

/** @param {{area:string, id?:string, error:unknown}} f @returns {AuditFinding} */
function readFailed(f) {
  const configId = f.area.startsWith('intellect') && f.id !== undefined ? Number(f.id) : undefined;
  return {
    severity: 'info', code: 'read_failed', field: f.area, ...(configId !== undefined && Number.isInteger(configId) ? { configId } : {}),
    message: `Could not read ${f.area}${f.id !== undefined ? ` ${f.id}` : ''} (${describe(f.error)}). The checks that need it were skipped.`,
    fix: 'Check that the token may read it, then run the doctor again.',
  };
}

export class Doctor {
  /**
   * @param {import('./client.js').Ctx} ctx
   * @param {{lifecycle:import('./lifecycle.js').Lifecycle, intellectConfig:import('./intellect-config.js').IntellectConfig, intellects:import('./intellects.js').Intellects, agents:import('./agents.js').Agents, avatars:import('./avatars.js').Avatars, catalog:import('./catalog.js').Catalog, insightSettings:import('./insight-settings.js').InsightSettings, emailTemplates:import('./email-templates.js').EmailTemplates}} deps
   */
  constructor(ctx, deps) {
    this._ = ctx;
    this._deps = deps;
  }

  /**
   * Check the partner's agents. READ only, it changes nothing. Returns one
   * report that merges:
   * - {@link Lifecycle#audit}: every rule (category `lifecycle`).
   * - {@link IntellectConfig#audit}: each intellect once (category `intellect`).
   *   A finding about an intellect carries `agentIds`, the agents that use it.
   * - Agent checks (categories `agent`, `avatar`, `language`): the intellect,
   *   avatars, voices and visuals each agent points at. See docs/DOCTOR.md.
   * - Orphans (category `orphans`): `orphan_insight_setting` and
   *   `orphan_email_template` (both `info`) for entities no rule uses. Skipped
   *   when `agentIds` is set, since an orphan belongs to no agent.
   *
   * A read that fails (a 403, a 5xx) becomes a `read_failed` finding, adds its
   * area to `skipped`, and the run goes on. Only an unusable token stops it.
   * A check that throws becomes `check_failed`. If the Messaging host is not
   * available (`region_unavailable`), the template checks are skipped and the
   * report says `skipped: ['templates']`. Findings are sorted by severity,
   * then code, then id.
   * @param {string} ks (admin)
   * @param {DoctorOptions} [opts]
   * @returns {Promise<import('./audit-report.js').AuditReport>}
   */
  async run(ks, opts = {}) {
    this._.assertAdmin(ks, 'doctor');
    const { lifecycle, agents, insightSettings, emailTemplates } = this._deps;
    const { agentIds, pageSize } = opts;
    const ignore = checkedIgnore(opts.ignore);
    const concurrency = opts.concurrency ?? 4;
    const thresholds = { ...DEFAULT_THRESHOLDS, ...Object.fromEntries(Object.entries(opts.thresholds ?? {}).filter(([, v]) => v !== undefined)) };
    const on = (/** @type {string} */ group) => (!opts.only?.length || opts.only.includes(group)) && !opts.skip?.includes(group);

    const all = await agents.list(ks, { pageSize }).all();
    const idOf = (/** @type {any} */ a) => a.agentId ?? a.id;
    const selected = new Set((agentIds ? all.filter((a) => agentIds.includes(idOf(a))) : all).map(idOf));

    /** @type {AuditFinding[]} */
    const findings = [];
    /** @type {Array<{area:string, id?:string, error:unknown}>} */
    const failures = [];
    /** @type {Record<string, number>} */
    const checked = {};
    /** @type {string[]} */
    const skipped = [];
    /** Run a read. A token error stops the run. Anything else becomes a failure. @param {string} area @param {()=>Promise<void>} read */
    const guarded = async (area, read) => {
      try { await read(); } catch (e) {
        if (isTokenError(e)) throw e;
        failures.push({ area, error: e });
      }
    };

    if (on('lifecycle')) {
      await guarded('lifecycle', async () => {
        const report = await lifecycle.audit(ks, { agentIds, pageSize, agents: all });
        findings.push(...report.findings);
        Object.assign(checked, report.checked);
        skipped.push(...report.skipped);
      });
    }

    const checks = selectChecks(CHECKS, opts);
    const gathered = await gather(ks, this._deps, {
      agents: all, selected, needs: new Set(checks.flatMap((c) => c.needs)), audit: on('intellect'), pageSize, concurrency,
    });
    failures.push(...gathered.failures);
    Object.assign(checked, gathered.checked, { agents: selected.size });
    findings.push(...gathered.intellectFindings, ...runChecks({ agents: gathered.agents, intellects: gathered.intellects, selected }, thresholds, checks));

    if (!agentIds && on('orphans')) {
      await guarded('orphans', async () => {
        const [rules, settings] = await Promise.all([lifecycle.list(ks, { pageSize }).all(), insightSettings.list(ks, { pageSize }).all()]);
        const used = new Set(rules.flatMap((r) => (Array.isArray(r.action?.insightSettingsIds) ? r.action.insightSettingsIds : [])));
        for (const s of settings) {
          if (!used.has(s.id)) {
            findings.push({ severity: 'info', code: 'orphan_insight_setting', message: `No rule uses insight setting ${s.id} (${s.key}).`, fix: 'Delete it, or add it to a triggerInsightSettingsKai rule.' });
          }
        }
        if (skipped.includes('templates')) return;
        try {
          const templates = await emailTemplates.list(ks, { pageSize }).all();
          const pinned = new Set(rules.map((r) => r.action?.templateId).filter(Boolean));
          for (const t of templates.filter((x) => x.status !== 'deleted' && !pinned.has(x.id))) {
            findings.push({ severity: 'info', code: 'orphan_email_template', message: `No rule uses email template ${t.id}${t.name ? ` (${t.name})` : ''}.`, fix: 'Delete it, or pin it as templateId on a sendInsightEmail rule.' });
          }
          checked.emailTemplates = Math.max(checked.emailTemplates ?? 0, templates.length);
        } catch (e) {
          if (/** @type {any} */ (e)?.code !== 'region_unavailable') throw e;
          skipped.push('templates');
        }
      });
    }

    findings.push(...failures.map(readFailed));
    skipped.push(...failures.map((f) => f.area));
    const visible = redact(findings).filter((f) => !ignore.some((rule) => ignores(rule, f))).sort(byImportance);
    const report = auditReport(visible, checked, [...new Set(skipped)]);
    if (ignore.length > 0) report.summary.suppressed = findings.length - visible.length;
    return report;
  }
}
