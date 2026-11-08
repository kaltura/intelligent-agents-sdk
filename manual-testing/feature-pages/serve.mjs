#!/usr/bin/env node
/**
 * Real-browser feature pages. Creates one throwaway agent, serves the pages,
 * prints a URL, and deletes everything on Ctrl+C or after the time limit.
 * See README.md.
 *
 *   node manual-testing/feature-pages/serve.mjs [--lan] [--port N] [--ttl-minutes N] [--env-file PATH]
 *   TARGET=<name> node manual-testing/feature-pages/serve.mjs --emotions
 *
 * The admin secret and every admin token stay in this process. A page gets a
 * conversation token, an avatar token, the partner id and the base URLs from
 * `/<secret>/api/config`, and nothing else. Admin work (catalog, variables,
 * cleanup) happens here, behind small JSON endpoints.
 */
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

/**
 * Which target the default run uses. Call it after every env file is loaded.
 * `AGENTIC_*` credentials mean production with the SDK's built-in URLs. Otherwise `NVP1_*`
 * credentials mean production with the URLs from the same file.
 * @param {Record<string, string|undefined>} env
 */
export function pickTarget(env) {
  if (env.AGENTIC_PARTNER_ID && env.AGENTIC_ADMIN_SECRET) return 'prod';
  if (env.NVP1_AGENTIC_PARTNER_ID && env.NVP1_AGENTIC_ADMIN_SECRET) return 'nvp1';
  return 'prod';
}

/** @param {Record<string, string|undefined>} env @param {{envFile?:string, emotions:boolean, target?:string}} args */
function resolveEnvironment(env, args) {
  if (args.envFile && !loadEnvFile(resolve(args.envFile))) throw new Error('Could not read the file given to --env-file.');
  loadEnvFile(resolve(repoRoot, '.env'));
  loadEnvFile(resolve(repoRoot, '../.env'));
  if (args.emotions) return resolveTarget(/** @type {string} */ (args.target));
  return resolveTarget(pickTarget(env));
}

/** Delete what a failed provision left behind and check it is gone. Throws, naming the ids, if something stays. */
async function dropPartial(kaltura, ks, partial) {
  const left = [];
  const why = (err) => redact(String(/** @type {any} */ (err)?.code || /** @type {any} */ (err)?.message));
  const del = async (what, id, remove, get) => {
    try { await remove(); } catch (err) { if (!isNotFound(err)) left.push(`${what} ${id}: ${why(err)}`); }
    try { await get(); left.push(`${what} ${id}: still present`); } catch (err) { if (!isNotFound(err)) left.push(`${what} ${id}: ${why(err)}`); }
  };
  if (partial.agentId) await del('agent', partial.agentId, () => kaltura.agents.delete(partial.agentId, ks, { confirmPermanent: true }), () => kaltura.agents.get(partial.agentId, ks));
  if (partial.avatarId) await del('avatar', partial.avatarId, () => kaltura.avatars.delete(partial.avatarId, ks, { confirmPermanent: true }), () => kaltura.avatars.get(partial.avatarId, ks));
  if (partial.configId) await del('intellect', partial.configId, () => kaltura.intellects.delete(partial.configId, ks, { confirmPermanent: true }), () => kaltura.intellects.get(partial.configId, ks));
  if (left.length) throw new Error(`could not remove a failed attempt: ${left.join('; ')}`);
}

/** @param {any} e */
function isNotFound(e) { return e?.status === 404 || /(^|_)not_found$/.test(String(e?.code ?? '')) || e?.title === 'AVATAR_NOT_FOUND'; }

/**
 * Create the throwaway agent. Its prompt has one custom variable and it allows request variables.
 * A step that fails is tried once more after a short wait, because the backend can fail a step now and then. The failed attempt is removed first.
 * @param {import('../../src/management/index.js').Management} kaltura @param {(ttl?:number)=>Promise<any>} admin @param {string} runId @param {(ids:any)=>void} [onCreated] Called as soon as ids exist, so teardown can clean a partial run. Called with undefined once a failed attempt is removed. @param {number} [backoffMs] Wait before the second try.
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
      if (partial) onCreated?.(partial);
      if (attempt === 2 || e?.code !== 'provision_failed') throw err;
      console.log(redact(`provision failed at step "${e?.body?.failedStep}", trying once more`));
      if (partial) { await dropPartial(kaltura, ks, partial); onCreated?.(undefined); }
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

/** Endpoints that change state and so accept POST only. Every other endpoint is GET only. */
const POST_ENDPOINTS = new Set(['catalog-init', 'catalog-scope']);

/**
 * Wrap an async function so parallel and repeated calls share one run. A failed run is forgotten, so the next call tries again.
 * `settled()` resolves when the current run ends, whatever its outcome.
 * @template T @param {() => Promise<T>} fn
 */
export function once(fn) {
  /** @type {Promise<T>|undefined} */
  let p;
  const call = () => {
    p ??= fn().catch((err) => { p = undefined; throw err; });
    return p;
  };
  return Object.assign(call, { settled: async () => { try { await p; } catch { /* the caller of fn saw it */ } } });
}

/**
 * The request listener. Pure of process state, so it can be tested with a fake api.
 * Every reply is built before its header is written, and no error text from a handler reaches the browser.
 * @param {{api:Record<string,(req:any, body:any)=>Promise<unknown>>, token:string, pages:string[], csp:string, title:string, log:(m:string)=>void}} ctx
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHandler({ api, token, pages, csp, title, log }) {
  const sendJson = (/** @type {import('node:http').ServerResponse} */ res, /** @type {number} */ status, /** @type {unknown} */ body) => {
    let text;
    try { text = JSON.stringify(body) ?? 'null'; } catch { status = 500; text = JSON.stringify({ error: 'The server could not build this answer.', code: null }); }
    res.writeHead(status, { 'content-type': MIME['.json'], ...securityHeaders(csp) });
    res.end(text);
  };
  const plain = (/** @type {import('node:http').ServerResponse} */ res, /** @type {number} */ status, /** @type {string} */ text) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, securityHeaders(csp));
    res.end(text);
  };
  return async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x');
      const r = route(url.pathname, token, pages);
      if (r.kind === 'none') { plain(res, 404, 'Not found'); return; }
      if (r.kind === 'index') {
        res.writeHead(200, { 'content-type': MIME['.html'], ...securityHeaders(csp) });
        res.end(indexHtml(pages, title));
        return;
      }
      if (r.kind === 'api') {
        if (!Object.hasOwn(api, r.name)) { sendJson(res, 404, { error: 'unknown endpoint', code: null }); return; }
        const wantPost = POST_ENDPOINTS.has(r.name);
        if (req.method !== (wantPost ? 'POST' : 'GET')) { sendJson(res, 405, { error: wantPost ? 'POST only' : 'GET only', code: null }); return; }
        let body = {};
        if (wantPost) {
          try { body = await readJson(req); } catch { sendJson(res, 400, { error: 'The request body is not valid.', code: null }); return; }
        }
        try {
          sendJson(res, 200, await api[r.name](req, body));
        } catch (err) {
          const e = /** @type {any} */ (err);
          log(`api ${r.name} failed: ${String(e?.code ?? '')} ${String(e?.detail || e?.message || e).slice(0, 300)}`);
          sendJson(res, 500, { error: 'The request failed. The server log has the detail.', code: typeof e?.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(e.code) ? e.code : null });
        }
        return;
      }
      const file = r.file;
      const inside = r.kind === 'src' ? file.startsWith(join(repoRoot, 'src') + sep) : true;
      let data;
      try { data = inside ? readFileSync(file) : undefined; } catch { data = undefined; }
      if (!data) { plain(res, 404, 'Not found'); return; }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', ...securityHeaders(csp) });
      res.end(data);
    } catch (err) {
      log(`request error: ${String(/** @type {any} */ (err)?.message || err)}`);
      plain(res, 500, 'Server error');
    }
  };
}

/**
 * A crash must not skip cleanup. On an uncaught error or a rejected promise, run `shutdown` (which tears down) instead of dying.
 * @param {{on:(event:string, fn:(err:unknown)=>void)=>unknown}} proc @param {(code:number)=>unknown} shutdown @param {(m:string)=>void} log
 */
export function installCrashGuards(proc, shutdown, log) {
  for (const [event, label] of [['uncaughtException', 'uncaught exception'], ['unhandledRejection', 'unhandled rejection']]) {
    proc.on(event, (err) => { log(`${label}: ${String(/** @type {any} */ (err)?.message || err)}`); shutdown(1); });
  }
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

  /** @type {{configId?:number, agentId?:string, widgetId?:string, avatarId?:string}|undefined} */
  let ids;
  /** @type {{itemId:string, scopeA:string, scopeB:string}|undefined} */
  let catalog;
  let conv;
  let init;
  /** @type {import('node:http').Server|undefined} */
  let server = undefined;
  let stopping = false;
  let extraSignals = 0;

  const log = (/** @type {string} */ m) => console.log(redact(m));
  /** The ids of everything this run made. They are not secrets, and the operator needs them to clean up by hand. */
  const idText = () => [
    ids?.agentId && `agent ${ids.agentId}`,
    ids?.configId && `intellect ${ids.configId}`,
    ids?.avatarId && `avatar ${ids.avatarId}`,
    catalog?.itemId && `catalog item ${catalog.itemId}`,
  ].filter(Boolean).join(', ') || 'no ids recorded';
  const logIds = (/** @type {string} */ m) => console.log(`${redact(m)} [${idText()}]`);

  const catalogInit = once(async () => {
    const ks = await admin(120);
    const scopeA = randomUUID(); const scopeB = randomUUID();
    const item = await kaltura.catalog.createVisual(fixtureBlob(), { name: `${RUN_PREFIX}-${runId} ${Date.now().toString(36)}`, genderPresentation: 'Feminine', agentScope: scopeA }, ks);
    catalog = { itemId: item.itemId, scopeA, scopeB };
    return { itemId: item.itemId, scopeA, scopeB };
  });

  async function teardown() {
    const problems = [];
    await catalogInit.settled();
    const ks = await admin().catch(() => undefined);
    if (!ks) { logIds('teardown: could not mint an admin token, so nothing was removed. Still present'); return 1; }
    const step = async (/** @type {string} */ what, /** @type {()=>Promise<any>} */ fn) => { try { await fn(); } catch (err) { problems.push(`${what}: ${redact(String(/** @type {any} */ (err)?.code || /** @type {any} */ (err)?.message || err))}`); } };
    const agentId = ids?.agentId; const avatarId = ids?.avatarId; const configId = ids?.configId;
    if (agentId) {
      await step('threads', async () => {
        const threads = await kaltura.threads.list(ks, { filter: { agentIdEquals: agentId } }).all();
        if (threads.length) await kaltura.threads.delete(threads.map((t) => t.id), ks, { confirmPermanent: true });
      });
    }
    if (catalog) await step('catalog item', () => kaltura.catalog.delete(catalog.itemId, ks, { confirmPermanent: true }));
    if (agentId) await step('agent', () => kaltura.agents.delete(agentId, ks, { confirmPermanent: true }));
    if (avatarId) await step('avatar', () => kaltura.avatars.delete(avatarId, ks, { confirmPermanent: true }));
    if (configId) await step('intellect', () => kaltura.intellects.delete(configId, ks, { confirmPermanent: true }));
    const gone = async (/** @type {string} */ what, /** @type {()=>Promise<any>} */ get) => {
      try { await get(); problems.push(`${what}: still present`); } catch (err) {
        const e = /** @type {any} */ (err);
        if (!isNotFound(e)) problems.push(`${what}: ${redact(String(e?.code || e?.message))}`);
      }
    };
    if (agentId) await gone('agent', () => kaltura.agents.get(agentId, ks));
    if (avatarId) await gone('avatar', () => kaltura.avatars.get(avatarId, ks));
    if (configId) await gone('intellect', () => kaltura.intellects.get(configId, ks));
    if (catalog) await gone('catalog item', () => kaltura.catalog.get(catalog.itemId, ks));
    if (agentId) {
      await step('thread check', async () => {
        const left = await kaltura.threads.list(ks, { filter: { agentIdEquals: agentId } }).all();
        if (left.length) problems.push(`threads: ${left.length} left`);
      });
    }
    if (problems.length) { for (const p of problems) logIds(`teardown problem: ${p}`); return 1; }
    log('teardown verified: agent, avatar, intellect, catalog item and threads are gone');
    return 0;
  }

  async function shutdown(/** @type {number} */ code = 0) {
    if (stopping) return;
    stopping = true;
    server?.close();
    server?.closeAllConnections?.();
    const bad = await teardown().catch((err) => { logIds(`teardown failed: ${String(err?.message || err)}`); return 1; });
    process.exit(code || bad);
  }
  const onSignal = (/** @type {string} */ name) => () => {
    if (!stopping) { log(`${name} received, stopping`); shutdown(0); return; }
    extraSignals++;
    if (extraSignals === 1) { log('teardown running, press again to abort'); return; }
    logIds('teardown aborted. Check these by hand');
    process.exit(1);
  };
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, onSignal(name));
  installCrashGuards(process, shutdown, log);

  try {
    log(`target ${target.name}; creating the throwaway agent`);
    await createAgent(kaltura, admin, runId, (made) => { ids = made; });
    conv = await kaltura.sessions.createConversationToken({ configId: ids.configId, agentId: ids.agentId, userId, ttlSeconds: args.ttlMinutes * 60 });
    if (!args.emotions) {
      const widget = await kaltura.sessions.createWidgetToken({ widgetId: ids.widgetId });
      init = await kaltura.application.appInit(widget.ks);
    }
  } catch (err) {
    const failed = /** @type {any} */ (err);
    logIds(`setup failed: ${String(failed?.code || failed?.message || err)}${failed?.body?.failedStep ? ` at ${failed.body.failedStep}` : ''}. Removing what was made`);
    await shutdown(1);
    return;
  }

  const csp = buildCsp(connectOrigins([target.genieUrl, init?.conversationManagerUrl, init?.srsBaseUrl]));

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
    'catalog-init': () => catalogInit(),
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

  server = createServer(createHandler({ api, token, pages, csp, title: args.emotions ? 'Feature pages (Limited Availability)' : 'Feature pages', log }));

  await new Promise((ok) => server.listen(args.port, args.lan ? '0.0.0.0' : '127.0.0.1', () => ok(undefined)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const host = args.lan ? lanAddress() : '127.0.0.1';
  console.log(`Open: http://${host}:${port}/${token}/`);
  console.log(`Pages: ${pages.join(', ')}`);
  console.log(`Stops in ${args.ttlMinutes} minutes, or press Ctrl+C. Everything it created is deleted then.`);
  setTimeout(() => { log('time limit reached'); shutdown(0); }, args.ttlMinutes * 60_000).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
