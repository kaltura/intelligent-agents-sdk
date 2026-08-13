/**
 * Agent factory — the UC-1 provision sequence as one call. Mirrors the
 * UC-1 provision sequence documented in API-REFERENCE.md, so the SDK and
 * the reference tooling produce the same agent.
 *
 * Sequence (all on documented endpoints; no new API):
 *   generateProfile → intellect.add → intellect.update (prompts) →
 *   pick preset voice+visual → avatar.create →
 *   agent.create → resolveWidgetId.
 *
 * Returns every id plus a `_meta` provenance receipt. WRITE — NOT idempotent
 * (creates intellect+avatar+agent). On a partial failure the error names which
 * step failed and which ids were already created (so you can clean up).
 */
import { meta, uuidv4 } from '../core/ids.js';
import { KalturaError } from '../core/errors.js';
import { resolveIntellectId } from './agents.js';
import { findIntellectsReferencingTool } from './tools.js';

/**
 * @param {import('./client.js').Management} mgmt
 * @param {object} opts
 * @param {string} opts.brief                Plain-English description of the agent.
 * @param {string} opts.ks                   Admin token.
 * @param {string} [opts.voiceId]            Override the auto-picked preset voice.
 * @param {string} [opts.visualId]           Override the auto-picked preset visual.
 * @param {string[]} [opts.adminTags]
 * @param {number} [opts.maxConversationLength]
 * @param {string} [opts.idempotencyKey]
 * @param {Record<string,'on'|'off'|'disabled'>} [opts.capabilities]   OPTIONAL — capability patch applied AFTER configure via `mgmt.intellects.setCapabilities` (read-merge-write full-replace sub-dict). Off by default.
 * @param {object[]} [opts.tools]            OPTIONAL — typed tool definitions (see `tools.api/csv/code`), each created as a standalone Tool entity via `mgmt.tools.add` and linked via `mgmt.intellectConfig.setToolIds`. Off by default.
 * @param {object} [opts.knowledge]          OPTIONAL — RAG corpus + linkage. `{name?, parentId?, description?, categoryId?, language?, modalities?, autoLink?}`. createCategory (OVP) is admin-allowed; the intellect LINKAGE is deployment-gated (see API-REFERENCE.md § Ground the Agent) — a 403 records `{linked:false, reason}` and NEVER fails the provision. Off by default.
 * @returns {Promise<{name:string,configId:number,avatarId:string,agentId:string,widgetId:string,profile:object,blocks?:object,_meta:object}>}
 */
export async function provision(mgmt, opts) {
  const created = /** @type {{configId?:number, avatarId?:string, agentId?:string}} */ ({});
  const idem = opts.idempotencyKey || uuidv4();
  let step = 'generateProfile';
  try {
    const profile = await mgmt.application.generateProfile(opts.brief, opts.ks);
    const name = profile?.name || 'Demo agent';
    const opening = profile?.openingPhrase || 'Hello!';

    step = 'intellect.add';
    const intel = await mgmt.intellects.add({ type: 'internal', status: 2 }, opts.ks);
    const configId = resolveIntellectId(intel) ?? intel?.id;
    if (!configId) throw new Error('intellect.add returned no id');
    created.configId = configId;

    step = 'intellect.update';
    await mgmt.intellects.update(intellectBody(configId, profile), opts.ks);

    step = 'pick catalog';
    const voiceId = opts.voiceId || (await firstPreset(mgmt, 'Voice', opts.ks));
    const visualId = opts.visualId || (await firstPreset(mgmt, 'Visual', opts.ks));
    if (!voiceId || !visualId) throw new Error('no preset catalog items available');

    step = 'avatar.create';
    const av = await mgmt.avatars.create({
      voice: { id: voiceId, speed: 1.0 },
      visual: { id: visualId, motionControl: { speaking: 0.6, nonSpeaking: 0.2 } },
      openingPhrase: opening,
    }, opts.ks, { idempotencyKey: idem + '-avatar' });
    const avatarId = av?.id;
    if (!avatarId) throw new Error('avatar.create returned no id');
    created.avatarId = avatarId;

    step = 'agent.create';
    const ag = await mgmt.agents.create({
      displayName: name,
      intellect: { intellectType: 'genie', id: configId },
      avatarIds: [avatarId],
      adminTags: opts.adminTags || ['provisioned'],
      maxConversationLength: opts.maxConversationLength || 600,
    }, opts.ks, { idempotencyKey: idem + '-agent' });
    const agentId = ag?.agentId;
    if (!agentId) throw new Error('agent.create returned no agentId');
    created.agentId = agentId;

    step = 'resolveWidgetId';
    const wr = await mgmt.application.resolveWidgetId(agentId, opts.ks);
    const widgetId = wr?.widgetId;

    // ── OPTIONAL, purely-additive post-configure blocks (default off) ──────────
    // These run AFTER the agent exists, never alter the core sequence/return
    // fields, and never fail the provision — each records its own partial result.
    // The methods they call land in Stage-B (G1 capabilities, G2 knowledge); the
    // tools resource is Stage-A. All are invoked DEFENSIVELY (feature-detected),
    // so an unmounted method is reported as skipped rather than throwing.
    const blocks = {};
    if (opts.capabilities !== undefined) blocks.capabilities = await applyCapabilities(mgmt, configId, opts.capabilities, opts.ks);
    if (opts.tools !== undefined) blocks.tools = await applyTools(mgmt, configId, opts.tools, opts.ks);
    if (opts.knowledge !== undefined) blocks.knowledge = await applyKnowledge(mgmt, configId, opts.knowledge, opts.ks);
    const ranBlocks = Object.keys(blocks).length > 0;

    return {
      name, configId, avatarId, agentId, widgetId, profile,
      ...(ranBlocks ? { blocks } : {}),
      _meta: meta({
        partnerId: mgmt._ctx.partnerId, source: 'sdk/provision', scope: 'admin (disableentitlement)',
        ...(ranBlocks ? { optionalBlocks: Object.keys(blocks) } : {}),
      }),
    };
  } catch (err) {
    const detail = `provision failed at step "${step}": ${err && (err.detail || err.message) || err}`;
    throw new KalturaError({
      type: 'https://docs.kaltura.com/agentic/errors/provision_failed', title: 'provision failed', code: 'provision_failed',
      detail, body: { failedStep: step, createdSoFar: created },
    });
  }
}

/** Build the full-format intellect prompt body from a generated profile (mirrors mkjson.py intellect_from_profile). */
function intellectBody(configId, profile) {
  const p = (key, headerTemplate) => ({ key, label: key, headerTemplate, type: 'custom', value: (profile && profile[key]) || '' });
  return {
    id: configId, type: 'internal', status: 2,
    prompts: [
      p('goal', 'Your core goal:'),
      p('targetAudience', 'Your audience:'),
      p('restrictedTopics', 'Never discuss:'),
      p('name', 'You are:'),
    ],
    base_directive: `You are ${(profile && profile.name) || 'Assistant'}. Be concise and helpful.`,
  };
}

/** @param {import('./client.js').Management} mgmt @param {'Voice'|'Visual'} type @param {string} ks */
async function firstPreset(mgmt, type, ks) {
  for await (const item of mgmt.catalog.list(ks, { type, pageSize: 1 })) return item.itemId;
  return undefined;
}

/** Short, redaction-safe reason string from any thrown error (never leaks a KS/body). @param {unknown} e */
function reasonOf(e) {
  const err = /** @type {any} */ (e);
  return String((err && (err.detail || err.message)) || err || 'unknown error');
}

/**
 * OPTIONAL capabilities block. Applies the `{name:state}` patch via
 * `mgmt.intellects.setCapabilities` (Stage-B G1 — read-merge-write full-replace
 * sub-dict). Feature-detected: if the method isn't mounted yet, records
 * `{applied:false, reason}` instead of throwing.
 * @param {import('./client.js').Management} mgmt @param {number} configId
 * @param {Record<string,'on'|'off'|'disabled'>} patch @param {string} ks
 * @returns {Promise<{applied:boolean, requested:string[], reason?:string}>}
 */
async function applyCapabilities(mgmt, configId, patch, ks) {
  const requested = patch && typeof patch === 'object' ? Object.keys(patch) : [];
  const fn = mgmt.intellects && /** @type {any} */ (mgmt.intellects).setCapabilities;
  if (typeof fn !== 'function') {
    return { applied: false, requested, reason: 'intellects.setCapabilities not available (Stage-B G1 not mounted)' };
  }
  try {
    await fn.call(mgmt.intellects, configId, patch, ks);
    return { applied: true, requested };
  } catch (e) {
    // Validation/KalturaError surfaces honestly; the agent is already provisioned.
    return { applied: false, requested, reason: reasonOf(e) };
  }
}

/**
 * OPTIONAL tools block. Each typed tool is created as a standalone Tool entity
 * via `mgmt.tools.add` (partner-level, NOT intellect-scoped) — UPSERT BY NAME:
 * an existing Tool sharing the definition's `name` is reused rather than
 * re-added (`add()` alone is NOT idempotent and a duplicate name may be
 * rejected server-side), so the same tool can be shared safely across
 * repeated/parallel `provision()` calls. The whole batch of ids is then linked
 * in ONE `mgmt.intellectConfig.setToolIds` write. Overwriting THIS intellect's
 * `tool_ids` list is safe because `configId` was just freshly created by THIS
 * SAME call (see `provision()` above) and so starts with no `tool_ids` of its
 * own to lose — this function is not meant for re-linking tools onto an
 * already-existing intellect from elsewhere.
 *
 * SHARED-BY-NAME HAZARD GUARD: a name match doesn't mean the existing Tool is
 * "yours" — since `configId` is brand new it can't be one of the intellects
 * already referencing that Tool, so ANY referencing intellect found is a
 * DIFFERENT one relying on that entity's current `config` (see `tools.js`'s
 * class doc). Before mutating a name-matched Tool in place, this runs the same
 * reference check `Tools#delete` uses ({@link findIntellectsReferencingTool}):
 * if the Tool is already in use elsewhere, its config is left untouched and
 * its id is simply reused for linkage — recorded in the returned
 * `skippedUpdates`, never silently overwritten out from under the other
 * intellect(s).
 *
 * Each tool create/update reports its own result so one bad tool never hides
 * the others, and a failure never fails the provision. Feature-detected.
 * @param {import('./client.js').Management} mgmt @param {number} configId
 * @param {object[]} toolDefs @param {string} ks
 * @returns {Promise<{attached:string[], failed:Array<{name?:string, reason:string}>, skippedUpdates?:Array<{name:string, toolId:string, referencedBy:number[]}>, ids:string[], linked:boolean, linkReason?:string, applied:boolean, reason?:string}>}
 */
async function applyTools(mgmt, configId, toolDefs, ks) {
  const list = Array.isArray(toolDefs) ? toolDefs : [];
  const toolsRes = /** @type {any} */ (mgmt).tools;
  if (!toolsRes || typeof toolsRes.add !== 'function' || typeof mgmt.intellectConfig?.setToolIds !== 'function') {
    return { attached: [], failed: [], ids: [], linked: false, applied: false, reason: 'mgmt.tools.add / intellectConfig.setToolIds not available (Stage-B mount missing)' };
  }
  const attached = [];
  const failed = [];
  const skippedUpdates = [];
  const ids = [];
  // Fetched at most once, lazily, and only if there's at least one named tool to look up.
  let existingByName;
  // Serialize the creates for deterministic ordering (mirrors the old upsert discipline).
  for (const tool of list) {
    const name = tool && typeof tool === 'object' ? /** @type {any} */ (tool).name : undefined;
    try {
      if (!name) {
        const created = await toolsRes.add(tool, ks);
        ids.push(created.id);
      } else {
        existingByName ??= new Map((await toolsRes.list(ks).all()).map((t) => [t.name, t]));
        const existing = existingByName.get(name);
        if (existing) {
          const refs = await findIntellectsReferencingTool(mgmt._ctx, existing.id, ks);
          if (refs.length > 0) skippedUpdates.push({ name, toolId: existing.id, referencedBy: refs });
          else await toolsRes.update(existing.id, { config: tool }, ks);
        } else {
          existingByName.set(name, await toolsRes.add(tool, ks));
        }
        ids.push(existingByName.get(name).id);
      }
      attached.push(name);
    } catch (e) {
      failed.push({ name, reason: reasonOf(e) });
    }
  }
  let linked = false;
  let linkReason;
  if (ids.length > 0) {
    try {
      await mgmt.intellectConfig.setToolIds(configId, ids, ks);
      linked = true;
    } catch (e) {
      linkReason = reasonOf(e);
    }
  }
  return {
    attached, failed, ids, linked,
    ...(skippedUpdates.length ? { skippedUpdates } : {}),
    ...(linkReason ? { linkReason } : {}),
    applied: failed.length === 0 && linked,
  };
}

/**
 * OPTIONAL knowledge block — corpus container + (gated) intellect linkage.
 *
 * HONEST GATE: OVP `category/add`
 * (createCategory) IS admin-allowed, but writing the LINKAGE onto the intellect
 * (`partner-config/update`) is deployment-gated and 403s for a partner admin KS
 * today. So this block:
 *   1. probes `mgmt.knowledge.linkAvailable` (when present) and short-circuits to
 *      `{linked:false, reason}` if the linkage write is gated;
 *   2. creates/reuses the corpus category (when `mgmt.knowledge.createCategory`
 *      is mounted, Stage-B G2) — recording the categoryId either way;
 *   3. attempts `linkCategory` only when `autoLink` is requested AND not gated,
 *      recording `{linked, reason}` — a 403 NEVER fails the provision.
 *
 * @param {import('./client.js').Management} mgmt @param {number} configId
 * @param {object} kn {name?, parentId?, description?, categoryId?, language?, modalities?, autoLink?}
 * @param {string} ks
 * @returns {Promise<{categoryId?:number, created:boolean, linked:boolean, gated:boolean, reason?:string}>}
 */
async function applyKnowledge(mgmt, configId, kn, ks) {
  const k = /** @type {any} */ (mgmt.knowledge);
  if (!k) return { created: false, linked: false, gated: true, reason: 'knowledge resource not mounted' };

  // (1) Probe the linkage gate up front (so the badge has a machine-readable source).
  let gated = false;
  let gateReason;
  if (typeof k.linkAvailable === 'function') {
    try {
      const probe = await k.linkAvailable(ks);
      if (probe && probe.available === false) { gated = true; gateReason = probe.reason; }
    } catch (e) { gated = true; gateReason = reasonOf(e); }
  }

  // (2) Corpus container: reuse a caller-supplied categoryId, else create one.
  let categoryId = kn && kn.categoryId;
  let created = false;
  if (!categoryId) {
    if (typeof k.createCategory !== 'function') {
      return { created: false, linked: false, gated, reason: gateReason || 'knowledge.createCategory not available (Stage-B G2 not mounted) and no categoryId supplied' };
    }
    try {
      const cat = await k.createCategory({ name: (kn && kn.name) || 'Knowledge', parentId: kn && kn.parentId, description: kn && kn.description }, ks);
      categoryId = cat && (cat.id ?? cat.categoryId);
      created = Boolean(categoryId);
      if (!categoryId) return { created: false, linked: false, gated, reason: 'createCategory returned no id' };
    } catch (e) {
      return { created: false, linked: false, gated, reason: reasonOf(e) };
    }
  }

  // (3) Linkage — only if requested and not gated. A 403 is honest, not fatal.
  if (!kn || kn.autoLink !== true) {
    return { categoryId, created, linked: false, gated, reason: gated ? gateReason : 'autoLink not requested (corpus container created; linkage skipped)' };
  }
  if (gated) {
    return { categoryId, created, linked: false, gated: true, reason: gateReason || 'knowledge linkage is deployment-gated (see API-REFERENCE.md § Ground the Agent)' };
  }
  if (typeof k.linkCategory !== 'function') {
    return { categoryId, created, linked: false, gated, reason: 'knowledge.linkCategory not available' };
  }
  try {
    const res = await k.linkCategory({ configId, categoryId, language: kn.language, modalities: kn.modalities }, ks);
    // CONTRACT (conversations.js Knowledge.linkCategory): the landed method does
    // NOT throw on the deployment gate — it CATCHES 403/404 and returns
    // `{applied:false, code, reason}` (never faking success). Honor that shape:
    // an `applied:false` (or `code:'forbidden'/'not_deployed'`) is the gate, not
    // a link. Treating a resolved promise as success would FAKE linked:true.
    if (res && res.applied === false) {
      const isGate = res.code === 'forbidden' || res.code === 'not_deployed' || gated;
      return { categoryId, created, linked: false, gated: isGate, reason: res.reason || gateReason || 'knowledge linkage not applied' };
    }
    return { categoryId, created, linked: true, gated: false };
  } catch (e) {
    // Defensive: an older/alternate linkCategory MIGHT throw a 403 instead of
    // returning {applied:false}; map it to the same honest gate, never fatal.
    const err = /** @type {any} */ (e);
    const is403 = err && (err.status === 403 || err.code === 'forbidden');
    return { categoryId, created, linked: false, gated: is403, reason: is403 ? `knowledge linkage forbidden (403) — partner-config/update needs a higher privilege (see API-REFERENCE.md § Ground the Agent): ${reasonOf(e)}` : reasonOf(e) };
  }
}
