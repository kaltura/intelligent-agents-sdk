#!/usr/bin/env node
/**
 * Live connect-timing verification for the silent-opening + kickoff pattern.
 *
 * Provisions a throwaway agent whose opening phrase is SILENT_OPENING, opens
 * `scripts/live-verify-kickoff.html` in the chosen browser, connects, and
 * measures the real startup path `--runs` times: SDK events, socket frames,
 * WebRTC peer state, `getStats()`, and what reaches the user's eyes and ears
 * (first decoded video frame, element `playing`, and audible sound on the remote
 * audio track measured with an AnalyserNode).
 *
 * Per run it asserts:
 *   1. connect() resolves
 *   2. STV media (ICE) is connected before connect() resolves
 *   3. with a silent opening: connect-resolved → opening avatarStopTalking < 1500 ms,
 *      and no sound is heard during that window
 *   4. with a kickoff: it leaves the client ≤ 50 ms after the opening's
 *      stvFinishedTalking, it is the only text sent, and the first speechChunk is
 *      on a non-opening speech id (real reply, not the opening)
 *   5. a video frame was decoded and rendered (video mode). When the STV answer carries no
 *      usable video section (port 0, no shared codec) the check reports that instead, with
 *      the codecs the browser offered, so a codec gap is not mistaken for an SDK bug
 *   6. sound was heard after avatarStartTalking (when the analyser is running)
 *   7. no transcript/speechChunk payload ever contains the silent-opening text
 * and records min/median/max of every timing relative to connect().
 *
 * Baseline before this pattern (same QA backend, fake mic, hand-timed with a
 * speak() nudge after connect): connect() 2.2–3.6 s, connect-resolved → first
 * words 1.75–1.85 s. The markdown artifact prints this baseline next to the
 * measured numbers so a regression is visible without opening the JSON.
 *
 * Usage
 *   node scripts/live-verify-connect-timing.mjs                 # --env prod, AGENTIC_* vars
 *   node scripts/live-verify-connect-timing.mjs --env nvq2 --env-file ../.env --runs 5
 *   node scripts/live-verify-connect-timing.mjs --env nvp1 --env-file ../.env --browser chrome
 *   node scripts/live-verify-connect-timing.mjs --browser firefox --opening 'Hello!' --no-kickoff
 *
 * Flags
 *   --runs N                 default 5
 *   --browser B              chromium (default) | chrome | firefox | webkit
 *   --headed                 show the browser (chrome is always headed, audio audible)
 *   --opening TEXT           spoken opening phrase instead of SILENT_OPENING (reset afterwards)
 *   --no-kickoff             connect without a kickoff (measures the opening only)
 *   --kickoff TEXT           kickoff text
 *   --mic M                  immediate (default) | deferred | denied
 *   --mode M                 avatar (default) | agent-avatar (KalturaAgentSession)
 *   --out DIR --keep --agent-json PATH
 *
 * Artifacts (`--out`, default live-verify-artifacts/): <runId>.json + <runId>.md.
 * No ids, tokens or secrets are written to them.
 */
import {
  bootstrap, Report, mdTable, stats, management, ensureAgent, mintPageInit, startServer,
  browserChoice, launchBrowser, contextOptions, openHarness, whepSummary, netProblems, waitFor, find, all, isOpeningSpeechId, textsSent, SILENT_OPENING,
} from './live-verify-kickoff-shared.mjs';

const { args, target, runId, outDir } = bootstrap(process.argv.slice(2), 'connect-timing');
const RUNS = Number(args.runs || 5);
const KICKOFF = args['no-kickoff'] === true ? null : (typeof args.kickoff === 'string' ? args.kickoff : 'Greet the user in one short sentence and ask how you can help.');
const OPENING = typeof args.opening === 'string' && args.opening.trim() ? args.opening : null;
const MIC = typeof args.mic === 'string' ? args.mic : undefined;   // undefined → harness default (WebKit: synthetic)
const MODE = typeof args.mode === 'string' ? args.mode : 'avatar';
if (MIC !== undefined && !['immediate', 'deferred', 'denied'].includes(MIC)) { console.error(`--mic ${MIC}: expected immediate, deferred or denied`); process.exit(1); }
if (!['avatar', 'agent-avatar'].includes(MODE)) { console.error(`--mode ${MODE}: expected avatar or agent-avatar`); process.exit(1); }
const choice = browserChoice(args);
const BASELINE = { connectMs: '2200–3600', firstWordsMs: '1750–1850' };
const MIC_LABEL = MIC ?? (choice.browser === 'webkit' ? 'synthetic' : 'immediate');
const SETUP = `${choice.browser}${choice.headed || choice.browser === 'chrome' ? ' headed' : ' headless'}, mic ${MIC_LABEL}, opening ${OPENING ? `spoken (${JSON.stringify(OPENING)})` : 'silent'}, ${KICKOFF ? 'kickoff' : 'no kickoff'}, mode ${MODE}`;

const report = new Report({ runId, target: target.name, browser: choice.browser, headed: choice.headed || choice.browser === 'chrome', setup: SETUP });
report.data.runs = [];
const kaltura = management(target);
const admin = await kaltura.sessions.createAdminToken();
const agent = await ensureAgent(kaltura, admin.ks, { agentJson: typeof args['agent-json'] === 'string' ? args['agent-json'] : undefined, keep: !!args.keep });
report.note('agent', agent.reused ? 'reused --agent-json ids' : 'provisioned throwaway agent with SILENT_OPENING');
report.note('setup', SETUP);
if (OPENING) await kaltura.intellectConfig.setOpeningPhrase(agent.configId, OPENING, admin.ks);

const { server, origin } = await startServer(() => mintPageInit(kaltura, agent, target.genieUrl));
const browser = await launchBrowser(choice);

/** @typedef {import('./live-verify-kickoff-shared.mjs').HarnessEvent} Ev */

/** First event of `type` at/after `from`, as ms after `base`. */
const at = (/** @type {Ev[]} */ evs, /** @type {string} */ type, /** @type {number} */ base, /** @type {{from?:number, where?:(d:any)=>boolean}} */ opts = {}) => {
  const e = find(evs, type, opts);
  return e ? e.tRel - base : null;
};

try {
  for (let i = 1; i <= RUNS; i++) {
    const context = await browser.newContext(contextOptions());
    /** @type {{pageErrors: string[], pages: import('playwright').Page[], network: import('./live-verify-kickoff-shared.mjs').NetRecord[]}} */
    const sink = { pageErrors: [], pages: [], network: [] };
    /** @type {Record<string, any>} */
    const run = { n: i };
    try {
      const page = await openHarness(context, origin, { mode: MODE, kickoff: KICKOFF ?? undefined, mic: MIC }, sink);
      const connect = await page.evaluate(() => /** @type {any} */ (window).testConnect());
      report.check(`run ${i}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      if (!connect.ok) { run.error = connect; continue; }

      // What "the agent spoke to the user" means for this setup.
      const isReply = (/** @type {any} */ d) => (KICKOFF ? !isOpeningSpeechId(d?.speechId) : typeof d?.text === 'string' && d.text.trim() !== '');
      let evs;
      if (KICKOFF || OPENING) {
        ({ events: evs } = await waitFor(page, (e) => find(e, 'speechChunk', { where: isReply }), 30_000, 'first spoken words'));
      } else {
        ({ events: evs } = await waitFor(page, (e) => find(e, 'avatarStopTalking'), 30_000, 'silent opening end'));
      }
      const start = find(evs, 'connect:start');
      const resolved = find(evs, 'connect:resolved');
      const openingStop = find(evs, 'avatarStopTalking', { from: start.index });
      const openingFinished = find(evs, 'socket:in', { from: start.index, where: (d) => d.ev === 'stvFinishedTalking' });
      const firstChunk = find(evs, 'speechChunk', { where: isReply });
      // The talk event that starts the speech we measure: the reply's for a kickoff, the opening's otherwise.
      const talkStart = KICKOFF
        ? find(evs, 'avatarStartTalking', { from: openingStop ? openingStop.index + 1 : start.index })
        : find(evs, 'avatarStartTalking', { from: start.index });

      // Let the user actually hear it: wait for the first sound after that talk event (or 8 s), then one more stats tick.
      if (talkStart) {
        await waitFor(page, (e) => find(e, 'audio:soundStart', { from: talkStart.index }), 8_000, 'audible sound after avatarStartTalking').catch(() => {});
      }
      await waitFor(page, (e) => find(e, 'stats:sample', { from: evs.length }), 2_000, 'stats tick').catch(() => {});
      evs = await page.evaluate(() => /** @type {any} */ (window).__events.slice());
      const sound = await page.evaluate(() => /** @type {any} */ (window).__sound);

      const T = start.tRel;
      const stvN = find(evs, 'pc:track')?.detail?.n ?? null;               // the peer that receives media is STV
      const mediaMode = find(evs, 'mediaReady')?.detail?.mode ?? null;
      const ctxRunning = !!find(evs, 'audioctx:state', { where: (d) => d.state === 'running' });
      const firstSoundAfterTalk = talkStart ? find(evs, 'audio:soundStart', { from: talkStart.index }) : null;
      const openingSound = openingStop ? find(evs, 'audio:soundStart', { from: resolved.index, where: () => true }) : null;
      const openingSoundInWindow = openingSound && openingStop && openingSound.tRel <= openingStop.tRel ? openingSound : null;
      const kickoffOut = KICKOFF ? find(evs, 'socket:out', { from: start.index, where: (d) => d.ev === 'onTextEntered' && d.text === KICKOFF }) : null;
      const firstTickWith = (/** @type {(d:any)=>boolean} */ pred) => find(evs, 'stats:sample', { from: start.index, where: pred });
      const lastSample = all(evs, 'stats:sample').at(-1)?.detail;
      const pair = lastSample?.pairs?.find((/** @type {any} */ p) => p.pc === stvN) ?? lastSample?.pairs?.[0] ?? null;
      const video = lastSample?.video?.[0] ?? null;

      Object.assign(run, {
        engine: find(evs, 'harness:ready')?.detail?.engine ?? null,
        mediaMode,
        connectMs: resolved.tRel - T,
        stvIceMs: stvN === null ? null : at(evs, 'pc:state', T, { from: start.index, where: (d) => d.n === stvN && (d.connection === 'connected' || d.ice === 'connected' || d.ice === 'completed') }),
        asrIceMs: stvN === null ? null : at(evs, 'pc:state', T, { from: start.index, where: (d) => d.n !== stvN && (d.connection === 'connected' || d.ice === 'connected' || d.ice === 'completed') }),
        trackAudioMs: at(evs, 'track:unmute', T, { where: (d) => d.kind === 'audio' }),
        trackVideoMs: at(evs, 'track:unmute', T, { where: (d) => d.kind === 'video' }),
        firstAudioPacketMs: (() => { const e = firstTickWith((d) => (d.inbound || []).some((/** @type {any} */ r) => r.packetsReceived > 0)); return e ? e.tRel - T : null; })(),
        firstDecodedFrameMs: (() => { const e = firstTickWith((d) => (d.video || []).some((/** @type {any} */ r) => r.framesDecoded > 0)); return e ? e.tRel - T : null; })(),
        videoFirstFrameMs: at(evs, 'video:firstFrame', T),
        videoPlayingMs: at(evs, 'video:playing', T),
        audioPlayingMs: at(evs, 'audio:playing', T),
        openingEndMs: openingStop ? openingStop.tRel - T : null,
        openingAfterConnectMs: openingStop ? openingStop.tRel - resolved.tRel : null,
        kickoffAfterReleaseMs: kickoffOut && openingFinished ? kickoffOut.tRel - openingFinished.tRel : null,
        talkStartMs: talkStart ? talkStart.tRel - T : null,
        firstWordsMs: firstChunk ? firstChunk.tRel - T : null,
        firstWordsAfterConnectMs: firstChunk ? firstChunk.tRel - resolved.tRel : null,
        firstSoundMs: firstSoundAfterTalk ? firstSoundAfterTalk.tRel - T : null,
        talkToSoundMs: firstSoundAfterTalk && talkStart ? firstSoundAfterTalk.tRel - talkStart.tRel : null,
        soundSpans: sound?.spans?.length ?? 0,
        analyser: sound?.error ? `error: ${sound.error}` : (ctxRunning ? 'running' : 'not running'),
        textsSent: textsSent(evs).length,
        candidatePair: pair ? `${pair.local ?? '?'}→${pair.remote ?? '?'} ${pair.protocol ?? ''} rtt ${pair.rtt ?? 'n/a'}` : null,
        videoStats: video ? { decoded: video.framesDecoded, dropped: video.framesDropped, size: `${video.frameWidth}x${video.frameHeight}`, fps: video.framesPerSecond, freezes: video.freezeCount } : null,
        whep: whepSummary(sink.network),
        // What the STV answer actually negotiated per m-section (kind, port, direction, codecs).
        negotiated: stvN === null ? null : (find(evs, 'pc:sdp', { where: (d) => d.n === stvN && d.role === 'remote' })?.detail?.media ?? null),
      });
      const videoSection = run.negotiated?.find((/** @type {any} */ m) => m.kind === 'video') ?? null;
      const videoNegotiated = !!videoSection && videoSection.port !== 0 && videoSection.codecs.length > 0 && videoSection.dir !== 'inactive';
      const offeredVideoCodecs = find(evs, 'pc:sdp', { where: (d) => d.n === stvN && d.role === 'local' })?.detail?.media?.find((/** @type {any} */ m) => m.kind === 'video')?.codecs ?? null;

      report.check(`run ${i}: STV media connected before connect() resolved`, mediaMode === 'audio' || (run.stvIceMs !== null && run.stvIceMs <= run.connectMs), { stvIceMs: run.stvIceMs, connectMs: run.connectMs, mediaMode });
      if (!OPENING) {
        report.check(`run ${i}: silent opening ended < 1500 ms after connect resolved`, run.openingAfterConnectMs !== null && run.openingAfterConnectMs < 1500, { openingAfterConnectMs: run.openingAfterConnectMs });
        if (ctxRunning) report.check(`run ${i}: no sound heard during the silent opening`, !openingSoundInWindow, { soundAtMs: openingSoundInWindow ? openingSoundInWindow.tRel - T : null, openingEndMs: run.openingEndMs });
        else report.note(`run ${i}: analyser not running, silent-opening audibility not measured`, { analyser: run.analyser });
      }
      if (KICKOFF) {
        report.check(`run ${i}: kickoff sent ≤ 50 ms after opening stvFinishedTalking`, run.kickoffAfterReleaseMs !== null && run.kickoffAfterReleaseMs >= 0 && run.kickoffAfterReleaseMs <= 50, { kickoffAfterReleaseMs: run.kickoffAfterReleaseMs });
        report.check(`run ${i}: exactly one text sent (the kickoff)`, run.textsSent === 1, { textsSent: run.textsSent });
        report.check(`run ${i}: first speechChunk is the reply, not the opening`, !!firstChunk && !isOpeningSpeechId(firstChunk.detail?.speechId), { speechId: firstChunk?.detail?.speechId });
      } else {
        report.check(`run ${i}: no text sent without a kickoff`, run.textsSent === 0, { textsSent: run.textsSent });
      }
      if (mediaMode !== 'audio') {
        if (run.negotiated && !videoNegotiated) {
          // The browser and the media server share no video codec (or the section was refused), so no
          // frame can arrive. That is a negotiation fact, recorded with the codecs each side offered.
          report.check(`run ${i}: video negotiated with the media server`, false, { answer: videoSection, browserOffered: offeredVideoCodecs, engine: run.engine });
        } else {
          report.check(`run ${i}: a video frame was decoded and rendered`, run.videoFirstFrameMs !== null && run.firstDecodedFrameMs !== null, { videoFirstFrameMs: run.videoFirstFrameMs, firstDecodedFrameMs: run.firstDecodedFrameMs, negotiated: videoSection });
        }
      }
      // Without a kickoff and with a silent opening the only speech is the silent opening itself,
      // so "sound heard" is not expected; the silent-opening check above already covers that case.
      if (talkStart && (KICKOFF || OPENING)) {
        if (ctxRunning) report.check(`run ${i}: sound heard after avatarStartTalking`, run.talkToSoundMs !== null, { talkToSoundMs: run.talkToSoundMs, spans: run.soundSpans });
        else report.note(`run ${i}: analyser not running, audibility not measured`, { analyser: run.analyser, firstAudioPacketMs: run.firstAudioPacketMs });
      }
      const leaked = [...all(evs, 'transcript'), ...all(evs, 'speechChunk')].filter((e) => typeof e.detail?.text === 'string' && e.detail.text.includes(SILENT_OPENING));
      report.check(`run ${i}: silent opening never surfaces as text`, leaked.length === 0, { leaked: leaked.length });
      const whepBad = run.whep.filter((/** @type {string} */ l) => /^POST .*(FAILED|→ [45]\d\d)/.test(l));
      if (mediaMode !== 'audio') report.check(`run ${i}: every WHEP POST succeeded`, whepBad.length === 0, { whep: run.whep });
      report.note(`run ${i}: timings from connect()`, { connectMs: run.connectMs, stvIceMs: run.stvIceMs, trackVideoMs: run.trackVideoMs, videoFirstFrameMs: run.videoFirstFrameMs, firstWordsMs: run.firstWordsMs, firstSoundMs: run.firstSoundMs, talkToSoundMs: run.talkToSoundMs, pair: run.candidatePair, video: run.videoStats });

      await page.evaluate(() => /** @type {any} */ (window).testDisconnect()).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      const late = whepSummary(sink.network).filter((l) => !run.whep.includes(l));
      if (late.length) report.note(`run ${i}: WHEP after disconnect()`, late);
      run.whep = whepSummary(sink.network);
    } catch (err) {
      run.error = String(/** @type {any} */ (err)?.message || err);
      report.check(`run ${i}: completed`, false, { error: run.error, pageErrors: sink.pageErrors.slice(0, 5) });
    } finally {
      const problems = netProblems(sink.network);
      if (problems.length) report.note(`run ${i}: HTTP requests that failed or returned 4xx/5xx`, problems.slice(0, 10));
      if (sink.pageErrors.length) report.note(`run ${i}: page errors`, sink.pageErrors.slice(0, 5));
      report.data.runs.push(run);
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
  if (OPENING) await kaltura.intellectConfig.setOpeningPhrase(agent.configId, SILENT_OPENING, admin.ks).catch((e) => console.warn(`reset opening phrase failed: ${e?.message || e}`));
  await agent.cleanup();
}

const ok = report.data.runs.filter((r) => !r.error);
const col = (/** @type {string} */ k) => stats(ok.map((r) => r[k]).filter((x) => typeof x === 'number'));
const METRICS = /** @type {[string, string, string][]} */ ([
  ['connectMs', 'connect() resolved', BASELINE.connectMs],
  ['asrIceMs', 'ASR peer ICE connected', ''],
  ['stvIceMs', 'STV peer ICE connected', ''],
  ['trackAudioMs', 'remote audio track unmuted', ''],
  ['trackVideoMs', 'remote video track unmuted', ''],
  ['firstAudioPacketMs', 'first inbound audio packet (getStats)', ''],
  ['firstDecodedFrameMs', 'first decoded video frame (getStats)', ''],
  ['videoFirstFrameMs', 'first video frame presented (rVFC)', ''],
  ['videoPlayingMs', '<video> playing', ''],
  ['audioPlayingMs', '<audio> playing', ''],
  ['openingEndMs', 'opening avatarStopTalking', ''],
  ['kickoffAfterReleaseMs', 'opening stvFinishedTalking → kickoff on the wire', 'manual speak() after connect'],
  ['talkStartMs', 'avatarStartTalking (measured speech)', ''],
  ['firstWordsMs', 'first speechChunk (measured speech)', ''],
  ['firstWordsAfterConnectMs', '  …relative to connect resolved', BASELINE.firstWordsMs],
  ['firstSoundMs', 'sound heard (AnalyserNode)', ''],
  ['talkToSoundMs', 'avatarStartTalking → sound heard', ''],
]);
report.data.summary = Object.fromEntries(METRICS.map(([k]) => [k, col(k)]));
report.data.baseline = BASELINE;

const fmt = (/** @type {{min:any, median:any, max:any}} */ s) => (s.min === null ? 'n/a' : `${s.min} / ${s.median} / ${s.max}`);
const md = [
  `# connect timing — ${target.name} — ${report.meta.startedAt}`,
  '',
  `${RUNS} runs. ${SETUP}. Values are ms from connect() start as min / median / max unless stated.`,
  '',
  mdTable(['metric', 'measured', 'baseline (before)'], METRICS.map(([k, label, base]) => [label, fmt(report.data.summary[k]), base])),
  '',
  mdTable(['run', 'connect', 'stv ice', 'video unmute', 'first frame', 'video playing', 'opening end', 'kickoff Δ', 'first words', 'sound heard', 'talk→sound', 'pair', 'video codecs', 'error'],
    report.data.runs.map((r) => [r.n, r.connectMs ?? '', r.stvIceMs ?? '', r.trackVideoMs ?? '', r.videoFirstFrameMs ?? '', r.videoPlayingMs ?? '', r.openingEndMs ?? '', r.kickoffAfterReleaseMs ?? '', r.firstWordsMs ?? '', r.firstSoundMs ?? '', r.talkToSoundMs ?? '', r.candidatePair ?? '', (r.negotiated ?? []).filter((/** @type {any} */ m) => m.kind === 'video').map((/** @type {any} */ m) => (m.port === 0 ? 'rejected' : m.codecs.join('/') || 'none')).join(' ') || '', r.error ?? ''])),
  '',
  '## WHEP requests per run',
  '',
  ...report.data.runs.map((r) => `- run ${r.n}: ${(r.whep || []).join('; ') || 'none recorded'}`),
  '',
  '## Checks',
  '',
  mdTable(['result', 'check', 'detail'], report.checks.map((c) => [c.ok ? 'ok' : 'FAIL', c.name, c.detail === undefined ? '' : JSON.stringify(c.detail).replace(/\|/g, '\\|')])),
  '',
].join('\n');
report.write(outDir, md);
console.log(`\n${SETUP}\nconnect() ${fmt(report.data.summary.connectMs)} ms (baseline ${BASELINE.connectMs}); first words after connect ${fmt(report.data.summary.firstWordsAfterConnectMs)} ms (baseline ${BASELINE.firstWordsMs}); sound heard ${fmt(report.data.summary.firstSoundMs)} ms; first frame ${fmt(report.data.summary.videoFirstFrameMs)} ms`);
process.exit(report.failed ? 1 : 0);
