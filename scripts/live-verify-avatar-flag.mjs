#!/usr/bin/env node
/**
 * Live verification that `sys__avatar_enabled` is TRUE in an avatar session and
 * FALSE in a plain conversation, for each place a `condition` can sit.
 *
 * Provisions a throwaway agent, then for each scenario puts ONE gated item on
 * its intellect and asks the same question twice: in a browser avatar session
 * and in a plain `converseOnce`. The gated item asks for a marker token, so the
 * marker in the reply shows the condition was true. A plain reply must still be
 * non-empty, so a missing marker means "false", not "the turn broke".
 *
 * | id | gated item and condition                                   | avatar session   | plain conversation |
 * |----|------------------------------------------------------------|------------------|--------------------|
 * | A1 | prompt block, `sys__avatar_enabled`                        | marker           | no marker          |
 * | A2 | prompt block, `... and not sys__avatar_share_screen_enabled` | marker         | no marker          |
 * | A3 | skill, `sys__avatar_enabled`                               | marker           | no marker          |
 *
 * Not covered:
 * - A tool condition in an avatar session. The avatar stream shows no tool event,
 *   so a call cannot be told from a skipped one. live-verify-authoring.mjs checks
 *   tool conditions in plain conversations only.
 * - `sys__avatar_share_screen_enabled` being TRUE. It needs a live screen-share
 *   capture, which a headless run cannot start. A2 shows it is false in an avatar
 *   session that is not sharing.
 *
 * Usage
 *   node scripts/live-verify-avatar-flag.mjs                        # --env prod, AGENTIC_* vars
 *   node scripts/live-verify-avatar-flag.mjs --env nvq2 --only A1,A3
 *   flags: --only IDS --browser chromium|chrome|firefox|webkit --headed --out DIR --keep
 *          --agent-json PATH --dump-events
 *
 * A model-dependent check retries once. Artifacts: see live-verify-opening-phrase.mjs.
 */
import {
  bootstrap, Report, mdTable, management, ensureAgent, verifyDeleted, mintPageInit, startServer,
  browserChoice, launchBrowser, contextOptions, openHarness, whepSummary, netProblems, waitFor, find, all, isOpeningSpeechId, sleep,
} from './live-verify-kickoff-shared.mjs';
import { callHook } from './live-verify-hooks-shared.mjs';

const { args, target, runId, outDir } = bootstrap(process.argv.slice(2), 'avatar-flag');
const ONLY = typeof args.only === 'string' ? new Set(args.only.split(',').map((s) => s.trim().toUpperCase())) : null;
const REPLY_TIMEOUT = 60_000;
const choice = browserChoice(args);
const HEADED = choice.headed || choice.browser === 'chrome';
const SETUP = `${choice.browser} ${HEADED ? 'headed' : 'headless'}`;
const TAG = Date.now().toString(36);
const MARK = `AVFLAG${TAG.toUpperCase()}`;

const report = new Report({ runId, target: target.name, browser: choice.browser, headed: HEADED });
report.data.scenarios = [];
const kaltura = management(target);
const admin = await kaltura.sessions.createAdminToken({ userId: 'sdk-live-verify' });
const agent = await ensureAgent(kaltura, admin.ks, {
  agentJson: typeof args['agent-json'] === 'string' ? args['agent-json'] : undefined,
  keep: !!args.keep,
  openingPhrase: 'Hello there.',
});
if (agent.reused) await kaltura.intellectConfig.setOpeningPhrase(agent.configId, 'Hello there.', admin.ks);
report.note('agent', agent.reused ? 'reused --agent-json ids' : 'provisioned throwaway agent');

const { server, origin } = await startServer(() => mintPageInit(kaltura, agent, target.genieUrl));
const browser = await launchBrowser(choice);
report.note('setup', SETUP);

const made = { skills: [] };
const ev = (/** @type {import('playwright').Page} */ page, /** @type {string} */ fn, /** @type {any} */ arg) => callHook(page, fn, arg);
const hasMark = (/** @type {string} */ text, mark = MARK) => text.replace(/\s+/g, '').includes(mark);
const baseRules = (value) => ({ key: 'rules', label: 'Rules', headerTemplate: 'Rules:', type: 'custom', value });
const markBlock = (condition) => ({ key: 'gate', label: 'g', headerTemplate: 'Gate rule:', type: 'custom', value: `End every reply with the token ${MARK}.`, condition });

/** Put exactly these prompts and skills on the agent's intellect. */
async function configure({ prompts, skillIds = [] }) {
  await kaltura.intellects.setPrompts(agent.configId, prompts, admin.ks, { lint: false });
  await kaltura.intellectConfig.setSkillIds(agent.configId, skillIds, admin.ks);
}

/** Connect an avatar session and wait for the opening turn to end. */
async function connectAvatar(/** @type {import('playwright').BrowserContext} */ context, sink, id) {
  const page = await openHarness(context, origin, { mode: 'agent-avatar' }, sink);
  const connect = await ev(page, 'testConnect');
  report.check(`${id}: avatar connect() resolved`, connect.ok, connect.ok ? undefined : connect);
  if (!connect.ok) throw new Error(`connect failed: ${connect.code} ${connect.message}`);
  await waitFor(page, (e) => find(e, 'socket:in', { where: (d) => d.ev === 'stvFinishedTalking' }), REPLY_TIMEOUT, 'end of the opening turn');
  return page;
}

/** Send one text turn in the avatar session and return the spoken reply text. */
async function avatarTurn(/** @type {import('playwright').Page} */ page, /** @type {string} */ text) {
  const from = await page.evaluate(() => /** @type {any} */ (globalThis).__events.length);
  await ev(page, 'testSendText', text);
  await waitFor(page, (e) => {
    const c = find(e, 'speechChunk', { from, where: (d) => !isOpeningSpeechId(d?.speechId) && typeof d?.text === 'string' });
    return c && find(e, 'avatarStopTalking', { from: c.index });
  }, REPLY_TIMEOUT, `end of the reply to "${text}"`);
  await sleep(500);
  const evs = await page.evaluate(() => /** @type {any} */ (globalThis).__events.slice());
  return all(evs.slice(from), 'speechChunk', (d) => !isOpeningSpeechId(d?.speechId) && typeof d?.text === 'string').map((e) => e.detail.text).join('').replace(/\s+/g, ' ').trim();
}

/**
 * Run `turns` (messages sent in order on one thread) in the avatar session, then in a plain
 * conversation. Returns the last reply of each. The avatar side retries once on a missing marker.
 */
async function bothSides({ context, sink, id, turns, mark = MARK }) {
  const page = await connectAvatar(context, sink, id);
  let avatar = '';
  for (let attempt = 0; attempt < 2 && !hasMark(avatar, mark); attempt++) for (const t of turns) avatar = await avatarTurn(page, t);
  await ev(page, 'testDisconnect').catch(() => {});
  const conv = await kaltura.sessions.createConversationToken({ configId: agent.configId });
  let threadId;
  let plain = { text: '' };
  for (const t of turns) {
    plain = await kaltura.converseOnce(agent.configId, t, { threadId }, conv);
    threadId = plain.threadId;
  }
  report.check(`${id}: avatar session reply carries the marker`, hasMark(avatar, mark), { reply: avatar.slice(0, 120) });
  report.check(`${id}: plain conversation reply is non-empty`, (plain.text ?? '').trim() !== '', { reply: (plain.text ?? '').slice(0, 120) });
  report.check(`${id}: plain conversation reply has no marker`, !hasMark(plain.text ?? '', mark), { reply: (plain.text ?? '').slice(0, 120) });
}

const SCENARIOS = {
  A1: {
    name: 'prompt block gated on sys__avatar_enabled',
    async run(ctx) {
      await configure({ prompts: [baseRules('Be terse.'), markBlock('sys__avatar_enabled')] });
      await bothSides({ ...ctx, turns: ['Say hi.'] });
    },
  },
  A2: {
    name: 'prompt block gated on sys__avatar_enabled and not sys__avatar_share_screen_enabled',
    async run(ctx) {
      await configure({ prompts: [baseRules('Be terse.'), markBlock('sys__avatar_enabled and not sys__avatar_share_screen_enabled')] });
      await bothSides({ ...ctx, turns: ['Say hi.'] });
    },
  },
  A3: {
    name: 'skill gated on sys__avatar_enabled',
    async run(ctx) {
      const skill = await kaltura.skills.add({
        name: `live-verify-avatar-flag-${TAG}`, description: 'Scratch skill for scripts/live-verify-avatar-flag.mjs',
        instructions: `If the user message contains the word PING, reply with exactly the single token ${MARK} and nothing else.`,
      }, admin.ks);
      made.skills.push(skill.id);
      await configure({ prompts: [baseRules('Be terse. If the user message contains PING and no skill applies, reply PONG.')], skillIds: [{ id: skill.id, mode: 'preloaded', condition: 'sys__avatar_enabled' }] });
      await bothSides({ ...ctx, turns: ['PING'] });
    },
  },
};

try {
  for (const [id, sc] of Object.entries(SCENARIOS)) {
    if (ONLY && !ONLY.has(id)) continue;
    console.log(`\n== ${id}: ${sc.name}`);
    const t0 = Date.now();
    const sink = { pageErrors: [], pages: [], network: [] };
    const context = await browser.newContext(contextOptions());
    const before = report.checks.length;
    let error = null;
    try {
      await sc.run({ context, sink, id });
    } catch (err) {
      error = String(/** @type {any} */ (err)?.message || err);
      report.check(`${id}: completed`, false, { error, pageErrors: sink.pageErrors.slice(0, 5) });
    } finally {
      await sleep(300);
      const whep = whepSummary(sink.network);
      const whepBad = whep.filter((l) => /^POST .*(FAILED|→ [45]\d\d)/.test(l));
      if (whep.length) report.check(`${id}: every WHEP POST succeeded`, whepBad.length === 0, { whep });
      const problems = netProblems(sink.network);
      if (problems.length) report.note(`${id}: HTTP requests that failed or returned 4xx/5xx`, problems.slice(0, 10));
      const own = report.checks.slice(before);
      report.data.scenarios.push({ id, name: sc.name, ok: own.every((c) => c.ok), checks: own.length, ms: Date.now() - t0, error, whep });
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
  await kaltura.intellectConfig.setSkillIds(agent.configId, [], admin.ks).catch(() => {});
  for (const id of made.skills) await kaltura.skills.delete(id, admin.ks, { confirmPermanent: true }).catch((e) => report.check('cleanup: skill deleted', false, { id, message: e?.detail || e?.message }));
  await agent.cleanup();
  if (!agent.reused && !args.keep) {
    const gone = await verifyDeleted(kaltura, admin.ks, agent);
    report.check('cleanup: agent, avatar and intellect deleted', Object.values(gone).every((s) => s === 'deleted'), gone);
  }
}

const md = [
  `# avatar-flag scenarios — ${target.name} — ${report.meta.startedAt}`,
  '',
  `${SETUP}, one fresh browser context per scenario.`,
  '',
  mdTable(['id', 'scenario', 'result', 'checks', 'ms', 'error'], report.data.scenarios.map((s) => [s.id, s.name, s.ok ? 'ok' : 'FAIL', s.checks, s.ms, s.error ?? ''])),
  '',
  '## Checks',
  '',
  mdTable(['result', 'check', 'detail'], report.checks.map((c) => [c.ok ? 'ok' : 'FAIL', c.name, c.detail === undefined ? '' : JSON.stringify(c.detail)])),
  '',
].join('\n');
report.write(outDir, md);
const failed = report.data.scenarios.filter((s) => !s.ok).map((s) => s.id);
console.log(`\n${report.data.scenarios.length} scenarios, ${failed.length ? `FAILED: ${failed.join(', ')}` : 'all ok'}`);
process.exit(report.failed ? 1 : 0);
