/**
 * Turn the raw results of an emotions eval into metrics, verdicts and insights.
 * Pure: the same results always give the same output. The report reads only what this returns.
 *
 * Results shape (written by scripts/live-eval-emotions.mjs):
 *   { schema:1, meta:{...}, scenarios:[{id, title, group, why, expectNeutral?, turns:[{accept, edge?}]}],
 *     turns:[{scenario, trial, turnIndex, mode:'on'|'off'|'avatar-off'|'send', prompt, ok, error, firstChunkMs, totalMs,
 *             segments:[{type, content, segmentStart, segmentEnd, isFinal, emotion?}]}],
 *     parserChecks:[{id, name, pass, detail}] }
 * A segment has an `emotion` key only when the chunk carried `metadata.emotion`.
 */
import { EMOTIONS } from './scenarios.mjs';
import { wilson, judge, zeroViolationBound, median, percentile, bootstrapMedianDiff } from './stats.mjs';

/** Targets for the soft dimensions. A rate passes when its 95% interval is on the right side of the target. */
export const THRESHOLDS = Object.freeze({
  coverage: { dir: 'atLeast', target: 0.8 },
  match: { dir: 'atLeast', target: 0.7 },
  avatarChunks: { dir: 'atLeast', target: 0.9 },
  neutralFalsePositive: { dir: 'atMost', target: 0.2 },
  emptyText: { dir: 'atMost', target: 0.05 },
  errors: { dir: 'atMost', target: 0.05 },
  repeatedLabel: { dir: 'atMost', target: 0.1 },
  sendCoverage: { dir: 'atLeast', target: 0.7 },
  latencyBudgetMs: 1500,
});

const VALID = new Set(EMOTIONS);

/** @param {any} seg */
const isAvatar = (seg) => seg && seg.type === 'avatar';
/** @param {any} seg */
const hasEmotion = (seg) => seg && Object.prototype.hasOwnProperty.call(seg, 'emotion');

/**
 * Facts about one turn.
 * @param {any} turn
 */
export function turnFacts(turn) {
  const segs = Array.isArray(turn?.segments) ? turn.segments.filter((s) => s && typeof s === 'object') : [];
  const avatarChunks = segs.filter(isAvatar);
  const starts = avatarChunks.filter((s) => s.segmentStart);
  const emoChunks = segs.filter(hasEmotion);
  const values = emoChunks.map((s) => s.emotion);
  const valid = values.filter((v) => typeof v === 'string' && VALID.has(v));
  const invalid = values.filter((v) => !(typeof v === 'string' && VALID.has(v)));
  const startLabels = starts.filter(hasEmotion).map((s) => s.emotion);
  let repeats = 0;
  for (let i = 1; i < startLabels.length; i++) if (startLabels[i] === startLabels[i - 1]) repeats++;
  const spoken = segs.filter((s) => (s.type === 'avatar' || s.type === 'text') && typeof s.content === 'string');
  const spokenChars = spoken.reduce((n, s) => n + s.content.trim().length, 0);
  const avatarSegments = starts.length || (avatarChunks.length ? 1 : 0);
  const errSeg = segs.find((s) => s.type === 'error');
  return {
    // A stream can end with an `error` chunk and still finish without a thrown error. That turn failed.
    ok: turn?.ok !== false && !turn?.error && !errSeg,
    streamError: errSeg ? String(errSeg.content ?? 'error').slice(0, 120) : null,
    avatarChunks: avatarChunks.length,
    avatarSegments,
    emotionChunks: emoChunks.length,
    values,
    valid,
    invalid,
    labelSet: [...new Set(valid)],
    misplaced: emoChunks.filter((s) => !(isAvatar(s) && s.segmentStart)).length,
    startLabels,
    repeats,
    spokenChars,
    empty: spokenChars === 0,
    textTag: spoken.some((s) => /\[\s*emotion\s*:/i.test(s.content)),
    toolSegments: segs.filter((s) => s.type === 'tool' || s.type === 'unisphere-tool').length,
    widgets: segs.filter((s) => s.type === 'unisphere-tool').length,
  };
}

/**
 * Did this turn show an acceptable label for its scenario turn?
 * @param {ReturnType<typeof turnFacts>} f @param {{accept?:string[]|null}|undefined} spec
 */
function matches(f, spec) {
  if (!f.valid.length) return false;
  if (!spec || !spec.accept) return true;
  return f.valid.some((v) => /** @type {string[]} */ (spec.accept).includes(v));
}

/** @param {number} k @param {number} n @param {{dir:string, target:number}} th */
function rateDim(k, n, th) {
  const ci = wilson(k, n);
  return { ...ci, dir: th.dir, target: th.target, status: judge(ci, /** @type {any} */ (th.dir), th.target) };
}

/**
 * Hard dimension: any violation fails. The interval is shown so a reader sees how little 0 of n proves.
 * @param {number} violations @param {number} n
 */
function hardDim(violations, n) {
  const ci = wilson(violations, n);
  return { violations, n, rate: n ? violations / n : null, upperBound: n ? (violations === 0 ? zeroViolationBound(n) : ci.hi) : null, status: n === 0 ? 'NO_DATA' : violations === 0 ? 'PASS' : 'FAIL' };
}

/** @param {any[]} turns @param {string} mode */
const byMode = (turns, mode) => turns.filter((t) => t.mode === mode);

/**
 * Analyze a results object.
 * @param {any} results
 */
export function analyze(results) {
  const scenarios = Array.isArray(results?.scenarios) ? results.scenarios : [];
  const allTurns = Array.isArray(results?.turns) ? results.turns : [];
  // A turn the server refused for rate limiting says nothing about the feature. Count it apart and keep it out of every metric.
  const throttledTurns = allTurns.filter((t) => t?.error?.code === 'rate_limited');
  const turns = allTurns.filter((t) => t?.error?.code !== 'rate_limited');
  const specOf = (/** @type {any} */ t) => scenarios.find((s) => s.id === t.scenario)?.turns?.[t.turnIndex];
  const facts = new Map(turns.map((t) => [t, turnFacts(t)]));
  const F = (/** @type {any} */ t) => /** @type {ReturnType<typeof turnFacts>} */ (facts.get(t));
  const on = byMode(turns, 'on');
  const off = byMode(turns, 'off');
  const avatarOff = byMode(turns, 'avatar-off');
  const send = byMode(turns, 'send');
  const scored = (/** @type {any} */ t) => specOf(t)?.edge !== 'empty';
  const onScored = on.filter(scored);

  // ── per scenario (mode "on") ──
  const perScenario = scenarios.map((sc) => {
    const ts = onScored.filter((t) => t.scenario === sc.id);
    const labelTurns = Object.fromEntries([...EMOTIONS, 'none', 'invalid'].map((l) => [l, 0]));
    let withEmotion = 0, matched = 0, success = 0, errors = 0, avatarTurns = 0, segs = 0, emoSegs = 0, repeats = 0;
    for (const t of ts) {
      const f = F(t);
      if (!f.ok) errors++;
      if (f.avatarChunks) avatarTurns++;
      segs += f.avatarSegments;
      emoSegs += f.startLabels.length;
      repeats += f.repeats;
      if (f.valid.length) withEmotion++; else labelTurns.none++;
      if (f.invalid.length) labelTurns.invalid++;
      for (const l of f.labelSet) labelTurns[l]++;
      const m = f.ok && matches(f, specOf(t));
      if (m) matched++;
      if (m && f.valid.length) success++;
    }
    // Trial success: every turn of the trial is a success.
    const trials = new Map();
    for (const t of ts) {
      const a = trials.get(t.trial) ?? { n: 0, good: 0 };
      a.n++;
      if (F(t).ok && F(t).valid.length && matches(F(t), specOf(t))) a.good++;
      trials.set(t.trial, a);
    }
    const trialCount = trials.size;
    const trialOk = [...trials.values()].filter((a) => a.n === a.good).length;
    const trialCi = wilson(trialOk, trialCount);
    return {
      id: sc.id, title: sc.title, group: sc.group, why: sc.why, expectNeutral: !!sc.expectNeutral,
      n: ts.length, errors, avatarTurns, withEmotion, matched, success,
      coverage: wilson(withEmotion, ts.length),
      success_ci: wilson(success, ts.length),
      trials: trialCount, trialSuccess: trialCi,
      passK3: trialCi.rate === null ? null : Math.pow(trialCi.rate, 3),
      labelTurns,
      avgAvatarSegments: ts.length ? segs / ts.length : null,
      density: segs ? emoSegs / segs : null,
      repeats,
      weak: ts.length > 0 && wilson(success, ts.length).hi < 0.5,
      flaky: ts.length >= 4 && wilson(success, ts.length).lo < 0.5 && wilson(success, ts.length).hi > 0.5 && success > 0 && success < ts.length,
    };
  });

  // ── pooled soft dimensions ──
  const all = onScored.map(F);
  const attempted = all.length;
  const withLabel = all.filter((f) => f.valid.length).length;
  const matchedGivenLabel = onScored.filter((t) => F(t).valid.length && matches(F(t), specOf(t))).length;
  const neutralTurns = onScored.filter((t) => scenarios.find((s) => s.id === t.scenario)?.expectNeutral && F(t).valid.length);
  const neutralFp = neutralTurns.filter((t) => F(t).valid.some((v) => v !== 'neutral')).length;
  const repeats = all.reduce((n, f) => n + f.repeats, 0);
  const repeatDenominator = all.reduce((n, f) => n + Math.max(f.startLabels.length - 1, 0), 0);

  const onOk = on.filter((t) => F(t).ok);
  const offOk = off.filter((t) => F(t).ok);
  const offTotal = offOk.map((t) => t.totalMs).filter(Number.isFinite);
  const onTotal = onOk.map((t) => t.totalMs).filter(Number.isFinite);
  const offFirst = offOk.map((t) => t.firstChunkMs).filter(Number.isFinite);
  const onFirst = onOk.map((t) => t.firstChunkMs).filter(Number.isFinite);
  const totalDiff = bootstrapMedianDiff(onTotal, offTotal);
  const firstDiff = bootstrapMedianDiff(onFirst, offFirst);
  const latency = {
    on: { total: median(onTotal), totalP90: percentile(onTotal, 0.9), first: median(onFirst), n: onTotal.length },
    off: { total: median(offTotal), totalP90: percentile(offTotal, 0.9), first: median(offFirst), n: offTotal.length },
    totalDiff, firstDiff,
    budgetMs: THRESHOLDS.latencyBudgetMs,
    status: !totalDiff ? 'NO_DATA' : totalDiff.hi <= THRESHOLDS.latencyBudgetMs ? 'PASS' : totalDiff.lo > THRESHOLDS.latencyBudgetMs ? 'FAIL' : 'INCONCLUSIVE',
  };
  const sendScored = send.filter(scored);

  const soft = {
    coverage: { name: 'Coverage: turns with at least one emotion', ...rateDim(withLabel, attempted, THRESHOLDS.coverage) },
    match: { name: 'Expected match: turns whose label is in the accepted set (of turns with a label)', ...rateDim(matchedGivenLabel, withLabel, THRESHOLDS.match) },
    avatarChunks: { name: 'Avatar chunks: turns that came back as avatar, not plain text', ...rateDim(all.filter((f) => f.avatarChunks).length, attempted, THRESHOLDS.avatarChunks) },
    neutralFalsePositive: { name: 'False positive on neutral topics (of labeled turns)', ...rateDim(neutralFp, neutralTurns.length, THRESHOLDS.neutralFalsePositive) },
    emptyText: { name: 'Empty text: turns with no spoken text', ...rateDim(all.filter((f) => f.ok && f.empty).length, attempted, THRESHOLDS.emptyText) },
    errors: { name: 'Errors: turns that failed', ...rateDim(all.filter((f) => !f.ok).length, attempted, THRESHOLDS.errors) },
    repeatedLabel: { name: 'Same label on two segments in a row (a label change should start a segment)', ...rateDim(repeats, repeatDenominator, THRESHOLDS.repeatedLabel) },
    sendCoverage: { name: 'Aggregate (send) path: turns with at least one emotion', ...rateDim(sendScored.filter((t) => F(t).valid.length).length, sendScored.length, THRESHOLDS.sendCoverage) },
    latency: { name: `Latency: median total time with emotions on minus off (budget ${THRESHOLDS.latencyBudgetMs} ms, 95% interval)`, status: latency.status, n: Math.min(onTotal.length, offTotal.length) },
  };

  // ── hard dimensions ──
  const allCapturedValues = [...on, ...avatarOff, ...send, ...off].flatMap((t) => F(t).values);
  const invalidValues = [...on, ...avatarOff, ...send, ...off].flatMap((t) => F(t).invalid);
  const parserChecks = Array.isArray(results?.parserChecks) ? results.parserChecks : [];
  const hard = {
    leakage: { name: 'Off-state leakage: turns with emotions off that carry any emotion', ...hardDim(offOk.filter((t) => F(t).emotionChunks > 0).length, offOk.length) },
    validity: { name: 'Validity: emotion values outside the four documented labels', ...hardDim(invalidValues.length, allCapturedValues.length) },
    placement: { name: 'Placement: emotion on a chunk that is not an avatar segment start', ...hardDim([...on, ...send].reduce((n, t) => n + F(t).misplaced, 0), [...on, ...send].reduce((n, t) => n + F(t).emotionChunks, 0)) },
    avatarOff: { name: 'Avatar off, emotions on: turns that still carry an emotion (must be refused or inert)', ...hardDim(avatarOff.filter((t) => F(t).ok && F(t).emotionChunks > 0).length, avatarOff.filter((t) => F(t).ok).length) },
    parser: { name: 'SDK parser checks (offline): checks that failed', ...hardDim(parserChecks.filter((c) => !c.pass).length, parserChecks.length) },
  };

  // How the avatar-off path really behaves, as an observation.
  const avatarOffOutcome = {
    refused: avatarOff.filter((t) => !F(t).ok).length,
    inert: avatarOff.filter((t) => F(t).ok && F(t).emotionChunks === 0).length,
    withEmotion: avatarOff.filter((t) => F(t).ok && F(t).emotionChunks > 0).length,
    errorCodes: [...new Set(avatarOff.filter((t) => !F(t).ok).map((t) => t.error?.code).filter(Boolean))],
  };

  const labelTotals = Object.fromEntries(EMOTIONS.map((l) => [l, 0]));
  for (const f of all) for (const v of f.startLabels) if (VALID.has(v)) labelTotals[v]++;
  const labelSum = Object.values(labelTotals).reduce((a, b) => a + b, 0);

  const emptyTurns = turns.filter((t) => !scored(t));
  const injection = onScored.filter((t) => t.scenario === 'injection');
  const extra = {
    labelTotals, labelSum,
    emptyTurn: { n: emptyTurns.length, refused: emptyTurns.filter((t) => !F(t).ok).length, replied: emptyTurns.filter((t) => F(t).ok).length },
    injection: { n: injection.length, textTags: injection.filter((t) => F(t).textTag).length, invalid: injection.reduce((n, t) => n + F(t).invalid.length, 0) },
    longReply: summarizeLong(onScored.filter((t) => t.scenario === 'long-reply').map(F)),
    topicShift: topicShift(onScored.filter((t) => t.scenario === 'topic-shift'), specOf, F),
    avatarOffOutcome,
    toolTurns: onScored.filter((t) => F(t).toolSegments > 0).length,
    streamErrors: (() => {
      const bad = turns.filter((t) => F(t).streamError);
      return { n: bad.length, message: bad.length ? F(bad[0]).streamError : '', scenarios: [...new Set(bad.map((t) => t.scenario))], medianToolCalls: median(bad.map((t) => F(t).toolSegments)) ?? 0, medianMs: median(bad.map((t) => t.totalMs).filter(Number.isFinite)) ?? 0 };
    })(),
    throttled: throttledTurns.length,
    retried: allTurns.filter((t) => t?.retries > 0).length,
    waitedMs: allTurns.reduce((n, t) => n + (Number.isFinite(t?.waitedMs) ? t.waitedMs : 0), 0),
    widgetOnly: onScored.filter((t) => F(t).widgets > 0 && F(t).avatarChunks === 0).length,
  };

  const model = { meta: results?.meta ?? {}, counts: { turns: turns.length, throttled: throttledTurns.length, on: on.length, off: off.length, avatarOff: avatarOff.length, send: send.length }, perScenario, soft, hard, latency, extra, thresholds: THRESHOLDS };
  const verdict = judgeAll(model);
  const insights = buildInsights(model);
  return { ...model, verdict, insights };
}

/** A reply with at least this many avatar chunks counts as long. */
const LONG_CHUNKS = 6;

/** @param {ReturnType<typeof turnFacts>[]} fs */
function summarizeLong(fs) {
  const long = fs.filter((f) => f.avatarChunks >= LONG_CHUNKS);
  const avg = (/** @type {ReturnType<typeof turnFacts>[]} */ xs, /** @type {(f:ReturnType<typeof turnFacts>)=>number} */ get) => (xs.length ? xs.reduce((n, f) => n + get(f), 0) / xs.length : null);
  return {
    n: fs.length, longTurns: long.length,
    oneLabelOnly: long.filter((f) => f.labelSet.length <= 1).length,
    avgChunks: avg(long, (f) => f.avatarChunks), avgSegments: avg(long, (f) => f.avatarSegments), avgDistinct: avg(long, (f) => f.labelSet.length),
  };
}

/** @param {any[]} ts @param {(t:any)=>any} specOf @param {(t:any)=>ReturnType<typeof turnFacts>} F */
function topicShift(ts, specOf, F) {
  const byTrial = new Map();
  for (const t of ts) byTrial.set(t.trial, [...(byTrial.get(t.trial) ?? []), t]);
  let pairs = 0, followed = 0;
  for (const list of byTrial.values()) {
    const a = list.find((t) => t.turnIndex === 0);
    const b = list.find((t) => t.turnIndex === 1);
    if (!a || !b) continue;
    pairs++;
    if (matches(F(a), specOf(a)) && matches(F(b), specOf(b))) followed++;
  }
  return { pairs, followed };
}

/** Roll the dimensions up into one verdict and an exit code. @param {any} model */
export function judgeAll(model) {
  const hard = Object.values(model.hard);
  const soft = Object.values(model.soft);
  const hardFail = hard.filter((d) => /** @type {any} */ (d).status === 'FAIL');
  const hardNoData = hard.filter((d) => /** @type {any} */ (d).status === 'NO_DATA');
  const softFail = soft.filter((d) => /** @type {any} */ (d).status === 'FAIL');
  const softInconclusive = soft.filter((d) => /** @type {any} */ (d).status === 'INCONCLUSIVE' || /** @type {any} */ (d).status === 'NO_DATA');
  if (hardFail.length) return { label: 'FAIL', exitCode: 1, tone: 'bad', summary: `${hardFail.length} hard dimension(s) failed. These must be 100%.` };
  if (hardNoData.length) return { label: 'INCOMPLETE', exitCode: 3, tone: 'warn', summary: `${hardNoData.length} hard dimension(s) had no data. Run with emotions-off trials and the other paths.` };
  if (softFail.length) return { label: 'SOFT FAIL', exitCode: 2, tone: 'bad', summary: `All hard dimensions pass. ${softFail.length} quality dimension(s) are confidently below target.` };
  if (softInconclusive.length) return { label: 'PASS WITH WARNINGS', exitCode: 0, tone: 'warn', summary: `All hard dimensions pass. ${softInconclusive.length} quality dimension(s) are not decided at this sample size.` };
  return { label: 'PASS', exitCode: 0, tone: 'good', summary: 'All hard dimensions pass and every quality dimension is above target.' };
}

/** @param {number|null} x */
const pct = (x) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`);

/**
 * Rules that read the numbers and say what stands out. Each rule returns zero or more lines.
 * @param {any} m
 * @returns {{level:'bad'|'warn'|'info', text:string}[]}
 */
export function buildInsights(m) {
  /** @type {{level:'bad'|'warn'|'info', text:string}[]} */
  const out = [];
  const sc = /** @type {any[]} */ (m.perScenario).filter((s) => s.n > 0);

  for (const [key, d] of Object.entries(m.hard)) {
    const dim = /** @type {any} */ (d);
    if (dim.status === 'FAIL') out.push({ level: 'bad', text: `Hard dimension failed: ${dim.name} (${dim.violations} of ${dim.n}).` });
    if (dim.status === 'NO_DATA') out.push({ level: 'warn', text: `No data for the hard dimension "${key}".` });
  }

  const ranked = [...sc].sort((a, b) => (a.success_ci.rate ?? 0) - (b.success_ci.rate ?? 0));
  const worst = ranked[0];
  if (worst && (worst.success_ci.rate ?? 1) < 0.7) {
    out.push({ level: worst.weak ? 'bad' : 'warn', text: `${worst.title}: ${worst.success}/${worst.n} turns showed an accepted emotion. This is the weakest scenario.` });
  }
  for (const s of sc) {
    if (s === worst) continue;
    if (s.coverage.n && s.withEmotion === 0) out.push({ level: 'bad', text: `${s.title}: no turn carried an emotion (${s.n} turns).` });
    else if (s.flaky) out.push({ level: 'warn', text: `${s.title}: unreliable. ${s.success}/${s.n} turns succeeded, so a single run proves little.` });
    else if (s.n >= 4 && s.weak) out.push({ level: 'bad', text: `${s.title}: ${s.success}/${s.n} turns showed an accepted emotion.` });
  }

  const av = /** @type {any} */ (m.soft.avatarChunks);
  if (av.n && av.k < av.n) out.push({ level: av.status === 'FAIL' ? 'bad' : 'warn', text: `${av.n - av.k} of ${av.n} turns came back as plain text instead of avatar chunks (${pct(av.rate)} avatar). A turn without avatar chunks cannot carry an emotion.` });

  const lr = m.extra.longReply;
  if (lr.n && lr.longTurns) {
    if (lr.oneLabelOnly === lr.longTurns) out.push({ level: 'warn', text: `Long replies: ${lr.longTurns} of ${lr.n} had ${lr.avgChunks.toFixed(0)} avatar chunks on average but one label for the whole reply (${lr.avgSegments.toFixed(1)} segment). The label does not follow a mood change inside a reply.` });
    else out.push({ level: 'info', text: `Long replies: ${lr.avgChunks.toFixed(0)} avatar chunks, ${lr.avgSegments.toFixed(1)} segments and ${lr.avgDistinct.toFixed(1)} distinct labels per reply on average.` });
  } else if (lr.n) {
    out.push({ level: 'info', text: 'No reply was long enough to test labels inside one reply (fewer than 6 avatar chunks).' });
  }

  if (m.extra.labelSum >= 10) {
    const top = Object.entries(m.extra.labelTotals).sort((a, b) => /** @type {number} */ (b[1]) - /** @type {number} */ (a[1]))[0];
    const share = /** @type {number} */ (top[1]) / m.extra.labelSum;
    if (share >= 0.6) out.push({ level: 'warn', text: `${pct(share)} of all labels are "${top[0]}". The feature leans on one label.` });
  }

  const nf = /** @type {any} */ (m.soft.neutralFalsePositive);
  if (nf.n && nf.k) out.push({ level: nf.status === 'FAIL' ? 'bad' : 'warn', text: `Neutral topics got a non-neutral label in ${nf.k} of ${nf.n} labeled turns.` });

  const ts = m.extra.topicShift;
  if (ts.pairs) out.push({ level: ts.followed / ts.pairs < 0.5 ? 'warn' : 'info', text: `Mood shift: the label followed the user in ${ts.followed} of ${ts.pairs} threads.` });

  if (m.extra.injection.n) {
    const inj = m.extra.injection;
    if (inj.invalid) out.push({ level: 'bad', text: `Prompt injection produced ${inj.invalid} emotion value(s) outside the enum.` });
    else if (inj.textTags) out.push({ level: 'info', text: `Prompt injection: the model wrote the fake tag into its spoken text in ${inj.textTags} of ${inj.n} turns. No fake value reached metadata.` });
    else out.push({ level: 'info', text: `Prompt injection: no fake value reached metadata (${inj.n} turns).` });
  }

  const ao = m.extra.avatarOffOutcome;
  const aoN = ao.refused + ao.inert + ao.withEmotion;
  if (aoN) {
    if (ao.withEmotion) out.push({ level: 'bad', text: `Avatar off with emotions on: ${ao.withEmotion} of ${aoN} turns still carried an emotion.` });
    else out.push({ level: 'info', text: `Avatar off with emotions on: ${ao.inert} turns inert, ${ao.refused} refused${ao.errorCodes.length ? ` (${ao.errorCodes.join(', ')})` : ''}. No emotion appeared.` });
  }

  if (m.extra.emptyTurn.n) {
    const e = m.extra.emptyTurn;
    out.push({ level: 'info', text: `Empty user turn: ${e.refused} refused, ${e.replied} answered (${e.n} tries).` });
  }

  const l = m.latency;
  if (l.totalDiff) {
    const d = Math.round(l.totalDiff.diff);
    out.push({ level: l.status === 'FAIL' ? 'bad' : 'info', text: `Latency: emotions on is ${d >= 0 ? '+' : ''}${d} ms at the median total time (95% interval ${Math.round(l.totalDiff.lo)} to ${Math.round(l.totalDiff.hi)} ms).` });
  }

  if (m.extra.throttled) out.push({ level: 'warn', text: `${m.extra.throttled} turn(s) were refused by the request limit even after waiting and retrying. They are left out of every metric. Lower --rate or run again.` });
  if (m.extra.retried) out.push({ level: 'info', text: `${m.extra.retried} turn(s) hit the request limit, waited and then ran (${Math.round(m.extra.waitedMs / 1000)} s of waiting in total).` });
  if (m.extra.streamErrors.n) {
    const e = m.extra.streamErrors;
    out.push({ level: 'warn', text: `${e.n} turn(s) ended with an error chunk ("${e.message}") in: ${e.scenarios.join(', ')}. Median ${e.medianToolCalls} tool calls and ${Math.round(e.medianMs / 1000)} s before the error.` });
  }
  if (m.extra.widgetOnly) out.push({ level: 'warn', text: `${m.extra.widgetOnly} turn(s) were answered with a widget and no avatar speech, so they carry no emotion.` });

  if (m.extra.toolTurns === 0 && sc.some((s) => s.id === 'tool-heavy')) out.push({ level: 'info', text: 'No tool call appeared in the tool scenario, so the tool path is untested in this run.' });

  const order = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}
