#!/usr/bin/env node
// Fails the build if a banned term appears in any page under src/.
// "DPP" is gone: per-slide context is described as request variables.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BANNED = [{ term: 'DPP', re: /\bDPPs?\b/, say: 'request variables' }];

function markdownFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...markdownFiles(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

const hits = [];
for (const file of markdownFiles(resolve(SITE_ROOT, 'src'))) {
  const text = readFileSync(file, 'utf8');
  for (const { term, re, say } of BANNED) {
    if (re.test(text)) hits.push(`${relative(SITE_ROOT, file)}: "${term}" (say "${say}")`);
  }
}
if (hits.length) {
  console.error(`check-banned-terms: ${hits.length} problem(s)\n  ${hits.join('\n  ')}`);
  process.exit(1);
}
console.log('check-banned-terms: ok');
