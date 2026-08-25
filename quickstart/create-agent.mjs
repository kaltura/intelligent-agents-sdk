/**
 * Kaltura Agentic Avatar — quickstart
 *
 * Provisions a complete agent (brain + face + voice) from a one-line brief,
 * sends a smoke-test message, and prints the reply + all IDs you need to embed
 * or extend the agent.
 *
 * Usage:
 *   node create-agent.mjs "A friendly yoga-studio receptionist"
 *
 * Credentials are read from the environment or from a .env file in the repo root.
 * Required: AGENTIC_PARTNER_ID, AGENTIC_ADMIN_SECRET
 */

// ── Load .env from repo root if present (no dotenv dependency needed) ────────
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // No .env file — credentials must be in the environment already.
}

// ── Validate credentials ───────────────────────────────────────────────────
const partnerId = process.env.AGENTIC_PARTNER_ID;
const adminSecret = process.env.AGENTIC_ADMIN_SECRET;

if (!partnerId || !adminSecret) {
  console.error('');
  console.error('Error: AGENTIC_PARTNER_ID and AGENTIC_ADMIN_SECRET are required.');
  console.error('');
  console.error('Set them in your environment:');
  console.error('  export AGENTIC_PARTNER_ID=your_partner_id');
  console.error('  export AGENTIC_ADMIN_SECRET=your_admin_secret');
  console.error('');
  console.error('Or put them in a .env file in the repo root (one directory above quickstart/):');
  console.error('  AGENTIC_PARTNER_ID=your_partner_id');
  console.error('  AGENTIC_ADMIN_SECRET=your_admin_secret');
  console.error('');
  process.exit(1);
}

// ── Parse the brief from argv ──────────────────────────────────────────────
const brief = process.argv[2] || 'A friendly yoga-studio receptionist';

// ── SDK import ─────────────────────────────────────────────────────────────
import { Management } from '@kaltura/intelligent-agents/management';

// ── Main ───────────────────────────────────────────────────────────────────
console.log('');
console.log('Kaltura Agentic Avatar — quickstart');
console.log('────────────────────────────────────');
console.log(`Brief: "${brief}"`);
console.log(`Partner ID: ${partnerId}`);
console.log('');

const kaltura = new Management({ partnerId, adminSecret });

// Step 1: Mint an admin token (never leave the server in production)
console.log('[1/3] Minting admin token...');
let adminToken;
try {
  adminToken = await kaltura.sessions.createAdminToken();
} catch (err) {
  console.error('');
  console.error('Failed to mint admin token:', err?.detail || err?.message || err);
  console.error('');
  console.error('Check that AGENTIC_PARTNER_ID and AGENTIC_ADMIN_SECRET are correct.');
  process.exit(1);
}
console.log('      Admin token minted.');

// Step 2: Provision the agent — this creates intellect + avatar + agent in sequence.
// It takes 1–3 minutes and shows no intermediate progress, so we print a heads-up.
console.log('');
console.log('[2/3] Provisioning agent (brain + face + voice)...');
console.log('      This takes 1–3 minutes — generating profile, building intellect,');
console.log('      selecting voice/visual, creating avatar, wiring the agent...');
console.log('');

let agent;
try {
  agent = await kaltura.provision({ brief, ks: adminToken });
} catch (err) {
  console.error('');
  console.error('Provision failed:', err?.detail || err?.message || err);
  if (err?.body?.failedStep) {
    console.error('Failed at step:', err.body.failedStep);
  }
  if (err?.body?.createdSoFar) {
    const { configId, avatarId, agentId } = err.body.createdSoFar;
    console.error('');
    console.error('Partial resources were created before the failure:');
    if (configId) console.error('  Intellect (configId):', configId);
    if (avatarId) console.error('  Avatar (avatarId):', avatarId);
    if (agentId) console.error('  Agent (agentId):', agentId);
    console.error('');
    console.error('Clean them up from a Node REPL with the same Management client:');
    if (agentId) console.error(`  await kaltura.agents.delete('${agentId}', adminToken, { confirmPermanent: true });`);
    if (avatarId) console.error(`  await kaltura.avatars.delete('${avatarId}', adminToken, { confirmPermanent: true });`);
    if (configId) console.error(`  await kaltura.intellects.delete('${configId}', adminToken, { confirmPermanent: true });`);
  }
  process.exit(1);
}

const { name, configId, agentId, avatarId, widgetId } = agent;

console.log('Agent provisioned successfully!');
console.log('');
console.log('  Name:       ', name);
console.log('  configId:   ', configId);
console.log('  agentId:    ', agentId);
console.log('  avatarId:   ', avatarId);
console.log('  widgetId:   ', widgetId || '(resolving...)');
console.log('');

// Step 3: Send a smoke-test message via the headless conversation path.
// converseOnce() auto-mints a conversation token from configId — the admin
// secret never leaves this process.
console.log('[3/3] Sending smoke-test message...');
console.log('      "Hello! What can you help me with?"');
console.log('');

let reply;
try {
  reply = await kaltura.converseOnce(configId, 'Hello! What can you help me with?');
} catch (err) {
  console.error('');
  console.error('converseOnce failed:', err?.detail || err?.message || err);
  console.error('');
  console.error('The agent was created successfully — the conversation error is not fatal.');
  console.error('You can test conversation later with:');
  console.error(`  await kaltura.converseOnce('${configId}', 'Hello!');`);
  // Don't exit(1) — the agent itself is ready even if the smoke test failed.
  reply = null;
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log('────────────────────────────────────');
console.log('Done!');
console.log('');
console.log('Agent reply:');
if (reply?.text) {
  console.log('');
  console.log(' ', reply.text);
  console.log('');
} else {
  console.log('  (no reply — see error above)');
  console.log('');
}

console.log('IDs for embedding or extending this agent:');
console.log('');
console.log(`  configId:  ${configId}   — used for conversation tokens + intellect updates`);
console.log(`  agentId:   ${agentId}    — used for management (update, delete)`);
console.log(`  avatarId:  ${avatarId}   — used for avatar-session (live WebRTC video)`);
if (widgetId) {
  console.log(`  widgetId:  ${widgetId}  — used for end-user widget tokens`);
}
console.log('');

console.log('To embed a live talking avatar in a web page, see:');
console.log('  API-REFERENCE.md → Use Case 12 (Embed a live avatar)');
console.log('');

console.log('To delete this agent later (deletion is permanent, hence the confirm flag):');
console.log(`  await kaltura.agents.delete('${agentId}', adminToken, { confirmPermanent: true });`);
console.log('');
