#!/usr/bin/env node
// Build-time check for _site/nova/sections.json, the manifest Nova's go_to tool
// navigates against. Fails the build when the file is missing, invalid, stale
// (differs from a fresh rebuild out of _site/**/index.html), or points at a
// section id that does not exist on its page. Also prints the SITE MAP token
// estimate so a growing site is visible before it hits the prompt budget.
//
// Run after `npm run build`. Exit 0 = manifest is sound, 1 = any failure.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MANIFEST_REL_PATH, buildManifest, loadSiteKeys } from './lib/sections-manifest.mjs';
import { resolveSdkDir } from './generate-docs.mjs';

const SITE_DIR = new URL('../_site', import.meta.url).pathname;
const MANIFEST_FILE = join(SITE_DIR, MANIFEST_REL_PATH);
const SITE_MAP_TOKEN_BUDGET = 2000;

if (!existsSync(SITE_DIR)) {
  console.error('check-sections-manifest: _site/ not found — run `npm run build` first');
  process.exit(1);
}
if (!existsSync(MANIFEST_FILE)) {
  console.error(`check-sections-manifest: ${MANIFEST_FILE} not found — the eleventy.after hook did not run`);
  process.exit(1);
}

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

// file path → site URL path ("/reference/api-reference/"), same rule as check-anchors.
function urlOf(file) {
  const rel = relative(SITE_DIR, file);
  if (rel === 'index.html') return '/';
  return '/' + rel.replace(/index\.html$/, '').replace(/\.html$/, '/');
}

const failures = [];
const fail = (msg) => failures.push(msg);

const { validateSectionsManifest, renderSiteMap } = await loadSiteKeys();
const sdkDir = resolveSdkDir();
const { estimateTokens } = await import(pathToFileURL(join(sdkDir, 'src', 'management', 'site-nav.js')).href);

let manifest;
try {
  manifest = validateSectionsManifest(JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')));
} catch (e) {
  console.error(`check-sections-manifest: ${MANIFEST_FILE} is invalid: ${e.detail || e.message}`);
  process.exit(1);
}

// 1. Same input, same manifest: rebuild from the HTML on disk and compare (minus the timestamp).
const results = htmlFiles(SITE_DIR).map((file) => ({ url: urlOf(file), outputPath: file, content: readFileSync(file, 'utf8') }));
const rebuilt = await buildManifest(results, { generatedAt: manifest.generatedAt });
if (JSON.stringify(rebuilt) !== JSON.stringify(manifest)) {
  fail('manifest differs from a fresh rebuild out of _site/ (the eleventy.after hook and this check disagree, or _site/ was edited after the build)');
}

// 2. Every manifest page is a built page, and every built page with a <main> is in the manifest.
const built = new Map(results.map((r) => [r.url, r.content]));
const listed = new Set(manifest.pages.map((p) => p.path));
for (const path of listed) if (!built.has(path)) fail(`manifest page ${path} has no built HTML`);
for (const [url, html] of built) {
  if (!listed.has(url) && html.includes('<main class="content-wrapper">')) fail(`built page ${url} is missing from the manifest`);
}

// 3. Every section id is a real DOM id on its page (what getElementById will find at runtime).
for (const page of manifest.pages) {
  const html = built.get(page.path);
  if (!html) continue;
  const ids = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), (m) => m[1]));
  const keys = new Set();
  for (const s of page.sections) {
    if (!ids.has(s.id)) fail(`${page.path} section "${s.key}" points at id="${s.id}" which is not in the page`);
    if (keys.has(s.key)) fail(`${page.path} has duplicate section key "${s.key}"`);
    keys.add(s.key);
  }
}

// 4. Prompt budget: warn only. The SDK's siteMapPrompt warns at the same threshold when Nova is provisioned.
const siteMap = renderSiteMap(manifest);
const tokens = estimateTokens(siteMap);
const sections = manifest.pages.reduce((n, p) => n + p.sections.length, 0);
if (tokens > SITE_MAP_TOKEN_BUDGET) {
  console.warn(`check-sections-manifest: WARNING SITE MAP is ~${tokens} tokens (budget ${SITE_MAP_TOKEN_BUDGET}); trim headings or stop words`);
}

if (failures.length) {
  console.error(`check-sections-manifest: ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-sections-manifest: OK — ${manifest.pages.length} pages, ${sections} sections, SITE MAP ~${tokens} tokens`);
