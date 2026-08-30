#!/usr/bin/env node
/**
 * Live-backend verification for 4 newly-added capabilities — real Kaltura
 * API, no fakes: Knowledge#listRecords, Application#getCustomPrompts,
 * Avatars#listTemplates, and the full Lifecycle domain (9 methods).
 *
 * Mints an admin token, exercises each method against production, and for
 * Lifecycle runs a full create -> get/list -> match -> update -> delete
 * cycle with try/finally teardown. Writes a timestamped JSON artifact with
 * real request ids and trimmed response excerpts as proof this hit the
 * live backend, not a mock.
 *
 * Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the
 * environment or a .env file in the repo root (same convention as
 * scripts/live-verify.mjs).
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
const runId = `ci-live-verify-capabilities-${Date.now()}`;
const artifact = { runId, startedAt, partnerId, steps: [] };

function record(step, ok, detail) {
  artifact.steps.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${step}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

const kaltura = new Management({ partnerId, adminSecret });
let admin;
let ruleId;
let failed = false;

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  // ── Knowledge#listRecords ──────────────────────────────────────────────
  const records = await kaltura.knowledge.listRecords(admin, { pageSize: 5 });
  record('knowledge.listRecords', true, {
    count: records.length,
    sample: records.slice(0, 2).map((r) => ({ id: r.id, name: r.name, status: r.status })),
  });

  // ── Application#getCustomPrompts ───────────────────────────────────────
  const prompts = await kaltura.application.getCustomPrompts(admin);
  record('application.getCustomPrompts', true, {
    count: prompts.length,
    keys: prompts.map((p) => p.key),
  });

  // ── Avatars#listTemplates ───────────────────────────────────────────────
  const templates = await kaltura.avatars.listTemplates(admin, { pageSize: 5 });
  record('avatars.listTemplates', true, {
    count: templates.length,
    sample: templates.slice(0, 2).map((t) => ({ id: t.id, name: t.name, voiceId: t.voice?.id, faceId: t.face?.id })),
  });

  // ── Lifecycle: discovery ────────────────────────────────────────────────
  const objects = await kaltura.lifecycle.listObjects(admin);
  record('lifecycle.listObjects', true, objects);

  const events = await kaltura.lifecycle.listEvents('thread', admin);
  record('lifecycle.listEvents', true, events);

  const fields = await kaltura.lifecycle.describeFields('thread', 'session_ended', admin);
  record('lifecycle.describeFields', true, {
    objectType: fields.objectType,
    eventType: fields.eventType,
    fieldCount: fields.fields?.length,
  });

  // ── Lifecycle: full CRUD + match cycle ──────────────────────────────────
  const created = await kaltura.lifecycle.create(
    {
      name: `${runId}-rule`,
      systemName: runId,
      eventType: 'session_ended',
      objectType: 'thread',
      action: { actionType: 'triggerInsight', insights: [{ insightKey: 'SUMMARY', valueType: 'string' }] },
    },
    admin,
  );
  ruleId = created.id;
  record('lifecycle.create', true, { id: ruleId, status: created.status });

  const got = await kaltura.lifecycle.get(ruleId, admin);
  record('lifecycle.get', true, { id: got.id, status: got.status });

  const list = await kaltura.lifecycle.list(admin, { pageSize: 30 });
  const foundInList = list.some((r) => r.id === ruleId);
  record('lifecycle.list', foundInList, { count: list.length, foundInList });

  const matched = await kaltura.lifecycle.match(
    'thread', 'session_ended',
    { object: { agent_id: `${runId}-agent`, thread_id: `${runId}-thread`, user_id: `${runId}-user` } },
    admin,
  );
  const allRuleIds = (matched.matchedRules || []).flatMap((g) => g.rules.map((r) => r.id));
  const foundInMatch = allRuleIds.includes(ruleId);
  const presetFound = allRuleIds.includes('preset__overridable_summary_on_session_ended');
  record('lifecycle.match', foundInMatch, {
    groupCount: matched.matchedRules?.length,
    allRuleIds,
    foundInMatch,
    presetFound,
  });

  const updated = await kaltura.lifecycle.update(ruleId, { name: `${runId}-rule-renamed` }, admin);
  record('lifecycle.update', updated.name === `${runId}-rule-renamed`, { id: updated.id, name: updated.name });
} catch (err) {
  failed = true;
  record('live-verify-capabilities', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  if (ruleId) {
    try {
      const del = await kaltura.lifecycle.delete(ruleId, admin, { confirmPermanent: true });
      record('lifecycle.delete', del.success === true, del);
    } catch (err) {
      failed = true;
      record('lifecycle.delete', false, { id: ruleId, message: err?.detail || err?.message || String(err) });
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
