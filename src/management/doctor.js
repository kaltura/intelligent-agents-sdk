/**
 * Doctor: one read-only health check over a partner's agents. Runs the
 * lifecycle audit, then the intellect audit for each agent's intellect, then
 * looks for insight settings and email templates that no rule uses. Reached
 * through `mgmt.doctor(ks, opts)`.
 */
import { resolveIntellectId } from './agents.js';
import { auditReport, isNotFound } from './audit-report.js';

/** @typedef {import('./audit-report.js').AuditFinding} AuditFinding */

export class Doctor {
  /**
   * @param {import('./client.js').Ctx} ctx
   * @param {{lifecycle:import('./lifecycle.js').Lifecycle, intellectConfig:import('./intellect-config.js').IntellectConfig, agents:import('./agents.js').Agents, insightSettings:import('./insight-settings.js').InsightSettings, emailTemplates:import('./email-templates.js').EmailTemplates}} deps
   */
  constructor(ctx, deps) {
    this._ = ctx;
    this._deps = deps;
  }

  /**
   * Check the partner's agents. READ only, it changes nothing. Returns one
   * report that merges:
   * - {@link Lifecycle#audit}: every rule.
   * - {@link IntellectConfig#audit}: the intellect of each agent, once per
   *   intellect. Each finding carries the `agentId` of the first agent that uses it.
   * - Orphans: `orphan_insight_setting` and `orphan_email_template` (both `info`)
   *   for entities no rule uses. Skipped when `agentIds` is set, since an orphan
   *   belongs to no agent.
   *
   * If the Messaging host is not available (`region_unavailable`), the template
   * checks are skipped and the report says `skipped: ['templates']`.
   * @param {string} ks (admin)
   * @param {{agentIds?:string[], pageSize?:number}} [opts] `agentIds` limits the check to those agents, plus the rules that run for them.
   * @returns {Promise<import('./audit-report.js').AuditReport>}
   */
  async run(ks, opts = {}) {
    this._.assertAdmin(ks, 'doctor');
    const { lifecycle, intellectConfig, agents, insightSettings, emailTemplates } = this._deps;
    const { agentIds, pageSize } = opts;
    const lifecycleReport = await lifecycle.audit(ks, { agentIds, pageSize });
    /** @type {AuditFinding[]} */
    const findings = [...lifecycleReport.findings];
    const checked = { ...lifecycleReport.checked };
    const skipped = [...lifecycleReport.skipped];

    const all = await agents.list(ks, { pageSize }).all();
    const mine = agentIds ? all.filter((a) => agentIds.includes(a.agentId ?? a.id)) : all;
    /** @type {Set<number>} */
    const seen = new Set();
    for (const agent of mine) {
      const agentId = agent.agentId ?? agent.id;
      const configId = resolveIntellectId(agent.intellect);
      if (configId === undefined || seen.has(configId)) continue;
      seen.add(configId);
      try {
        const report = await intellectConfig.audit(configId, ks);
        findings.push(...report.findings.map((f) => ({ ...f, agentId })));
      } catch (e) {
        if (!isNotFound(e)) throw e;
        findings.push({ severity: 'error', code: 'intellect_not_found', agentId, configId, message: `Agent ${agentId} points at intellect ${configId}, which does not exist.`, fix: 'Point the agent at an existing intellect.' });
      }
    }
    checked.agentIntellects = seen.size;

    if (!agentIds) {
      const [rules, settings] = await Promise.all([lifecycle.list(ks, { pageSize }).all(), insightSettings.list(ks, { pageSize }).all()]);
      const used = new Set(rules.flatMap((r) => (Array.isArray(r.action?.insightSettingsIds) ? r.action.insightSettingsIds : [])));
      for (const s of settings) {
        if (!used.has(s.id)) {
          findings.push({ severity: 'info', code: 'orphan_insight_setting', message: `No rule uses insight setting ${s.id} (${s.key}).`, fix: 'Delete it, or add it to a triggerInsightSettingsKai rule.' });
        }
      }
      if (!skipped.includes('templates')) {
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
      }
    }
    return auditReport(findings, checked, skipped);
  }
}
