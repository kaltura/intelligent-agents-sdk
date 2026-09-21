#!/usr/bin/env node
/**
 * Minimal dev server backing every examples/*.html file's `fetch('/appInit')` stub,
 * and serving the repo statically so their relative `../src/...` imports resolve.
 *
 * Run: AGENTIC_PARTNER_ID=… AGENTIC_WIDGET_ID=… node examples/dev-server.mjs
 * No AGENTIC_WIDGET_ID? Set AGENTIC_ADMIN_SECRET instead and it provisions a
 * throwaway agent on startup (admin secret stays server-side, never sent to the browser).
 *
 * Then open http://127.0.0.1:8091/examples/<example>.html — e.g. event-timing.html, browser-experience.html.
 * (repo-root-relative, so each example's `../src/...` import resolves correctly)
 *
 * Listens on 127.0.0.1 only, and serves files from examples/ and src/ only (no dotfiles):
 * `/appInit` mints a real widget token with your admin secret, so nothing else on the
 * network should be able to reach it, and a repo-root `.env` must never be fetchable.
 *
 * NOTE (dev-local path): imports below resolve against the repo's src/ tree.
 * npm consumers should instead import from '@kaltura/intelligent-agents/management'.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';

const EXAMPLES_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(EXAMPLES_DIR, '..');
const PORT = Number(process.env.PORT || 8091);

const partnerId = process.env.AGENTIC_PARTNER_ID;
if (!partnerId) { console.error('Set AGENTIC_PARTNER_ID'); process.exit(2); }

const kaltura = new Management({
  partnerId,
  adminSecret: process.env.AGENTIC_ADMIN_SECRET,
  agenticUrl: process.env.AGENTIC_URL,
  genieUrl: process.env.GENIE_URL,
  ovpUrl: process.env.OVP_URL,
});

let widgetId = process.env.AGENTIC_WIDGET_ID;
if (!widgetId) {
  if (!process.env.AGENTIC_ADMIN_SECRET) {
    console.error('Set AGENTIC_WIDGET_ID (an existing agent), or AGENTIC_ADMIN_SECRET to provision a throwaway one');
    process.exit(2);
  }
  const admin = await kaltura.sessions.createAdminToken();
  const agent = await kaltura.provision({ brief: process.env.AGENTIC_BRIEF || 'A minimal test agent for example harnesses', ks: admin.ks });
  widgetId = agent.widgetId;
  console.log('Provisioned a throwaway agent:', { configId: agent.configId, agentId: agent.agentId, widgetId });
}

// Resolved once, with a trailing separator, so a served path is a plain prefix
// match on the resolved request path and nothing outside these two trees can match.
const SERVED_ROOTS = ['examples', 'src'].map((d) => path.resolve(REPO_ROOT, d) + path.sep);
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.json': 'application/json', '.jpeg': 'image/jpeg' };

const server = http.createServer(async (req, res) => {
  if (req.url === '/appInit') {
    try {
      const widgetToken = await kaltura.sessions.createWidgetToken({ widgetId });
      const init = await kaltura.application.appInit(widgetToken.ks);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(init));
    } catch (err) {
      console.error('appInit failed:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'appInit failed; see the dev-server log' }));
    }
    return;
  }
  // Static files: only examples/ and src/ (the harness pages import ../src/...), never a
  // dotfile, never anything else under the repo root (a local `.env` lives there).
  const urlPath = (req.url || '/').split('?')[0];
  const rel = urlPath === '/' ? 'examples/event-timing.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const resolved = path.resolve(REPO_ROOT, rel);
  const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); };
  // The resolved path is only used after it is confirmed to sit under one of the
  // two served roots. `..` segments are already collapsed by resolve(), so a
  // prefix match on the resolved path is the whole containment check.
  let filePath;
  if (resolved.startsWith(SERVED_ROOTS[0])) filePath = resolved;
  else if (resolved.startsWith(SERVED_ROOTS[1])) filePath = resolved;
  else { notFound(); return; }
  const hasDotSegment = path.relative(REPO_ROOT, filePath).split(path.sep).some((seg) => seg.startsWith('.'));
  if (hasDotSegment) { notFound(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { notFound(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Serving examples/*.html + /appInit on http://127.0.0.1:${PORT}/ (loopback only)`));
