#!/usr/bin/env node
/**
 * @kaltura/intelligent-agents — Constitution Harness (supplementary)
 *
 * `scripts/agent_verify.mjs` is the canonical SDK_CONSTITUTION.md verifier and
 * already runs in CI (the `constitution` job) — it owns every grep-shaped rule:
 * I-1/I-2 (isolation), S-1/S-2/S-6 (AppSec), R-1..R-5 and P-1 (presence checks
 * on http.js), D-1/D-2/D-3 (JSDoc/dead-export/stub scans). `scripts/harness/
 * semgrep-rules.yml` additionally covers eval/innerHTML/shell-injection/raw-fetch
 * as proper SAST rules. This script does NOT duplicate any of that — it only
 * covers what neither reaches:
 *
 *   - A numeric THRESHOLD on `maxResponseBytes`, not just presence of the guard
 *     (agent_verify.mjs's P-1 passes as soon as the word appears; it can't tell
 *     a sane 10 MiB cap from a useless 1-byte one).
 *   - The bounded-accumulation guard in `core/stream.js` — no other gate reads
 *     this file at all.
 *   - The fetch-injectability CONTRACT in `experience/session.js` (`cfg.fetch ||
 *     globalThis.fetch`) — no other gate reads this file either.
 *   - Issue-closure checks: named symbols from specific shipped features that
 *     must never silently vanish in a refactor. This is the one category no
 *     other gate replaces — it's institutional memory, not a pattern match.
 *
 * Exit code: 0 on all checks green, 1 on any failure.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// script lives at sdk/tools/constitution-harness.mjs → sdk/ is one level up
const SDK_ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
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
function read(path) {
  return readFileSync(path, 'utf8');
}

// ─── Performance: response-size THRESHOLD + bounded accumulation ───────────

section('Performance — size threshold + bounded accumulation');
{
  const httpSrc = read(join(SDK_SRC, 'core/http.js'));

  const mibForm = httpSrc.includes('10 * 1024 * 1024') || httpSrc.includes('10485760');
  const plainMatch = httpSrc.match(/maxResponseBytes\s*\?\?\s*(\d[\d_]*)\b/);
  if (mibForm) {
    ok('Http: default maxResponseBytes = 10 MiB (expression form)');
  } else if (plainMatch) {
    const cap = parseInt(plainMatch[1].replace(/_/g, ''), 10);
    if (cap >= 1024 * 1024) {
      ok(`Http: default maxResponseBytes = ${(cap / (1024 * 1024)).toFixed(0)} MiB`);
    } else {
      ng('Http: default maxResponseBytes too small', `${cap} bytes — agent_verify.mjs's P-1 only checks the guard exists, not that its default is sane`);
    }
  } else {
    ng('Http: default maxResponseBytes cap not found', '');
  }

  const streamSrc = read(join(SDK_SRC, 'core/stream.js'));
  if (/SPOKEN_TYPES/.test(streamSrc)) {
    ok('stream.js: SPOKEN_TYPES guard present (text accumulation is bounded by type)');
  } else {
    ng('stream.js: SPOKEN_TYPES guard absent', 'collectConverse may accumulate unboundedly');
  }
}

// ─── Resiliency: fetch is injectable in the Experience runtime ─────────────

section('Resiliency — session.js fetch injectability contract');
{
  const sessionSrc = read(join(SDK_SRC, 'experience/session.js'));
  if (/cfg\.fetch\s*\|\|/.test(sessionSrc)) {
    ok('session.js: fetch is injectable (cfg.fetch || globalThis.fetch)');
  } else {
    ng('session.js: fetch not injectable', 'missing `cfg.fetch || globalThis.fetch` pattern');
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
