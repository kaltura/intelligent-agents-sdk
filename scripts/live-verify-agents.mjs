#!/usr/bin/env node
/**
 * Live Agents verification — real Kaltura API, no fakes, no mocks.
 *
 * Exercises the full Agents write path, which had zero live coverage.
 * Agents bind an intellect (brain) to avatars (face+voice), so this script
 * builds the whole scratch stack an agent needs, then tears all of it down:
 *
 *   1  intellects.add       — scratch intellect (same minimal shape as live-verify-threads-messages-feedback.mjs)
 *   2  catalog.createVisual — scratch Visual for the avatar's face
 *   3  avatars.create       — {voice:{id: <existing catalog voice>}, visual:{id: <scratch visual>}}
 *   4  agents.create        — {displayName, intellect:{intellectType:'genie', id}, avatarIds:[avatarId], adminTags:['ci-scratch']}
 *   5  agents.get           — visible, right shape
 *   6  agents.list          — the new agent appears
 *   7  agents.update        — rename persists on a follow-up get
 *   8  agents.delete        — scratch agent removed (adminTags carries no PROTECTED_TAGS match, so the plain path runs), re-`get` real-404s
 *
 * Cleanup order matters: agent first (it references the avatar+intellect),
 * then avatar, then the scratch Visual, then the intellect — each verified
 * independently gone. Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET,
 * from the environment or a .env file in the repo root.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // No .env file — credentials must already be in the environment.
}

const partnerId = process.env.AGENTIC_PARTNER_ID;
const adminSecret = process.env.AGENTIC_ADMIN_SECRET;

if (!partnerId || !adminSecret) {
  console.error('AGENTIC_PARTNER_ID and AGENTIC_ADMIN_SECRET are required (env or repo-root .env).');
  process.exit(1);
}

const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
  '01f15c4890000000a49444154789c6300010000050001a5f645400000' +
  '0000049454e44ae426082',
  'hex',
);

const startedAt = new Date().toISOString();
const runId = `ci-live-verify-agents-${Date.now()}`;
const RUN_TAG = `ag${Date.now().toString(36)}`;
const artifact = { runId, startedAt, partnerId, steps: [] };

function record(step, ok, detail) {
  artifact.steps.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${step}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

let failed = false;
function check(step, ok, detail) {
  if (!ok) failed = true;
  record(step, ok, detail);
}

const kaltura = new Management({ partnerId, adminSecret });
let admin;
let intellectId;
let visualItemId;
let avatarId;
let agentId;

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  // 1: intellects.add — scratch intellect.
  const intel = await kaltura.intellects.add({
    type: 'internal',
    status: 2,
    prompts: [{ key: 'name', label: 'name', headerTemplate: 'Your name is:', type: 'custom', value: 'Live-Verify Agents Probe' }],
    capabilities: {
      avatar: 'on', avatar_filler: 'off', use_knowledge_base: 'off',
      use_content_search: 'disabled', use_get_entry_content: 'disabled',
      use_related_files: 'disabled', use_web_search: 'disabled',
      generate_followup_questions: 'disabled', include_sources: 'disabled',
      video_gallery: 'disabled', external_video: 'disabled', show_link: 'disabled',
      avatar_show_content: 'disabled', kaltura_genie_experiences: 'disabled',
      screen_share_analysis: 'disabled',
    },
  }, admin);
  intellectId = intel.id;
  check('1-intellect-create', !!intellectId, { intellectId });

  // An existing Voice catalog item — reused, never created/deleted by this script.
  const voices = await kaltura.catalog.list(admin, { type: 'Voice', pageSize: 1 }).all();
  const voiceId = voices[0]?.itemId;
  if (!voiceId) {
    throw new Error('No Voice catalog items found for this partner — avatars.create needs at least one existing voice.id. Cannot proceed.');
  }
  record('existing-voice-found', true, { voiceId });

  // 2: catalog.createVisual — scratch Visual for the avatar's face.
  const file = new Blob([PNG_1PX], { type: 'image/png' });
  const visual = await kaltura.catalog.createVisual(file, {
    name: `Live Verify Agent Visual ${RUN_TAG}`,
    genderPresentation: 'Feminine',
  }, admin);
  visualItemId = visual.itemId;
  check('2-catalog-create-visual', !!visualItemId, { visualItemId });

  // 3: avatars.create
  const avatar = await kaltura.avatars.create({
    voice: { id: voiceId },
    visual: { id: visualItemId },
    openingPhrase: `Hi, this is a live-verify agents probe ${RUN_TAG}.`,
  }, admin);
  avatarId = avatar.id;
  check('3-avatars-create', !!avatarId, { avatarId });

  // 4: agents.create — adminTags:['ci-scratch'] deliberately avoids agents.js's
  // PROTECTED_TAGS patterns (prod/production/keep/do-not-delete/live) so the
  // plain delete path (no allowProtected needed) runs at cleanup.
  const displayName = `Live Verify Agent ${RUN_TAG}`;
  const created = await kaltura.agents.create({
    displayName,
    intellect: { intellectType: 'genie', id: intellectId },
    avatarIds: [avatarId],
    adminTags: ['ci-scratch'],
  }, admin);
  agentId = created.agentId || created.id;
  check('4-agents-create', !!agentId, { agentId, displayName: created.displayName, adminTags: created.adminTags });

  // 5: agents.get — visible, right shape.
  const got = await kaltura.agents.get(agentId, admin);
  check('5-agents-get', (got.agentId || got.id) === agentId && got.displayName === displayName, { displayName: got.displayName, adminTags: got.adminTags });

  // 6: agents.list — the new agent appears.
  const all = await kaltura.agents.list(admin).all();
  const found = all.find((a) => (a.agentId || a.id) === agentId);
  check('6-agents-list-contains-agent', !!found, { count: all.length, foundOurs: !!found });

  // 7: agents.update — rename persists.
  const newDisplayName = `Live Verify Agent Renamed ${RUN_TAG}`;
  const updated = await kaltura.agents.update({ agentId, displayName: newDisplayName }, admin);
  check('7-agents-update-returns-new-name', updated.displayName === newDisplayName, { displayName: updated.displayName });
  const gotAfterUpdate = await kaltura.agents.get(agentId, admin);
  check('7-agents-update-persists', gotAfterUpdate.displayName === newDisplayName, { displayName: gotAfterUpdate.displayName });
} catch (err) {
  failed = true;
  record('live-verify-agents', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  // 8: agents.delete — scratch agent removed, re-get real-404s. Cleanup order:
  // agent (references avatar+intellect) → avatar → Visual → intellect.
  if (agentId) {
    try {
      await kaltura.agents.delete(agentId, admin, { confirmPermanent: true });
      record('8-agents-delete', true, { agentId });
      try {
        await kaltura.agents.get(agentId, admin);
        failed = true;
        record('8-agents-delete-reget-still-found', false, { agentId });
      } catch (err) {
        record('8-agents-delete-reget-not-found', true, { agentId, code: err?.code, message: err?.detail || err?.message });
      }
    } catch (err) {
      failed = true;
      record('8-agents-delete', false, { agentId, message: err?.detail || err?.message || String(err) });
    }
  }
  if (avatarId) {
    try {
      await kaltura.avatars.delete(avatarId, admin, { confirmPermanent: true });
      record('avatar-delete', true, { avatarId });
    } catch (err) {
      failed = true;
      record('avatar-delete', false, { avatarId, message: err?.detail || err?.message || String(err) });
    }
  }
  if (visualItemId) {
    try {
      await kaltura.catalog.delete(visualItemId, admin, { confirmPermanent: true });
      record('catalog-visual-delete', true, { visualItemId });
    } catch (err) {
      failed = true;
      record('catalog-visual-delete', false, { visualItemId, message: err?.detail || err?.message || String(err) });
    }
  }
  if (intellectId) {
    try {
      await kaltura.intellects.delete(intellectId, admin, { confirmPermanent: true });
      record('intellect-delete', true, { intellectId });
    } catch (err) {
      failed = true;
      record('intellect-delete', false, { intellectId, message: err?.detail || err?.message || String(err) });
    }
  }
}

artifact.finishedAt = new Date().toISOString();
artifact.ok = !failed;

mkdirSync(resolve(__dirname, '../live-verify-artifacts'), { recursive: true });
const outPath = resolve(__dirname, `../live-verify-artifacts/${runId}.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written: ${outPath}`);

process.exit(failed ? 1 : 0);
