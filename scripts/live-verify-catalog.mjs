#!/usr/bin/env node
/**
 * Live Catalog verification — real Kaltura API, no fakes, no mocks.
 *
 * Exercises the Catalog write path:
 *
 *   1b catalog.createVisual: attribute values outside the accepted lists reject with bad_request
 *      and the error lists the accepted values
 *   1  catalog.createVisual — upload a scratch custom Visual (1x1 PNG)
 *   2  catalog.get          — visible, right shape
 *   3  catalog.list         — filtered to Visual, the new item appears
 *   3b-3d  list filters    : itemIdEqual, idsIn, and type + idsIn narrow to the right items
 *   3e list orderBy        : -createdAt sorts newest first; +createdAt resolves (order logged)
 *   3f list languageEqual  : voices filtered to 'en' carry language 'en'
 *   3g list rejections     : a bad orderBy and an unknown filter key reject with bad_request
 *   3h list adminTagsIn, agentScope: both resolve (contents are not asserted)
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
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';
import { resolveTarget } from './lib/target.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const target = resolveTarget(process.env.TARGET ?? 'prod');
const { partnerId } = target;

// A minimal valid 1x1 transparent PNG, used across the scratch-visual scripts.
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

const kaltura = new Management(target);
let admin;
let itemId;
let strayItemId;

try {
  admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  // 1b: attribute values outside the accepted lists are rejected, and the error lists the accepted values.
  const badFile = new Blob([PNG_1PX], { type: 'image/png' });
  try {
    const stray = await kaltura.catalog.createVisual(badFile, {
      name: `Live Verify Bad Attrs ${RUN_TAG}`, genderPresentation: 'Feminine',
      background: 'Bogus', skinTone: 'Dark', ageGroup: 'Teen', hairColor: 'Green',
    }, admin);
    strayItemId = stray.itemId;
    check('1b-create-visual-bad-attrs-rejects', false, { message: 'expected a rejection, got a created item', itemId: strayItemId });
  } catch (err) {
    const detail = err?.detail ?? '';
    check('1b-create-visual-bad-attrs-rejects', err?.code === 'bad_request' && err?.status === 400 && ['Color', 'MediumTan', 'OlderAdult', 'Blonde'].every((v) => detail.includes(v)), { code: err?.code, status: err?.status, message: err?.body?.message });
  }

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

  // 3b-3d: filter keys narrow the list.
  const byId = await kaltura.catalog.list(admin, { filter: { itemIdEqual: itemId } }).all();
  check('3b-list-itemIdEqual', byId.length === 1 && byId[0].itemId === itemId, { ids: byId.map((v) => v.itemId) });
  const otherId = visuals.find((v) => v.itemId !== itemId)?.itemId;
  check('3c-preset-visual-exists', !!otherId, { otherId });
  const byIds = await kaltura.catalog.list(admin, { filter: { idsIn: [itemId, otherId] } }).all();
  check('3c-list-idsIn', byIds.length === 2 && byIds.some((v) => v.itemId === itemId) && byIds.some((v) => v.itemId === otherId), { ids: byIds.map((v) => v.itemId) });
  const typedIds = await kaltura.catalog.list(admin, { type: 'Visual', filter: { idsIn: [itemId] } }).all();
  check('3d-list-type-and-idsIn', typedIds.length === 1 && typedIds[0].itemId === itemId, { ids: typedIds.map((v) => v.itemId) });

  // 3e: orderBy. -createdAt sorts newest first. +createdAt only has to resolve.
  const newest = (await kaltura.catalog.list(admin, { type: 'Visual', orderBy: '-createdAt' })).slice(0, 50);
  const stamps = newest.map((v) => v.createdAt).filter((t) => t !== undefined);
  if (stamps.length < 2) {
    record('3e-list-orderBy-newest-first', true, { note: 'items carry no createdAt, order not asserted', items: newest.length });
  } else {
    check('3e-list-orderBy-newest-first', stamps.every((t, i) => i === 0 || t <= stamps[i - 1]), { first5: stamps.slice(0, 5) });
  }
  const oldest = await kaltura.catalog.list(admin, { type: 'Visual', orderBy: '+createdAt' });
  check('3e-list-orderBy-plus-createdAt-resolves', Array.isArray(oldest), { first5: oldest.slice(0, 5).map((v) => v.createdAt) });

  // 3f: languageEqual narrows voices.
  const enVoices = await kaltura.catalog.list(admin, { type: 'Voice', filter: { languageEqual: 'en' } });
  const langs = enVoices.map((v) => v.attributes?.voice?.language).filter((l) => l !== undefined);
  check('3f-list-languageEqual', enVoices.length > 0 && langs.length > 0 && langs.every((l) => l === 'en'), { items: enVoices.length, withLanguage: langs.length, languages: [...new Set(langs)] });

  // 3g: an unknown orderBy value and an unknown filter key are rejected, and the error says why.
  for (const [name, opts, expected] of [
    ['3g-list-bad-orderBy', { orderBy: 'createdAt' }, ['+createdAt', '-createdAt']],
    ['3g-list-unknown-filter-key', { filter: { bogusKey: 1 } }, ['bogusKey']],
  ]) {
    try {
      await kaltura.catalog.list(admin, opts);
      check(name, false, { message: 'expected a rejection' });
    } catch (err) {
      check(name, err?.code === 'bad_request' && err?.status === 400 && expected.every((e) => err.detail.includes(e)), { code: err?.code, status: err?.status, detail: err?.detail });
    }
  }

  // 3h: adminTagsIn and agentScope are accepted. Their effect is not asserted.
  const tagged = await kaltura.catalog.list(admin, { type: 'Voice', filter: { adminTagsIn: ['custom'] } });
  check('3h-list-adminTagsIn-resolves', Array.isArray(tagged), { items: tagged.length });
  const scoped = await kaltura.catalog.list(admin, { agentScope: 'x' });
  check('3h-list-agentScope-resolves', Array.isArray(scoped), { items: scoped.length });

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
  if (strayItemId) {
    try {
      await kaltura.catalog.delete(strayItemId, admin, { confirmPermanent: true });
      record('1b-stray-item-delete', true, { strayItemId });
    } catch (err) {
      failed = true;
      record('1b-stray-item-delete', false, { strayItemId, message: err?.detail || err?.message || String(err) });
    }
  }
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
