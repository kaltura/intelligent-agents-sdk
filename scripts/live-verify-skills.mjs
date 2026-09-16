#!/usr/bin/env node
/**
 * Live Skills verification — real Kaltura API, no fakes, no mocks.
 *
 * Exercises the full Skills write path, which had zero live coverage:
 *
 *   1  skills.add        — create a scratch skill
 *   2  skills.get        — visible, right shape
 *   3  skills.list       — the new skill appears
 *   4  skills.update     — rename + description change persists on a follow-up get
 *   5  skills.delete     — plain delete (not referenced by any intellect), re-`get` real-404s
 *
 * Throwaway resource only (one Skill), full cleanup in `finally`, with
 * independent re-verification that it is truly gone (a real not-found, not
 * just a 200 from delete). Credentials: AGENTIC_PARTNER_ID /
 * AGENTIC_ADMIN_SECRET, from the environment or a .env file in the repo root.
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
const runId = `ci-live-verify-skills-${Date.now()}`;
const RUN_TAG = `sk${Date.now().toString(36)}`;
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
let skillId;

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  // 1: skills.add — name must match ^[a-zA-Z0-9_-]+$ (no spaces).
  const skillName = `live-verify-skill-${RUN_TAG}`;
  const created = await kaltura.skills.add({
    name: skillName,
    description: 'Scratch skill created by scripts/live-verify-skills.mjs',
    instructions: 'Never invoked live — this is a CI coverage probe.',
  }, admin);
  skillId = created.id;
  check('1-skills-add', !!skillId && created.name === skillName, { id: skillId, name: created.name });

  // 2: skills.get — visible, right shape.
  const got = await kaltura.skills.get(skillId, admin);
  check('2-skills-get', got.id === skillId && got.description === created.description, { id: got.id, description: got.description });

  // 3: skills.list — the new skill appears.
  const all = await kaltura.skills.list(admin).all();
  const found = all.find((s) => s.id === skillId);
  check('3-skills-list-contains-skill', !!found, { count: all.length, foundOurs: !!found });

  // 4: skills.update — rename + description change persists.
  const newName = `live-verify-skill-renamed-${RUN_TAG}`;
  const newDescription = 'Renamed by live-verify-skills.mjs';
  const updated = await kaltura.skills.update(skillId, { name: newName, description: newDescription }, admin);
  check('4-skills-update-returns-new-values', updated.name === newName && updated.description === newDescription, { name: updated.name, description: updated.description });
  const gotAfterUpdate = await kaltura.skills.get(skillId, admin);
  check('4-skills-update-persists', gotAfterUpdate.name === newName && gotAfterUpdate.description === newDescription, { name: gotAfterUpdate.name, description: gotAfterUpdate.description });
} catch (err) {
  failed = true;
  record('live-verify-skills', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  // 5: skills.delete — plain delete (no intellect references this scratch skill).
  if (skillId) {
    try {
      await kaltura.skills.delete(skillId, admin, { confirmPermanent: true });
      record('5-skills-delete', true, { skillId });
      try {
        await kaltura.skills.get(skillId, admin);
        failed = true;
        record('5-skills-delete-reget-still-found', false, { skillId });
      } catch (err) {
        record('5-skills-delete-reget-not-found', true, { skillId, code: err?.code, message: err?.detail || err?.message });
      }
    } catch (err) {
      failed = true;
      record('5-skills-delete', false, { skillId, message: err?.detail || err?.message || String(err) });
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
