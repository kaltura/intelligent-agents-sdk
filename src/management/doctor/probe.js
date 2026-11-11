/**
 * Timing probe: sends one text message to an agent and measures the turn. It is the
 * only doctor part that talks to the agent, so it is a separate, opt-in call.
 * The text path uses no speech recognition, no voice and no avatar. It measures the
 * brain (model, prompt, tools), not speech problems.
 */
import { KalturaError } from '../../core/errors.js';
import { collectConverse } from '../../core/stream.js';
import { resolveIntellectId } from '../agents.js';
import { scopedAgentIds } from '../lifecycle-rules.js';
import { isTokenError } from './gather.js';

const PROBE_USER_ID = 'sdk-doctor-probe';
const DEFAULT_MESSAGE = 'Hello, what can you help me with?';
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_MESSAGE_CHARS = 500;

/** What the probe cannot show. Added to every result. */
export const PROBE_LIMITS = 'The probe sends text. It uses no speech recognition, no voice and no avatar, so it cannot show speech problems.';

/**
 * @typedef {object} DoctorProbeOptions
 * @property {string} agentId  The agent to probe.
 * @property {string} [message]  What to send. Default: a short greeting. Up to 500 characters.
 * @property {boolean} [allowSideEffects]  Run even when active lifecycle rules match the agent. Default false.
 * @property {number} [timeoutMs]  Stop waiting for the reply after this long. Default 60000.
 */

/**
 * @typedef {object} DoctorProbeRule
 * @property {string} id
 * @property {string} [systemName]
 * @property {string} [eventType]
 * @property {string} [actionType]
 */

/**
 * @typedef {object} DoctorProbeResult
 * @property {string} agentId
 * @property {boolean} ran  False when the probe sent nothing because lifecycle rules match the agent.
 * @property {DoctorProbeRule[]} rules  Active thread rules that run for this agent, or for every agent. Listed whether or not the probe ran.
 * @property {number|null} configId  The agent's intellect id.
 * @property {{thinkingLevel: unknown, includeThoughts: unknown, maxOutputTokens: unknown, type: unknown}|null} config  Model settings in effect. Null when the intellect could not be read.
 * @property {{firstSegmentMs: number|null, firstTextMs: number|null, totalMs: number}|null} timings  Null when the probe did not run.
 * @property {{toolCalls: number, spiralStopped: boolean, replyChars: number, errorSegments: number}|null} reply  Null when the probe did not run or the request failed.
 * @property {{code: string, message: string}|null} error  The request failure, if any.
 * @property {string} limits
 */

/** Sends one text turn and measures it. */
export class DoctorProbe {
  /** @param {import('../client.js').Ctx} ctx @param {{agents: import('../agents.js').Agents, lifecycle: import('../lifecycle.js').Lifecycle, intellects: import('../intellects.js').Intellects, conversations: import('../conversations.js').Conversations, sessions: import('../../core/session.js').Sessions, now?: () => number}} deps */
  constructor(ctx, deps) {
    this._ = ctx;
    this._d = deps;
    this._now = deps.now ?? (() => Date.now());
  }

  /**
   * Probe one agent. WRITE: it mints a user token and sends one message with
   * `add_message_in_db: false`, so the message is not stored. Lifecycle rules may still
   * react to the session, so the probe lists the rules that match the agent first and
   * does not run when there are any, unless `allowSideEffects` is true. An expired or
   * non-admin token rejects the call. A failed request is returned in `error`.
   * @param {string} ks  Admin token.
   * @param {DoctorProbeOptions} opts
   * @returns {Promise<DoctorProbeResult>}
   */
  async run(ks, opts) {
    this._.assertAdmin(ks, 'doctorProbe');
    const { agentId, message = DEFAULT_MESSAGE, allowSideEffects = false, timeoutMs = DEFAULT_TIMEOUT_MS } = opts ?? {};
    if (typeof agentId !== 'string' || !agentId.trim()) throw badRequest('doctorProbe needs opts.agentId.');
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_CHARS) throw badRequest(`doctorProbe message must be 1 to ${MAX_MESSAGE_CHARS} characters.`);
    if (!(timeoutMs > 0)) throw badRequest('doctorProbe timeoutMs must be a positive number.');

    const agent = await this._d.agents.get(agentId, ks);
    const configId = resolveIntellectId(agent.intellect) ?? null;
    const rules = (await this._d.lifecycle.list(ks).all())
      .filter((r) => (r.status === undefined || r.status === 'active') && r.objectType === 'thread')
      .filter((r) => { const ids = scopedAgentIds(r.eventConditions); return ids.length === 0 || ids.includes(agentId); })
      .map((r) => ({ id: r.id, systemName: r.systemName, eventType: r.eventType, actionType: r.action?.actionType }));
    const config = await this._config(ks, configId);
    const base = { agentId, rules, configId, config, limits: PROBE_LIMITS };
    if (rules.length > 0 && !allowSideEffects) return { ...base, ran: false, timings: null, reply: null, error: null };
    if (configId === null) throw new KalturaError({ type: 'about:blank', title: 'agent has no intellect', code: 'intellect_not_found', detail: `doctorProbe: agent ${agentId} has no intellect id.` });

    const token = await this._d.sessions.createAgentToken({ agentId, configId, userId: PROBE_USER_ID });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = this._now();
    /** @type {number|null} */ let firstSegmentMs = null;
    /** @type {number|null} */ let firstTextMs = null;
    const timed = async function* (/** @type {AsyncIterable<any>} */ source, /** @type {() => number} */ now) {
      for await (const seg of source) {
        const at = now() - t0;
        firstSegmentMs ??= at;
        if (firstTextMs === null && seg?.type === 'text' && seg.content) firstTextMs = at;
        yield seg;
      }
    };
    try {
      const stream = this._d.conversations.stream({ userMessage: message, add_message_in_db: false, signal: ctl.signal }, token);
      const r = await collectConverse(timed(stream, this._now));
      return {
        ...base, ran: true, error: null,
        timings: { firstSegmentMs, firstTextMs, totalMs: this._now() - t0 },
        reply: { toolCalls: r.segments.filter((x) => x.type === 'tool').length, spiralStopped: r.spiralStopped, replyChars: r.text.length, errorSegments: r.kindCounts.error },
      };
    } catch (e) {
      if (isTokenError(e)) throw e;
      const err = /** @type {any} */ (e);
      const code = ctl.signal.aborted ? 'probe_timeout' : String(err?.code ?? err?.status ?? 'error');
      const msg = ctl.signal.aborted ? `No reply within ${timeoutMs} ms.` : String(err?.detail ?? err?.message ?? err);
      return { ...base, ran: true, timings: { firstSegmentMs, firstTextMs, totalMs: this._now() - t0 }, reply: null, error: { code, message: msg } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** @param {string} ks @param {number|null} configId @returns {Promise<DoctorProbeResult['config']>} */
  async _config(ks, configId) {
    if (configId === null) return null;
    try {
      const c = await this._d.intellects.get(configId, ks);
      const m = c?.model_configuration ?? {};
      return { type: c?.type, thinkingLevel: m.thinking_level, includeThoughts: m.include_thoughts, maxOutputTokens: m.max_output_tokens };
    } catch (e) {
      if (isTokenError(e)) throw e;
      return null;
    }
  }
}

/** @param {string} detail @returns {KalturaError} */
function badRequest(detail) {
  return new KalturaError({ type: 'about:blank', title: 'invalid doctorProbe call', code: 'bad_request', detail });
}
