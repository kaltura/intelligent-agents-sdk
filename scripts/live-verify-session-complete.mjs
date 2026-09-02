#!/usr/bin/env node
/**
 * Live-BROWSER smoke test for the `session_completed` signal
 * (`KalturaChatSession`'s `disconnect()`/lifecycle/presence mechanism —
 * `src/experience/session-complete.js`) — real Kaltura API, real conversation
 * KS, real headless Chromium, real `POST {genieUrl}/thread/session_completed`.
 *
 * Unit/e2e tests (`test/unit/session-complete.test.js`) cover this logic
 * against injected fakes. This script instead exercises the browser-native
 * primitives a fake can't stand in for: a real `visibilitychange`/`pagehide`
 * dispatched by an actual browser event loop, a real cross-tab
 * `BroadcastChannel`, and a real fetch surviving a real page navigation via
 * `keepalive`. It settles the one assumption the design itself calls out as
 * unverified from static analysis alone: that the ordinary conversation KS is
 * accepted by `/thread/session_completed` (a 401/403 here would mean the
 * design needs to move server-side instead).
 *
 * Provisions one throwaway intellect + one conversation KS, drives several
 * headless-Chromium pages against `scripts/live-verify-session-complete.html`
 * (served locally, importing the real unmodified `src/experience/chat-session.js`),
 * asserts on real network activity, then tears down the intellect. Most scenarios
 * hit the real production genieUrl and assert via Playwright's response tracking;
 * the real-navigation scenario instead routes at our own local server, since
 * Playwright doesn't reliably report network events for a request whose document
 * is mid-navigation-teardown even though the request is genuinely sent.
 *
 * Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the environment
 * or a .env file in the repo root (same convention as scripts/live-verify.mjs).
 *
 * Engine: LIVE_VERIFY_BROWSER=chromium|firefox|webkit (default chromium) — CI
 * runs all three as a matrix to catch cross-engine gaps in fetch(keepalive),
 * BroadcastChannel and visibilitychange semantics. webkit here is desktop
 * Safari's engine, not iOS Safari — real mobile OS backgrounding/tab-kill
 * behavior isn't reachable from any Playwright engine; see
 * manual-testing/session-complete/ for that coverage.
 */
import { readFileSync, writeFileSync, mkdirSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
import { Management } from '../src/management/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const ENGINES = { chromium, firefox, webkit };
const engineName = process.env.LIVE_VERIFY_BROWSER || 'chromium';
const engine = ENGINES[engineName];
if (!engine) {
  console.error(`Unknown LIVE_VERIFY_BROWSER "${engineName}" — expected one of: ${Object.keys(ENGINES).join(', ')}`);
  process.exit(1);
}

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
const runId = `ci-live-verify-session-complete-${engineName}-${Date.now()}`;
const artifact = { runId, startedAt, partnerId, engine: engineName, steps: [] };

function record(step, ok, detail) {
  artifact.steps.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${step}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

function assert(cond, message, detail) {
  if (!cond) {
    const err = new Error(message);
    err.detail = detail;
    throw err;
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

/**
 * Serves the fixture/SDK files, and also records hits on `/thread/session_completed` —
 * used only by the real-pagehide-via-navigation scenario. Playwright's `page.on('response')`
 * silently drops network events for a request whose document is mid-navigation-teardown
 * (confirmed by isolated repro: the real HTTP request lands at a server we control even
 * though Playwright never reports it back). Routing that one scenario's `genieUrl` at this
 * local server sidesteps the observability gap without changing what the SDK actually does.
 */
function startServer() {
  const sessionCompletedHits = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/thread/session_completed')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        sessionCompletedHits.push({ at: Date.now(), authorization: req.headers.authorization, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      return;
    }
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
  return new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise({ server, sessionCompletedHits })));
}

/** Opens a fixture page, tracking every response it sees for the session's lifetime (survives navigation on the same Page). */
async function openPage(context, port, { token, threadId, hiddenGraceMs, genieUrl } = {}) {
  const page = await context.newPage();
  const responses = [];
  page.on('response', (res) => responses.push({ url: res.url(), status: res.status(), method: res.request().method() }));
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  const qs = new URLSearchParams();
  if (token) qs.set('token', token);
  if (threadId) qs.set('threadId', threadId);
  if (hiddenGraceMs != null) qs.set('hiddenGraceMs', String(hiddenGraceMs));
  if (genieUrl) qs.set('genieUrl', genieUrl);

  await page.goto(`http://127.0.0.1:${port}/scripts/live-verify-session-complete.html?${qs}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
  return { page, responses, pageErrors };
}

function sessionCompletedRequests(responses) {
  return responses.filter((r) => r.url.endsWith('/thread/session_completed'));
}

async function waitFor(fn, { timeout = 10000, polling = 200 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, polling));
  }
}

const kaltura = new Management({ partnerId, adminSecret });
let admin;
let configId;
let server;
let sessionCompletedHits;
let browser;
let failed = false;

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  const intellect = await kaltura.intellects.create(
    { name: runId, status: 2, base_directive: 'You are a CI smoke-test bot. Reply in under 20 words.' },
    admin,
  );
  configId = intellect.configId;
  record('intellect-create', true, { configId });

  const conv = await kaltura.sessions.createConversationToken({ configId });
  record('conversation-token-mint', true, { secondsRemaining: conv.secondsRemaining() });
  const token = conv.ks;

  ({ server, sessionCompletedHits } = await startServer());
  const port = server.address().port;
  record('local-server-start', true, { port });

  browser = await engine.launch();
  record('browser-launch', true, { engine: engineName });
  // All pages share one BrowserContext — `browser.newPage()` would give each page its
  // own isolated context (like separate incognito profiles), and BroadcastChannel
  // presence can't cross that boundary. Real users share one context across tabs.
  const context = await browser.newContext();

  // 1. Golden path: connect, one real turn, disconnect() -> real POST + sessionCompleted event.
  //    Also settles the one static-analysis-only assumption: the ordinary conversation KS
  //    is accepted by /thread/session_completed (a 401/403 here means 401/403 in production).
  {
    const { page, responses } = await openPage(context, port, { token });
    await page.evaluate(() => window.testConnect());
    const { threadId } = await page.evaluate((text) => window.testSend(text), 'Golden path live-verify turn.');
    assert(!!threadId, 'golden path: no threadId after first turn');
    await page.evaluate((opts) => window.testDisconnect(opts), undefined);
    await waitFor(() => sessionCompletedRequests(responses).length > 0);
    const reqs = sessionCompletedRequests(responses);
    assert(reqs.every((r) => r.status === 200), 'golden path: session_completed did not 200', reqs);
    const events = await page.evaluate(() => window.__events);
    assert(events.some((e) => e.payload?.reason === 'disconnect' && e.payload?.sent === true), 'golden path: no sessionCompleted{reason:disconnect,sent:true} event', events);
    record('golden-path-disconnect', true, { threadId, sessionCompletedStatus: reqs.map((r) => r.status) });
    await page.close();
  }

  // 2. completeThread() after teardown rejects invalid_state.
  {
    const { page, responses } = await openPage(context, port, { token });
    await page.evaluate(() => window.testConnect());
    await page.evaluate((text) => window.testSend(text), 'Post-teardown completeThread live-verify turn.');
    await page.evaluate(() => window.testDisconnect());
    await waitFor(() => sessionCompletedRequests(responses).length > 0);
    const outcome = await page.evaluate(async () => {
      try { await window.testCompleteThread(); return { threw: false }; }
      catch (e) { return { threw: true, code: e?.code }; }
    });
    assert(outcome.threw && outcome.code === 'invalid_state', 'completeThread() after teardown did not reject invalid_state', outcome);
    record('complete-thread-after-teardown-rejects', true, outcome);
    await page.close();
  }

  // 3. No threadId yet -> disconnect() sends nothing.
  {
    const { page, responses } = await openPage(context, port, { token });
    await page.evaluate(() => window.testConnect());
    await page.evaluate(() => window.testDisconnect());
    await page.waitForTimeout(500);
    assert(sessionCompletedRequests(responses).length === 0, 'no-threadId disconnect() sent a signal it should not have', responses);
    record('no-threadid-disconnect-is-noop', true, {});
    await page.close();
  }

  // 4. Cross-tab BroadcastChannel presence: thread pre-minted server-side (no browser
  //    tab has ever held it), then two tabs seeded with it via cfg.threadId. First
  //    close is suppressed (a peer remains); last tab standing fires for real.
  {
    const reply = await kaltura.converseOnce(configId, 'Pre-mint a thread for the cross-tab presence live-verify test.', {}, conv);
    const threadId = reply.threadId;
    record('cross-tab-thread-premint', true, { threadId });

    const tabA = await openPage(context, port, { token, threadId });
    const tabB = await openPage(context, port, { token, threadId });
    await tabA.page.evaluate(() => window.testConnect());
    await tabB.page.evaluate(() => window.testConnect());
    // Let both tabs' presence channels exchange hello/ack before either decides.
    await tabA.page.waitForTimeout(500);

    await tabA.page.evaluate(() => window.testDisconnect());
    await tabA.page.waitForTimeout(500);
    assert(sessionCompletedRequests(tabA.responses).length === 0, 'cross-tab: first tab should have been suppressed (peer still alive)', tabA.responses);
    const eventsA = await tabA.page.evaluate(() => window.__events);
    assert(eventsA.some((e) => e.payload?.suppressed === true), 'cross-tab: first tab did not report suppressed:true', eventsA);
    record('cross-tab-first-close-suppressed', true, { threadId });

    await tabB.page.evaluate(() => window.testDisconnect());
    await waitFor(() => sessionCompletedRequests(tabB.responses).length > 0);
    const reqsB = sessionCompletedRequests(tabB.responses);
    assert(reqsB.every((r) => r.status === 200), 'cross-tab: last tab standing did not get a real 200', reqsB);
    record('cross-tab-last-tab-fires', true, { threadId, status: reqsB.map((r) => r.status) });

    await tabA.page.close();
    await tabB.page.close();
  }

  // 5. Hidden-grace timer: real visibilitychange, wait past the grace window -> fires.
  {
    const graceMs = 2000;
    const { page, responses } = await openPage(context, port, { token, hiddenGraceMs: graceMs });
    await page.evaluate(() => window.testConnect());
    await page.evaluate((text) => window.testSend(text), 'Hidden-grace live-verify turn.');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => sessionCompletedRequests(responses).length > 0, { timeout: graceMs + 5000 });
    const reqs = sessionCompletedRequests(responses);
    assert(reqs.every((r) => r.status === 200), 'hidden-grace: session_completed did not 200', reqs);
    const events = await page.evaluate(() => window.__events);
    assert(events.some((e) => e.payload?.reason === 'hidden_grace'), 'hidden-grace: no sessionCompleted{reason:hidden_grace} event', events);
    record('hidden-grace-fires', true, { status: reqs.map((r) => r.status) });
    await page.close();
  }

  // 6. Hidden-grace cancelled by returning to visible before the deadline.
  {
    const graceMs = 2000;
    const { page, responses } = await openPage(context, port, { token, hiddenGraceMs: graceMs });
    await page.evaluate(() => window.testConnect());
    await page.evaluate((text) => window.testSend(text), 'Hidden-grace-cancel live-verify turn.');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(graceMs / 2);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(graceMs);
    assert(sessionCompletedRequests(responses).length === 0, 'hidden-grace-cancel: signal fired despite returning to visible', responses);
    record('hidden-grace-cancelled-on-return-to-visible', true, {});
    await page.evaluate(() => window.testDisconnect());
    await page.close();
  }

  // 7. Real pagehide via genuine browser navigation — fetch must survive the unload
  //    (this is what `keepalive:true` is for). Routed at our own local server instead
  //    of the real genieUrl: Playwright's page-level network events don't survive a
  //    request whose document is mid-navigation-teardown, even though the request
  //    really is sent (confirmed by isolated repro against a server we control) — so
  //    verify server-side receipt here rather than client-side response tracking.
  {
    // genieUrl is one shared setting for every call this session makes, including the
    // real conversation endpoint — so the thread is pre-minted server-side (as in
    // scenario 4) and seeded via cfg.threadId, keeping this page's genieUrl local
    // without ever needing it to reach the real conversation endpoint too.
    const reply = await kaltura.converseOnce(configId, 'Pre-mint a thread for the real-pagehide live-verify test.', {}, conv);
    const threadId = reply.threadId;
    const localGenieUrl = `http://127.0.0.1:${port}`;
    const { page } = await openPage(context, port, { token, threadId, genieUrl: localGenieUrl });
    await page.evaluate(() => window.testConnect());
    const hitsBefore = sessionCompletedHits.length;
    await page.goto(`http://127.0.0.1:${port}/scripts/live-verify-session-complete.html?id=after-pagehide`, { waitUntil: 'domcontentloaded' });
    await waitFor(() => sessionCompletedHits.length > hitsBefore);
    const hit = sessionCompletedHits[sessionCompletedHits.length - 1];
    assert(hit.authorization === `KS ${token}`, 'real pagehide: session_completed POST carried the wrong Authorization header', hit);
    assert(JSON.parse(hit.body).id === threadId, 'real pagehide: session_completed POST carried the wrong thread id', hit);
    record('real-pagehide-survives-navigation', true, { threadId });
    await page.close();
  }

  // 8. bfcache freeze (pagehide, persisted:true) — the SDK can't survive the freeze
  //    anyway, so it fires immediately by default.
  {
    const { page, responses } = await openPage(context, port, { token });
    await page.evaluate(() => window.testConnect());
    await page.evaluate((text) => window.testSend(text), 'bfcache pagehide live-verify turn.');
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await waitFor(() => sessionCompletedRequests(responses).length > 0);
    const reqs = sessionCompletedRequests(responses);
    assert(reqs.every((r) => r.status === 200), 'bfcache pagehide: session_completed did not 200', reqs);
    const events = await page.evaluate(() => window.__events);
    assert(events.some((e) => e.payload?.reason === 'pagehide_bfcache'), 'bfcache pagehide: no sessionCompleted{reason:pagehide_bfcache} event', events);
    record('bfcache-pagehide-fires', true, { status: reqs.map((r) => r.status) });
    await page.close();
  }
} catch (err) {
  failed = true;
  record('live-verify-session-complete', false, { message: err?.message || String(err), detail: err?.detail });
} finally {
  if (browser) { try { await browser.close(); } catch { /* best-effort teardown */ } }
  if (server) { try { await new Promise((r) => server.close(r)); } catch { /* best-effort teardown */ } }
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
