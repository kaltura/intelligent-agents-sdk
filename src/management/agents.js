/**
 * Agents — the deployable unit binding an intellect (brain) to avatars
 * (face+voice). Lives on the Agentic host; needs an admin token
 * (`disableentitlement`). Reference: docs/api/management-operations.md.
 */
import { paginate } from './paginate.js';
import { uuidv4 } from '../core/ids.js';
import { KalturaError } from '../core/errors.js';

/**
 * Speech recognition settings on an agent.
 * @typedef {object} AgentAsr
 * @property {string} language  A language code, for example 'en'.
 * @property {'kaltura'|'kaltura-hebrew'|'elevenlabs'|'soniox'} provider
 */

/**
 * Admin-tag patterns that mark a PRODUCTION / keep resource. `agents.delete`
 * refuses to delete an agent carrying any of these unless `allowProtected:true`
 * is passed — the guardrail against an automated cleanup-by-tag sweep nuking a
 * real, in-use agent. Matches case-insensitively: `prod` as a whole tag word
 * (delimited by `-` or `_`, so `prod` and `prod-eu` match), `production`,
 * `keep`, `do-not-delete` and `live`. Frozen: `agents.delete` always
 * matches against this exact list, so there is no way to add your own
 * patterns to it. Write your own tag check before calling `delete` if you
 * need extra protected markers.
 * @type {readonly (string|RegExp)[]}
 */
export const PROTECTED_TAGS = Object.freeze([
  /(^|[-_])prod($|[-_])/i, /production/i, /\bkeep\b/i, /do-?not-?delete/i,
  /\blive\b/i,
]);

/** @param {string[]|undefined} tags @returns {string|null} the matched protected tag, or null */
export function matchProtectedTag(tags) {
  if (!Array.isArray(tags)) return null;
  for (const t of tags) {
    const s = String(t);
    for (const p of PROTECTED_TAGS) {
      if (p instanceof RegExp ? p.test(s) : s.toLowerCase().includes(String(p).toLowerCase())) return s;
    }
  }
  return null;
}

/**
 * Developer-facing `screenShare` → the field name the server uses. The server
 * name can change, so the SDK keeps the two apart: apps use `screenShare`.
 * Bodies without `screenShare` pass through untouched. Throws `bad_request` on a
 * malformed value, or when the body also carries the server name.
 * @param {any} body @param {string} where
 */
function screenShareToWire(body, where) {
  if (!body || typeof body !== 'object' || body.screenShare === undefined) return body;
  const { screenShare, ...rest } = body;
  const bad = (detail) => new KalturaError({ type: 'about:blank', title: 'bad screenShare', code: 'bad_request', detail: `${where}: ${detail}` });
  if (rest.legacyScreenShare !== undefined) throw bad('pass `screenShare` only; do not also pass `legacyScreenShare`.');
  if (!screenShare || typeof screenShare !== 'object' || Array.isArray(screenShare)) throw bad('`screenShare` must be an object like { enabled: true, prompt: "..." }.');
  if (screenShare.enabled !== undefined && typeof screenShare.enabled !== 'boolean') throw bad('`screenShare.enabled` must be a boolean.');
  if (screenShare.prompt !== undefined && typeof screenShare.prompt !== 'string') throw bad('`screenShare.prompt` must be a string.');
  return { ...rest, legacyScreenShare: screenShare };
}

/** An agent read back from the server, with its screen share setting under `screenShare`. @param {any} agent */
function screenShareFromWire(agent) {
  if (!agent || typeof agent !== 'object' || agent.legacyScreenShare === undefined) return agent;
  const { legacyScreenShare, ...rest } = agent;
  return { ...rest, screenShare: legacyScreenShare };
}

export class Agents {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * List agents. READ. Async-iterable + awaitable (first page).
   * `filter` is sent as-is (default `{}`). `orderBy` is sent top-level next to
   * `filter`. Keys, values and sort behavior:
   * docs/api/management-operations.md#agents.
   *
   * @example <caption>Newest agents first, filtered by an admin tag</caption>
   * const newest = await k.agents.list(adminKs, { filter: { adminTagsIn: ['lobby'] }, orderBy: '-createdAt' }).all();
   *
   * @param {string} ks
   * @param {{filter?:object, orderBy?:'+createdAt'|'-createdAt'|'+updatedAt'|'-updatedAt', pageSize?:number}} [opts]
   */
  list(ks, opts = {}) {
    this._.assertAdmin(ks, 'agents.list');
    return paginate({
      style: 'offset', pageSize: opts.pageSize,
      fetchPage: (pager) => this._.agentic('agent/list', { filter: opts.filter || {}, ...(opts.orderBy ? { orderBy: opts.orderBy } : {}), pager }, ks).then((r) => {
        const page = r.data;
        return Array.isArray(page?.objects) ? { ...page, objects: page.objects.map(screenShareFromWire) } : page;
      }),
    });
  }

  /** Get one agent. READ. @param {string} agentId @param {string} ks */
  async get(agentId, ks) {
    this._.assertAdmin(ks, 'agents.get');
    return screenShareFromWire((await this._.agentic('agent/get', { agentId }, ks)).data);
  }

  /**
   * Create an agent. WRITE, NOT idempotent. Sends an `Idempotency-Key` header
   * (`opts.idempotencyKey`, else a random one). A create is not retried after a
   * 429 or 5xx. `intellect.id` is the intellect's
   * configId — no separate genieId is needed (the request body's `intellect`
   * only takes `intellectType`+`id`).
   * `maxConversationLength` is seconds, 1 to 3600; out of range is a 400.
   * `widgetConfig` is `{tips?, initialPage?:{title?, subtitle?, backgroundImageUrl?, initialQuestions?:[{text, answerType?:'markdown'|'flashcards'}]}, layouts?:{avatar?, chat?}, tapToTalk?}`
   * and `embedConfig` is `{theme?}`. Field rules: docs/api/build/avatar-and-agent.md.
   * @param {object} body {displayName,intellect:{intellectType:'genie',id},avatarIds?,adminTags?,maxConversationLength?,widgetConfig?,embedConfig?,screenShare?:{enabled?:boolean,prompt?:string},asr?:AgentAsr}
   * @param {string} ks
   * @param {{idempotencyKey?:string}} [opts]
   */
  async create(body, ks, opts = {}) {
    this._.assertAdmin(ks, 'agents.create');
    const wire = screenShareToWire(body, 'agents.create');
    return screenShareFromWire((await this._.agentic('agent/create', wire, ks, { idempotencyKey: opts.idempotencyKey || uuidv4() })).data);
  }

  /**
   * Update an agent. WRITE — idempotent for a given body. `screenShare` is
   * `{enabled?, prompt?}`, the same as on {@link Agents#create}.
   * `asr` is `{language, provider}` (see {@link AgentAsr}), sent as-is.
   * Sending `widgetConfig` or `embedConfig` replaces that whole object; omit it to keep it, `null` clears it.
   * @param {object} body {agentId,...} @param {string} ks
   */
  async update(body, ks) {
    this._.assertAdmin(ks, 'agents.update');
    const wire = screenShareToWire(body, 'agents.update');
    return screenShareFromWire((await this._.agentic('agent/update', wire, ks)).data);
  }

  /**
   * Delete an agent. WRITE — DESTRUCTIVE. Requires `{confirmPermanent:true}` so
   * a deletion can't happen by accident. Does NOT cascade — the avatar and
   * intellect are independent resources and survive.
   *
   * PRODUCTION GUARD: if the agent carries a PROTECTED admin tag
   * ({@link PROTECTED_TAGS} — anything matching `prod`/`keep`/`do-not-delete`/
   * `live`), the delete is REFUSED unless you ALSO pass `{ allowProtected: true }`.
   * This is the guardrail against a blind cleanup-by-tag sweep nuking a real,
   * in-use agent. The check reads the agent with `agent/get`. If that lookup
   * fails, the delete is refused with that error, so a guard that cannot run never lets
   * a delete through. A missing agent (`not_found` / `agent_not_found`) is the one exception: there is nothing
   * to protect, and the delete reports its own result. `confirm.skipProtectedCheck:true` skips the
   * guard and the lookup entirely.
   * {@link PROTECTED_TAGS} is frozen and not caller-extendable. Run your own
   * tag check first if you need extra protected markers.
   * @param {string} agentId @param {string} ks
   * @param {{confirmPermanent:boolean, allowProtected?:boolean, skipProtectedCheck?:boolean}} confirm
   */
  async delete(agentId, ks, confirm) {
    this._.assertAdmin(ks, 'agents.delete');
    requireConfirm(confirm, 'agents.delete', agentId);
    if (!confirm.allowProtected && !confirm.skipProtectedCheck) {
      // Look up the agent's tags; refuse if any is protected (production marker).
      const agent = await this.get(agentId, ks).catch((e) => { if (e?.status === 404 || e?.code === 'not_found' || e?.code === 'agent_not_found') return null; throw e; });
      const hit = agent && matchProtectedTag(agent.adminTags);
      if (hit) {
        throw new KalturaError({
          type: 'https://docs.kaltura.com/agentic/errors/protected_resource',
          title: 'protected resource', code: 'protected_resource',
          detail: `agents.delete refused: agent ${agentId} carries the protected tag "${hit}" (a production marker). This guard stops a cleanup-by-tag sweep from deleting a real agent. Pass { confirmPermanent:true, allowProtected:true } if you truly mean to delete it.`,
        });
      }
    }
    return (await this._.agentic('agent/delete', { agentId }, ks)).data;
  }

}

/**
 * Guard for an agent's `intellect.id`. Returns the id only if `intellect` is
 * an object and `id` is a number; `undefined` otherwise.
 * @param {{id?:number, [k:string]:unknown}} intellect
 * @returns {number|undefined}
 */
export function resolveIntellectId(intellect) {
  if (!intellect || typeof intellect !== 'object') return undefined;
  const v = intellect.id;
  return typeof v === 'number' ? v : undefined;
}

/** @param {{confirmPermanent?:boolean}|undefined} confirm @param {string} where @param {string} id */
export function requireConfirm(confirm, where, id) {
  if (!confirm || confirm.confirmPermanent !== true) {
    throw new KalturaError({
      type: 'https://docs.kaltura.com/agentic/errors/confirmation_required',
      title: 'confirmation required', code: 'confirmation_required',
      detail: `${where} is destructive and permanently changes your account. Pass { confirmPermanent: true } to delete ${id}.`,
    });
  }
}
