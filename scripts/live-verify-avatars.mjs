#!/usr/bin/env node
/**
 * Live Avatars verification — real Kaltura API, no fakes, no mocks.
 *
 * `live-verify-capabilities.mjs` already covers `avatars.listTemplates`
 * (READ). This script covers the write path that still had zero live
 * coverage:
 *
 *   1  catalog.createVisual — scratch Visual (1x1 PNG), reused as this avatar's face
 *   2  avatars.create       — {voice:{id: <existing catalog voice>}, visual:{id: <scratch visual>}, openingPhrase}
 *   3  avatars.get          — visible, right shape
 *   3b avatars.list         — the new avatar appears
 *   4  avatars.update       — PATCH openingPhrase only; visual/voice untouched, persists on a follow-up get
 *   5  avatars.delete       — scratch avatar removed, re-`get` throws (avatars.get 404s as `api_exception`, not a stable code — see avatars.js)
 *   6  catalog.delete       — scratch Visual removed, re-`get` real-404s
 *
 * The voice half of the avatar is an EXISTING catalog Voice (read via
 * `catalog.list`), not a freshly cloned one: `catalog.createVoice` does a
 * real ElevenLabs clone and needs a real MP3, which is not cheap or safe to
 * do on every CI run for a throwaway resource (see live-verify-catalog.mjs).
 * If the partner has no Voice catalog items at all, this script fails fast
 * with a clear message instead of guessing an id.
 *
 * Throwaway resources only (one avatar + one Visual catalog item), full
 * cleanup in `finally`, with independent re-verification that both are truly
 * gone. Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the
 * environment or a .env file in the repo root.
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
const runId = `ci-live-verify-avatars-${Date.now()}`;
const RUN_TAG = `av${Date.now().toString(36)}`;
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
let visualItemId;
let avatarId;

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  // An existing Voice catalog item — reused, never created/deleted by this script.
  const voices = await kaltura.catalog.list(admin, { type: 'Voice', pageSize: 1 }).all();
  const voiceId = voices[0]?.itemId;
  if (!voiceId) {
    throw new Error('No Voice catalog items found for this partner — avatars.create needs at least one existing voice.id. Cannot proceed.');
  }
  record('existing-voice-found', true, { voiceId });

  // 1: catalog.createVisual — scratch Visual, this avatar's face.
  const file = new Blob([PNG_1PX], { type: 'image/png' });
  const visual = await kaltura.catalog.createVisual(file, {
    name: `Live Verify Avatar Visual ${RUN_TAG}`,
    genderPresentation: 'Masculine',
  }, admin);
  visualItemId = visual.itemId;
  check('1-catalog-create-visual', !!visualItemId, { visualItemId });

  // 2: avatars.create
  const openingPhrase = `Hi, this is a live-verify probe ${RUN_TAG}.`;
  const created = await kaltura.avatars.create({
    voice: { id: voiceId },
    visual: { id: visualItemId },
    openingPhrase,
  }, admin);
  avatarId = created.id;
  check('2-avatars-create', !!avatarId, { avatarId, voiceId: created.voice?.id, visualId: created.visual?.id, openingPhrase: created.openingPhrase });

  // 3: avatars.get — visible, right shape.
  const got = await kaltura.avatars.get(avatarId, admin);
  check('3-avatars-get', got.id === avatarId && got.openingPhrase === openingPhrase, { id: got.id, openingPhrase: got.openingPhrase });

  // 3b: avatars.list — the new avatar appears.
  const listed = await kaltura.avatars.list(admin, { pageSize: 100 }).all();
  check('3b-avatars-list', listed.some((a) => a.id === avatarId), { count: listed.length, avatarId });

  // 4: avatars.update — PATCH openingPhrase only; visual/voice untouched, persists.
  const newPhrase = `Welcome back, live-verify probe ${RUN_TAG}.`;
  const updated = await kaltura.avatars.update({ id: avatarId, openingPhrase: newPhrase }, admin);
  check('4-avatars-update-returns-new-phrase', updated.openingPhrase === newPhrase, { openingPhrase: updated.openingPhrase });
  const gotAfterUpdate = await kaltura.avatars.get(avatarId, admin);
  check('4-avatars-update-persists', gotAfterUpdate.openingPhrase === newPhrase, { openingPhrase: gotAfterUpdate.openingPhrase });
  check('4-avatars-update-preserves-visual', gotAfterUpdate.visual?.id === visualItemId, { visualId: gotAfterUpdate.visual?.id });
} catch (err) {
  failed = true;
  record('live-verify-avatars', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  // 5: avatars.delete — scratch avatar removed, re-get throws.
  if (avatarId) {
    try {
      await kaltura.avatars.delete(avatarId, admin, { confirmPermanent: true });
      record('5-avatars-delete', true, { avatarId });
      try {
        await kaltura.avatars.get(avatarId, admin);
        failed = true;
        record('5-avatars-delete-reget-still-found', false, { avatarId });
      } catch (err) {
        record('5-avatars-delete-reget-not-found', true, { avatarId, code: err?.code, message: err?.detail || err?.message });
      }
    } catch (err) {
      failed = true;
      record('5-avatars-delete', false, { avatarId, message: err?.detail || err?.message || String(err) });
    }
  }
  // 6: catalog.delete — scratch Visual removed, re-get real-404s.
  if (visualItemId) {
    try {
      await kaltura.catalog.delete(visualItemId, admin, { confirmPermanent: true });
      record('6-catalog-delete-visual', true, { visualItemId });
      try {
        await kaltura.catalog.get(visualItemId, admin);
        failed = true;
        record('6-catalog-delete-visual-reget-still-found', false, { visualItemId });
      } catch (err) {
        record('6-catalog-delete-visual-reget-not-found', true, { visualItemId, code: err?.code, message: err?.detail || err?.message });
      }
    } catch (err) {
      failed = true;
      record('6-catalog-delete-visual', false, { visualItemId, message: err?.detail || err?.message || String(err) });
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
