/**
 * Guided fixes for doctor findings. The only writer in the doctor. It is a separate
 * call, so `doctor()` stays read-only.
 *
 * One fix exists: set an agent's `asr.language` to the language its intellect forces
 * replies in (`asr_language_mismatch` at `error`). Other findings have no safe fix,
 * because the right value cannot be known from the config alone.
 */
import { KalturaError } from '../../core/errors.js';
import { normalizeLanguage, sameLanguage } from './language.js';

/**
 * @typedef {object} DoctorFixOptions
 * @property {boolean} [apply]  Write the changes. Default false: a dry run that reads and plans only.
 * @property {string[]} [codes]  Finding codes to fix. Required with `apply`. A dry run without it plans every fixable finding.
 */

/**
 * @typedef {object} DoctorFixResult
 * @property {string} code  The finding code.
 * @property {string} agentId
 * @property {'planned'|'applied'|'already_applied'|'refused'|'failed'} status
 * @property {{language: string|undefined, provider: string|undefined}} before  The agent's ASR as read right now.
 * @property {{language: string, provider: string}} after  The ASR the fix sets. The provider stays as it is.
 * @property {{agentId: string, asr: {language: string, provider: string}}} [undo]  A body for `agents.update` that restores the old setting. Set when `before` was readable.
 * @property {string} [reason]  Why a fix was refused or failed.
 */

/**
 * @typedef {object} DoctorFixReport
 * @property {boolean} applied  True when the run wrote changes.
 * @property {DoctorFixResult[]} results
 */

const FIXABLE = new Set(['asr_language_mismatch']);

/** @param {string} detail @returns {KalturaError} */
const badRequest = (detail) => new KalturaError({ type: 'about:blank', title: 'invalid doctorFix call', code: 'bad_request', detail });

/** The fix on a finding, if it is one this module can apply. Anything else on the object is ignored. @param {any} f */
function fixOf(f) {
  const a = f?.autofix;
  if (!FIXABLE.has(f?.code) || a?.action !== 'set_asr_language') return null;
  if (typeof a.agentId !== 'string' || !a.agentId || typeof a.from !== 'string' || typeof a.to !== 'string' || normalizeLanguage(a.to) !== a.to) return null;
  return { code: f.code, agentId: a.agentId, from: a.from, to: a.to };
}

/** Applies the fixes in a doctor report. */
export class DoctorFix {
  /** @param {import('../client.js').Ctx} ctx @param {{agents: import('../agents.js').Agents}} deps */
  constructor(ctx, deps) { this._ = ctx; this._agents = deps.agents; }

  /**
   * Plan or apply the fixes in a doctor report. A dry run (the default) reads each
   * agent and plans. With `apply: true` it writes, one agent at a time. Before each
   * write it reads the agent again and refuses when `asr.language` is no longer the
   * value the report saw, so a stale report cannot overwrite a later change. The ASR
   * provider is kept. Every result carries an `undo` body for `agents.update`.
   * WRITE only with `apply: true`.
   * @param {string} ks  Admin token. An expired or non-admin token rejects the call.
   * @param {import('../audit-report.js').AuditReport} report  A report from `mgmt.doctor`.
   * @param {DoctorFixOptions} [opts]
   * @returns {Promise<DoctorFixReport>}
   * @throws {KalturaError} `bad_request` for a malformed report, or `apply` without `codes`.
   */
  async run(ks, report, opts = {}) {
    this._.assertAdmin(ks, 'doctorFix');
    if (!report || !Array.isArray(report.findings)) throw badRequest('doctorFix: the report must be the result of mgmt.doctor, with a findings array.');
    const { apply = false, codes } = opts;
    if (codes !== undefined && (!Array.isArray(codes) || codes.some((c) => typeof c !== 'string'))) throw badRequest('doctorFix: codes must be an array of finding codes.');
    if (apply && (!codes || codes.length === 0)) throw badRequest('doctorFix: apply needs the codes to fix, for example { apply: true, codes: ["asr_language_mismatch"] }.');
    const wanted = report.findings.map(fixOf).filter((f) => f && (!codes || codes.includes(f.code)));
    const seen = new Set();
    const fixes = wanted.filter((f) => { const k = `${f?.agentId}`; if (seen.has(k)) return false; seen.add(k); return true; });
    /** @type {DoctorFixResult[]} */
    const results = [];
    for (const fix of fixes) results.push(await this._one(ks, /** @type {NonNullable<ReturnType<typeof fixOf>>} */ (fix), apply));
    return { applied: apply && results.some((r) => r.status === 'applied'), results };
  }

  /** @param {string} ks @param {{code:string, agentId:string, from:string, to:string}} fix @param {boolean} apply @returns {Promise<DoctorFixResult>} */
  async _one(ks, fix, apply) {
    let agent;
    try {
      agent = await this._agents.get(fix.agentId, ks);
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (err?.status === 401 || err?.code === 'wrong_token_scope') throw e;
      const gone = err?.status === 404 || /not_found$/.test(String(err?.code));
      return { code: fix.code, agentId: fix.agentId, status: gone ? 'refused' : 'failed', before: { language: undefined, provider: undefined }, after: { language: fix.to, provider: 'kaltura' }, reason: gone ? 'The agent no longer exists.' : `The agent could not be read (${err?.status ?? err?.code ?? 'error'}).` };
    }
    const before = { language: agent?.asr?.language, provider: agent?.asr?.provider };
    const provider = before.provider ?? 'kaltura';
    const base = { code: fix.code, agentId: fix.agentId, before, after: { language: fix.to, provider } };
    const undo = typeof before.language === 'string' ? { agentId: fix.agentId, asr: { language: before.language, provider } } : undefined;
    if (sameLanguage(before.language, fix.to) === true) return { ...base, status: 'already_applied' };
    if (before.language !== fix.from) return { ...base, status: 'refused', reason: `asr.language is "${before.language}" now, but the report saw "${fix.from}". Run the doctor again.` };
    if (!apply) return { ...base, status: 'planned', ...(undo ? { undo } : {}) };
    try {
      await this._agents.update({ agentId: fix.agentId, asr: { language: fix.to, provider } }, ks);
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (err?.status === 401 || err?.code === 'wrong_token_scope') throw e;
      return { ...base, status: 'failed', reason: `The update failed (${err?.status ?? err?.code ?? 'error'}).`, ...(undo ? { undo } : {}) };
    }
    return { ...base, status: 'applied', ...(undo ? { undo } : {}) };
  }
}
