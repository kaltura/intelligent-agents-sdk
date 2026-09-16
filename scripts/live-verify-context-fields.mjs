#!/usr/bin/env node
/**
 * Live runtime-effect check for `KalturaAvatarSession`'s `contextId`/`contextType`
 * options — the `sys__context_id`/`sys__context_type` reserved template variables.
 *
 * Regression guard: the wire payload's `kaltura.contextId`/`kaltura.contextType`
 * keys are read by the agentic backend as camelCase. A prior snake_case
 * (`context_id`/`context_type`) key mismatch meant the backend's field checks
 * never matched, so the values were silently dropped and the reserved
 * variables always rendered empty — with no error anywhere in the stack. This
 * script asserts the wire-level key names directly, not just the end-to-end
 * outcome, so a casing regression fails fast instead of silently reproducing
 * that bug.
 *
 * Drives two real conversations against one throwaway intellect: one with
 * `contextId`/`contextType` set, one without. Both are visible in the
 * `sys__context_id`/`sys__context_type` prompt block, which is asserted on
 * the transcript{type:'final'} text (the exact text handed to TTS).
 *
 * Pattern reused from scripts/live-verify-force-language.mjs: credential
 * loading, static file server, headless Chromium with fake-media flags, full
 * teardown + independent reverify-gone checks in `finally`, artifacts written
 * to live-verify-artifacts/. The probe category is created idempotently
 * (`knowledge.findOrCreateCategory`) and reused across runs — the SDK has no
 * category-delete surface, so a fixed, clearly-named fixture category avoids
 * accumulating orphans.
 */
import { readFileSync, writeFileSync, mkdirSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
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
  // No .env file -- credentials must already be in the environment.
}

const partnerId = process.env.AGENTIC_PARTNER_ID;
const adminSecret = process.env.AGENTIC_ADMIN_SECRET;

if (!partnerId || !adminSecret) {
  console.error('AGENTIC_PARTNER_ID and AGENTIC_ADMIN_SECRET are required (env or repo-root .env).');
  process.exit(1);
}

const runId = `context-fields-runtime-check-${Date.now()}`;
const CONTEXT_TYPE = 'category';
const artifact = { runId, startedAt: new Date().toISOString(), partnerId, steps: [] };

function record(step, ok, detail) {
  artifact.steps.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${step}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}
let failed = false;
function check(step, ok, detail) { if (!ok) failed = true; record(step, ok, detail); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
function startServer() {
  const server = createServer((req, res) => {
    const urlPath = normalize(decodeURIComponent(req.url.split('?')[0]));
    const filePath = resolve(repoRoot, `.${urlPath}`);
    if (!filePath.startsWith(repoRoot) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  });
  return new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise(server)));
}

const kaltura = new Management({ partnerId, adminSecret });
let admin;
let provisioned;
let server;
let browser;
let createdSoFar = null;

const prompts = [
  { key: 'name', label: 'name', headerTemplate: 'Your name is:', type: 'custom', value: 'Live-Verify Context Probe' },
  { key: 'contextProbe', label: 'contextProbe', headerTemplate: 'Context probe (authoritative, current):', type: 'custom', value: 'CTXID={{ sys__context_id }} CTXTYPE={{ sys__context_type }}' },
  { key: 'rules', label: 'rules', headerTemplate: 'Rules you must obey without exception:', type: 'custom', value: 'When asked to report the context probe, reply with EXACTLY the "Context probe" section content above, verbatim, character for character, and nothing else — no greeting, no punctuation added.' },
];

async function runProbe(port, label, { withContext, contextId }) {
  const widget = await kaltura.sessions.createWidgetToken({ widgetId: provisioned.widgetId });
  const init = await kaltura.application.appInit(widget.ks);
  record(`${label}-app-init`, true, { conversationManagerUrl: init.conversationManagerUrl });

  const qs = new URLSearchParams({
    token: init.ks,
    conversationManagerUrl: init.conversationManagerUrl,
    srsBaseUrl: init.srsBaseUrl,
    turnServerUrl: init.turnServerUrl,
  });
  if (withContext) { qs.set('contextId', contextId); qs.set('contextType', CONTEXT_TYPE); }

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto(`http://127.0.0.1:${port}/scripts/live-verify-context-fields.html?${qs}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
  await page.evaluate(() => window.testConnect());
  record(`${label}-connected`, true, {});

  // Let the greeting play out before speaking, so the probe reply isn't
  // interleaved with it under AVATAR_ONLY turn-taking.
  await page.waitForFunction(
    () => (window.__events || []).some((e) => e.type === 'avatarStopTalking'),
    null, { timeout: 30000, polling: 500 },
  ).catch(() => {});
  await page.waitForTimeout(3000);

  await page.evaluate(() => window.testSpeak('Please report the context probe now.'));
  await page.waitForFunction(
    () => (window.__events || []).some((e) => e.type === 'transcript' && e.ttype === 'final' && e.text.includes('CTXID=')),
    null, { timeout: 45000, polling: 500 },
  );

  const events = await page.evaluate(() => window.__events);
  const finalText = events.filter((e) => e.type === 'transcript' && e.ttype === 'final').pop()?.text || '';
  const logText = await page.locator('#log').textContent();
  await page.evaluate(() => window.testDisconnect());
  await page.close();
  return { finalText, pageErrors, logText };
}

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  provisioned = await kaltura.provision({ brief: 'A CI live-verify probe bot for sys__context_id/sys__context_type', ks: admin.ks });
  record('provision', true, {
    configId: provisioned.configId, agentId: provisioned.agentId,
    avatarId: provisioned.avatarId, widgetId: provisioned.widgetId,
  });

  // Idempotent: reused across runs. The SDK has no category-delete surface,
  // so this fixture accumulates zero orphans instead of one per run.
  const category = await kaltura.knowledge.findOrCreateCategory({ name: 'sdk-live-verify-context-fields' }, admin.ks);
  const contextId = String(category.id);
  record('category-find-or-create', true, { categoryId: contextId });

  await kaltura.intellects.setPrompts(provisioned.configId, prompts, admin.ks, { knownVars: [] });
  record('set-prompts', true, {});

  server = await startServer();
  const port = server.address().port;
  record('local-server-start', true, { port });

  browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });

  const withCtx = await runProbe(port, 'with-context', { withContext: true, contextId });
  const joinLine = withCtx.logText.split('\n').find((l) => l.startsWith('OUT join payload='));
  const joinPayload = joinLine ? JSON.parse(joinLine.slice('OUT join payload='.length)) : null;
  // Wire-level regression guard: these are the exact keys the backend reads.
  check('with-context-join-payload-uses-camelcase-keys',
    joinPayload?.kaltura?.contextId === contextId && joinPayload?.kaltura?.contextType === CONTEXT_TYPE,
    { kalturaKeys: joinPayload ? Object.keys(joinPayload.kaltura) : null });
  check('with-context-echoes-contextId', withCtx.finalText.includes(`CTXID=${contextId}`), { text: withCtx.finalText });
  check('with-context-echoes-contextType', withCtx.finalText.includes(`CTXTYPE=${CONTEXT_TYPE}`), { text: withCtx.finalText });
  if (withCtx.pageErrors.length) record('with-context-page-errors', false, { pageErrors: withCtx.pageErrors });

  const withoutCtx = await runProbe(port, 'without-context', { withContext: false, contextId });
  check('without-context-is-empty', withoutCtx.finalText.includes('CTXID= CTXTYPE='), { text: withoutCtx.finalText });
  if (withoutCtx.pageErrors.length) record('without-context-page-errors', false, { pageErrors: withoutCtx.pageErrors });
} catch (err) {
  failed = true;
  createdSoFar = provisioned || null;
  record('context-fields-runtime-check', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  if (browser) { try { await browser.close(); } catch { /* best-effort teardown */ } }
  if (server) { try { await new Promise((r) => server.close(r)); } catch { /* best-effort teardown */ } }

  const ids = provisioned || createdSoFar || {};
  if (ids.agentId) {
    try { await kaltura.agents.delete(ids.agentId, admin.ks, { confirmPermanent: true }); record('agent-delete', true, { agentId: ids.agentId }); }
    catch (err) { failed = true; record('agent-delete', false, { agentId: ids.agentId, message: err?.detail || err?.message || String(err) }); }
  }
  if (ids.avatarId) {
    try { await kaltura.avatars.delete(ids.avatarId, admin.ks, { confirmPermanent: true }); record('avatar-delete', true, { avatarId: ids.avatarId }); }
    catch (err) { failed = true; record('avatar-delete', false, { avatarId: ids.avatarId, message: err?.detail || err?.message || String(err) }); }
  }
  if (ids.configId) {
    try { await kaltura.intellects.delete(ids.configId, admin.ks, { confirmPermanent: true }); record('intellect-delete', true, { configId: ids.configId }); }
    catch (err) { failed = true; record('intellect-delete', false, { configId: ids.configId, message: err?.detail || err?.message || String(err) }); }
  }

  // Independent re-verification: a real not-found, not just a 200 from delete.
  if (ids.agentId) {
    try { await kaltura.agents.get(ids.agentId, admin.ks); record('agent-reverify-gone', false, { agentId: ids.agentId, note: 'still fetchable after delete' }); failed = true; }
    catch (err) { record('agent-reverify-gone', true, { agentId: ids.agentId, code: err?.code || String(err) }); }
  }
  if (ids.avatarId) {
    try { await kaltura.avatars.get(ids.avatarId, admin.ks); record('avatar-reverify-gone', false, { avatarId: ids.avatarId, note: 'still fetchable after delete' }); failed = true; }
    catch (err) { record('avatar-reverify-gone', true, { avatarId: ids.avatarId, code: err?.code || String(err) }); }
  }
  if (ids.configId) {
    try { await kaltura.intellects.get(ids.configId, admin.ks); record('intellect-reverify-gone', false, { configId: ids.configId, note: 'still fetchable after delete' }); failed = true; }
    catch (err) { record('intellect-reverify-gone', true, { configId: ids.configId, code: err?.code || String(err) }); }
  }
}

artifact.finishedAt = new Date().toISOString();
artifact.ok = !failed;

mkdirSync(resolve(repoRoot, 'live-verify-artifacts'), { recursive: true });
const outPath = resolve(repoRoot, `live-verify-artifacts/${runId}.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written: ${outPath}`);

process.exit(failed ? 1 : 0);
