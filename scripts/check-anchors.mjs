#!/usr/bin/env node
// Build-time anchor check: every in-site `#fragment` link in the built HTML
// must resolve to a real `id` on its target page. Guards against the slug
// drift class of bug (issue #87): links copied from GitHub-flavored docs use
// GitHub's slug form, and a slugger mismatch silently no-ops every such link.
//
// Run after `npm run build`. Exit 0 = all fragments resolve, 1 = any broken.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const SITE_DIR = new URL('../_site', import.meta.url).pathname;

if (!existsSync(SITE_DIR)) {
  console.error('check-anchors: _site/ not found — run `npm run build` first');
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

// file path → site URL path ("/reference/api-reference/")
function urlOf(file) {
  const rel = relative(SITE_DIR, file);
  if (rel === 'index.html') return '/';
  return '/' + rel.replace(/index\.html$/, '').replace(/\.html$/, '/');
}

const pages = new Map(); // url → { file, ids:Set, links:[{href, raw}] }
for (const file of htmlFiles(SITE_DIR)) {
  const html = readFileSync(file, 'utf8');
  const ids = new Set();
  for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  const links = [];
  for (const m of html.matchAll(/<a\s[^>]*href="([^"]*#[^"]+)"/g)) {
    links.push(m[1]);
  }
  pages.set(urlOf(file), { file, ids, links });
}

const broken = [];
for (const [url, page] of pages) {
  for (const href of page.links) {
    if (/^(https?:)?\/\//.test(href) || href.startsWith('mailto:')) continue;
    const [path, fragment] = href.split('#');
    if (!fragment) continue;
    let target;
    if (!path) {
      target = page; // same-page "#frag"
    } else {
      // Root-absolute site URLs only (matches how the site authors links);
      // normalize a missing trailing slash to the directory-index form.
      const normalized = path.endsWith('/') ? path : path + '/';
      target = pages.get(normalized) ?? pages.get(path);
      if (!target) {
        broken.push({ page: url, href, reason: 'target page not in build' });
        continue;
      }
    }
    if (!target.ids.has(fragment)) {
      broken.push({ page: url, href, reason: 'no such id on target page' });
    }
  }
}

if (broken.length) {
  console.error(`check-anchors: ${broken.length} broken fragment link(s):\n`);
  for (const b of broken) {
    console.error(`  ${b.page}\n    → ${b.href}  (${b.reason})`);
  }
  process.exit(1);
}
console.log(`check-anchors: all in-site fragment links resolve (${pages.size} pages)`);
