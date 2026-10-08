#!/usr/bin/env node
// Fails the build if a page the site deliberately does not publish shows up
// anywhere a reader or the assistant could find it. The excluded pages are the
// docs/ files in DOCS_SUBTREE_IGNORE (generate-docs.mjs). Their source docs stay
// in the SDK repo. Run after `npm run build`. For each excluded doc, with its
// slug taken from the file name (ARCHITECTURE-RECIPE.md -> architecture-recipe):
//   1. no manifest entry names it as a source or uses the slug in its target
//   2. no file named <slug>.md exists under src/
//   3. the sidebar nav (src/_data/nav.js) does not mention the slug
//   4. the built llms.txt does not mention the slug
//   5. the built site has no folder named <slug>
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest } from './docs-manifest.mjs';
import { DOCS_SUBTREE_IGNORE } from './generate-docs.mjs';

const SITE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function walk(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, found);
    found.push(p);
  }
  return found;
}

const srcFiles = walk(resolve(SITE_ROOT, 'src'));
const siteDirs = walk(resolve(SITE_ROOT, '_site')).filter((p) => statSync(p).isDirectory());
const nav = existsSync(resolve(SITE_ROOT, 'src/_data/nav.js')) ? readFileSync(resolve(SITE_ROOT, 'src/_data/nav.js'), 'utf8') : '';
const llmsPath = resolve(SITE_ROOT, '_site/llms.txt');
const failures = [];
if (!existsSync(llmsPath)) failures.push('_site/llms.txt is missing; run `npm run build` first');
const llms = existsSync(llmsPath) ? readFileSync(llmsPath, 'utf8') : '';

for (const source of DOCS_SUBTREE_IGNORE) {
  const slug = source.split('/').pop().replace(/\.md$/, '').toLowerCase();
  if (manifest.some((e) => e.source === source || (e.target || '').includes(slug))) failures.push(`${source}: a manifest entry exists`);
  if (srcFiles.some((p) => p.endsWith(`/${slug}.md`))) failures.push(`${source}: a src/**/${slug}.md page exists`);
  if (nav.includes(slug)) failures.push(`${source}: "${slug}" is in src/_data/nav.js`);
  if (llms.includes(slug)) failures.push(`${source}: "${slug}" is in _site/llms.txt`);
  if (siteDirs.some((p) => p.endsWith(`/${slug}`))) failures.push(`${source}: the build produced a "${slug}" folder`);
}

if (failures.length) {
  console.error(`check-excluded-pages: ${failures.length} problem(s)\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-excluded-pages: ok (${DOCS_SUBTREE_IGNORE.size} excluded pages absent from manifest, src, nav, llms.txt and the build)`);
