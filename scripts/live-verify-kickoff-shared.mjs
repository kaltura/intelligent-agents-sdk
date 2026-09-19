/**
 * Shared plumbing for the two live kickoff scripts:
 *   scripts/live-verify-connect-timing.mjs
 *   scripts/live-verify-kickoff.mjs
 *
 * Owns: CLI + .env parsing, environment targets, throwaway-agent provisioning
 * with a SILENT_OPENING opening phrase, the local static server that backs
 * `scripts/live-verify-kickoff.html`, headless Chromium with fake media, and
 * the event-polling helpers both scripts assert with.
 *
 * Nothing here is imported by the SDK. Credentials come from the environment
 * or a .env file; none are written to the artifacts.
 */
import { readFileSync, writeFileSync, mkdirSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { Management, SILENT_OPENING } from '../src/management/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, '..');
export { SILENT_OPENING };

// ---------------------------------------------------------------------------
// CLI + env
// ---------------------------------------------------------------------------

/**
 * Parse `--flag value` / `--flag` pairs. Repeated flags keep the last value.
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

/**
 * Load `KEY=value` lines from a .env file into process.env without overriding
 * values that are already set. Keys may contain digits (`NVQ2_PARTNER_ID_1`).
 * @param {string} path
 * @returns {boolean} true when the file was read
 */
export function loadEnvFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return false; }
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return true;
}

/**
 * Resolve one backend target from the environment.
 *
 * | --env | partner / secret | URLs |
 * |---|---|---|
 * | `prod` (default) | `AGENTIC_PARTNER_ID` / `AGENTIC_ADMIN_SECRET` | SDK defaults |
 * | `nvq2` | `NVQ2_PARTNER_ID_1` / `NVQ2_ADMIN_SECRET_1` | `NVQ2_AGENTIC_API_URL`, `NVQ2_GENIE_URL`, `NVQ2_KALTURA_API_ENDPOINT` |
 *
 * Every URL override is passed explicitly to `Management`, so a target never
 * falls back to the production defaults by accident.
 * @param {string} name
 * @returns {{name:string, partnerId:string, adminSecret:string, agenticUrl?:string, genieUrl?:string, ovpUrl?:string}}
 */
export function resolveTarget(name) {
  const need = (/** @type {string[]} */ keys) => {
    const missing = keys.filter((k) => !process.env[k]);
    if (missing.length) {
      console.error(`--env ${name}: missing ${missing.join(', ')} (set them in the environment or pass --env-file <path>).`);
      process.exit(1);
    }
  };
  if (name === 'prod') {
    need(['AGENTIC_PARTNER_ID', 'AGENTIC_ADMIN_SECRET']);
    return { name, partnerId: process.env.AGENTIC_PARTNER_ID, adminSecret: process.env.AGENTIC_ADMIN_SECRET };
  }
  if (name === 'nvq2') {
    need(['NVQ2_PARTNER_ID_1', 'NVQ2_ADMIN_SECRET_1', 'NVQ2_AGENTIC_API_URL', 'NVQ2_GENIE_URL', 'NVQ2_KALTURA_API_ENDPOINT']);
    return {
      name,
      partnerId: process.env.NVQ2_PARTNER_ID_1,
      adminSecret: process.env.NVQ2_ADMIN_SECRET_1,
      agenticUrl: process.env.NVQ2_AGENTIC_API_URL,
      genieUrl: process.env.NVQ2_GENIE_URL,
      ovpUrl: process.env.NVQ2_KALTURA_API_ENDPOINT,
    };
  }
  console.error(`--env ${name}: unknown target (expected prod or nvq2).`);
  process.exit(1);
}

/**
 * Standard setup shared by both scripts: parse argv, load the env file, pick a target.
 * @param {string[]} argv
 * @param {string} scriptName
 */
export function bootstrap(argv, scriptName) {
  const args = parseArgs(argv);
  const envFile = typeof args['env-file'] === 'string' ? resolve(String(args['env-file'])) : resolve(repoRoot, '.env');
  loadEnvFile(envFile);
  const target = resolveTarget(typeof args.env === 'string' ? args.env : 'prod');
  const runId = `${scriptName}-${target.name}-${Date.now()}`;
  const outDir = typeof args.out === 'string' ? resolve(String(args.out)) : resolve(repoRoot, 'live-verify-artifacts');
  mkdirSync(outDir, { recursive: true });
  return { args, target, runId, outDir };
}

// ---------------------------------------------------------------------------
// Result recording
// ---------------------------------------------------------------------------

/** @typedef {{name:string, ok:boolean, detail?:any, at:string}} Check */

export class Report {
  /** @param {{runId:string, target:string}} meta */
  constructor(meta) {
    this.meta = { ...meta, startedAt: new Date().toISOString() };
    /** @type {Check[]} */ this.checks = [];
    /** @type {Record<string, any>} */ this.data = {};
  }
  /** @param {string} name @param {boolean} ok @param {any} [detail] */
  check(name, ok, detail) {
    this.checks.push({ name, ok: !!ok, detail, at: new Date().toISOString() });
    console.log(`[${ok ? 'ok' : 'FAIL'}] ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
    return !!ok;
  }
  /** @param {string} name @param {any} [detail] */
  note(name, detail) {
    this.checks.push({ name, ok: true, detail, at: new Date().toISOString() });
    console.log(`[note] ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  }
  get failed() { return this.checks.some((c) => !c.ok); }
  /**
   * Write `<outDir>/<runId>.json` and `<outDir>/<runId>.md`.
   * @param {string} outDir @param {string} markdown
   */
  write(outDir, markdown) {
    this.meta.finishedAt = new Date().toISOString();
    this.meta.ok = !this.failed;
    const json = resolve(outDir, `${this.meta.runId}.json`);
    const md = resolve(outDir, `${this.meta.runId}.md`);
    writeFileSync(json, JSON.stringify({ ...this.meta, checks: this.checks, data: this.data }, null, 2));
    writeFileSync(md, markdown);
    console.log(`\nartifacts: ${json}\n           ${md}`);
  }
}

/**
 * @param {string[]} header
 * @param {(string|number)[][]} rows
 */
export function mdTable(header, rows) {
  const line = (/** @type {(string|number)[]} */ cells) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

/** @param {number[]} xs */
export function stats(xs) {
  if (!xs.length) return { min: null, median: null, max: null, n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  return { min: s[0], median, max: s[s.length - 1], n: s.length };
}

// ---------------------------------------------------------------------------
// Backend: provisioning + token minting
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<typeof resolveTarget>} target
 */
export function management(target) {
  return new Management({
    partnerId: target.partnerId,
    adminSecret: target.adminSecret,
    ...(target.agenticUrl ? { agenticUrl: target.agenticUrl } : {}),
    ...(target.genieUrl ? { genieUrl: target.genieUrl } : {}),
    ...(target.ovpUrl ? { ovpUrl: target.ovpUrl } : {}),
  });
}

/**
 * Provision a throwaway agent whose opening phrase is SILENT_OPENING, or reuse
 * the ids in `--agent-json <path>` (`{configId, agentId, widgetId, avatarId?}`).
 * Returns the ids plus a `cleanup()` that deletes only what this call created.
 * @param {Management} kaltura
 * @param {string} adminKs
 * @param {{agentJson?:string, keep?:boolean, brief?:string}} opts
 */
export async function ensureAgent(kaltura, adminKs, opts) {
  if (opts.agentJson) {
    const ids = JSON.parse(readFileSync(resolve(opts.agentJson), 'utf8'));
    if (!ids.configId || !ids.widgetId) throw new Error('--agent-json needs at least {configId, widgetId}');
    return { ...ids, reused: true, cleanup: async () => {} };
  }
  /** @type {any} */
  let created;
  try {
    created = await kaltura.provision({
      brief: opts.brief || 'A concise, friendly product guide for a live SDK verification run. Keep every answer to one or two short sentences.',
      ks: adminKs,
      openingPhrase: SILENT_OPENING,
    });
  } catch (err) {
    // provision() throws with the ids created so far; delete them before re-throwing.
    const partial = /** @type {any} */ (err)?.body?.createdSoFar;
    if (partial) await deleteAgent(kaltura, adminKs, partial);
    throw err;
  }
  const ids = { configId: created.configId, agentId: created.agentId, widgetId: created.widgetId, avatarId: created.avatarId ?? created.avatarIds?.[0] };
  return {
    ...ids,
    reused: false,
    cleanup: async () => { if (!opts.keep) await deleteAgent(kaltura, adminKs, ids); },
  };
}

/**
 * Best-effort delete of agent → avatar → intellect. Never throws.
 * @param {Management} kaltura @param {string} ks @param {{agentId?:string, avatarId?:string, configId?:string}} ids
 */
export async function deleteAgent(kaltura, ks, ids) {
  const attempts = [
    ['agent', () => ids.agentId && kaltura.agents.delete(ids.agentId, ks, { confirmPermanent: true })],
    ['avatar', () => ids.avatarId && kaltura.avatars.delete(ids.avatarId, ks, { confirmPermanent: true })],
    ['intellect', () => ids.configId && kaltura.intellects.delete(ids.configId, ks, { confirmPermanent: true })],
  ];
  for (const [what, fn] of attempts) {
    try { await fn(); } catch (err) { console.warn(`cleanup: ${what} delete failed — ${/** @type {any} */ (err)?.message || err}`); }
  }
}

/**
 * Mint everything one harness page needs. Called per page load so each scenario
 * gets fresh tokens; the widget token is secret-free, the conversation token
 * is what `KalturaChatSession`/`KalturaAgentSession` chat mode needs.
 * @param {Management} kaltura
 * @param {{widgetId:string, configId:string}} ids
 * @param {string|undefined} genieUrl
 */
export async function mintPageInit(kaltura, ids, genieUrl) {
  const widget = await kaltura.sessions.createWidgetToken({ widgetId: ids.widgetId });
  const init = await kaltura.application.appInit(widget.ks);
  const conversation = await kaltura.sessions.createConversationToken({ configId: ids.configId });
  return {
    ks: init.ks,
    conversationKs: conversation.ks,
    conversationManagerUrl: init.conversationManagerUrl,
    srsBaseUrl: init.srsBaseUrl,
    turnServerUrl: init.turnServerUrl,
    genieUrl: genieUrl || null,
  };
}

// ---------------------------------------------------------------------------
// Local static server
// ---------------------------------------------------------------------------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

/**
 * Serve repo files (so the harness can import `/src/experience/index.js`) plus
 * `/init`, which mints fresh tokens on every request via `mintInit()`.
 * @param {() => Promise<any>} mintInit
 * @returns {Promise<{server: import('node:http').Server, origin: string}>}
 */
export function startServer(mintInit) {
  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/init') {
      mintInit().then((data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      }, (err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      });
      return;
    }
    const filePath = resolve(repoRoot, `.${normalize(decodeURIComponent(path))}`);
    if (!filePath.startsWith(repoRoot) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => {
    const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
    ok({ server, origin: `http://127.0.0.1:${addr.port}` });
  }));
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/** Headless Chromium with a real (fake-device) media pipeline and auto-granted permissions. */
export function launchBrowser() {
  return chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
    ],
  });
}

/**
 * Strip anything that must not land in an artifact: KS tokens and URL query
 * strings (the socket URL carries the partner id as a query parameter).
 * @param {string} text
 */
export function redact(text) {
  return text
    .replace(/djJ8[A-Za-z0-9_=+/-]+/g, '<KS>')
    .replace(/((?:https?|wss?):\/\/[^\s"'?]+)\?[^\s"']*/g, '$1?<query>');
}

/**
 * Open the harness page with the given query params and wait for `window.__ready`.
 * Pages are pushed onto `sink.pages` so the caller can dump their event logs.
 * @param {import('playwright').BrowserContext} context
 * @param {string} origin
 * @param {Record<string, string|number|boolean|undefined>} params
 * @param {{pageErrors?: string[], pages?: import('playwright').Page[]}} [sink]
 */
export async function openHarness(context, origin, params, sink) {
  const page = await context.newPage();
  sink?.pages?.push(page);
  page.on('pageerror', (e) => sink?.pageErrors?.push(redact(String(e?.message || e))));
  page.on('console', (m) => { if (m.type() === 'error') sink?.pageErrors?.push(redact(`console.error: ${m.text()}`)); });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== false) qs.set(k, String(v));
  await page.goto(`${origin}/scripts/live-verify-kickoff.html?${qs}`);
  await page.waitForFunction(() => /** @type {any} */ (window).__ready === true, null, { timeout: 30_000 });
  return page;
}

// ---------------------------------------------------------------------------
// Event helpers (the harness records `{t, tRel, type, detail}` into window.__events)
// ---------------------------------------------------------------------------

/** @typedef {{t:number, tRel:number, type:string, detail?:any}} HarnessEvent */

/** @param {import('playwright').Page} page @returns {Promise<HarnessEvent[]>} */
export function events(page) {
  return page.evaluate(() => /** @type {any} */ (window).__events.slice());
}

/**
 * Poll the page every 100 ms until `pred(events)` returns a truthy value, or fail after `timeoutMs`.
 * @template T
 * @param {import('playwright').Page} page
 * @param {(evs: HarnessEvent[]) => T} pred
 * @param {number} timeoutMs
 * @param {string} what
 * @returns {Promise<{value: T, events: HarnessEvent[]}>}
 */
export async function waitFor(page, pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const evs = await events(page);
    const value = pred(evs);
    if (value) return { value, events: evs };
    if (Date.now() > deadline) throw new Error(`timeout after ${timeoutMs} ms waiting for ${what}; last events: ${JSON.stringify(evs.slice(-8).map((e) => e.type))}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * First event of `type` (optionally filtered) at or after index `from`.
 * @param {HarnessEvent[]} evs @param {string} type @param {{from?:number, where?:(d:any, e:HarnessEvent)=>boolean}} [opts]
 */
export function find(evs, type, opts = {}) {
  const from = opts.from ?? 0;
  for (let i = from; i < evs.length; i++) {
    const e = evs[i];
    if (e.type === type && (!opts.where || opts.where(e.detail, e))) return { ...e, index: i };
  }
  return null;
}

/** All events of `type` (optionally filtered). @param {HarnessEvent[]} evs @param {string} type @param {(d:any)=>boolean} [where] */
export function all(evs, type, where) {
  return evs.filter((e) => e.type === type && (!where || where(e.detail)));
}

/** Opening-turn speech ids end with `-approved-permissions`. @param {any} id */
export function isOpeningSpeechId(id) { return typeof id === 'string' && id.endsWith('-approved-permissions'); }

/** Outgoing `onTextEntered` wire events carrying real text (not barge-in markers). @param {HarnessEvent[]} evs */
export function textsSent(evs) {
  return all(evs, 'socket:out', (d) => d.ev === 'onTextEntered' && typeof d.text === 'string' && d.text.trim() !== '');
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
