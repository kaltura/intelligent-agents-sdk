#!/usr/bin/env node
/**
 * Live request-variables verification — real Kaltura API, no fakes.
 *
 * Proves every advanced `request_vars` behavior the SDK documents, end to end
 * on the HTTP transport (`converseOnce`). Each step is a hard assertion; the
 * run exits non-zero if any fails:
 *
 *   A  turn 1 sends counter=41 + visitor_tier=platinum → prompt renders 41
 *   B  turn 2, SAME thread, NO vars → 41 still renders (per-thread persistence)
 *   C  turn 3 updates counter=55 only → 55 renders (server-side merge)
 *   D  api tool call with NO vars on the turn → request template interpolates
 *      visitor_tier=platinum (persisted from turn 1, never referenced by any
 *      prompt) AND counter=55, and `response_mapping` shapes what comes back
 *   E  sys__* injection: a tool template renders `sys__thread_id` (echoed back
 *      and matched against THIS conversation's threadId) and a Jinja presence
 *      probe over `sys__ks` — proof the server injects live system variables.
 *      The KS itself NEVER leaves the tool template: only the boolean
 *      "present"/"absent" is sent (kaltura.com is not reachable from the tool
 *      executor, so calling session/get with the KS is not an
 *      option, and interpolating a raw KS toward any third-party endpoint
 *      would leak a live token).
 *   F  large page_context: ~32 KB of JSON through the PAGE_CONTEXT_PROMPT
 *      block (the exact channel `setDynamicPrompt` uses) — the model finds
 *      one needle item among hundreds
 *   G  fresh thread → all vars gone (per-thread scope, not per-config)
 *
 * The prompts are linted with `lintPrompts` (gate + placeholder cross-check)
 * before provisioning, so the script also exercises the §4a.3 guardrails.
 *
 * The socket transport's side of the same contract (setDynamicPrompt /
 * updateRequestVars emitting the full-context `updateGenieContext` payload
 * with capabilities preserved) is asserted at the wire level in
 * test/e2e/connect.test.js and test/unit/isolation.test.js — followup
 * segments are not observable under AVATAR_ONLY, so payload-shape tests are
 * the reliable regression there.
 *
 * Throwaway resources only (intellect + two api tools), full cleanup in
 * `finally`. Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the
 * environment or a .env file in the repo root.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management, lintPrompts, PAGE_CONTEXT_PROMPT, tools } from '../src/management/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const env = readFileSync(resolve(__dirname, '../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch {
  // No .env file — credentials must already be in the environment.
}

const partnerId = process.env.AGENTIC_PARTNER_ID;
const adminSecret = process.env.AGENTIC_ADMIN_SECRET;

if (!partnerId || !adminSecret) {
  console.error('AGENTIC_PARTNER_ID and AGENTIC_ADMIN_SECRET are required (env or repo-root .env).');
  process.exit(1);
}

const startedAt = new Date().toISOString();
const runId = `ci-live-verify-request-vars-${Date.now()}`;
const RUN_TAG = `rv${Date.now().toString(36)}`;
const artifact = { runId, startedAt, partnerId, steps: [] };

function record(step, ok, detail) {
  artifact.steps.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${step}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}

/** Assert-style record: FAIL marks the whole run failed but later steps still run. */
let failed = false;
function check(step, ok, detail) {
  if (!ok) failed = true;
  record(step, ok, detail);
}

const snippet = (text) => JSON.stringify(text ?? '').slice(0, 160);

// ~32 KB of page context: hundreds of look-alike items, one needle whose
// status only exists in this run. Finding it proves the whole blob reached
// the prompt, not a truncated prefix (the needle sits past the midpoint).
const NEEDLE_ID = 'itm-297';
const NEEDLE_STATUS = `ARMED-${RUN_TAG}`;
function buildLargePageContext() {
  const items = Array.from({ length: 420 }, (_, i) => ({
    id: `itm-${i}`,
    name: `Inventory item ${i} (${RUN_TAG})`,
    status: `itm-${i}` === NEEDLE_ID ? NEEDLE_STATUS : 'idle',
  }));
  const json = JSON.stringify({ page: '/inventory', items });
  if (json.length < 30_000) throw new Error(`page_context too small to prove size headroom: ${json.length} bytes`);
  return json;
}

const TOOL_ECHO = `live_verify_echo_${RUN_TAG}`;
const TOOL_SYSVARS = `live_verify_sysvars_${RUN_TAG}`;

const prompt = (key, headerTemplate, value) => ({ key, label: key, headerTemplate, type: 'custom', value });
const prompts = [
  prompt('name', 'Your name is:', 'Live-Verify Probe'),
  PAGE_CONTEXT_PROMPT,
  prompt('counterSection', 'Live counter value (authoritative, current — may change or be empty at any time):', '{{counter}}'),
  prompt('rules', 'Rules you must obey without exception:', [
    'When asked what the counter section says, report EXACTLY what the "Live counter value" section above contains RIGHT NOW. If it is empty, reply with the single word EMPTY.',
    'The section is the ONLY source of truth for the counter. Values mentioned in earlier conversation turns are stale and must be ignored.',
    `When asked to check the server echo, call ${TOOL_ECHO}, then report the received_tier and received_counter values it returned, verbatim. If a value is empty, say NONE for it.`,
    `When asked to check the system variables, call ${TOOL_SYSVARS}, then report the ks_state and echo_thread values it returned, verbatim.`,
    'When asked about an item in the live page context, reply with ONLY that item\'s status value, verbatim.',
  ].join('\n')),
];

const kaltura = new Management({ partnerId, adminSecret });
let admin;
let intellectId;
const toolIds = [];

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  // §4a.3 guardrails, exercised pre-flight: the gate will be ON and both
  // client vars ({{page_context}}, {{counter}}) are referenced, so the lint
  // must come back clean. visitor_tier is DELIBERATELY absent from every
  // prompt — step D proves tools still see it.
  const lint = lintPrompts(prompts, { allowClientVariables: true, knownVars: ['counter', 'page_context'] });
  check('prompt-lint-clean', lint.ok && lint.findings.length === 0, {
    findings: lint.findings, clientVariables: lint.clientVariables,
  });

  // Echo tool: POSTs {{visitor_tier}} + {{counter}} to a public echo server
  // (no secrets in the template) and maps the echo back.
  const echoTool = await kaltura.tools.add(tools.api({
    name: TOOL_ECHO,
    description: 'Check what the remote echo server currently knows. Call this whenever the visitor asks you to check the server echo. Takes no arguments.',
    request: {
      url: 'https://httpbin.org/anything',
      method: 'POST',
      body: { tier: '{{ visitor_tier }}', counter: '{{ counter }}' },
      timeout: 20,
    },
    responseMapping: { received_tier: 'json.tier', received_counter: 'json.counter' },
  }), admin);
  toolIds.push(echoTool.id);
  record('tool-create-echo', true, { toolId: echoTool.id, name: TOOL_ECHO });

  // sys__* injection tool: echoes sys__thread_id (harmless, matched against
  // the live threadId below) and a Jinja PRESENCE probe over sys__ks. The raw
  // KS must never be interpolated toward any non-Kaltura endpoint, and the
  // tool executor cannot reach kaltura.com, so presence/shape
  // is the strongest safe assertion.
  const sysvarsTool = await kaltura.tools.add(tools.api({
    name: TOOL_SYSVARS,
    description: 'Check the system variables on the remote echo server. Call this whenever the visitor asks you to check the system variables. Takes no arguments.',
    request: {
      url: 'https://httpbin.org/anything',
      method: 'POST',
      body: {
        ks_state: "{{ 'present' if (sys__ks | default('') | length) > 20 else 'absent' }}",
        tid: '{{ sys__thread_id }}',
      },
      timeout: 20,
    },
    responseMapping: { ks_state: 'json.ks_state', echo_thread: 'json.tid' },
  }), admin);
  toolIds.push(sysvarsTool.id);
  record('tool-create-sysvars', true, { toolId: sysvarsTool.id, name: TOOL_SYSVARS });

  const intel = await kaltura.intellects.add({
    type: 'internal',
    status: 2,
    allow_client_variables: true,   // pin the gate explicitly — off means silent empty turns
    tool_ids: toolIds,
    prompts,
    capabilities: {
      avatar: 'on', avatar_filler: 'off', use_knowledge_base: 'off',
      use_content_search: 'disabled', use_get_entry_content: 'disabled',
      use_related_files: 'disabled', use_web_search: 'disabled',
      generate_followup_questions: 'disabled', include_sources: 'disabled',
      video_gallery: 'disabled', external_video: 'disabled', show_link: 'disabled',
      avatar_show_content: 'disabled', kaltura_genie_experiences: 'disabled',
      screen_share_analysis: 'disabled',
    },
  }, admin);
  intellectId = intel.id;
  record('intellect-create', true, { intellectId });

  const askCounter = 'What does the counter section say? Answer with just the value, or EMPTY.';

  // A: seed counter=41 AND visitor_tier=platinum (tier is never in a prompt).
  const a = await kaltura.converseOnce(intellectId, askCounter, { request_vars: { counter: '41', visitor_tier: 'platinum' } });
  const threadId = a.threadId;
  check('A-turn1-counter-renders', /41/.test(a.text), { text: snippet(a.text), threadId });

  // B: SAME thread, NO vars — persistence.
  const b = await kaltura.converseOnce(intellectId, askCounter, { threadId });
  check('B-persists-across-turns', /41/.test(b.text) && !/EMPTY/i.test(b.text), { text: snippet(b.text) });

  // C: update counter only — merge keeps visitor_tier.
  const c = await kaltura.converseOnce(intellectId, askCounter, { threadId, request_vars: { counter: '55' } });
  check('C-merge-updates-counter', /55/.test(c.text), { text: snippet(c.text) });

  // D: api tool interpolates BOTH persisted vars, with NO vars on this turn.
  const d = await kaltura.converseOnce(intellectId,
    'Please check the server echo and tell me exactly what received_tier and received_counter it returned.', { threadId });
  check('D-tool-interpolates-persisted-vars', /platinum/.test(d.text) && /55/.test(d.text), {
    text: snippet(d.text), toolCalls: (d.toolCalls ?? []).map((t) => t?.name ?? t?.tool_name).filter(Boolean),
  });

  // E: sys__* injection — ks present AND the echoed thread id is THIS thread's.
  const e = await kaltura.converseOnce(intellectId,
    'Please check the system variables and tell me the ks_state and echo_thread values verbatim.', { threadId });
  check('E-sys-vars-injected', /present/i.test(e.text) && e.text.includes(threadId), { text: snippet(e.text) });

  // F: ~32 KB page_context through the PAGE_CONTEXT_PROMPT block — the exact
  // channel setDynamicPrompt(data) uses (page_context request variable).
  const pageContext = buildLargePageContext();
  const f = await kaltura.converseOnce(intellectId,
    `According to the live page context, what is the status of item ${NEEDLE_ID}? Reply with just the status value.`,
    { threadId, request_vars: { page_context: pageContext } });
  check('F-large-page-context-needle', f.text.includes(NEEDLE_STATUS), {
    bytes: pageContext.length, needle: NEEDLE_STATUS, text: snippet(f.text),
  });

  // G: fresh thread — everything gone (per-thread scope).
  const g = await kaltura.converseOnce(intellectId, askCounter, {});
  check('G-fresh-thread-empty', /EMPTY/i.test(g.text) && !/41|55/.test(g.text), { text: snippet(g.text), threadId: g.threadId });
} catch (err) {
  failed = true;
  record('live-verify-request-vars', false, { message: err?.detail || err?.message || String(err), code: err?.code });
} finally {
  if (intellectId) {
    try {
      await kaltura.intellects.delete(intellectId, admin, { confirmPermanent: true });
      record('intellect-delete', true, { intellectId });
    } catch (err) {
      failed = true;
      record('intellect-delete', false, { intellectId, message: err?.detail || err?.message || String(err) });
    }
  }
  for (const toolId of toolIds) {
    try {
      await kaltura.tools.delete(toolId, admin, { confirmPermanent: true });
      record('tool-delete', true, { toolId });
    } catch {
      // Tool may still be referenced moments after the intellect delete — force it.
      try {
        await kaltura.tools.delete(toolId, admin, { confirmPermanent: true, force: true });
        record('tool-delete', true, { toolId, forced: true });
      } catch (err2) {
        failed = true;
        record('tool-delete', false, { toolId, message: err2?.detail || err2?.message || String(err2) });
      }
    }
  }
}

artifact.finishedAt = new Date().toISOString();
artifact.ok = !failed;

mkdirSync(resolve(__dirname, '../live-verify-artifacts'), { recursive: true });
const outPath = resolve(__dirname, `../live-verify-artifacts/${runId}.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written: ${outPath}`);

process.exit(failed ? 1 : 0);
