/**
 * Agents — the deployable unit binding an intellect (brain) to avatars
 * (face+voice). Lives on the Agentic host; needs an admin token
 * (`disableentitlement`). Source of truth: tools/agentic.mjs agent-* +
 * API-REFERENCE §2.5 / Management Operations.
 */
import { paginate } from './paginate.js';
import { uuidv4 } from '../core/ids.js';
import { KalturaError } from '../core/errors.js';

/**
 * Admin-tag patterns that mark a PRODUCTION / keep resource. `agents.delete`
 * refuses to delete an agent carrying any of these unless `allowProtected:true`
 * is passed — the guardrail against an automated cleanup-by-tag sweep nuking a
 * real, in-use agent. Matches case-insensitively, as a substring (so `prod`
 * catches `prod`/`production`/`prod-eu`). Extend via the exported set.
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
 * The three embed layouts `agent/getEmbedScript` accepts (closed server enum —
 * anything else 400s: "embedType must be one of the following values:
 * contained, page, floater").
 * @type {readonly ('contained'|'page'|'floater')[]}
 */
export const EMBED_TYPES = Object.freeze(['contained', 'page', 'floater']);

export class Agents {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * List agents. READ. Async-iterable + awaitable (first page).
   *
   * ⚠️ NO SERVER-SIDE FILTERING TODAY: `filter` must be `{}` (the default). Every
   * guessed key returns an opaque `bad_request` — verified for
   * `{objectType:'AgentListFilter'}`, `{displayNameLike}`, and
   * `{adminTagsMultiLikeOr}`. Filter CLIENT-SIDE on the listed objects instead
   * (agents carry `adminTags`, set via {@link create}/{@link update}).
   *
   * @example <caption>List all, then filter by tag client-side</caption>
   * const tagged = await k.agents.list(adminKs).all()
   *   .then((all) => all.filter((a) => a.adminTags?.includes('lobby')));
   *
   * @param {string} ks @param {{filter?:object,pageSize?:number}} [opts]
   */
  list(ks, opts = {}) {
    this._.assertAdmin(ks, 'agents.list');
    return paginate({
      style: 'offset', pageSize: opts.pageSize,
      fetchPage: (pager) => this._.agentic('agent/list', { filter: opts.filter || {}, pager }, ks).then((r) => r.data),
    });
  }

  /** Get one agent. READ. @param {string} agentId @param {string} ks */
  async get(agentId, ks) {
    this._.assertAdmin(ks, 'agents.get');
    return (await this._.agentic('agent/get', { agentId }, ks)).data;
  }

  /**
   * Get the ready-to-paste HTML embed snippet for an agent. READ — no state
   * change. Returns the workspace-embed HTML (`embeds.workspace(...)` +
   * `apis.genieChat.<embedType>(...)`) that renders the agent's chat widget on
   * any page. `embedType` is validated against {@link EMBED_TYPES} BEFORE any
   * network call (the server 400s on anything else — verified live).
   * @param {string} agentId
   * @param {'contained'|'page'|'floater'} embedType `contained` (inline box), `page` (full page), or `floater` (floating launcher).
   * @param {string} ks (admin)
   * @returns {Promise<string>} The HTML embed snippet.
   */
  async getEmbedScript(agentId, embedType, ks) {
    this._.assertAdmin(ks, 'agents.getEmbedScript');
    if (!EMBED_TYPES.includes(embedType)) {
      throw new KalturaError({
        type: 'about:blank', title: 'bad request', code: 'bad_request',
        detail: `agents.getEmbedScript embedType must be one of ${EMBED_TYPES.join(', ')}, got ${JSON.stringify(embedType)}.`,
      });
    }
    // Live wire replies `{objectType:'Object', html:'<script…>'}` — unwrap to the snippet.
    const d = (await this._.agentic('agent/getEmbedScript', { agentId, embedType }, ks)).data;
    return typeof d === 'string' ? d : d?.html;
  }

  /**
   * Create an agent. WRITE — NOT idempotent (auto-sends an Idempotency-Key for
   * hygiene; the server ignores it today). `intellect.id` is the intellect's
   * configId — no separate genieId is needed (verified against the current
   * OpenAPI contract: `CreateAgentIntellectDto` has only `intellectType`+`id`).
   * @param {object} body {displayName,intellect:{intellectType:'genie',id},avatarIds?,adminTags?,maxConversationLength?,widgetConfig?,embedConfig?}
   * @param {string} ks
   * @param {{idempotencyKey?:string}} [opts]
   */
  async create(body, ks, opts = {}) {
    this._.assertAdmin(ks, 'agents.create');
    return (await this._.agentic('agent/create', body, ks, { idempotencyKey: opts.idempotencyKey || uuidv4() })).data;
  }

  /** Update an agent. WRITE — idempotent for a given body. @param {object} body {agentId,...} @param {string} ks */
  async update(body, ks) {
    this._.assertAdmin(ks, 'agents.update');
    return (await this._.agentic('agent/update', body, ks)).data;
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
   * in-use agent. Pass `confirm.skipProtectedCheck:true` only when you already
   * hold the tags and don't want the extra `agent/get` round-trip. Extend
   * {@link PROTECTED_TAGS} with your own project-specific tags as needed.
   * @param {string} agentId @param {string} ks
   * @param {{confirmPermanent:boolean, allowProtected?:boolean, skipProtectedCheck?:boolean}} confirm
   */
  async delete(agentId, ks, confirm) {
    this._.assertAdmin(ks, 'agents.delete');
    requireConfirm(confirm, 'agents.delete', agentId);
    if (!confirm.allowProtected && !confirm.skipProtectedCheck) {
      // Look up the agent's tags; refuse if any is protected (production marker).
      const agent = await this.get(agentId, ks).catch(() => null);
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
 * Resolve the intellect id field, normalizing across the backend's id-field
 * migration (`intellect.id` → `intellect.configId`). Returns the best available
 * numeric id. Both fields are consulted; `configId` is preferred (the stable
 * post-migration name), falling back to `id` for current-state responses.
 * @param {{id?:number, configId?:number, [k:string]:unknown}} intellect
 * @returns {number|undefined}
 */
export function resolveIntellectId(intellect) {
  if (!intellect || typeof intellect !== 'object') return undefined;
  const v = intellect.configId ?? intellect.id;
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
