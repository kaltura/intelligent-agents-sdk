#!/usr/bin/env node
/**
 * Minimal dev server backing every examples/*.html file's `fetch('/appInit')` stub,
 * and serving the repo statically so their relative `../src/...` imports resolve.
 *
 * Run: AGENTIC_PARTNER_ID=… AGENTIC_WIDGET_ID=… node examples/dev-server.mjs
 * No AGENTIC_WIDGET_ID? Set AGENTIC_ADMIN_SECRET instead and it provisions a
 * throwaway agent on startup (admin secret stays server-side, never sent to the browser).
 *
 * Then open http://localhost:8091/examples/<example>.html — e.g. event-timing.html, browser-experience.html.
 * (repo-root-relative, so each example's `../src/...` import resolves correctly)
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
  // Static files: only from the repo root, never above it (the harness pages import ../src/...).
  const urlPath = (req.url || '/').split('?')[0];
  const rel = urlPath === '/' ? 'examples/event-timing.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const filePath = path.resolve(REPO_ROOT, rel);
  if (!filePath.startsWith(REPO_ROOT + path.sep)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Serving examples/*.html + /appInit on http://localhost:${PORT}/`));
