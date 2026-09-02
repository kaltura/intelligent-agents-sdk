#!/usr/bin/env node
/**
 * Manual cross-browser/device test harness for the real avatar pipeline
 * (mic capture → ASR uplink → STV/WHEP video downlink → chroma-key
 * compositing) — see manual-testing/voice-video/README.md for the full test
 * plan and for exactly which parts of this are already covered by
 * automation (scripts/live-verify-browser.mjs, .github/workflows/live-verify.yml)
 * versus what only a real device/browser/network can exercise.
 *
 * Provisions a throwaway agent+avatar+intellect, serves the real unmodified
 * examples/chroma-key-avatar.html plus a real /appInit route over the LAN,
 * and prints a URL to open on each test device.
 *
 * Ctrl+C when done: deletes the throwaway agent/avatar/intellect and exits.
 *
 * Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the environment
 * or a .env file in the repo root (same convention as scripts/live-verify.mjs).
 */
import { readFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
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

const PORT = Number(process.env.MANUAL_VERIFY_PORT) || 4789;
const FOUR_HOURS = 4 * 60 * 60;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

function lanAddress() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function startServer(appInitData) {
  const server = createServer((req, res) => {
    if (req.url === '/appInit') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(appInitData));
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
/** @type {any} */
let provisioned = null;

async function cleanup() {
  console.log('\nShutting down…');
  if (server) await new Promise((r) => server.close(r));
  if (provisioned) {
    const admin = await kaltura.sessions.createAdminToken().catch(() => null);
    if (admin) {
      await kaltura.agents.delete(provisioned.agentId, admin.ks, { confirmPermanent: true }).catch((err) => console.error('agent delete failed:', err?.message || err));
      await kaltura.avatars.delete(provisioned.avatarId, admin.ks, { confirmPermanent: true }).catch((err) => console.error('avatar delete failed:', err?.message || err));
      await kaltura.intellects.delete(provisioned.configId, admin.ks, { confirmPermanent: true }).catch((err) => console.error('intellect delete failed:', err?.message || err));
      console.log(`Deleted throwaway agent/avatar/intellect (${provisioned.agentId}).`);
    }
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

const admin = await kaltura.sessions.createAdminToken({ ttlSeconds: FOUR_HOURS });
provisioned = await kaltura.provision({ brief: 'A friendly manual-QA greeter avatar', ks: admin.ks });
console.log(`Throwaway agent/avatar/intellect: ${provisioned.agentId} / ${provisioned.avatarId} / ${provisioned.configId}`);

let widgetId = provisioned.widgetId;
if (!widgetId) widgetId = (await kaltura.application.resolveWidgetId(provisioned.agentId, admin.ks))?.widgetId;
const widget = await kaltura.sessions.createWidgetToken({ widgetId, ttlSeconds: FOUR_HOURS });
const init = await kaltura.application.appInit(widget.ks);

try {
  server = await startServer(init);
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
const url = `http://${host}:${PORT}/examples/chroma-key-avatar.html`;

console.log('');
console.log('Open this URL on each test device (same Wi-Fi network):');
console.log('');
console.log(`  ${url}`);
console.log('');
console.log('For a device that can\'t reach your LAN, tunnel this port instead (e.g. `ngrok http 4789`) and use the tunnel URL.');
console.log('Ctrl+C to finish and delete the throwaway agent/avatar/intellect.');
console.log('');
