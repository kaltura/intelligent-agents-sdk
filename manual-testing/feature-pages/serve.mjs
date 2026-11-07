#!/usr/bin/env node
/**
 * Real-browser feature pages. Creates one throwaway agent, serves the pages,
 * prints a URL, and deletes everything on Ctrl+C or after the time limit.
 * See README.md.
 *
 *   node manual-testing/feature-pages/serve.mjs [--lan] [--port N] [--ttl-minutes N] [--env-file PATH]
 *   TARGET=<name> node manual-testing/feature-pages/serve.mjs --emotions
 *
 * The admin secret and every admin token stay in this process. A page gets one
 * conversation token from `/<secret>/api/config` and nothing else. Admin work
 * (catalog, variables, cleanup) happens here, behind small JSON endpoints.
 */
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';
import { SILENT_OPENING } from '../../src/management/index.js';
import { loadEnvFile, resolveTarget, managementFor, repoRoot } from '../../scripts/lib/target.mjs';
import { redact } from '../../scripts/lib/redact.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Pages served by default, in index order. */
export const DEFAULT_PAGES = Object.freeze(['connect-errors', 'side-question', 'catalog-scope', 'variables', 'request-vars']);
/** Needs a Limited Availability environment. Served only with `--emotions`. */
export const EMOTIONS_PAGE = 'emotions';
export const RUN_PREFIX = 'sdk-pages-check';
export const CUSTOM_VAR = 'sdk_live_color';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

/**
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} [env]
 * @returns {{lan:boolean, port:number, ttlMinutes:number, envFile?:string, emotions:boolean, target?:string}}
 */
export function parseArgs(argv, env = {}) {
  const out = { lan: false, port: 0, ttlMinutes: 60, envFile: env.ENV_FILE || undefined, emotions: false, target: undefined };
  const num = (/** @type {string} */ flag, /** @type {string|undefined} */ v, /** @type {number} */ min, /** @type {number} */ max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} needs a whole number from ${min} to ${max}.`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lan') out.lan = true;
    else if (a === '--emotions') out.emotions = true;
    else if (a === '--port') out.port = num(a, argv[++i], 0, 65535);
    else if (a === '--ttl-minutes') out.ttlMinutes = num(a, argv[++i], 1, 240);
    else if (a === '--env-file') { out.envFile = argv[++i]; if (!out.envFile) throw new Error('--env-file needs a path.'); }
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (out.emotions) {
    if (!env.TARGET) throw new Error('--emotions needs TARGET set to the name of a Limited Availability environment. There is no default.');
    out.target = env.TARGET;
  }
  return out;
}

/** @param {boolean} emotions */
export function pageList(emotions) { return emotions ? [EMOTIONS_PAGE] : [...DEFAULT_PAGES]; }

/** A random path segment. It is the only gate on the server, so it must not be guessable. */
export function newToken() { return randomBytes(16).toString('hex'); }

/**
 * Origins a page may call. Each https origin also gets its wss twin, for sockets.
 * @param {Array<string|null|undefined>} urls
 */
export function connectOrigins(urls) {
  const set = new Set();
  for (const u of urls) {
    if (!u) continue;
    let p;
    try { p = new URL(u); } catch { continue; }
    if (p.protocol === 'https:') { set.add(p.origin); set.add(`wss://${p.host}`); }
    else if (p.protocol === 'http:') { set.add(p.origin); set.add(`ws://${p.host}`); }
  }
  return [...set];
}

/** @param {string[]} origins */
export function buildCsp(origins) {
  return [
    "default-src 'none'",
    "script-src 'self' https://cdn.socket.io",
    "style-src 'self'",
    "img-src 'self' data: https:",
    `connect-src 'self' ${origins.join(' ')}`.trim(),
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** @param {string} csp */
export function securityHeaders(csp) {
  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'cross-origin-opener-policy': 'same-origin',
  };
}

/** @param {string} a @param {string} b */
function sameToken(a, b) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Map a URL path to what the server does with it. Pure, so it can be tested offline.
 * Only listed files are served, never a directory.
 * @param {string} pathname
 * @param {string} token
 * @param {string[]} pages
 * @returns {{kind:'index'}|{kind:'feature', file:string}|{kind:'src', file:string}|{kind:'api', name:string}|{kind:'none'}}
 */
export function route(pathname, token, pages) {
  const parts = pathname.split('/').filter((p, i) => !(i === 0 && p === ''));
  if (parts.length === 0 || !sameToken(parts[0], token)) return { kind: 'none' };
  const rest = parts.slice(1);
  if (rest.some((p) => p === '..' || p === '.' || p.includes('\\') || p.includes('\0'))) return { kind: 'none' };
  if (rest.length === 0 || (rest.length === 1 && rest[0] === '')) return { kind: 'index' };
  if (rest[0] === 'api' && rest.length === 2 && /^[a-z][a-z-]*$/.test(rest[1])) return { kind: 'api', name: rest[1] };
  if (rest[0] === 'src' && rest.length >= 2 && rest.at(-1)?.endsWith('.js')) return { kind: 'src', file: join(repoRoot, ...rest) };
  if (rest[0] === 'manual-testing' && rest[1] === 'feature-pages' && rest.length === 3) {
    const name = rest[2];
    const allowed = new Set(['common.js', 'style.css', ...pages.flatMap((p) => [`${p}.html`, `${p}.js`])]);
    if (allowed.has(name)) return { kind: 'feature', file: join(here, name) };
  }
  return { kind: 'none' };
}

/** @param {string[]} pages @param {string} title */
function indexHtml(pages, title) {
  const items = pages.map((p) => `<li><a href="manual-testing/feature-pages/${p}.html">${p}</a></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="manual-testing/feature-pages/style.css"></head><body><main><h1>${title}</h1><ul>${items}</ul></main></body></html>`;
}

function lanAddress() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces || []) if (iface.family === 'IPv4' && !iface.internal) return iface.address;
  }
  return '127.0.0.1';
}

/** @param {Record<string, string|undefined>} env @param {{envFile?:string, emotions:boolean, target?:string}} args */
function resolveEnvironment(env, args) {
  if (args.envFile && !loadEnvFile(resolve(args.envFile))) throw new Error('Could not read the file given to --env-file.');
  if (args.emotions) return resolveTarget(/** @type {string} */ (args.target));
  return resolveTarget(env.NVP1_AGENTIC_PARTNER_ID ? 'nvp1' : 'prod');
}

/** Delete what a failed provision left behind and check it is gone. Throws if something stays. */
async function dropPartial(kaltura, ks, partial) {
  const left = [];
  const del = async (what, remove, get) => {
    try { await remove(); } catch (err) { if (!isNotFound(err)) left.push(`${what}: ${redact(String(/** @type {any} */ (err)?.code || /** @type {any} */ (err)?.message))}`); }
    try { await get(); left.push(`${what}: still present`); } catch (err) { if (!isNotFound(err)) left.push(`${what}: ${redact(String(/** @type {any} */ (err)?.code || /** @type {any} */ (err)?.message))}`); }
  };
  if (partial.agentId) await del('agent', () => kaltura.agents.delete(partial.agentId, ks, { confirmPermanent: true }), () => kaltura.agents.get(partial.agentId, ks));
  if (partial.avatarId) await del('avatar', () => kaltura.avatars.delete(partial.avatarId, ks, { confirmPermanent: true }), () => kaltura.avatars.get(partial.avatarId, ks));
  if (partial.configId) await del('intellect', () => kaltura.intellects.delete(partial.configId, ks, { confirmPermanent: true }), () => kaltura.intellects.get(partial.configId, ks));
  if (left.length) throw new Error(`could not remove a failed attempt: ${left.join('; ')}`);
}

/** @param {any} e */
function isNotFound(e) { return e?.status === 404 || /(^|_)not_found$/.test(String(e?.code ?? '')) || e?.title === 'AVATAR_NOT_FOUND'; }

/**
 * Create the throwaway agent. Its prompt has one custom variable and it allows request variables.
 * A step that fails is tried once more after a short wait, because the backend can fail a step now and then. The failed attempt is removed first.
 * @param {import('../../src/management/index.js').Management} kaltura @param {(ttl?:number)=>Promise<any>} admin @param {string} runId @param {(ids:any)=>void} [onCreated] Called as soon as ids exist, so teardown can clean a partial run. @param {number} [backoffMs] Wait before the second try.
 */
export async function createAgent(kaltura, admin, runId, onCreated, backoffMs = 3000) {
  const ks = await admin();
  const brief = `Throwaway live-check guide ${RUN_PREFIX}-${runId}. Keep every answer to one or two short sentences.`;
  let made;
  for (let attempt = 1; ; attempt++) {
    try {
      made = await kaltura.provision({ brief, ks, openingPhrase: SILENT_OPENING, adminTags: [RUN_PREFIX, `${RUN_PREFIX}-${runId}`] });
      break;
    } catch (err) {
      const e = /** @type {any} */ (err);
      const partial = e?.body?.createdSoFar;
      if (attempt === 2 || e?.code !== 'provision_failed') {
        if (partial) onCreated?.(partial);
        throw err;
      }
      console.log(redact(`provision failed at step "${e?.body?.failedStep}", trying once more`));
      if (partial) await dropPartial(kaltura, ks, partial);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  const ids = { configId: made.configId, agentId: made.agentId, widgetId: made.widgetId, avatarId: made.avatarId ?? made.avatarIds?.[0] };
  onCreated?.(ids);
  const intellect = await kaltura.intellects.get(ids.configId, ks);
  await kaltura.intellects.setPrompts(ids.configId, intellect.prompts ?? [], ks, {
    baseDirective: `You are a short-answer assistant for a live SDK check. Answer in one or two sentences. If asked, the favourite colour is {{ ${CUSTOM_VAR} }}.`,
    knownVars: [CUSTOM_VAR],
  });
  await kaltura.intellects.setClientVariablesEnabled(ids.configId, true, ks);
  return ids;
}

/** Fixture image for the catalog page. */
function fixtureBlob() {
  const file = join(repoRoot, 'examples', 'chroma-key-green-screen-portrait.jpeg');
  return new Blob([readFileSync(file)], { type: 'image/jpeg' });
}

/** @param {import('node:http').IncomingMessage} req */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 16_384) throw new Error('body too large'); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2), process.env); } catch (err) { console.error(/** @type {Error} */ (err).message); process.exit(1); }
  const target = resolveEnvironment(process.env, args);
  const kaltura = managementFor(target);
  const admin = (ttlSeconds = 600) => kaltura.sessions.createAdminToken({ userId: `${RUN_PREFIX}-admin`, ttlSeconds });
  const pages = pageList(args.emotions);
  const token = newToken();
  const runId = randomBytes(3).toString('hex');
  const userId = `${RUN_PREFIX}-user`;

  /** @type {{configId:number, agentId:string, widgetId:string, avatarId?:string}|undefined} */
  let ids;
  /** @type {{itemId:string, scopeA:string, scopeB:string}|undefined} */
  let catalog;
  let conv;
  let init;
  /** @type {import('node:http').Server|undefined} */
  let server = undefined;
  let stopping = false;

  const log = (/** @type {string} */ m) => console.log(redact(m));

  async function teardown() {
    const problems = [];
    const ks = await admin().catch(() => undefined);
    if (!ks) { log('teardown: could not mint an admin token'); return 1; }
    const step = async (/** @type {string} */ what, /** @type {()=>Promise<any>} */ fn) => { try { await fn(); } catch (err) { problems.push(`${what}: ${redact(String(/** @type {any} */ (err)?.code || /** @type {any} */ (err)?.message || err))}`); } };
    if (ids) {
      await step('threads', async () => {
        const threads = await kaltura.threads.list(ks, { filter: { agentIdEquals: ids.agentId } }).all();
        if (threads.length) await kaltura.threads.delete(threads.map((t) => t.id), ks, { confirmPermanent: true });
      });
    }
    if (catalog) await step('catalog item', () => kaltura.catalog.delete(catalog.itemId, ks, { confirmPermanent: true }));
    if (ids) {
      await step('agent', () => kaltura.agents.delete(ids.agentId, ks, { confirmPermanent: true }));
      if (ids.avatarId) await step('avatar', () => kaltura.avatars.delete(/** @type {string} */ (ids.avatarId), ks, { confirmPermanent: true }));
      await step('intellect', () => kaltura.intellects.delete(ids.configId, ks, { confirmPermanent: true }));
    }
    const gone = async (/** @type {string} */ what, /** @type {()=>Promise<any>} */ get) => {
      try { await get(); problems.push(`${what}: still present`); } catch (err) {
        const e = /** @type {any} */ (err);
        if (!isNotFound(e)) problems.push(`${what}: ${redact(String(e?.code || e?.message))}`);
      }
    };
    if (ids) {
      await gone('agent', () => kaltura.agents.get(ids.agentId, ks));
      if (ids.avatarId) await gone('avatar', () => kaltura.avatars.get(/** @type {string} */ (ids.avatarId), ks));
      await gone('intellect', () => kaltura.intellects.get(ids.configId, ks));
    }
    if (catalog) await gone('catalog item', () => kaltura.catalog.get(catalog.itemId, ks));
    if (ids) {
      await step('thread check', async () => {
        const left = await kaltura.threads.list(ks, { filter: { agentIdEquals: ids.agentId } }).all();
        if (left.length) problems.push(`threads: ${left.length} left`);
      });
    }
    if (problems.length) { for (const p of problems) log(`teardown problem: ${p}`); return 1; }
    log('teardown verified: agent, avatar, intellect, catalog item and threads are gone');
    return 0;
  }

  async function shutdown(/** @type {number} */ code = 0) {
    if (stopping) return;
    stopping = true;
    server?.close();
    server?.closeAllConnections?.();
    const bad = await teardown().catch((err) => { log(`teardown failed: ${String(err?.message || err)}`); return 1; });
    process.exit(code || bad);
  }
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));

  try {
    log(`target ${target.name}; creating the throwaway agent`);
    await createAgent(kaltura, admin, runId, (made) => { ids = made; });
    conv = await kaltura.sessions.createConversationToken({ configId: ids.configId, agentId: ids.agentId, userId, ttlSeconds: 3600 });
    if (!args.emotions) {
      const widget = await kaltura.sessions.createWidgetToken({ widgetId: ids.widgetId });
      init = await kaltura.application.appInit(widget.ks);
    }
  } catch (err) {
    const failed = /** @type {any} */ (err);
    log(`setup failed: ${String(failed?.code || failed?.message || err)}${failed?.body?.failedStep ? ` at ${failed.body.failedStep}` : ''}`);
    await shutdown(1);
    return;
  }

  const csp = buildCsp(connectOrigins([target.genieUrl, init?.conversationManagerUrl, init?.srsBaseUrl]));
  const sendJson = (/** @type {import('node:http').ServerResponse} */ res, /** @type {number} */ status, /** @type {unknown} */ body) => {
    res.writeHead(status, { 'content-type': MIME['.json'], ...securityHeaders(csp) });
    res.end(JSON.stringify(body));
  };

  /** @type {Record<string, (req:any, body:any)=>Promise<unknown>>} */
  const api = {
    config: async () => ({
      emotions: args.emotions,
      partnerId: String(target.partnerId),
      genieUrl: target.genieUrl,
      configId: ids?.configId,
      agentId: ids?.agentId,
      customVar: CUSTOM_VAR,
      conversationKs: conv.ks,
      avatarToken: init?.ks ?? null,
      conversationManagerUrl: init?.conversationManagerUrl ?? null,
      srsBaseUrl: init?.srsBaseUrl ?? null,
      turnServerUrl: init?.turnServerUrl ?? null,
    }),
    variables: async () => kaltura.application.getCustomVariables(/** @type {any} */ (ids).agentId, await admin(120)),
    'catalog-init': async () => {
      if (catalog) return { itemId: catalog.itemId, scopeA: catalog.scopeA, scopeB: catalog.scopeB };
      const ks = await admin(120);
      const scopeA = randomUUID(); const scopeB = randomUUID();
      const item = await kaltura.catalog.createVisual(fixtureBlob(), { name: `${RUN_PREFIX}-${runId} ${Date.now().toString(36)}`, genderPresentation: 'Feminine', agentScope: scopeA }, ks);
      catalog = { itemId: item.itemId, scopeA, scopeB };
      return { itemId: item.itemId, scopeA, scopeB };
    },
    'catalog-state': async () => {
      if (!catalog) return { ready: false };
      const ks = await admin(120);
      const item = await kaltura.catalog.get(catalog.itemId, ks);
      const inList = async (/** @type {string|undefined} */ scope) => {
        const rows = await kaltura.catalog.list(ks, { ...(scope ? { agentScope: scope } : {}), filter: { itemIdEqual: /** @type {any} */ (catalog).itemId } }).all();
        return rows.length;
      };
      return { ready: true, scope: item.agentScope ?? null, name: item.attributes?.visual?.name ?? null, thumbnail: item.imageUrl ?? null, inListA: await inList(catalog.scopeA), inListB: await inList(catalog.scopeB), inListNone: await inList(undefined), scopeA: catalog.scopeA, scopeB: catalog.scopeB };
    },
    'catalog-scope': async (_req, body) => {
      if (!catalog) throw new Error('call catalog-init first');
      const to = body?.to;
      const agentScope = to === 'A' ? catalog.scopeA : to === 'B' ? catalog.scopeB : to === 'none' ? '' : null;
      if (agentScope === null) throw new Error('to must be A, B or none');
      await kaltura.catalog.update({ itemId: catalog.itemId, agentScope }, await admin(120));
      return { ok: true };
    },
  };

  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x');
      const r = route(url.pathname, token, pages);
      if (r.kind === 'none') { res.writeHead(404, securityHeaders(csp)); res.end('Not found'); return; }
      if (r.kind === 'index') {
        res.writeHead(200, { 'content-type': MIME['.html'], ...securityHeaders(csp) });
        res.end(indexHtml(pages, args.emotions ? 'Feature pages (Limited Availability)' : 'Feature pages'));
        return;
      }
      if (r.kind === 'api') {
        const fn = api[r.name];
        if (!fn) { sendJson(res, 404, { error: 'unknown endpoint' }); return; }
        if (r.name === 'catalog-init' || r.name === 'catalog-scope') { if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST only' }); return; } }
        else if (req.method !== 'GET') { sendJson(res, 405, { error: 'GET only' }); return; }
        const body = req.method === 'POST' ? await readJson(req) : {};
        try { sendJson(res, 200, await fn(req, body)); } catch (err) {
          const e = /** @type {any} */ (err);
          sendJson(res, 500, { error: redact(String(e?.detail || e?.message || e)).slice(0, 300), code: e?.code ?? null });
        }
        return;
      }
      const file = r.file;
      const inside = r.kind === 'src' ? file.startsWith(join(repoRoot, 'src') + sep) : true;
      if (!inside || !existsSync(file)) { res.writeHead(404, securityHeaders(csp)); res.end('Not found'); return; }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', ...securityHeaders(csp) });
      res.end(readFileSync(file));
    } catch (err) {
      res.writeHead(500, securityHeaders(csp)); res.end('Server error');
      log(`request error: ${String(/** @type {any} */ (err)?.message || err)}`);
    }
  });

  await new Promise((ok) => server.listen(args.port, args.lan ? '0.0.0.0' : '127.0.0.1', () => ok(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const host = args.lan ? lanAddress() : '127.0.0.1';
  console.log(`Open: http://${host}:${port}/${token}/`);
  console.log(`Pages: ${pages.join(', ')}`);
  console.log(`Stops in ${args.ttlMinutes} minutes, or press Ctrl+C. Everything it created is deleted then.`);
  setTimeout(() => { log('time limit reached'); shutdown(0); }, args.ttlMinutes * 60_000).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
