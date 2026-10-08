#!/usr/bin/env node
/**
 * Live Tools verification — real Kaltura API, no fakes, no mocks.
 *
 * Exercises the Tools write path, including the `code`/`csv` gate. A customer
 * admin session cannot create a `code` or `csv` tool, or change a tool's
 * `config` to one. Both calls reply 403 `forbidden`. Everything else works.
 *
 *   1  tools.add (client)      — a `client` tool creates fine (no gate)
 *   2  tools.get               — visible, right shape
 *   3  tools.add (code)        — 403 forbidden
 *   4  tools.add (csv)         — 403 forbidden
 *   5  tools.add (api)         — scratch tool used by the update steps
 *   6  tools.update (name)     — a name-only patch works
 *   7  tools.update (-> code)  — 403 forbidden
 *   8  tools.update (-> csv)   — 403 forbidden
 *   9  tools.get               — the denied updates changed nothing
 *  10  tools.update (-> api)   — re-sending an `api` config works
 *  11  tools.list              — the denied adds left no tool behind
 *  12  tools.delete            — scratch tools removed, re-`get` real-404s
 *
 * Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the
 * environment or a .env file in the repo root. `TARGET=nvq2` (or `nvq2:2`)
 * runs against another environment.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';
import { resolveTarget } from './lib/target.mjs';
import { tools } from '../src/management/tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const target = resolveTarget(process.env.TARGET ?? 'prod');
const { partnerId } = target;

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

/** Run `fn`. Pass when it rejects with 403 `forbidden`, fail when it resolves. */
async function expectForbidden(step, fn) {
  try {
    await fn();
    check(`${step}-unexpectedly-succeeded`, false, {});
  } catch (err) {
    check(`${step}-403-forbidden`, err?.status === 403 && err?.code === 'forbidden', { status: err?.status, code: err?.code, message: err?.detail || err?.message });
  }
}

const kaltura = new Management(target);
/** @type {string[]} */
const scratchIds = [];

const names = {
  client: `probe_client_${RUN_TAG}`,
  code: `probe_code_${RUN_TAG}`,
  csv: `probe_csv_${RUN_TAG}`,
  api: `probe_api_${RUN_TAG}`,
  apiRenamed: `probe_api_renamed_${RUN_TAG}`,
};

const codeConfig = () => tools.code({ name: names.code, description: 'live-verify probe', code: 'def main():\n    return 1' });
const csvConfig = () => tools.csv({ name: names.csv, description: 'live-verify probe', csv: 'a,b\n1,2' });
const apiConfig = (name, description) => tools.api({
  name, description, request: { url: 'https://example.com/ping', method: 'GET' }, responseTemplate: 'ok',
});

try {
  const admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  // 1: tools.add (client) — no gate, creates fine.
  const created = await kaltura.tools.add(tools.client({ name: names.client, description: 'live-verify probe' }), admin);
  scratchIds.push(created.id);
  check('1-tools-add-client', !!created.id, { toolId: created.id });

  // 2: tools.get — visible, right shape.
  const got = await kaltura.tools.get(created.id, admin);
  check('2-tools-get', got?.id === created.id && got?.config?.type === 'client', { id: got?.id, type: got?.config?.type });

  // 3, 4: tools.add (code, csv) — 403 forbidden.
  await expectForbidden('3-tools-add-code', () => kaltura.tools.add(codeConfig(), admin));
  await expectForbidden('4-tools-add-csv', () => kaltura.tools.add(csvConfig(), admin));

  // 5: tools.add (api) — scratch tool for the update steps.
  const api = await kaltura.tools.add(apiConfig(names.api, 'live-verify probe'), admin);
  scratchIds.push(api.id);
  check('5-tools-add-api', !!api.id && api.config?.type === 'api', { toolId: api.id, type: api.config?.type });

  // 6: name-only patch — the gate looks at `config`, so this works.
  const renamed = await kaltura.tools.update(api.id, { name: names.apiRenamed }, admin);
  check('6-tools-update-name', renamed?.name === names.apiRenamed && renamed?.config?.type === 'api', { name: renamed?.name, type: renamed?.config?.type });

  // 7, 8: config -> code / csv — 403 forbidden.
  await expectForbidden('7-tools-update-to-code', () => kaltura.tools.update(api.id, { config: codeConfig() }, admin));
  await expectForbidden('8-tools-update-to-csv', () => kaltura.tools.update(api.id, { config: csvConfig() }, admin));

  // 9: the denied updates changed nothing.
  const after = await kaltura.tools.get(api.id, admin);
  check('9-tools-get-unchanged', after?.name === names.apiRenamed && after?.config?.type === 'api', { name: after?.name, type: after?.config?.type });

  // 10: re-sending an api config works.
  const reapplied = await kaltura.tools.update(api.id, { config: apiConfig(names.apiRenamed, 'live-verify probe v2') }, admin);
  check('10-tools-update-api-config', reapplied?.config?.type === 'api' && reapplied?.config?.description === 'live-verify probe v2', { type: reapplied?.config?.type, description: reapplied?.config?.description });

  // 11: the denied adds left no tool behind.
  const leftovers = [];
  for (const name of [names.code, names.csv]) {
    const page = await kaltura.tools.list(admin, { filter: { nameEquals: name } });
    leftovers.push(...(page.objects ?? page).filter((t) => t.name === name));
  }
  check('11-tools-denied-adds-left-nothing', leftovers.length === 0, { found: leftovers.map((t) => t.name) });
} catch (err) {
  failed = true;
  record('live-verify-tools', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  // 12: tools.delete — scratch tools removed, re-get real-404s.
  if (scratchIds.length) {
    try {
      const admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
      for (const toolId of scratchIds) {
        try {
          await kaltura.tools.delete(toolId, admin, { confirmPermanent: true, force: true });
          record('12-tools-delete', true, { toolId });
        } catch (err) {
          failed = true;
          record('12-tools-delete', false, { toolId, message: err?.detail || err?.message || String(err) });
          continue;
        }
        try {
          await kaltura.tools.get(toolId, admin);
          failed = true;
          record('12-tools-delete-reget-still-found', false, { toolId });
        } catch (err) {
          record('12-tools-delete-reget-not-found', true, { toolId, code: err?.code, message: err?.detail || err?.message });
        }
      }
    } catch (err) {
      failed = true;
      record('12-tools-delete', false, { message: err?.detail || err?.message || String(err) });
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
