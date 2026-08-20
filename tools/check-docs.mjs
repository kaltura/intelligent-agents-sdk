#!/usr/bin/env node
/**
 * Docs CI gate for @kaltura/intelligent-agents.
 * Fails (exit 1) when docs drift from code, leak secrets, or break GFM.
 *
 * Usage: node tools/check-docs.mjs
 *
 * Zero deps beyond node: builtins (fs, path, child_process, test).
 *
 * This copy keeps only the SDK-scoped checks (secrets/IP leakage, GFM
 * hygiene, cross-doc links, SDK invariants) — no CLI-tool-specific checks
 * (payload/tool-annotation/JSON-injection tests), since this repo ships an
 * SDK, not a CLI toolkit.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = normalize(join(__dirname, '..'));

const SELF = 'tools/check-docs.mjs';

const DOCS = [
  'README.md', 'API-REFERENCE.md', 'GETTING-STARTED.md',
  'docs/ARCHITECTURE.md', 'docs/ARCHITECTURE-REFERENCE.md', 'docs/ARCHITECTURE-RECIPE.md',
  'docs/WIRE-PROTOCOL.md', 'docs/GENUI-REFERENCE.md',
  'docs/CLIENT-COMMANDS.md', 'docs/DYNAMIC-DATA-INJECTION.md',
  'docs/STRUCTURED-DATA-FORMS.md', 'docs/EXTERNAL-API-INTEGRATIONS.md',
  'docs/VOICE-INPUT-MODES.md', 'docs/USE-CASES.md', 'SECURITY.md', 'SDK_CONSTITUTION.md',
];

/** Read a file relative to ROOT, return empty string if missing. */
function read(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/** Git-tracked file list (paths relative to ROOT). */
function trackedFiles() {
  const out = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' });
  return out.trim().split('\n').filter(Boolean);
}

/** Slugify a heading the same way GitHub does. */
function slugify(h) {
  let s = h.trim().toLowerCase();
  s = s.replace(/[^\w\s-]/g, '');
  s = s.replace(/ /g, '-');
  return s;
}

/** Collect headings from a markdown file → Set<slug>. */
function anchorsOf(filePath) {
  const anchors = new Set();
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) anchors.add(slugify(m[2]));
  }
  return anchors;
}

const SCAN_EXCLUDE_DIRS = [
  'node_modules', 'vendor', 'test', 'tests', 'artifacts', 'test-results',
  'recording', 'recordings', '.git',
];
const SCAN_EXCLUDE_FILES = ['package-lock.json', SELF];

function isExcluded(f) {
  const parts = f.split('/');
  if (SCAN_EXCLUDE_DIRS.some((d) => parts.includes(d))) return true;
  if (SCAN_EXCLUDE_FILES.some((s) => f.endsWith(s))) return true;
  return false;
}

const SCAN_EXTS = /\.(md|mjs|js|html|json|jsonl|yml|yaml)$/;

function scanFiles() {
  return trackedFiles().filter((f) => SCAN_EXTS.test(f) && !isExcluded(f));
}

// Secret-SHAPE scans (below, in "1. Secrets") must NOT exclude test/tests —
// a real secret pasted into a fixture is exactly as dangerous as one pasted
// into a doc, and excluding whole directories let that slip past silently.
// Only non-content dirs (deps, build artifacts, recordings) stay excluded.
const SECRET_SCAN_EXCLUDE_DIRS = SCAN_EXCLUDE_DIRS.filter((d) => d !== 'test' && d !== 'tests');

// test/unit/redaction.test.js intentionally embeds a djJ8-shaped fake token
// (as a literal string) to prove core/redact.js's KS-token regex scrubs it —
// same precedent as the net-guard.js exemption in the private-IP check below:
// the secret-shaped literal IS the test fixture under test, not a leaked
// credential. Allow-listed by exact file path, not by directory, so any OTHER
// real secret pasted anywhere else under test/ still fails the scan.
const SECRET_SCAN_EXCLUDE_FILES = ['test/unit/redaction.test.js'];

function isExcludedFromSecretScan(f) {
  const parts = f.split('/');
  if (SECRET_SCAN_EXCLUDE_DIRS.some((d) => parts.includes(d))) return true;
  if (SCAN_EXCLUDE_FILES.some((s) => f.endsWith(s))) return true;
  if (SECRET_SCAN_EXCLUDE_FILES.includes(f)) return true;
  return false;
}

function scanFilesForSecrets() {
  return trackedFiles().filter((f) => SCAN_EXTS.test(f) && !isExcludedFromSecretScan(f));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) SECRETS
// ─────────────────────────────────────────────────────────────────────────────
describe('1. Secrets', () => {
  test('no raw KS token (djJ8…) in tracked files', () => {
    const files = scanFilesForSecrets();
    const offenders = [];
    for (const f of files) {
      const content = read(f);
      if (/djJ8[A-Za-z0-9_-]{20,}/.test(content)) offenders.push(f);
    }
    assert.deepEqual(offenders, [], `raw KS tokens found in: ${offenders.join(', ')}`);
  });

  test('no 32-char hex secret-shaped string in tracked files', () => {
    // Unanchored (\b...\b, not ^...$) — catches a hex secret embedded inside a
    // longer string (e.g. `Bearer <32hex>`, `token=<32hex>`), not just a bare
    // exactly-quoted 32-char literal. Mirrors core/redact.js's HEX32_RE shape.
    const re = /\b[a-f0-9]{32}\b/;
    const files = scanFilesForSecrets();
    const offenders = [];
    for (const f of files) {
      if (re.test(read(f))) offenders.push(f);
    }
    assert.deepEqual(offenders, [], `hex-secret-shaped string found in: ${offenders.join(', ')}`);
  });

  // Local pre-commit safety net, NOT a CI gate: CI never checks out a .env
  // file (it's gitignored and never provisioned by the pipeline), so this
  // test's "no .env — skip" early-return fires on every CI run and the check
  // silently no-ops there. It only has teeth on a maintainer's own machine,
  // where .env holds a real AGENTIC_ADMIN_SECRET that could otherwise get
  // pasted into a doc/fixture by accident. A CI-enforced version of this
  // check would need to source the secret from a CI secret store, not a
  // local .env file — out of scope for this script.
  test('no Admin Secret leaked into tracked files', () => {
    const envPath = join(ROOT, '.env');
    if (!existsSync(envPath)) return; // no .env — skip
    const secret = readFileSync(envPath, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('AGENTIC_ADMIN_SECRET='))
      ?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
    if (!secret) return;
    const files = scanFilesForSecrets();
    const offenders = [];
    for (const f of files) {
      if (read(f).includes(secret)) offenders.push(f);
    }
    assert.deepEqual(offenders, [], `Admin Secret leaked in: ${offenders.join(', ')}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) RFC1918 private IPs
// ─────────────────────────────────────────────────────────────────────────────
describe('2. Private IPs', () => {
  test('no RFC1918 private IPs in tracked files', () => {
    const re = /\b(10|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.\d{1,3}\.\d{1,3}\b/;
    // net-guard.js IS the SSRF guard — its private-range regex/examples are the
    // detection logic itself, not a leaked address.
    const NET_GUARD = 'src/core/net-guard.js';
    const files = scanFiles().filter((f) => f !== SELF && f !== NET_GUARD);
    const offenders = [];
    for (const f of files) {
      if (re.test(read(f))) offenders.push(f);
    }
    assert.deepEqual(offenders, [], `private IPs found in: ${offenders.join(', ')}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) ICE policy
// ─────────────────────────────────────────────────────────────────────────────
describe('3. ICE policy', () => {
  test("src/experience/wire.js ICE policy: STV=relay, ASR=all (unchanged)", () => {
    const src = read('src/experience/wire.js');
    assert.ok(src.includes("channel === 'stv'"), "stv channel check not found in wire.js");
    assert.ok(src.includes("isFirefox ? 'all' : 'relay'"), "STV relay policy not found in wire.js");
  });

  test('docs: no doc claims STV uses default ICE / no relay / all', () => {
    const mdFiles = trackedFiles().filter((f) => f.endsWith('.md') && f !== SELF);
    for (const f of mdFiles) {
      const content = read(f);
      if (/STV[^.]{0,40}(does\s*n.?t\s*need\s*relay|default\s*ICE|no\s*relay|uses\s*.?all.?)/i.test(content)) {
        assert.fail(`${f}: doc claims STV uses default ICE / no relay — STV is iceTransportPolicy:'relay'`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) Socket events: all captured events documented in WIRE-PROTOCOL.md
// ─────────────────────────────────────────────────────────────────────────────
describe('4. Socket event coverage', () => {
  test('all captured socket events (golden fixture) appear in WIRE-PROTOCOL.md', () => {
    const golden = JSON.parse(read('test/fixtures/golden-session.json'));
    const events = [...(golden.inboundEvents ?? []), ...(golden.outboundEvents ?? [])];
    const wireDoc = read('docs/WIRE-PROTOCOL.md');
    const documented = new Set(wireDoc.match(/`([a-zA-Z_][a-zA-Z0-9_-]+)`/g)?.map((s) => s.slice(1, -1)) ?? []);
    const missing = events.filter((e) => !documented.has(e));
    assert.deepEqual(missing, [], `socket events not in WIRE-PROTOCOL.md: ${missing.join(', ')}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) GFM hygiene
// ─────────────────────────────────────────────────────────────────────────────
describe('5. GFM hygiene', () => {
  function gfmCheck(files) {
    const issues = [];
    for (const rel of files) {
      const full = join(ROOT, rel);
      if (!existsSync(full)) continue;
      const txt = readFileSync(full, 'utf8');
      const lines = txt.split('\n');
      let fence = false;
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const s = ln.trimStart();
        if (s.startsWith('```')) {
          if (!fence && i > 0 && lines[i - 1].trim() !== '') {
            issues.push(`${rel}:${i + 1}: no blank line before code fence`);
          }
          if (/[ \t]+$/.test(ln)) {
            issues.push(`${rel}:${i + 1}: trailing whitespace on code-fence line`);
          }
          fence = !fence;
          continue;
        }
        if (fence) {
          if (/[ \t]+$/.test(ln)) {
            issues.push(`${rel}:${i + 1}: trailing whitespace inside code block (not a <br> — strip it)`);
          }
          continue;
        }
        const prev = i > 0 ? lines[i - 1].trim() : '';
        if (/^#{1,6}\s/.test(s) && i > 0 && prev !== '') {
          issues.push(`${rel}:${i + 1}: no blank line before heading`);
        }
        if (/^\|.*\|/.test(s) && prev !== '' && !/^\|/.test(lines[i - 1]?.trimStart() ?? '')) {
          issues.push(`${rel}:${i + 1}: no blank line before table`);
        }
        const m = ln.match(/[ \t]+$/);
        if (m) {
          const ws = m[0];
          const next = i + 1 < lines.length ? lines[i + 1].trim() : '';
          if (ws.includes('\t')) {
            issues.push(`${rel}:${i + 1}: trailing tab`);
          } else if (ws === '  ' && next === '') {
            issues.push(`${rel}:${i + 1}: 2-space hard break before blank line (useless)`);
          } else if (ws !== '  ') {
            issues.push(`${rel}:${i + 1}: bad trailing whitespace (${ws.length} spaces — use 0 or exactly 2)`);
          }
        }
      }
      if (!txt.endsWith('\n')) issues.push(`${rel}:EOF: no trailing newline`);
      if (fence) issues.push(`${rel}:EOF: unclosed code fence`);
    }
    return issues;
  }

  test('GFM clean across all tracked .md files', () => {
    const mdFiles = trackedFiles().filter((f) => f.endsWith('.md'));
    const issues = gfmCheck(mdFiles);
    assert.deepEqual(issues, [], `GFM issues:\n  ${issues.join('\n  ')}`);
  });

  test('env-var commands in shell code blocks use clean export form (no cramming, no backslash continuation)', () => {
    const crammed = /^\s*[A-Za-z_][A-Za-z0-9_]*=\S+\s+[A-Za-z_][A-Za-z0-9_]*=\S+\s+\S/;
    const contin  = /^\s*[A-Za-z_][A-Za-z0-9_]*=\S+\s*\\\s*$/;
    const mdFiles = trackedFiles().filter((f) => f.endsWith('.md'));
    const issues = [];
    for (const f of mdFiles) {
      const lines = read(f).split('\n');
      let fenceLang = null;
      for (let i = 0; i < lines.length; i++) {
        const s = lines[i].trim();
        if (s.startsWith('```')) {
          fenceLang = fenceLang === null ? s.slice(3).trim().toLowerCase() : null;
          continue;
        }
        if (['bash', 'sh', 'shell', 'console', 'zsh'].includes(fenceLang)) {
          if (crammed.test(lines[i])) {
            issues.push(`${f}:${i + 1}: crammed inline-env — use one export per line`);
          } else if (contin.test(lines[i])) {
            issues.push(`${f}:${i + 1}: env var with trailing '\\' — use export VAR=… lines`);
          }
        }
      }
    }
    assert.deepEqual(issues, [], `env-var formatting issues:\n  ${issues.join('\n  ')}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) Cross-doc link resolution
// ─────────────────────────────────────────────────────────────────────────────
describe('6. Cross-doc links', () => {
  test('all cross-doc .md links + #anchors resolve', () => {
    const anchorsCache = new Map();
    function getAnchors(absPath) {
      if (anchorsCache.has(absPath)) return anchorsCache.get(absPath);
      const a = anchorsOf(absPath);
      anchorsCache.set(absPath, a);
      return a;
    }

    const broken = [];
    for (const rel of DOCS) {
      const full = join(ROOT, rel);
      if (!existsSync(full)) continue;
      const content = readFileSync(full, 'utf8');
      const base = dirname(full);
      for (const m of content.matchAll(/\]\(([^)#]+\.md)(#[^)]+)?\)/g)) {
        const target = m[1];
        const frag   = m[2];
        if (target.startsWith('http')) continue;
        const absTarget = normalize(join(base, target));
        if (!existsSync(absTarget)) {
          broken.push(`${rel} → ${target} (missing file)`);
          continue;
        }
        if (frag && frag.length > 1) {
          const slug = frag.slice(1).toLowerCase();
          const anchors = getAnchors(absTarget);
          if (!anchors.has(slug)) {
            broken.push(`${rel} → ${target}${frag} (stale anchor)`);
          }
        }
      }
    }
    assert.deepEqual(broken, [], `broken links:\n  ${broken.join('\n  ')}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) SDK invariants
// ─────────────────────────────────────────────────────────────────────────────
describe('7. SDK invariants', () => {
  test('zero runtime + dev dependencies', () => {
    const pkg = JSON.parse(read('package.json'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    assert.deepEqual(Object.keys(deps), [], `package.json declares deps: ${Object.keys(deps).join(', ')}`);
  });

  test('no install lifecycle scripts', () => {
    const pkg = JSON.parse(read('package.json'));
    const bad = Object.keys(pkg.scripts || {}).filter((k) =>
      ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack'].includes(k),
    );
    assert.deepEqual(bad, [], `lifecycle scripts found: ${bad.join(', ')}`);
  });

  test('no registry publishConfig', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(!pkg.publishConfig, 'package.json declares publishConfig — this repo is private and not published');
  });

  test('SECURITY.md present and in files allowlist', () => {
    assert.ok(existsSync(join(ROOT, 'SECURITY.md')), 'SECURITY.md missing');
    assert.ok(read('package.json').includes('SECURITY.md'), 'SECURITY.md not in package.json files');
  });

  test('all socket.io CDN <script> tags carry SRI integrity', () => {
    const htmlFiles = trackedFiles().filter((f) => f.endsWith('.html') && f.startsWith('examples/'));
    const offenders = [];
    for (const f of htmlFiles) {
      const content = read(f);
      if (/cdn\.socket\.io\/[0-9.]+\/socket\.io(\.min)?\.js/.test(content)) {
        if (!/integrity="sha(256|384|512)-/.test(content)) offenders.push(f);
      }
    }
    assert.deepEqual(offenders, [], `socket.io CDN without SRI in: ${offenders.join(', ')}`);
  });

  test('src: no TODO/FIXME/XXX/stub markers', () => {
    const files = trackedFiles().filter((f) => f.startsWith('src/') && f.endsWith('.js'));
    const issues = [];
    for (const f of files) {
      const content = read(f);
      const lines = content.split('\n');
      lines.forEach((ln, i) => {
        if (/TODO|FIXME|XXX|\bstub\b/.test(ln)) issues.push(`${f}:${i + 1}: ${ln.trim()}`);
      });
    }
    assert.deepEqual(issues, [], `stubs/markers in src:\n  ${issues.join('\n  ')}`);
  });

  test('no not_implemented stubs in src', () => {
    const files = trackedFiles().filter((f) => f.startsWith('src/') && f.endsWith('.js'));
    const offenders = files.filter((f) => read(f).includes("code: 'not_implemented'"));
    assert.deepEqual(offenders, [], `not_implemented in: ${offenders.join(', ')}`);
  });

  test('mint-time entitlement guard in core/session.js', () => {
    assert.ok(read('src/core/session.js').includes('assertEntitlementOn'), 'assertEntitlementOn missing from core/session.js');
  });

  test('socket.io never imported in src (only injected)', () => {
    const files = trackedFiles().filter((f) => f.startsWith('src/') && f.endsWith('.js'));
    const offenders = [];
    for (const f of files) {
      const lines = read(f).split('\n');
      for (const [i, ln] of lines.entries()) {
        if (/from\s+['"]socket\.io|require\(['"]socket\.io/.test(ln) && !/^\s*(\*|\/\/|\/\*)/.test(ln)) {
          offenders.push(`${f}:${i + 1}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `socket.io imported (not injected) at: ${offenders.join(', ')}`);
  });

  test("cast_mode never defaults to 'webrtc'", () => {
    const files = trackedFiles().filter((f) => f.startsWith('src/') && f.endsWith('.js'));
    for (const f of files) {
      const lines = read(f).split('\n');
      for (const [i, ln] of lines.entries()) {
        if (/cast_mode.*['"]webrtc['"]/.test(ln) && !/never|not |broken|R8/i.test(ln)) {
          assert.fail(`${f}:${i + 1}: default cast_mode:'webrtc' found (must omit → SRS WHEP)`);
        }
      }
    }
  });

  test('CAPABILITIES enum matches API-REFERENCE.md catalogue', () => {
    const capSrc = read('src/management/capabilities.js');
    const m = capSrc.match(/CAPABILITIES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
    assert.ok(m, 'could not parse CAPABILITIES array from capabilities.js');
    const codeSet = new Set(m[1].match(/'([a-z_]+)'/g)?.map((s) => s.slice(1, -1)) ?? []);
    assert.ok(codeSet.size > 0, 'CAPABILITIES array is empty');

    const docText = read('API-REFERENCE.md');
    const catSet = new Set(
      [...docText.matchAll(/^\|\s*`([a-z_]+)`\s*\|\s*(?:ON|OFF)\s*\|/gm)].map(
        (x) => x[1],
      ),
    );
    assert.ok(catSet.size > 0, 'no capability rows found in API-REFERENCE.md');

    const missingDoc  = [...codeSet].filter((c) => !catSet.has(c));
    const missingCode = [...catSet].filter((c) => !codeSet.has(c));
    assert.deepEqual(missingDoc,  [], `in code but not in catalogue: ${missingDoc.join(', ')}`);
    assert.deepEqual(missingCode, [], `in catalogue but not in code: ${missingCode.join(', ')}`);
  });

  test('client-tool channel wired + documented', () => {
    assert.ok(read('src/management/tools.js').includes('export function client('), 'tools.client missing');
    assert.ok(read('src/management/tools.js').includes('export function clientToolReadiness'), 'tools.clientToolReadiness missing');
    assert.ok(read('src/core/stream.js').includes('export function parseToolCall'), 'parseToolCall missing');
    assert.ok(read('src/experience/session.js').includes('onToolCall(name, handler)'), 'session.onToolCall missing');
    assert.ok(read('README.md').includes('tools.client'), 'README.md missing tools.client docs');
    assert.ok(read('README.md').includes('onToolCall'), 'README.md missing onToolCall docs');
    assert.ok(read('docs/WIRE-PROTOCOL.md').includes('client-side-command channel'), 'WIRE-PROTOCOL.md missing type:tool channel note');
  });

  test('all tests pass', () => {
    const testFiles = execSync('find test -name "*.test.js"', {
      cwd: ROOT, encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
    assert.ok(testFiles.length > 0, 'no test files found');

    const result = spawnSync(
      process.execPath,
      ['--test', '--test-concurrency=1', ...testFiles],
      { cwd: ROOT, encoding: 'utf8', timeout: 120_000 },
    );
    if (result.status !== 0) {
      const out = (result.stdout || '') + (result.stderr || '');
      const failLines = out.split('\n')
        .filter((l) => /not ok|cancelled|Error|ERR_|SyntaxError/.test(l))
        .slice(0, 20).join('\n');
      assert.fail(`SDK tests failed:\n${failLines}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8) Preprocessing-claim accuracy (see issue #15)
// ─────────────────────────────────────────────────────────────────────────────
describe('8. Preprocessing-claim accuracy', () => {
  // Scoped to "no preprocessing" specifically, not "no-op"/"unmodified" —
  // those are legitimate, common terms elsewhere (idempotent methods, or
  // issue #16's deliberate "raw, unmodified upload" passthrough annotation)
  // and would collide with correct docs if flagged here. The actual defect
  // (issue #15) is a false claim about backend image processing, so the
  // check only fires where that specific claim and visual-content
  // vocabulary co-occur without a citation naming how it was verified.
  const ABSOLUTE_CLAIM = /\bno preprocessing\b/i;
  const VISUAL_CONTEXT = /\b(portrait|visual|image|face|avatar likeness)\b/i;
  const CITED = /verified:.*\b(preprocessing|crop|pad|face|frame|ratio)\b/i;

  // Split into paragraph-or-list-item units — a blank-line paragraph split
  // alone merges unrelated bullets under one Markdown list into a single
  // "paragraph" (e.g. SECURITY.md's LLM01/deepfake bullets), producing
  // false positives across bullets that share nothing but proximity.
  function claimUnits(text) {
    const units = [];
    let cur = [];
    for (const line of text.split('\n')) {
      const startsListItem = /^\s*[-*]\s/.test(line);
      if ((line.trim() === '' || startsListItem) && cur.length) {
        units.push(cur.join('\n'));
        cur = [];
      }
      if (line.trim() !== '') cur.push(line);
    }
    if (cur.length) units.push(cur.join('\n'));
    return units;
  }

  test('absolute preprocessing/processing claims about visual content are paired with a citation that actually verifies them', () => {
    const mdFiles = [...DOCS, 'README.md'].filter((f, i, a) => a.indexOf(f) === i);
    const offenders = [];
    for (const f of mdFiles) {
      const text = read(f);
      if (!text) continue;
      for (const unit of claimUnits(text)) {
        if (ABSOLUTE_CLAIM.test(unit) && VISUAL_CONTEXT.test(unit) && !CITED.test(unit)) {
          offenders.push(`${f}: "${unit.match(ABSOLUTE_CLAIM)[0]}" (visual-content context) without a citation that verifies the processing claim itself`);
        }
      }
    }
    assert.deepEqual(offenders, [], `uncited absolute visual-processing claims:\n  ${offenders.join('\n  ')}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9) Preview/loading field annotation (see issue #16)
// ─────────────────────────────────────────────────────────────────────────────
describe('9. Preview/loading field annotation', () => {
  const FIELD = /^\w*(preview\w*|imageurl|videourl)\w*$/i;
  const ANNOTATED = /\b(raw|passthrough|rendered)\b/i;

  test('preview*/*ImageUrl/*VideoUrl field references in API-REFERENCE.md carry a raw-passthrough or rendered annotation on the same line', () => {
    const text = read('API-REFERENCE.md');
    const offenders = [];
    for (const [i, line] of text.split('\n').entries()) {
      const codeSpans = line.match(/`([^`]+)`/g) || [];
      const hasField = codeSpans.some((c) => c.slice(1, -1).split(/[^a-zA-Z]+/).some((word) => FIELD.test(word)));
      if (hasField && !ANNOTATED.test(line)) {
        offenders.push(`API-REFERENCE.md:${i + 1}: ${line.trim()}`);
      }
    }
    assert.deepEqual(offenders, [], `unannotated preview/loading field references:\n  ${offenders.join('\n  ')}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10) Avatar video framing (see issue #18)
// ─────────────────────────────────────────────────────────────────────────────
describe('10. Avatar video framing', () => {
  // File-level, not selector-level: precise per-file selector coverage is
  // proven in test/unit/examples-video-css.test.js. This gate exists so a
  // FUTURE example added under examples/ with a bare <video> and zero CSS
  // (the exact issue #18 defect) fails loudly here too, without needing to
  // know that new file's specific markup shape in advance.
  test('every examples/*.html file with a <video> element declares object-fit somewhere in its <style> block', () => {
    const htmlFiles = trackedFiles().filter((f) => f.startsWith('examples/') && f.endsWith('.html'));
    const offenders = [];
    for (const f of htmlFiles) {
      const content = read(f);
      if (!/<video\b/i.test(content)) continue;
      const style = content.match(/<style>([\s\S]*?)<\/style>/i)?.[1] ?? '';
      if (!/object-fit/i.test(style)) offenders.push(f);
    }
    assert.deepEqual(offenders, [], `examples with a <video> but no object-fit rule: ${offenders.join(', ')}`);
  });
});
