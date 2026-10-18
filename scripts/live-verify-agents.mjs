#!/usr/bin/env node
/**
 * Live Agents verification — real Kaltura API, no fakes, no mocks.
 *
 * Exercises the full Agents write path.
 * Agents bind an intellect (brain) to avatars (face+voice), so this script
 * builds the whole scratch stack an agent needs, then tears all of it down:
 *
 *   1  intellects.add       — scratch intellect (same minimal shape as live-verify-threads-messages-feedback.mjs)
 *   2  catalog.createVisual — scratch Visual for the avatar's face
 *   3  avatars.create       — {voice:{id: <existing catalog voice>}, visual:{id: <scratch visual>}}
 *   4  agents.create        — {displayName, intellect:{intellectType:'genie', id}, avatarIds:[avatarId], adminTags:['ci-scratch']}
 *   5  agents.get           — visible, right shape
 *   6  agents.list          — the new agent appears
 *   6b a second scratch agent with the same tags, created after a pause
 *   7  agents.update        — rename persists on a follow-up get (a pause first, so A is the newest update)
 *   7b agents.list orderBy  — -createdAt gives [B, A], -updatedAt gives [A, B]; the other orders are logged
 *   7c agents.list orderBy  — an unknown value rejects with bad_request listing the four values
 *   7d agents asr           — the default is {language:'en', provider:'kaltura'}, an update persists,
 *      and a provider or language outside the accepted values rejects with bad_request
 *   8  agents.delete        — scratch agent removed (adminTags carries no PROTECTED_TAGS match, so the plain path runs), re-`get` real-404s
 *
 * Cleanup order matters: agent first (it references the avatar+intellect),
 * then avatar, then the scratch Visual, then the intellect — each verified
 * independently gone. Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET,
 * from the environment or a .env file in the repo root.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';
import { resolveTarget } from './lib/target.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const target = resolveTarget(process.env.TARGET ?? 'prod');
const { partnerId } = target;

const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
  '01f15c4890000000a49444154789c6300010000050001a5f645400000' +
  '0000049454e44ae426082',
  'hex',
);

const startedAt = new Date().toISOString();
const runId = `ci-live-verify-agents-${Date.now()}`;
const RUN_TAG = `ag${Date.now().toString(36)}`;
const ORD = `ord${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const kaltura = new Management(target);
let admin;
let intellectId;
let visualItemId;
let avatarId;
let agentId;
let agentIdB;

try {
  admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
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
    adminTags: ['ci-scratch', ORD],
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

  // 6b: a second agent with the same tags, created after a pause so the two creation times differ.
  await sleep(1100);
  const createdB = await kaltura.agents.create({
    displayName: `Live Verify Agent B ${RUN_TAG}`,
    intellect: { intellectType: 'genie', id: intellectId },
    avatarIds: [avatarId],
    adminTags: ['ci-scratch', ORD],
  }, admin);
  agentIdB = createdB.agentId || createdB.id;
  check('6b-agents-create-second', !!agentIdB, { agentIdB });

  // 7: agents.update — rename persists. The pause makes A the newest update.
  await sleep(1100);
  const newDisplayName = `Live Verify Agent Renamed ${RUN_TAG}`;
  const updated = await kaltura.agents.update({ agentId, displayName: newDisplayName }, admin);
  check('7-agents-update-returns-new-name', updated.displayName === newDisplayName, { displayName: updated.displayName });
  const gotAfterUpdate = await kaltura.agents.get(agentId, admin);
  check('7-agents-update-persists', gotAfterUpdate.displayName === newDisplayName, { displayName: gotAfterUpdate.displayName });

  // 7b: orderBy. The two newest-first orders are asserted. The other two are logged only.
  const idsFor = async (orderBy) => (await kaltura.agents.list(admin, { filter: { adminTagsIn: [ORD] }, ...(orderBy ? { orderBy } : {}) }).all()).map((a) => a.agentId || a.id);
  const sameIds = (got, want) => got.length === want.length && got.every((id, i) => id === want[i]);
  const byCreated = await idsFor('-createdAt');
  check('7b-list-orderBy-newest-created-first', sameIds(byCreated, [agentIdB, agentId]), { got: byCreated });
  const byUpdated = await idsFor('-updatedAt');
  check('7b-list-orderBy-newest-updated-first', sameIds(byUpdated, [agentId, agentIdB]), { got: byUpdated });
  record('7b-list-orderBy-other-orders', true, { plusCreatedAt: await idsFor('+createdAt'), plusUpdatedAt: await idsFor('+updatedAt'), none: await idsFor() });

  // 7c: an unknown orderBy value is rejected and the error lists the four values.
  try {
    await kaltura.agents.list(admin, { orderBy: 'updatedAt' });
    check('7c-list-bad-orderBy', false, { message: 'expected a rejection' });
  } catch (err) {
    check('7c-list-bad-orderBy', err?.code === 'bad_request' && err?.status === 400 && ['+createdAt', '-createdAt', '+updatedAt', '-updatedAt'].every((v) => err.detail.includes(v)), { code: err?.code, status: err?.status, detail: err?.detail });
  }

  // 7d: agent asr. The default is {language:'en', provider:'kaltura'}. An update persists.
  const asrDefault = (await kaltura.agents.get(agentId, admin)).asr;
  check('7d-asr-default', asrDefault?.language === 'en' && asrDefault?.provider === 'kaltura', { asr: asrDefault });
  await kaltura.agents.update({ agentId, asr: { language: 'he', provider: 'kaltura' } }, admin);
  const asrSet = (await kaltura.agents.get(agentId, admin)).asr;
  check('7d-asr-update-persists', asrSet?.language === 'he' && asrSet?.provider === 'kaltura', { asr: asrSet });
  for (const [name, asr, expected] of [
    ['7d-asr-bad-provider', { language: 'en', provider: 'bogus' }, ['kaltura', 'kaltura-hebrew', 'elevenlabs', 'soniox']],
    ['7d-asr-bad-language', { language: 'zz', provider: 'kaltura' }, []],
  ]) {
    try {
      await kaltura.agents.update({ agentId, asr }, admin);
      check(name, false, { message: 'expected a rejection' });
    } catch (err) {
      check(name, err?.code === 'bad_request' && err?.status === 400 && expected.every((v) => err.detail.includes(v)), { code: err?.code, status: err?.status, detail: err?.detail });
    }
  }
} catch (err) {
  failed = true;
  record('live-verify-agents', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  // 8: agents.delete — scratch agent removed, re-get real-404s. Cleanup order:
  // agent (references avatar+intellect) → avatar → Visual → intellect.
  if (agentIdB) {
    try {
      await kaltura.agents.delete(agentIdB, admin, { confirmPermanent: true });
      record('8-agents-delete-second', true, { agentIdB });
      try {
        await kaltura.agents.get(agentIdB, admin);
        failed = true;
        record('8-agents-delete-second-reget-still-found', false, { agentIdB });
      } catch (err) {
        record('8-agents-delete-second-reget-not-found', true, { agentIdB, code: err?.code });
      }
    } catch (err) {
      failed = true;
      record('8-agents-delete-second', false, { agentIdB, message: err?.detail || err?.message || String(err) });
    }
  }
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
