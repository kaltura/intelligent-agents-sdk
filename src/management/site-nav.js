/**
 * site-nav (management side) — provision a fire-and-forget `go_to` client tool
 * and the two prompt blocks that make it work: a compact SITE MAP and the
 * navigation rules. Pair it with `experience/site-nav` in the browser.
 *
 * ```js
 * import { Management, goToTool, siteMapPrompt, SITE_NAV_RULES_PROMPT, PAGE_CONTEXT_PROMPT, loadSectionsManifest } from '@kaltura/intelligent-agents/management';
 *
 * const manifest = await loadSectionsManifest('https://docs.example.com/nova/sections.json');
 * const tool = await m.tools.add(goToTool({ siteLabel: 'the Example docs' }), ks);
 * await m.intellects.create({
 *   tool_ids: [tool.id],
 *   allow_client_variables: true,
 *   prompts: [identity, siteMapPrompt(manifest), SITE_NAV_RULES_PROMPT, PAGE_CONTEXT_PROMPT],
 *   ...
 * }, ks);
 * ```
 *
 * Why fire-and-forget: the tool has `wait_for_response: false`, so the model
 * writes its answer right after emitting the call and the client never sends a
 * result back. There is nothing to time out on and nothing to retry, which is
 * what keeps a navigation tool from spiralling.
 */

import { client } from './tools.js';
import { KalturaError } from '../core/errors.js';
import { renderSiteMap, validateSectionsManifest } from '../core/site-keys.js';

/** Tool name the rules prompt and the browser plugin default to. */
export const SITE_NAV_TOOL_NAME = 'go_to';

/** Default manifest size guard for {@link loadSectionsManifest} (P-1). */
const DEFAULT_MANIFEST_MAX_BYTES = 512 * 1024;

/** @param {string} code @param {string} detail @param {number} [status] @returns {KalturaError} */
function err(code, detail, status) {
  return new KalturaError({ type: 'about:blank', title: code.replace(/_/g, ' '), code, detail, status });
}

/**
 * Build the `go_to` client tool config. Pass the result to `tools.add()` or
 * `tools.update(id, { config })`. Idempotent: same options, same config.
 *
 * @param {object} [opts]
 * @param {string} [opts.name='go_to'] Tool name. Keep `go_to` unless you also change {@link SITE_NAV_RULES_PROMPT}.
 * @param {string} [opts.siteLabel='the docs site'] How the site is named in the tool description, e.g. `'the Acme help center'`.
 * @param {number} [opts.timeout=5] Backend timeout in seconds (integer 1..120). Irrelevant for a fire-and-forget tool but required by the API.
 * @param {string} [opts.displayName] Optional human label shown in tooling.
 * @returns {object} Wire-shaped tool config (`type: 'client'`, `wait_for_response: false`).
 */
export function goToTool(opts = {}) {
  const { name = SITE_NAV_TOOL_NAME, siteLabel = 'the docs site', timeout = 5, displayName } = opts;
  const cfg = {
    name,
    description: [
      `Bring the visitor to a page of ${siteLabel}, optionally scrolled to a section.`,
      'path: a path exactly as listed in the SITE MAP (for example /guides/pause-resume/).',
      'section: one of that page\'s section keys from the SITE MAP (for example troubleshooting). Omit to open the page top.',
      'Call at most once per turn, then answer. There is no result to wait for.',
    ].join(' '),
    args: /** @type {Record<string, import('./tools.js').GenieToolArg>} */ ({
      path: { prompt: 'Page path from the SITE MAP, with leading and trailing slash.', type: 'str', required: true },
      section: { prompt: 'Section key from the SITE MAP for that page. Omit for the page top.', type: 'str', required: false },
    }),
    waitForResponse: false,
    timeout,
  };
  if (displayName) cfg.displayName = displayName;
  return client(cfg);
}

/**
 * Rough token estimate for budget warnings (about 3.2 characters per token,
 * which matches hyphenated slugs and paths within ±20%). Not a tokenizer.
 * @param {string} text @returns {number}
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  return Math.ceil(s.length / 3.2);
}

/**
 * Render a manifest as the SITE MAP prompt block the model reads: one line per
 * page, `path: key1, key2`. Warns (never throws) when the estimated token cost
 * exceeds `maxTokens`, so a growing site is visible in provisioning logs.
 *
 * @param {import('../core/site-keys.js').SectionsManifest|{pages:Array}} manifest
 * @param {object} [opts]
 * @param {string} [opts.key='siteMap'] Prompt key.
 * @param {string} [opts.label='Site map'] Prompt label shown in tooling.
 * @param {number} [opts.maxTokens=2000] Warn threshold.
 * @param {(msg:string)=>void} [opts.warn=console.warn] Warning sink (inject to silence or capture).
 * @returns {{key:string,label:string,headerTemplate:string,type:'custom',value:string}}
 */
export function siteMapPrompt(manifest, opts = {}) {
  const { key = 'siteMap', label = 'Site map', maxTokens = 2000, warn = (m) => console.warn(m) } = opts;
  const value = renderSiteMap(manifest);
  const tokens = estimateTokens(value);
  if (tokens > maxTokens) warn(`[site-nav] SITE MAP is ~${tokens} tokens (limit ${maxTokens}). Consider depth: 2, more stop words, or splitting the site.`);
  return { key, label, headerTemplate: 'SITE MAP. One line per page: path, then that page\'s section keys.', type: 'custom', value };
}

/**
 * Navigation rules prompt block. Wording is the variant that measured best
 * live (zero calls on unmapped topics, one call per mapped ask, no screen
 * narration). Place it right after the SITE MAP and before `PAGE_CONTEXT_PROMPT`.
 * @type {Readonly<{key:string,label:string,headerTemplate:string,type:'custom',value:string}>}
 */
export const SITE_NAV_RULES_PROMPT = Object.freeze({
  key: 'navRules',
  label: 'Navigation rules',
  headerTemplate: 'Navigation rules:',
  type: 'custom',
  value: [
    `${SITE_NAV_TOOL_NAME} rules:`,
    `1. Topic is covered by a SITE MAP page: call ${SITE_NAV_TOOL_NAME} once (best path, plus a section key when one fits). Then answer in one or two sentences.`,
    `2. No SITE MAP page covers the topic: do not call ${SITE_NAV_TOOL_NAME}. Answer in one sentence from what you know, or say the docs do not cover it.`,
    `3. One ${SITE_NAV_TOOL_NAME} per reply, never two. If two pages fit, pick the one the visitor asked for first.`,
    '4. Never mention the screen. Do not say a page is open, is here, is showing, is loaded, or that you opened, showed, navigated, brought, pulled up or pointed to anything. Do not say "I\'ll look up" or "let me check". Your first sentence is the first fact of the answer.',
  ].join('\n'),
});

/**
 * Fetch and validate a `sections.json` manifest (server-side, at provisioning
 * time). Size-guarded, then passed through {@link validateSectionsManifest}.
 *
 * @param {string} url Absolute URL of the manifest.
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch] Fetch implementation (defaults to the global one).
 * @param {number} [opts.maxBytes=524288] Reject responses larger than this.
 * @param {number} [opts.timeoutMs=15000] Abort the request after this long.
 * @returns {Promise<import('../core/site-keys.js').SectionsManifest>}
 */
export async function loadSectionsManifest(url, opts = {}) {
  const { fetch: f = globalThis.fetch, maxBytes = DEFAULT_MANIFEST_MAX_BYTES, timeoutMs = 15000 } = opts;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw err('bad_arg', 'loadSectionsManifest needs an http(s) URL');
  if (typeof f !== 'function') throw err('bad_arg', 'loadSectionsManifest needs a fetch implementation');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let text;
  try {
    const res = await f(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw err('http_error', `sections manifest fetch failed: HTTP ${res.status}`, res.status);
    const declared = Number(res.headers?.get?.('content-length'));
    if (declared > maxBytes) throw err('too_large', `sections manifest is ${declared} bytes (limit ${maxBytes})`);
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }
  if (text.length > maxBytes) throw err('too_large', `sections manifest is ${text.length} bytes (limit ${maxBytes})`);
  let raw;
  try { raw = JSON.parse(text); } catch { throw err('bad_manifest', 'sections manifest is not valid JSON'); }
  return validateSectionsManifest(raw);
}
