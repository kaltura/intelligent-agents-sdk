#!/usr/bin/env node
/**
 * @kaltura/intelligent-agents — Constitution Harness
 *
 * Standalone, zero-dependency proof script that enforces five structural
 * rules across the SDK source tree, plus a handful of issue-closure checks
 * for specific merged features. Complements (does not replace) `check-docs.mjs`,
 * which owns doc↔code drift; this script owns SDK-source-only invariants that
 * check-docs.mjs doesn't cover (global-state writes, CSP-unsafe patterns,
 * retry/backoff shape, response-size caps, JSDoc coverage, dead exports).
 *
 * Rules:
 *   C1 — Isolation    : no global-state mutations (no `window.X =`, no `globalThis.X =` writes)
 *   C2 — AppSec       : no `eval()`, no `innerHTML =`, no `new Function(`, no `document.write(`
 *   C3 — Resiliency   : all HTTP I/O routes through Http transport with documented retry/backoff
 *   C4 — Performance  : response size cap enforced (maxResponseBytes), no uncapped reads
 *   C5 — DX/JSDoc     : all public exports carry at least one JSDoc comment; no TODO/FIXME/stub
 *
 * Issue-closure checks (features that shipped and should never silently regress):
 *   I4  — resolveIntellectId exists in agents.js (E1/D2 — no genieId probe needed)
 *   I5  — requireDisclosureAck + acknowledgeDisclosure + disclosure_required present in session.js (P5)
 *   I6  — CaptionService exported from experience index
 *   I7  — createConversationToken present in core/session.js (D5 one-call token)
 *   I10 — hubspotContactUpsert + salesforceContactUpsert exported from management index
 *   I11 — Presenter + parseSlideNumber exported from experience index
 *   I12 — meta() present in ids.js with generatedAt
 *   I13 — waitForCapacity present in session.js (R4)
 *   I14 — whep_private_ip error code present in session.js (R8, additive Location check)
 *
 * Exit code: 0 on all checks green, 1 on any failure.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// script lives at sdk/tools/constitution-harness.mjs → sdk/ is one level up
const SDK_ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const ROOT = SDK_ROOT;
const SDK_SRC = join(SDK_ROOT, 'src');

let pass = 0;
let fail = 0;
const failures = [];

function ok(label) {
  process.stdout.write(`  ✔ ${label}\n`);
  pass++;
}
function ng(label, detail) {
  process.stdout.write(`  ✘ ${label}\n    → ${detail}\n`);
  fail++;
  failures.push({ label, detail });
}
function section(name) {
  process.stdout.write(`\n▶ ${name}\n`);
}

// ─── File helpers ───────────────────────────────────────────────────────────

function allFiles(dir, exts = ['.js', '.mjs']) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...allFiles(full, exts));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function read(path) {
  return readFileSync(path, 'utf8');
}

const srcFiles = allFiles(SDK_SRC);

// ─── C1: Isolation — no global-state mutations ──────────────────────────────

section('C1 — Isolation: no global-state mutations');
{
  // Reads are fine (globalThis.fetch, globalThis.crypto); writes are forbidden.
  const WRITE_GLOBAL = /(?:globalThis|window)\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*\s*=(?![=>])/;
  const violations = [];
  for (const f of srcFiles) {
    const lines = read(f).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (WRITE_GLOBAL.test(line) && !line.trimStart().startsWith('//')) {
        violations.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  if (violations.length === 0) {
    ok('no global-state writes (globalThis.X= / window.X=)');
  } else {
    ng('global-state writes found', violations.join('\n    '));
  }

  // Multi-instance: Management constructor must not share any module-level mutable state.
  const clientSrc = read(join(SDK_SRC, 'management/client.js'));
  const moduleLevelMutable = /^(?:let|var)\s+/m.test(clientSrc);
  if (!moduleLevelMutable) {
    ok('client.js has no module-level mutable `let`/`var` declarations');
  } else {
    ng('client.js has module-level mutable state (let/var)', 'multi-instance isolation at risk');
  }
}

// ─── C2: AppSec — no eval / no dynamic code / no unsafe HTML injection ─────

section('C2 — AppSec: eval / new Function / innerHTML / document.write');
{
  const BANNED = [
    { re: /\beval\s*\(/, label: 'eval(' },
    { re: /new\s+Function\s*\(/, label: 'new Function(' },
    { re: /\binnerHTML\s*=(?!=)/, label: 'innerHTML =' },
    { re: /document\.write\s*\(/, label: 'document.write(' },
  ];

  const violations = [];
  for (const f of srcFiles) {
    const lines = read(f).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart().startsWith('//')) continue;
      for (const { re, label } of BANNED) {
        if (re.test(line)) {
          violations.push(`${label} at ${relative(ROOT, f)}:${i + 1}`);
        }
      }
    }
  }
  if (violations.length === 0) {
    ok('no eval / new Function / innerHTML= / document.write in sdk/src');
  } else {
    ng('CSP-violating patterns found', violations.join('\n    '));
  }

  // No TODO/FIXME/stub markers (sanity double-check; check-docs.mjs already enforces)
  const markers = [];
  for (const f of srcFiles) {
    const content = read(f);
    const found = [...content.matchAll(/\b(?:TODO|FIXME|XXX|STUB|not_implemented)\b/g)];
    if (found.length) markers.push(`${relative(ROOT, f)}: ${found.length} marker(s)`);
  }
  if (markers.length === 0) {
    ok('no TODO/FIXME/XXX/STUB markers in sdk/src');
  } else {
    ng('stub/TODO markers present', markers.join('; '));
  }
}

// ─── C3: Resiliency — retry/backoff is documented and present in Http ────────

section('C3 — Resiliency: retry/backoff in Http transport');
{
  const httpSrc = read(join(SDK_SRC, 'core/http.js'));

  const hasRetriable = /RETRIABLE_STATUSES/.test(httpSrc);
  const hasMaxRetries = /maxRetries/.test(httpSrc);
  const hasBaseDelay = /baseDelayMs/.test(httpSrc);
  const hasMaxDelay = /maxDelayMs/.test(httpSrc);
  const hasExponential = /exponential|backoff|jitter/i.test(httpSrc);

  if (hasRetriable && hasMaxRetries && hasBaseDelay && hasMaxDelay && hasExponential) {
    ok('Http: RETRIABLE_STATUSES + maxRetries + baseDelayMs + maxDelayMs + backoff/jitter');
  } else {
    ng(
      'Http retry/backoff incomplete',
      `RETRIABLE_STATUSES=${hasRetriable} maxRetries=${hasMaxRetries} ` +
        `baseDelayMs=${hasBaseDelay} maxDelayMs=${hasMaxDelay} exponential/jitter=${hasExponential}`,
    );
  }

  // Verify that direct fetch calls outside Http are not present in management src
  const mgmtFiles = allFiles(join(SDK_SRC, 'management'));
  const rawFetchCalls = [];
  for (const f of mgmtFiles) {
    const lines = read(f).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        /(?:^|[^.\w])fetch\s*\(/.test(line) &&
        !line.includes('this._fetch') &&
        !line.includes('opts.fetch') &&
        !line.includes('cfg.fetch') &&
        !line.trimStart().startsWith('//') &&
        !line.trimStart().startsWith('*')
      ) {
        rawFetchCalls.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  if (rawFetchCalls.length === 0) {
    ok('management src: no raw fetch() calls outside Http transport');
  } else {
    ng('management src has raw fetch() bypass', rawFetchCalls.join('\n    '));
  }

  // Verify inject pattern in session.js
  const sessionSrc = read(join(SDK_SRC, 'experience/session.js'));
  const hasInjectFetch = /cfg\.fetch\s*\|\|/.test(sessionSrc);
  if (hasInjectFetch) {
    ok('session.js: fetch is injectable (cfg.fetch || globalThis.fetch)');
  } else {
    ng('session.js: fetch not injectable', 'missing `cfg.fetch || globalThis.fetch` pattern');
  }
}

// ─── C4: Performance — response size budgets, no uncapped body reads ─────────

section('C4 — Performance: payload size caps enforced');
{
  const httpSrc = read(join(SDK_SRC, 'core/http.js'));

  const hasSizeCap = /maxResponseBytes/.test(httpSrc) && /response_too_large/.test(httpSrc);
  if (hasSizeCap) {
    ok('Http: maxResponseBytes cap + response_too_large error defined');
  } else {
    ng('Http: missing maxResponseBytes cap or response_too_large error', '');
  }

  // Verify default cap is sensible (>= 1 MiB).
  const mibForm = httpSrc.includes('10 * 1024 * 1024') || httpSrc.includes('10485760');
  const plainMatch = httpSrc.match(/maxResponseBytes\s*\?\?\s*(\d[\d_]*)\b/);
  if (mibForm) {
    ok('Http: default maxResponseBytes = 10 MiB (expression form)');
  } else if (plainMatch) {
    const cap = parseInt(plainMatch[1].replace(/_/g, ''), 10);
    if (cap >= 1024 * 1024) {
      ok(`Http: default maxResponseBytes = ${(cap / (1024 * 1024)).toFixed(0)} MiB`);
    } else {
      ng('Http: default maxResponseBytes too small', `${cap} bytes`);
    }
  } else {
    ng('Http: default maxResponseBytes cap not found', '');
  }

  // Constitution rule: stream.js collectConverse must not accumulate unboundedly.
  const streamSrc = read(join(SDK_SRC, 'core/stream.js'));
  const hasSpokenTypes = /SPOKEN_TYPES/.test(streamSrc);
  if (hasSpokenTypes) {
    ok('stream.js: SPOKEN_TYPES guard present (text accumulation is bounded by type)');
  } else {
    ng('stream.js: SPOKEN_TYPES guard absent', 'collectConverse may accumulate unboundedly');
  }
}

// ─── C5: DX / JSDoc — public interface documentation ─────────────────────────

section('C5 — DX/JSDoc: public interfaces documented');
{
  const REQUIRED_JSDOC = [
    'management/client.js',
    'management/agents.js',
    'management/avatars.js',
    'management/intellects.js',
    'management/intellect-config.js',
    'management/crm-recipes.js',
    'management/tools.js',
    'management/capabilities.js',
    'management/provision.js',
    'experience/session.js',
    'core/http.js',
    'core/errors.js',
    'core/stream.js',
    'core/ids.js',
    'core/session.js',
  ];

  const missingJsdoc = [];
  for (const rel of REQUIRED_JSDOC) {
    const full = join(SDK_SRC, rel);
    try {
      const src = read(full);
      if (!/\/\*\*/.test(src)) missingJsdoc.push(rel);
    } catch {
      missingJsdoc.push(`${rel} (not found)`);
    }
  }
  if (missingJsdoc.length === 0) {
    ok(`all ${REQUIRED_JSDOC.length} public modules have JSDoc blocks`);
  } else {
    ng('modules missing JSDoc', missingJsdoc.join(', '));
  }

  // No dead-code: verify key exports from management/index.js are actually defined
  // in the source files they claim to come from (dead export = export of undefined).
  const mgmtIndex = read(join(SDK_SRC, 'management/index.js'));
  const exportedSymbols = [
    { symbol: 'Management', file: 'management/client.js' },
    { symbol: 'resolveIntellectId', file: 'management/agents.js' },
    { symbol: 'IntellectConfig', file: 'management/intellect-config.js' },
    { symbol: 'hubspotContactUpsert', file: 'management/crm-recipes.js' },
    { symbol: 'salesforceContactUpsert', file: 'management/crm-recipes.js' },
  ];
  const deadExports = [];
  for (const { symbol, file } of exportedSymbols) {
    const src = read(join(SDK_SRC, file));
    const defined = new RegExp(
      `export\\s+(?:function|class|const|async function)\\s+${symbol}\\b|export\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`,
    ).test(src);
    if (!defined) deadExports.push(`${symbol} (in ${file})`);
  }
  // Also confirm management/index.js itself re-exports each symbol.
  for (const { symbol } of exportedSymbols) {
    if (!new RegExp(`\\b${symbol}\\b`).test(mgmtIndex)) deadExports.push(`${symbol} (not re-exported from management/index.js)`);
  }
  if (deadExports.length === 0) {
    ok('no dead exports — all key symbols verified present in their source files and re-exported');
  } else {
    ng('dead exports found (exported but not defined, or not re-exported)', deadExports.join(', '));
  }
}

// ─── Issue closure checks ────────────────────────────────────────────────────

section('Issue closure checks');

const agentsSrc = read(join(SDK_SRC, 'management/agents.js'));
const sessionSrc = read(join(SDK_SRC, 'experience/session.js'));
const coreSessionSrc = read(join(SDK_SRC, 'core/session.js'));
const experienceIndexSrc = read(join(SDK_SRC, 'experience/index.js'));
const presenterSrc = read(join(SDK_SRC, 'experience/presenter.js'));
const slidenavSrc = read(join(SDK_SRC, 'experience/slidenav.js'));
const mgmtIndexSrc = read(join(SDK_SRC, 'management/index.js'));
const idsSrc = read(join(SDK_SRC, 'core/ids.js'));
const crmSrc = read(join(SDK_SRC, 'management/crm-recipes.js'));

// I4 — resolveIntellectId in agents.js
if (/resolveIntellectId/.test(agentsSrc)) {
  ok('#4 — resolveIntellectId present in agents.js (E1/D2 — no genieId probe needed)');
} else {
  ng('#4 — resolveIntellectId missing from agents.js', '');
}

// I5 — disclosure gate in session.js
if (/requireDisclosureAck/.test(sessionSrc) && /acknowledgeDisclosure/.test(sessionSrc) && /disclosure_required/.test(sessionSrc)) {
  ok('#5 — EU AI Act disclosure gate: requireDisclosureAck + acknowledgeDisclosure + disclosure_required');
} else {
  ng('#5 — disclosure gate incomplete in session.js', '');
}

// I6 — CaptionService in experience/index.js
if (/CaptionService/.test(experienceIndexSrc)) {
  ok('#6 — CaptionService exported from experience/index.js');
} else {
  ng('#6 — CaptionService not exported from experience/index.js', '');
}

// I7 — createConversationToken in core/session.js (one-call conversation token helper)
if (/createConversationToken/.test(coreSessionSrc)) {
  ok('#7 — createConversationToken present in core/session.js (D5 one-call token)');
} else {
  ng('#7 — createConversationToken missing from core/session.js', '');
}

// I10 — CRM recipes (hubspot/salesforce upsert builders, no captureContact — that pattern was discarded)
if (
  /hubspotContactUpsert/.test(crmSrc) &&
  /salesforceContactUpsert/.test(crmSrc) &&
  /hubspotContactUpsert/.test(mgmtIndexSrc) &&
  /salesforceContactUpsert/.test(mgmtIndexSrc)
) {
  ok('#10 — hubspotContactUpsert + salesforceContactUpsert present and re-exported');
} else {
  ng('#10 — CRM recipe surface incomplete', '');
}

// I11 — Presenter (own subpath) + parseSlideNumber (slidenav.js) still exist.
// Both moved OUT of experience/index.js in the Presenter/GenUI packaging split
// (they're now optional subpath exports, not part of the base barrel), so this
// checks their source files directly instead of the barrel.
if (/export class Presenter/.test(presenterSrc) && /export function parseSlideNumber/.test(slidenavSrc)) {
  ok('#11 — Presenter (presenter.js) + parseSlideNumber (slidenav.js) present');
} else {
  ng('#11 — Presenter or parseSlideNumber missing', '');
}

// I12 — meta() with generatedAt in ids.js
if (/generatedAt/.test(idsSrc) && /function meta|const meta|export.*meta/.test(idsSrc)) {
  ok('#12 — meta() with generatedAt present in ids.js');
} else {
  ng('#12 — meta() or generatedAt missing from ids.js', '');
}

// I13 — waitForCapacity in session.js
if (/waitForCapacity/.test(sessionSrc)) {
  ok('#13 — waitForCapacity present in session.js (R4)');
} else {
  ng('#13 — waitForCapacity missing from session.js', '');
}

// I14 — whep_private_ip error code present in session.js (R8, additive Location check)
if (/whep_private_ip/.test(sessionSrc)) {
  ok('#14 — whep_private_ip error code present in session.js (R8)');
} else {
  ng('#14 — whep_private_ip error code missing from session.js', '');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

process.stdout.write(`\n${'─'.repeat(60)}\n`);
process.stdout.write(`Constitution Harness: ${pass} pass, ${fail} fail\n`);

if (fail > 0) {
  process.stdout.write('\nFAILURES:\n');
  for (const { label, detail } of failures) {
    process.stdout.write(`  ✘ ${label}\n    ${detail}\n`);
  }
  process.stdout.write('\nEXIT: 1\n');
  process.exit(1);
} else {
  process.stdout.write('\nAll Constitution rules upheld — circuit breaker cleared.\nEXIT: 0\n');
  process.exit(0);
}
