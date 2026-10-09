import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every network call in `src/` has a deadline or a caller-owned signal. A new bare `fetch(`
 * fails here until it gets one, or lands on the list below with a reason.
 */

const SRC = new URL('../../src/', import.meta.url).pathname;
const ROOT = new URL('../../', import.meta.url).pathname;

/** Calls allowed to have no deadline, with how many each file may hold. Streams pass a caller `signal`, so they need no entry. */
const ALLOWED = {
  'src/experience/analytics.js': { count: 1, why: 'fire-and-forget keepalive beacon, nothing waits on it' },
};

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('every fetch call in src/ has a deadline or an allowlisted reason', () => {
  const offenders = [];
  const bare = {};
  for (const file of walk(SRC)) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\b_?fetch\(/.test(line) && !/http\._fetch\(/.test(line)) return;
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      if (/\b(whepPost|fetchWithTimeout)\(/.test(line)) return;
      // The request options sit within the next few lines.
      const window = lines.slice(i, i + 8).join('\n');
      if (/signal\b/.test(window)) return;
      if (ALLOWED[rel]) { bare[rel] = (bare[rel] ?? 0) + 1; return; }
      offenders.push(`${rel}:${i + 1}: ${t}`);
    });
  }
  assert.deepEqual(offenders, [], 'add a deadline (fetchWithTimeout / whepPost) or an ALLOWED entry with a reason');
  for (const [rel, { count }] of Object.entries(ALLOWED)) assert.equal(bare[rel] ?? 0, count, `${rel}: bare fetch count changed`);
});

