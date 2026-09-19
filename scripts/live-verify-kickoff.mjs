#!/usr/bin/env node
/**
 * Live scenario verification for the silent-opening + kickoff pattern.
 *
 * Provisions a throwaway agent whose opening phrase is SILENT_OPENING, opens
 * `scripts/live-verify-kickoff.html` in the chosen browser once per scenario,
 * and asserts what a caller observes: session events, outgoing socket frames,
 * inbound WebRTC stats, audible sound on the remote track, and every WHEP
 * request's outcome. Every scenario runs in a fresh browser context.
 *
 * | id  | scenario                                             | asserts |
 * |-----|------------------------------------------------------|---------|
 * | V2  | silent opening audibility                            | no sound heard and ~0 inbound audio energy during the opening vs the reply |
 * | V4  | kickoff echo                                         | default: no user transcript with the kickoff; `echo: true`: exactly one |
 * | V6  | requireDisclosureAck                                 | kickoff waits for acknowledgeDisclosure() |
 * | V7  | pause() / resume()                                   | kickoff not re-sent; speak() after resume gets a reply |
 * | V8  | reconnect after a dropped socket                     | kickoff not re-sent; state returns to connected; speak() works |
 * | V9  | speak() typed during the opening                     | one onTextEntered carrying kickoff + typed text |
 * | V10 | KalturaAgentSession avatar → chat → avatar           | kickoff sent once across transports |
 * | V11 | KalturaAgentSession chat mode                        | kickoff sent, reply arrives, no echo, sendText() works |
 * | V12 | mic denied                                           | connected + warning, kickoff reply, speak() works, one getUserMedia |
 * | V13 | micStartMode: 'deferred'                             | no getUserMedia until startMic(), reply still arrives |
 * | V14 | audio-only mode (iPhone UA)                          | when the server picks audio mode: reply arrives with one peer |
 * | V15 | spoken opening ('Hello!') + kickoff                  | opening spoken, kickoff after it, reply on a new speech id |
 * | V16 | text barge-in mid-reply                              | `interrupted` within 1500 ms of speak() |
 *
 * Usage
 *   node scripts/live-verify-kickoff.mjs                        # --env prod, AGENTIC_* vars
 *   node scripts/live-verify-kickoff.mjs --env nvq2 --env-file ../.env --only V4,V6
 *   node scripts/live-verify-kickoff.mjs --env nvp1 --env-file ../.env --browser chrome
 *   flags: --only IDS --browser chromium|chrome|firefox|webkit --headed --out DIR --keep
 *          --agent-json PATH --kickoff TEXT --dump-events
 *
 * Artifacts (`--out`, default live-verify-artifacts/): <runId>.json + <runId>.md,
 * plus <runId>-<id>-events.json (the page's full event log) for every failed
 * scenario, or for all of them with --dump-events. Tokens and URL query strings
 * are redacted; no ids or secrets are written.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  bootstrap, Report, mdTable, management, ensureAgent, mintPageInit, startServer,
  browserChoice, launchBrowser, contextOptions, openHarness, whepSummary, netProblems, redact, waitFor, find, all, isOpeningSpeechId, textsSent, sleep, SILENT_OPENING,
} from './live-verify-kickoff-shared.mjs';

const { args, target, runId, outDir } = bootstrap(process.argv.slice(2), 'kickoff');
const KICKOFF = typeof args.kickoff === 'string' ? args.kickoff : 'Greet the user in one short sentence and ask how you can help.';
const ONLY = typeof args.only === 'string' ? new Set(args.only.split(',').map((s) => s.trim().toUpperCase())) : null;
const REPLY_TIMEOUT = 30_000;
const REPLY_END_TIMEOUT = 60_000;
const choice = browserChoice(args);
const HEADED = choice.headed || choice.browser === 'chrome';
const SETUP = `${choice.browser} ${HEADED ? 'headed' : 'headless'}`;

const report = new Report({ runId, target: target.name, browser: choice.browser, headed: HEADED });
report.data.scenarios = [];
const kaltura = management(target);
const admin = await kaltura.sessions.createAdminToken();
const agent = await ensureAgent(kaltura, admin.ks, { agentJson: typeof args['agent-json'] === 'string' ? args['agent-json'] : undefined, keep: !!args.keep });
report.note('agent', agent.reused ? 'reused --agent-json ids' : 'provisioned throwaway agent with SILENT_OPENING');

const { server, origin } = await startServer(() => mintPageInit(kaltura, agent, target.genieUrl));
const browser = await launchBrowser(choice);
report.note('setup', SETUP);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** @typedef {import('./live-verify-kickoff-shared.mjs').HarnessEvent} Ev */

const ev = (/** @type {import('playwright').Page} */ page, /** @type {string} */ fn, /** @type {any} */ arg) =>
  page.evaluate(([f, a]) => /** @type {any} */ (window)[f](a), [fn, arg]);

/** First reply chunk (any speechChunk on a non-opening speech id) at or after `from`. */
const replyChunk = (/** @type {Ev[]} */ evs, from = 0) => find(evs, 'speechChunk', { from, where: (d) => !isOpeningSpeechId(d?.speechId) });
/** Outgoing kickoff frames. */
const kickoffFrames = (/** @type {Ev[]} */ evs) => all(evs, 'socket:out', (d) => d.ev === 'onTextEntered' && typeof d.text === 'string' && d.text.includes(KICKOFF));
/** User-echo transcripts carrying the kickoff text. */
const kickoffEchoes = (/** @type {Ev[]} */ evs) => all(evs, 'transcript', (d) => d?.type === 'user' && typeof d?.text === 'string' && d.text.includes(KICKOFF));
/** transcript/speechChunk payloads containing the silent opening text. */
const leaks = (/** @type {Ev[]} */ evs) => [...all(evs, 'transcript'), ...all(evs, 'speechChunk')].filter((e) => typeof e.detail?.text === 'string' && e.detail.text.includes(SILENT_OPENING));

/** connect and wait for the first reply chunk; returns events + indexes. */
async function connectAndReply(/** @type {import('playwright').Page} */ page, /** @type {string} */ id) {
  const connect = await ev(page, 'testConnect');
  report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
  if (!connect.ok) throw new Error(`connect failed: ${connect.code} ${connect.message}`);
  const { events: evs } = await waitFor(page, (e) => replyChunk(e), REPLY_TIMEOUT, 'first reply speechChunk');
  return evs;
}

/** Wait for the reply that started at/after `from` to end (avatarStopTalking or interrupted). */
async function replyEnd(/** @type {import('playwright').Page} */ page, /** @type {number} */ from) {
  const { events: evs } = await waitFor(page, (e) => find(e, 'avatarStopTalking', { from }) || find(e, 'interrupted', { from }), REPLY_END_TIMEOUT, 'reply end');
  return evs;
}

/** speak(text) and wait for a fresh reply chunk after the call. */
async function speakAndReply(/** @type {import('playwright').Page} */ page, /** @type {string} */ id, /** @type {string} */ text, /** @type {string} */ label) {
  const before = await ev(page, 'testState');
  const beforeEvs = await page.evaluate(() => /** @type {any} */ (window).__events.length);
  const sent = await ev(page, 'testSpeak', text);
  const { events: evs } = await waitFor(page, (e) => replyChunk(e, beforeEvs), REPLY_TIMEOUT, `reply to ${label}`);
  const call = find(evs, 'speak:call', { from: beforeEvs });
  const chunk = replyChunk(evs, beforeEvs);
  report.check(`${id}: speak() ${label} → reply`, sent === true && !!chunk, { sent, stateBefore: before.state, replyMs: chunk && call ? chunk.tRel - call.tRel : null });
  return evs;
}

/** Common closing checks on a full event log. */
function commonChecks(/** @type {string} */ id, /** @type {Ev[]} */ evs, /** @type {{expectEchoes?: number}} */ opts = {}) {
  report.check(`${id}: kickoff on the wire exactly once`, kickoffFrames(evs).length === 1, { frames: kickoffFrames(evs).length, textsSent: textsSent(evs).length });
  report.check(`${id}: silent opening never surfaces as text`, leaks(evs).length === 0, { leaked: leaks(evs).length });
  if (opts.expectEchoes !== undefined) report.check(`${id}: kickoff user-echo transcripts = ${opts.expectEchoes}`, kickoffEchoes(evs).length === opts.expectEchoes, { echoes: kickoffEchoes(evs).length });
}

/** Sum of inbound audio energy across peers for one stats sample. */
const energy = (/** @type {any} */ sample) => (sample?.detail?.inbound || []).reduce((s, r) => s + (r.totalAudioEnergy || 0), 0);
const hasInbound = (/** @type {any} */ sample) => (sample?.detail?.inbound || []).length > 0;

/**
 * Write every page's recorded event log to `<outDir>/<runId>-<id>-events.json`,
 * redacted. Runs for every failed scenario, and for all of them with --dump-events.
 * @param {string} id @param {import('playwright').Page[]} pages
 */
async function dumpEvents(id, pages) {
  const logs = [];
  for (const page of pages) {
    if (page.isClosed()) continue;
    try { logs.push(await page.evaluate(() => /** @type {any} */ (window).__events.slice())); } catch { /* page gone */ }
  }
  if (!logs.length) return;
  const file = resolve(outDir, `${runId}-${id}-events.json`);
  writeFileSync(file, redact(JSON.stringify(logs, null, 1)));
  console.log(`[events] ${id}: ${file}`);
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

/** @typedef {{pageErrors: string[], pages: import('playwright').Page[], network: import('./live-verify-kickoff-shared.mjs').NetRecord[]}} Sink */
/** @type {Record<string, {name: string, run: (ctx: {context: import('playwright').BrowserContext, sink: Sink, id: string}) => Promise<void>, context?: () => Promise<import('playwright').BrowserContext>}>} */
const SCENARIOS = {
  V2: {
    name: 'silent opening audibility',
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar', kickoff: KICKOFF }, sink);
      const connect = await ev(page, 'testConnect');
      report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      if (!connect.ok) return;
      await page.evaluate(() => /** @type {any} */ (window).sampleStats('connect-resolved'));
      let { events: evs } = await waitFor(page, (e) => replyChunk(e), REPLY_TIMEOUT, 'first reply speechChunk');
      const firstChunk = replyChunk(evs);
      evs = await replyEnd(page, firstChunk.index);

      const start = find(evs, 'connect:start');
      const atConnect = find(evs, 'stats:sample', { from: start.index, where: (d) => d.label === 'connect-resolved' });
      const openingStop = find(evs, 'stats:sample', { from: start.index, where: (d) => d.label === 'avatarStopTalking' });
      const replyStart = find(evs, 'stats:sample', { from: openingStop ? openingStop.index + 1 : start.index, where: (d) => d.label === 'avatarStartTalking' });
      const replyStop = find(evs, 'stats:sample', { from: replyStart ? replyStart.index + 1 : start.index, where: (d) => d.label === 'avatarStopTalking' || d.label === 'interrupted' });
      const ok = atConnect && openingStop && replyStart && replyStop && hasInbound(openingStop) && hasInbound(replyStop);
      if (!ok) {
        report.check(`${id}: inbound audio stats available for opening and reply`, false, { atConnect: !!atConnect, openingStop: !!openingStop, replyStart: !!replyStart, replyStop: !!replyStop, inbound: hasInbound(replyStop) });
        return;
      }
      // What the user hears: the AnalyserNode on the remote audio track.
      const resolved = find(evs, 'connect:resolved');
      const ctxRunning = !!find(evs, 'audioctx:state', { where: (d) => d.state === 'running' });
      const openingSound = find(evs, 'audio:soundStart', { from: resolved.index });
      const soundDuringOpening = openingSound && openingSound.tRel <= openingStop.tRel;
      const replySound = find(evs, 'audio:soundStart', { from: replyStart.index });
      if (ctxRunning) {
        report.check(`${id}: no sound heard during the silent opening`, !soundDuringOpening, { soundAtMs: soundDuringOpening ? openingSound.tRel - resolved.tRel : null, openingEndMs: openingStop.tRel - resolved.tRel });
        report.check(`${id}: sound heard during the reply`, !!replySound, { afterTalkMs: replySound ? replySound.tRel - replyStart.tRel : null });
      } else {
        report.note(`${id}: analyser not running, audibility measured from stats only`, { engine: find(evs, 'harness:ready')?.detail?.engine });
      }
      // What the wire carried: inbound-rtp totalAudioEnergy (Chromium/WebKit; Firefox does not report it).
      const hasEnergy = (openingStop.detail.inbound || []).some((/** @type {any} */ r) => typeof r.totalAudioEnergy === 'number');
      if (hasEnergy) {
        const openingDelta = energy(openingStop) - energy(atConnect);
        const replyDelta = energy(replyStop) - energy(replyStart);
        const limit = Math.max(1e-3, 0.05 * replyDelta);
        report.check(`${id}: opening audio energy ≈ 0 (≤ max(1e-3, 5% of reply))`, replyDelta > 0 && openingDelta <= limit, { openingDelta: +openingDelta.toFixed(5), replyDelta: +replyDelta.toFixed(5), limit: +limit.toFixed(5) });
      } else {
        report.note(`${id}: totalAudioEnergy not reported by this browser, energy check skipped`, { engine: find(evs, 'harness:ready')?.detail?.engine });
        if (!ctxRunning) report.check(`${id}: audibility measurable (analyser or totalAudioEnergy)`, false, {});
      }
      commonChecks(id, evs);
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },

  V4: {
    name: 'kickoff echo',
    async run({ context, sink, id }) {
      for (const echo of [false, true]) {
        const label = echo ? 'echo:true' : 'default';
        const page = await openHarness(context, origin, { mode: 'avatar', kickoff: KICKOFF, echo: echo ? 1 : undefined }, sink);
        const first = await connectAndReply(page, `${id} ${label}`);
        await replyEnd(page, replyChunk(first).index);
        // the user echo (agentTurnToTalk) arrives before the reply; give a short grace anyway
        await sleep(500);
        const evs = await page.evaluate(() => /** @type {any} */ (window).__events.slice());
        commonChecks(`${id} ${label}`, evs, { expectEchoes: echo ? 1 : 0 });
        await ev(page, 'testDisconnect').catch(() => {});
        // the page stays open (context.close() ends it) so its event log can be dumped
      }
    },
  },

  V6: {
    name: 'requireDisclosureAck gates the kickoff',
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar', kickoff: KICKOFF, disclosure: 1 }, sink);
      const connect = await ev(page, 'testConnect');
      report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      if (!connect.ok) return;
      let evs = await page.evaluate(() => /** @type {any} */ (window).__events.slice());
      report.check(`${id}: disclosure event emitted`, !!find(evs, 'disclosure'));
      await sleep(2000);
      evs = await page.evaluate(() => /** @type {any} */ (window).__events.slice());
      report.check(`${id}: no kickoff before acknowledgeDisclosure()`, kickoffFrames(evs).length === 0 && !find(evs, 'avatarStartTalking'), { frames: kickoffFrames(evs).length, kickoff: await ev(page, 'testKickoff') });
      const ackAt = evs.length;
      await ev(page, 'testAck');
      ({ events: evs } = await waitFor(page, (e) => replyChunk(e, ackAt), REPLY_TIMEOUT, 'reply after ack'));
      const ack = find(evs, 'ack:call');
      const frame = kickoffFrames(evs)[0];
      report.check(`${id}: kickoff sent after ack`, !!frame && !!ack && frame.tRel >= ack.tRel, { afterAckMs: frame && ack ? frame.tRel - ack.tRel : null });
      report.check(`${id}: kickoff getter reports sent`, (await ev(page, 'testKickoff'))?.sent === true);
      commonChecks(id, evs, { expectEchoes: 0 });
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },

  V7: {
    name: 'pause() / resume() never re-sends the kickoff',
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar', kickoff: KICKOFF }, sink);
      let evs = await connectAndReply(page, id);
      evs = await replyEnd(page, replyChunk(evs).index);
      const pauseAt = evs.length;
      await ev(page, 'testPause');
      await sleep(1500);
      await ev(page, 'testResume');
      ({ events: evs } = await waitFor(page, (e) => find(e, 'resumed', { from: pauseAt }) || find(e, 'resume:resolved', { from: pauseAt }), 20_000, 'resume'));
      const state = await ev(page, 'testState');
      report.check(`${id}: connected and not paused after resume()`, state.state === 'connected' && state.paused === false, state);
      report.check(`${id}: kickoff not re-sent by resume()`, kickoffFrames(evs).length === 1, { frames: kickoffFrames(evs).length });
      // a replayed opening (if any) must release before speak() can go out
      const speakAt = evs.length;
      evs = await speakAndReply(page, id, 'Say the word banana.', 'after resume');
      const imm = find(evs, 'speak:immediate', { from: speakAt });
      report.note(`${id}: speak() after resume was held`, imm?.detail?.pending === true);
      commonChecks(id, evs, { expectEchoes: 0 });
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },

  V8: {
    name: 'reconnect after a dropped socket',
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar', kickoff: KICKOFF }, sink);
      let evs = await connectAndReply(page, id);
      evs = await replyEnd(page, replyChunk(evs).index);
      const dropAt = evs.length;
      await context.setOffline(true);
      await page.evaluate(() => /** @type {any} */ (window).__sockets.at(-1).io.engine.close());
      ({ events: evs } = await waitFor(page, (e) => find(e, 'reconnecting', { from: dropAt }), 10_000, 'reconnecting'));
      const rec = find(evs, 'reconnecting', { from: dropAt });
      await sleep(3000);
      await context.setOffline(false);
      ({ events: evs } = await waitFor(page, (e) => find(e, 'reconnected', { from: dropAt }), 60_000, 'reconnected'));
      const done = find(evs, 'reconnected', { from: dropAt });
      const cold = !!find(evs, 'reconnecting', { from: dropAt, where: (d) => d?.cold === true });
      const state = await ev(page, 'testState');
      report.check(`${id}: back to connected after the drop`, state.state === 'connected', { state: state.state, reason: rec?.detail?.reason, recovered: done?.detail?.recovered, cold, reconnectMs: done.tRel - rec.tRel });
      report.check(`${id}: kickoff not re-sent by reconnect`, kickoffFrames(evs).length === 1, { frames: kickoffFrames(evs).length });
      evs = await speakAndReply(page, id, 'Say the word cherry.', 'after reconnect');
      commonChecks(id, evs, { expectEchoes: 0 });
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },

  V9: {
    name: 'speak() typed during the opening coalesces with the kickoff',
    async run({ context, sink, id }) {
      const TYPED = 'Also mention the word pineapple.';
      const page = await openHarness(context, origin, { mode: 'avatar', kickoff: KICKOFF }, sink);
      const connect = await ev(page, 'testConnect');
      report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      if (!connect.ok) return;
      // fire speak() without awaiting: it must be held behind the opening, together with the kickoff
      await page.evaluate((t) => { /** @type {any} */ (window).__speakP = /** @type {any} */ (window).testSpeak(t); }, TYPED);
      let { events: evs } = await waitFor(page, (e) => replyChunk(e), REPLY_TIMEOUT, 'first reply speechChunk');
      const imm = find(evs, 'speak:immediate');
      report.check(`${id}: speak() during the opening was held`, imm?.detail?.pending === true, imm?.detail);
      const frames = textsSent(evs);
      report.check(`${id}: one onTextEntered carrying kickoff + typed text`, frames.length === 1 && frames[0].detail.text.includes(KICKOFF) && frames[0].detail.text.includes(TYPED), { frames: frames.length, text: frames[0]?.detail?.text });
      const sent = await page.evaluate(() => /** @type {any} */ (window).__speakP);
      report.check(`${id}: speak() resolved true`, sent === true, { sent });
      evs = await replyEnd(page, replyChunk(evs).index);
      report.check(`${id}: silent opening never surfaces as text`, leaks(evs).length === 0, { leaked: leaks(evs).length });
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },

  V10: {
    name: 'KalturaAgentSession avatar → chat → avatar sends the kickoff once',
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'agent-avatar', kickoff: KICKOFF }, sink);
      let evs = await connectAndReply(page, id);
      evs = await replyEnd(page, replyChunk(evs).index);
      const k1 = await ev(page, 'testKickoff');
      report.check(`${id}: first avatar transport reports kickoff sent`, k1?.sent === true, k1);
      await ev(page, 'testSwitch', 'chat');
      const switchAt = evs.length;
      await ev(page, 'testSendText', 'What is two plus two? Answer in one word.');
      await waitFor(page, (e) => find(e, 'transcript', { from: switchAt, where: (d) => d?.type === 'final' }), REPLY_TIMEOUT, 'chat reply');
      report.check(`${id}: chat reply after switchMode('chat')`, true, { mode: (await ev(page, 'testState')).mode });
      await ev(page, 'testSwitch', 'avatar');
      const state = await ev(page, 'testState');
      report.check(`${id}: back in avatar mode and connected`, state.mode === 'avatar' && state.state === 'connected', state);
      await sleep(3000);
      evs = await page.evaluate(() => /** @type {any} */ (window).__events.slice());
      report.check(`${id}: second avatar transport has no kickoff`, (await ev(page, 'testKickoff')) === null);
      report.check(`${id}: kickoff on the wire once across transports`, kickoffFrames(evs).length === 1, { frames: kickoffFrames(evs).length, sockets: all(evs, 'socket:created').length });
      report.check(`${id}: silent opening never surfaces as text`, leaks(evs).length === 0, { leaked: leaks(evs).length });
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },

  V11: {
    name: 'KalturaAgentSession chat mode',
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'agent-chat', kickoff: KICKOFF }, sink);
      const connect = await ev(page, 'testConnect');
      report.check(`${id}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      if (!connect.ok) return;
      let { events: evs } = await waitFor(page, (e) => find(e, 'transcript', { where: (d) => d?.type === 'final' }), REPLY_TIMEOUT, 'chat kickoff reply');
      const k = await ev(page, 'testKickoff');
      report.check(`${id}: kickoff getter reports sent`, k?.sent === true, k);
      report.check(`${id}: no user echo of the kickoff`, kickoffEchoes(evs).length === 0, { echoes: kickoffEchoes(evs).length });
      const at = evs.length;
      await ev(page, 'testSendText', 'What is two plus two? Answer in one word.');
      ({ events: evs } = await waitFor(page, (e) => find(e, 'transcript', { from: at, where: (d) => d?.type === 'final' }), REPLY_TIMEOUT, 'chat reply'));
      report.check(`${id}: sendText() reply after the kickoff`, true, { finals: all(evs, 'transcript', (d) => d?.type === 'final').length });
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },

  V12: {
    name: 'mic denied: session continues, kickoff reply arrives',
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar', kickoff: KICKOFF, mic: 'denied' }, sink);
      let evs = await connectAndReply(page, id);
      evs = await replyEnd(page, replyChunk(evs).index);
      const warn = find(evs, 'warning', { where: (d) => d?.code === 'mic_permission_denied' });
      report.check(`${id}: one warning mic_permission_denied`, !!warn && all(evs, 'warning', (d) => d?.code === 'mic_permission_denied').length === 1, warn?.detail);
      report.check(`${id}: exactly one getUserMedia call`, (await page.evaluate(() => /** @type {any} */ (window).__gumCalls)) === 1);
      evs = await speakAndReply(page, id, 'Say the word mango.', 'with no mic');
      commonChecks(id, evs, { expectEchoes: 0 });
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },

  V13: {
    name: "micStartMode: 'deferred' + kickoff, then startMic()",
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar', kickoff: KICKOFF, mic: 'deferred' }, sink);
      let evs = await connectAndReply(page, id);
      report.check(`${id}: no getUserMedia before startMic()`, (await page.evaluate(() => /** @type {any} */ (window).__gumCalls)) === 0);
      evs = await replyEnd(page, replyChunk(evs).index);
      const at = evs.length;
      await ev(page, 'testStartMic');
      ({ events: evs } = await waitFor(page, (e) => find(e, 'micStarted', { from: at }), 10_000, 'micStarted'));
      report.check(`${id}: startMic() → micStarted, one getUserMedia`, (await page.evaluate(() => /** @type {any} */ (window).__gumCalls)) === 1);
      commonChecks(id, evs, { expectEchoes: 0 });
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },

  V14: {
    name: 'audio-only mode (iPhone UA)',
    context: () => browser.newContext(contextOptions({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    })),
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar', kickoff: KICKOFF }, sink);
      let evs = await connectAndReply(page, id);
      evs = await replyEnd(page, replyChunk(evs).index);
      const media = find(evs, 'mediaReady');
      if (media?.detail?.mode === 'audio') {
        report.check(`${id}: audio mode → reply arrived with one peer connection`, (await page.evaluate(() => /** @type {any} */ (window).__pcs.length)) === 1, { pcs: await page.evaluate(() => /** @type {any} */ (window).__pcs.length) });
      } else {
        report.note(`${id}: server kept video mode for this UA; audio-only mode is chosen by the server, not the client. Reply still arrived.`, { mode: media?.detail?.mode ?? null });
      }
      commonChecks(id, evs, { expectEchoes: 0 });
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },

  V15: {
    name: "spoken opening ('Hello!') + kickoff",
    async run({ context, sink, id }) {
      await kaltura.intellectConfig.setOpeningPhrase(agent.configId, 'Hello!', admin.ks);
      try {
        const page = await openHarness(context, origin, { mode: 'avatar', kickoff: KICKOFF }, sink);
        let evs = await connectAndReply(page, id);
        evs = await replyEnd(page, replyChunk(evs).index);
        const start = find(evs, 'connect:start');
        const openingChunk = find(evs, 'speechChunk', { from: start.index, where: (d) => isOpeningSpeechId(d?.speechId) && typeof d?.text === 'string' && d.text.trim() !== '' });
        const openingFinished = find(evs, 'socket:in', { from: start.index, where: (d) => d.ev === 'stvFinishedTalking' });
        const frame = kickoffFrames(evs)[0];
        report.check(`${id}: opening spoken (speechChunk on the opening id with text)`, !!openingChunk, { text: openingChunk?.detail?.text });
        report.check(`${id}: kickoff sent after the opening finished`, !!frame && !!openingFinished && frame.tRel >= openingFinished.tRel, { afterMs: frame && openingFinished ? frame.tRel - openingFinished.tRel : null });
        report.check(`${id}: reply on a non-opening speech id`, !!replyChunk(evs, frame ? frame.index : 0));
        report.check(`${id}: kickoff on the wire exactly once`, kickoffFrames(evs).length === 1, { frames: kickoffFrames(evs).length });
        await ev(page, 'testDisconnect').catch(() => {});
      } finally {
        await kaltura.intellectConfig.setOpeningPhrase(agent.configId, SILENT_OPENING, admin.ks);
      }
    },
  },

  V16: {
    name: 'text barge-in mid-reply',
    async run({ context, sink, id }) {
      const page = await openHarness(context, origin, { mode: 'avatar', kickoff: KICKOFF }, sink);
      let evs = await connectAndReply(page, id);
      const at = evs.length;
      // speak while the reply is still playing
      await page.evaluate((t) => { /** @type {any} */ (window).__speakP = /** @type {any} */ (window).testSpeak(t); }, 'Stop. Just say OK.');
      ({ events: evs } = await waitFor(page, (e) => find(e, 'interrupted', { from: at }), 10_000, 'interrupted'));
      const call = find(evs, 'speak:call', { from: at });
      const intr = find(evs, 'interrupted', { from: at });
      const latency = intr.tRel - call.tRel;
      report.check(`${id}: interrupted within 1500 ms of speak()`, latency <= 1500, { latencyMs: latency });
      const sent = await page.evaluate(() => /** @type {any} */ (window).__speakP);
      report.check(`${id}: barge-in speak() resolved true`, sent === true, { sent });
      ({ events: evs } = await waitFor(page, (e) => replyChunk(e, intr.index), REPLY_TIMEOUT, 'reply after barge-in'));
      report.check(`${id}: reply after the barge-in`, true);
      commonChecks(id, evs, { expectEchoes: 0 });
      await ev(page, 'testDisconnect').catch(() => {});
    },
  },
};

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

try {
  for (const [id, sc] of Object.entries(SCENARIOS)) {
    if (ONLY && !ONLY.has(id)) continue;
    console.log(`\n== ${id}: ${sc.name}`);
    const t0 = Date.now();
    /** @type {Sink} */
    const sink = { pageErrors: [], pages: [], network: [] };
    const context = sc.context ? await sc.context() : await browser.newContext(contextOptions());
    const before = report.checks.length;
    let error = null;
    try {
      await sc.run({ context, sink, id });
    } catch (err) {
      error = String(/** @type {any} */ (err)?.message || err);
      report.check(`${id}: completed`, false, { error, pageErrors: sink.pageErrors.slice(0, 5) });
    } finally {
      // Let the fire-and-forget WHEP DELETE from disconnect() land before we read the network log.
      await sleep(300);
      const whep = whepSummary(sink.network);
      const whepBad = whep.filter((l) => /^POST .*(FAILED|→ [45]\d\d)/.test(l));
      if (whep.length) report.check(`${id}: every WHEP POST succeeded`, whepBad.length === 0, { whep });
      const problems = netProblems(sink.network);
      if (problems.length) report.note(`${id}: HTTP requests that failed or returned 4xx/5xx`, problems.slice(0, 10));
      if (sink.pageErrors.length) report.note(`${id}: page errors`, sink.pageErrors.slice(0, 5));
      const own = report.checks.slice(before);
      const ok = own.every((c) => c.ok);
      if (!ok || args['dump-events']) await dumpEvents(id, sink.pages);
      report.data.scenarios.push({ id, name: sc.name, ok, checks: own.length, ms: Date.now() - t0, error, whep });
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
  await agent.cleanup();
}

const md = [
  `# kickoff scenarios — ${target.name} — ${report.meta.startedAt}`,
  '',
  `${SETUP}, one fresh browser context per scenario, silent opening + kickoff.`,
  '',
  mdTable(['id', 'scenario', 'result', 'checks', 'ms', 'WHEP requests', 'error'],
    report.data.scenarios.map((s) => [s.id, s.name, s.ok ? 'ok' : 'FAIL', s.checks, s.ms, (s.whep || []).join('; ').replace(/\|/g, '\\|'), s.error ?? ''])),
  '',
  '## Checks',
  '',
  mdTable(['result', 'check', 'detail'], report.checks.map((c) => [c.ok ? 'ok' : 'FAIL', c.name, c.detail === undefined ? '' : JSON.stringify(c.detail).replace(/\|/g, '\\|')])),
  '',
].join('\n');
report.write(outDir, md);
const failed = report.data.scenarios.filter((s) => !s.ok).map((s) => s.id);
console.log(`\n${report.data.scenarios.length} scenarios, ${failed.length ? `FAILED: ${failed.join(', ')}` : 'all ok'}`);
process.exit(report.failed ? 1 : 0);
