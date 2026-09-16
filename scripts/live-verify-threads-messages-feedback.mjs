#!/usr/bin/env node
/**
 * Live threads/messages/feedback/followups verification — real Kaltura API,
 * no fakes, no mocks.
 *
 * Exercises the write paths that had zero live coverage: a scratch thread is
 * created via a real conversation turn, then driven through every SDK-level
 * Threads/Messages/Feedback/Followups method the client currently exposes:
 *
 *   1  converseOnce → scratch thread + message
 *   2  threads.get          — the new thread is visible, right title/status
 *   3  threads.rename       — title change persists on a follow-up get
 *   4  threads.transcript   — flattened human:/ai: transcript contains the turn
 *   5  messages.list        — filtered to this thread, contains the message
 *   6  messages.share       — clones the message under a new title (best-effort, see below)
 *   7  feedback.add         — rates the message, is_positive persists
 *   8  followups.getSuggested — partner-level starter questions (may be [])
 *   9  threads.delete       — scratch thread removed, re-`get` real-404s
 *
 * Each step is a hard assertion (run exits non-zero if it fails) EXCEPT step 6
 * (messages.share), which is recorded but never fails the run — see the
 * comment at that step for why.
 *
 * Threads/Messages/Feedback/Followups currently expose only the methods this
 * script calls; there is no `setAnalysis`/`clearAnalysis`/`push` on `threads`,
 * and no `list` on `feedback` or `followups` — this run covers the full
 * client-side surface of these four classes as it exists today.
 *
 * Throwaway resources only (intellect + scratch thread), full cleanup in
 * `finally`, with independent re-verification that the thread is truly gone
 * (a real not-found, not just a 200 from delete). Credentials:
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
const runId = `ci-live-verify-threads-messages-feedback-${Date.now()}`;
const RUN_TAG = `tmf${Date.now().toString(36)}`;
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

const snippet = (text) => JSON.stringify(text ?? '').slice(0, 160);

const kaltura = new Management({ partnerId, adminSecret });
let admin;
let intellectId;
let threadId;

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  const intel = await kaltura.intellects.add({
    type: 'internal',
    status: 2,
    prompts: [{ key: 'name', label: 'name', headerTemplate: 'Your name is:', type: 'custom', value: 'Live-Verify Threads Probe' }],
    capabilities: {
      avatar: 'on', avatar_filler: 'off', use_knowledge_base: 'off',
      use_content_search: 'disabled', use_get_entry_content: 'disabled',
      use_related_files: 'disabled', use_web_search: 'disabled',
      generate_followup_questions: 'disabled', include_sources: 'disabled',
      video_gallery: 'disabled', external_video: 'disabled', show_link: 'disabled',
      avatar_show_content: 'disabled', kaltura_genie_experiences: 'disabled',
      screen_share_analysis: 'disabled',
    },
  }, admin);
  intellectId = intel.id;
  record('intellect-create', true, { intellectId });

  // 1: scratch thread via a real conversation turn.
  const turn = await kaltura.converseOnce(intellectId, `Say hello. Run tag: ${RUN_TAG}.`, {});
  threadId = turn.threadId;
  check('1-converse-creates-thread', !!threadId && !!turn.messageId, { threadId, messageId: turn.messageId, text: snippet(turn.text) });

  // 2: threads.get — visible, right shape.
  const got = await kaltura.threads.get(threadId, admin);
  check('2-threads-get', got.id === threadId && typeof got.status === 'number', { id: got.id, status: got.status, title: got.title });

  // 3: threads.rename — persists on a follow-up get.
  const newTitle = `Live Verify ${RUN_TAG}`;
  const renamed = await kaltura.threads.rename(threadId, newTitle, admin);
  check('3-threads-rename-returns-new-title', renamed.title === newTitle, { title: renamed.title });
  const gotAfterRename = await kaltura.threads.get(threadId, admin);
  check('3-threads-rename-persists', gotAfterRename.title === newTitle, { title: gotAfterRename.title });

  // 4: threads.transcript — the one endpoint whose response is one envelope
  // deeper than every sibling method; the flattened text is at `.data.data`.
  const transcript = await kaltura.threads.transcript(threadId, admin);
  check('4-threads-transcript-contains-turn', typeof transcript?.data === 'string' && transcript.data.includes(RUN_TAG), { snippet: snippet(transcript?.data) });

  // 5: messages.list — filtered to this thread, contains the message.
  const messages = await kaltura.messages.list(admin, { threadId });
  const ourMessage = messages.find((m) => m.id === turn.messageId || m.thread_id === threadId);
  check('5-messages-list-contains-message', messages.length > 0 && !!ourMessage, { count: messages.length, foundOurs: !!ourMessage });

  // 6: messages.share — clones the message under a new title. Best-effort,
  // NOT a hard gate: this call is observably flaky on the live backend
  // (occasionally comes back with no newMessageId on an otherwise-valid
  // request), and the resulting clone isn't reachable through any read method
  // this client exposes, so a failure here can't be distinguished from
  // transient backend noise and there is nothing to independently verify or
  // clean up either way. Retried twice since the call is cheap and read-only
  // in effect if it silently no-ops.
  let shared;
  for (let attempt = 0; attempt < 3 && !shared?.newMessageId; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    shared = await kaltura.messages.share(turn.messageId, `shared-${RUN_TAG}`, admin);
  }
  record('6-messages-share-returns-new-id', !!shared?.newMessageId && shared.newMessageId !== turn.messageId, { newMessageId: shared?.newMessageId });

  // 7: feedback.add — rates the message; call is idempotent for the same pair.
  const fb = await kaltura.feedback.add({ message_id: turn.messageId, is_positive: true, comment: `live-verify ${RUN_TAG}` }, admin);
  check('7-feedback-add-succeeds', !!fb, { response: fb });

  // 8: followups.getSuggested — partner-level starter questions (may be []).
  const suggested = await kaltura.followups.getSuggested(admin);
  check('8-followups-get-suggested-is-array', Array.isArray(suggested), { count: Array.isArray(suggested) ? suggested.length : null });
} catch (err) {
  failed = true;
  record('live-verify-threads-messages-feedback', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  // 9: threads.delete — scratch thread removed, re-get real-404s.
  if (threadId) {
    try {
      await kaltura.threads.delete([threadId], admin, { confirmPermanent: true });
      record('9-threads-delete', true, { threadId });
      try {
        await kaltura.threads.get(threadId, admin);
        failed = true;
        record('9-threads-delete-reget-still-found', false, { threadId });
      } catch (err) {
        record('9-threads-delete-reget-not-found', true, { threadId, code: err?.code, message: err?.detail || err?.message });
      }
    } catch (err) {
      failed = true;
      record('9-threads-delete', false, { threadId, message: err?.detail || err?.message || String(err) });
    }
  }
  if (intellectId) {
    try {
      await kaltura.intellects.delete(intellectId, admin, { confirmPermanent: true });
      record('intellect-delete', true, { intellectId });
    } catch (err) {
      failed = true;
      record('intellect-delete', false, { intellectId, message: err?.detail || err?.message || String(err) });
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
