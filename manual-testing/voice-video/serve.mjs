/**
 * Shared bits for the manual voice/video harnesses (mint.mjs, improv.mjs):
 * credentials from env or repo-root .env, a static server over the repo root
 * with a JSON /appInit route, and the LAN address to print.
 */
import { readFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PORT = Number(process.env.MANUAL_VERIFY_PORT) || 4789;
export const FOUR_HOURS = 4 * 60 * 60;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.jpeg': 'image/jpeg' };

/** AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET from the environment or a repo-root .env. Exits when missing. */
export function loadCredentials() {
  try {
    for (const line of readFileSync(resolve(repoRoot, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    // No .env file: credentials must already be in the environment.
  }
  const partnerId = process.env.AGENTIC_PARTNER_ID;
  const adminSecret = process.env.AGENTIC_ADMIN_SECRET;
  if (!partnerId || !adminSecret) {
    console.error('AGENTIC_PARTNER_ID and AGENTIC_ADMIN_SECRET are required (env or repo-root .env).');
    process.exit(1);
  }
  return { partnerId, adminSecret };
}

export function lanAddress() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

/** Serves the repo root plus `/appInit` (the given JSON). Rejects with EADDRINUSE when the port is taken. */
export function startServer(appInitData) {
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

export function reportListenError(err) {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Set MANUAL_VERIFY_PORT to another port and retry.`);
  else console.error(err);
}
