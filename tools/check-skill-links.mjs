#!/usr/bin/env node
/**
 * Live link check for the app-builder skill. Every docs-site page the skill
 * names must return 200, and every #fragment must exist as an id on the page.
 * Run by .github/workflows/skill-links.yml. Needs network, no secrets.
 *
 * Usage: node tools/check-skill-links.mjs
 */
/* global fetch */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://kaltura.github.io/intelligent-agents-sdk';
const FILES = [
  'app-builder-skill/skills/build-kaltura-agent-app/SKILL.md',
  'app-builder-skill/skills/build-kaltura-agent-app/references/paths.md',
];

const urls = new Set([`${BASE}/llms.txt`]);
for (const f of FILES) {
  const text = readFileSync(join(ROOT, f), 'utf8');
  for (const m of text.matchAll(/https:\/\/kaltura\.github\.io\/intelligent-agents-sdk[^\s)>`'"]*/g)) urls.add(m[0]);
  // paths.md names pages as `/section/page/` relative to the site base.
  for (const m of text.matchAll(/`(\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/(?:#[\w-]+)?)`/g)) urls.add(BASE + m[1]);
}

const pages = new Map();
async function load(url) {
  if (!pages.has(url)) {
    pages.set(url, fetch(url, { redirect: 'follow' }).then(async (r) => ({ status: r.status, body: await r.text() }))); // nosemgrep: scripts.harness.no-raw-fetch-bypass
  }
  return pages.get(url);
}

const problems = [];
for (const full of [...urls].sort()) {
  const [url, fragment] = full.split('#');
  let res;
  try {
    res = await load(url);
  } catch (err) {
    problems.push(`${full}: ${err.message}`);
    continue;
  }
  if (res.status !== 200) problems.push(`${full}: HTTP ${res.status}`);
  else if (fragment && !res.body.includes(`id="${fragment}"`)) problems.push(`${full}: no element with id "${fragment}"`);
}

console.log(`checked ${urls.size} URLs`);
if (problems.length) {
  console.error(`✗ ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('✓ all skill links resolve');
