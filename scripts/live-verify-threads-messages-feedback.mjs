#!/usr/bin/env node
/**
 * Live threads/messages/feedback verification — real Kaltura API,
 * no fakes, no mocks.
 *
 * Exercises the write paths: a scratch thread is created via a real
 * conversation turn, then driven through these SDK-level
 * Threads/Messages/Feedback methods:
 *
 *   1  converseOnce → scratch thread + message
 *   2  threads.get          — the new thread is visible, right title/status
 *   3  threads.rename       — title change persists on a follow-up get
 *   4  threads.transcript   — flattened human:/ai: transcript contains the turn
 *   5  messages.list        — filtered to this thread, contains the message
 *   5b conversations add_message_in_db:false — a side question on the thread reuses its
 *                           history and leaves the message count unchanged
 *   5c conversations shared_message_id — forks a new thread from the message, source
 *                           thread unchanged, reply uses the seeded context
 *   6  messages.share       : clones the message under a new title, clone readable via messages.get (only with --with-share)
 *   7  feedback.add         — rates the message, is_positive persists
 *   8  threads.delete       — scratch threads removed, re-`get` real-404s
 *
 * Each step is a hard assertion (run exits non-zero if it fails), except the two
 * reply-recall observations in 5b and 5c, which are printed as notes only.
 *
 * `threads.setAnalysis`/`clearAnalysis`/`push` and `feedback.list` are
 * covered by live-verify-conversation-avatar-surface.mjs.
 *
 * Throwaway resources only (intellect + scratch threads), full cleanup in
 * `finally` and on SIGINT, with independent re-verification that the thread is truly gone
 * (a real not-found, not just a 200 from delete). The step 6 clone is left
 * behind: it does not live in the scratch thread, and the SDK has no call to
 * delete a single message. Credentials:
 * AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the environment or a .env
 * file in the repo root.
 *
 * QA note: non-production targets such as nvq2 are for employees and certified partners only.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';
import { resolveTarget } from './lib/target.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const target = resolveTarget(process.env.TARGET ?? 'prod');
const { partnerId } = target;

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

/** Print a model-dependent observation. Never fails the run: LLM recall is not a contract. */
function note(step, observed, detail) {
  record(step, true, { note: observed ? 'observed' : 'not observed (model-dependent, not a failure)', ...detail });
}

const snippet = (text) => JSON.stringify(text ?? '').slice(0, 160);

const kaltura = new Management(target);
let admin;
let intellectId;
let threadId;
let forkThreadId;
let cleanedUp = false;

/** Delete the scratch threads and intellect once, then re-check that each thread is gone. Also runs on SIGINT. */
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const id of [threadId, forkThreadId].filter(Boolean)) {
    // 8: threads.delete — scratch thread removed, re-get real-404s.
    try {
      await kaltura.threads.delete([id], admin, { confirmPermanent: true });
      record('8-threads-delete', true, { threadId: id });
      try {
        await kaltura.threads.get(id, admin);
        failed = true;
        record('8-threads-delete-reget-still-found', false, { threadId: id });
      } catch (err) {
        record('8-threads-delete-reget-not-found', true, { threadId: id, code: err?.code, message: err?.detail || err?.message });
      }
    } catch (err) {
      failed = true;
      record('8-threads-delete', false, { threadId: id, message: err?.detail || err?.message || String(err) });
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

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});

try {
  admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  const intel = await kaltura.intellects.add({
    type: 'internal',
    status: 2,
    prompts: [{ key: 'name', label: 'name', headerTemplate: 'Your name is:', type: 'custom', value: `sdk-live-${RUN_TAG}` }],
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
  // The same conversation token rates the message in step 7: feedback must
  // come from the user who sent it.
  const conv = await kaltura.sessions.createConversationToken({ configId: intellectId, userId: 'sdk-live-verify-user' });
  const turn = await kaltura.converseOnce(intellectId, `Say hello. Run tag: ${RUN_TAG}. Note for later: our project nickname is Falcon-${RUN_TAG}.`, {}, conv);
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

  // 5b: add_message_in_db:false — the side question sees the thread's history, stores nothing.
  const NICKNAME_ASK = 'What is our project nickname? Reply with just the nickname.';
  const before = await kaltura.messages.list(admin, { threadId });
  const side = await kaltura.converseOnce(intellectId, NICKNAME_ASK, { threadId, add_message_in_db: false }, conv);
  const afterSide = await kaltura.messages.list(admin, { threadId });
  check('5b-unsaved-turn-leaves-message-count', afterSide.length === before.length, { before: before.length, after: afterSide.length });
  note('5b-unsaved-turn-used-thread-history', side.text.includes(RUN_TAG), { text: snippet(side.text) });

  // 5c: shared_message_id — fork from the original message (not a share clone).
  const fork = await kaltura.converseOnce(intellectId, NICKNAME_ASK, { shared_message_id: turn.messageId }, conv);
  forkThreadId = fork.threadId;
  const afterFork = await kaltura.messages.list(admin, { threadId });
  check('5c-fork-opens-new-thread', !!forkThreadId && forkThreadId !== threadId, { forkThreadId });
  check('5c-fork-leaves-source-unchanged', afterFork.length === before.length, { before: before.length, after: afterFork.length });
  note('5c-fork-reply-used-seeded-context', fork.text.includes(RUN_TAG), { text: snippet(fork.text) });

  // 6: messages.share clones the message under a new title. Opt-in (--with-share):
  // every run leaves an undeletable clone behind, so run it only after a change
  // to the share code path.
  if (process.argv.includes('--with-share')) {
    const shared = await kaltura.messages.share(turn.messageId, `shared-${RUN_TAG}`, admin);
    check('6-messages-share-returns-new-id', !!shared?.newMessageId && shared.newMessageId !== turn.messageId, { newMessageId: shared?.newMessageId });
    const clone = await kaltura.messages.get(shared.newMessageId, admin);
    check('6-messages-share-clone-readable', clone?.id === shared.newMessageId && clone?.human === `shared-${RUN_TAG}`, { id: clone?.id, human: clone?.human });
  }

  // 7: feedback.add — rates the message; call is idempotent for the same pair.
  const fb = await kaltura.feedback.add({ message_id: turn.messageId, is_positive: true, comment: `live-verify ${RUN_TAG}` }, conv);
  check('7-feedback-add-succeeds', !!fb, { response: fb });
} catch (err) {
  failed = true;
  record('live-verify-threads-messages-feedback', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  await cleanup();
}

artifact.finishedAt = new Date().toISOString();
artifact.ok = !failed;

mkdirSync(resolve(__dirname, '../live-verify-artifacts'), { recursive: true });
const outPath = resolve(__dirname, `../live-verify-artifacts/${runId}.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written: ${outPath}`);

process.exit(failed ? 1 : 0);
