#!/usr/bin/env node
/**
 * Live thread-access verification — real Kaltura API, no fakes, no mocks.
 *
 * A conversation token only works on threads its own user created. Sending a `threadId` that
 * belongs to another user is refused in-band (HTTP 200 with an `error` segment). This proves
 * the SDK raises that as an error and does not return an empty reply:
 *
 *   1  owner sends a first turn            — thread is created, reply has text
 *   2  other user, KalturaChatSession      — rejects with `thread_access_denied`, emits `error`
 *   3  other user, conversations.send      — rejects with `thread_access_denied`
 *   4  other user, onErrorSegment:'return' — resolves, refusal in `result.errors`
 *   5  other user, onErrorSegment:'warn'   — chat session resolves, emits `warning`
 *   6  owner continues the same thread     — still works
 *
 * Run: TARGET=nvq2:1 node scripts/live-verify-thread-access.mjs
 * Creates one scratch intellect and one thread, deletes both at the end.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';
import { KalturaChatSession } from '../src/experience/chat-session.js';
import { resolveTarget } from './lib/target.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = resolveTarget(process.env.TARGET ?? 'prod');
const runId = `ci-live-verify-thread-access-${Date.now()}`;
const artifact = { runId, startedAt: new Date().toISOString(), partnerId: target.partnerId, steps: [] };

let failed = false;
function check(step, ok, detail) {
  if (!ok) failed = true;
  artifact.steps.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${step}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

const kaltura = new Management(target);
let admin; let configId; let threadId;
const token = async (userId) => (await kaltura.sessions.createConversationToken({ configId, userId })).ks;

try {
  admin = (await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' })).ks;
  const it = await kaltura.intellects.create({ name: `ta-${Date.now()}`, status: 2, base_directive: 'You are a terse test bot. Reply in under 15 words.' }, admin);
  configId = it.configId;

  const owner = await token('ta-owner');
  const other = await token('ta-other');

  // 1
  const first = await kaltura.conversations.send({ userMessage: 'Say OK.' }, { ks: owner, kind: 'conversation' });
  threadId = first.threadId;
  check('1-owner-first-turn', !!threadId && first.text.length > 0 && first.errors.length === 0, { threadId: !!threadId, textLength: first.text.length });

  // 2
  const chat = new KalturaChatSession({ token: other, genieUrl: target.genieUrl, threadId, pageLifecycleAware: false, fetch: target.fetch });
  const emitted = [];
  chat.on('error', (e) => emitted.push(e.code));
  await chat.connect();
  try {
    await chat.sendText('Hello.');
    check('2-chat-session-throws', false, { note: 'resolved with an empty reply' });
  } catch (e) {
    check('2-chat-session-throws', e.code === 'thread_access_denied' && emitted.includes('thread_access_denied'), { code: e.code, emitted, detail: String(e.detail).slice(0, 160) });
  }
  await chat.disconnect?.();

  // 3
  try {
    await kaltura.conversations.send({ userMessage: 'Hello.', threadId }, { ks: other, kind: 'conversation' });
    check('3-send-throws', false, { note: 'resolved with an empty reply' });
  } catch (e) {
    check('3-send-throws', e.code === 'thread_access_denied', { code: e.code, requestId: e.requestId });
  }

  // 4
  const ret = await kaltura.conversations.send({ userMessage: 'Hello.', threadId, onErrorSegment: 'return' }, { ks: other, kind: 'conversation' });
  check('4-send-return-mode', ret.text === '' && ret.errors.length === 1, { errors: ret.errors.map((s) => s.content) });

  // 5
  const warnChat = new KalturaChatSession({ token: other, genieUrl: target.genieUrl, threadId, onErrorSegment: 'warn', pageLifecycleAware: false, fetch: target.fetch });
  const warned = [];
  warnChat.on('warning', (w) => warned.push(w.code));
  await warnChat.connect();
  const warnRes = await warnChat.sendText('Hello.');
  check('5-chat-session-warn-mode', warnRes.text === '' && warned.includes('thread_access_denied'), { warned });
  await warnChat.disconnect?.();

  // 6
  const again = await kaltura.conversations.send({ userMessage: 'Say OK again.', threadId }, { ks: owner, kind: 'conversation' });
  check('6-owner-continues', again.text.length > 0 && again.errors.length === 0, { textLength: again.text.length });
} catch (err) {
  failed = true;
  console.log('[FAIL] live-verify-thread-access', err?.code, String(err?.detail || err?.message || err).slice(0, 300));
} finally {
  if (threadId && admin) { try { await kaltura.threads.delete([threadId], admin, { confirmPermanent: true }); } catch (e) { console.log('thread cleanup failed', e?.code); } }
  if (configId && admin) { try { await kaltura.intellects.delete(configId, admin, { confirmPermanent: true }); } catch (e) { console.log('intellect cleanup failed', e?.code); } }
}

artifact.finishedAt = new Date().toISOString();
artifact.ok = !failed;
mkdirSync(resolve(__dirname, '../live-verify-artifacts'), { recursive: true });
const outPath = resolve(__dirname, `../live-verify-artifacts/${runId}.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written: ${outPath}`);
process.exit(failed ? 1 : 0);
