#!/usr/bin/env node
/**
 * Create or update Juno on your own Kaltura partner. Safe to run again: it
 * reuses the ids saved in agent/agent.json and updates them in place.
 *
 *   AGENTIC_PARTNER_ID=... AGENTIC_ADMIN_SECRET=... node examples/showroom/agent/provision.mjs
 *   node --env-file=.env examples/showroom/agent/provision.mjs
 *
 *   --cleanup   delete the agent, avatar, intellect and tools listed in agent.json (explicit, separate)
 *
 * Writes agent/agent.json with ids only (git-ignored). The dev server reads it.
 */
import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management, lintPrompts, lintPersonaIdentity, findIntellectsReferencingTool } from '../../../src/management/index.js';
import {
  AGENT_SETTINGS, AVATAR_LOOKS, BASE_DIRECTIVE, OPENING_PHRASE, PERSONA_NAME, PROMPTS, TAG, intellectBody, toolConfigs,
} from './spec.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'agent.json');
const { AGENTIC_PARTNER_ID: partnerId, AGENTIC_ADMIN_SECRET: adminSecret } = process.env;
if (!partnerId || !adminSecret) { console.error('Set AGENTIC_PARTNER_ID and AGENTIC_ADMIN_SECRET.'); process.exit(2); }

const mgmt = new Management({ partnerId, adminSecret, agenticUrl: process.env.AGENTIC_URL, genieUrl: process.env.GENIE_URL, ovpUrl: process.env.OVP_URL });
const admin = await mgmt.sessions.createAdminToken({ userId: 'showroom-provision' });
const saved = JSON.parse(await readFile(OUT, 'utf8').catch(() => '{}'));
const log = (m) => console.log(`ok  ${m}`);

if (process.argv.includes('--cleanup')) {
  const confirm = { confirmPermanent: true };
  if (saved.agentId) { await mgmt.agents.delete(saved.agentId, admin, confirm); log(`deleted agent ${saved.agentId}`); }
  if (saved.avatarId) { await mgmt.avatars.delete(saved.avatarId, admin, confirm); log(`deleted avatar ${saved.avatarId}`); }
  if (saved.visualId) { await mgmt.catalog.delete(saved.visualId, admin, confirm); log(`deleted visual ${saved.visualId}`); }
  if (saved.configId) { await mgmt.intellects.delete(saved.configId, admin, confirm); log(`deleted intellect ${saved.configId}`); }
  for (const id of saved.toolIds || []) { await mgmt.tools.delete(id, admin, confirm); log(`deleted tool ${id}`); }
  await rm(OUT, { force: true });
  process.exit(0);
}

// Same checks the SDK ships, before anything is written.
const promptLint = lintPrompts(PROMPTS, { allowClientVariables: true, knownVars: ['screen', 'cart'] });
const identityLint = lintPersonaIdentity({ name: PERSONA_NAME, openingPhrase: OPENING_PHRASE, baseDirective: BASE_DIRECTIVE, prompts: PROMPTS });
for (const f of [...promptLint.findings, ...identityLint.findings]) console.warn(`warn ${f.code}: ${f.message}`);
if (!promptLint.ok || !identityLint.ok) { console.error('Lint failed. Nothing was written.'); process.exit(1); }

// 1. Tools: partner-level, matched by name.
const existing = await mgmt.tools.list(admin).all();
const toolIds = [];
for (const cfg of toolConfigs()) {
  const found = existing.find((t) => t.name === cfg.name);
  if (!found) { toolIds.push((await mgmt.tools.add(cfg, admin)).id); continue; }
  const others = (await findIntellectsReferencingTool(mgmt._ctx, found.id, admin)).filter((id) => id !== saved.configId);
  if (others.length) console.warn(`warn tool "${cfg.name}" is used by ${others.length} other intellect(s). Kept as is, not overwritten.`);
  else await mgmt.tools.update(found.id, { config: cfg }, admin);
  toolIds.push(found.id);
}
log(`${toolIds.length} tools`);

// 2. Intellect.
const body = { ...intellectBody(), tool_ids: toolIds };
let configId = saved.configId;
if (configId) await mgmt.intellects.update({ id: configId, ...body }, admin);
else configId = (await mgmt.intellects.add(body, admin)).id;
log(`intellect ${configId}`);

// 3. Avatar: Juno's own portrait as a custom visual (uploaded once), plus a preset voice picked by name.
async function preset(type, match) {
  for await (const item of mgmt.catalog.list(admin, { type, pageSize: 100 })) if (match(item.attributes?.[type.toLowerCase()] || {})) return item.itemId;
  throw new Error(`No ${type} preset matched in your catalog. Change AVATAR_LOOKS in agent/spec.mjs.`);
}
async function portraitVisual() {
  const found = saved.visualId || await preset('Visual', (v) => v.name === AVATAR_LOOKS.portrait.name).catch(() => null);
  if (found) return found;
  const file = new Blob([await readFile(join(dirname(OUT), AVATAR_LOOKS.portraitFile))], { type: 'image/jpeg' });
  return (await mgmt.catalog.createVisual(file, AVATAR_LOOKS.portrait, admin)).itemId;
}
const visualId = await portraitVisual();
let avatarId = saved.avatarId;
let replaced = null;
if (!avatarId || saved.visualId !== visualId) {
  const voiceId = await preset('Voice', (v) => v.name === AVATAR_LOOKS.voiceName);
  // No openingPhrase on the avatar: the intellect's opening_phrase owns it.
  const created = (await mgmt.avatars.create({ voice: { id: voiceId, speed: 1.0 }, visual: { id: visualId, motionControl: { speaking: 0.6, nonSpeaking: 0.2 } } }, admin)).id;
  // The agent switches to the new avatar below. The old one is deleted after that.
  replaced = avatarId;
  avatarId = created;
}
log(`avatar ${avatarId} (visual ${visualId})`);

// 4. Agent and widget id.
let agentId = saved.agentId;
if (agentId) await mgmt.agents.update({ agentId, ...AGENT_SETTINGS, avatarIds: [avatarId] }, admin);
else agentId = (await mgmt.agents.create({ ...AGENT_SETTINGS, intellect: { intellectType: 'genie', id: configId }, avatarIds: [avatarId] }, admin)).agentId;
const widgetId = saved.widgetId || (await mgmt.application.resolveWidgetId(agentId, admin)).widgetId;
log(`agent ${agentId}`);
if (replaced) { await mgmt.avatars.delete(replaced, admin, { confirmPermanent: true }); log(`removed old avatar ${replaced}`); }

await writeFile(OUT, JSON.stringify({ configId, avatarId, visualId, agentId, widgetId, toolIds, tag: TAG }, null, 2) + '\n');
console.log(`\nDone. Ids saved to ${OUT}\nRun: node --env-file=<your .env> examples/showroom/server.mjs`);
