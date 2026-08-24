#!/usr/bin/env node
/**
 * Live-backend smoke test — real Kaltura API, no fakes.
 *
 * Mints an admin token, creates a throwaway intellect, mints a conversation
 * token against it, sends one converse turn, then deletes the intellect.
 * Writes a timestamped JSON artifact with the real session/request ids and
 * the model's reply as proof the run hit the live backend, not a mock.
 *
 * This exercises the server-side management + conversation path only. It
 * does NOT cover live browser/WebRTC (KalturaAvatarSession) — that needs a
 * headed Playwright job with real media devices, deliberately out of scope
 * here (see .github/workflows/live-verify.yml's header comment).
 *
 * Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the
 * environment or a .env file in the repo root (same convention as
 * quickstart/create-agent.mjs).
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
const runId = `ci-live-verify-${Date.now()}`;
const artifact = { runId, startedAt, partnerId, steps: [] };

function record(step, ok, detail) {
  artifact.steps.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${step}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

const kaltura = new Management({ partnerId, adminSecret });
let admin;
let configId;
let failed = false;

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  const intellect = await kaltura.intellects.create(
    { name: runId, status: 2, base_directive: 'You are a CI smoke-test bot. Reply with exactly: ok' },
    admin,
  );
  configId = intellect.configId;
  record('intellect-create', true, { configId, requestId: intellect.raw?.requestId ?? intellect._meta?.requestId });

  const conv = await kaltura.sessions.createConversationToken({ configId });
  record('conversation-token-mint', true, { secondsRemaining: conv.secondsRemaining() });

  const reply = await kaltura.converseOnce(configId, 'Reply with exactly: ok', {}, conv);
  record('converse-once', true, {
    threadId: reply.threadId,
    messageId: reply.messageId,
    text: reply.text,
    requestId: reply._meta?.requestId,
  });
} catch (err) {
  failed = true;
  record('live-verify', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  if (configId) {
    try {
      await kaltura.intellects.delete(configId, admin, { confirmPermanent: true });
      record('intellect-delete', true, { configId });
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
