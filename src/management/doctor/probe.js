/**
 * Timing probe: sends one text message to an agent and measures the turn. It is the
 * only doctor part that talks to the agent, so it is a separate, opt-in call.
 * The text path uses no speech recognition, no voice and no avatar. It measures the
 * brain (model, prompt, tools), not speech problems.
 */
import { KalturaError } from '../../core/errors.js';
import { collectConverse, parseToolCall } from '../../core/stream.js';
import { sanitizeJson } from '../../core/safety.js';
import { resolveIntellectId } from '../agents.js';
import { scopedAgentIds } from '../lifecycle-rules.js';
import { isTokenError } from './gather.js';

const PROBE_USER_ID = 'sdk-doctor-probe';
const DEFAULT_MESSAGE = 'Hello, what can you help me with?';
const DEFAULT_TIMEOUT_MS = 60000;
/** The largest delay `setTimeout` accepts. */
const MAX_TIMEOUT_MS = 2147483647;
const MAX_MESSAGE_CHARS = 500;
/** The symbols `spoken` reports, and the only values `allowSymbols` accepts. */
const SPOKEN_SYMBOLS = ['%', '$', '&', '€', '£', '#'];

/** What the probe cannot show. Added to every result. */
export const PROBE_LIMITS = 'The probe sends text. It uses no speech recognition, no voice and no avatar, so it cannot show speech problems.';

/**
 * @typedef {object} DoctorProbeOptions
 * @property {string} agentId  The agent to probe.
 * @property {string} [message]  What to send. Default: a short greeting. Up to 500 characters.
 * @property {boolean} [allowSideEffects]  Run even when active lifecycle rules match the agent. Default false.
 * @property {number} [timeoutMs]  Stop waiting for the reply after this long. Default 60000.
 * @property {{rawTerms?: string[], allowSymbols?: string[]}} [spoken]  Check the reply text for what a voice reads badly. `rawTerms` are written forms that must not appear, such as `EBITDA` when the prompt asks for "ebitda". Matching is case-sensitive and on whole words. `allowSymbols` lists symbols from `% $ & € £ #` that the voice reads well, so they are left out of `symbols`.
 * @property {Record<string, ClientToolAnswer>} [clientTools]  Answers for client tools that wait for a reply, keyed by tool name. A client tool the agent calls with `wait_for_response` holds the turn until the server's tool timeout (30 s by default) unless a host answers it. The probe has no host, so list each such tool here and the probe answers it at once.
 * @property {boolean} [includeText]  Add the reply text as `reply.text`. Default false.
 */

/**
 * What the probe sends back for a waiting client tool: a JSON object, or a function that returns one (sync or async). Make it as realistic as the real host's answer, because the agent writes its reply from it.
 * @typedef {Record<string, unknown> | ((args: any, call: import('../../core/stream.js').ToolCall) => Record<string, unknown> | Promise<Record<string, unknown>>)} ClientToolAnswer
 */

/**
 * @typedef {object} ToolAck
 * @property {string} name  The client tool.
 * @property {boolean} ok  True when the server accepted the answer.
 * @property {'handler_error'|'bad_response'|'http_error'} [reason]  Why `ok` is false.
 * @property {number} [status]  The HTTP status, with `http_error`. Absent when no response came back.
 */

/**
 * What the reply holds that a voice reads badly.
 * @typedef {object} SpokenCheck
 * @property {string[]} rawTerms  The `rawTerms` that appear in the reply.
 * @property {number} digits  Number of digit runs in the reply.
 * @property {string[]} digitRuns  The digit runs, in order. `digits` is their count.
 * @property {string[]} symbols  Distinct symbols from `% $ & € £ #` in the reply, without the `allowSymbols`.
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
 * @property {{toolCalls: number, spiralStopped: boolean, replyChars: number, errorSegments: number, toolAcks: ToolAck[], unansweredTools: string[], text?: string, spoken?: SpokenCheck}|null} reply  Null when the probe did not run or the request failed. `toolAcks` has one entry per answer the probe sent. `unansweredTools` names the client tools that waited for a reply the probe did not give: no answer given, or the answer failed. Each held the turn up to the server's tool timeout. `text` is set only with `includeText`, `spoken` only when the call passed `spoken`.
 * @property {{code: string, message: string, unansweredTools: string[]}|null} error  The request failure, if any. On `probe_timeout` the message names the client tools that were waiting.
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
    const { agentId, message = DEFAULT_MESSAGE, allowSideEffects = false, timeoutMs = DEFAULT_TIMEOUT_MS, spoken, clientTools, includeText = false } = opts ?? {};
    if (typeof agentId !== 'string' || !agentId.trim()) throw badRequest('doctorProbe needs opts.agentId.');
    if (typeof message !== 'string' || !message.trim() || message.length > MAX_MESSAGE_CHARS) throw badRequest(`doctorProbe message must be 1 to ${MAX_MESSAGE_CHARS} characters.`);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw badRequest(`doctorProbe timeoutMs must be a number from 1 to ${MAX_TIMEOUT_MS}.`);

    checkSpoken(spoken);
    checkClientTools(clientTools);
    if (typeof includeText !== 'boolean') throw badRequest('doctorProbe includeText must be true or false.');

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
    /** @type {ToolAck[]} */ const toolAcks = [];
    /** @type {Set<string>} */ const unanswered = new Set();
    /** @type {Promise<void>[]} */ const acks = [];
    const timed = async function* (/** @type {AsyncIterable<any>} */ source, /** @type {() => number} */ now, /** @type {(call: any, handler: ClientToolAnswer) => Promise<ToolAck>} */ answer) {
      for await (const seg of source) {
        const at = now() - t0;
        firstSegmentMs ??= at;
        if (firstTextMs === null && seg?.type === 'text' && seg.content) firstTextMs = at;
        const call = parseToolCall(seg);
        if (call?.toolMetadata?.waitForResponse) {
          const handler = clientTools && Object.hasOwn(clientTools, call.name) ? clientTools[call.name] : undefined;
          if (handler === undefined) unanswered.add(call.name);
          else acks.push(answer(call, handler).then((ack) => { toolAcks.push(ack); if (!ack.ok) unanswered.add(ack.name); }));
        }
        yield seg;
      }
    };
    try {
      const stream = this._d.conversations.stream({ userMessage: message, add_message_in_db: false, signal: ctl.signal }, token);
      const r = await collectConverse(timed(stream, this._now, (call, handler) => this._answer(token, call, handler)));
      await Promise.all(acks);
      return {
        ...base, ran: true, error: null,
        timings: { firstSegmentMs, firstTextMs, totalMs: this._now() - t0 },
        reply: {
          toolCalls: r.segments.filter((x) => x.type === 'tool').length, spiralStopped: r.spiralStopped, replyChars: r.text.length, errorSegments: r.kindCounts.error,
          toolAcks, unansweredTools: [...unanswered],
          ...(includeText ? { text: r.text } : {}),
          ...(spoken ? { spoken: spokenCheck(r.text, spoken) } : {}),
        },
      };
    } catch (e) {
      if (isTokenError(e)) throw e;
      const err = /** @type {any} */ (e);
      const code = ctl.signal.aborted ? 'probe_timeout' : String(err?.code ?? err?.status ?? 'error');
      const waiting = [...unanswered];
      const hint = waiting.length ? ` The agent was waiting for a reply to client tool ${waiting.map((n) => `"${n}"`).join(', ')}. Pass clientTools: { ${waiting[0]}: { ... } } to answer it.` : '';
      const msg = ctl.signal.aborted ? `No reply within ${timeoutMs} ms.${hint}` : String(err?.detail ?? err?.message ?? err);
      return { ...base, ran: true, timings: { firstSegmentMs, firstTextMs, totalMs: this._now() - t0 }, reply: null, error: { code, message: msg, unansweredTools: waiting } };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Answer one waiting client tool. Never throws: a failed answer is returned as `ok: false`.
   * @param {any} token  The probe's conversation token.
   * @param {import('../../core/stream.js').ToolCall} call  A call with `toolMetadata`.
   * @param {ClientToolAnswer} handler
   * @returns {Promise<ToolAck>}
   */
  async _answer(token, call, handler) {
    const name = call.name;
    let response;
    try { response = typeof handler === 'function' ? await handler(call.args, call) : handler; } catch { return { name, ok: false, reason: 'handler_error' }; }
    if (!response || typeof response !== 'object' || Array.isArray(response)) return { name, ok: false, reason: 'bad_response' };
    const id = /** @type {string} */ (call.toolMetadata?.id);
    try {
      await this._.genie('assistant/tool_response', { tool_name: name, tool_id: id, tool_invocation_id: id, response: sanitizeJson(response) }, token);
      return { name, ok: true };
    } catch (e) {
      const status = /** @type {any} */ (e)?.status;
      return { name, ok: false, reason: 'http_error', ...(status > 0 ? { status } : {}) };
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

/** @param {string} text @param {{rawTerms?: string[], allowSymbols?: string[]}} spoken @returns {SpokenCheck} */
function spokenCheck(text, { rawTerms = [], allowSymbols = [] }) {
  const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const digitRuns = text.match(/\d+/g) ?? [];
  return {
    rawTerms: rawTerms.filter((t) => new RegExp(`(?<![A-Za-z0-9])${esc(t)}(?![A-Za-z0-9])`).test(text)),
    digits: digitRuns.length,
    digitRuns,
    symbols: [...new Set(text.match(/[%$&€£#]/g) ?? [])].filter((c) => !allowSymbols.includes(c)),
  };
}

/** @param {unknown} spoken */
function checkSpoken(spoken) {
  if (spoken === undefined) return;
  const s = /** @type {any} */ (spoken);
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw badRequest('doctorProbe spoken must be an object.');
  if (s.rawTerms !== undefined && (!Array.isArray(s.rawTerms) || s.rawTerms.some((t) => typeof t !== 'string' || !t))) throw badRequest('doctorProbe spoken.rawTerms must be an array of non-empty strings.');
  if (s.allowSymbols !== undefined && (!Array.isArray(s.allowSymbols) || s.allowSymbols.some((c) => !SPOKEN_SYMBOLS.includes(c)))) throw badRequest(`doctorProbe spoken.allowSymbols must be an array of: ${SPOKEN_SYMBOLS.join(' ')}`);
}

/** @param {unknown} clientTools */
function checkClientTools(clientTools) {
  if (clientTools === undefined) return;
  const t = /** @type {any} */ (clientTools);
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw badRequest('doctorProbe clientTools must be an object keyed by tool name.');
  for (const [name, handler] of Object.entries(t)) {
    if (typeof handler === 'function') continue;
    if (!handler || typeof handler !== 'object' || Array.isArray(handler)) throw badRequest(`doctorProbe clientTools.${name} must be a JSON object or a function that returns one.`);
  }
}

/** @param {string} detail @returns {KalturaError} */
function badRequest(detail) {
  return new KalturaError({ type: 'about:blank', title: 'invalid doctorProbe call', code: 'bad_request', detail });
}
