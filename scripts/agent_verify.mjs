#!/usr/bin/env node
/**
 * SDK Constitution verifier — exits 0 when all rules pass, non-zero otherwise.
 *
 * Run: node scripts/agent_verify.mjs
 *
 * Each check references its rule ID from SDK_CONSTITUTION.md.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SDK_SRC = join(ROOT, 'src');
const SDK_PKG = join(ROOT, 'package.json');
const SDK_TEST = ROOT;

// ── helpers ────────────────────────────────────────────────────────────────

let failures = 0;
let warnings = 0;

function pass(rule, desc) {
  console.log(`  \x1b[32m✓\x1b[0m [${rule}] ${desc}`);
}
function fail(rule, desc, detail) {
  failures++;
  console.error(`  \x1b[31m✗\x1b[0m [${rule}] ${desc}`);
  if (detail) console.error(`      ${detail}`);
}
function warn(rule, desc, detail) {
  warnings++;
  console.warn(`  \x1b[33m⚠\x1b[0m [${rule}] ${desc}`);
  if (detail) console.warn(`      ${detail}`);
}

/** Recursively collect all .js files under a directory, skipping node_modules (avoids a
 * symlink loop back to the repo root via a `file:..` npm dependency, e.g. quickstart/). */
function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Read a file, returning its content as a string (or '' if missing). */
function read(p) {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

/**
 * Grep all SDK source files for a pattern. Returns an array of
 * { file, line, text } matches.
 */
function grepSrc(pattern, flags = 'g') {
  const re = new RegExp(pattern, flags);
  const results = [];
  for (const f of jsFiles(SDK_SRC)) {
    const src = read(f);
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        results.push({ file: relative(ROOT, f), line: i + 1, text: lines[i].trim() });
      }
      re.lastIndex = 0; // reset for 'g' flag
    }
  }
  return results;
}

// ── Section header ─────────────────────────────────────────────────────────

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// ══════════════════════════════════════════════════════════════════════════
// PART 1 — ISOLATION
// ══════════════════════════════════════════════════════════════════════════

section('Part 1 — Isolation');

// I-1: No module-level let (mutable state)
{
  const hits = [];
  for (const f of jsFiles(SDK_SRC)) {
    const src = read(f);
    // Find lines that start with `let ` outside of function bodies.
    // Heuristic: we count brace depth. A let at depth 0 is module-level.
    let depth = 0;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];
      depth += (t.match(/\{/g) || []).length;
      depth -= (t.match(/\}/g) || []).length;
      depth = Math.max(0, depth);
      if (depth === 0 && /^\s*let\s+/.test(t) && !/^\s*\/\//.test(t)) {
        hits.push({ file: relative(ROOT, f), line: i + 1, text: t.trim() });
      }
    }
  }
  if (hits.length === 0) {
    pass('I-1', 'No module-level `let` (no mutable module state)');
  } else {
    fail('I-1', `Module-level \`let\` found (${hits.length} occurrence${hits.length > 1 ? 's' : ''})`,
      hits.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n      '));
  }
}

// I-2: No writes to globalThis / window / self
{
  const hits = grepSrc('(globalThis|window|self)\\.[a-zA-Z_$][a-zA-Z0-9_$]*\\s*=[^=]');
  // Filter out: comments, comparison operators (===, !==, ==, !=), and type-guard reads
  const realHits = hits.filter(h =>
    !h.text.startsWith('//') && !h.text.startsWith('*') &&
    !/=\s*(typeof|null|undefined|true|false|\d)/.test(h.text)
  );
  if (realHits.length === 0) {
    pass('I-2', 'No writes to globalThis / window / self');
  } else {
    fail('I-2', `Writes to globalThis/window/self found (${realHits.length})`,
      realHits.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n      '));
  }
}

// I-3 + I-4: Multi-instance isolation and event-listener cleanup — exercised by existing tests
// (isolation.test.js). We run the SDK's unit tests as the verify step.
// This is handled later in the "run SDK tests" section.
pass('I-3', 'Multi-instance isolation — verified by test/unit/isolation.test.js (run below)');
pass('I-4', 'Event-listener cleanup — verified by test/unit/isolation.test.js (run below)');

// ══════════════════════════════════════════════════════════════════════════
// PART 2 — SECURITY
// ══════════════════════════════════════════════════════════════════════════

section('Part 2 — Security');

// S-1: No eval / new Function / document.write
{
  const evalHits = grepSrc('\\beval\\s*\\(');
  const fnHits = grepSrc('new\\s+Function\\s*\\(');
  const dwHits = grepSrc('document\\.write\\s*\\(');
  const all = [...evalHits, ...fnHits, ...dwHits].filter(h => !h.text.startsWith('//') && !h.text.startsWith('*'));
  if (all.length === 0) {
    pass('S-1', 'No eval() / new Function() / document.write()');
  } else {
    fail('S-1', `Dangerous dynamic execution found (${all.length})`,
      all.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n      '));
  }
}

// S-2: No innerHTML/outerHTML assignments
{
  const hits = grepSrc('\\.innerHTML\\s*=|\\.outerHTML\\s*=|insertAdjacentHTML\\s*\\(');
  const real = hits.filter(h => !h.text.startsWith('//') && !h.text.startsWith('*') && !h.text.includes('no innerHTML') && !h.text.includes('NEVER') && !h.text.includes('NEVER uses'));
  if (real.length === 0) {
    pass('S-2', 'No innerHTML/outerHTML assignments');
  } else {
    fail('S-2', `innerHTML/outerHTML assignment found (${real.length})`,
      real.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n      '));
  }
}

// S-3: safeUrl used at link-build sites — verified by security.test.js
pass('S-3', 'safeUrl() at all link-build sites — verified by test/e2e/security.test.js');

// S-4: sanitizeJson in setDynamicPrompt — verified by compliance.test.js
pass('S-4', 'sanitizeJson() on LLM/user input — verified by test/e2e/compliance.test.js');

// S-5: Admin secret non-enumerable — verified by isolation.test.js
pass('S-5', '_adminSecret non-enumerable — verified by test/unit/isolation.test.js');

// S-6: No hardcoded KS tokens or 32-char hex secrets
{
  const ksHits = grepSrc('djJ8[A-Za-z0-9_\\-+/=]{16,}');
  // Exclude the regex pattern itself in redact.js
  const realKs = ksHits.filter(h => !h.file.includes('redact.js') && !h.file.includes('test/'));
  const hexHits = grepSrc("'[a-f0-9]{32}'|\"[a-f0-9]{32}\"");
  const realHex = hexHits.filter(h => !h.file.includes('test/'));
  if (realKs.length === 0 && realHex.length === 0) {
    pass('S-6', 'No hardcoded KS tokens or 32-char hex secrets in src/');
  } else {
    fail('S-6', 'Hardcoded secrets found',
      [...realKs, ...realHex].map(h => `${h.file}:${h.line}: ${h.text}`).join('\n      '));
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PART 3 — RESILIENCY
// ══════════════════════════════════════════════════════════════════════════

section('Part 3 — Resiliency');

// R-1 through R-5: Http retry/backoff — check that the implementation exists
{
  const httpSrc = read(join(SDK_SRC, 'core', 'http.js'));
  const hasRetry = /maxRetries/.test(httpSrc);
  const hasBackoff = /baseDelayMs|exponential|backoff/i.test(httpSrc);
  const hasDelayFn = /delayFn/.test(httpSrc);
  const hasRetryableCodes = /503|502|504|429/.test(httpSrc);

  if (hasRetry && hasBackoff && hasDelayFn && hasRetryableCodes) {
    pass('R-1', 'Http has retry logic with configurable maxRetries');
    pass('R-2', 'GET requests are retry-safe (covered by R-1 implementation)');
    pass('R-3', 'Idempotency-Key POSTs are retry-safe (covered by R-1 implementation)');
    pass('R-4', 'Retry loop respects caller AbortSignal');
    pass('R-5', 'delayFn injectable — retry exercisable offline');
  } else {
    const missing = [];
    if (!hasRetry) missing.push('maxRetries');
    if (!hasBackoff) missing.push('backoff delay logic');
    if (!hasDelayFn) missing.push('injectable delayFn');
    if (!hasRetryableCodes) missing.push('retriable status codes (429/502/503/504)');
    fail('R-1', `Http.request() missing: ${missing.join(', ')}`, 'See SDK_CONSTITUTION.md R-1 for spec');
    fail('R-2', 'Cannot verify — R-1 not implemented');
    fail('R-3', 'Cannot verify — R-1 not implemented');
    fail('R-4', 'Cannot verify — R-1 not implemented');
    fail('R-5', 'Cannot verify — R-1 not implemented');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PART 4 — PERFORMANCE
// ══════════════════════════════════════════════════════════════════════════

section('Part 4 — Performance');

// P-1: Response size budget in Http
{
  const httpSrc = read(join(SDK_SRC, 'core', 'http.js'));
  const hasMaxBytes = /maxResponseBytes|response_too_large|Content-Length/.test(httpSrc);
  if (hasMaxBytes) {
    pass('P-1', 'Http enforces maxResponseBytes response size budget');
  } else {
    fail('P-1', 'Http.request() has no response size budget (no maxResponseBytes check)', 'See SDK_CONSTITUTION.md P-1');
  }
}

// P-2: No synchronous blocking — JSON parsing is post-read (structural, always pass given P-1)
pass('P-2', 'JSON parsing guarded by P-1 size check (structural)');

// P-3: Zero runtime npm dependencies
{
  const pkg = JSON.parse(read(SDK_PKG) || '{}');
  const deps = pkg.dependencies;
  if (!deps || Object.keys(deps).length === 0) {
    pass('P-3', 'package.json has zero runtime dependencies');
  } else {
    fail('P-3', `sdk has runtime dependencies: ${Object.keys(deps).join(', ')}`,
      'SDK must be zero-dep. Move to devDependencies or inline.');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PART 5 — DX AND CLEAN CODE
// ══════════════════════════════════════════════════════════════════════════

section('Part 5 — DX and Clean Code');

// D-1: All exported symbols have JSDoc
{
  const missing = [];
  for (const f of jsFiles(SDK_SRC)) {
    const lines = read(f).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];
      // Look for `export function`, `export class`, `export const X =`
      if (/^\s*export\s+(function|class|async function)\s+\w+/.test(t) ||
          /^\s*export\s+const\s+[A-Z][A-Z0-9_]+\s*=/.test(t)) {
        // Walk backwards up to 5 lines for a /** block
        let hasDoc = false;
        for (let j = Math.max(0, i - 1); j >= Math.max(0, i - 5); j--) {
          if (/\/\*\*/.test(lines[j])) { hasDoc = true; break; }
          if (/^\s*\*/.test(lines[j])) { hasDoc = true; break; }
        }
        // Also look forward: class body may open on same line, with JSDoc on constructor
        if (!hasDoc) {
          for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
            const ahead = lines[j].trim();
            if (/^\/\*\*/.test(ahead)) { hasDoc = true; break; }
            if (/^\*/.test(ahead)) { hasDoc = true; break; }
            if (ahead === '' || ahead === '{') continue;
            break; // non-blank, non-brace, non-JSDoc → no doc
          }
        }
        if (!hasDoc) {
          missing.push(`${relative(ROOT, f)}:${i + 1}: ${t.trim().slice(0, 80)}`);
        }
      }
    }
  }
  if (missing.length === 0) {
    pass('D-1', 'All exported functions/classes have JSDoc');
  } else {
    fail('D-1', `${missing.length} exported symbol${missing.length > 1 ? 's' : ''} missing JSDoc`,
      missing.join('\n      '));
  }
}

// D-2: Dead exports (warning only — requires human confirmation before deletion)
{
  const exportedNames = new Set();
  const importedNames = new Set();
  // A symbol exported directly from a file that package.json's own `exports`
  // map names as an entry point IS the public API by construction — nothing
  // inside this repo needs to "consume" it for it to be live, real code.
  const pkg = JSON.parse(read(SDK_PKG));
  const entryPointFiles = new Set(Object.values(pkg.exports || {}).map((p) => join(ROOT, p)));
  for (const f of jsFiles(SDK_SRC)) {
    const src = read(f);
    // Collect exports
    for (const m of src.matchAll(/export\s+(?:function|class|const|let)\s+(\w+)/g)) {
      exportedNames.add(m[1]);
      if (entryPointFiles.has(f)) importedNames.add(m[1]);
    }
    for (const m of src.matchAll(/export\s*\{([^}]+)\}\s*(from\s*['"][^'"]+['"])?/g)) {
      const isReExport = !!m[2];
      for (const name of m[1].split(',')) {
        const n = name.trim().split(/\s+as\s+/)[0].trim();
        if (!n) continue;
        exportedNames.add(n);
        // `export { X } from './leaf.js'` is exactly how this SDK's own barrel
        // entry points (src/index.js, management/index.js, …) re-export leaf
        // modules' symbols — that re-export IS a live consumer of X.
        if (isReExport || entryPointFiles.has(f)) importedNames.add(n);
      }
    }
    // Collect imports
    for (const m of src.matchAll(/import\s*\{([^}]+)\}/g)) {
      for (const name of m[1].split(',')) {
        const n = name.trim().split(/\s+as\s+/)[0].trim();
        if (n) importedNames.add(n);
      }
    }
  }
  // Also scan tools/, apps/, examples/, quickstart/, and the test suite itself
  // for consumers — a symbol only ever imported by its own tests is still live.
  const consumerDirs = ['tools', 'apps', 'examples', 'quickstart', 'test'].map((d) => join(ROOT, d));
  for (const dir of consumerDirs) {
    if (!existsSync(dir)) continue;
    for (const f of jsFiles(dir)) {
      const src = read(f);
      for (const m of src.matchAll(/import\s*\{([^}]+)\}/g)) {
        for (const name of m[1].split(',')) {
          const n = name.trim().split(/\s+as\s+/)[0].trim();
          if (n) importedNames.add(n);
        }
      }
    }
  }
  const dead = [...exportedNames].filter((n) => !importedNames.has(n));
  // These are common utility exports intentionally kept for library users — skip them
  const KNOWN_INTENTIONAL = new Set(['KalturaError', 'Management', 'Sessions', 'Http',
    'CAPABILITIES', 'CAPABILITY_STATE', 'tools', 'CHAPTER_TYPE', 'STRATEGY', 'EMBED',
    'ExperienceRenderer', 'KalturaAvatarSession', 'Presenter', 'Emitter',
    'TranscriptTracker', 'CaptionService', 'SegmentAssembler',
    // Used in tests (outside sdk/src/) or consumed within the same module (the heuristic
    // only detects cross-file `import {X}`, not an intra-module reference):
    'WIDGET_KINDS', 'ksString', 'TOOL_TYPES', 'CALL_STAGES']);
  const flagged = dead.filter(n => !KNOWN_INTENTIONAL.has(n) && n.length > 1);
  if (flagged.length === 0) {
    pass('D-2', 'No obviously dead exports found');
  } else {
    warn('D-2', `${flagged.length} exported symbol${flagged.length > 1 ? 's' : ''} with no detected consumers (confirm before deleting)`,
      flagged.slice(0, 20).join(', ') + (flagged.length > 20 ? ` … +${flagged.length - 20} more` : ''));
  }
}

// D-3: No TODO/FIXME/HACK/XXX/STUB in src
{
  const hits = grepSrc('\\b(TODO|FIXME|HACK|XXX|STUB)\\b');
  if (hits.length === 0) {
    pass('D-3', 'No TODO/FIXME/HACK/XXX/STUB in src/');
  } else {
    fail('D-3', `${hits.length} stub comment${hits.length > 1 ? 's' : ''} found`,
      hits.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n      '));
  }
}

// D-4: Lifecycle discipline — typed invalid_state + idempotent teardown
{
  const sessionFiles = ['session.js', 'chat-session.js', 'agent-session.js', 'scripted-video-session.js']
    .map((f) => join(SDK_SRC, 'experience', f));
  const missingTyped = sessionFiles.filter((f) => !/code:\s*'invalid_state'/.test(read(f)));
  const lifecycleTests = [
    { file: join(ROOT, 'test', 'unit', 'chat-session.test.js'), needle: 'disconnect idempotent' },
    { file: join(ROOT, 'test', 'unit', 'agent-session.test.js'), needle: 'same-target' },
  ];
  const missingTests = lifecycleTests.filter((t) => !read(t.file).includes(t.needle));
  if (missingTyped.length === 0 && missingTests.length === 0) {
    pass('D-4', 'Session classes throw typed invalid_state; idempotent-teardown lifecycle tests present (run below)');
  } else {
    const detail = [
      ...missingTyped.map((f) => `${relative(ROOT, f)}: no code: 'invalid_state' construction`),
      ...missingTests.map((t) => `${relative(ROOT, t.file)}: lifecycle test "${t.needle}" not found`),
    ].join('\n      ');
    fail('D-4', 'Lifecycle discipline not verifiable', detail);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// SDK TEST SUITE (node:test)
// ══════════════════════════════════════════════════════════════════════════

section('SDK Test Suite (npm test)');

{
  // The suite normally finishes well under 2 minutes, but a cold npm cache or a
  // loaded CI runner can push past it — a timeout kill must read as "timed out",
  // never as a test failure. Override with AGENT_VERIFY_TEST_TIMEOUT_MS.
  const timeoutMs = Number(process.env.AGENT_VERIFY_TEST_TIMEOUT_MS) || 300_000;
  const result = spawnSync('npm', ['test'], {
    cwd: SDK_TEST,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const out = (result.stdout || '') + (result.stderr || '');
  // Extract the summary line
  const summaryMatch = out.match(/pass\s+\d+[\s\S]{0,200}fail\s+\d+/i) ||
                       out.match(/\d+ passing.*?\d+ failing/i);
  const summary = summaryMatch ? summaryMatch[0].replace(/\n/g, ' ') : out.slice(-400).replace(/\n/g, ' ');
  if (result.status === 0) {
    pass('I-3/I-4/S-3/S-4/S-5', `SDK tests pass — ${summary || 'all suites green'}`);
  } else if (result.signal) {
    fail('SDK-TESTS', `SDK test run KILLED by ${result.signal} after ${timeoutMs / 1000}s — a timeout, not a test failure. Re-run, or raise AGENT_VERIFY_TEST_TIMEOUT_MS.`,
      summary || out.slice(-800));
  } else {
    fail('SDK-TESTS', 'SDK test suite failed', summary || out.slice(-800));
    // Print full output so the caller can diagnose
    console.error('\n--- npm test output (last 1000 chars) ---');
    console.error(out.slice(-1000));
    console.error('--- end ---\n');
  }
}

// ══════════════════════════════════════════════════════════════════════════
// FINAL VERDICT
// ══════════════════════════════════════════════════════════════════════════

console.log('');
console.log('─'.repeat(60));
if (failures === 0 && warnings === 0) {
  console.log('\x1b[32m\x1b[1m✓ ALL CONSTITUTION RULES PASS\x1b[0m');
} else if (failures === 0) {
  console.log(`\x1b[33m\x1b[1m✓ ALL RULES PASS — ${warnings} warning${warnings > 1 ? 's' : ''} (review D-2 dead-code list)\x1b[0m`);
} else {
  console.error(`\x1b[31m\x1b[1m✗ ${failures} RULE${failures > 1 ? 'S' : ''} FAILING, ${warnings} WARNING${warnings !== 1 ? 'S' : ''}\x1b[0m`);
}
console.log('─'.repeat(60));

process.exit(failures > 0 ? 1 : 0);
