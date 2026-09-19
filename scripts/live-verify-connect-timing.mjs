#!/usr/bin/env node
/**
 * Live connect-timing verification for the silent-opening + kickoff pattern.
 *
 * Provisions a throwaway agent whose opening phrase is SILENT_OPENING, opens
 * `scripts/live-verify-kickoff.html` in headless Chromium (fake mic), connects
 * with a `kickoff`, and measures the real startup path `--runs` times.
 *
 * Per run it asserts:
 *   1. connect() resolves
 *   2. connect-resolved → opening avatarStopTalking < 1500 ms
 *   3. kickoff leaves the client ≤ 50 ms after the opening's stvFinishedTalking arrives
 *   4. the first speechChunk is on a non-opening speech id (real reply, not the opening)
 *   5. no transcript/speechChunk payload ever contains the silent-opening text
 * and records connect() total, connect-resolved → first words, plus min/median/max.
 *
 * Baseline before this pattern (same QA backend, fake mic, hand-timed with a
 * speak() nudge after connect): connect() 2.2–3.6 s, connect-resolved → first
 * words 1.75–1.85 s. The markdown artifact prints this baseline next to the
 * measured numbers so a regression is visible without opening the JSON.
 *
 * Usage
 *   node scripts/live-verify-connect-timing.mjs                 # --env prod, AGENTIC_* vars
 *   node scripts/live-verify-connect-timing.mjs --env nvq2 --env-file ../.env --runs 5
 *   flags: --runs N (default 5) --out DIR --keep --agent-json PATH --kickoff TEXT
 *
 * Artifacts (`--out`, default live-verify-artifacts/): <runId>.json + <runId>.md.
 * No ids, tokens or secrets are written to them.
 */
import {
  bootstrap, Report, mdTable, stats, management, ensureAgent, mintPageInit, startServer,
  launchBrowser, openHarness, waitFor, find, all, isOpeningSpeechId, textsSent, SILENT_OPENING,
} from './live-verify-kickoff-shared.mjs';

const { args, target, runId, outDir } = bootstrap(process.argv.slice(2), 'connect-timing');
const RUNS = Number(args.runs || 5);
const KICKOFF = typeof args.kickoff === 'string' ? args.kickoff : 'Greet the user in one short sentence and ask how you can help.';
const BASELINE = { connectMs: '2200–3600', firstWordsMs: '1750–1850' };

const report = new Report({ runId, target: target.name });
report.data.runs = [];
const kaltura = management(target);
const admin = await kaltura.sessions.createAdminToken();
const agent = await ensureAgent(kaltura, admin.ks, { agentJson: typeof args['agent-json'] === 'string' ? args['agent-json'] : undefined, keep: !!args.keep });
report.note('agent', agent.reused ? 'reused --agent-json ids' : 'provisioned throwaway agent with SILENT_OPENING');

const { server, origin } = await startServer(() => mintPageInit(kaltura, agent, target.genieUrl));
const browser = await launchBrowser();

try {
  for (let i = 1; i <= RUNS; i++) {
    const context = await browser.newContext({ permissions: ['microphone'] });
    const sink = { pageErrors: [] };
    const run = { n: i };
    try {
      const page = await openHarness(context, origin, { mode: 'avatar', kickoff: KICKOFF }, sink);
      const connect = await page.evaluate(() => /** @type {any} */ (window).testConnect());
      report.check(`run ${i}: connect() resolved`, connect.ok, connect.ok ? undefined : connect);
      if (!connect.ok) { run.error = connect; continue; }

      // Wait for the reply to start: first speechChunk on a non-opening speech id.
      const { events: evs } = await waitFor(page, (e) => find(e, 'speechChunk', { where: (d) => !isOpeningSpeechId(d?.speechId) }), 30_000, 'first reply speechChunk');
      // Give the opening's stop event a moment if it raced the first chunk.
      const start = find(evs, 'connect:start');
      const resolved = find(evs, 'connect:resolved');
      const openingStop = find(evs, 'avatarStopTalking', { from: start.index });
      const openingFinished = find(evs, 'socket:in', { from: start.index, where: (d) => d.ev === 'stvFinishedTalking' });
      const kickoffOut = find(evs, 'socket:out', { from: start.index, where: (d) => d.ev === 'onTextEntered' && d.text === KICKOFF });
      const firstChunk = find(evs, 'speechChunk', { where: (d) => !isOpeningSpeechId(d?.speechId) });
      const firstStart = find(evs, 'avatarStartTalking', { from: openingStop ? openingStop.index + 1 : start.index });

      run.connectMs = resolved.tRel - start.tRel;
      run.openingMs = openingStop ? openingStop.tRel - resolved.tRel : null;
      run.kickoffAfterReleaseMs = kickoffOut && openingFinished ? kickoffOut.tRel - openingFinished.tRel : null;
      run.firstWordsMs = firstChunk.tRel - resolved.tRel;
      run.firstAudioMs = firstStart ? firstStart.tRel - resolved.tRel : null;
      run.textsSent = textsSent(evs).length;

      report.check(`run ${i}: opening ended < 1500 ms after connect resolved`, run.openingMs !== null && run.openingMs < 1500, { openingMs: run.openingMs });
      report.check(`run ${i}: kickoff sent ≤ 50 ms after opening stvFinishedTalking`, run.kickoffAfterReleaseMs !== null && run.kickoffAfterReleaseMs >= 0 && run.kickoffAfterReleaseMs <= 50, { kickoffAfterReleaseMs: run.kickoffAfterReleaseMs });
      report.check(`run ${i}: exactly one text sent (the kickoff)`, run.textsSent === 1, { textsSent: run.textsSent });
      report.check(`run ${i}: first speechChunk is the reply, not the opening`, !isOpeningSpeechId(firstChunk.detail?.speechId), { speechId: firstChunk.detail?.speechId });
      const leaked = [...all(evs, 'transcript'), ...all(evs, 'speechChunk')].filter((e) => typeof e.detail?.text === 'string' && e.detail.text.includes(SILENT_OPENING));
      report.check(`run ${i}: silent opening never surfaces as text`, leaked.length === 0, { leaked: leaked.length });
      report.note(`run ${i}: timings`, { connectMs: run.connectMs, firstWordsMs: run.firstWordsMs, firstAudioMs: run.firstAudioMs });

      await page.evaluate(() => /** @type {any} */ (window).testDisconnect()).catch(() => {});
    } catch (err) {
      run.error = String(/** @type {any} */ (err)?.message || err);
      report.check(`run ${i}: completed`, false, { error: run.error, pageErrors: sink.pageErrors.slice(0, 5) });
    } finally {
      if (sink.pageErrors.length) report.note(`run ${i}: page errors`, sink.pageErrors.slice(0, 5));
      report.data.runs.push(run);
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
  await agent.cleanup();
}

const ok = report.data.runs.filter((r) => !r.error);
const summary = {
  connectMs: stats(ok.map((r) => r.connectMs)),
  openingMs: stats(ok.map((r) => r.openingMs).filter((x) => x !== null)),
  kickoffAfterReleaseMs: stats(ok.map((r) => r.kickoffAfterReleaseMs).filter((x) => x !== null)),
  firstWordsMs: stats(ok.map((r) => r.firstWordsMs)),
  firstAudioMs: stats(ok.map((r) => r.firstAudioMs).filter((x) => x !== null)),
};
report.data.summary = summary;
report.data.baseline = BASELINE;

const fmt = (/** @type {{min:any, median:any, max:any}} */ s) => (s.min === null ? 'n/a' : `${s.min} / ${s.median} / ${s.max}`);
const md = [
  `# connect timing — ${target.name} — ${report.meta.startedAt}`,
  '',
  `${RUNS} runs, headless Chromium with a fake mic, silent opening + kickoff. Values are ms as min / median / max.`,
  '',
  mdTable(['metric', 'measured', 'baseline (before)'], [
    ['connect() total', fmt(summary.connectMs), BASELINE.connectMs],
    ['connect resolved → opening ended', fmt(summary.openingMs), 'n/a (spoken opening ran several seconds)'],
    ['opening stvFinishedTalking → kickoff on the wire', fmt(summary.kickoffAfterReleaseMs), 'manual speak() after connect'],
    ['connect resolved → first reply audio', fmt(summary.firstAudioMs), '—'],
    ['connect resolved → first reply words', fmt(summary.firstWordsMs), BASELINE.firstWordsMs],
  ]),
  '',
  mdTable(['run', 'connect', 'opening', 'kickoff after release', 'first audio', 'first words', 'error'],
    report.data.runs.map((r) => [r.n, r.connectMs ?? '', r.openingMs ?? '', r.kickoffAfterReleaseMs ?? '', r.firstAudioMs ?? '', r.firstWordsMs ?? '', r.error ?? ''])),
  '',
  `## Checks`,
  '',
  mdTable(['result', 'check', 'detail'], report.checks.map((c) => [c.ok ? 'ok' : 'FAIL', c.name, c.detail === undefined ? '' : JSON.stringify(c.detail)])),
  '',
].join('\n');
report.write(outDir, md);
console.log(`\nconnect() ${fmt(summary.connectMs)} ms (baseline ${BASELINE.connectMs}); first words ${fmt(summary.firstWordsMs)} ms (baseline ${BASELINE.firstWordsMs})`);
process.exit(report.failed ? 1 : 0);
