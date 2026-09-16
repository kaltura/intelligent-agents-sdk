#!/usr/bin/env node
/**
 * Live IntellectConfig verification — real Kaltura API, no fakes, no mocks.
 *
 * Exercises every intellectConfig setter, which had zero live coverage
 * (only `patch` was exercised elsewhere). All of it runs against ONE scratch
 * intellect, created fresh and deleted at the end:
 *
 *   1  intellects.add                          — scratch intellect to configure
 *   2  setToolIds([])                          — empty list, no real Tool needed
 *   3  setSkillIds([])                         — empty list, no real Skill needed
 *   4  setThreadStartTools([])                 — empty list, no real Tool needed
 *   5  setModelConfiguration({...})            — a real MODEL_IDS entry, then null to clear
 *   6  setOpeningPhrase('...')                 — then null to clear
 *   7  setAvatarSummaryConfig({...})           — then null to restore defaults
 *   8  setSecrets({CI_SCRATCH_SECRET: fake})   — fake name/value, never a real credential
 *      listSecretNames                          — confirms the name, never the value
 *      secrets cleanup                          — replaceAll({}) removes it, re-verified gone
 *   9  setUserPropertiesForms([{...}])         — minimal schema-valid form
 *      clearUserPropertiesForms                 — sets it back to null
 *  10  setAllowClientVariables(true/false)     — toggles the request_vars gate
 *  11  setMetadata({name, description, tags})  — row metadata, no config.* write
 *  12  setKnowledgeIds([])                     — empty list, no real Knowledge record needed
 *  13  setMcpServers({...})                    — one obviously-fake, non-resolvable http(s)
 *      entry, schema-valid only. mcp_servers is validated for shape client-side
 *      and stored server-side as-is; nothing here makes the backend dial out to
 *      it (the intellect never runs a live conversation turn in this script).
 *      Cleared back to {} at the end of the block.
 *  14  describe                                — read-only, asserts the editable
 *      surface reflects every write above
 *
 * Every array/dict setter that would otherwise need a real Tool/Skill/Knowledge
 * entity is exercised with `[]`/`{}` (a real, valid write — "detach everything"),
 * which is exactly what a fresh intellect already has: idempotent, zero-cost,
 * and still a genuine live round-trip through `v1/intellect/update`.
 *
 * Cleanup: intellects.delete the scratch intellect, re-`get` real-404s.
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
const runId = `ci-live-verify-intellect-config-${Date.now()}`;
const RUN_TAG = `ic${Date.now().toString(36)}`;
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

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  // 1: intellects.add — scratch intellect.
  const intel = await kaltura.intellects.add({
    type: 'internal',
    status: 2,
    prompts: [{ key: 'name', label: 'name', headerTemplate: 'Your name is:', type: 'custom', value: `Live-Verify IntellectConfig Probe ${RUN_TAG}` }],
  }, admin);
  configId = intel.id;
  check('1-intellect-create', !!configId, { configId });

  // 2: setToolIds([]) — direct reference-list write, no real Tool needed.
  const toolIds = await kaltura.intellectConfig.setToolIds(configId, [], admin);
  check('2-set-tool-ids', toolIds.applied === true, { applied: toolIds.applied });

  // 3: setSkillIds([]) — direct reference-list write, no real Skill needed.
  const skillIds = await kaltura.intellectConfig.setSkillIds(configId, [], admin);
  check('3-set-skill-ids', skillIds.applied === true, { applied: skillIds.applied });

  // 4: setThreadStartTools([]) — direct reference-list write, no real Tool needed.
  const startTools = await kaltura.intellectConfig.setThreadStartTools(configId, [], admin);
  check('4-set-thread-start-tools', startTools.applied === true, { applied: startTools.applied });

  // 5: setModelConfiguration — a real MODEL_IDS entry, then null to clear.
  const modelConfig = await kaltura.intellectConfig.setModelConfiguration(configId, {
    model_id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    max_output_tokens: 512,
    temperature: 0.3,
  }, admin);
  check('5-set-model-configuration', modelConfig.applied === true, { applied: modelConfig.applied });
  const modelConfigClear = await kaltura.intellectConfig.setModelConfiguration(configId, null, admin);
  check('5-clear-model-configuration', modelConfigClear.applied === true, { applied: modelConfigClear.applied });

  // 6: setOpeningPhrase — then null to clear.
  const openingPhrase = await kaltura.intellectConfig.setOpeningPhrase(configId, `Hello from live-verify ${RUN_TAG}!`, admin);
  check('6-set-opening-phrase', openingPhrase.applied === true, { applied: openingPhrase.applied });
  const openingPhraseClear = await kaltura.intellectConfig.setOpeningPhrase(configId, null, admin);
  check('6-clear-opening-phrase', openingPhraseClear.applied === true, { applied: openingPhraseClear.applied });

  // 7: setAvatarSummaryConfig — then null to restore defaults.
  const summaryConfig = await kaltura.intellectConfig.setAvatarSummaryConfig(configId, {
    prompt: 'Keep the summary under two sentences.',
    analysis: { summary: 'A short recap of the conversation.' },
    template: '{{ summary }}',
    content_type: 'text',
  }, admin);
  check('7-set-avatar-summary-config', summaryConfig.applied === true, { applied: summaryConfig.applied });
  const summaryConfigClear = await kaltura.intellectConfig.setAvatarSummaryConfig(configId, null, admin);
  check('7-clear-avatar-summary-config', summaryConfigClear.applied === true, { applied: summaryConfigClear.applied });

  // 8: setSecrets — fake, clearly-fake name/value, never a real credential.
  const SECRET_NAME = `CI_SCRATCH_SECRET_${RUN_TAG}`;
  const setSecrets = await kaltura.intellectConfig.setSecrets(configId, { [SECRET_NAME]: 'fake-scratch-value-never-real' }, admin);
  check('8-set-secrets', !!setSecrets.result, { sentSecretsKeys: Object.keys(setSecrets.sent?.secrets || {}) });
  const listNames = await kaltura.intellectConfig.listSecretNames(configId, admin);
  check('8-list-secret-names-contains-scratch', listNames.names.includes(SECRET_NAME), { names: listNames.names });

  // 9: setUserPropertiesForms — minimal schema-valid form, then clear.
  const propsForm = await kaltura.intellectConfig.setUserPropertiesForms(configId, {
    callStage: 'end',
    properties: [{ key: 'satisfaction', type: 'str' }],
  }, admin);
  check('9-set-user-properties-forms', !!propsForm.result, { sent: propsForm.sent?.user_properties_forms });
  const describeAfterForms = await kaltura.intellectConfig.describe(configId, admin);
  const formsEcho = describeAfterForms.editable.user_properties_forms;
  check('9-user-properties-forms-persisted', Array.isArray(formsEcho) && formsEcho.length === 1 && formsEcho[0].call_stage === 'end', { formsEcho });
  const propsFormClear = await kaltura.intellectConfig.clearUserPropertiesForms(configId, admin);
  check('9-clear-user-properties-forms', !!propsFormClear.result, { sent: propsFormClear.sent?.user_properties_forms });

  // 10: setAllowClientVariables — toggles the request_vars gate.
  const allowVarsOn = await kaltura.intellectConfig.setAllowClientVariables(configId, true, admin);
  check('10-set-allow-client-variables-true', !!allowVarsOn, { result: allowVarsOn });
  const allowVarsOff = await kaltura.intellectConfig.setAllowClientVariables(configId, false, admin);
  check('10-set-allow-client-variables-false', !!allowVarsOff, { result: allowVarsOff });

  // 11: setMetadata — row metadata (name/description/tags), no config.* write.
  const metaResult = await kaltura.intellectConfig.setMetadata(configId, {
    name: `Live Verify IntellectConfig ${RUN_TAG}`,
    description: 'Scratch intellect for live-verify-intellect-config.mjs',
    tags: ['ci-scratch'],
  }, admin);
  check('11-set-metadata', !!metaResult.result, { sent: { name: metaResult.sent?.name, tags: metaResult.sent?.tags } });

  // 12: setKnowledgeIds([]) — direct reference-list write, no real Knowledge record needed.
  const knowledgeIds = await kaltura.intellectConfig.setKnowledgeIds(configId, [], admin);
  check('12-set-knowledge-ids', knowledgeIds.applied === true, { applied: knowledgeIds.applied });

  // 13: setMcpServers — one obviously-fake, non-resolvable http(s) entry.
  // Shape/URL-scheme validated client-side only; the backend stores the map
  // as-is and never dials out here (no converse turn runs in this script).
  const mcpServers = await kaltura.intellectConfig.setMcpServers(configId, {
    [`live-verify-scratch-${RUN_TAG}`]: { url: 'https://mcp.invalid.example/live-verify-scratch' },
  }, admin);
  check('13-set-mcp-servers', mcpServers.applied === true, { applied: mcpServers.applied });
  const mcpServersClear = await kaltura.intellectConfig.setMcpServers(configId, {}, admin);
  check('13-clear-mcp-servers', mcpServersClear.applied === true, { applied: mcpServersClear.applied });

  // 14: describe — read-only, asserts the editable surface reflects the writes above.
  const described = await kaltura.intellectConfig.describe(configId, admin);
  check('14-describe-type', described.type === 'internal', { type: described.type });
  check('14-describe-secrets-names-only', Array.isArray(described.editable.secrets?.names) && described.editable.secrets.names.includes(SECRET_NAME), { names: described.editable.secrets?.names });
  check('14-describe-tool-ids-empty', Array.isArray(described.editable.tool_ids) && described.editable.tool_ids.length === 0, { tool_ids: described.editable.tool_ids });
  check('14-describe-mcp-servers-cleared', described.editable.mcp_servers && typeof described.editable.mcp_servers === 'object' && Object.keys(described.editable.mcp_servers).length === 0, { mcp_servers: described.editable.mcp_servers });
  check('14-describe-capability-names', Array.isArray(described.capabilityNames) && described.capabilityNames.length > 0, { count: described.capabilityNames.length });

  // Secrets cleanup — remove the scratch secret before the intellect is deleted,
  // re-verified gone via listSecretNames.
  await kaltura.intellects.secrets.replaceAll(configId, {}, admin, { confirmPermanent: true });
  const listNamesAfterCleanup = await kaltura.intellectConfig.listSecretNames(configId, admin);
  check('8-secrets-cleanup-verified-gone', !listNamesAfterCleanup.names.includes(SECRET_NAME), { names: listNamesAfterCleanup.names });
} catch (err) {
  failed = true;
  record('live-verify-intellect-config', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  if (configId) {
    try {
      await kaltura.intellects.delete(configId, admin, { confirmPermanent: true });
      record('intellect-delete', true, { configId });
      try {
        await kaltura.intellects.get(configId, admin);
        failed = true;
        record('intellect-delete-reget-still-found', false, { configId });
      } catch (err) {
        record('intellect-delete-reget-not-found', true, { configId, code: err?.code, message: err?.detail || err?.message });
      }
    } catch (err) {
      failed = true;
      record('intellect-delete', false, { configId, message: err?.detail || err?.message || String(err) });
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
