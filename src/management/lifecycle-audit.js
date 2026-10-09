/**
 * Pure audit of existing lifecycle rules. No network. `Lifecycle#audit` and
 * `Doctor#run` fetch the inputs and call {@link auditLifecycleRules}.
 *
 * Each check rests on behavior `docs/lifecycle/README.md` already states.
 */
import { hasAgentScope, scopedAgentIds, changedKeysFilter, isAgentCondition } from './lifecycle-rules.js';

/** Insight keys the always-on summary rule writes for every session. */
const FREE_KEYS = ['SUMMARY'];
/** Keys `conversationInsightExample` needs from the analysis. */
const PRESET_KEYS = ['SUMMARY', 'TOPIC', 'CUSTOM'];
/** Tokens the email action fills in itself. */
const AUTO_TOKENS = new Set(['AGENTNAME', 'CTAURL', 'USER']);
/** `insightSettingsIds` allows at most this many ids. */
export const MAX_INSIGHT_SETTINGS_PER_RULE = 20;

/** @typedef {import('./audit-report.js').AuditFinding} AuditFinding */

/**
 * What the audit needs to know about the partner. Pass only what you fetched.
 * @typedef {object} LifecycleAuditContext
 * @property {Array<{id:string, key:string, status?:string}>} insightSettings Every insight setting on the partner.
 * @property {Array<{agentId?:string, id?:string}>} agents Every agent on the partner.
 * @property {Array<{id:string, status?:string, msgParamsMap?:Record<string,{type?:string}>}>|null} [emailTemplates] Every email template. `null` or omitted skips the template checks.
 * @property {Record<string, {user_properties_forms?:unknown}|null>} [intellects] The intellect of each agent, keyed by agent id. `null` means it could not be read. An agent that is missing from the map is not checked.
 */

/** @param {any} rule */
const isPreset = (rule) => typeof rule?.id === 'string' && rule.id.startsWith('preset__');
/** @param {any} rule */
const isDisabled = (rule) => rule?.status !== undefined && rule.status !== 'active';
/** @param {any} rule */
const actionOf = (rule) => (rule?.action && typeof rule.action === 'object' ? rule.action : {});

/**
 * Do two rules cover a common agent? A rule with no agent scope covers all.
 * @param {string[]} a @param {string[]} b
 */
function overlaps(a, b) {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((id) => b.includes(id));
}

/**
 * Audit existing lifecycle rules against the partner's insight settings,
 * agents, email templates and intellects. PURE: no network, never throws on
 * odd input. Returns one finding per problem. A disabled rule gets only
 * `rule_disabled`, and produces nothing for other rules' checks.
 *
 * | code | severity | what it flags |
 * |---|---|---|
 * | `unscoped_rule` | warn | A `thread` rule with no agent condition runs for every agent. |
 * | `agent_not_found` | warn | The rule names an agent id the partner does not have. |
 * | `duplicate_agent_ids` | info | The same agent id appears twice in the rule's agent conditions. |
 * | `insight_setting_missing` | warn | `insightSettingsIds` holds an id with no insight setting. It is skipped. |
 * | `insight_setting_disabled` | warn | A referenced insight setting is `disabled`. It is skipped. |
 * | `too_many_insight_settings` | error | More than 20 `insightSettingsIds`. |
 * | `email_on_session_ended` | error | `sendInsightEmail` only fires on `analysis_updated`. |
 * | `email_unfiltered` | warn | A `sendInsightEmail` rule on `analysis_updated` has no `changed_keys` filter. |
 * | `changed_keys_unproduced` | warn | The `changed_keys` filter waits for a key no active rule on those agents produces. |
 * | `template_missing_or_deleted` | error | The pinned `templateId` does not exist or has `status:'deleted'`. |
 * | `template_tokens_unproduced` | warn | The template or preset needs a key no active rule on those agents produces. |
 * | `dtc_without_forms` | warn | `triggerDtcKai` on an agent whose intellect has no `user_properties_forms`. |
 * | `rule_disabled` | info | The rule is not active. |
 *
 * The key checks skip when an active `triggerDtcKai` rule covers the same
 * agents, since the keys it writes are not documented.
 * @param {Array<any>} rules Lifecycle rules, as `lifecycle.list` returns them.
 * @param {LifecycleAuditContext} ctx
 * @returns {AuditFinding[]}
 */
export function auditLifecycleRules(rules, ctx) {
  /** @type {AuditFinding[]} */
  const findings = [];
  const list = Array.isArray(rules) ? rules : [];
  const settingsById = new Map((ctx.insightSettings || []).map((s) => [s.id, s]));
  const agentIds = new Set((ctx.agents || []).map((a) => a.agentId ?? a.id));
  const templatesById = ctx.emailTemplates ? new Map(ctx.emailTemplates.map((t) => [t.id, t])) : null;
  const live = list.filter((r) => !isDisabled(r));

  /** The keys the other active rules on these agents write, or `null` when that is unknowable. @param {string[]} scope */
  const producedKeys = (scope) => {
    const keys = new Set(FREE_KEYS);
    for (const p of live) {
      const action = actionOf(p);
      if (!overlaps(scope, scopedAgentIds(p.eventConditions))) continue;
      if (action.actionType === 'triggerDtcKai') return null;
      if (action.actionType !== 'triggerInsightSettingsKai') continue;
      for (const id of Array.isArray(action.insightSettingsIds) ? action.insightSettingsIds : []) {
        const s = settingsById.get(id);
        if (s && s.status !== 'disabled') keys.add(s.key);
      }
    }
    return keys;
  };

  for (const rule of list) {
    if (isPreset(rule)) continue;
    /** @param {AuditFinding['severity']} severity @param {string} code @param {string} message @param {string} fix @param {Partial<AuditFinding>} [extra] */
    const add = (severity, code, message, fix, extra = {}) => {
      findings.push({ severity, code, ruleId: rule.id, ...(rule.systemName ? { systemName: rule.systemName } : {}), message, fix, ...extra });
    };
    if (isDisabled(rule)) {
      add('info', 'rule_disabled', `The rule is ${rule.status}, so it never fires.`, 'Set status to active to use it, or delete it.');
      continue;
    }
    const action = actionOf(rule);
    const conditions = Array.isArray(rule.eventConditions) ? rule.eventConditions : [];
    const scope = scopedAgentIds(conditions);

    if (rule.objectType === 'thread' && !hasAgentScope(conditions)) {
      add('warn', 'unscoped_rule', 'The rule has no agent condition, so it runs for every agent on the partner.',
        "Add {field:'object.agent_id', operator:'eq', value:'<agent-id>'} to eventConditions. Keep it as is only if every agent should run it.");
    }

    const named = conditions.filter(isAgentCondition).flatMap((c) => (c.operator === 'eq' ? [c.value] : c.value));
    for (const id of new Set(named)) {
      if (id !== 'default' && !agentIds.has(id)) {
        add('warn', 'agent_not_found', `The rule names agent ${id}, which the partner does not have.`, 'Use the id of an existing agent, or delete the rule.', { agentId: id });
      }
    }
    const dupes = [...new Set(named.filter((id, i) => named.indexOf(id) !== i))];
    if (dupes.length) {
      add('info', 'duplicate_agent_ids', `The agent id ${dupes.join(', ')} appears more than once in the rule's agent conditions.`, 'List each agent id once.');
    }

    if (action.actionType === 'triggerInsightSettingsKai') {
      const ids = Array.isArray(action.insightSettingsIds) ? action.insightSettingsIds : [];
      if (ids.length > MAX_INSIGHT_SETTINGS_PER_RULE) {
        add('error', 'too_many_insight_settings', `insightSettingsIds has ${ids.length} ids. The limit is ${MAX_INSIGHT_SETTINGS_PER_RULE}.`, `Keep at most ${MAX_INSIGHT_SETTINGS_PER_RULE} ids per rule, and split the rest into a second rule.`);
      }
      for (const id of ids) {
        const s = settingsById.get(id);
        if (!s) add('warn', 'insight_setting_missing', `Insight setting ${id} does not exist, so it is skipped.`, 'Remove the id from insightSettingsIds, or create the insight setting again.');
        else if (s.status === 'disabled') add('warn', 'insight_setting_disabled', `Insight setting ${id} (${s.key}) is disabled, so it is skipped.`, "Run insightSettings.update(id, {status:'active'}, ks), or remove the id from the rule.");
      }
    }

    if (action.actionType === 'triggerDtcKai' && ctx.intellects) {
      for (const id of scope) {
        const intellect = ctx.intellects[id];
        if (!intellect) continue;
        const forms = intellect.user_properties_forms;
        if (!Array.isArray(forms) || forms.length === 0) {
          add('warn', 'dtc_without_forms', `Agent ${id} has an intellect with no user_properties_forms, so triggerDtcKai is skipped.`, 'Set user_properties_forms on the intellect, or remove the rule.', { agentId: id });
        }
      }
    }

    if (action.actionType !== 'sendInsightEmail') continue;

    if (rule.eventType === 'session_ended') {
      add('error', 'email_on_session_ended', 'sendInsightEmail only fires on analysis_updated, so on session_ended it does nothing.', "Change eventType to 'analysis_updated'.");
    }
    const keyed = changedKeysFilter(conditions);
    if (rule.eventType === 'analysis_updated' && !keyed) {
      add('warn', 'email_unfiltered', 'The rule has no changed_keys filter, so it sends on every analysis update.',
        "Add {field:'changed_keys', operator:'has_all', value:['SUMMARY', ...]} to eventConditions. Keep it as is only if you want every update.");
    }

    const produced = producedKeys(scope);
    if (rule.eventType === 'analysis_updated' && keyed && produced) {
      const waits = keyed.value;
      const missing = keyed.operator === 'has_all' ? waits.filter((k) => !produced.has(k)) : (waits.some((k) => produced.has(k)) ? [] : waits);
      if (missing.length) {
        add('warn', 'changed_keys_unproduced', `changed_keys ${keyed.operator === 'has_all' ? 'waits for' : 'waits for any of'} ${missing.join(', ')}, but no active rule on these agents writes ${missing.length > 1 ? 'them' : 'it'}. The email never sends.`,
          'Add an insight setting with that key to a triggerInsightSettingsKai rule on the same agents, or change the filter. Keys are case-sensitive.');
      }
    }

    if (action.templateId !== undefined && templatesById) {
      const t = templatesById.get(action.templateId);
      if (!t || t.status === 'deleted') {
        add('error', 'template_missing_or_deleted', `Template ${action.templateId} ${t ? 'is deleted' : 'does not exist'}, so the rule silently stops sending.`, 'Point templateId at an existing template, or use a presetType.');
      } else if (produced) {
        const params = t.msgParamsMap && typeof t.msgParamsMap === 'object' ? t.msgParamsMap : {};
        const needs = Object.entries(params).filter(([name, p]) => p?.type === 'String' && !AUTO_TOKENS.has(name)).map(([name]) => name);
        const missing = needs.filter((k) => !produced.has(k));
        if (missing.length) {
          add('warn', 'template_tokens_unproduced', `Template ${action.templateId} needs ${missing.join(', ')}, but no active rule on these agents writes ${missing.length > 1 ? 'them' : 'it'}. The send is skipped.`,
            'Add insight settings with those keys to a triggerInsightSettingsKai rule on the same agents. Keys are case-sensitive.');
        }
      }
    } else if (action.presetType === 'conversationInsightExample' && produced) {
      const missing = PRESET_KEYS.filter((k) => !produced.has(k));
      if (missing.length) {
        add('warn', 'template_tokens_unproduced', `The conversationInsightExample preset needs ${PRESET_KEYS.join(', ')}, but no active rule on these agents writes ${missing.join(', ')}. The send is skipped.`,
          'Add insight settings with those keys to a triggerInsightSettingsKai rule on the same agents. Keys are case-sensitive.');
      }
    }
  }
  return findings;
}
