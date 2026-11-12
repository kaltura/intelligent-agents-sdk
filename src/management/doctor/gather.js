/**
 * The doctor's read phase. Reads each thing once, with at most `concurrency`
 * requests in flight, and builds the views the checks run over. A read that
 * fails becomes a `failures` entry and an `unread` state, so one 403 never
 * loses the report. Only a bad or non-admin token aborts the run.
 */
import { resolveIntellectId } from '../agents.js';
import { isNotFound } from '../audit-report.js';

/** @typedef {import('./model.js').AgentView} AgentView */
/** @typedef {import('./model.js').AvatarView} AvatarView */
/** @typedef {import('./model.js').CatalogRef} CatalogRef */
/** @typedef {import('./model.js').IntellectView} IntellectView */
/** @typedef {import('../audit-report.js').AuditFinding} AuditFinding */

/**
 * A read that failed.
 * @typedef {object} ReadFailure
 * @property {string} area The kind of thing: `intellects`, `intellect audit`, `avatars`, `catalog`.
 * @property {string} [id]
 * @property {unknown} error
 */

/** True for an error that means the token is unusable, so no read can work. @param {any} e */
export function isTokenError(e) {
  return e?.status === 401 || e?.code === 'wrong_token_scope';
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight. Results keep
 * the order of `items`. A rejection from `fn` rejects the whole call.
 * @template T, R
 * @param {readonly T[]} items @param {number} limit @param {(item:T, index:number)=>Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return out;
}

/** @param {any} agent @returns {string} */
const idOf = (agent) => agent.agentId ?? agent.id;

/**
 * Read what the checks need.
 * @param {string} ks (admin)
 * @param {{agents:import('../agents.js').Agents, avatars:import('../avatars.js').Avatars, catalog:import('../catalog.js').Catalog, intellects:import('../intellects.js').Intellects, intellectConfig:import('../intellect-config.js').IntellectConfig}} deps
 * @param {{agents:any[], selected:Set<string>, needs:Set<string>, audit:boolean, pageSize?:number, concurrency:number}} plan
 * `agents` is the full agent list. `selected` is the ids the run covers. `needs`
 * holds `intellect`, `avatars` and `catalog`. `audit` asks for the intellect config audit too.
 * @returns {Promise<{agents:AgentView[], intellects:IntellectView[], intellectFindings:AuditFinding[], failures:ReadFailure[], checked:Record<string, number>}>}
 */
export async function gather(ks, deps, plan) {
  /** @type {ReadFailure[]} */
  const failures = [];
  /** @param {string} area @param {unknown} error @param {string} [id] */
  const fail = (area, error, id) => {
    if (isTokenError(error)) throw error;
    failures.push({ area, error, ...(id !== undefined ? { id } : {}) });
  };
  const { selected, concurrency } = plan;
  const needsIntellect = plan.needs.has('intellect') || plan.audit;
  const needsAvatars = plan.needs.has('avatars') || plan.needs.has('catalog');

  /** @type {AgentView[]} */
  const views = plan.agents.map((agent) => ({
    agentId: idOf(agent), agent, configId: resolveIntellectId(agent.intellect), intellectState: 'none', avatars: [],
  }));
  const mine = views.filter((v) => selected.has(v.agentId));

  // Intellects: one read per distinct id.
  /** @type {Map<number, AgentView[]>} */
  const byConfig = new Map();
  for (const v of mine) if (v.configId !== undefined) byConfig.set(v.configId, [...(byConfig.get(v.configId) ?? []), v]);
  /** @type {Map<number, Record<string, any>>} */
  const configs = new Map();
  if (needsIntellect) {
    await mapLimit([...byConfig.keys()], concurrency, async (configId) => {
      const users = byConfig.get(configId) ?? [];
      try {
        const config = await deps.intellects.get(configId, ks);
        configs.set(configId, config);
        for (const v of users) Object.assign(v, { intellectState: 'found', intellect: config });
      } catch (e) {
        if (isNotFound(e)) for (const v of users) v.intellectState = 'missing';
        else { fail('intellects', e, String(configId)); for (const v of users) v.intellectState = 'unread'; }
      }
    });
  }

  // The intellect config audit, once per intellect.
  /** @type {IntellectView[]} */
  const intellects = [...configs].map(([configId, config]) => {
    const agentViews = byConfig.get(configId) ?? [];
    return { configId, config, agentIds: agentViews.map((v) => v.agentId).sort(), agents: agentViews };
  });
  /** @type {AuditFinding[]} */
  const intellectFindings = [];
  if (plan.audit) {
    await mapLimit(intellects, concurrency, async (iv) => {
      try {
        const report = await deps.intellectConfig.audit(iv.configId, ks, { config: iv.config });
        intellectFindings.push(...report.findings.map((f) => ({ ...f, agentIds: iv.agentIds })));
      } catch (e) {
        fail('intellect audit', e, String(iv.configId));
      }
    });
  }

  // Avatars and the catalog items they use.
  let avatarCount = 0;
  if (needsAvatars) {
    const wanted = [...new Set(mine.flatMap((v) => (Array.isArray(v.agent.avatarIds) ? v.agent.avatarIds : [])))];
    /** @type {Map<string, AvatarView>} */
    const avatarById = new Map(wanted.map((id) => [id, { id, state: 'unread' }]));
    if (wanted.length > 0) {
      /** @type {Map<string, any>} */
      const listed = new Map();
      try {
        for (const a of await deps.avatars.list(ks, { pageSize: plan.pageSize }).all()) listed.set(a.id, a);
      } catch (e) { fail('avatars', e); }
      await mapLimit(wanted, concurrency, async (id) => {
        const view = /** @type {AvatarView} */ (avatarById.get(id));
        const hit = listed.get(id);
        if (hit) { Object.assign(view, { state: 'found', avatar: hit }); return; }
        try {
          Object.assign(view, { state: 'found', avatar: await deps.avatars.get(id, ks) });
        } catch (e) {
          if (isNotFound(e)) view.state = 'missing';
          else fail('avatars', e, id);
        }
      });
      avatarCount = [...avatarById.values()].filter((a) => a.state === 'found').length;
      if (plan.needs.has('catalog')) await attachCatalog(ks, deps.catalog, [...avatarById.values()], plan, fail);
    }
    for (const v of mine) {
      v.avatars = (Array.isArray(v.agent.avatarIds) ? v.agent.avatarIds : []).map((/** @type {string} */ id) => /** @type {AvatarView} */ (avatarById.get(id)));
    }
  }

  return {
    agents: views, intellects, intellectFindings, failures,
    checked: { agentIntellects: needsIntellect ? byConfig.size : 0, avatars: avatarCount },
  };
}

/**
 * Look up each found avatar's voice and visual. Lists the unscoped catalog
 * once per type, then asks `catalog.get` for what the list missed, because an
 * item scoped to one agent is not in the unscoped list.
 * @param {string} ks @param {import('../catalog.js').Catalog} catalog @param {AvatarView[]} avatars
 * @param {{pageSize?:number, concurrency:number}} plan @param {(area:string, error:unknown, id?:string)=>void} fail
 */
async function attachCatalog(ks, catalog, avatars, plan, fail) {
  const found = avatars.filter((a) => a.state === 'found');
  /** @type {Array<['voice'|'visual', 'Voice'|'Visual']>} */
  const kinds = [['voice', 'Voice'], ['visual', 'Visual']];
  for (const [field, type] of kinds) {
    const ids = [...new Set(found.map((a) => a.avatar?.[field]?.id).filter((id) => typeof id === 'string' && id))];
    if (ids.length === 0) continue;
    /** @type {Map<string, any>} */
    const listed = new Map();
    let listOk = true;
    try {
      for (const item of await catalog.list(ks, { type, pageSize: plan.pageSize }).all()) listed.set(item.itemId ?? item.id, item);
    } catch (e) { listOk = false; fail('catalog', e); }
    /** @type {Map<string, CatalogRef>} */
    const refs = new Map();
    await mapLimit(ids, plan.concurrency, async (id) => {
      if (listed.has(id)) { refs.set(id, { id, state: 'found', item: listed.get(id) }); return; }
      try {
        refs.set(id, { id, state: 'found', item: await catalog.get(id, ks) });
      } catch (e) {
        if (isNotFound(e)) refs.set(id, { id, state: 'missing' });
        else { if (listOk) fail('catalog', e, id); refs.set(id, { id, state: 'unread' }); }
      }
    });
    for (const a of found) {
      const id = a.avatar?.[field]?.id;
      if (typeof id === 'string' && refs.has(id)) a[field] = refs.get(id);
    }
  }
}
