/**
 * Server-side: auto-summarize every conversation and email a human when
 * that summary is ready — zero polling, entirely server-driven.
 *
 * What this shows, against the real API:
 *   1. Discover what's available: listObjects/listEvents/describeFields —
 *      the same calls a no-code rule-editor UI would make.
 *   2. Create rule A: on session_ended, extract TOPIC + CUSTOM. SUMMARY
 *      (the third key the built-in email preset needs) isn't requested here
 *      — every session already gets one for free from the always-on system
 *      preset, and asking for your own would be silently overridden — see
 *      the guide's "four action types" section.
 *   3. Create rule B: on analysis_updated, email a human using the
 *      zero-setup 'conversationInsightExample' preset.
 *   4. Dry-run both rules with match() — instant, synthetic, no real
 *      thread needed. This is how you verify wiring before a real
 *      conversation ever happens.
 *   5. Clean up both rules.
 *
 * Real session_ended/analysis_updated events only fire via the backend's
 * own idle-session scan (there's no on-demand trigger), so this example
 * proves the rules are wired correctly with match() rather than waiting
 * for one. See docs/lifecycle/recipes.md for the full walkthrough.
 *
 * Run: AGENTIC_PARTNER_ID=… AGENTIC_ADMIN_SECRET=… node examples/lifecycle-insights-and-email.mjs
 *
 * NOTE (dev-local path): the import below resolves against the repo's src/ tree.
 * npm consumers should instead import from '@kaltura/intelligent-agents/management'.
 */
import { Management } from '../src/management/index.js';

const partnerId = process.env.AGENTIC_PARTNER_ID;
const adminSecret = process.env.AGENTIC_ADMIN_SECRET;
if (!partnerId || !adminSecret) { console.error('Set AGENTIC_PARTNER_ID + AGENTIC_ADMIN_SECRET'); process.exit(2); }

// Replace with a real Kaltura user id to actually receive mail — recipients
// are resolved as Kaltura user ids, not raw email addresses (see the guide).
const recipientUserId = process.env.DEMO_RECIPIENT_USER_ID || 'demo-support-lead';

const kaltura = new Management({ partnerId, adminSecret });
const admin = await kaltura.sessions.createAdminToken();

// 1. Discovery — what a no-code rule-editor UI would show in its dropdowns.
const objectTypes = await kaltura.lifecycle.listObjects(admin);
console.log('Object types:', objectTypes);
const events = await kaltura.lifecycle.listEvents('thread', admin);
console.log('Events for "thread":', events);
const fields = await kaltura.lifecycle.describeFields('thread', 'session_ended', admin);
console.log('Filterable fields for session_ended:', fields);

let summaryRule;
let emailRule;
try {
  // 2. Rule A: extract TOPIC + CUSTOM the instant a session ends. CUSTOM
  // isn't a built-in key (only SUMMARY/SENTIMENT/TOPIC are), so it needs its
  // own prompt. valueType is required on every insight. SUMMARY is
  // deliberately not requested here — every session already gets one for
  // free from the always-on system preset, and it merges into this same
  // batch automatically.
  summaryRule = await kaltura.lifecycle.create({
    name: 'Demo — summarize on session end',
    systemName: `demo_recipe_summary_${Date.now()}`,
    eventType: 'session_ended',
    objectType: 'thread',
    action: {
      actionType: 'triggerInsight',
      insights: [
        { insightKey: 'TOPIC', valueType: 'string' },
        { insightKey: 'CUSTOM', valueType: 'string', prompt: 'One actionable next step for the support team, or "none".' },
      ],
    },
  }, admin);
  console.log('Created summary rule:', summaryRule.id);

  // 3. Rule B: email a human once that analysis lands. The preset's
  // template needs exactly SUMMARY/TOPIC/CUSTOM from rule A above —
  // AGENTNAME/CTAURL/USER are filled in automatically. eventConditions
  // constrains the send to the update that actually completes that set —
  // without it, the rule would also fire (and re-send) on any later,
  // unrelated analysis_updated event on the same thread.
  emailRule = await kaltura.lifecycle.create({
    name: 'Demo — email support lead on analysis update',
    systemName: `demo_recipe_email_${Date.now()}`,
    eventType: 'analysis_updated',
    objectType: 'thread',
    eventConditions: [{ field: 'changed_keys', operator: 'has_all', value: ['SUMMARY', 'TOPIC', 'CUSTOM'] }],
    action: {
      actionType: 'sendInsightEmail',
      recipients: [recipientUserId],
      presetType: 'conversationInsightExample',
    },
  }, admin);
  console.log('Created email rule:', emailRule.id);

  // 4. Dry-run both — proves the rules are wired correctly without waiting
  // for a real conversation to end. matchedRules[] can be a flat list of
  // rules OR a grouped entry ({isGrouped:true, rules:[...]}) — the system
  // preset and a partner rule on the same event/objectType merge into one
  // group, so a naive .map(r => r.id) only ever sees the group's key and
  // never actually checks that our own rule matched.
  const flattenMatchedRuleIds = (matchedRules) => matchedRules.flatMap((entry) => (entry.isGrouped ? entry.rules.map((r) => r.id) : [entry.id]));

  const syntheticObject = { agent_id: 'demo-agent', thread_id: 'demo-thread', user_id: 'demo-user' };
  const sessionEndedMatch = await kaltura.lifecycle.match('thread', 'session_ended', { object: syntheticObject }, admin);
  const sessionEndedIds = flattenMatchedRuleIds(sessionEndedMatch.matchedRules);
  console.log('session_ended would match rule ids:', sessionEndedIds);
  if (!sessionEndedIds.includes(summaryRule.id)) throw new Error(`Dry run did not match the summary rule (${summaryRule.id}) — check eventType/objectType.`);

  const analysisUpdatedMatch = await kaltura.lifecycle.match(
    'thread', 'analysis_updated',
    { object: syntheticObject, changed_keys: ['SUMMARY', 'TOPIC', 'CUSTOM'] },
    admin,
  );
  const analysisUpdatedIds = flattenMatchedRuleIds(analysisUpdatedMatch.matchedRules);
  console.log('analysis_updated would match rule ids:', analysisUpdatedIds);
  if (!analysisUpdatedIds.includes(emailRule.id)) throw new Error(`Dry run did not match the email rule (${emailRule.id}) — check eventConditions/changed_keys.`);
} finally {
  // 5. Clean up — lifecycle rules have no in-use scan, so delete is immediate.
  // Both deletions are attempted independently: if emailRule fails to delete,
  // summaryRule (a second live partner-wide rule) must still be cleaned up —
  // not skipped because an earlier delete in the same block threw.
  const cleanupErrors = [];
  if (emailRule) {
    try { await kaltura.lifecycle.delete(emailRule.id, admin, { confirmPermanent: true }); console.log('Cleaned up email rule:', emailRule.id); }
    catch (err) { cleanupErrors.push(err); }
  }
  if (summaryRule) {
    try { await kaltura.lifecycle.delete(summaryRule.id, admin, { confirmPermanent: true }); console.log('Cleaned up summary rule:', summaryRule.id); }
    catch (err) { cleanupErrors.push(err); }
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `${cleanupErrors.length} lifecycle rule(s) failed to clean up — delete manually via kaltura.lifecycle.delete().`);
}
