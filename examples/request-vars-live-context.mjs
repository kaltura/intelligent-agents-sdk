/**
 * Server-side: stream live application state to an agent with request
 * variables — the one context channel that works on every transport.
 *
 * What this shows, each turn against the real API:
 *   1. Seed variables on turn 1 ({{counter}} renders in the prompt).
 *   2. Send NOTHING on turn 2 — the values persist for the whole thread.
 *   3. Update one key on turn 3 — the server merges, other keys survive.
 *   4. Stream a large page_context JSON blob (what the user is looking at)
 *      through the ready-made PAGE_CONTEXT_PROMPT block — the exact channel
 *      the browser SDK's setDynamicPrompt() uses.
 *   5. Start a fresh thread — everything is gone (per-thread, not per-config).
 *
 * Run: AGENTIC_PARTNER_ID=… AGENTIC_ADMIN_SECRET=… node examples/request-vars-live-context.mjs
 *
 * NOTE (dev-local path): the import below resolves against the repo's src/ tree.
 * npm consumers should instead import from '@kaltura/intelligent-agents/management'.
 */
import { Management, lintPrompts, PAGE_CONTEXT_PROMPT } from '../src/management/index.js';

const partnerId = process.env.AGENTIC_PARTNER_ID;
const adminSecret = process.env.AGENTIC_ADMIN_SECRET;
if (!partnerId || !adminSecret) { console.error('Set AGENTIC_PARTNER_ID + AGENTIC_ADMIN_SECRET'); process.exit(2); }

const kaltura = new Management({ partnerId, adminSecret });
const admin = await kaltura.sessions.createAdminToken();

// Two client-fed sections: the ready-made page-context block, plus a custom
// {{counter}} slot. Lint before provisioning — it catches a referenced
// variable with the gate off (the classic silent-empty-turn misconfig).
const prompts = [
  { key: 'name', label: 'name', headerTemplate: 'Your name is:', type: 'custom', value: 'Context Demo' },
  PAGE_CONTEXT_PROMPT,
  { key: 'counter', label: 'counter', headerTemplate: 'Live counter (authoritative, may be empty):', type: 'custom', value: '{{counter}}' },
  { key: 'rules', label: 'rules', headerTemplate: 'Rules:', type: 'custom',
    value: 'When asked for the counter, answer with just its current value, or EMPTY if the section is empty. When asked about an item on the page, answer with just that item\'s status from the live page context.' },
];
const lint = lintPrompts(prompts, { allowClientVariables: true, knownVars: ['counter', 'page_context'] });
if (!lint.ok) { console.error('Prompt lint failed:', lint.findings); process.exit(1); }

const intellect = await kaltura.intellects.add({
  type: 'internal',
  status: 2,
  allow_client_variables: true, // required — without it every request_vars turn returns empty
  prompts,
  capabilities: { avatar: 'on', avatar_filler: 'off', use_knowledge_base: 'off' },
}, admin);
console.log('Provisioned intellect:', intellect.id);

try {
  const ask = 'What is the counter? Just the value, or EMPTY.';

  // 1. Seed. request_vars values must be strings.
  const t1 = await kaltura.converseOnce(intellect.id, ask, { request_vars: { counter: '41', plan: 'gold' } });
  console.log('turn 1 (seed counter=41):', t1.text);

  // 2. Same thread, no vars sent — persisted server-side.
  const t2 = await kaltura.converseOnce(intellect.id, ask, { threadId: t1.threadId });
  console.log('turn 2 (nothing sent):  ', t2.text);

  // 3. Merge: update counter only; plan (and page_context, later) survive.
  const t3 = await kaltura.converseOnce(intellect.id, ask, { threadId: t1.threadId, request_vars: { counter: '55' } });
  console.log('turn 3 (counter=55):    ', t3.text);

  // 4. Large structured context — same channel setDynamicPrompt() uses in the
  //    browser. Tens of KB is fine; it persists and merges like any other var.
  const pageContext = JSON.stringify({
    page: '/orders/8841',
    order: { id: 8841, status: 'PACKED', eta: '2026-08-28' },
    lineItems: Array.from({ length: 200 }, (_, i) => ({ sku: `SKU-${i}`, qty: 1, status: i === 137 ? 'BACKORDERED' : 'in-stock' })),
  });
  const t4 = await kaltura.converseOnce(intellect.id,
    'What is the status of line item SKU-137 on this page? Just the status.',
    { threadId: t1.threadId, request_vars: { page_context: pageContext } });
  console.log(`turn 4 (${pageContext.length} B page_context):`, t4.text);

  // 5. Fresh thread — clean slate.
  const t5 = await kaltura.converseOnce(intellect.id, ask, {});
  console.log('turn 5 (new thread):    ', t5.text);
} finally {
  await kaltura.intellects.delete(intellect.id, admin, { confirmPermanent: true });
  console.log('Cleaned up intellect:', intellect.id);
}
