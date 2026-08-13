/**
 * Server-side: provision an agent from a brief, then mint a short-lived,
 * entitlement-ON conversation token to hand a browser. The admin secret never
 * leaves this process. Run: AGENTIC_PARTNER_ID=… AGENTIC_ADMIN_SECRET=… node examples/server-token.mjs "A friendly yoga receptionist"
 *
 * NOTE (dev-local path): the import below resolves against the repo's src/ tree.
 * npm consumers should instead import from '@kaltura/intelligent-agents/management'.
 */
import { Management } from '../src/management/index.js';

const partnerId = process.env.AGENTIC_PARTNER_ID;
const adminSecret = process.env.AGENTIC_ADMIN_SECRET;
if (!partnerId || !adminSecret) { console.error('Set AGENTIC_PARTNER_ID + AGENTIC_ADMIN_SECRET'); process.exit(2); }

const brief = process.argv[2] || 'A friendly technical-support agent for a video platform';
const kaltura = new Management({ partnerId, adminSecret });

const admin = await kaltura.sessions.createAdminToken();          // disableentitlement — server-only
const agent = await kaltura.provision({ brief, ks: admin.ks });   // full UC-1 factory
console.log('Provisioned:', { name: agent.name, configId: agent.configId, agentId: agent.agentId, widgetId: agent.widgetId });

// What you send the browser: a scoped, entitlement-ON token (NOT the admin KS).
const conv = await kaltura.sessions.createConversationToken({ configId: agent.configId, ttlSeconds: 3600 });
console.log('Conversation token scope:', conv.scope);             // entitlementEnforced: true

// Headless smoke test of the brain (no video):
const reply = await kaltura.conversations.send({ userMessage: 'Hello, what can you help me with?' }, conv.ks);
console.log('Agent says:', reply.text);
