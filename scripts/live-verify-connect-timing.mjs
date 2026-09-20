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
 * KPIs. After the runs, the median of each startup KPI over the successful runs
 * is checked against a budget. A miss fails the script like any other check, so
 * a startup regression fails the CI job instead of hiding in a table:
 *
 *   connect() resolved                         ≤ 2500 ms   (2200–3600 before the concurrent connect path)
 *   first video frame presented (rVFC)         ≤ 2500 ms
 *   first audio (remote audio track unmuted)   ≤ 2500 ms
 *   first agent words after connect() resolved ≤ 1850 ms   (1750–1850 with a manual speak() nudge)
 *   sound heard (AnalyserNode)                 ≤ 5000 ms
 *
 * Budgets are ms from connect() start (first words: from connect() resolved).
 * Defaults were calibrated on prod with headless Chromium, Firefox and WebKit
 * (medians: connect 1.5–1.8 s, first frame 1.3–1.6 s, first audio 1.2–1.5 s,
 * first words after connect 1.0–1.6 s, sound heard 3.0–3.9 s) and leave headroom
 * for a slower CI runner. A KPI with no sample in the run set is reported as n/a
 * and skipped, not failed. The two speech KPIs are reported but not enforced
 * with `--opening` or `--no-kickoff`, because the first words are then the opening
 * line, not the agent's reply. The report carries the table under `## KPI`
 * (markdown) and `data.kpi` (JSON).
 *
 * Resource hints (`--hints`). An app can add `<link rel=preconnect|dns-prefetch|
 * preload|modulepreload>` tags to its `<head>` so the browser opens the socket
 * and WHEP connections, resolves the TURN host and fetches socket.io/the SDK
 * before any script runs. `--hints ab` measures whether that helps here: runs
 * alternate between the plain harness page (odd runs, "off") and the same page
 * with the hints injected (even runs, "on"; see `resourceHints()` in the shared
 * module for the exact tags, built from the init response at runtime). Each run
 * uses a fresh browser context, so connection pools and TLS sessions are cold
 * for both arms and only the OS DNS cache is shared. Every run also records
 * Resource Timing for the cross-origin requests (socket.io script, WHEP POST)
 * and the SDK module graph, and the report prints per-arm min / median / max
 * plus the on − off median delta.
 *
 * Usage
 *   node scripts/live-verify-connect-timing.mjs                 # --env prod, AGENTIC_* vars
 *   node scripts/live-verify-connect-timing.mjs --env nvq2 --env-file ../.env --runs 5
 *   node scripts/live-verify-connect-timing.mjs --env nvp1 --env-file ../.env --browser chrome
 *   node scripts/live-verify-connect-timing.mjs --browser firefox --opening 'Hello!' --no-kickoff
 *   node scripts/live-verify-connect-timing.mjs --env nvq2 --env-file ../.env --browser chrome --runs 10 --hints ab
 *
 * Flags
 *   --runs N                 default 5 (with --hints ab: total, half per arm)
 *   --browser B              chromium (default) | chrome | firefox | webkit
 *   --headed                 show the browser (chrome is always headed, audio audible)
 *   --hints H                off (default) | on (every run gets the hints) | ab (alternate off/on)
 *   --opening TEXT           spoken opening phrase instead of SILENT_OPENING (reset afterwards)
 *   --no-kickoff             connect without a kickoff (measures the opening only)
 *   --kickoff TEXT           kickoff text
 *   --mic M                  immediate (default) | deferred | denied
 *   --mode M                 avatar (default) | agent-avatar (KalturaAgentSession)
 *   --budget-K MS            override one KPI budget; K = connect | first-frame | first-audio | first-words | sound
 *   --no-budgets             report the KPIs without failing on them
 *   --out DIR --keep --agent-json PATH
 *
 * Artifacts (`--out`, default live-verify-artifacts/): <runId>.json + <runId>.md.
 * No ids, tokens or secrets are written to them.
 */
import {
  bootstrap, Report, mdTable, stats, management, ensureAgent, mintPageInit, startServer, resourceHints, SOCKET_IO_CDN,
  browserChoice, launchBrowser, contextOptions, openHarness, whepSummary, netProblems, waitFor, find, all, isOpeningSpeechId, textsSent, SILENT_OPENING,
} from './live-verify-kickoff-shared.mjs';

const { args, target, runId, outDir } = bootstrap(process.argv.slice(2), 'connect-timing');
const RUNS = Number(args.runs || 5);
const KICKOFF = args['no-kickoff'] === true ? null : (typeof args.kickoff === 'string' ? args.kickoff : 'Greet the user in one short sentence and ask how you can help.');
const OPENING = typeof args.opening === 'string' && args.opening.trim() ? args.opening : null;
const MIC = typeof args.mic === 'string' ? args.mic : undefined;   // undefined → harness default (WebKit: synthetic)
const MODE = typeof args.mode === 'string' ? args.mode : 'avatar';
const HINTS = typeof args.hints === 'string' ? args.hints : 'off';
if (MIC !== undefined && !['immediate', 'deferred', 'denied'].includes(MIC)) { console.error(`--mic ${MIC}: expected immediate, deferred or denied`); process.exit(1); }
if (!['avatar', 'agent-avatar'].includes(MODE)) { console.error(`--mode ${MODE}: expected avatar or agent-avatar`); process.exit(1); }
if (!['off', 'on', 'ab'].includes(HINTS)) { console.error(`--hints ${HINTS}: expected off, on or ab`); process.exit(1); }
const choice = browserChoice(args);
const BASELINE = { connectMs: '2200–3600', firstWordsMs: '1750–1850' };

/**
 * Startup KPIs: median over the successful runs must be ≤ budget (ms). See the header
 * for how the defaults were calibrated. `enforce: false` KPIs are reported only.
 * @typedef {{key:string, flag:string, label:string, budgetMs:number, enforce:boolean}} Kpi
 */
const SPEECH_KPI = !OPENING && !!KICKOFF;   // otherwise the first words are the opening line, not the reply
const ENFORCE = args['no-budgets'] !== true;
const KPIS = /** @type {Kpi[]} */ ([
  { key: 'connectMs', flag: 'connect', label: 'connect() resolved', budgetMs: 2500, enforce: ENFORCE },
  { key: 'videoFirstFrameMs', flag: 'first-frame', label: 'first video frame presented (rVFC)', budgetMs: 2500, enforce: ENFORCE },
  { key: 'trackAudioMs', flag: 'first-audio', label: 'first audio (remote audio track unmuted)', budgetMs: 2500, enforce: ENFORCE },
  { key: 'firstWordsAfterConnectMs', flag: 'first-words', label: 'first agent words after connect() resolved', budgetMs: 1850, enforce: ENFORCE && SPEECH_KPI },
  { key: 'firstSoundMs', flag: 'sound', label: 'sound heard (AnalyserNode)', budgetMs: 5000, enforce: ENFORCE && SPEECH_KPI },
]);
for (const k of KPIS) {
  const raw = args[`budget-${k.flag}`];
  if (raw === undefined) continue;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0) { console.error(`--budget-${k.flag} ${raw}: expected a positive integer (ms)`); process.exit(1); }
  k.budgetMs = ms;
}
const MIC_LABEL = MIC ?? (choice.browser === 'webkit' ? 'synthetic' : 'immediate');
const SETUP = `${choice.browser}${choice.headed || choice.browser === 'chrome' ? ' headed' : ' headless'}, mic ${MIC_LABEL}, opening ${OPENING ? `spoken (${JSON.stringify(OPENING)})` : 'silent'}, ${KICKOFF ? 'kickoff' : 'no kickoff'}, mode ${MODE}, resource hints ${HINTS === 'ab' ? 'A/B (odd runs off, even runs on)' : HINTS}`;
/** Which arm a run belongs to: `off` = plain page, `on` = page with resource hints in <head>. */
const armOf = (/** @type {number} */ i) => (HINTS === 'ab' ? (i % 2 === 0 ? 'on' : 'off') : HINTS);

const report = new Report({ runId, target: target.name, browser: choice.browser, headed: choice.headed || choice.browser === 'chrome', setup: SETUP });
report.data.runs = [];
const kaltura = management(target);
const admin = await kaltura.sessions.createAdminToken();
const agent = await ensureAgent(kaltura, admin.ks, { agentJson: typeof args['agent-json'] === 'string' ? args['agent-json'] : undefined, keep: !!args.keep });
report.note('agent', agent.reused ? 'reused --agent-json ids' : 'provisioned throwaway agent with SILENT_OPENING');
report.note('setup', SETUP);
if (OPENING) await kaltura.intellectConfig.setOpeningPhrase(agent.configId, OPENING, admin.ks);

// One init up front gives the backend origins: the hint tags are built from them, and the
// Resource Timing entries below are matched against them. Hostnames stay in memory only.
const mintInit = () => mintPageInit(kaltura, agent, target.genieUrl);
const firstInit = await mintInit();
const HINT_TAGS = resourceHints(firstInit);
report.data.hints = HINT_TAGS.map((h) => ({ rel: h.rel, as: h.as, crossorigin: h.crossorigin }));   // rels only, no hosts
if (HINTS !== 'off') report.note('resource hints under test', HINT_TAGS.map((h) => `${h.rel}${h.as ? ` as=${h.as}` : ''}${h.crossorigin ? ' crossorigin' : ''}`));

const { server, origin } = await startServer(mintInit, { hints: HINT_TAGS });
const browser = await launchBrowser(choice);

/**
 * Resource Timing view of one run, from `window.testResources()`.
 * - `scriptLoadMs`: socket.io script fetch (cross-origin CDN)
 * - `whepPostMs`: the STV WHEP POST (the one cross-origin `fetch()` on a `/whep/` path;
 *   its host comes from the server's session reply, so it is matched by path, not origin)
 * - `sdkLoadedAtMs`: last `/src/` module response end, ms since navigation start
 *   (a span measure would only widen when `modulepreload` starts the fetches earlier)
 * Connection-level fields (dns/tcp/tls, reused) are only present when the server
 * sends Timing-Allow-Origin; otherwise Resource Timing exposes duration alone.
 * @param {{entries: any[], hints: any[]}} res
 */
const resourceMetrics = (res) => {
  const cdn = res.entries.find((e) => e.url === SOCKET_IO_CDN);
  const whep = res.entries.find((e) => e.initiator === 'fetch' && !e.url.startsWith('/') && /\/whep(\/|\?|$)/.test(e.url));
  const sdk = res.entries.filter((e) => e.url.startsWith('/src/'));
  const sdkEnd = sdk.length ? Math.max(...sdk.map((e) => e.startMs + e.durationMs)) : null;
  return {
    scriptLoadMs: cdn?.durationMs ?? null,
    whepPostMs: whep?.durationMs ?? null,
    whepReusedConnection: whep?.reusedConnection ?? null,
    whepTao: whep?.tao ?? null,
    sdkLoadedAtMs: sdkEnd,
    sdkModules: sdk.length,
    crossOrigin: res.entries.filter((e) => !e.url.startsWith('/')).map((e) => ({ url: e.url.replace(/\?.*$/, ''), initiator: e.initiator, startRel: e.startRel, durationMs: e.durationMs, tao: e.tao, reused: e.reusedConnection })),
  };
};

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
    const arm = armOf(i);
    /** @type {Record<string, any>} */
    const run = { n: i, hints: arm };
    try {
      const page = await openHarness(context, origin, { mode: MODE, kickoff: KICKOFF ?? undefined, mic: MIC, hints: arm === 'on' ? 1 : undefined }, sink);
      const ready = await page.evaluate(() => /** @type {any} */ (window).__events.find((/** @type {any} */ e) => e.type === 'harness:ready')?.detail ?? null);
      run.hintTags = ready?.hintTags ?? null;
      run.pageReadyMs = ready?.sinceNavMs ?? null;
      report.check(`run ${i}: resource hints ${arm === 'on' ? 'present' : 'absent'} in <head> (${arm} arm)`, arm === 'on' ? run.hintTags === HINT_TAGS.length : run.hintTags === 0, { hintTags: run.hintTags, expected: arm === 'on' ? HINT_TAGS.length : 0 });
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
      const resources = resourceMetrics(await page.evaluate(() => /** @type {any} */ (window).testResources()));

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
        socketConnectMs: at(evs, 'socket:connect', T, { from: start.index }),
        scriptLoadMs: resources.scriptLoadMs,
        sdkLoadedAtMs: resources.sdkLoadedAtMs,
        whepPostMs: resources.whepPostMs,
        resources,
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
      report.note(`run ${i}: resources (hints ${arm})`, { pageReadyMs: run.pageReadyMs, scriptLoadMs: run.scriptLoadMs, sdkLoadedAtMs: run.sdkLoadedAtMs, sdkModules: resources.sdkModules, socketConnectMs: run.socketConnectMs, whepPostMs: run.whepPostMs, whepTao: resources.whepTao, whepReusedConnection: resources.whepReusedConnection });

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
const col = (/** @type {string} */ k, /** @type {Record<string, any>[]} */ rows = ok) => stats(rows.map((r) => r[k]).filter((x) => typeof x === 'number'));
const METRICS = /** @type {[string, string, string][]} */ ([
  ['pageReadyMs', 'page ready (navigation → harness ready)', ''],
  ['scriptLoadMs', 'socket.io script fetch (Resource Timing)', ''],
  ['sdkLoadedAtMs', 'SDK module graph loaded, since navigation (Resource Timing)', ''],
  ['socketConnectMs', 'socket connected', ''],
  ['whepPostMs', 'WHEP POST round trip (Resource Timing)', ''],
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

// KPI budgets: one check per enforced KPI on the median, so a regression fails the run.
report.data.kpi = KPIS.map((k) => {
  const s = report.data.summary[k.key];
  const measured = typeof s.median === 'number';
  const within = measured ? s.median <= k.budgetMs : null;
  let status = 'n/a';
  if (measured && k.enforce) status = within ? 'ok' : 'FAIL';
  else if (measured) status = within ? 'ok (not enforced)' : 'over budget (not enforced)';
  const detail = { medianMs: s.median, minMs: s.min, maxMs: s.max, n: s.n, budgetMs: k.budgetMs };
  if (measured && k.enforce) report.check(`KPI: median ${k.label} ≤ ${k.budgetMs} ms`, within === true, detail);
  else report.note(`KPI: ${k.label} ${measured ? 'reported only, budget not enforced' : 'not measured in this run set'}`, detail);
  return { key: k.key, label: k.label, medianMs: s.median, minMs: s.min, maxMs: s.max, n: s.n, budgetMs: k.budgetMs, enforced: k.enforce && measured, ok: within, status };
});
const kpiMd = [
  '## KPI',
  '',
  `Median over the ${ok.length} successful run${ok.length === 1 ? '' : 's'} vs budget, ms from connect() start (first words: from connect() resolved). ${ENFORCE ? 'An enforced KPI over budget fails the run.' : 'Budgets not enforced (--no-budgets).'}`,
  '',
  mdTable(['KPI', 'median', 'budget', 'min / max', 'result'], report.data.kpi.map((k) => [k.label, k.medianMs ?? 'n/a', `≤ ${k.budgetMs}`, k.medianMs === null ? '' : `${k.minMs} / ${k.maxMs}`, k.status])),
  '',
];
const kpiLine = report.data.kpi.map((k) => `${k.label.replace(/ \(.*\)$/, '')} ${k.medianMs ?? 'n/a'}${k.medianMs === null ? '' : ` ≤ ${k.budgetMs}`} ${k.status}`).join('; ');

// A/B: per-arm stats and the on − off median delta (negative = hints made it faster).
/** @type {string[]} */
let abMd = [];
let abLine = '';
if (HINTS === 'ab') {
  const off = ok.filter((r) => r.hints === 'off');
  const on = ok.filter((r) => r.hints === 'on');
  const delta = (/** @type {string} */ k) => { const a = col(k, off).median; const b = col(k, on).median; return typeof a === 'number' && typeof b === 'number' ? b - a : null; };
  report.data.ab = Object.fromEntries(METRICS.map(([k]) => [k, { off: col(k, off), on: col(k, on), deltaMedianMs: delta(k) }]));
  const sign = (/** @type {number|null} */ d) => (d === null ? 'n/a' : `${d > 0 ? '+' : ''}${d}`);
  abMd = [
    `## Resource hints A/B (${off.length} runs off, ${on.length} runs on)`,
    '',
    'Hints under test: ' + HINT_TAGS.map((h) => `\`${h.rel}${h.as ? ` as=${h.as}` : ''}${h.crossorigin ? ' crossorigin' : ''}\``).join(', ') + '. Delta is the on − off median; negative means the hints made it faster.',
    '',
    mdTable(['metric', 'off (min / median / max)', 'on (min / median / max)', 'Δ median'], METRICS.map(([k, label]) => [label, fmt(report.data.ab[k].off), fmt(report.data.ab[k].on), sign(report.data.ab[k].deltaMedianMs)])),
    '',
  ];
  abLine = `\nhints A/B, Δ median (on − off): connect ${sign(delta('connectMs'))} ms; socket ${sign(delta('socketConnectMs'))} ms; WHEP POST ${sign(delta('whepPostMs'))} ms; stv ice ${sign(delta('stvIceMs'))} ms; first frame ${sign(delta('videoFirstFrameMs'))} ms; first words ${sign(delta('firstWordsMs'))} ms; sound ${sign(delta('firstSoundMs'))} ms`;
}

const md = [
  `# connect timing — ${target.name} — ${report.meta.startedAt}`,
  '',
  `${RUNS} runs. ${SETUP}. Values are ms from connect() start as min / median / max unless stated.`,
  '',
  ...kpiMd,
  '## All timings',
  '',
  mdTable(['metric', 'measured', 'baseline (before)'], METRICS.map(([k, label, base]) => [label, fmt(report.data.summary[k]), base])),
  '',
  ...abMd,
  mdTable(['run', 'hints', 'page ready', 'socket', 'whep post', 'connect', 'stv ice', 'video unmute', 'first frame', 'video playing', 'opening end', 'kickoff Δ', 'first words', 'sound heard', 'talk→sound', 'pair', 'video codecs', 'error'],
    report.data.runs.map((r) => [r.n, r.hints ?? '', r.pageReadyMs ?? '', r.socketConnectMs ?? '', r.whepPostMs ?? '', r.connectMs ?? '', r.stvIceMs ?? '', r.trackVideoMs ?? '', r.videoFirstFrameMs ?? '', r.videoPlayingMs ?? '', r.openingEndMs ?? '', r.kickoffAfterReleaseMs ?? '', r.firstWordsMs ?? '', r.firstSoundMs ?? '', r.talkToSoundMs ?? '', r.candidatePair ?? '', (r.negotiated ?? []).filter((/** @type {any} */ m) => m.kind === 'video').map((/** @type {any} */ m) => (m.port === 0 ? 'rejected' : m.codecs.join('/') || 'none')).join(' ') || '', r.error ?? ''])),
  '',
  '## Cross-origin resources per run (Resource Timing)',
  '',
  ...report.data.runs.map((r) => `- run ${r.n} (hints ${r.hints}): ${(r.resources?.crossOrigin ?? []).map((/** @type {any} */ e) => `${e.initiator} ${e.url} +${e.startRel} ms, ${e.durationMs} ms${e.tao ? (e.reused ? ', reused connection' : ', new connection') : ''}`).join('; ') || 'none recorded'}`),
  '',
  '## WHEP requests per run',
  '',
  ...report.data.runs.map((r) => `- run ${r.n}: ${(r.whep || []).join('; ') || 'none recorded'}`),
  '',
  '## Checks',
  '',
  mdTable(['result', 'check', 'detail'], report.checks.map((c) => [c.ok ? 'ok' : 'FAIL', c.name, c.detail === undefined ? '' : JSON.stringify(c.detail)])),
  '',
].join('\n');
report.write(outDir, md);
console.log(`\n${SETUP}\nconnect() ${fmt(report.data.summary.connectMs)} ms (baseline ${BASELINE.connectMs}); first words after connect ${fmt(report.data.summary.firstWordsAfterConnectMs)} ms (baseline ${BASELINE.firstWordsMs}); sound heard ${fmt(report.data.summary.firstSoundMs)} ms; first frame ${fmt(report.data.summary.videoFirstFrameMs)} ms${abLine}\nKPI (median ≤ budget): ${kpiLine}`);
process.exit(report.failed ? 1 : 0);
