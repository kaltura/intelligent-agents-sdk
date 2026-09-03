#!/usr/bin/env node
// Regenerates src/**/*.md (for every manifest entry with generated:true) and
// src/_data/nav.js from the SDK repo's own docs, per scripts/docs-manifest.mjs.
// Never touches a generated:false (hand-authored) target.
//
// Usage: node scripts/generate-docs.mjs [--sdk-dir <path>] [--site-dir <path>]
// Env:   SDK_REPO_DIR, SITE_REPO_DIR (used when the matching flag is omitted)
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest, findBySource, basenameIndex } from './docs-manifest.mjs';
import githubSlugify from './lib/github-slugify.js';

const SITE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SDK_DIR = resolve(SITE_REPO_ROOT, '..', 'intelligent-agents-sdk');
const GITHUB_BLOB_BASE = 'https://github.com/kaltura/intelligent-agents-sdk/blob/main/';

// Root-level SDK docs that are intentionally never ported to the site (contributor-
// facing, not user-facing). Anything else new at the SDK repo's root or under docs/
// must get a manifest entry — see checkSourceCoverage — so a new doc file can never
// silently miss the site the way docs/lifecycle/ once did.
const ROOT_DOC_IGNORE = new Set(['README.md', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'SDK_CONSTITUTION.md']);

function walkMarkdown(dir, base = dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkMarkdown(p, base));
    else if (ent.name.endsWith('.md')) out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

export function checkSourceCoverage(sdkDir) {
  const rootMd = readdirSync(sdkDir).filter((n) => n.endsWith('.md') && !ROOT_DOC_IGNORE.has(n));
  const docsMd = walkMarkdown(resolve(sdkDir, 'docs')).map((p) => `docs/${p}`);
  const discovered = new Set([...rootMd, ...docsMd]);
  const manifestSources = new Set(manifest.filter((e) => e.source).map((e) => e.source));
  const missing = [...discovered].filter((s) => !manifestSources.has(s));
  const stale = [...manifestSources].filter((s) => !discovered.has(s));
  if (missing.length || stale.length) {
    const parts = [];
    if (missing.length) parts.push(`new SDK doc(s) with no manifest entry — add one to docs-manifest.mjs:\n  ${missing.join('\n  ')}`);
    if (stale.length) parts.push(`manifest entries whose source no longer exists in the SDK repo:\n  ${stale.join('\n  ')}`);
    throw new Error(`docs-manifest.mjs is out of sync with ${sdkDir}:\n\n${parts.join('\n\n')}`);
  }
}

function flagOrEnv(argv, env, flag, envVar, fallback) {
  const eqFlag = argv.find((a) => a.startsWith(`${flag}=`));
  const idx = argv.indexOf(flag);
  const flagValue = eqFlag ? eqFlag.slice(flag.length + 1) : idx >= 0 ? argv[idx + 1] : null;
  return resolve(flagValue || env[envVar] || fallback);
}

export function resolveSdkDir({ argv = process.argv, env = process.env } = {}) {
  const dir = flagOrEnv(argv, env, '--sdk-dir', 'SDK_REPO_DIR', DEFAULT_SDK_DIR);
  if (!existsSync(resolve(dir, 'GETTING-STARTED.md')) || !existsSync(resolve(dir, 'docs', 'ARCHITECTURE.md'))) {
    throw new Error(`SDK repo checkout not found at ${dir} (expected GETTING-STARTED.md + docs/ARCHITECTURE.md) — pass --sdk-dir <path> or set SDK_REPO_DIR`);
  }
  return dir;
}

export function resolveSiteDir({ argv = process.argv, env = process.env } = {}) {
  return flagOrEnv(argv, env, '--site-dir', 'SITE_REPO_DIR', SITE_REPO_ROOT);
}

function stripH1(body) {
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => l.startsWith('# '));
  if (idx === -1) return body;
  lines.splice(idx, 1);
  return lines.join('\n');
}

function frontMatter(entry) {
  return [
    '---',
    'layout: base.njk',
    `title: "${entry.title.replace(/"/g, '\\"')}"`,
    `description: "${entry.description.replace(/"/g, '\\"')}"`,
    `eyebrow: ${/[:#]/.test(entry.eyebrow) ? `"${entry.eyebrow}"` : entry.eyebrow}`,
    '---',
    '',
  ].join('\n');
}

// Every `##` heading (in source order) becomes one "On this page" entry,
// linked verbatim to its own heading text — not a hand-paraphrased shorter
// label — so this stays reproducible without editorial judgment on every run.
function buildQuickNav(body) {
  const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  if (headings.length < 2) return null;
  const links = headings.map((h) => `[${h}](#${githubSlugify(h)})`);
  return `**On this page:** ${links.join(' · ')}`;
}

function insertQuickNav(body, quickNav) {
  if (!quickNav) return body;
  const lines = body.split('\n');
  // Intro block = everything before the first "##" heading or "---" divider.
  let introEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ') || lines[i].trim() === '---') {
      introEnd = i;
      break;
    }
  }
  // First paragraph of the intro = up to the first blank line inside it.
  let paraEnd = introEnd;
  for (let i = 0; i < introEnd; i++) {
    if (lines[i].trim() === '' && i > 0) {
      paraEnd = i;
      break;
    }
  }
  return [...lines.slice(0, paraEnd), '', quickNav, ...lines.slice(paraEnd)].join('\n');
}

function resolveRelativePath(fromSource, href) {
  const dir = posix.dirname(fromSource);
  const normalized = posix.normalize(posix.join(dir, href));
  return normalized.replace(/^\.\//, '');
}

// Finds the longest basenameIndex key that appears in `stripped`, for prose
// that cites a pre-split monolith's own root filename (e.g. "API-REFERENCE.md
// § Initialize the Runtime") even though the href beside it already points
// at the specific split sub-page that now owns that section. Longest match
// wins so a hub name never shadows a more specific one that also matches.
function findAltBasenameMatch(stripped) {
  let best = null;
  for (const [name, entry] of basenameIndex) {
    const idx = stripped.indexOf(name);
    if (idx !== -1 && (!best || name.length > best.name.length)) best = { name, entry, idx };
  }
  return best;
}

function retitleLinkText(text, basename, title, resolved, rawPath) {
  const stripped = text.replace(/^`(.*)`$/, '$1');
  // Some source docs use a relative path as the link text itself — either
  // written the same way as the href ("[architecture-reference/channels.md]
  // (architecture-reference/channels.md)") or repo-root-relative regardless
  // of the href's own form ("[docs/lifecycle/README.md](../lifecycle/README.md)"),
  // sometimes with a "§N" suffix ("[wire-protocol/audio-channels.md §5](...)").
  // A directory prefix right before the basename is that path convention
  // leaking into prose — noise to drop — but a suffix after it (a section
  // reference) is meaningful and must survive the retitle.
  if (stripped === basename || stripped === resolved || stripped === rawPath) return title;
  let idx = stripped.indexOf(basename);
  let matchLen = basename.length;
  let matchTitle = title;
  if (idx === -1) {
    const alt = findAltBasenameMatch(stripped);
    if (!alt) return text;
    idx = alt.idx;
    matchLen = alt.name.length;
    matchTitle = alt.entry.title;
  }
  const prefix = stripped.slice(0, idx);
  const suffix = stripped.slice(idx + matchLen);
  const cleanPrefix = /^[\w./-]*$/.test(prefix) ? '' : prefix;
  return `${cleanPrefix}${matchTitle}${suffix}`;
}

// A link to another SDK doc's own H1 (its self-anchor, e.g. a pre-split
// "§7" cross-reference) breaks once generated: stripH1 removes the numeral
// prefix from the displayed heading, so the id the site actually renders no
// longer matches the fragment the source doc's link was written against.
// Translate that one specific case — fragment equals the target's *original*
// H1 slug — to the slug the manifest's own h1 will actually render as.
const h1SlugCache = new Map();

function originalH1Slug(target, sdkDir) {
  if (!h1SlugCache.has(target.source)) {
    const raw = readFileSync(resolve(sdkDir, target.source), 'utf8');
    const m = raw.match(/^# (.+)$/m);
    h1SlugCache.set(target.source, m ? githubSlugify(m[1].trim()) : null);
  }
  return h1SlugCache.get(target.source);
}

function rewriteLinks(body, sourcePath, sdkDir) {
  return body.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, bang, text, href) => {
    if (bang) return whole; // image embed — handled by rewriteImages
    if (/^(https?:)?\/\//.test(href) || href.startsWith('mailto:') || href.startsWith('#')) return whole;
    const [rawPath, fragment] = href.split('#');
    if (!rawPath) return whole; // pure same-page fragment
    const resolved = resolveRelativePath(sourcePath, rawPath);
    const target = findBySource(resolved);
    if (target) {
      const fixedFragment = fragment && fragment === originalH1Slug(target, sdkDir)
        ? githubSlugify(target.h1)
        : fragment;
      const newHref = fixedFragment ? `${target.url}#${fixedFragment}` : target.url;
      const basename = posix.basename(resolved);
      const newText = retitleLinkText(text, basename, target.title, resolved, rawPath);
      return `[${newText}](${newHref})`;
    }
    const blobUrl = `${GITHUB_BLOB_BASE}${resolved}${fragment ? `#${fragment}` : ''}`;
    return `[${text}](${blobUrl})`;
  });
}

// A page's URL depth varies (e.g. /reference/api/design/ vs /guides/), so an
// image path copied verbatim from the SDK repo's docs tree would resolve
// differently per page. Every embed is copied into the site's own
// src/assets/img/ (served by Eleventy's passthrough copy) and rewritten to
// an absolute /assets/img/<basename> path instead.
function rewriteImages(body, sourcePath, sdkDir, siteDir) {
  return body.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt, href) => {
    if (/^(https?:)?\/\//.test(href)) return whole;
    const resolved = resolveRelativePath(sourcePath, href);
    const basename = posix.basename(resolved);
    const destAsset = resolve(siteDir, 'src', 'assets', 'img', basename);
    mkdirSync(dirname(destAsset), { recursive: true });
    copyFileSync(resolve(sdkDir, resolved), destAsset);
    return `![${alt}](/assets/img/${basename})`;
  });
}

// `data-nova-target` divs are consumed by docs-site-avatar's eval harness (see
// tests/eval/site-data.mjs there) to build Nova's curated highlight-target
// inventory. The SDK repo's own doc authors mark the exact content with
// `<!-- nova-target: id | label --> ... <!-- /nova-target -->` around it —
// living in the SDK source means the marker moves with the content on every
// edit there, instead of a site-side anchor that goes stale the moment the
// SDK repo's prose changes.
const NOVA_TARGET_RE = /<!--\s*nova-target:\s*([\w-]+)\s*\|\s*([^-][\s\S]*?)\s*-->\n([\s\S]*?)\n<!--\s*\/nova-target\s*-->/g;

// Strips only leading/trailing blank *lines*, not whitespace within a kept
// line — a marked block nested in a list relies on its first/last line's own
// indentation to stay part of that list.
function trimBlankLines(s) {
  return s.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
}

function applyNovaTargets(body) {
  return body.replace(NOVA_TARGET_RE, (whole, target, label, inner) => (
    `<div data-nova-target="${target}" data-nova-label="${label}">\n\n${trimBlankLines(inner)}\n\n</div>`
  ));
}

const IMPORT_RE = /^(\s*)import (.+) from '(?:\.\.\/)+src\/([\w./-]+)\/index\.js';\s*$/;

function rewriteImports(body) {
  const lines = body.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(IMPORT_RE);
    if (!m) {
      out.push(lines[i]);
      continue;
    }
    const [, indent, binding, subpath] = m;
    // Drop a contiguous `//`-comment block directly above this import line.
    while (out.length && new RegExp(`^${indent}//`).test(out[out.length - 1])) {
      out.pop();
    }
    out.push(`${indent}import ${binding} from '@kaltura/intelligent-agents/${subpath}';`);
  }
  return out.join('\n');
}

function generatePage(entry, sdkDir, siteDir) {
  const sourcePath = resolve(sdkDir, entry.source);
  const raw = readFileSync(sourcePath, 'utf8');
  let body = stripH1(raw).replace(/^\n+/, '');
  body = rewriteLinks(body, entry.source, sdkDir);
  body = rewriteImages(body, entry.source, sdkDir, siteDir);
  body = rewriteImports(body);
  body = applyNovaTargets(body);
  const quickNav = buildQuickNav(body);
  body = insertQuickNav(body, quickNav);
  const out = `${frontMatter(entry)}\n# ${entry.h1}\n\n${body.trimStart()}\n`;
  const targetPath = resolve(siteDir, 'src', entry.target);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, out, 'utf8');
  return targetPath;
}

function generateNav(siteDir) {
  const groups = new Map();
  const order = ['Tutorial', 'How-to Guides', 'Explanation', 'Reference'];
  for (const entry of manifest) {
    if (!entry.group) continue;
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push({ title: entry.navTitle, url: entry.url });
  }
  const lines = [
    '// GENERATED by scripts/generate-docs.mjs from scripts/docs-manifest.mjs — do not hand-edit.',
    '// Sidebar nav, grouped by Diátaxis quadrant (Tutorial → How-to Guides →',
    '// Explanation → Reference — Diátaxis\'s own recommended reading order).',
    '// Stays flat on purpose: split reference sub-pages are reached via their',
    '// hub page\'s own link table, not flattened into the sidebar.',
    'module.exports = [',
  ];
  for (const group of order) {
    const pages = groups.get(group);
    if (!pages) continue;
    lines.push('  {');
    lines.push(`    group: '${group}',`);
    lines.push('    pages: [');
    for (const p of pages) {
      lines.push(`      { title: ${JSON.stringify(p.title)}, url: ${JSON.stringify(p.url)} },`);
    }
    lines.push('    ],');
    lines.push('  },');
  }
  lines.push('];');
  writeFileSync(resolve(siteDir, 'src', '_data', 'nav.js'), lines.join('\n') + '\n', 'utf8');
}

async function main() {
  const sdkDir = resolveSdkDir();
  const siteDir = resolveSiteDir();
  checkSourceCoverage(sdkDir);
  let count = 0;
  for (const entry of manifest) {
    if (!entry.generated) continue;
    generatePage(entry, sdkDir, siteDir);
    count++;
  }
  generateNav(siteDir);
  console.log(`generate-docs: wrote ${count} page(s) + nav.js from ${sdkDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
