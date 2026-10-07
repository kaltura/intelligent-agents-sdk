#!/usr/bin/env node
// Fails the build if the markdown twins (scripts/lib/markdown-twins.js) drift
// from the site: every HTML page except Home needs a twin, no twin keeps front
// matter or a root-relative link, and every site link in a twin or in
// llms.txt points at a file that exists in _site.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SITE_DIR = join(new URL('..', import.meta.url).pathname, '_site');
const siteUrl = require('../src/_data/site.js').url;
const problems = [];

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const files = walk(SITE_DIR);
const rel = (f) => relative(SITE_DIR, f).split(sep).join('/');

const pages = files.filter((f) => rel(f).endsWith('/index.html') && rel(f) !== 'index.html');
const twins = files.filter((f) => rel(f).endsWith('/index.md'));
for (const html of pages) {
  const twin = html.replace(/index\.html$/, 'index.md');
  if (!existsSync(twin)) problems.push(`no markdown twin for /${rel(html)}`);
}

const resolves = (url) => {
  if (!url.startsWith(siteUrl)) return true;
  const path = url.slice(siteUrl.length).split('#')[0];
  const target = join(SITE_DIR, path);
  return existsSync(target) && (!path.endsWith('/') || statSync(target).isDirectory());
};
const siteLinks = (text) => [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);

for (const f of twins) {
  const text = readFileSync(f, 'utf8');
  if (text.startsWith('---')) problems.push(`${rel(f)}: front matter was not stripped`);
  const lines = text.split('\n');
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (/\]\(\/(?!\/)/.test(line) || /\b(?:href|src)="\/(?!\/)/.test(line)) problems.push(`${rel(f)}: root-relative link: ${line.trim().slice(0, 80)}`);
  }
  for (const url of siteLinks(text)) if (!resolves(url)) problems.push(`${rel(f)}: broken link ${url}`);
}

const llms = readFileSync(join(SITE_DIR, 'llms.txt'), 'utf8');
const llmsLinks = siteLinks(llms);
for (const url of llmsLinks) {
  if (!resolves(url)) problems.push(`llms.txt: broken link ${url}`);
  else if (url.startsWith(siteUrl) && !url.split('#')[0].endsWith('.md')) problems.push(`llms.txt: not a markdown twin ${url}`);
}

if (problems.length) {
  console.error(`check-markdown-twins: ${problems.length} problem(s):\n\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-markdown-twins: OK — ${twins.length} twins, ${llmsLinks.length} llms.txt links`);
