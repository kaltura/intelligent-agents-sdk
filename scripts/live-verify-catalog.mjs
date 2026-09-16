#!/usr/bin/env node
/**
 * Live Catalog verification — real Kaltura API, no fakes, no mocks.
 *
 * Exercises the Catalog write path, which had zero live coverage:
 *
 *   1  catalog.createVisual — upload a scratch custom Visual (1x1 PNG)
 *   2  catalog.get          — visible, right shape
 *   3  catalog.list         — filtered to Visual, the new item appears
 *   4  catalog.update       — rename persists on a follow-up get
 *   4b catalog.importVoiceFromElevenLabs — an unknown provider voiceId creates
 *      nothing server-side, so the rejection path is free to exercise live
 *   4c catalog.importVoiceFromCartesia   — same contract, same free coverage
 *   5  catalog.delete       — scratch item removed, re-`get` real-404s
 *
 * `catalog.createVoice` (a real ElevenLabs clone) is NOT exercised here: it
 * needs a real MP3 (44.1kHz, >=6s of speech) and burns real clone-provider
 * quota on every CI run for a throwaway resource — not a cheap or safe thing
 * to do on every push. Visual upload is the write path this script proves;
 * `createVoice`'s request-shaping logic (attrs validation, multipart
 * encoding) is covered by unit tests instead. Importing a real EXISTING
 * provider voice (the success path of 4b/4c) would need a real ElevenLabs/
 * Cartesia voiceId this repo doesn't have — same cost/safety tradeoff as
 * `createVoice`, so only the free, deterministic rejection path is covered
 * live; the success path's request-shaping is unit-tested.
 *
 * Throwaway resource only (one Visual catalog item), full cleanup in
 * `finally`, with independent re-verification that it is truly gone.
 * Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the
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

// A minimal valid 1x1 transparent PNG, used across the trio's scratch-visual scripts.
const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
  '01f15c4890000000a49444154789c6300010000050001a5f645400000' +
  '0000049454e44ae426082',
  'hex',
);

const startedAt = new Date().toISOString();
const runId = `ci-live-verify-catalog-${Date.now()}`;
const RUN_TAG = `cat${Date.now().toString(36)}`;
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
let itemId;

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  // 1: catalog.createVisual
  const file = new Blob([PNG_1PX], { type: 'image/png' });
  const created = await kaltura.catalog.createVisual(file, {
    name: `Live Verify Visual ${RUN_TAG}`,
    genderPresentation: 'Feminine',
  }, admin);
  itemId = created.itemId;
  check('1-catalog-create-visual', !!itemId, { itemId, adminTags: created.adminTags });

  // 2: catalog.get — visible, right shape.
  const got = await kaltura.catalog.get(itemId, admin);
  check('2-catalog-get', got.itemId === itemId && got.type === 'Visual', { itemId: got.itemId, type: got.type });

  // 3: catalog.list — filtered to Visual, the new item appears.
  const visuals = await kaltura.catalog.list(admin, { type: 'Visual' }).all();
  const found = visuals.find((v) => v.itemId === itemId);
  check('3-catalog-list-contains-item', !!found, { count: visuals.length, foundOurs: !!found });

  // 4: catalog.update — rename persists.
  const newAttrs = { name: `Live Verify Visual Renamed ${RUN_TAG}`, genderPresentation: 'Feminine' };
  const updated = await kaltura.catalog.update({ itemId, attributes: { visual: newAttrs } }, admin);
  check('4-catalog-update-returns-new-name', updated?.itemId === itemId, { itemId: updated?.itemId });
  const gotAfterUpdate = await kaltura.catalog.get(itemId, admin);
  check('4-catalog-update-persists', gotAfterUpdate?.name === newAttrs.name || gotAfterUpdate?.attributes?.visual?.name === newAttrs.name, { got: gotAfterUpdate?.name ?? gotAfterUpdate?.attributes?.visual?.name });

  // 4b/4c: importVoiceFromElevenLabs/importVoiceFromCartesia — an unknown provider
  // voiceId creates nothing server-side, so the error path is free to exercise live.
  try {
    await kaltura.catalog.importVoiceFromElevenLabs(`live-verify-nonexistent-${RUN_TAG}`, admin);
    check('4b-import-voice-elevenlabs-rejects-unknown-id', false, { message: 'expected a rejection, got a created item' });
  } catch (err) {
    check('4b-import-voice-elevenlabs-rejects-unknown-id', err?.code === 'voice_not_found_elevenlabs', { code: err?.code, message: err?.detail || err?.message });
  }
  try {
    await kaltura.catalog.importVoiceFromCartesia(`live-verify-nonexistent-${RUN_TAG}`, admin);
    check('4c-import-voice-cartesia-rejects-unknown-id', false, { message: 'expected a rejection, got a created item' });
  } catch (err) {
    check('4c-import-voice-cartesia-rejects-unknown-id', err?.code === 'voice_not_found_cartesia', { code: err?.code, message: err?.detail || err?.message });
  }
} catch (err) {
  failed = true;
  record('live-verify-catalog', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  // 5: catalog.delete — scratch item removed, re-get real-404s.
  if (itemId) {
    try {
      await kaltura.catalog.delete(itemId, admin, { confirmPermanent: true });
      record('5-catalog-delete', true, { itemId });
      try {
        await kaltura.catalog.get(itemId, admin);
        failed = true;
        record('5-catalog-delete-reget-still-found', false, { itemId });
      } catch (err) {
        record('5-catalog-delete-reget-not-found', true, { itemId, code: err?.code, message: err?.detail || err?.message });
      }
    } catch (err) {
      failed = true;
      record('5-catalog-delete', false, { itemId, message: err?.detail || err?.message || String(err) });
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
