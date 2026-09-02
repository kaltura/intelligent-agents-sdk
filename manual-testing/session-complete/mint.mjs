#!/usr/bin/env node
/**
 * Manual cross-browser/device test harness for the `session_completed`
 * lifecycle signal (`src/experience/session-complete.js`) — see
 * manual-testing/session-complete/README.md for the full test plan.
 *
 * Mints a throwaway intellect + long-lived conversation KS, serves this
 * folder plus the real unmodified `src/` over the LAN, and prints a URL to
 * open on each test device. The app's `genieUrl` points back at THIS server,
 * which transparently proxies every `/assistant/*` and `/thread/*` call
 * through to the real production genie — so the conversation is still real
 * end-to-end, but every `/thread/session_completed` hit also gets logged
 * live, in this terminal, with a timestamp. That's the authoritative record
 * for flows where the page itself may die (real tab-close, mobile
 * backgrounding, OS tab-kill) before it could show anything on screen — the
 * same observability gap Playwright itself has (see
 * scripts/live-verify-session-complete.mjs's header comment), solved the
 * same way: verify server-side, not by trusting the dying page.
 *
 * Ctrl+C when done: deletes the throwaway intellect and exits.
 *
 * Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the environment
 * or a .env file in the repo root (same convention as scripts/live-verify.mjs).
 */
import { readFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { Readable } from 'node:stream';
import { Management } from '../../src/management/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

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

const PORT = Number(process.env.MANUAL_VERIFY_PORT) || 4787;
const FOUR_HOURS = 4 * 60 * 60;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
// Mirrors src/experience/chat-session.js's DEFAULT_GENIE_URL / src/experience/session.js's
// own copy of the same constant — override via GENIE_BASE_URL if that ever changes.
const GENIE_BASE_URL = process.env.GENIE_BASE_URL || 'https://genie.nvp1.ovp.kaltura.com';

function lanAddress() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// The app points its genieUrl at this server (same-origin, no browser-side CORS
// hop) so every real genie call is visible here — not just session_completed.
// We transparently forward each one to the real backend and relay the real
// response back, streamed rather than buffered so /assistant/converse's NDJSON
// stream stays live.
async function proxyToGenie(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  if (req.url.startsWith('/thread/session_completed')) {
    const threadId = JSON.parse(body.toString('utf8') || '{}').id;
    const hasAuth = !!req.headers.authorization;
    console.log(`[${new Date().toISOString()}] session_completed  thread=${threadId}  auth=${hasAuth ? 'present' : 'MISSING'}  from=${req.socket.remoteAddress}`);
  }

  const upstream = await fetch(`${GENIE_BASE_URL}${req.url}`, {
    method: req.method,
    headers: { 'Content-Type': req.headers['content-type'] || 'application/json', Authorization: req.headers.authorization || '' },
    body: body.length ? body : undefined,
  });
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'application/json' });
  if (!upstream.body) { res.end(); return; }
  Readable.fromWeb(upstream.body).pipe(res);
}

function startServer() {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && (req.url.startsWith('/assistant/') || req.url.startsWith('/thread/'))) {
      proxyToGenie(req, res).catch((err) => {
        console.error('Proxy error:', err?.message || err);
        if (!res.headersSent) res.writeHead(502);
        res.end('proxy error');
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
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(PORT, '0.0.0.0', () => resolvePromise(server));
  });
}

const kaltura = new Management({ partnerId, adminSecret });
let server;

async function cleanup() {
  console.log('\nShutting down…');
  if (server) await new Promise((r) => server.close(r));
  if (configId) {
    try {
      await kaltura.intellects.delete(configId, admin, { confirmPermanent: true });
      console.log(`Deleted throwaway intellect ${configId}.`);
    } catch (err) {
      console.error(`Could not delete intellect ${configId} — delete it manually:`, err?.detail || err?.message || err);
    }
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

const admin = await kaltura.sessions.createAdminToken({ ttlSeconds: FOUR_HOURS });

const runId = `manual-verify-session-complete-${Date.now()}`;
const intellect = await kaltura.intellects.create(
  { name: runId, status: 2, base_directive: 'You are a manual QA test bot for a lifecycle-signal test harness. Reply in under 20 words.' },
  admin,
);
const configId = intellect.configId;
console.log(`Throwaway intellect: ${configId}`);

const conv = await kaltura.sessions.createConversationToken({ configId, ttlSeconds: FOUR_HOURS });
const token = conv.ks;

try {
  server = await startServer();
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set MANUAL_VERIFY_PORT to another port and retry.`);
  } else {
    console.error(err);
  }
  await cleanup();
  process.exit(1);
}

const host = lanAddress();
const url = `http://${host}:${PORT}/manual-testing/session-complete/app.html?token=${encodeURIComponent(token)}`;

console.log('');
console.log('Open this URL on each test device (same Wi-Fi network):');
console.log('');
console.log(`  ${url}`);
console.log('');
console.log(`Conversation KS expires in ~${Math.floor(conv.secondsRemaining() / 60)} minutes.`);
console.log('Every real session_completed POST this server receives will be logged below.');
console.log('Ctrl+C to finish and delete the throwaway intellect.');
console.log('');
