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
 * | A4 | `var` tool, `sys__avatar_enabled`                          | tool called      | tool never called  |
 * | A5 | prompt block, `sys__avatar_share_screen_enabled`           | marker after a share | not run        |
 * | A6 | prompt block, `... and not sys__avatar_share_screen_enabled` | no marker after a share | not run  |
 *
 * A4 reads the saved thread for a `tool` segment, because the avatar stream shows no tool event.
 *
 * A5 and A6 run only with `--share` or `--only`: they wait on a background vision call that sometimes does not land,
 * so they are not part of the default run that CI uses. They enable `screenShare` on the agent, ask PING,
 * simulate a share, then ask again. The page emits `screenShareStarted` on the session socket (the SDK has no public method for it) and sends one still with
 * `sendScreenShot()`. No real screen capture is involved, so they run headless.
 *
 * Usage
 *   node scripts/live-verify-avatar-flag.mjs                        # --env prod, AGENTIC_* vars
 *   node scripts/live-verify-avatar-flag.mjs --env nvq2 --only A1,A3
 *   flags: --only IDS --share --browser chromium|chrome|firefox|webkit --headed --out DIR --keep
 *          --agent-json PATH --dump-events
 *
 * A model-dependent check retries up to 3 times on fresh sessions. Artifacts: see live-verify-opening-phrase.mjs.
 */
import {
  bootstrap, Report, mdTable, management, ensureAgent, verifyDeleted, mintPageInit, startServer,
  browserChoice, launchBrowser, contextOptions, openHarness, whepSummary, netProblems, waitFor, find, all, isOpeningSpeechId, sleep,
} from './live-verify-kickoff-shared.mjs';
import { tools } from '../src/management/tools.js';
import { callHook } from './live-verify-hooks-shared.mjs';

const { args, target, runId, outDir } = bootstrap(process.argv.slice(2), 'avatar-flag');
const ONLY = typeof args.only === 'string' ? new Set(args.only.split(',').map((s) => s.trim().toUpperCase())) : null;
// A5 and A6 depend on a background vision call that sometimes does not land, so they run only on request.
const SHARE_ONLY = new Set(['A5', 'A6']);
const REPLY_TIMEOUT = 60_000;
const choice = browserChoice(args);
const HEADED = choice.headed || choice.browser === 'chrome';
const SETUP = `${choice.browser} ${HEADED ? 'headed' : 'headless'}`;
const TAG = Date.now().toString(36);
// A word the avatar can speak: a made-up token sometimes gets no audio, so no reply to wait for.
const MARK = 'pomegranate';

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

const made = { skills: [], tools: [] };
const ev = (/** @type {import('playwright').Page} */ page, /** @type {string} */ fn, /** @type {any} */ arg) => callHook(page, fn, arg);
const hasMark = (/** @type {string} */ text, mark = MARK) => text.replace(/\s+/g, '').includes(mark);
const baseRules = (value) => ({ key: 'rules', label: 'Rules', headerTemplate: 'Rules:', type: 'custom', value });
const markBlock = (condition) => ({ key: 'gate', label: 'g', headerTemplate: 'Gate rule:', type: 'custom', value: `If the user message contains PING, reply with exactly: Pong, ${MARK}.`, condition });

/** Put exactly these prompts and skills on the agent's intellect. */
async function configure({ prompts, skillIds = [], toolIds = [] }) {
  await kaltura.intellects.setPrompts(agent.configId, prompts, admin.ks, { lint: false });
  await kaltura.intellectConfig.setSkillIds(agent.configId, skillIds, admin.ks);
  await kaltura.intellectConfig.setToolIds(agent.configId, toolIds, admin.ks);
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
 * conversation. Returns the last reply of each. The avatar side makes up to 3 attempts, each on a
 * fresh session, until the marker shows. A turn the avatar never finishes speaking counts as an
 * empty attempt, so a slow video render does not read as a failed condition.
 */
async function bothSides({ context, sink, id, turns, mark = MARK }) {
  let avatar = '';
  for (let attempt = 0; attempt < 3 && !hasMark(avatar, mark); attempt++) {
    const page = await connectAvatar(context, sink, id);
    try {
      for (const t of turns) avatar = await avatarTurn(page, t);
    } catch (err) {
      avatar = '';
      report.note(`${id}: attempt ${attempt + 1} ended early`, String(/** @type {any} */ (err)?.message).slice(0, 160));
    }
    await ev(page, 'testDisconnect').catch(() => {});
  }
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

/**
 * Send `text` in the avatar session and return its reply from the saved thread. The spoken reply
 * does not always finish when screen share is on, so this reads what the server stored instead.
 * `known` is how many replies the thread already holds.
 */
async function savedReply(/** @type {import('playwright').Page} */ page, /** @type {string} */ text, known = 0) {
  await ev(page, 'testSendText', text);
  const threadId = (await ev(page, 'testState'))?.threadId;
  for (let i = 0; threadId && i < 25; i++) {
    await sleep(3000);
    const msgs = await kaltura.messages.list(admin.ks, { threadId }).all();
    const replies = msgs.flatMap((m) => (m.assistant?.messages ?? []).flatMap((x) => x.content ?? [])).filter((seg) => seg.type === 'avatar' && !/^\s*Hello there/.test(String(seg.content))).map((seg) => String(seg.content));
    if (replies.length > known) return replies[known];
  }
  return '';
}

/** Send one still from the page. `start` also emits `screenShareStarted` first. Returns `sent` or an error code. */
function sendStill(/** @type {import('playwright').Page} */ page, /** @type {boolean} */ start) {
  return page.evaluate(async (begin) => {
    const t = /** @type {any} */ (globalThis).session.transport ?? /** @type {any} */ (globalThis).session;
    const c = document.createElement('canvas'); c.width = 640; c.height = 360;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 360); g.fillStyle = '#000'; g.font = '48px sans-serif'; g.fillText('INVOICE 4711', 40, 180);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    if (begin) { t._socket.emit('screenShareStarted', {}); await new Promise((r) => setTimeout(r, 1000)); }
    try { t.sendScreenShot(new Uint8Array(await blob.arrayBuffer())); return 'sent'; } catch (e) { return String(e?.code ?? e?.message); }
  }, start);
}

/**
 * Enable screen share on the agent, then ask PING before and after a share runs in an avatar
 * session. The share is simulated: the page emits `screenShareStarted` on the session socket (the
 * SDK has no public method for it) and sends one still with `sendScreenShot()`. The agent's
 * `screenShare` is restored at the end. Up to 3 attempts, each on a fresh session.
 */
async function sharing({ context, sink, id }, { condition, before, after }) {
  const previous = (await kaltura.agents.get(agent.agentId, admin.ks))?.screenShare ?? { enabled: false };
  await kaltura.agents.update({ agentId: agent.agentId, screenShare: { enabled: true, prompt: 'Describe this screen in one short sentence.' } }, admin.ks);
  try {
    await configure({ prompts: [baseRules('Be terse. If the user message contains PING and no gate rule applies, reply with exactly: Pong.'), markBlock(condition)] });
    let seen = { before: null, after: null };
    for (let attempt = 0; attempt < 3 && !(seen.before === before && seen.after === after); attempt++) {
      const page = await connectAvatar(context, sink, id);
      try {
        const first = await savedReply(page, 'PING');
        const shot = await sendStill(page, true);
        report.check(`${id}: sendScreenShot() accepted once screen share is enabled on the agent`, shot === 'sent', { shot });
        // The still is analysed in the background. Send it again and ask again until the flag changes, up to 4 times.
        let second = '';
        for (let n = 1; n <= 4 && (!second || hasMark(second) !== after); n++) {
          await sleep(5000);
          if (n > 1) await sendStill(page, false);
          second = await savedReply(page, 'PING', n);
        }
        seen = { before: first ? hasMark(first) : null, after: second ? hasMark(second) : null };
        report.note(`${id}: attempt ${attempt + 1}`, { first: first.slice(0, 60), second: second.slice(0, 60) });
      } catch (err) {
        report.note(`${id}: attempt ${attempt + 1} ended early`, String(/** @type {any} */ (err)?.message).slice(0, 160));
      }
      await ev(page, 'testDisconnect').catch(() => {});
    }
    report.check(`${id}: marker ${before ? 'present' : 'absent'} before the share`, seen.before === before, seen);
    report.check(`${id}: marker ${after ? 'present' : 'absent'} after the share`, seen.after === after, seen);
  } finally {
    await kaltura.agents.update({ agentId: agent.agentId, screenShare: previous }, admin.ks).catch((e) => report.check('cleanup: screenShare restored', false, { message: e?.detail || e?.message }));
  }
}

const SCENARIOS = {
  A1: {
    name: 'prompt block gated on sys__avatar_enabled',
    async run(ctx) {
      await configure({ prompts: [baseRules('Be terse. If the user message contains PING and no gate rule applies, reply with exactly: Pong.'), markBlock('sys__avatar_enabled')] });
      await bothSides({ ...ctx, turns: ['PING'] });
    },
  },
  A2: {
    name: 'prompt block gated on sys__avatar_enabled and not sys__avatar_share_screen_enabled',
    async run(ctx) {
      await configure({ prompts: [baseRules('Be terse. If the user message contains PING and no gate rule applies, reply with exactly: Pong.'), markBlock('sys__avatar_enabled and not sys__avatar_share_screen_enabled')] });
      await bothSides({ ...ctx, turns: ['PING'] });
    },
  },
  A3: {
    name: 'skill gated on sys__avatar_enabled',
    async run(ctx) {
      const skill = await kaltura.skills.add({
        name: `live-verify-avatar-flag-${TAG}`, description: 'Scratch skill for scripts/live-verify-avatar-flag.mjs',
        instructions: `If the user message contains the word PING, reply with exactly: Pong, ${MARK}.`,
      }, admin.ks);
      made.skills.push(skill.id);
      await configure({ prompts: [baseRules('Be terse. If the user message contains PING and no skill applies, reply with exactly: Pong.')], skillIds: [{ id: skill.id, mode: 'preloaded', condition: 'sys__avatar_enabled' }] });
      await bothSides({ ...ctx, turns: ['PING'] });
    },
  },
  A4: {
    name: 'var tool gated on sys__avatar_enabled',
    async run(ctx) {
      const toolName = `live_verify_avatar_flag_${TAG}`;
      const tool = await kaltura.tools.add(tools.var({
        name: toolName, description: 'Switch the reply mode. Call it with the mode name the user asks for.',
        args: { af_mode: { prompt: 'Mode name, lowercase', type: 'str', required: true } }, condition: 'sys__avatar_enabled',
      }), admin.ks);
      made.tools.push(tool.id);
      await configure({ prompts: [baseRules('Be terse. When the user asks to switch mode, call the mode tool, then reply "Done".')], toolIds: [tool.id] });
      const priorExperiences = (await kaltura.intellects.get(agent.configId, admin.ks)).capabilities?.kaltura_genie_experiences;
      await kaltura.intellectConfig.setCapabilities(agent.configId, { kaltura_genie_experiences: 'off' }, admin.ks);
      try {
        // The avatar stream shows no tool event, so read the saved thread for a `tool` segment.
        let called = false;
        for (let attempt = 0; attempt < 3 && !called; attempt++) {
          const page = await connectAvatar(ctx.context, ctx.sink, ctx.id);
          // Do not wait for speech: the reply after a tool call is not always spoken. Poll the thread.
          await ev(page, 'testSendText', 'Switch mode to zebra.');
          const threadId = (await ev(page, 'testState'))?.threadId;
          for (let i = 0; threadId && i < 20 && !called; i++) {
            await sleep(3000);
            const msgs = await kaltura.messages.list(admin.ks, { threadId }).all();
            const segments = msgs.flatMap((m) => (m.assistant?.messages ?? []).flatMap((x) => x.content ?? []));
            called = segments.some((seg) => seg.type === 'tool' && String(seg.content).startsWith(toolName));
          }
          await ev(page, 'testDisconnect').catch(() => {});
        }
        report.check(`${ctx.id}: avatar session offers and calls the tool`, called);
        const conv = await kaltura.sessions.createConversationToken({ configId: agent.configId });
        const plain = [await kaltura.converseOnce(agent.configId, 'Switch mode to zebra.', {}, conv), await kaltura.converseOnce(agent.configId, 'Please switch the mode to zebra now.', {}, conv)];
        report.check(`${ctx.id}: plain conversation never calls the tool`, plain.every((r) => (r.toolCalls ?? []).length === 0 && (r.text ?? '').trim() !== ''), { calls: plain.map((r) => (r.toolCalls ?? []).length) });
      } finally {
        await kaltura.intellectConfig.setCapabilities(agent.configId, { kaltura_genie_experiences: priorExperiences ?? 'on' }, admin.ks).catch(() => {});
      }
    },
  },
  A5: {
    name: 'sys__avatar_share_screen_enabled flips to true once a screen share runs (agent screenShare enabled)',
    async run(ctx) {
      await sharing(ctx, { condition: 'sys__avatar_share_screen_enabled', before: false, after: true });
    },
  },
  A6: {
    name: 'sys__avatar_enabled and not sys__avatar_share_screen_enabled flips to false once a screen share runs',
    async run(ctx) {
      await sharing(ctx, { condition: 'sys__avatar_enabled and not sys__avatar_share_screen_enabled', before: true, after: false });
    },
  },
};

try {
  for (const [id, sc] of Object.entries(SCENARIOS)) {
    if (ONLY ? !ONLY.has(id) : SHARE_ONLY.has(id) && !args.share) continue;
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
  for (const id of made.tools) await kaltura.tools.delete(id, admin.ks, { confirmPermanent: true, force: true }).catch((e) => report.check('cleanup: tool deleted', false, { id, message: e?.detail || e?.message }));
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
