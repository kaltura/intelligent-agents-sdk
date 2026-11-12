/**
 * The doctor's check registry and the runner that applies it. Add a check by
 * writing it in a module next to this file and listing it in `CHECKS`.
 */
import {
  asrLanguage, avatarCapability, avatarReferences, avatarShared, intellectReference, maxConversation,
  openingPhraseDuplicate, openingPhraseLanguage, voiceLanguageDefault, voiceReplyLanguage,
} from './agent.js';

/** @typedef {import('../model.js').DoctorCheck} DoctorCheck */
/** @typedef {import('../model.js').AgentView} AgentView */
/** @typedef {import('../model.js').IntellectView} IntellectView */
/** @typedef {import('../model.js').DoctorThresholds} DoctorThresholds */
/** @typedef {import('../../audit-report.js').AuditFinding} AuditFinding */

/**
 * Every check, in the order they run. Output is sorted afterwards, so the
 * order only matters for the cost of the reads.
 * @type {readonly DoctorCheck[]}
 */
export const CHECKS = Object.freeze([
  intellectReference, avatarReferences, asrLanguage, voiceLanguageDefault, voiceReplyLanguage,
  openingPhraseDuplicate, openingPhraseLanguage, maxConversation, avatarCapability, avatarShared,
]);

/**
 * Codes the doctor emits itself, outside the registry: the lifecycle and
 * intellect audits keep their own, and these three come from the run.
 * @type {readonly string[]}
 */
const RUN_CODES = Object.freeze(['read_failed', 'check_failed', 'orphan_insight_setting', 'orphan_email_template']);

/**
 * Every finding code the doctor itself defines, from the registry and the run.
 * The lifecycle and intellect audits list theirs in their own docs.
 * @type {readonly string[]}
 */
export const DOCTOR_CODES = Object.freeze([...CHECKS.flatMap((c) => c.codes), ...RUN_CODES]);

/**
 * Keep the checks a run asked for. A name matches a check `id` or a `category`.
 * `only` keeps just the matches. `skip` drops them, and wins over `only`. PURE.
 * @param {readonly DoctorCheck[]} checks
 * @param {{only?:string[], skip?:string[]}} [opts]
 * @returns {DoctorCheck[]}
 */
export function selectChecks(checks, opts = {}) {
  const hit = (/** @type {string[]|undefined} */ names, /** @type {DoctorCheck} */ c) => names?.some((n) => n === c.id || n === c.category) ?? false;
  return checks.filter((c) => (!opts.only?.length || hit(opts.only, c)) && !hit(opts.skip, c));
}

/**
 * Run checks over the gathered views. A check that throws becomes one
 * `check_failed` finding, and the rest still run. PURE.
 * @param {{agents:AgentView[], intellects:IntellectView[], selected:Set<string>}} model
 * @param {Required<DoctorThresholds>} thresholds
 * @param {readonly DoctorCheck[]} [checks]
 * @returns {AuditFinding[]}
 */
export function runChecks(model, thresholds, checks = CHECKS) {
  /** @type {AuditFinding[]} */
  const findings = [];
  const inputs = {
    agent: model.agents.filter((a) => model.selected.has(a.agentId)),
    intellect: model.intellects,
    partner: [{ agents: model.agents, selected: model.selected }],
  };
  for (const check of checks) {
    for (const input of inputs[check.scope]) {
      try {
        findings.push(...check.run(input, thresholds));
      } catch (e) {
        const agentId = /** @type {any} */ (input).agentId;
        findings.push({
          severity: 'info', code: 'check_failed', ...(agentId ? { agentId } : {}),
          message: `Check "${check.id}" could not run: ${/** @type {any} */ (e)?.message ?? e}`,
          fix: `Run again with skip: ['${check.id}'] and open an issue with this message.`,
        });
      }
    }
  }
  return findings;
}
