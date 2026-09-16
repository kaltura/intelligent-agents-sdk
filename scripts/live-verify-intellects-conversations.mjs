#!/usr/bin/env node
/**
 * Live Intellects/Conversations verification — real Kaltura API, no fakes, no mocks.
 *
 * Covers the intellect snapshot/restore + capability-policy surface and the
 * headless text conversation surface, which had zero live coverage:
 *
 *   1  intellects.create           — scratch intellect (defaults applied)
 *   2  intellects.setPrompts       — base_directive A + one prompt block
 *   3  intellects.getCapabilities  — baseline read
 *   4  intellects.setCapabilities  — turn one off-by-default capability on
 *   5  intellects.resolveCapabilities — resolved policy reflects the write
 *   6  intellects.snapshot         — capture state (prompts A + capability on)
 *   7  intellects.setPrompts       — drift base_directive to B
 *   7b intellects.setCapabilities  — drift the capability back off
 *   8  intellects.restore          — restore the step-6 snapshot
 *   9  intellects.get              — base_directive reverted to A
 *   9b intellects.getCapabilities  — capability reverted to on
 *   10 sessions.createConversationToken — mint a conversation-scoped token
 *   11 conversations.send          — one headless text turn
 *   12 conversations.status        — assistant status/consent/avatar config
 *   13 intellects.delete           — scratch intellect removed
 *
 * Step 9b is a regression guard for a real bug: `restore()`'s default path
 * used to write prompts/base_directive/glossary/status via `setPrompts` only
 * — which never sends `capabilities` — so a capability drifted after a
 * snapshot was NOT actually reverted, even though the return value's
 * `written` list claimed `'capabilities'` was restored. Fixed by adding a
 * second write (via `setCapabilities({force:true})`) whenever both
 * `'prompts'` and `'capabilities'` are being restored. A failure here now
 * means a real regression, not an expected gap.
 *
 * Throwaway resource only (one intellect), full cleanup in `finally`, with
 * independent re-verification that it is truly gone. Credentials:
 * AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the environment or a .env
 * file in the repo root.
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
const runId = `ci-live-verify-intellects-conversations-${Date.now()}`;
const RUN_TAG = `ic${Date.now().toString(36)}`;
const CAP_NAME = 'use_web_search';
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

  // 1: intellects.create — scratch intellect, SDK defaults applied.
  const intel = await kaltura.intellects.create({}, admin);
  configId = intel.configId;
  check('1-intellects-create', !!configId, { configId, type: intel.type, status: intel.status });

  // 2: intellects.setPrompts — base_directive A + one prompt block.
  const directiveA = `You are live-verify probe A ${RUN_TAG}.`;
  await kaltura.intellects.setPrompts(
    configId,
    [{ key: 'goal', label: 'goal', headerTemplate: 'Your core goal:', type: 'custom', value: 'Answer briefly.' }],
    admin,
    { baseDirective: directiveA },
  );
  const afterSetA = await kaltura.intellects.get(configId, admin);
  check('2-intellects-set-prompts-a', afterSetA.base_directive === directiveA, { base_directive: afterSetA.base_directive });

  // 3: intellects.getCapabilities — baseline read (off-by-default).
  const baseline = await kaltura.intellects.getCapabilities(configId, admin);
  check('3-intellects-get-capabilities-baseline', baseline.capabilities[CAP_NAME] !== 'on', { [CAP_NAME]: baseline.capabilities[CAP_NAME] });

  // 4: intellects.setCapabilities — turn the capability on.
  await kaltura.intellects.setCapabilities(configId, { [CAP_NAME]: 'on' }, admin);
  const afterCapOn = await kaltura.intellects.getCapabilities(configId, admin);
  check('4-intellects-set-capabilities-on', afterCapOn.capabilities[CAP_NAME] === 'on', { [CAP_NAME]: afterCapOn.capabilities[CAP_NAME] });

  // 5: intellects.resolveCapabilities — resolved policy reflects the write.
  const resolved = await kaltura.intellects.resolveCapabilities(configId, admin);
  check('5-intellects-resolve-capabilities', resolved.capabilities[CAP_NAME]?.state === 'on' && resolved.capabilities[CAP_NAME]?.resolvedFrom === 'partner_config', { [CAP_NAME]: resolved.capabilities[CAP_NAME] });

  // 6: intellects.snapshot — capture state (directive A + capability on).
  const snap = await kaltura.intellects.snapshot(configId, admin, { label: `live-verify-${RUN_TAG}` });
  check('6-intellects-snapshot', snap.fields.base_directive === directiveA && snap.fields.capabilities[CAP_NAME] === 'on', { base_directive: snap.fields.base_directive, [CAP_NAME]: snap.fields.capabilities[CAP_NAME] });

  // 7: intellects.setPrompts — drift base_directive to B.
  const directiveB = `You are live-verify probe B (drifted) ${RUN_TAG}.`;
  await kaltura.intellects.setPrompts(
    configId,
    [{ key: 'goal', label: 'goal', headerTemplate: 'Your core goal:', type: 'custom', value: 'Answer at length.' }],
    admin,
    { baseDirective: directiveB },
  );
  const afterSetB = await kaltura.intellects.get(configId, admin);
  check('7-intellects-set-prompts-b-drift', afterSetB.base_directive === directiveB, { base_directive: afterSetB.base_directive });

  // 7b: drift the capability back off.
  await kaltura.intellects.setCapabilities(configId, { [CAP_NAME]: 'off' }, admin);
  const afterCapOff = await kaltura.intellects.getCapabilities(configId, admin);
  check('7b-intellects-set-capabilities-off-drift', afterCapOff.capabilities[CAP_NAME] === 'off', { [CAP_NAME]: afterCapOff.capabilities[CAP_NAME] });

  // 8: intellects.restore — restore the step-6 snapshot.
  const restored = await kaltura.intellects.restore(snap, admin);
  check('8-intellects-restore', restored.written.includes('prompts') && restored.written.includes('capabilities'), { written: restored.written });

  // 9: intellects.get — base_directive reverted to A.
  const afterRestore = await kaltura.intellects.get(configId, admin);
  check('9-intellects-restore-reverts-directive', afterRestore.base_directive === directiveA, { base_directive: afterRestore.base_directive });

  // 9b: intellects.getCapabilities — capability reverted to on (documented contract of `restore`).
  const capAfterRestore = await kaltura.intellects.getCapabilities(configId, admin);
  check('9b-intellects-restore-reverts-capability', capAfterRestore.capabilities[CAP_NAME] === 'on', { [CAP_NAME]: capAfterRestore.capabilities[CAP_NAME] });

  // 10: sessions.createConversationToken — mint a conversation-scoped token.
  const conv = await kaltura.sessions.createConversationToken({ configId });
  check('10-create-conversation-token', !!conv?.ks, { secondsRemaining: conv?.secondsRemaining?.() });

  // 11: conversations.send — one headless text turn.
  const reply = await kaltura.conversations.send({ userMessage: `Reply with a short greeting. ${RUN_TAG}` }, conv.ks);
  check('11-conversations-send', typeof reply.text === 'string' && reply.text.length > 0 && !!reply.threadId, { threadId: reply.threadId, textLength: reply.text?.length });

  // 12: conversations.status — assistant status/consent/avatar config.
  const status = await kaltura.conversations.status(conv.ks);
  check('12-conversations-status', status !== undefined && status !== null, { keys: status && typeof status === 'object' ? Object.keys(status) : typeof status });
} catch (err) {
  failed = true;
  record('live-verify-intellects-conversations', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  // 13: intellects.delete — scratch intellect removed.
  if (configId) {
    try {
      await kaltura.intellects.delete(configId, admin, { confirmPermanent: true });
      record('13-intellects-delete', true, { configId });
      try {
        await kaltura.intellects.get(configId, admin);
        failed = true;
        record('13-intellects-delete-reget-still-found', false, { configId });
      } catch (err) {
        record('13-intellects-delete-reget-not-found', true, { configId, code: err?.code, message: err?.detail || err?.message });
      }
    } catch (err) {
      failed = true;
      record('13-intellects-delete', false, { configId, message: err?.detail || err?.message || String(err) });
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
