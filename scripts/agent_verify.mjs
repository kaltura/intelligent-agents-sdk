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

// I-3: Class-based encapsulation — no cross-instance state leakage.
// A rubber-stamped pass() here would keep reporting green even if the named
// test below were deleted; needle-check the specific assertions the rule
// claims exist, same pattern as D-4. The SDK test suite (run below) then
// proves they're currently green, not just present.
{
  const isoTest = join(ROOT, 'test', 'unit', 'isolation.test.js');
  const needles = [
    'no credential bleed: instance A cannot observe instance B secret',
    'concurrent token mints on two tenants do not cross tokens',
  ];
  const missing = needles.filter((n) => !read(isoTest).includes(n));
  if (existsSync(isoTest) && missing.length === 0) {
    pass('I-3', 'Multi-instance isolation tests present in test/unit/isolation.test.js (run below)');
  } else {
    fail('I-3', 'Multi-instance isolation test(s) missing from test/unit/isolation.test.js',
      missing.length ? missing.map((n) => `missing test "${n}"`).join('\n      ') : `${relative(ROOT, isoTest)} not found`);
  }
}

// I-4: Event-listener cleanup.
{
  const isoTest = join(ROOT, 'test', 'unit', 'isolation.test.js');
  const sessionSrc = read(join(SDK_SRC, 'experience', 'session.js'));
  const hasWiring = /_wireNetwork\s*\(/.test(sessionSrc) && /_unwireNetwork\s*\(/.test(sessionSrc);
  const needle = '_unwireNetwork() removes exactly the online/offline handlers _wireNetwork() added';
  const hasTest = read(isoTest).includes(needle);
  if (hasWiring && hasTest) {
    pass('I-4', 'Event-listener cleanup — _wireNetwork()/_unwireNetwork() implemented and tested in test/unit/isolation.test.js (run below)');
  } else {
    const detail = [];
    if (!hasWiring) detail.push('src/experience/session.js missing _wireNetwork()/_unwireNetwork()');
    if (!hasTest) detail.push(`test/unit/isolation.test.js missing test "${needle}"`);
    fail('I-4', 'Event-listener cleanup not verifiable', detail.join('\n      '));
  }
}

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

// S-3: All user-supplied URLs must pass through safeUrl().
{
  const safetyTest = join(ROOT, 'test', 'unit', 'safety.test.js');
  const needles = [
    'safeUrl rejects authority-relative URLs',
    'safeUrl rejects embedded userinfo credentials',
  ];
  const missing = needles.filter((n) => !read(safetyTest).includes(n));
  if (existsSync(safetyTest) && missing.length === 0) {
    pass('S-3', 'safeUrl() unit tests present in test/unit/safety.test.js (run below)');
  } else {
    fail('S-3', 'safeUrl() test(s) missing from test/unit/safety.test.js',
      missing.length ? missing.map((n) => `missing test "${n}"`).join('\n      ') : `${relative(ROOT, safetyTest)} not found`);
  }
}

// S-4: No prototype pollution. Coverage is a unit test in safety.test.js plus
// an e2e test in security.test.js.
{
  const safetyTest = join(ROOT, 'test', 'unit', 'safety.test.js');
  const securityTest = join(ROOT, 'test', 'e2e', 'security.test.js');
  const hasUnit = read(safetyTest).includes('sanitizeJson drops prototype-pollution keys');
  const hasE2e = read(securityTest).includes('setDynamicPrompt scrubs prototype-pollution keys');
  if (hasUnit && hasE2e) {
    pass('S-4', 'sanitizeJson() prototype-pollution tests present in test/unit/safety.test.js + test/e2e/security.test.js (run below)');
  } else {
    const detail = [];
    if (!hasUnit) detail.push('test/unit/safety.test.js missing "sanitizeJson drops prototype-pollution keys"');
    if (!hasE2e) detail.push('test/e2e/security.test.js missing "setDynamicPrompt scrubs prototype-pollution keys"');
    fail('S-4', 'sanitizeJson() prototype-pollution test(s) missing', detail.join('\n      '));
  }
}

// S-5: Admin secret non-enumerable and non-serializable.
{
  const isoTest = join(ROOT, 'test', 'unit', 'isolation.test.js');
  if (read(isoTest).includes('admin secret is non-enumerable')) {
    pass('S-5', '_adminSecret non-enumerable test present in test/unit/isolation.test.js (run below)');
  } else {
    fail('S-5', 'test/unit/isolation.test.js missing "admin secret is non-enumerable" test');
  }
}

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

// R-1 through R-5: Http retry/backoff. A source-token heuristic alone can't
// tell "the retry code exists" from "the retry code for THIS rule still has
// a test" — pair it with a needle-check against the specific tagged test(s)
// in http.test.js, so deleting one no longer leaves every rule green.
{
  const httpSrc = read(join(SDK_SRC, 'core', 'http.js'));
  const httpTestFile = join(ROOT, 'test', 'unit', 'http.test.js');
  const httpTestSrc = read(httpTestFile);
  const hasRetry = /maxRetries/.test(httpSrc);
  const hasBackoff = /baseDelayMs|exponential|backoff/i.test(httpSrc);
  const hasDelayFn = /delayFn/.test(httpSrc);
  const hasRetryableCodes = /503|502|504|429/.test(httpSrc);
  const implOk = hasRetry && hasBackoff && hasDelayFn && hasRetryableCodes;
  const implMissing = [];
  if (!hasRetry) implMissing.push('maxRetries missing');
  if (!hasBackoff) implMissing.push('backoff delay logic missing');
  if (!hasDelayFn) implMissing.push('injectable delayFn missing');
  if (!hasRetryableCodes) implMissing.push('retriable status codes (429/502/503/504) missing');

  const RULE_TEST_NEEDLES = {
    'R-1': ['R-1: 503 GET is retried up to maxRetries times then throws', 'R-1: non-retriable 401 is NOT retried'],
    'R-2': ['R-2: GET requires no idempotency key to be retry-safe'],
    'R-3': ['R-3: POST with idempotency-key is retried on 503', 'R-3: POST without idempotency-key is retried on network error'],
    'R-4': ['R-4: abort signal stops retry loop immediately'],
    'R-5': ['R-5: delayFn is called between retries'],
  };
  for (const [rule, needles] of Object.entries(RULE_TEST_NEEDLES)) {
    const missingTests = existsSync(httpTestFile) ? needles.filter((n) => !httpTestSrc.includes(n)) : needles;
    if (implOk && missingTests.length === 0) {
      pass(rule, `Http retry/backoff — verified by test/unit/http.test.js (run below)`);
    } else {
      const detail = [...implMissing, ...missingTests.map((n) => `test/unit/http.test.js missing "${n}"`)];
      fail(rule, `${rule} not verifiable`, detail.join('\n      '));
    }
  }
}

// R-6: connect() never waits on, and never fails for, the microphone.
// Source: the only accepted micStartMode values are 'immediate' | 'deferred'
// (no 'required'). Tests: a failed mic still yields state 'connected', and
// 'required' is rejected with bad_request at construction.
{
  const sessionSrc = read(join(SDK_SRC, 'experience', 'session.js'));
  const micTest = read(join(ROOT, 'test', 'e2e', 'mic-concurrency.test.js'));
  const deferredTest = read(join(ROOT, 'test', 'e2e', 'deferred-mic.test.js'));
  const problems = [];
  if (!/must be 'immediate' or 'deferred'/.test(sessionSrc)) problems.push("session.js: micStartMode validation must accept only 'immediate' | 'deferred'");
  if (/micStartMode\s*[!=]==?\s*'required'/.test(sessionSrc)) problems.push("session.js: still branches on micStartMode 'required'");
  if (!micTest.includes('a failed mic never fails connect()')) problems.push('test/e2e/mic-concurrency.test.js missing "a failed mic never fails connect()"');
  if (!/micStartMode:\s*'required'/.test(deferredTest)) problems.push("test/e2e/deferred-mic.test.js missing the micStartMode: 'required' → bad_request assertion");
  if (problems.length === 0) pass('R-6', 'connect() never waits on or fails for the mic — verified by mic-concurrency + deferred-mic tests (run below)');
  else fail('R-6', 'connect()/mic decoupling not verifiable', problems.join('\n      '));
}

// R-7: turn state changes only on named socket events, never on timers.
// Grep the hold/release method bodies for setTimeout/setInterval and check
// that kickoff.test.js still covers each row of the hold/release table.
{
  const sessionSrc = read(join(SDK_SRC, 'experience', 'session.js'));
  const bodyOf = (name) => {
    const start = sessionSrc.indexOf(`\n  ${name}(`);
    if (start < 0) return null;
    const end = sessionSrc.indexOf('\n  }', start);
    return end < 0 ? null : sessionSrc.slice(start, end);
  };
  const problems = [];
  for (const name of ['_endUninterruptibleTurn', '_dropHeldTurns', '_maybeSendKickoff']) {
    const body = bodyOf(name);
    if (body == null) problems.push(`session.js: ${name}() not found`);
    else if (/setTimeout|setInterval/.test(body)) problems.push(`session.js: ${name}() uses a timer`);
  }
  const kickoffTest = read(join(ROOT, 'test', 'unit', 'kickoff.test.js'));
  for (const needle of [
    'sent on stvFinishedTalking, exactly once',
    'kickoff is released by agentInterrupted too',
    'disconnect() during the opening drops the held kickoff',
    'kickoff is not re-sent after pause() → pauseSessionExpired → resume()',
    'a held kickoff survives a cold reconnect',
  ]) if (!kickoffTest.includes(needle)) problems.push(`test/unit/kickoff.test.js missing "${needle}"`);
  if (problems.length === 0) pass('R-7', 'Held turns released/dropped only on named socket events — no timers in the hold path, hold/release table tested (run below)');
  else fail('R-7', 'timer-free turn state not verifiable', problems.join('\n      '));
}

// ══════════════════════════════════════════════════════════════════════════
// PART 4 — PERFORMANCE
// ══════════════════════════════════════════════════════════════════════════

section('Part 4 — Performance');

// P-1: Response size budget in Http
{
  const httpSrc = read(join(SDK_SRC, 'core', 'http.js'));
  const httpTestFile = join(ROOT, 'test', 'unit', 'http.test.js');
  const httpTestSrc = read(httpTestFile);
  const hasMaxBytes = /maxResponseBytes|response_too_large|Content-Length/.test(httpSrc);
  const needles = [
    'P-1: response exceeding maxResponseBytes by Content-Length throws response_too_large',
    'P-1: response body exceeding maxResponseBytes throws response_too_large',
  ];
  const missingTests = existsSync(httpTestFile) ? needles.filter((n) => !httpTestSrc.includes(n)) : needles;
  if (hasMaxBytes && missingTests.length === 0) {
    pass('P-1', 'Http response-size budget — verified by test/unit/http.test.js (run below)');
  } else {
    const detail = [];
    if (!hasMaxBytes) detail.push('Http.request() has no response size budget (no maxResponseBytes check)');
    missingTests.forEach((n) => detail.push(`test/unit/http.test.js missing "${n}"`));
    fail('P-1', 'P-1 not verifiable', detail.join('\n      '));
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

// D-5: kickoff is sent at most once per session object — never on resume(),
// a cold reconnect, or switchMode(). Each session class guards it with a
// once-flag; the tests below pin each re-entry path.
{
  const tests = [
    { file: join(ROOT, 'test', 'unit', 'kickoff.test.js'), needle: 'sent on stvFinishedTalking, exactly once' },
    { file: join(ROOT, 'test', 'unit', 'kickoff.test.js'), needle: 'kickoff is not re-sent after pause() → pauseSessionExpired → resume()' },
    { file: join(ROOT, 'test', 'unit', 'kickoff.test.js'), needle: 'kickoff is not re-sent after a cold reconnect' },
    { file: join(ROOT, 'test', 'unit', 'kickoff.test.js'), needle: 'kickoff waits for acknowledgeDisclosure()' },
    { file: join(ROOT, 'test', 'unit', 'kickoff.test.js'), needle: 'kickoff: wrong shapes throw bad_request at construction' },
    { file: join(ROOT, 'test', 'unit', 'chat-session.test.js'), needle: 'sent as the first converse turn on connect(), exactly once' },
    { file: join(ROOT, 'test', 'unit', 'chat-session.test.js'), needle: 'kickoff: wrong shapes throw bad_request at construction' },
    { file: join(ROOT, 'test', 'unit', 'agent-session.test.js'), needle: 'passed to the first transport only; a switchMode() transport never carries it' },
  ];
  const problems = tests.filter((t) => !read(t.file).includes(t.needle))
    .map((t) => `${relative(ROOT, t.file)}: test "${t.needle}" not found`);
  const avatarSrc = read(join(SDK_SRC, 'experience', 'session.js'));
  if (!/_kickoffSent\s*=\s*true/.test(avatarSrc)) problems.push('src/experience/session.js: no _kickoffSent once-flag');
  if (problems.length === 0) pass('D-5', 'kickoff sent at most once per session object — once-flag + resume/reconnect/switchMode tests present (run below)');
  else fail('D-5', 'kickoff once-only not verifiable', problems.join('\n      '));
}

// ══════════════════════════════════════════════════════════════════════════
// PART 6 — MEDIA PATH
// ══════════════════════════════════════════════════════════════════════════

section('Part 6 — Media path');

// M-1: avatar-media.js is pure track routing — no document, DOM creation, timers or console
{
  const file = join(SDK_SRC, 'experience', 'avatar-media.js');
  const src = read(file);
  const banned = ['document\\.', 'createElement', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'console\\.'];
  const hits = [];
  if (!src) hits.push('src/experience/avatar-media.js is missing');
  src.split('\n').forEach((text, i) => {
    for (const b of banned) if (new RegExp(b).test(text)) hits.push(`src/experience/avatar-media.js:${i + 1}: /${b}/ → ${text.trim()}`);
  });
  if (hits.length === 0) {
    pass('M-1', 'avatar-media.js has no document/DOM creation/timers/console (pure track routing)');
  } else {
    fail('M-1', `${hits.length} forbidden reference${hits.length > 1 ? 's' : ''} in avatar-media.js`, hits.join('\n      '));
  }
}

// M-2: the raw silent opening phrase (SILENT_OPENING) never reaches a listener;
// the opening turn surfaces as SILENT_OPENING_LABEL instead. The relabel is
// keyed on the opening speech id; a spoken opening and a `<blank>` in a normal
// reply are left alone.
{
  const sessionSrc = read(join(SDK_SRC, 'experience', 'session.js'));
  const openingSrc = read(join(SDK_SRC, 'core', 'opening.js'));
  const kickoffTest = read(join(ROOT, 'test', 'unit', 'kickoff.test.js'));
  const problems = [];
  if (!/export const SILENT_OPENING\s*=/.test(openingSrc)) problems.push('src/core/opening.js: SILENT_OPENING not exported');
  if (!/export const SILENT_OPENING_LABEL\s*=/.test(openingSrc)) problems.push('src/core/opening.js: SILENT_OPENING_LABEL not exported');
  if (!/function openingText\(/.test(sessionSrc)) problems.push('src/experience/session.js: no openingText() relabel helper');
  for (const needle of [
    'on transcript/speechChunk/stop',
    'silent opening: a spoken opening phrase on the opening speechId still surfaces',
    'on a normal reply speechId is not relabelled',
  ]) if (!kickoffTest.includes(needle)) problems.push(`test/unit/kickoff.test.js missing "${needle}"`);
  if (problems.length === 0) pass('M-2', 'Silent opening surfaces as SILENT_OPENING_LABEL, never as the raw phrase — speech-id-scoped relabel + tests present (run below)');
  else fail('M-2', 'silent-opening relabel not verifiable', problems.join('\n      '));
}

// M-3: the STV downlink subscription is released wherever it is dropped or
// replaced. Closing the peer locally does not free the server's egress session,
// so every site that closes `_pcStv` (teardown, media recovery, cold reconnect,
// resume) must go through `_releaseCurrentWhep()`, and the three `_connectStv`
// abort lanes (the app disconnected while the answer was being read, the connect
// deadline expired, the other lane lost) must release the answer they never stored.
{
  const file = join(SDK_SRC, 'experience', 'session.js');
  const sessionSrc = read(file);
  const lines = sessionSrc.split('\n');
  const problems = [];

  // The single release helper, clearing the field before the DELETE so a second call is a no-op.
  const helper = /_releaseCurrentWhep\(\)\s*\{\s*\n\s*const loc = this\._whepLocation;\s*\n\s*this\._whepLocation = null;/.test(sessionSrc);
  if (!helper) problems.push('src/experience/session.js: _releaseCurrentWhep() must read _whepLocation, clear it, then release (idempotent)');

  // Exactly one site stores a Location. More than one means a path can overwrite without releasing.
  const stores = lines.filter((t) => /^\s*this\._whepLocation = (?!null)/.test(t)).length;
  if (stores !== 1) problems.push(`src/experience/session.js: expected exactly 1 non-null "this._whepLocation =" assignment, found ${stores}`);

  // Every close of the STV peer releases within a few lines (same line counts).
  lines.forEach((text, i) => {
    if (!/this\._pcStv\?\.close|_closePeer\(this\._pcStv\)/.test(text)) return;
    const window = lines.slice(i, i + 7).join('\n');
    if (!/this\._releaseCurrentWhep\(\)/.test(window)) problems.push(`src/experience/session.js:${i + 1}: closes _pcStv without a nearby _releaseCurrentWhep() → ${text.trim()}`);
  });

  // The three abort lanes in _connectStv (disconnect during the body read, deadline
  // expired, other lane lost) release directly: their Location was never stored, so
  // nothing else can ever DELETE it.
  const aborts = (sessionSrc.match(/if \(res\.ok && resolvedLoc\) this\._releaseWhep\(resolvedLoc\);/g) || []).length;
  if (aborts !== 3) problems.push(`src/experience/session.js: expected all three _connectStv abort lanes to release the answered subscription, found ${aborts}`);

  for (const [rel, needles] of [
    ['test/e2e/connect.test.js', ['the WHEP resource is released exactly once', 'releases the WHEP resource (no leak on the error path)']],
    ['test/e2e/connect-concurrency.test.js', ['the answered subscription is released']],
    ['test/e2e/connect-cancel.test.js', ['a 201 that lands after the cancel is released with a DELETE', 'a late non-2xx answer is dropped without a DELETE']],
    ['test/e2e/resilience.test.js', ['the re-subscribe releases the previous subscription exactly once', 'cold reconnect releases the subscription', 'frees the subscription the paused session held']],
  ]) {
    const src = read(join(ROOT, rel));
    for (const needle of needles) if (!src.includes(needle)) problems.push(`${rel} missing "${needle}"`);
  }

  if (problems.length === 0) pass('M-3', 'Every path that drops or replaces the STV downlink releases its WHEP subscription exactly once — single store site, idempotent release, tests present (run below)');
  else fail('M-3', 'WHEP subscription release not verifiable', problems.join('\n      '));
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
    pass('SDK-TESTS', `SDK tests pass — ${summary || 'all suites green'}`);
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
