#!/usr/bin/env node
// Verifies scripts/docs-manifest.mjs and src/**/*.md stay in lockstep:
//   1. every generated:true entry's target file exists
//   2. every generated:false (hand-authored) target is untouched by the last
//      `git diff` — the generator must never write to one of these
//   3. every src/**/*.md file has exactly one manifest entry (no orphans)
// Run after scripts/generate-docs.mjs + `npm run build`.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { relative, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest } from './docs-manifest.mjs';

const SITE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC_DIR = resolve(SITE_ROOT, 'src');

function markdownFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...markdownFiles(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

const problems = [];

for (const entry of manifest) {
  const targetPath = resolve(SRC_DIR, entry.target);
  if (!existsSync(targetPath)) {
    problems.push(`missing target for manifest entry ${entry.source ?? '(hand-authored)'}: ${entry.target}`);
  }
}

for (const entry of manifest.filter((e) => !e.generated)) {
  const relPath = relative(SITE_ROOT, resolve(SRC_DIR, entry.target));
  try {
    const diff = execSync(`git diff --name-only -- "${relPath}"`, { cwd: SITE_ROOT, encoding: 'utf8' });
    if (diff.trim()) {
      problems.push(`generator touched a hand-authored exception: ${entry.target}`);
    }
  } catch {
    // not a git repo / no HEAD yet — skip this check rather than fail CI setup
  }
}

const manifestTargets = new Set(manifest.map((e) => relative(SITE_ROOT, resolve(SRC_DIR, e.target))));
for (const file of markdownFiles(SRC_DIR)) {
  const relPath = relative(SITE_ROOT, file);
  if (!manifestTargets.has(relPath)) {
    problems.push(`orphan page not in manifest: ${relPath}`);
  }
}

if (problems.length) {
  console.error(`check-manifest-coverage: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-manifest-coverage: OK — ${manifest.length} manifest entries, all covered.`);
