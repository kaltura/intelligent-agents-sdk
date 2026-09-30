#!/usr/bin/env node
/**
 * Live MCP verification — real Kaltura backend, real MCP server, no mocks.
 *
 * Wires the reference server at `examples/mcp-live-showcase/server.mjs`
 * (exposed over a public HTTPS URL) into throwaway intellects and proves
 * every documented `mcp_servers` behavior end to end, against a live
 * environment (QA or production, selected with --target):
 *
 *   1  basic tool call            — echo, no auth
 *   2  shared static auth         — {{secrets.X}} header, whoami echoes it back
 *   3  per-attendee auth (text)   — two concurrent sessions, two different
 *                                    {{ATTENDEE_TOKEN}}/{{ATTENDEE_ID}} request vars
 *   4  per-attendee auth (avatar) — same as 3, force_experience:'avatar_only'
 *   5  allowedTools               — pre-exposure restriction, config-level
 *   6  two servers, same tool     — no collision at the config level
 *   7  unreachable server         — write succeeds, conversation still completes
 *   8  slow tool, client timeout  — AbortSignal wraps a 20s tool in a 4s ceiling
 *   9  OAuth consent flow         — oauth_required interruption, auto-approved
 *                                    consent, authenticated call — text + avatar
 *   10 external real-world server — a pre-existing, independently-run public
 *                                    MCP server (not part of this repo), no auth
 *   11 stateful tool               — counter increments correctly across two
 *                                    sequential calls in the same thread
 *   12 tool-level failure          — a tool reporting isError:true doesn't
 *                                    break the turn; the model sees and
 *                                    reports the failure
 *

 * Two phases, split so a failed verify never destroys the provisioned
 * intellects (a retryable failure would otherwise force a full re-provision).
 * Scenarios 5/6/7 only read config (`describe()`), so they run and assert
 * immediately in the provision phase; 1/2/3/4/8/9/11/12 need the model to
 * actually call a tool, so they run in the verify phase:
 *
 *   MCP_PUBLIC_URL=https://<tunnel-host> node scripts/live-verify-mcp.mjs --target=nvq2 --phase=provision
 *   MCP_PUBLIC_URL=https://<tunnel-host> node scripts/live-verify-mcp.mjs --target=nvq2 --phase=verify
 *   MCP_PUBLIC_URL=https://<tunnel-host> node scripts/live-verify-mcp.mjs --target=nvq2 --phase=cleanup
 *
 * `--phase=all` runs all three back to back and is the default if --phase is
 * omitted. Tool names the model calls are namespaced `<serverKey>__<toolName>`
 * (see docs/MCP-INTEGRATIONS.md, "Multiple servers, no collision risk") — the
 * rules prompts below use the namespaced form.
 *
 * Credentials: your .env (two levels up from this file, not the repo-root
 * .env) holds QA and production prefixed vars. --target selects the
 * prefix; Management is constructed with explicit agenticUrl/genieUrl/ovpUrl
 * overrides, since the defaults are production.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../src/management/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const artifactsDir = resolve(__dirname, '../live-verify-artifacts');

try {
  const env = readFileSync(resolve(__dirname, '../../.env'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch {
  // No .env file: credentials must already be in the environment.
}

const argValue = (flag, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : fallback;
};

const TARGET = argValue('--target', process.env.LIVE_VERIFY_TARGET || 'nvq2').toLowerCase();
const PREFIX = TARGET === 'nvp1' ? 'NVP1' : 'NVQ2';
const PHASE = argValue('--phase', 'all');
const MCP_BASE = argValue('--mcp-url', process.env.MCP_PUBLIC_URL || '').replace(/\/$/, '');
const statePath = resolve(artifactsDir, `state-${TARGET}.json`);

const partnerId = process.env[`${PREFIX}_AGENTIC_PARTNER_ID`] || process.env[`${PREFIX}_PARTNER_ID_1`];
const adminSecret = process.env[`${PREFIX}_AGENTIC_ADMIN_SECRET`] || process.env[`${PREFIX}_ADMIN_SECRET_1`];
const agenticUrl = process.env[`${PREFIX}_AGENTIC_API_URL`];
const genieUrl = process.env[`${PREFIX}_GENIE_URL`];
const ovpUrl = process.env[`${PREFIX}_KALTURA_API_ENDPOINT`];

if (!partnerId || !adminSecret || !agenticUrl || !genieUrl || !ovpUrl) {
  console.error(`Missing ${PREFIX}_* credentials/URLs (env or your .env two levels up).`);
  process.exit(1);
}
if (PHASE !== 'verify' && !MCP_BASE) {
  console.error('MCP_PUBLIC_URL (or --mcp-url=) is required — the public HTTPS URL for examples/mcp-live-showcase/server.mjs.');
  process.exit(1);
}

const results = [];
let failed = false;
function record(step, ok, detail) {
  results.push({ step, ok, detail, at: new Date().toISOString() });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${step}${detail ? ` — ${JSON.stringify(detail)}` : ''}`);
}
function check(step, ok, detail) {
  if (!ok) failed = true;
  record(step, ok, detail);
}

const snippet = (text) => JSON.stringify(text ?? '').slice(0, 220);
const field = (text, name) => {
  const m = new RegExp(`${name}=(\\S+)`).exec(text || '');
  return m ? m[1] : null;
};

const CAPABILITIES = {
  avatar: 'on', avatar_filler: 'off', use_knowledge_base: 'off',
  use_content_search: 'disabled', use_get_entry_content: 'disabled',
  use_related_files: 'disabled', use_web_search: 'disabled',
  generate_followup_questions: 'disabled', include_sources: 'disabled',
  video_gallery: 'disabled', external_video: 'disabled', show_link: 'disabled',
  avatar_show_content: 'disabled', kaltura_genie_experiences: 'disabled',
  screen_share_analysis: 'disabled',
};
const namePrompt = (label) => ({ key: 'name', label: 'name', headerTemplate: 'Your name is:', type: 'custom', value: label });
const rulesPrompt = (lines) => ({ key: 'rules', label: 'rules', headerTemplate: 'Rules you must obey without exception:', type: 'custom', value: lines.join('\n') });

const WHOAMI_RULE = (server) => `When asked to check who you are, call the ${server}__whoami tool, then reply with EXACTLY: CLIENTID=<authenticatedClientId value, or NONE if null> ATTENDEE=<attendeeId value, or NONE if null> AUTHTAIL=<authorizationTail value, or NONE if null> and nothing else, no other words.`;
const ECHO_RULE = (server) => `When asked to echo some text, call the ${server}__echo tool with that text as the "text" argument, then reply with EXACTLY: ECHO=<the text value the tool returned> and nothing else.`;
const SLOW_RULE = (server) => `When asked to run a slow operation, call the ${server}__slow_op tool with ms=20000, then reply with EXACTLY: SLOWMS=<sleptMs value the tool returned> and nothing else.`;
const COUNTER_RULE = (server) => `When asked to increment the counter, call the ${server}__counter tool, then reply with EXACTLY: COUNT=<count value the tool returned> and nothing else.`;
const FLAKY_RULE = (server) => `When asked to run the flaky operation, call the ${server}__flaky_op tool. Whether it succeeds or reports a failure, reply with EXACTLY: FLAKYRESULT=<OK if the tool succeeded, or FAILED if the tool reported a failure> and nothing else.`;
const DEEPWIKI_RULE = (server) => `When asked about a GitHub repo's documentation structure, call the ${server}__read_wiki_structure tool with repoName="expressjs/express", then reply with EXACTLY: STRUCTURE_OK=<the tool's returned text, verbatim, up to 400 characters> and nothing else.`;
const EXTERNAL_MCP_URL = 'https://mcp.deepwiki.com/mcp';

const kaltura = new Management({ partnerId, adminSecret, agenticUrl, genieUrl, ovpUrl });

async function runProvision() {
  const OPEN_URL = `${MCP_BASE}/mcp`;
  const OAUTH_URL = `${MCP_BASE}/mcp/oauth`;
  const RUN_TAG = `mcp${Date.now().toString(36)}`;
  const admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
  record('admin-token-mint-provision', true, { secondsRemaining: admin.secondsRemaining(), target: TARGET });

  const intel = async (prompts) => (await kaltura.intellects.add({ type: 'internal', status: 2, allow_client_variables: true, prompts, capabilities: CAPABILITIES }, admin)).id;

  // ── Scenarios 1, 2, 8: one server, shared-secret header ──
  const SHARED_TOKEN = `shared-${RUN_TAG}-${Math.random().toString(36).slice(2)}`;
  const intellectA = await intel([namePrompt('Live-Verify MCP Probe A'), rulesPrompt([ECHO_RULE('main'), WHOAMI_RULE('main'), SLOW_RULE('main'), COUNTER_RULE('main'), FLAKY_RULE('main')])]);
  await kaltura.intellects.secrets.set(intellectA, { SHARED_TOKEN }, admin);
  await kaltura.intellectConfig.setMcpServers(intellectA, { main: { url: OPEN_URL, headers: { Authorization: 'Bearer {{secrets.SHARED_TOKEN}}' } } }, admin);
  record('intellectA-provisioned', true, { intellectA });

  // ── Scenarios 3, 4: per-attendee headers via bare request-var templating ──
  const intellectB = await intel([namePrompt('Live-Verify MCP Probe B'), rulesPrompt([WHOAMI_RULE('attendee')])]);
  await kaltura.intellectConfig.setMcpServers(intellectB, { attendee: { url: OPEN_URL, headers: { Authorization: 'Bearer {{ATTENDEE_TOKEN}}', 'X-Attendee-Id': '{{ATTENDEE_ID}}' } } }, admin);
  record('intellectB-provisioned', true, { intellectB });

  // ── Scenario 9: OAuth-gated mount ──
  const intellectC = await intel([namePrompt('Live-Verify MCP Probe C'), rulesPrompt([WHOAMI_RULE('secure')])]);
  await kaltura.intellectConfig.setMcpServers(intellectC, { secure: { url: OAUTH_URL } }, admin);
  record('intellectC-provisioned', true, { intellectC });

  // ── Scenarios 5, 6, 7: config-level only — describe() reads current config, not cached ──
  const intellectD = await intel([namePrompt('Live-Verify MCP Probe D')]);
  record('intellectD-provisioned', true, { intellectD });

  await kaltura.intellectConfig.setMcpServers(intellectD, { solo: { url: OPEN_URL, allowedTools: ['echo'] } }, admin);
  const d5 = await kaltura.intellectConfig.describe(intellectD, admin);
  const solo5 = d5.editable?.mcp_servers?.solo;
  check('5-allowed-tools-config', Array.isArray(solo5?.allowedTools) && solo5.allowedTools.length === 1 && solo5.allowedTools[0] === 'echo', { solo: solo5 });

  await kaltura.intellectConfig.setMcpServers(intellectD, { primary: { url: OPEN_URL }, mirror: { url: OPEN_URL } }, admin);
  const d6 = await kaltura.intellectConfig.describe(intellectD, admin);
  const servers6 = d6.editable?.mcp_servers || {};
  check('6-two-servers-no-collision', !!servers6.primary && !!servers6.mirror, { keys: Object.keys(servers6) });

  await kaltura.intellectConfig.setMcpServers(intellectD, { alive: { url: OPEN_URL }, dead: { url: 'http://127.0.0.1:1/mcp' } }, admin);
  const d7 = await kaltura.intellectConfig.describe(intellectD, admin);
  const servers7 = d7.editable?.mcp_servers || {};
  check('7-unreachable-server-write-succeeds', !!servers7.alive && !!servers7.dead, { keys: Object.keys(servers7) });
  const r7 = await kaltura.converseOnce(intellectD, 'Please just say hello, nothing else.', {});
  check('7-unreachable-server-conversation-completes', typeof r7.text === 'string' && r7.text.length > 0, { text: snippet(r7.text) });

  // ── Scenario 10: a real, pre-existing, independently-run public MCP server ──
  const intellectE = await intel([namePrompt('Live-Verify MCP Probe E'), rulesPrompt([DEEPWIKI_RULE('docs')])]);
  await kaltura.intellectConfig.setMcpServers(intellectE, { docs: { url: EXTERNAL_MCP_URL } }, admin);
  record('intellectE-provisioned', true, { intellectE, externalMcpUrl: EXTERNAL_MCP_URL });

  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    target: TARGET, mcpBase: MCP_BASE, runTag: RUN_TAG, sharedToken: SHARED_TOKEN,
    intellectA, intellectB, intellectC, intellectD, intellectE,
    provisionedAt: new Date().toISOString(), provisionResults: results,
  }, null, 2));
  record('provision-state-saved', true, { statePath });
}

async function runVerify() {
  if (!existsSync(statePath)) {
    check('verify-state-missing', false, { statePath, note: 'run --phase=provision first' });
    return;
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  for (const r of state.provisionResults) results.push(r);
  const { intellectA, intellectB, intellectC, intellectE, sharedToken, runTag } = state;
  const admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
  record('admin-token-mint-verify', true, { secondsRemaining: admin.secondsRemaining(), target: TARGET, ageMs: Date.now() - new Date(state.provisionedAt).getTime() });

  try {
    // 1: basic tool call.
    const echoText = `hello-mcp-${runTag}`;
    const r1 = await kaltura.converseOnce(intellectA, `Please echo this exact text: ${echoText}`, {});
    check('1-basic-tool-call', field(r1.text, 'ECHO') === echoText, { text: snippet(r1.text) });

    // 2: shared static secret header — whoami echoes the tail of SHARED_TOKEN.
    const r2 = await kaltura.converseOnce(intellectA, 'Please check who you are.', { threadId: r1.threadId });
    check('2-shared-secret-auth', field(r2.text, 'AUTHTAIL') === sharedToken.slice(-6), { text: snippet(r2.text), expectedTail: sharedToken.slice(-6) });

    // 11: stateful tool — counter increments correctly across two sequential
    // calls in the same thread.
    const r11a = await kaltura.converseOnce(intellectA, 'Please increment the counter.', { threadId: r1.threadId });
    const r11b = await kaltura.converseOnce(intellectA, 'Please increment the counter again.', { threadId: r1.threadId });
    check('11-stateful-tool-counter', field(r11a.text, 'COUNT') === '1' && field(r11b.text, 'COUNT') === '2', {
      first: snippet(r11a.text), second: snippet(r11b.text),
    });

    // 12: a tool reporting isError:true doesn't break the turn — the model
    // sees and reports the failure instead of the conversation erroring out.
    const r12 = await kaltura.converseOnce(intellectA, 'Please run the flaky operation.', { threadId: r1.threadId });
    check('12-tool-error-result-surfaced', field(r12.text, 'FLAKYRESULT') === 'FAILED', { text: snippet(r12.text) });

    // 8: slow tool, client-side timeout — the tool asks for 20s, we give it 4s.
    {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 4000);
      const startedMs = Date.now();
      try {
        await kaltura.converseOnce(intellectA, 'Please run a slow operation.', { signal: ac.signal });
        check('8-slow-tool-client-timeout', false, { note: 'expected an abort, call completed instead' });
      } catch (err) {
        const elapsedMs = Date.now() - startedMs;
        check('8-slow-tool-client-timeout', elapsedMs < 15000, { elapsedMs, name: err?.name, message: err?.message || String(err) });
      } finally {
        clearTimeout(timer);
      }
    }

    // 3/4: per-attendee headers, two concurrent identities, text then avatar-hint.
    async function attendeeCheck(step, tokenSuffix, attendeeId, forceExperience) {
      const token = `attendee-${tokenSuffix}-${Math.random().toString(36).slice(2)}`;
      const opts = { request_vars: { ATTENDEE_TOKEN: token, ATTENDEE_ID: attendeeId } };
      if (forceExperience) opts.force_experience = forceExperience;
      // Each attendee needs its own userId-bound KS — an anonymous KS gives the
      // backend no way to tell two attendees apart, so its per-user tool/header
      // cache collapses them onto the same entry (see docs/MCP-INTEGRATIONS.md
      // § A different credential per attendee).
      const ks = await kaltura.sessions.createConversationToken({ configId: intellectB, userId: attendeeId });
      const res = await kaltura.converseOnce(intellectB, 'Please check who you are.', opts, ks);
      check(step, field(res.text, 'AUTHTAIL') === token.slice(-6) && field(res.text, 'ATTENDEE') === attendeeId, {
        text: snippet(res.text), expectedTail: token.slice(-6), expectedAttendee: attendeeId,
      });
    }
    // Each attendeeId below is used exactly once across the whole run — the
    // backend's per-user tool/header cache can replay a stale header if the
    // same userId is reused for a second call within its TTL, so scenario 4
    // must not reuse scenario 3's attendee ids.
    await Promise.all([
      attendeeCheck('3-per-attendee-auth-text-A', 'txtA', `attendeeA-${runTag}-txt`),
      attendeeCheck('3-per-attendee-auth-text-B', 'txtB', `attendeeB-${runTag}-txt`),
    ]);
    await Promise.all([
      attendeeCheck('4-per-attendee-auth-avatar-A', 'avA', `attendeeA-${runTag}-av`, 'avatar_only'),
      attendeeCheck('4-per-attendee-auth-avatar-B', 'avB', `attendeeB-${runTag}-av`, 'avatar_only'),
    ]);

    // 9: full automated OAuth consent + token exchange + authenticated call — text + avatar.
    async function oauthFlow(step, forceExperience) {
      const opts1 = forceExperience ? { force_experience: forceExperience } : {};
      const first = await kaltura.converseOnce(intellectC, 'Please check who you are.', opts1);
      const threadId = first.threadId;
      let final = first;
      if (first.oauthRequired?.length) {
        const authUrl = first.oauthRequired[0].authUrl;
        // The free trycloudflare.com quick tunnel intermittently drops a direct
        // connection under bursty concurrent load (this call lands after ~10
        // other requests already hit the same tunnel in the preceding seconds).
        // Retry a couple of times before treating it as a real failure.
        let consentRes;
        for (let attempt = 1; ; attempt++) {
          try {
            consentRes = await fetch(authUrl, { redirect: 'follow' }); // nosemgrep: scripts.harness.no-raw-fetch-bypass
            break;
          } catch (err) {
            if (attempt >= 3) throw err;
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
        record(`${step}-consent-fetched`, true, { authUrlHost: new URL(authUrl).host, status: consentRes.status });
        await new Promise((r) => setTimeout(r, 2000));
        const opts2 = { threadId, ...(forceExperience ? { force_experience: forceExperience } : {}) };
        final = await kaltura.converseOnce(intellectC, 'Please check who you are again.', opts2);
      } else {
        record(`${step}-no-consent-needed`, true, { note: 'consent already cached for this scope' });
      }
      const clientId = field(final.text, 'CLIENTID');
      check(step, !!clientId && clientId !== 'NONE' && clientId.startsWith('client_') && !(final.oauthRequired?.length), {
        firstOauthRequired: first.oauthRequired?.length || 0, finalOauthRequired: final.oauthRequired?.length || 0, text: snippet(final.text),
      });
    }
    await oauthFlow('9-oauth-flow-text');
    await oauthFlow('9-oauth-flow-avatar', 'avatar_only');

    // 10: a real, independently-run public MCP server (mcp.deepwiki.com) — not
    // part of this repo, no auth, proves the SDK's mcp_servers wiring against
    // an MCP implementation we don't control.
    const r10 = await kaltura.converseOnce(intellectE, "Please look up expressjs/express's documentation structure.", {});
    check('10-external-real-world-mcp-server', /STRUCTURE_OK=/.test(r10.text) && /express/i.test(r10.text) && r10.text.length > 60, { text: snippet(r10.text) });
  } catch (err) {
    failed = true;
    record('verify-run', false, { message: err?.detail || err?.message || String(err), code: err?.code });
  }
  // Cleanup is a separate explicit --phase=cleanup step (see runCleanup) — a
  // failed verify (e.g. cache not cleared yet) must not destroy the still-good
  // provisioned intellects, or a retryable failure forces a full re-provision
  // and another ~1h wait for nothing.
}

async function runCleanup() {
  if (!existsSync(statePath)) {
    check('cleanup-state-missing', false, { statePath });
    return;
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
  for (const id of [state.intellectA, state.intellectB, state.intellectC, state.intellectD, state.intellectE]) {
    try {
      await kaltura.intellects.delete(id, admin, { confirmPermanent: true });
      record('intellect-delete', true, { id });
    } catch (err) {
      failed = true;
      record('intellect-delete', false, { id, message: err?.detail || err?.message || String(err) });
    }
  }
}

const startedAt = new Date().toISOString();
try {
  if (PHASE === 'provision') await runProvision();
  else if (PHASE === 'verify') await runVerify();
  else if (PHASE === 'cleanup') await runCleanup();
  else { await runProvision(); await runVerify(); await runCleanup(); }
} catch (err) {
  failed = true;
  record('live-verify-mcp', false, { message: err?.detail || err?.message || String(err), code: err?.code });
}

mkdirSync(artifactsDir, { recursive: true });
const runId = `ci-live-verify-mcp-${TARGET}-${PHASE}-${Date.now()}`;
const outPath = resolve(artifactsDir, `${runId}.json`);
writeFileSync(outPath, JSON.stringify({ runId, startedAt, finishedAt: new Date().toISOString(), target: TARGET, phase: PHASE, mcpBase: MCP_BASE, ok: !failed, steps: results }, null, 2));
console.log(`Artifact written: ${outPath}`);

process.exit(failed ? 1 : 0);
