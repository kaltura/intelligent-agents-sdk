#!/usr/bin/env node
/**
 * Live feedback-flow verification — real Kaltura API, no fakes. Runs against
 * one target deployment, or two in a single run (primary, then secondary).
 *
 * Starts a real conversation, sends two messages, submits feedback on the
 * second message's reply, closes the thread via the documented
 * `thread/session_completed` signal, waits 5 minutes, then reads feedback
 * back two ways: `mgmt.feedback.list({ filter: { messageIdEquals } })` and
 * `mgmt.messages.list({ filter: { idEquals } })` (the message row itself
 * carries `is_positive`/`comment`).
 * Each step is a hard assertion; the run exits non-zero if any fails, but
 * never throws away partial results — every environment gets its own
 * artifact and its own pass/fail line in the summary printed at the end.
 *
 * Throwaway intellect only, deleted in `finally` regardless of outcome.
 *
 * Targets come from scripts/lib/target.mjs. The primary target is `TARGET`
 * (default `prod`). The optional second target is `alt`: set
 * `ALT_AGENTIC_PARTNER_ID`/`ALT_AGENTIC_ADMIN_SECRET`/`ALT_AGENTIC_API_URL`/
 * `ALT_GENIE_URL`/`ALT_KALTURA_API_ENDPOINT` to run it too.
 *
 * Run one target only: `node scripts/live-verify-feedback-flow.mjs primary`.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';
import { ksString } from '../src/management/client.js';
import { Http } from '../src/core/http.js';
import { loadEnvFile, resolveTarget } from './lib/target.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Primary is TARGET (default prod). Secondary is the optional `alt` target (ALT_* vars).
loadEnvFile(resolve(__dirname, '../.env'));
const hasAlt = Object.keys(process.env).some((k) => k.startsWith('ALT_'));
const ENVIRONMENTS = ['primary', 'secondary'];

const onlyEnv = process.argv[2];
if (onlyEnv && !ENVIRONMENTS.includes(onlyEnv)) {
  console.error(`Unknown target "${onlyEnv}" — expected one of: ${ENVIRONMENTS.join(', ')}`);
  process.exit(1);
}

// An unconfigured secondary target is skipped, not an error — one target is a valid run.
const environmentsToRun = [];
if (onlyEnv !== 'secondary') environmentsToRun.push({ ...resolveTarget(process.env.TARGET ?? 'prod'), name: 'primary' });
if (onlyEnv === 'secondary' || (!onlyEnv && hasAlt)) environmentsToRun.push({ ...resolveTarget('alt'), name: 'secondary' });

const snippet = (text) => JSON.stringify(text ?? '').slice(0, 160);

async function runForEnv(env) {
  const startedAt = new Date().toISOString();
  const runId = `ci-live-verify-feedback-flow-${env.name}-${Date.now()}`;
  const RUN_TAG = `fb${env.name}${Date.now().toString(36)}`;
  const artifact = { runId, startedAt, environment: env.name, partnerId: env.partnerId, steps: [] };
  let failed = false;

  function record(step, ok, detail) {
    artifact.steps.push({ step, ok, detail, at: new Date().toISOString() });
    console.log(`[${env.name}] [${ok ? 'ok' : 'FAIL'}] ${step}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
  function check(step, ok, detail) {
    if (!ok) failed = true;
    record(step, ok, detail);
  }

  const kaltura = new Management(env);

  let admin;
  let intellectId;
  let threadId;

  try {
    admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
    record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

    const intel = await kaltura.intellects.add({
      type: 'internal',
      status: 2,
      allow_client_variables: false,
      prompts: [
        { key: 'name', label: 'name', headerTemplate: 'Your name is:', type: 'custom', value: `Live-Verify Feedback Probe (${RUN_TAG})` },
        { key: 'rules', label: 'rules', headerTemplate: 'Rules you must obey without exception:', type: 'custom', value: 'Reply with a short one-sentence acknowledgment to whatever the visitor says. Do not ask questions back.' },
      ],
      capabilities: {
        avatar: 'off', avatar_filler: 'off', use_knowledge_base: 'off',
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

    const conv = await kaltura.sessions.createConversationToken({ configId: intellectId });
    record('conversation-token-mint', true, { secondsRemaining: conv.secondsRemaining() });

    const m1 = await kaltura.converseOnce(intellectId, `Hello, this is live-verify-feedback-flow message 1 (${RUN_TAG}).`, {}, conv);
    threadId = m1.threadId;
    check('message-1-sent', !!m1.threadId && !!m1.messageId, { threadId: m1.threadId, messageId: m1.messageId, text: snippet(m1.text) });

    const m2 = await kaltura.converseOnce(intellectId, `This is message 2 (${RUN_TAG}) — please just acknowledge briefly.`, { threadId }, conv);
    check('message-2-sent', m2.threadId === threadId && !!m2.messageId && m2.messageId !== m1.messageId, { threadId: m2.threadId, messageId: m2.messageId, text: snippet(m2.text) });

    const feedbackComment = `live-verify-feedback-flow probe ${RUN_TAG}`;
    const addResult = await kaltura.feedback.add({ message_id: m2.messageId, is_positive: true, comment: feedbackComment }, conv);
    record('feedback-add', true, { messageId: m2.messageId, addResult });

    const http = new Http({ fetch: env.fetch });
    let closeOk = true;
    let closeDetail;
    try {
      const closeRes = await http.postJson({
        url: `${env.genieUrl.replace(/\/$/, '')}/thread/session_completed`,
        ks: ksString(conv),
        body: { id: threadId },
      });
      closeDetail = { data: closeRes.data };
    } catch (err) {
      closeOk = false;
      closeDetail = { message: err?.detail || err?.message || String(err), code: err?.code };
    }
    check('thread-session-completed', closeOk, closeDetail);

    record('wait-300s-start', true, {});
    await new Promise((r) => setTimeout(r, 300_000));
    record('wait-300s-done', true, {});

    const byMessageId = await kaltura.feedback.list(admin, { filter: { messageIdEquals: m2.messageId } });
    const byThreadId = await kaltura.feedback.list(admin, { filter: { threadIdEquals: threadId } });
    record('feedback-list-by-messageId', true, { messageId: m2.messageId, rowCount: byMessageId.length, rows: byMessageId });
    record('feedback-list-by-threadId', true, { threadId, rowCount: byThreadId.length, rows: byThreadId });

    check('feedback-visible-in-feedback-list', byMessageId.length > 0 || byThreadId.length > 0, {
      note: (byMessageId.length > 0 || byThreadId.length > 0)
        ? 'Feedback submitted via feedback.add() IS visible via feedback.list().'
        : 'Feedback submitted via feedback.add() returned success but is NOT visible via feedback.list() for this message/thread.',
    });

    const messagesById = await kaltura.messages.list(admin, { filter: { idEquals: m2.messageId } });
    const targetMessage = messagesById.find((m) => m.id === m2.messageId) || messagesById[0];
    record('messages-list-by-idEquals', true, { messageId: m2.messageId, rowCount: messagesById.length, message: targetMessage });

    const messageCarriesFeedback = !!targetMessage && targetMessage.is_positive === true && targetMessage.comment === feedbackComment;
    check('feedback-visible-on-message-row', messageCarriesFeedback, {
      note: messageCarriesFeedback
        ? 'The message row itself (via messages.list) carries the submitted is_positive/comment.'
        : 'The message row (via messages.list) does NOT carry the submitted is_positive/comment.',
      is_positive: targetMessage?.is_positive, comment: targetMessage?.comment,
    });
  } catch (err) {
    failed = true;
    record('live-verify-feedback-flow', false, { message: err?.detail || err?.message || String(err), code: err?.code });
  } finally {
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
  console.log(`[${env.name}] Artifact written: ${outPath}`);

  return artifact;
}

const results = [];
for (const env of environmentsToRun) {
  results.push(await runForEnv(env));
}

console.log('\n=== Summary ===');
for (const r of results) {
  const viaFeedback = r.steps.find((s) => s.step === 'feedback-visible-in-feedback-list');
  const viaMessage = r.steps.find((s) => s.step === 'feedback-visible-on-message-row');
  console.log(`${r.environment}: run ${r.ok ? 'PASSED' : 'FAILED'}; visible via feedback.list = ${viaFeedback ? viaFeedback.ok : 'unknown'}; visible via messages.list = ${viaMessage ? viaMessage.ok : 'unknown'}`);
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
