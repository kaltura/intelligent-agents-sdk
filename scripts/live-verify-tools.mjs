#!/usr/bin/env node
/**
 * Live Tools verification — real Kaltura API, no fakes, no mocks.
 *
 * Exercises the Tools write path, which had zero live coverage:
 *
 *   1  tools.add (client)  — a `client` tool creates fine (no gate)
 *   2  tools.get           — visible, right shape
 *   3  tools.add (code)    — code is UNAVAILABLE BY DEFAULT: expects 403 forbidden
 *   4  tools.add (csv)     — csv is UNAVAILABLE BY DEFAULT: expects 403 forbidden
 *   5  tools.delete        — scratch client tool removed, re-`get` real-404s
 *
 * Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the
 * environment or a .env file in the repo root.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';
import { tools } from '../src/management/tools.js';

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
const runId = `ci-live-verify-tools-${Date.now()}`;
const RUN_TAG = `tl${Date.now().toString(36)}`;
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
let toolId;

try {
  const admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  // 1: tools.add (client) — no gate, creates fine.
  const clientTool = tools.client({ name: `probe_client_${RUN_TAG}`, description: 'live-verify probe' });
  const created = await kaltura.tools.add(clientTool, admin);
  toolId = created.id;
  check('1-tools-add-client', !!toolId, { toolId });

  // 2: tools.get — visible, right shape.
  const got = await kaltura.tools.get(toolId, admin);
  check('2-tools-get', got?.id === toolId && got?.config?.type === 'client', { id: got?.id, type: got?.config?.type });

  // 3: tools.add (code) — unavailable by default, expects 403 forbidden.
  try {
    const codeTool = tools.code({ name: `probe_code_${RUN_TAG}`, description: 'live-verify probe', code: 'result = 1' });
    await kaltura.tools.add(codeTool, admin);
    check('3-tools-add-code-unexpectedly-succeeded', false, {});
  } catch (err) {
    check('3-tools-add-code-403-forbidden', err?.status === 403 && err?.code === 'forbidden', { status: err?.status, code: err?.code, message: err?.detail || err?.message });
  }

  // 4: tools.add (csv) — unavailable by default, expects 403 forbidden.
  try {
    const csvTool = tools.csv({ name: `probe_csv_${RUN_TAG}`, description: 'live-verify probe', csv: 'a,b\n1,2' });
    await kaltura.tools.add(csvTool, admin);
    check('4-tools-add-csv-unexpectedly-succeeded', false, {});
  } catch (err) {
    check('4-tools-add-csv-403-forbidden', err?.status === 403 && err?.code === 'forbidden', { status: err?.status, code: err?.code, message: err?.detail || err?.message });
  }
} catch (err) {
  failed = true;
  record('live-verify-tools', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  // 5: tools.delete — scratch client tool removed, re-get real-404s.
  if (toolId) {
    try {
      const admin = await kaltura.sessions.createAdminToken();
      await kaltura.tools.delete(toolId, admin, { confirmPermanent: true, force: true });
      record('5-tools-delete', true, { toolId });
      try {
        await kaltura.tools.get(toolId, admin);
        failed = true;
        record('5-tools-delete-reget-still-found', false, { toolId });
      } catch (err) {
        record('5-tools-delete-reget-not-found', true, { toolId, code: err?.code, message: err?.detail || err?.message });
      }
    } catch (err) {
      failed = true;
      record('5-tools-delete', false, { toolId, message: err?.detail || err?.message || String(err) });
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
