/**
 * Shared plumbing for the two live kickoff scripts:
 *   scripts/live-verify-connect-timing.mjs
 *   scripts/live-verify-kickoff.mjs
 *
 * Owns: CLI + .env parsing, environment targets, throwaway-agent provisioning
 * with a SILENT_OPENING opening phrase, the local static server that backs
 * `scripts/live-verify-kickoff.html`, browser launch (Chromium, Google Chrome,
 * Firefox, WebKit; headless or headed) with fake media, and the event-polling
 * helpers both scripts assert with.
 *
 * Nothing here is imported by the SDK. Credentials come from the environment
 * or a .env file; none are written to the artifacts.
 */
import { readFileSync, writeFileSync, mkdirSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium, firefox, webkit } from 'playwright';
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
 * | `nvp1` | `NVP1_AGENTIC_PARTNER_ID` / `NVP1_AGENTIC_ADMIN_SECRET` | `NVP1_AGENTIC_API_URL`, `NVP1_GENIE_URL`, `NVP1_KALTURA_API_ENDPOINT` |
 *
 * Every URL override is passed explicitly to `Management`, so a target never
 * falls back to the production defaults by accident. `nvp1` is production
 * reached through explicit URLs (same backend as `prod`, different env names).
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
  if (name === 'nvp1') {
    need(['NVP1_AGENTIC_PARTNER_ID', 'NVP1_AGENTIC_ADMIN_SECRET', 'NVP1_AGENTIC_API_URL', 'NVP1_GENIE_URL', 'NVP1_KALTURA_API_ENDPOINT']);
    return {
      name,
      partnerId: process.env.NVP1_AGENTIC_PARTNER_ID,
      adminSecret: process.env.NVP1_AGENTIC_ADMIN_SECRET,
      agenticUrl: process.env.NVP1_AGENTIC_API_URL,
      genieUrl: process.env.NVP1_GENIE_URL,
      ovpUrl: process.env.NVP1_KALTURA_API_ENDPOINT,
    };
  }
  console.error(`--env ${name}: unknown target (expected prod, nvq2 or nvp1).`);
  process.exit(1);
}

/** Browser engines the live scripts can drive. `chrome` is the installed Google Chrome via Playwright's `channel`. */
export const BROWSERS = ['chromium', 'chrome', 'firefox', 'webkit'];

/**
 * Pick the browser from `--browser` / `--headed` flags.
 * @param {Record<string, string|boolean>} args
 * @returns {{browser: string, headed: boolean}}
 */
export function browserChoice(args) {
  const browser = typeof args.browser === 'string' ? args.browser : 'chromium';
  if (!BROWSERS.includes(browser)) {
    console.error(`--browser ${browser}: unknown (expected ${BROWSERS.join(', ')}).`);
    process.exit(1);
  }
  return { browser, headed: args.headed === true };
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
  // Escape backslashes first, then pipes, so a cell can never break the table row.
  const cell = (/** @type {string|number} */ v) => String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  const line = (/** @type {(string|number)[]} */ cells) => `| ${cells.map(cell).join(' | ')} |`;
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
 * Provision a throwaway agent whose intellect opening phrase is
 * `opts.openingPhrase` (default SILENT_OPENING), or reuse the ids in
 * `--agent-json <path>` (`{configId, agentId, widgetId, avatarId?}`).
 * Returns the ids plus a `cleanup()` that deletes only what this call created.
 * @param {Management} kaltura
 * @param {string} adminKs
 * @param {{agentJson?:string, keep?:boolean, brief?:string, openingPhrase?:string}} opts
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
      openingPhrase: opts.openingPhrase ?? SILENT_OPENING,
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

const HARNESS_PATH = '/scripts/live-verify-kickoff.html';
export const SOCKET_IO_CDN = 'https://cdn.socket.io/4.7.5/socket.io.min.js';

/** @typedef {{rel: string, href: string, as?: string, crossorigin?: string}} ResourceHint */

/**
 * The `<link>` resource hints an app would add to its `<head>` for a faster
 * first connect, derived from the same init payload the harness connects with:
 *
 * | hint | target | why |
 * |---|---|---|
 * | `preconnect` | socket origin | DNS + TCP + TLS before the socket.io handshake |
 * | `preconnect crossorigin` | socket origin | same, on the CORS pool `fetch()` uses: the WHEP POST URL comes from the server's session reply and lives on this origin |
 * | `preconnect crossorigin` | `srsBaseUrl` origin | only when it differs from the socket origin (the SDK's fallback WHEP host) |
 * | `dns-prefetch` | TURN host | only DNS; TURN is UDP/TLS from the ICE agent, not an HTTP pool |
 * | `preload as=script crossorigin` | socket.io CDN script | matches the `<script integrity crossorigin>` tag |
 * | `modulepreload` | SDK entry module | fetch + parse the module graph before the inline module runs |
 *
 * Origins come from the init response at runtime, never from a fixed list.
 * @param {{conversationManagerUrl?: string, srsBaseUrl?: string, turnServerUrl?: string}} init
 * @returns {ResourceHint[]}
 */
export function resourceHints(init) {
  const origin = (/** @type {string|undefined} */ u) => { try { return u ? new URL(u).origin : null; } catch { return null; } };
  const turnHost = String(init.turnServerUrl || '').replace(/\/$/, '').replace(/^turns?:/, '').split(':')[0];
  /** @type {ResourceHint[]} */
  const hints = [];
  const socket = origin(init.conversationManagerUrl);
  const whep = origin(init.srsBaseUrl);
  if (socket) {
    hints.push({ rel: 'preconnect', href: socket });
    hints.push({ rel: 'preconnect', href: socket, crossorigin: 'anonymous' });
  }
  if (whep && whep !== socket) hints.push({ rel: 'preconnect', href: whep, crossorigin: 'anonymous' });
  if (turnHost) hints.push({ rel: 'dns-prefetch', href: `//${turnHost}` });
  hints.push({ rel: 'preload', href: SOCKET_IO_CDN, as: 'script', crossorigin: 'anonymous' });
  hints.push({ rel: 'modulepreload', href: '/src/experience/index.js' });
  return hints;
}

/** @param {ResourceHint[]} hints */
export function hintTags(hints) {
  const esc = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return hints.map((h) => {
    const attrs = [`rel="${esc(h.rel)}"`, `href="${esc(h.href)}"`];
    if (h.as) attrs.push(`as="${esc(h.as)}"`);
    if (h.crossorigin) attrs.push(`crossorigin="${esc(h.crossorigin)}"`);
    return `  <link ${attrs.join(' ')}>`;
  }).join('\n');
}

/**
 * Serve repo files (so the harness can import `/src/experience/index.js`) plus
 * `/init`, which mints fresh tokens on every request via `mintInit()`.
 *
 * With `hints`, a request for the harness page carrying `?hints=1` gets the
 * `<link>` tags injected right after `<meta charset>`, before the socket.io
 * `<script>`. The browser then sees them exactly as it would in a real app's
 * static HTML, before any script runs. Without `hints=1` the file is served
 * byte-for-byte, so the same server can run both arms of an A/B.
 * @param {() => Promise<any>} mintInit
 * @param {{hints?: ResourceHint[]}} [opts]
 * @returns {Promise<{server: import('node:http').Server, origin: string}>}
 */
export function startServer(mintInit, { hints } = {}) {
  const server = createServer((req, res) => {
    const [path, query = ''] = (req.url || '/').split('?');
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }   // keeps the console free of a 404 on first load
    if (path === HARNESS_PATH && hints?.length && new URLSearchParams(query).get('hints') === '1') {
      const html = readFileSync(resolve(repoRoot, `.${HARNESS_PATH}`), 'utf8');
      const marker = '<meta charset="utf-8">';
      if (!html.includes(marker)) { res.writeHead(500); res.end('harness head marker missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html.replace(marker, `${marker}\n${hintTags(hints)}`));
      return;
    }
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

/** Set by `launchBrowser`; `openHarness` uses it to pick browser-specific harness params. */
let activeBrowser = { name: 'chromium', headed: false };

/**
 * Launch a browser with a real media pipeline and auto-granted permissions.
 *
 * | browser | mic | notes |
 * |---|---|---|
 * | `chromium` (default) | Chromium's fake device | headless unless `headed` |
 * | `chrome` | fake device | the installed Google Chrome, always headed, audio audible |
 * | `firefox` | Firefox's fake stream (`media.navigator.streams.fake`) | `isFirefox` is set by the harness from the UA |
 * | `webkit` | synthetic silent track from the harness (`mic=synthetic`) | WebKit has no fake-device flag |
 *
 * Headless Chromium mutes audio output; a headed run leaves it audible so a
 * person can confirm what the analyser in the harness measures.
 * @param {{browser?: string, headed?: boolean}} [opts]
 */
export function launchBrowser({ browser = 'chromium', headed = false } = {}) {
  activeBrowser = { name: browser, headed: headed || browser === 'chrome' };
  const chromiumArgs = [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ];
  if (browser === 'chrome') return chromium.launch({ channel: 'chrome', headless: false, args: chromiumArgs });
  if (browser === 'chromium') return chromium.launch({ headless: !headed, args: headed ? chromiumArgs : [...chromiumArgs, '--mute-audio'] });
  if (browser === 'firefox') {
    return firefox.launch({
      headless: !headed,
      firefoxUserPrefs: {
        'media.navigator.streams.fake': true,
        'media.navigator.permission.disabled': true,
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
        'media.autoplay.block-webaudio': false,
        // Playwright's Firefox ships without the OpenH264 plugin, so it offers only VP8/VP9/AV1
        // and the media server (H264 only) answers the video section `inactive`. This pref lets
        // Firefox use the platform hardware H264 decoder instead, the same way stock Firefox with
        // OpenH264 would receive the stream.
        'media.webrtc.hw.h264.enabled': true,
      },
    });
  }
  if (browser === 'webkit') return webkit.launch({ headless: !headed });
  throw new Error(`unknown browser ${browser}`);
}

export function browserInfo() { return { ...activeBrowser }; }

/**
 * Options for `browser.newContext()` on the active engine. Chromium-based
 * engines take `permissions: ['microphone']`; Firefox and WebKit reject that
 * name (`Unknown permission: microphone`) and grant the mic through the launch
 * prefs / the harness's synthetic track instead.
 * @param {Record<string, any>} [extra]
 */
export function contextOptions(extra = {}) {
  const chromiumLike = activeBrowser.name === 'chromium' || activeBrowser.name === 'chrome';
  return { ...(chromiumLike ? { permissions: ['microphone'] } : {}), ...extra };
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

/** @typedef {{t:number, kind:'request'|'response'|'failed', method:string, url:string, status?:number, error?:string, resourceType:string}} NetRecord */

/**
 * Open the harness page with the given query params and wait for `window.__ready`.
 * Pages are pushed onto `sink.pages` so the caller can dump their event logs.
 * Every cross-origin HTTP request (WHEP POST/DELETE, token calls) is recorded
 * into `sink.network` with its outcome, so a "failed" console line can be tied
 * to the exact request. URLs are redacted (no query strings, no tokens).
 *
 * Browser-specific defaults: WebKit gets `mic=synthetic` unless the caller
 * chose a mic mode (no fake-device flag exists there); a headed run gets
 * `headed=1` so the harness knows audio output is real.
 * @param {import('playwright').BrowserContext} context
 * @param {string} origin
 * @param {Record<string, string|number|boolean|undefined>} params
 * @param {{pageErrors?: string[], pages?: import('playwright').Page[], network?: NetRecord[]}} [sink]
 */
export async function openHarness(context, origin, params, sink) {
  const page = await context.newPage();
  sink?.pages?.push(page);
  page.on('pageerror', (e) => sink?.pageErrors?.push(redact(String(e?.message || e))));
  page.on('console', (m) => { if (m.type() === 'error') sink?.pageErrors?.push(redact(`console.error: ${m.text()}`)); });
  const isExternal = (/** @type {string} */ url) => !url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:');
  page.on('request', (r) => { if (isExternal(r.url())) sink?.network?.push({ t: Date.now(), kind: 'request', method: r.method(), url: redact(r.url()), resourceType: r.resourceType() }); });
  page.on('response', (r) => { const q = r.request(); if (isExternal(q.url())) sink?.network?.push({ t: Date.now(), kind: 'response', method: q.method(), url: redact(q.url()), status: r.status(), resourceType: q.resourceType() }); });
  page.on('requestfailed', (r) => { if (isExternal(r.url())) sink?.network?.push({ t: Date.now(), kind: 'failed', method: r.method(), url: redact(r.url()), error: r.failure()?.errorText, resourceType: r.resourceType() }); });
  const merged = { ...params };
  if (activeBrowser.name === 'webkit' && merged.mic === undefined) merged.mic = 'synthetic';
  if (activeBrowser.headed) merged.headed = 1;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== false) qs.set(k, String(v));
  await page.goto(`${origin}/scripts/live-verify-kickoff.html?${qs}`);
  await page.waitForFunction(() => /** @type {any} */ (window).__ready === true, null, { timeout: 30_000 });
  return page;
}

/**
 * Summarise WHEP traffic (`/rtc/` or `whep`/`whip` in the path) for a report:
 * one line per request with its outcome.
 * @param {NetRecord[]} net
 */
export function whepSummary(net) {
  const isWhep = (/** @type {string} */ u) => /\/rtc\/|whep|whip/i.test(u);
  const out = [];
  for (const r of net) {
    if (!isWhep(r.url) || r.kind === 'request') continue;
    out.push(`${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, '')} → ${r.kind === 'failed' ? `FAILED ${r.error}` : r.status}`);
  }
  return out;
}

/**
 * Every cross-origin HTTP request that failed or got a 4xx/5xx, one line each
 * (`METHOD host/path → status|FAILED err`), so a console "Failed to load
 * resource" line can be tied to the request behind it.
 * @param {NetRecord[]} net
 */
export function netProblems(net) {
  const out = [];
  for (const r of net) {
    if (r.kind === 'request') continue;
    if (r.kind === 'response' && (r.status ?? 0) < 400) continue;
    out.push(`${r.method} ${r.url.replace(/^https?:\/\//, '')} → ${r.kind === 'failed' ? `FAILED ${r.error}` : r.status}`);
  }
  return out;
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
