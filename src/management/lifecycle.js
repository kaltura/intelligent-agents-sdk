/**
 * Lifecycle — event-driven rule engine on the Agentic host's `lifecycle/*`
 * routes (agentic-hosted, `{offset,limit}` pager). A rule is `{eventType, objectType,
 * eventConditions[], action}` — when a matching backend event fires (e.g. a
 * thread's `session_ended`), every active rule (including partner-invisible,
 * system-seeded presets — see {@link Lifecycle#match}) is evaluated and its
 * `action` runs server-side. Four action shapes exist, passed through as
 * plain objects (not built by the SDK), but only the first two are meant to
 * be created here — the other two only exist to power system preset rules
 * and ignore anything a caller passes:
 * `{actionType:'triggerInsight', insights:[{insightKey, valueType, prompt?}, ...]}`
 * (`valueType` is REQUIRED on every insight, even built-in keys like
 * `SUMMARY` — omitting it 400s live: "action.insights.0.valueType must be
 * one of the following values: string, number, boolean, arrayString,
 * arrayNumber, arrayBoolean"; every rule extracting insights on the same
 * event merges into one LLM batch, so don't request `SUMMARY` — every
 * partner already has an always-on preset producing one for free),
 * `{actionType:'sendInsightEmail', recipients:string[], templateId?:string,
 * presetType?:string}` (only fires on `eventType:'analysis_updated'` — a
 * `session_ended` rule with this action type is a no-op server-side),
 * `{actionType:'triggerOverridableSummaryInsight'}` (system preset only —
 * customize its prompt via `agents.update({agentId, summaryOverridePrompt})`,
 * not a rule), and `{actionType:'triggerDataToCollectInsight'}` (system
 * preset only, currently disabled account-wide — would extract one insight
 * per configured lead-capture field, `intellectConfig.user_properties_forms`,
 * if enabled). See
 * `docs/LIFECYCLE-INSIGHTS-RECIPE.md` for the full explanation. Mounted at
 * `mgmt.lifecycle`.
 */
import { paginate } from './paginate.js';
import { uuidv4, meta } from '../core/ids.js';
import { requireConfirm } from './agents.js';
import { KalturaError } from '../core/errors.js';

/** @param {unknown} v @param {string} where */
function requireRuleId(v, where) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} id must be a non-empty string (the lifecycle rule's id).` });
  }
}

/** @param {unknown} v @param {string} where @param {string} field */
function requireNonEmptyString(v, where, field) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `${where} ${field} must be a non-empty string.` });
  }
}

export class Lifecycle {
  /** @param {import('./client.js').Ctx} ctx */
  constructor(ctx) { this._ = ctx; }

  /**
   * Create a lifecycle rule. WRITE — NOT idempotent (a repeat call creates a
   * second rule, same as {@link Tools#add}).
   * @param {{name:string, systemName:string, eventType:string, objectType:string, eventConditions?:Array<{field:string,operator:string,value:unknown}>, action:object}} body
   * @param {string} ks (admin)
   */
  async create(body, ks) {
    this._.assertAdmin(ks, 'lifecycle.create');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'lifecycle.create needs a {name, systemName, eventType, objectType, eventConditions?, action} object.' });
    }
    requireNonEmptyString(body.name, 'lifecycle.create', 'name');
    requireNonEmptyString(body.systemName, 'lifecycle.create', 'systemName');
    requireNonEmptyString(body.eventType, 'lifecycle.create', 'eventType');
    requireNonEmptyString(body.objectType, 'lifecycle.create', 'objectType');
    if (!body.action || typeof body.action !== 'object') {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'lifecycle.create action must be an object (e.g. {actionType:"triggerInsight", insights:[...]}).' });
    }
    /** @type {Record<string,unknown>} */
    const wire = { name: body.name, systemName: body.systemName, eventType: body.eventType, objectType: body.objectType, action: body.action };
    if (body.eventConditions !== undefined) wire.eventConditions = body.eventConditions;
    return (await this._.agentic('lifecycle/create', wire, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Get a lifecycle rule by id. READ.
   * @param {string} id @param {string} ks (admin)
   */
  async get(id, ks) {
    this._.assertAdmin(ks, 'lifecycle.get');
    requireRuleId(id, 'lifecycle.get');
    return (await this._.agentic('lifecycle/get', { id }, ks)).data;
  }

  /**
   * List lifecycle rules for the authenticated partner. READ. Async-iterable
   * + awaitable (first page) — mirrors {@link Avatars#list}'s `{offset,limit}`
   * pager (agentic-hosted, NOT the Genie `{pageIndex,pageSize}` convention).
   * @param {string} ks (admin)
   * @param {{filter?:{eventTypeEqual?:string, statusEqual?:string, systemNameEqual?:string}, orderBy?:'+createdAt'|'-createdAt', pageSize?:number}} [opts]
   */
  list(ks, opts = {}) {
    this._.assertAdmin(ks, 'lifecycle.list');
    return paginate({
      style: 'offset', pageSize: opts.pageSize,
      fetchPage: (pager) => this._.agentic('lifecycle/list', { filter: opts.filter || {}, ...(opts.orderBy ? { orderBy: opts.orderBy } : {}), pager }, ks).then((r) => r.data),
    });
  }

  /**
   * Update a lifecycle rule's name/systemName/eventType/objectType/status/
   * eventConditions/action. WRITE — idempotent.
   * @param {string} id
   * @param {{name?:string, systemName?:string, eventType?:string, objectType?:string, status?:string, eventConditions?:Array<object>, action?:object}} patch
   * @param {string} ks (admin)
   */
  async update(id, patch, ks) {
    this._.assertAdmin(ks, 'lifecycle.update');
    requireRuleId(id, 'lifecycle.update');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'lifecycle.update needs a patch object.' });
    }
    const fields = ['name', 'systemName', 'eventType', 'objectType', 'status', 'eventConditions', 'action'];
    if (!fields.some((f) => patch[f] !== undefined)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `lifecycle.update needs at least one of ${fields.join('/')}.` });
    }
    /** @type {Record<string,unknown>} */
    const wire = { id };
    for (const f of fields) if (patch[f] !== undefined) wire[f] = patch[f];
    return (await this._.agentic('lifecycle/update', wire, ks, { idempotencyKey: uuidv4() })).data;
  }

  /**
   * Delete a lifecycle rule by id. WRITE — destructive (requires
   * confirmation). No in-use scan runs first: unlike {@link Skills}/
   * {@link Tools}, nothing else references a lifecycle rule by id.
   * @param {string} id @param {string} ks (admin) @param {{confirmPermanent:boolean}} confirm
   * @returns {Promise<{removed:string, success:boolean, _meta:object}>}
   */
  async delete(id, ks, confirm) {
    this._.assertAdmin(ks, 'lifecycle.delete');
    requireRuleId(id, 'lifecycle.delete');
    requireConfirm(confirm, 'lifecycle.delete', id);
    const { success } = await this._.agentic('lifecycle/delete', { id }, ks).then((r) => r.data);
    return { removed: id, success, _meta: meta({ partnerId: this._.partnerId, source: 'agentic/lifecycle.delete', scope: `lifecycle:${id}` }) };
  }

  /**
   * Dry-run event matching: "if this event happened right now, which rules
   * would fire?" READ. `eventData` is `{object?:object, changed_keys?:string[]}`
   * — NOT a bare `object` field at the top level. For `objectType:'thread'`
   * (both `session_ended` and `analysis_updated`), `object` is validated
   * server-side against a strict schema — all 3 of `agent_id`, `thread_id`,
   * `user_id` are REQUIRED strings; omitting any one 400s live naming the
   * missing path (e.g. `"eventData.object.user_id: Invalid input: expected
   * string, received undefined"`).
   *
   * The response can include rules the caller never created: production
   * ships system-seeded preset rules (e.g.
   * `preset__overridable_summary_on_session_ended`, which matches every
   * `session_ended`/`thread` event for every partner by default) that show
   * up in `matchedRules[]` alongside the caller's own. Related rules are
   * grouped: `matchedRules[].isGrouped` is `true` when two or more rules
   * share a `groupKey` and dispatch as one composite action. Example mixed
   * response:
   * ```json
   * {
   *   "matchedRules": [
   *     {
   *       "isGrouped": true,
   *       "groupKey": "_system_grouped_kai_insights",
   *       "rules": [
   *         { "id": "preset__overridable_summary_on_session_ended", "systemName": "overridable_summary_on_session_ended", "action": { "actionType": "triggerOverridableSummaryInsight" } },
   *         { "id": "68a...", "systemName": "my_custom_rule", "action": { "actionType": "triggerInsight", "insights": [{ "insightKey": "SESSIONSUMMARY", "valueType": "string" }] } }
   *       ]
   *     }
   *   ]
   * }
   * ```
   * @param {string} objectType @param {string} eventType
   * @param {{object?:object, changed_keys?:string[]}} eventData
   * @param {string} ks (admin)
   */
  async match(objectType, eventType, eventData, ks) {
    this._.assertAdmin(ks, 'lifecycle.match');
    requireNonEmptyString(objectType, 'lifecycle.match', 'objectType');
    requireNonEmptyString(eventType, 'lifecycle.match', 'eventType');
    if (!eventData || typeof eventData !== 'object' || Array.isArray(eventData)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'lifecycle.match eventData must be an object shaped {object?, changed_keys?} (not a bare object at the top level).' });
    }
    return (await this._.agentic('lifecycle/match', { objectType, eventType, eventData }, ks)).data;
  }

  /**
   * List the object types rules can target (currently just `thread`). READ,
   * one-call passthrough — for a no-code rule-editor UI's dropdowns.
   * @param {string} ks (admin)
   */
  async listObjects(ks) {
    this._.assertAdmin(ks, 'lifecycle.listObjects');
    return (await this._.agentic('lifecycle/listObjects', {}, ks)).data;
  }

  /**
   * List the event types available for an object type. READ, one-call
   * passthrough.
   * @param {string} objectType @param {string} ks (admin)
   */
  async listEvents(objectType, ks) {
    this._.assertAdmin(ks, 'lifecycle.listEvents');
    requireNonEmptyString(objectType, 'lifecycle.listEvents', 'objectType');
    return (await this._.agentic('lifecycle/listEvents', { objectType }, ks)).data;
  }

  /**
   * Describe which fields are filterable in `eventConditions` for a given
   * object type + event type pair. READ, one-call passthrough.
   * @param {string} objectType @param {string} eventType @param {string} ks (admin)
   */
  async describeFields(objectType, eventType, ks) {
    this._.assertAdmin(ks, 'lifecycle.describeFields');
    requireNonEmptyString(objectType, 'lifecycle.describeFields', 'objectType');
    requireNonEmptyString(eventType, 'lifecycle.describeFields', 'eventType');
    return (await this._.agentic('lifecycle/describeFields', { objectType, eventType }, ks)).data;
  }
}
