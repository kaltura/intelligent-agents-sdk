/**
 * Server-side: email a human the moment a conversation's analysis is ready
 * — zero polling, entirely server-driven.
 *
 * What this shows, against the real API:
 *   1. Discover what's available: listObjects/listEvents/describeFields —
 *      the same calls a no-code rule-editor UI would make.
 *   2. Create a rule: on analysis_updated, email a human using the
 *      zero-setup 'conversationInsightExample' preset.
 *   3. Dry-run the rule with match() — instant, synthetic, no real
 *      thread needed. This is how you verify wiring before a real
 *      conversation ever happens.
 *   4. Clean up the rule.
 *
 * Every session already gets a SUMMARY for free from an always-on system
 * preset (see the guide's "four action types" section) — no rule of your
 * own required for that. The email preset used here also expects TOPIC and
 * CUSTOM; if your app wants those in the notification, write them yourself
 * with `mgmt.threads.setAnalysis()` once you've decided a conversation is
 * worth flagging — that write itself fires the analysis_updated event this
 * rule reacts to.
 *
 * Real analysis_updated events only fire via the backend's own idle-session
 * scan and app-driven writes (there's no on-demand trigger), so this
 * example proves the rule is wired correctly with match() rather than
 * waiting for one. See docs/lifecycle/recipes.md for the full walkthrough.
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

let emailRule;
try {
  // 2. Email a human once analysis lands. The preset's template needs
  // SUMMARY/TOPIC/CUSTOM present on the thread — AGENTNAME/CTAURL/USER are
  // filled in automatically. eventConditions constrains the send to the
  // update that actually completes that set — without it, the rule would
  // also fire (and re-send) on any later, unrelated analysis_updated event
  // on the same thread.
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

  // 3. Dry-run — proves the rule is wired correctly without waiting for a
  // real analysis update. matchedRules[] can be a flat list of rules OR a
  // grouped entry ({isGrouped:true, rules:[...]}) — the system SUMMARY
  // preset and a partner rule on the same event/objectType merge into one
  // group, so a naive .map(r => r.id) only ever sees the group's key and
  // never actually checks that our own rule matched.
  const flattenMatchedRuleIds = (matchedRules) => matchedRules.flatMap((entry) => (entry.isGrouped ? entry.rules.map((r) => r.id) : [entry.id]));

  const syntheticObject = { agent_id: 'demo-agent', thread_id: 'demo-thread', user_id: 'demo-user' };
  const analysisUpdatedMatch = await kaltura.lifecycle.match(
    'thread', 'analysis_updated',
    { object: syntheticObject, changed_keys: ['SUMMARY', 'TOPIC', 'CUSTOM'] },
    admin,
  );
  const analysisUpdatedIds = flattenMatchedRuleIds(analysisUpdatedMatch.matchedRules);
  console.log('analysis_updated would match rule ids:', analysisUpdatedIds);
  if (!analysisUpdatedIds.includes(emailRule.id)) throw new Error(`Dry run did not match the email rule (${emailRule.id}) — check eventConditions/changed_keys.`);
} finally {
  // 4. Clean up — lifecycle rules have no in-use scan, so delete is immediate.
  if (emailRule) {
    try { await kaltura.lifecycle.delete(emailRule.id, admin, { confirmPermanent: true }); console.log('Cleaned up email rule:', emailRule.id); }
    catch (err) { console.error('Failed to clean up email rule', emailRule.id, '— delete manually via kaltura.lifecycle.delete().', err); }
  }
}
