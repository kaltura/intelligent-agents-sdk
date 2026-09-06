// Builds the public `sections.json` manifest that Nova's fire-and-forget `go_to`
// tool navigates against, straight from the HTML Eleventy just wrote. The key
// algorithm and manifest shape live in the SDK (`src/core/site-keys.js`), so
// this file only does two site-specific things: pull headings and
// `data-nova-target` anchors out of each page's <main>, and give those anchors
// a DOM id so the browser plugin can find them with getElementById.
//
// Zero dependencies. The markup is Eleventy's own output through base.njk, so a
// regex over that known shape is enough; no HTML parser needed.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSdkDir } from '../generate-docs.mjs';

/** Where the manifest lands inside the Eleventy output dir. Same path the browser fetches. */
export const MANIFEST_REL_PATH = 'nova/sections.json';

/** Only h2 headings (and hand-placed targets, which carry no level) become sections: about 25 tokens per page in the SITE MAP. Raise `depth` to 3 to include h3. */
export const MANIFEST_OPTIONS = Object.freeze({ lang: 'en', depth: 2 });

const MAIN_RE = /<main class="content-wrapper">([\s\S]*?)<\/main>/;
const HEADING_RE = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/g;
const TARGET_RE = /<([a-z][a-z0-9-]*)\b([^>]*\bdata-nova-target="([^"]+)"[^>]*)>/g;
const ID_ATTR_RE = /\bid="([^"]+)"/;
const ATTR_RE = (name) => new RegExp(`\\b${name}="([^"]*)"`);
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode the entities markdown-it emits (named, decimal, hex). */
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Visible text of an HTML fragment: tags stripped, entities decoded, whitespace collapsed. */
export function textOf(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Pull one page's title, headings and hand-placed targets out of built HTML.
 * Returns null for pages without the site's <main> wrapper (nothing to navigate to).
 * @param {string} html
 * @returns {{title:string, headings:Array<{id:string,text:string,level:number}>, targets:Array<{id:string,text:string}>}|null}
 */
export function extractPage(html) {
  const main = MAIN_RE.exec(html)?.[1];
  if (main == null) return null;
  const headings = [];
  let title = '';
  for (const m of main.matchAll(HEADING_RE)) {
    const level = Number(m[1]);
    const text = textOf(m[3]);
    if (level === 1) { if (!title) title = text; continue; }
    const id = ID_ATTR_RE.exec(m[2])?.[1];
    if (id) headings.push({ id, text, level });
  }
  if (!title) title = textOf(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? '').split(' — ')[0];
  const targets = [];
  const seen = new Set();
  for (const m of main.matchAll(TARGET_RE)) {
    const id = m[3];
    if (seen.has(id)) continue;
    seen.add(id);
    targets.push({ id, text: decodeEntities(ATTR_RE('data-nova-label').exec(m[2])?.[1] ?? '') });
  }
  return { title, headings, targets };
}

/**
 * Give every `data-nova-target="x"` element an `id="x"` so the browser plugin
 * can reach it by id, unless the page already has an element with that id
 * (a heading of the same slug, for example). Idempotent: running it twice
 * changes nothing the second time.
 * @param {string} html @returns {string}
 */
export function ensureTargetIds(html) {
  const ids = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  return html.replace(TARGET_RE, (whole, tag, attrs, target) => {
    if (ID_ATTR_RE.test(attrs) || ids.has(target)) return whole;
    ids.add(target);
    return `<${tag} id="${target}"${attrs}>`;
  });
}

/**
 * Locate the SDK checkout (`--sdk-dir` flag, `SDK_REPO_DIR` env, or the sibling
 * `../intelligent-agents-sdk`) and import its manifest builder. The build fails
 * loudly here rather than shipping a site without `sections.json`.
 * @returns {Promise<typeof import('../../../intelligent-agents-sdk/src/core/site-keys.js')>}
 */
export async function loadSiteKeys() {
  const sdkDir = resolveSdkDir();
  const file = join(sdkDir, 'src', 'core', 'site-keys.js');
  if (!existsSync(file)) {
    throw new Error(`sections-manifest: ${file} not found. The SDK checkout at ${sdkDir} predates site navigation (needs v1.16.1 or later).`);
  }
  return import(pathToFileURL(file).href);
}

/**
 * Build the manifest from Eleventy's `eleventy.after` results
 * (`{ url, outputPath, content }` per written file) or any equivalent list.
 * @param {Array<{url:string, outputPath?:string, content:string}>} results
 * @param {{generatedAt?:string}} [opts]
 * @returns {Promise<object>} The validated manifest.
 */
export async function buildManifest(results, opts = {}) {
  const { buildSectionsManifest } = await loadSiteKeys();
  const pages = [];
  for (const r of results) {
    if (r.outputPath && !r.outputPath.endsWith('.html')) continue;
    const page = extractPage(r.content);
    if (!page) continue;
    pages.push({ path: r.url, ...page });
  }
  return buildSectionsManifest(pages, { ...MANIFEST_OPTIONS, generatedAt: opts.generatedAt });
}

/**
 * Build and write `<outputDir>/nova/sections.json`. Same input, same file
 * (apart from `generatedAt`), so repeated builds are safe.
 * @param {Array<{url:string, outputPath?:string, content:string}>} results
 * @param {string} outputDir Eleventy output dir (`_site`).
 * @returns {Promise<{file:string, pages:number, sections:number}>}
 */
export async function writeManifest(results, outputDir) {
  const manifest = await buildManifest(results);
  const file = join(outputDir, MANIFEST_REL_PATH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(manifest)}\n`);
  return { file, pages: manifest.pages.length, sections: manifest.pages.reduce((n, p) => n + p.sections.length, 0) };
}
