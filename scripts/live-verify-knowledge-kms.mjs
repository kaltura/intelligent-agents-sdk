#!/usr/bin/env node
/**
 * Live Knowledge KMS-linkage verification — real Kaltura API, no fakes, no mocks.
 *
 * `live-verify-knowledge.mjs` already covers the record CRUD (addRecord/
 * getRecord/list/updateRecord/addSource/removeSource/entryStatus/deleteRecord)
 * and `live-verify-intellect-config.mjs` covers `setKnowledgeIds([])` as a
 * trivial empty write. This script covers the part neither exercises: actually
 * LINKING a real Knowledge record onto a real intellect, and the read/status
 * surface that depends on that linkage being real:
 *
 *   1  intellects.add            — scratch intellect
 *   2  knowledge.getLinkage      — before any link: {knowledgeIds:[], enabled:false}
 *   3  knowledge.addRecord       — scratch record
 *   3b knowledge.corpusStatus({configId}) — no knowledge_ids linked yet: unlinked
 *   3c knowledge.corpusStatus({})         — neither categoryId nor configId: bad_request
 *   4  intellectConfig.setKnowledgeIds([recordId]) — the real linkage write
 *   5  knowledge.getLinkage      — reflects the linked record id
 *   5b knowledge.corpusStatus({configId}) — linked, but no config.sources[].categoryIds yet: still unlinked
 *   6  knowledge.setEnabled(true/false)   — toggles use_knowledge_base, each confirmed via getLinkage
 *   7  knowledge.addSource       — one source carrying a categoryIds entry
 *   8  knowledge.corpusStatus({configId}) — now resolves real categoryIds (entryCount 0, populated:false, NOT unlinked)
 *   9  knowledge.isIndexed       — READY immediately, indexPosition null (nothing indexed yet)
 *  10  knowledge.removeSource    — cleanup, back to no sources
 *  11  knowledge.deleteRecord WITHOUT force, still linked — typed `knowledge_in_use` naming the configId
 *  12  intellectConfig.setKnowledgeIds([]) — unlink, confirmed via getLinkage
 *  13  knowledge.deleteRecord (real cleanup) — re-`getRecord` real-404s
 *  14  intellects.delete        — scratch intellect removed, re-`get` real-404s
 *
 * `knowledge.createCategory`/`findCategory`/`findOrCreateCategory` are NOT
 * exercised here: the SDK has no `category.delete` — a category created live
 * would leak on every CI run with no way to clean it up (same cost/safety
 * class as `catalog.createVoice`). `corpusStatus`'s categoryIds param above is
 * a scratch integer that was never actually created as a category — querying
 * entries "in" a category that doesn't exist is a safe, free, real API call
 * that still exercises the real per-category counting code path (it just
 * legitimately finds zero entries). `uploadDocument`/`uploadMarkdown` are
 * skipped for the same no-cleanup reason (no exposed way to delete the
 * KMS entry they create); their request-shaping is a documented gap, not
 * unit-tested — see the DX audit notes for this PR.
 *
 * Cleanup: record then intellect, each independently re-verified gone.
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

const startedAt = new Date().toISOString();
const runId = `ci-live-verify-knowledge-kms-${Date.now()}`;
const RUN_TAG = `kk${Date.now().toString(36)}`;
// Never actually created as a real category — see the header comment above.
const SCRATCH_CATEGORY_ID = 900000000 + (Date.now() % 90000000);
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
let configId;
let recordId;

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  // 1: intellects.add — scratch intellect.
  const intel = await kaltura.intellects.add({
    type: 'internal',
    status: 2,
    prompts: [{ key: 'name', label: 'name', headerTemplate: 'Your name is:', type: 'custom', value: `Live-Verify Knowledge-KMS Probe ${RUN_TAG}` }],
  }, admin);
  configId = intel.id;
  check('1-intellect-create', !!configId, { configId });

  // 2: getLinkage — before any link.
  const linkageBefore = await kaltura.knowledge.getLinkage(configId, admin);
  check('2-linkage-before-empty', linkageBefore.knowledgeIds.length === 0 && linkageBefore.enabled === false, linkageBefore);

  // 3: addRecord — scratch record.
  const createdRecord = await kaltura.knowledge.addRecord({
    name: `Live Verify Knowledge KMS ${RUN_TAG}`,
    description: 'Scratch knowledge record created by scripts/live-verify-knowledge-kms.mjs',
  }, admin);
  recordId = createdRecord.id;
  check('3-knowledge-add-record', !!recordId, { id: recordId });

  // 3b: corpusStatus({configId}) — no knowledge_ids linked yet.
  const corpusUnlinked = await kaltura.knowledge.corpusStatus({ configId }, admin);
  check('3b-corpus-status-no-knowledge-ids', corpusUnlinked.populated === false && corpusUnlinked._meta?.unlinked === true, corpusUnlinked);

  // 3c: corpusStatus({}) — neither categoryId nor configId.
  try {
    await kaltura.knowledge.corpusStatus({}, admin);
    check('3c-corpus-status-bad-request-rejects', false, { message: 'expected a rejection' });
  } catch (err) {
    check('3c-corpus-status-bad-request-rejects', err?.code === 'bad_request', { code: err?.code, message: err?.detail || err?.message });
  }

  // 4: setKnowledgeIds([recordId]) — the real linkage write.
  const linked = await kaltura.intellectConfig.setKnowledgeIds(configId, [recordId], admin);
  check('4-set-knowledge-ids-linked', linked.applied === true, { applied: linked.applied });

  // 5: getLinkage — reflects the linked record.
  const linkageAfter = await kaltura.knowledge.getLinkage(configId, admin);
  check('5-linkage-after-link', linkageAfter.knowledgeIds.includes(recordId) && linkageAfter.enabled === false, linkageAfter);

  // 5b: corpusStatus({configId}) — linked, but no config.sources[].categoryIds yet.
  const corpusLinkedNoSources = await kaltura.knowledge.corpusStatus({ configId }, admin);
  check('5b-corpus-status-linked-no-sources', corpusLinkedNoSources.populated === false && corpusLinkedNoSources._meta?.unlinked === true, corpusLinkedNoSources);

  // 6: setEnabled toggles — each confirmed via getLinkage.
  await kaltura.knowledge.setEnabled(configId, true, admin);
  const linkageEnabled = await kaltura.knowledge.getLinkage(configId, admin);
  check('6-set-enabled-true', linkageEnabled.enabled === true, linkageEnabled);
  await kaltura.knowledge.setEnabled(configId, false, admin);
  const linkageDisabled = await kaltura.knowledge.getLinkage(configId, admin);
  check('6-set-enabled-false', linkageDisabled.enabled === false, linkageDisabled);

  // 7: addSource — one source carrying a categoryIds entry.
  const source = { type: 'internal', language: 'en', categoryIds: [String(SCRATCH_CATEGORY_ID)], indexers: [] };
  const addedSource = await kaltura.knowledge.addSource(recordId, source, admin);
  check('7-add-source-applied', addedSource.applied === true, { applied: addedSource.applied });

  // 8: corpusStatus({configId}) — now resolves real categoryIds (entryCount 0, populated:false, NOT unlinked).
  const corpusWithCategory = await kaltura.knowledge.corpusStatus({ configId }, admin);
  check('8-corpus-status-resolves-category', corpusWithCategory.categoryIds.includes(SCRATCH_CATEGORY_ID) && corpusWithCategory._meta?.unlinked !== true, corpusWithCategory);
  check('8-corpus-status-entry-count-zero', corpusWithCategory.entryCount === 0 && corpusWithCategory.populated === false, corpusWithCategory);

  // 9: isIndexed — READY immediately, no index position yet.
  const indexed = await kaltura.knowledge.isIndexed(recordId, admin);
  check('9-is-indexed-ready', indexed.ready === true && indexed.status === 'READY' && indexed.indexPosition === null, indexed);

  // 10: removeSource — cleanup, back to no sources.
  const removedSource = await kaltura.knowledge.removeSource(recordId, source, admin);
  check('10-remove-source-applied', removedSource.applied === true, { applied: removedSource.applied });

  // 11: deleteRecord WITHOUT force, still linked — typed `knowledge_in_use`.
  try {
    await kaltura.knowledge.deleteRecord(recordId, admin, { confirmPermanent: true });
    check('11-delete-record-in-use-rejects', false, { message: 'expected a rejection, record was deleted' });
  } catch (err) {
    const namesConfigId = typeof err?.detail === 'string' && err.detail.includes(String(configId));
    check('11-delete-record-in-use-rejects', err?.code === 'knowledge_in_use' && namesConfigId, { code: err?.code, message: err?.detail || err?.message });
  }

  // 12: setKnowledgeIds([]) — unlink, confirmed via getLinkage.
  const unlinked = await kaltura.intellectConfig.setKnowledgeIds(configId, [], admin);
  check('12-set-knowledge-ids-unlinked', unlinked.applied === true, { applied: unlinked.applied });
  const linkageFinal = await kaltura.knowledge.getLinkage(configId, admin);
  check('12-linkage-confirms-unlinked', linkageFinal.knowledgeIds.length === 0, linkageFinal);
} catch (err) {
  failed = true;
  record('live-verify-knowledge-kms', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  // 13: deleteRecord (real cleanup) — re-`getRecord` real-404s.
  if (recordId) {
    try {
      await kaltura.knowledge.deleteRecord(recordId, admin, { confirmPermanent: true, force: true });
      record('13-knowledge-delete-record', true, { recordId });
      try {
        await kaltura.knowledge.getRecord(recordId, admin);
        failed = true;
        record('13-knowledge-delete-record-reget-still-found', false, { recordId });
      } catch (err) {
        record('13-knowledge-delete-record-reget-not-found', true, { recordId, code: err?.code, message: err?.detail || err?.message });
      }
    } catch (err) {
      failed = true;
      record('13-knowledge-delete-record', false, { recordId, message: err?.detail || err?.message || String(err) });
    }
  }
  // 14: intellects.delete — scratch intellect removed, re-`get` real-404s.
  if (configId) {
    try {
      await kaltura.intellects.delete(configId, admin, { confirmPermanent: true });
      record('14-intellect-delete', true, { configId });
      try {
        await kaltura.intellects.get(configId, admin);
        failed = true;
        record('14-intellect-delete-reget-still-found', false, { configId });
      } catch (err) {
        record('14-intellect-delete-reget-not-found', true, { configId, code: err?.code, message: err?.detail || err?.message });
      }
    } catch (err) {
      failed = true;
      record('14-intellect-delete', false, { configId, message: err?.detail || err?.message || String(err) });
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
