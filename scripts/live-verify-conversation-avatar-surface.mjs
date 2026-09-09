#!/usr/bin/env node
/**
 * Live-backend verification for this PR's new backend-touching capabilities —
 * real Kaltura API, no fakes: Threads#push/setAnalysis/clearAnalysis,
 * Feedback#add/list/report, Followups#list, and Avatars#create/update
 * composed both via face+background and via templateId+background, plus
 * Catalog#createFace/createBackground.
 *
 * Mints an admin token, opens one real conversation thread via converseOnce
 * to get a live threadId/messageId, then exercises each capability against
 * production with try/finally teardown (avatars → catalog items → thread →
 * intellect). Writes a timestamped JSON artifact with real request ids and
 * trimmed response excerpts as proof this hit the live backend, not a mock.
 *
 * Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the
 * environment or a .env file in the repo root (same convention as
 * scripts/live-verify.mjs).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

try {
  const env = readFileSync(resolve(repoRoot, '.env'), 'utf8');
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
const runId = `ci-live-verify-conversation-surface-${Date.now()}`;
const artifact = { runId, startedAt, partnerId, steps: [] };

function record(step, ok, detail) {
  if (!ok) failed = true;
  artifact.steps.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${step}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

// Two real, small JPEG portraits already committed to the repo — reused here
// as face/background upload payloads so this hits the real multipart-upload
// path with real image bytes, not a synthetic 1x1 pixel.
const FACE_IMAGE = resolve(repoRoot, 'examples/chroma-key-green-screen-portrait.jpeg');
const BACKGROUND_IMAGE = resolve(repoRoot, 'manual-testing/voice-video/improv/max.jpeg');

const kaltura = new Management({ partnerId, adminSecret });
let admin;
let configId;
let threadId;
let faceItemId;
let backgroundItemId;
let avatarAId;
let avatarBId;
let failed = false;

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  // ── Set up a real thread to exercise Threads/Feedback/Followups against ──
  const intellect = await kaltura.intellects.create(
    { name: runId, status: 2, base_directive: 'You are a CI smoke-test bot. Reply with exactly: ok' },
    admin,
  );
  configId = intellect.configId;
  record('intellect-create', true, { configId });

  const conv = await kaltura.sessions.createConversationToken({ configId });
  const opened = await kaltura.conversations.send({ userMessage: 'Reply with exactly: ok' }, conv);
  threadId = opened.threadId;
  const messageId = opened.messageId;
  record('converse-open-thread', Boolean(threadId && messageId), { threadId, messageId, text: opened.text });

  // ── Threads#push / setAnalysis / clearAnalysis ──────────────────────────
  const pushed = await kaltura.threads.push({ id: threadId, content: 'CI live-verify push message' }, admin);
  record('threads.push', typeof pushed?.delivered === 'boolean', { delivered: pushed?.delivered, messageId: pushed?.messageId });

  const analyzed = await kaltura.threads.setAnalysis(threadId, { ci_probe: runId }, admin);
  record('threads.setAnalysis', analyzed?.thread_metadata?.analysis?.ci_probe === runId, { analysis: analyzed?.thread_metadata?.analysis });

  const cleared = await kaltura.threads.clearAnalysis(threadId, admin);
  const analysisGone = !cleared?.thread_metadata?.analysis || Object.keys(cleared.thread_metadata.analysis).length === 0;
  record('threads.clearAnalysis', analysisGone, { thread_metadata: cleared?.thread_metadata });

  // ── Feedback#add / list / report ────────────────────────────────────────
  const feedback = await kaltura.feedback.add({ message_id: messageId, is_positive: true, comment: 'ci live-verify' }, conv);
  record('feedback.add', Boolean(feedback), { feedback });

  const feedbackRows = await kaltura.feedback.list(admin, { pageSize: 30 });
  const foundFeedback = feedbackRows.some((r) => r.message_id === messageId || r.messageId === messageId);
  record('feedback.list', foundFeedback, { count: feedbackRows.length, foundFeedback });

  const feedbackReport = await kaltura.feedback.report(admin, { pageSize: 100 });
  record('feedback.report', feedbackReport === null || typeof feedbackReport === 'string', { isString: typeof feedbackReport === 'string', isNull: feedbackReport === null });

  // ── Followups#list ──────────────────────────────────────────────────────
  const followupRows = await kaltura.followups.list(admin, { pageSize: 5 });
  record('followups.list', Array.isArray(followupRows), { count: followupRows.length });

  // ── Catalog#createFace / createBackground ───────────────────────────────
  const faceFile = new Blob([readFileSync(FACE_IMAGE)], { type: 'image/jpeg' });
  const face = await kaltura.catalog.createFace(faceFile, { name: `${runId}-face`, genderPresentation: 'Feminine' }, admin);
  faceItemId = face.itemId;
  record('catalog.createFace', Boolean(faceItemId), { itemId: faceItemId });

  const backgroundFile = new Blob([readFileSync(BACKGROUND_IMAGE)], { type: 'image/jpeg' });
  const background = await kaltura.catalog.createBackground(backgroundFile, { name: `${runId}-background`, genderPresentation: 'Feminine' }, admin);
  backgroundItemId = background.itemId;
  record('catalog.createBackground', Boolean(backgroundItemId), { itemId: backgroundItemId });

  // ── Avatars#create/update — face + background composition ──────────────
  const voices = await kaltura.catalog.list(admin, { type: 'Voice', pageSize: 1 }).all();
  const voiceItemId = voices[0]?.itemId;
  record('catalog.list(Voice) preset lookup', Boolean(voiceItemId), { voiceItemId });

  const avatarA = await kaltura.avatars.create(
    { voice: { id: voiceItemId }, face: { id: faceItemId }, background: { type: 'visual', value: backgroundItemId }, openingPhrase: '<blank>' },
    admin,
  );
  avatarAId = avatarA.id;
  record('avatars.create (face+background)', Boolean(avatarAId), { id: avatarAId, composition: avatarA.visual?.composition });

  const avatarAUpdated = await kaltura.avatars.update(
    { id: avatarAId, face: { id: faceItemId }, background: { type: 'color', value: '#ffffff' } },
    admin,
  );
  record('avatars.update (face+background recompose)', avatarAUpdated?.id === avatarAId, { id: avatarAUpdated?.id, composition: avatarAUpdated?.visual?.composition });

  // ── Avatars#create/update — templateId + background composition ────────
  const templates = await kaltura.avatars.listTemplates(admin, { pageSize: 1 }).all();
  const template = templates[0];
  record('avatars.listTemplates', Boolean(template), { id: template?.id, name: template?.name });

  const avatarB = await kaltura.avatars.create(
    { voice: template.voice, templateId: template.id, background: { type: 'color', value: '#ffffff' }, openingPhrase: '<blank>' },
    admin,
  );
  avatarBId = avatarB.id;
  record('avatars.create (templateId+background)', Boolean(avatarBId), { id: avatarBId, composition: avatarB.visual?.composition });

  const avatarBUpdated = await kaltura.avatars.update({ id: avatarBId, name: `${runId}-renamed` }, admin);
  record('avatars.update (name-only patch)', avatarBUpdated?.name === `${runId}-renamed`, { id: avatarBUpdated?.id, name: avatarBUpdated?.name });
} catch (err) {
  failed = true;
  record('live-verify-conversation-avatar-surface', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  if (avatarAId) {
    try {
      await kaltura.avatars.delete(avatarAId, admin, { confirmPermanent: true });
      record('avatars.delete (avatarA)', true, { id: avatarAId });
    } catch (err) {
      failed = true;
      record('avatars.delete (avatarA)', false, { id: avatarAId, message: err?.detail || err?.message || String(err) });
    }
  }
  if (avatarBId) {
    try {
      await kaltura.avatars.delete(avatarBId, admin, { confirmPermanent: true });
      record('avatars.delete (avatarB)', true, { id: avatarBId });
    } catch (err) {
      failed = true;
      record('avatars.delete (avatarB)', false, { id: avatarBId, message: err?.detail || err?.message || String(err) });
    }
  }
  if (faceItemId) {
    try {
      await kaltura.catalog.delete(faceItemId, admin, { confirmPermanent: true });
      record('catalog.delete (face)', true, { itemId: faceItemId });
    } catch (err) {
      failed = true;
      record('catalog.delete (face)', false, { itemId: faceItemId, message: err?.detail || err?.message || String(err) });
    }
  }
  if (backgroundItemId) {
    try {
      await kaltura.catalog.delete(backgroundItemId, admin, { confirmPermanent: true });
      record('catalog.delete (background)', true, { itemId: backgroundItemId });
    } catch (err) {
      failed = true;
      record('catalog.delete (background)', false, { itemId: backgroundItemId, message: err?.detail || err?.message || String(err) });
    }
  }
  if (threadId) {
    try {
      const del = await kaltura.threads.delete([threadId], admin, { confirmPermanent: true });
      record('threads.delete', Boolean(del), { threadId, del });
    } catch (err) {
      failed = true;
      record('threads.delete', false, { threadId, message: err?.detail || err?.message || String(err) });
    }
  }
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

mkdirSync(resolve(repoRoot, 'live-verify-artifacts'), { recursive: true });
const outPath = resolve(repoRoot, `live-verify-artifacts/${runId}.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written: ${outPath}`);

process.exit(failed ? 1 : 0);
