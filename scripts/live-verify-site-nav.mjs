#!/usr/bin/env node
/**
 * Live site-navigation verification — real Kaltura API, no fakes.
 *
 * Proves the `go_to` contract that `src/management/site-nav.js` and
 * `src/core/site-keys.js` document, end to end on the HTTP transport:
 *
 *   1  `goToTool()` round-trips: the stored tool echoes `type:"client"`,
 *      `wait_for_response:false`, both args with the right `required` flags
 *      and the exact description the SDK wrote.
 *   2  `tools.update(id, {config})` with the same config keeps the tool id
 *      (the idempotent redeploy path every consumer of this pattern relies on).
 *   3  An intellect built from `siteMapPrompt()`, `SITE_NAV_RULES_PROMPT` and
 *      `PAGE_CONTEXT_PROMPT` echoes every prompt block, SITE MAP byte-for-byte.
 *   4  A mapped ask ("take me to X") streams exactly one `go_to` segment whose
 *      `path` resolves through `resolvePath()` and whose `section`, when
 *      present, resolves through `resolveSection()`; the backend synthesizes
 *      the `tool_response` itself (no client ACK on a fire-and-forget tool).
 *   5  An ask about a topic the SITE MAP does not cover streams zero `go_to`
 *      segments (rule 2 of `SITE_NAV_RULES_PROMPT`).
 *
 * The SITE MAP is built offline from `test/fixtures/site-headings.json` (a
 * snapshot of the docs site's h2/h3 headings) with `buildSectionsManifest()`,
 * so this run needs no built site. `page_context` is sent as a JSON string,
 * exactly what `session.setDynamicPrompt()` produces.
 *
 * Steps 4 and 5 assert model behaviour. Each is given up to two fresh-thread
 * attempts and passes if one attempt passes; both attempts are recorded.
 *
 * Throwaway resources only (one intellect + one client tool), full cleanup in
 * `finally`. Credentials: AGENTIC_PARTNER_ID / AGENTIC_ADMIN_SECRET, from the
 * environment or a .env file in the repo root.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Management,
  PAGE_CONTEXT_PROMPT,
  SITE_NAV_RULES_PROMPT,
  SITE_NAV_TOOL_NAME,
  buildSectionsManifest,
  estimateTokens,
  goToTool,
  resolvePath,
  resolveSection,
  siteMapPrompt,
  validateSectionsManifest,
} from '../src/management/index.js';
import { parseToolCall } from '../src/core/stream.js';

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
const runId = `ci-live-verify-site-nav-${Date.now()}`;
const RUN_TAG = `sn${Date.now().toString(36)}`;
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

/** Thrown to end the run early without failing it; see the `go_to` clash check. */
class SkipRun extends Error {}

const snippet = (text) => JSON.stringify(text ?? '').slice(0, 160);
const TURN_TIMEOUT_MS = 90_000;
const ATTEMPTS = 2;

// SITE MAP from the fixture snapshot, through the same builder a site build uses.
const headings = JSON.parse(readFileSync(resolve(__dirname, '../test/fixtures/site-headings.json'), 'utf8'));
const manifest = validateSectionsManifest(JSON.parse(JSON.stringify(buildSectionsManifest(headings))));
const mapPrompt = siteMapPrompt(manifest, { warn: (m) => console.warn(`[warn] ${m}`) });
const homePage = resolvePath(manifest, '/');
const pageContext = JSON.stringify({ url: '/', sections: homePage ? homePage.sections.map((s) => s.key) : [] });

const SITE_LABEL = 'the Kaltura Intelligent Agents SDK docs';
const DISPLAY_NAME = `Go to (${RUN_TAG})`;
const toolConfig = () => goToTool({ siteLabel: SITE_LABEL, displayName: DISPLAY_NAME });

const prompts = [
  {
    key: 'identity', label: 'identity', headerTemplate: 'Who you are:', type: 'custom',
    value: `You are the assistant for the Kaltura Intelligent Agents SDK docs site. Temporary CI instance ${RUN_TAG}.`,
  },
  mapPrompt,
  SITE_NAV_RULES_PROMPT,
  PAGE_CONTEXT_PROMPT,
];

const kaltura = new Management({ partnerId, adminSecret });
let admin;
let toolId;
let intellectId;

/** One fresh-thread turn: every raw `go_to` segment, text, and tool_response count. */
async function turn(userMessage) {
  const token = await kaltura.sessions.createConversationToken({ configId: intellectId, ttlSeconds: 600 });
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), TURN_TIMEOUT_MS);
  const out = { calls: [], toolResponses: 0, text: '', error: null };
  try {
    const stream = kaltura.conversations.stream({ userMessage, request_vars: { page_context: pageContext }, signal: ac.signal }, token);
    for await (const seg of stream) {
      if (seg.type === 'tool') {
        const call = parseToolCall(seg);
        out.calls.push({ name: call?.name, args: call?.args ?? null });
      } else if (seg.type === 'tool_response') out.toolResponses += 1;
      else if (seg.type === 'text') out.text += seg.content || '';
      else if (seg.type === 'error') out.error = JSON.stringify(seg).slice(0, 200);
    }
  } catch (err) {
    out.error = err?.detail || err?.message || String(err);
  } finally {
    clearTimeout(killer);
  }
  return out;
}

/** Run `userMessage` up to ATTEMPTS times on fresh threads; stop at the first attempt `passes` accepts. */
async function attemptTurn(userMessage, passes) {
  const attempts = [];
  for (let i = 0; i < ATTEMPTS; i += 1) {
    const out = await turn(userMessage);
    const summary = { ...out, text: snippet(out.text) };
    const ok = passes(out);
    attempts.push({ ...summary, ok });
    if (ok) return { ok: true, attempts };
  }
  return { ok: false, attempts };
}

function resolveCall(call) {
  const page = resolvePath(manifest, call.args?.path);
  const section = call.args?.section == null ? undefined : resolveSection(page, call.args.section);
  return {
    path: page?.path ?? null,
    section: section === undefined ? null : (section ? `${section.section.id} (by ${section.by})` : 'UNRESOLVED'),
  };
}

const isGoTo = (c) => c.name === SITE_NAV_TOOL_NAME;
/** Exactly one go_to, path resolves, section (if any) resolves, backend synthesized the tool_response. */
function navPasses(out) {
  const calls = out.calls.filter(isGoTo);
  if (out.error || calls.length !== 1 || out.toolResponses < 1) return false;
  const r = resolveCall(calls[0]);
  return r.path !== null && r.section !== 'UNRESOLVED';
}
const noNavPasses = (out) => !out.error && out.calls.filter(isGoTo).length === 0;

try {
  admin = await kaltura.sessions.createAdminToken();
  record('admin-token-mint', true, { secondsRemaining: admin.secondsRemaining() });

  record('site-map-built', true, {
    pages: manifest.pages.length,
    sections: manifest.pages.reduce((n, p) => n + p.sections.length, 0),
    estimatedTokens: estimateTokens(mapPrompt.value),
  });

  // Tool names are unique per partner (`tool/add` returns 409 on a duplicate), so
  // a partner that already runs a real `go_to` tool (a live docs assistant, for
  // example) cannot host this run's throwaway one. Leave the real tool alone and
  // skip: the run is only meaningful on a partner without a live go_to deployment.
  const existing = await kaltura.tools.list(admin).all();
  const clash = existing.find((t) => t.name === SITE_NAV_TOOL_NAME);
  if (clash) {
    throw new SkipRun(`a live ${SITE_NAV_TOOL_NAME} tool (id ${clash.id}) already exists on this partner; tool names are unique per partner, so this run is skipped and the existing tool is left untouched. Point AGENTIC_PARTNER_ID at a partner without a live ${SITE_NAV_TOOL_NAME} deployment to run it.`);
  }

  // 1. wire-shape round trip
  const cfg = toolConfig();
  const created = await kaltura.tools.add(cfg, admin);
  toolId = created.id;
  record('tool-create', true, { toolId, name: SITE_NAV_TOOL_NAME });

  const echoed = await kaltura.tools.get(toolId, admin);
  const ec = echoed.config || {};
  check('1-tool-echo-shape',
    echoed.name === SITE_NAV_TOOL_NAME && ec.type === 'client' && ec.wait_for_response === false
      && ec.args?.path?.required === true && ec.args?.section?.required === false
      && ec.description === cfg.description && ec.display_name === DISPLAY_NAME,
    {
      name: echoed.name, type: ec.type, wait_for_response: ec.wait_for_response, timeout: ec.timeout,
      argNames: Object.keys(ec.args || {}), pathRequired: ec.args?.path?.required, sectionRequired: ec.args?.section?.required,
      descriptionMatches: ec.description === cfg.description, display_name: ec.display_name,
    });

  // 2. idempotent update keeps the id
  const updated = await kaltura.tools.update(toolId, { config: toolConfig() }, admin);
  const after = await kaltura.tools.get(toolId, admin);
  check('2-update-keeps-id', (updated?.id ?? toolId) === toolId && after.config?.wait_for_response === false, {
    toolId, updatedId: updated?.id ?? null, wait_for_response: after.config?.wait_for_response,
  });

  // 3. intellect with the SDK prompt blocks
  const intel = await kaltura.intellects.create({
    type: 'internal',
    status: 2,
    allow_client_variables: true,   // required for request_vars.page_context to render
    tool_ids: [toolId],
    prompts,
    base_directive: 'Answer briefly and plainly.',
    capabilities: {
      avatar: 'off', avatar_filler: 'off', use_knowledge_base: 'off',
      use_content_search: 'disabled', use_get_entry_content: 'disabled',
      use_related_files: 'disabled', use_web_search: 'disabled',
      generate_followup_questions: 'disabled', include_sources: 'disabled',
      video_gallery: 'disabled', external_video: 'disabled', show_link: 'disabled',
      avatar_show_content: 'disabled', kaltura_genie_experiences: 'off',
      screen_share_analysis: 'disabled',
    },
  }, admin);
  intellectId = intel.configId;
  record('intellect-create', true, { intellectId });

  const full = await kaltura.intellects.get(intellectId, admin);
  const echoedKeys = (full.prompts || []).map((p) => p.key);
  const siteMapIntact = (full.prompts || []).find((p) => p.key === mapPrompt.key)?.value === mapPrompt.value;
  check('3-prompts-echoed', siteMapIntact && prompts.every((p) => echoedKeys.includes(p.key)), { echoedKeys, siteMapIntact });

  // 4. mapped asks → exactly one go_to that resolves
  const navAsks = [
    'Take me to the GenUI reference.',
    'Show me the troubleshooting part of the pause-resume guide.',
  ];
  for (const [i, ask] of navAsks.entries()) {
    const res = await attemptTurn(ask, navPasses);
    check(`4${'ab'[i]}-mapped-ask-one-go-to`, res.ok, {
      ask,
      attempts: res.attempts.map((a) => ({
        ok: a.ok, error: a.error, toolResponses: a.toolResponses,
        calls: a.calls.map((c) => ({ name: c.name, args: c.args, resolved: isGoTo(c) ? resolveCall(c) : null })),
        text: a.text,
      })),
    });
  }

  // 5. unmapped ask → zero go_to
  const nfAsk = 'Take me to the pricing page.';
  const nf = await attemptTurn(nfAsk, noNavPasses);
  check('5-unmapped-ask-zero-go-to', nf.ok, {
    ask: nfAsk,
    attempts: nf.attempts.map((a) => ({ ok: a.ok, error: a.error, calls: a.calls, text: a.text })),
  });
} catch (err) {
  if (err instanceof SkipRun) {
    artifact.skipped = true;
    record('live-verify-site-nav', true, { skipped: true, message: err.message });
  } else {
    failed = true;
    record('live-verify-site-nav', false, { message: err?.detail || err?.message || String(err), code: err?.code });
  }
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
  if (toolId) {
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
  if (admin && (toolId || intellectId)) {
    const leftovers = [];
    if (toolId) { try { await kaltura.tools.get(toolId, admin); leftovers.push(`tool:${toolId}`); } catch { /* gone */ } }
    if (intellectId) { try { await kaltura.intellects.get(intellectId, admin); leftovers.push(`intellect:${intellectId}`); } catch { /* gone */ } }
    check('cleanup-leftovers-empty', leftovers.length === 0, { leftovers });
  }
}

artifact.finishedAt = new Date().toISOString();
artifact.ok = !failed;

mkdirSync(resolve(__dirname, '../live-verify-artifacts'), { recursive: true });
const outPath = resolve(__dirname, `../live-verify-artifacts/${runId}.json`);
writeFileSync(outPath, JSON.stringify(artifact, null, 2));
console.log(`Artifact written: ${outPath}`);

process.exit(failed ? 1 : 0);
