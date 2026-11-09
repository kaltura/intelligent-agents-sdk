#!/usr/bin/env node
/**
 * One Face, many backgrounds, live on one page.
 *
 *   AGENTIC_PARTNER_ID=… AGENTIC_ADMIN_SECRET=… node examples/face-and-backgrounds/serve.mjs [--ttl-minutes N] [--port N]
 *
 * Uploads assets/face.png once (a transparent PNG cutout) and each assets/bg-*.jpg, then builds one avatar
 * per background (plus one flat color) and one agent per avatar, all on a single shared intellect.
 * Serves the page on 127.0.0.1. Ctrl+C or the time limit (default 60 minutes) deletes everything it created.
 * The admin secret and admin token stay in this process. The page gets only widget-scoped sessions.
 *
 * NOTE (dev-local path): the import below resolves against the repo's src/ tree.
 * npm consumers should import from '@kaltura/intelligent-agents/management'.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../../src/management/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sdkSrc = path.resolve(here, '../../src') + path.sep;
try { process.loadEnvFile?.(path.resolve(here, '../../.env')); } catch { /* no .env: use the environment */ }

const partnerId = process.env.AGENTIC_PARTNER_ID;
const adminSecret = process.env.AGENTIC_ADMIN_SECRET;
if (!partnerId || !adminSecret) { console.error('Set AGENTIC_PARTNER_ID and AGENTIC_ADMIN_SECRET'); process.exit(2); }

const flag = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const ttlMinutes = flag('--ttl-minutes', 60);
const port = flag('--port', 8092);
const runId = `face-bg-${Date.now().toString(36)}`;

const kaltura = new Management({ partnerId, adminSecret });
const admin = (await kaltura.sessions.createAdminToken({ userId: 'admin@example.com' })).ks;

const BACKGROUNDS = [
  { key: 'library', label: 'Home library', file: 'bg-library.jpg' },
  { key: 'terrace', label: 'Sunny terrace', file: 'bg-terrace.jpg' },
  { key: 'office', label: 'Open-plan office', file: 'bg-office.jpg' },
  { key: 'studio', label: 'Dark-blue studio', file: 'bg-studio.jpg' },
  { key: 'color', label: 'Flat color #c0392b', color: '#c0392b' },
];
const blob = (file, type) => new Blob([fs.readFileSync(path.join(here, 'assets', file))], { type });

const created = { agents: [], avatars: [], catalog: [], configId: undefined };
const cells = [];

async function setup() {
  // The Face must be a transparent PNG cutout. An opaque photo keeps its own backdrop and ignores the background.
  const face = await kaltura.catalog.createFace(blob('face.png', 'image/png'), { name: `${runId}-face`, genderPresentation: 'Feminine' }, admin);
  created.catalog.push(face.itemId);

  const [voice] = await kaltura.catalog.list(admin, { type: 'Voice', pageSize: 1 }).all();
  if (!voice) throw new Error('no preset voice found');

  // One intellect for every agent, so the background is the only difference between cells.
  const base = await kaltura.provision({
    brief: 'A friendly greeter who welcomes visitors in one short sentence and answers briefly. Keep every reply under two sentences.',
    ks: admin,
    adminTags: [runId],
  });
  created.configId = base.configId;
  created.avatars.push(base.avatarId);
  created.agents.push(base.agentId);

  for (const bg of BACKGROUNDS) {
    let background = { type: 'color', value: bg.color };
    let backgroundId = bg.color;
    if (bg.file) {
      const item = await kaltura.catalog.createBackground(blob(bg.file, 'image/jpeg'), { name: `${runId}-${bg.key}`, genderPresentation: 'Feminine' }, admin);
      created.catalog.push(item.itemId);
      background = { type: 'visual', value: item.itemId };
      backgroundId = item.itemId;
    }
    const avatar = await kaltura.avatars.create({ voice: { id: voice.itemId }, face: { id: face.itemId }, background }, admin);
    created.avatars.push(avatar.id);
    const agent = await kaltura.agents.create({
      displayName: `${runId}-${bg.key}`,
      intellect: { intellectType: 'genie', id: base.configId },
      avatarIds: [avatar.id],
      adminTags: [runId],
      maxConversationLength: 600,
    }, admin);
    created.agents.push(agent.agentId);
    const { widgetId } = await kaltura.application.resolveWidgetId(agent.agentId, admin);
    cells.push({ ...bg, faceId: face.itemId, backgroundId, avatarId: avatar.id, widgetId });
    console.log(`cell ${bg.key}: face ${face.itemId} + background ${backgroundId}`);
  }
}

async function cleanup() {
  const step = async (name, fn) => { try { await fn(); console.log('deleted', name); } catch (e) { console.log('FAILED to delete', name, e?.detail || e?.message || e); } };
  const confirm = { confirmPermanent: true };
  for (const id of created.agents) await step(`agent ${id}`, () => kaltura.agents.delete(id, admin, confirm));
  for (const id of created.avatars) await step(`avatar ${id}`, () => kaltura.avatars.delete(id, admin, confirm));
  if (created.configId) await step(`intellect ${created.configId}`, () => kaltura.intellects.delete(created.configId, admin, confirm));
  for (const id of created.catalog) await step(`catalog ${id}`, () => kaltura.catalog.delete(id, admin, confirm));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.json': 'application/json' };
const send = (res, code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/cells') {
      const out = [];
      for (const c of cells) {
        const widget = await kaltura.sessions.createWidgetToken({ widgetId: c.widgetId });
        const init = await kaltura.application.appInit(widget.ks);
        out.push({ key: c.key, label: c.label, faceId: c.faceId, backgroundId: c.backgroundId, image: c.file ? `/assets/${c.file}` : null, color: c.color || null, init });
      }
      return send(res, 200, MIME['.json'], JSON.stringify(out));
    }
    let file;
    if (url.pathname === '/') file = path.join(here, 'index.html');
    else if (url.pathname === '/page.js') file = path.join(here, 'page.js');
    else if (/^\/assets\/bg-[\w-]+\.jpg$/.test(url.pathname)) file = path.join(here, url.pathname);
    else if (url.pathname.startsWith('/src/')) {
      const p = path.resolve(sdkSrc, '.' + url.pathname.slice(4));
      if (p.startsWith(sdkSrc)) file = p;
    }
    if (!file) return send(res, 404, 'text/plain', 'not found');
    send(res, 200, MIME[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file));
  } catch (err) {
    console.error('request failed:', err?.detail || err?.message || err);
    send(res, 500, MIME['.json'], JSON.stringify({ error: 'request failed, see server log' }));
  }
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await cleanup();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await setup();
} catch (err) {
  console.error('setup failed:', err?.detail || err?.message || err);
  await cleanup();
  process.exit(1);
}
server.listen(port, '127.0.0.1', () => console.log(`Open: http://127.0.0.1:${port}/  (stops and cleans up in ${ttlMinutes} min, or on Ctrl+C)`));
setTimeout(shutdown, ttlMinutes * 60_000);
