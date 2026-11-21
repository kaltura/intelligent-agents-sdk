#!/usr/bin/env node
/**
 * Local server for the showroom example. Loopback only.
 *
 *   node --env-file=.env examples/showroom/server.mjs
 *
 * It serves `examples/showroom/` and `src/` (never dotfiles), and answers
 * `GET /appInit` by minting a widget token for the agent that
 * `agent/provision.mjs` created. The admin secret stays in this process.
 * With no credentials it still serves the page, so `?demo` works offline.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../../src/management/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const PORT = Number(process.env.PORT || 8092);
const ROOTS = [path.join(REPO, 'examples', 'showroom'), path.join(REPO, 'src')].map((d) => d + path.sep);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.webm': 'video/webm', '.mp4': 'video/mp4' };

function widgetId() {
  if (process.env.AGENTIC_WIDGET_ID) return process.env.AGENTIC_WIDGET_ID;
  try { return JSON.parse(fs.readFileSync(path.join(HERE, 'agent', 'agent.json'), 'utf8')).widgetId; } catch { return null; }
}

const live = process.env.AGENTIC_PARTNER_ID && process.env.AGENTIC_ADMIN_SECRET;
const kaltura = live ? new Management({
  partnerId: process.env.AGENTIC_PARTNER_ID, adminSecret: process.env.AGENTIC_ADMIN_SECRET,
  agenticUrl: process.env.AGENTIC_URL, genieUrl: process.env.GENIE_URL, ovpUrl: process.env.OVP_URL,
}) : null;

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

const server = http.createServer(async (req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (urlPath.includes('\0')) { res.writeHead(400); return res.end(); }
  if (urlPath === '/appInit') {
    const id = widgetId();
    if (!kaltura || !id) return json(res, 503, { error: 'No agent yet. Run agent/provision.mjs, or open the page with ?demo.' });
    try {
      const token = await kaltura.sessions.createWidgetToken({ widgetId: id });
      return json(res, 200, await kaltura.application.appInit(token.ks));
    } catch (err) {
      console.error('appInit failed:', err?.message || err);
      return json(res, 500, { error: 'appInit failed. See the server log.' });
    }
  }
  if (urlPath === '/') { res.writeHead(302, { Location: '/examples/showroom/index.html' }); return res.end(); }
  const rel = urlPath.replace(/^\/+/, '');
  const file = path.resolve(REPO, rel);
  const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); };
  const hasDot = path.relative(REPO, file).split(path.sep).some((seg) => seg.startsWith('.'));
  // `agent/` holds the provisioning script and its saved ids, which the browser never needs.
  const inAgent = file.startsWith(path.join(HERE, 'agent') + path.sep);
  if (!ROOTS.some((r) => file.startsWith(r)) || hasDot || inAgent) return notFound();
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound();
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' };
    // Safari only plays video from servers that answer byte-range requests.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!range) { res.writeHead(200, { ...headers, 'Content-Length': st.size }); return fs.createReadStream(file).pipe(res); }
    const start = range[1] === '' ? Math.max(0, st.size - Number(range[2])) : Number(range[1]);
    const end = range[1] === '' || range[2] === '' ? st.size - 1 : Math.min(Number(range[2]), st.size - 1);
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Showroom on http://127.0.0.1:${PORT}/  (add ?demo for the scripted agent, ?kiosk for a shared screen)`);
  if (!live) console.log('No credentials set: live mode is off, demo mode works.');
});
