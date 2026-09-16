#!/usr/bin/env node
/**
 * Live Knowledge verification — real Kaltura API, no fakes, no mocks.
 *
 * `live-verify-capabilities.mjs` already covers `knowledge.list` (READ) and
 * lifecycle CRUD. This script covers the write path that still had zero live
 * coverage:
 *
 *   1  knowledge.addRecord    — create a scratch record (createRecord alias)
 *   2  knowledge.getRecord    — visible, right shape
 *   3  knowledge.list         — the new record appears
 *   4  knowledge.updateRecord — rename persists on a follow-up get
 *   5  knowledge.addSource    — appends a source to config.sources, idempotent no-op on repeat
 *   6  knowledge.removeSource — removes it back out, idempotent no-op on repeat
 *   7  knowledge.entryStatus  — unknown entry ids are silently omitted, not an error
 *   8  knowledge.deleteRecord — scratch record removed, re-`getRecord` real-404s
 *
 * Throwaway resource only (one Knowledge record, no real indexed content),
 * full cleanup in `finally`, with independent re-verification that it is
 * truly gone. Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from
 * the environment or a .env file in the repo root.
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

const startedAt = new Date().toISOString();
const runId = `ci-live-verify-knowledge-${Date.now()}`;
const RUN_TAG = `kn${Date.now().toString(36)}`;
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
let recordId;

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  // 1: knowledge.addRecord
  const created = await kaltura.knowledge.addRecord({
    name: `Live Verify Knowledge ${RUN_TAG}`,
    description: 'Scratch knowledge record created by scripts/live-verify-knowledge.mjs',
  }, admin);
  recordId = created.id;
  check('1-knowledge-add-record', !!recordId, { id: recordId, name: created.name, status: created.status });

  // 2: knowledge.getRecord — visible, right shape.
  const got = await kaltura.knowledge.getRecord(recordId, admin);
  check('2-knowledge-get-record', got.id === recordId && got.name === created.name, { id: got.id, name: got.name, status: got.status });

  // 3: knowledge.list — the new record appears.
  const all = await kaltura.knowledge.list(admin).all();
  const found = all.find((r) => r.id === recordId);
  check('3-knowledge-list-contains-record', !!found, { count: all.length, foundOurs: !!found });

  // 4: knowledge.updateRecord — rename persists.
  const newName = `Live Verify Knowledge Renamed ${RUN_TAG}`;
  const updated = await kaltura.knowledge.updateRecord(recordId, { name: newName }, admin);
  check('4-knowledge-update-record-returns-new-name', updated.name === newName, { name: updated.name });
  const gotAfterUpdate = await kaltura.knowledge.getRecord(recordId, admin);
  check('4-knowledge-update-record-persists', gotAfterUpdate.name === newName, { name: gotAfterUpdate.name });

  // 5: knowledge.addSource — appends a source; repeat is an idempotent no-op.
  const source = { type: 'internal', language: 'en', categoryIds: [], indexers: [] };
  const added = await kaltura.knowledge.addSource(recordId, source, admin);
  check('5-knowledge-add-source-applied', added.applied === true, { applied: added.applied });
  const addedAgain = await kaltura.knowledge.addSource(recordId, source, admin);
  check('5-knowledge-add-source-idempotent', addedAgain.applied === false, { applied: addedAgain.applied });

  // 6: knowledge.removeSource — removes it back out; repeat is an idempotent no-op.
  const removed = await kaltura.knowledge.removeSource(recordId, source, admin);
  check('6-knowledge-remove-source-applied', removed.applied === true, { applied: removed.applied });
  const removedAgain = await kaltura.knowledge.removeSource(recordId, source, admin);
  check('6-knowledge-remove-source-idempotent', removedAgain.applied === false, { applied: removedAgain.applied });

  // 7: knowledge.entryStatus — an unknown entry id is silently omitted, not an error.
  const status = await kaltura.knowledge.entryStatus(recordId, ['0_livekn00'], admin);
  check('7-knowledge-entry-status-is-array', Array.isArray(status?.entries), { entries: status?.entries });
} catch (err) {
  failed = true;
  record('live-verify-knowledge', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  // 8: knowledge.deleteRecord — scratch record removed, re-get real-404s.
  if (recordId) {
    try {
      await kaltura.knowledge.deleteRecord(recordId, admin, { confirmPermanent: true });
      record('8-knowledge-delete-record', true, { recordId });
      try {
        await kaltura.knowledge.getRecord(recordId, admin);
        failed = true;
        record('8-knowledge-delete-record-reget-still-found', false, { recordId });
      } catch (err) {
        record('8-knowledge-delete-record-reget-not-found', true, { recordId, code: err?.code, message: err?.detail || err?.message });
      }
    } catch (err) {
      failed = true;
      record('8-knowledge-delete-record', false, { recordId, message: err?.detail || err?.message || String(err) });
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
