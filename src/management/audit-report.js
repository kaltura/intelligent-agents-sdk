/**
 * Shared shapes for the audit tools: `lifecycle.audit`, `intellectConfig.audit`
 * and `doctor`. Every audit is read-only and returns the same report.
 */

/**
 * One problem an audit found.
 * @typedef {object} AuditFinding
 * @property {'error'|'warn'|'info'} severity `error` is broken or will silently do nothing. `warn` is probably wrong. `info` is worth a look.
 * @property {string} code Stable machine-readable id, for example `unscoped_rule`.
 * @property {string} [ruleId] The lifecycle rule the finding is about.
 * @property {string} [systemName] That rule's `systemName`.
 * @property {string} [agentId] The agent the finding is about.
 * @property {number} [configId] The intellect the finding is about.
 * @property {string} [field] The intellect field the finding is about, for example `tool_ids`.
 * @property {string} message What is wrong, in plain words.
 * @property {string} fix What to do about it.
 */

/**
 * What an audit method resolves to.
 * @typedef {object} AuditReport
 * @property {AuditFinding[]} findings
 * @property {{error:number, warn:number, info:number}} summary Finding counts by severity.
 * @property {Record<string, number>} checked How many of each thing the audit read, for example `{rules: 4, insightSettings: 2}`.
 * @property {string[]} skipped Checks the audit could not run, for example `['templates']`.
 */

/**
 * True for an error that means "that resource does not exist": HTTP 404, a
 * code ending in `not_found`, or a title ending in `_NOT_FOUND` (a read of a
 * missing rule, insight setting or template fails with
 * `code:'api_exception'` and a title such as `LIFECYCLE_RULE_NOT_FOUND`). PURE.
 * @param {any} err
 * @returns {boolean}
 */
export function isNotFound(err) {
  return err?.status === 404 || /not_found$/.test(err?.code ?? '') || /_NOT_FOUND$/.test(err?.title ?? '');
}

/**
 * Count findings by severity. PURE.
 * @param {AuditFinding[]} findings
 * @returns {{error:number, warn:number, info:number}}
 */
export function summarizeFindings(findings) {
  const summary = { error: 0, warn: 0, info: 0 };
  for (const f of findings) summary[f.severity] += 1;
  return summary;
}

/**
 * Build an {@link AuditReport}. PURE.
 * @param {AuditFinding[]} findings
 * @param {Record<string, number>} checked
 * @param {string[]} [skipped]
 * @returns {AuditReport}
 */
export function auditReport(findings, checked, skipped = []) {
  return { findings, summary: summarizeFindings(findings), checked, skipped };
}
