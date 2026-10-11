/**
 * Lifecycle — event-driven rule engine on the Agentic host's `lifecycle/*`
 * routes (agentic-hosted, `{offset,limit}` pager). A rule is `{eventType,
 * objectType, eventConditions[], action}`, when a matching event
 * fires (e.g. a thread's `session_ended`), every active rule (including
 * preset rules you did not create, see {@link
 * Lifecycle#match}) is evaluated and its `action` runs. Three
 * action shapes are available to callers, passed through as plain objects
 * (not built by the SDK):
 *
 * - `{actionType:'triggerInsightSettingsKai', insightSettingsIds:string[]}`
 *   — extract one or more previously-defined insights (see
 *   {@link InsightSettings}, mounted at `mgmt.insightSettings`). Each id in
 *   `insightSettingsIds` (max 20) is validated at rule create/update time —
 *   an id that doesn't exist or isn't owned by the calling partner 400s. At
 *   dispatch time, only ids whose insight setting has `status:'active'`
 *   actually resolve into an extraction; a `disabled` one is silently
 *   skipped (the rest of the action still fires).
 * - `{actionType:'sendInsightEmail', recipients:string[], templateId?:string,
 *   presetType?:string}` — only fires on `eventType:'analysis_updated'`; a
 *   `session_ended` rule with this action type does nothing.
 * - `{actionType:'triggerDtcKai'}` — takes no caller-supplied fields.
 *   Extracts one insight per lead-capture field configured on the target
 *   intellect (`intellectConfig.user_properties_forms`) and is
 *   automatically skipped when none are configured.
 *
 * Every session also gets one fixed, built-in summary insight for free —
 * it comes from a preset rule visible via {@link
 * Lifecycle#match} but never creatable, updatable, or customizable by a
 * caller. See `docs/lifecycle/README.md` for the full explanation. Mounted
 * at `mgmt.lifecycle`.
 */
import { paginate } from './paginate.js';
import { uuidv4, meta } from '../core/ids.js';
import { requireConfirm, resolveIntellectId } from './agents.js';
import { KalturaError } from '../core/errors.js';
import { hasAgentScope, hasEmailTrigger, scopedAgentIds } from './lifecycle-rules.js';
import { auditLifecycleRules } from './lifecycle-audit.js';
import { auditReport, isNotFound } from './audit-report.js';

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

/**
 * Refuse a `thread` rule that has no `object.agent_id` condition (operator
 * `eq` with an id, or `in` with a list of ids). Without one the rule runs
 * for every agent on the partner.
 * @param {unknown} eventConditions @param {string} where
 */
function requireAgentScope(eventConditions, where) {
  if (hasAgentScope(eventConditions)) return;
  throw new KalturaError({
    type: 'about:blank', title: 'unscoped lifecycle rule', code: 'lifecycle_unscoped',
    detail: `${where}: a thread rule needs an agent condition, or it runs for every agent on the partner. Add {field:'object.agent_id', operator:'eq', value:'<agent-uuid>'} (a non-empty id; operator 'in' takes a non-empty array of ids) to eventConditions, or pass { partnerWide: true } to run on every agent on purpose.`,
  });
}

/**
 * Refuse a `sendInsightEmail` rule on `analysis_updated` that has no
 * `changed_keys` condition. The action has no once-per-thread guard, so
 * without one it sends on every analysis update.
 * @param {unknown} eventConditions @param {string} where
 */
function requireEmailTrigger(eventConditions, where) {
  if (hasEmailTrigger(eventConditions)) return;
  throw new KalturaError({
    type: 'about:blank', title: 'unfiltered email rule', code: 'lifecycle_email_unfiltered',
    detail: `${where}: a sendInsightEmail rule on analysis_updated sends on every analysis update unless it names the insight keys it waits for. Add {field:'changed_keys', operator:'has_all', value:['SUMMARY', ...]} to eventConditions, or pass { emailOnEveryUpdate: true } to send on every update on purpose.`,
  });
}

export class Lifecycle {
  /**
   * @param {import('./client.js').Ctx} ctx
   * @param {{insightSettings:import('./insight-settings.js').InsightSettings, agents:import('./agents.js').Agents, emailTemplates:import('./email-templates.js').EmailTemplates, intellects:import('./intellects.js').Intellects}} [siblings] The resources {@link Lifecycle#audit} reads. Without them `audit` throws.
   */
  constructor(ctx, siblings) {
    this._ = ctx;
    this._siblings = siblings;
  }

  /**
   * Check the partner's existing lifecycle rules for mistakes. READ only, it
   * changes nothing. Reads every rule, insight setting and agent (all pages).
   * It reads each email template a rule pins, and each intellect a
   * `triggerDtcKai` rule needs, by id. Then it runs {@link auditLifecycleRules}.
   *
   * If the Messaging host is not available (`region_unavailable`), the template
   * checks are skipped and the report says `skipped: ['templates']`. Any other
   * error is thrown.
   *
   * Finding codes: `unscoped_rule`, `agent_not_found`, `duplicate_agent_ids`,
   * `insight_setting_missing`, `insight_setting_disabled`,
   * `too_many_insight_settings`, `email_on_session_ended`, `email_unfiltered`,
   * `changed_keys_unproduced`, `template_missing_or_deleted`,
   * `template_tokens_unproduced`, `dtc_without_forms`, `rule_disabled`.
   * @param {string} ks (admin)
   * @param {{agentIds?:string[], pageSize?:number}} [opts] `agentIds` keeps only findings for rules that run for one of those agents, including rules with no agent scope.
   * @returns {Promise<import('./audit-report.js').AuditReport>}
   */
  async audit(ks, opts = {}) {
    this._.assertAdmin(ks, 'lifecycle.audit');
    const s = this._siblings;
    if (!s) throw new KalturaError({ type: 'about:blank', title: 'audit unavailable', code: 'bad_request', detail: 'lifecycle.audit needs the sibling resources. Use mgmt.lifecycle from a Management instance.' });
    const { pageSize } = opts;
    const [rules, insightSettings, agents] = await Promise.all([
      this.list(ks, { pageSize }).all(), s.insightSettings.list(ks, { pageSize }).all(), s.agents.list(ks, { pageSize }).all(),
    ]);
    const live = rules.filter((r) => r.status === undefined || r.status === 'active');
    /** @type {string[]} */
    const skipped = [];

    /** @type {Array<any>|null} */
    let emailTemplates = [];
    const templateIds = [...new Set(live.map((r) => r.action?.templateId).filter((id) => typeof id === 'string' && id))];
    try {
      for (const id of templateIds) {
        try { emailTemplates.push(await s.emailTemplates.get(id, ks)); } catch (e) { if (!isNotFound(e)) throw e; }
      }
    } catch (e) {
      if (/** @type {any} */ (e)?.code !== 'region_unavailable') throw e;
      emailTemplates = null;
      skipped.push('templates');
    }

    /** @type {Record<string, any>} */
    const intellects = {};
    /** @type {Map<number, any>} */
    const fetched = new Map();
    const dtcAgentIds = new Set(live.filter((r) => r.action?.actionType === 'triggerDtcKai').flatMap((r) => scopedAgentIds(r.eventConditions)));
    for (const agent of agents) {
      const agentId = agent.agentId ?? agent.id;
      if (!dtcAgentIds.has(agentId)) continue;
      const configId = resolveIntellectId(agent.intellect);
      if (configId === undefined) continue;
      if (!fetched.has(configId)) {
        fetched.set(configId, await s.intellects.get(configId, ks).catch((e) => { if (isNotFound(e)) return null; throw e; }));
      }
      intellects[agentId] = fetched.get(configId);
    }

    let findings = auditLifecycleRules(rules, { insightSettings, agents, emailTemplates, intellects });
    const only = opts.agentIds;
    if (only) {
      const keep = new Set(rules.filter((r) => { const ids = scopedAgentIds(r.eventConditions); return ids.length === 0 || ids.some((id) => only.includes(id)); }).map((r) => r.id));
      findings = findings.filter((f) => keep.has(/** @type {string} */ (f.ruleId)));
    }
    return auditReport(findings, { rules: rules.length, insightSettings: insightSettings.length, agents: agents.length, emailTemplates: emailTemplates?.length ?? 0, intellects: fetched.size }, skipped);
  }

  /**
   * Create a lifecycle rule. WRITE — NOT idempotent (a repeat call creates a
   * second rule, same as {@link Tools#add}).
   *
   * A `thread` rule must scope itself to an agent: `eventConditions` needs an
   * entry with `field:'object.agent_id'` and operator `eq` (a non-empty id)
   * or `in` (a non-empty array of ids). A rule without one runs for every
   * agent on the partner, so the SDK throws `KalturaError` with
   * `code:'lifecycle_unscoped'` before any request. Pass
   * `{ partnerWide: true }` to run on every agent on purpose. Other
   * `objectType` values are not checked.
   *
   * A `sendInsightEmail` rule on `analysis_updated` must also name the insight
   * keys it waits for: a `changed_keys` condition with operator `has_all` or
   * `has_any` and a non-empty array of keys. Otherwise it sends on every
   * analysis update, so the SDK throws `code:'lifecycle_email_unfiltered'`.
   * Pass `{ emailOnEveryUpdate: true }` to send on every update on purpose.
   * @param {{name:string, systemName:string, eventType:string, objectType:string, eventConditions?:Array<{field:string,operator:string,value:unknown}>, action:object}} body
   * @param {string} ks (admin)
   * @param {{partnerWide?:boolean, emailOnEveryUpdate?:boolean}} [opts] `partnerWide:true` skips the agent-scope check. `emailOnEveryUpdate:true` skips the email-trigger check
   */
  async create(body, ks, opts = {}) {
    this._.assertAdmin(ks, 'lifecycle.create');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'lifecycle.create needs a {name, systemName, eventType, objectType, eventConditions?, action} object.' });
    }
    requireNonEmptyString(body.name, 'lifecycle.create', 'name');
    requireNonEmptyString(body.systemName, 'lifecycle.create', 'systemName');
    requireNonEmptyString(body.eventType, 'lifecycle.create', 'eventType');
    requireNonEmptyString(body.objectType, 'lifecycle.create', 'objectType');
    if (!body.action || typeof body.action !== 'object') {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'lifecycle.create action must be an object (e.g. {actionType:"triggerInsightSettingsKai", insightSettingsIds:[...]}).' });
    }
    if (body.objectType === 'thread' && opts.partnerWide !== true) requireAgentScope(body.eventConditions, 'lifecycle.create');
    if (body.eventType === 'analysis_updated' && /** @type {any} */ (body.action).actionType === 'sendInsightEmail' && opts.emailOnEveryUpdate !== true) {
      requireEmailTrigger(body.eventConditions, 'lifecycle.create');
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
   *
   * The agent-scope rule from {@link Lifecycle#create} applies when the patch
   * includes `eventConditions`. The patch's `objectType` decides whether the
   * rule is a `thread` rule; without one the SDK assumes `thread`. The new
   * conditions then need an `object.agent_id` entry with operator `eq` or
   * `in` and real ids, or the SDK throws `code:'lifecycle_unscoped'` before
   * any request. `{ partnerWide: true }` skips the check.
   *
   * The email-trigger rule from {@link Lifecycle#create} applies when the
   * patch sets a `sendInsightEmail` `action` together with `eventConditions`
   * (and an `eventType` of `analysis_updated`, or none). `{ emailOnEveryUpdate:
   * true }` skips it.
   *
   * Send the full `eventConditions` list, not only the new condition. The SDK
   * cannot see stored conditions, so a patch that leaves out
   * `eventConditions` is not checked.
   * @param {string} id
   * @param {{name?:string, systemName?:string, eventType?:string, objectType?:string, status?:string, eventConditions?:Array<object>, action?:object}} patch
   * @param {string} ks (admin)
   * @param {{partnerWide?:boolean, emailOnEveryUpdate?:boolean}} [opts] `partnerWide:true` skips the agent-scope check. `emailOnEveryUpdate:true` skips the email-trigger check
   */
  async update(id, patch, ks, opts = {}) {
    this._.assertAdmin(ks, 'lifecycle.update');
    requireRuleId(id, 'lifecycle.update');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: 'lifecycle.update needs a patch object.' });
    }
    const fields = ['name', 'systemName', 'eventType', 'objectType', 'status', 'eventConditions', 'action'];
    if (!fields.some((f) => patch[f] !== undefined)) {
      throw new KalturaError({ type: 'about:blank', title: 'bad request', code: 'bad_request', detail: `lifecycle.update needs at least one of ${fields.join('/')}.` });
    }
    if (patch.eventConditions !== undefined && (patch.objectType === undefined || patch.objectType === 'thread') && opts.partnerWide !== true) {
      requireAgentScope(patch.eventConditions, 'lifecycle.update');
    }
    if (patch.eventConditions !== undefined && /** @type {any} */ (patch.action)?.actionType === 'sendInsightEmail'
      && (patch.eventType === undefined || patch.eventType === 'analysis_updated') && opts.emailOnEveryUpdate !== true) {
      requireEmailTrigger(patch.eventConditions, 'lifecycle.update');
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
   * (both `session_ended` and `analysis_updated`), `object` needs all 3 of
   * `agent_id`, `thread_id`, `user_id` as strings. Omitting any one returns a
   * 400 that names the missing field.
   *
   * The response can include rules the caller never created. The preset rule
   * `preset__summary_on_session_ended` matches every `session_ended`/`thread`
   * event and shows up in `matchedRules[]` alongside the caller's own.
   * Related rules are grouped: `matchedRules[].isGrouped` is `true` when two
   * or more rules share a `groupKey` and dispatch as one composite action.
   * Example mixed response:
   * ```json
   * {
   *   "matchedRules": [
   *     {
   *       "isGrouped": true,
   *       "groupKey": "_default_all_kai_triggers",
   *       "rules": [
   *         { "id": "preset__summary_on_session_ended", "systemName": "summary_on_session_ended", "action": { "actionType": "<system-internal — never sent or constructed by a caller>" } },
   *         { "id": "68a...", "systemName": "my_custom_rule", "action": { "actionType": "triggerInsightSettingsKai", "insightSettingsIds": ["507f1f77bcf86cd799439011"] } }
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
   * List the object types rules can target (e.g. `thread`). READ,
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
