import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, turnFacts, judgeAll, buildInsights, runNotes, THRESHOLDS } from '../../scripts/lib/emotion-eval/analyze.mjs';
import { runParserChecks } from '../../scripts/lib/emotion-eval/parser-checks.mjs';
import { avatar, scenario, turn, many, results, healthyRun, GOOD_PARSER } from '../fakes/emotion-results.js';

/** The emotions eval: turn facts, dimensions, verdicts, insights. */

const chunk = (type, content, extra = {}) => ({ type, content, segmentStart: false, segmentEnd: false, isFinal: false, ...extra });

// ── turnFacts ───────────────────────────────────────────────────────────────

test('turnFacts reads labels, placement, repeats and spoken text', () => {
  const f = turnFacts(turn({ segments: [...avatar('One.', 'sad'), ...avatar('Two.', 'sad'), ...avatar('Three.', 'happy')] }));
  assert.equal(f.avatarSegments, 3);
  assert.deepEqual(f.startLabels, ['sad', 'sad', 'happy']);
  assert.equal(f.repeats, 1);
  assert.equal(f.misplaced, 0);
  assert.deepEqual(f.labelSet.sort(), ['happy', 'sad']);
  assert.equal(f.empty, false);
});

test('turnFacts flags an invalid value, a misplaced emotion, a text tag and an empty reply', () => {
  const bad = turnFacts(turn({ segments: [chunk('avatar', 'x', { segmentStart: true, emotion: 'furious' }), chunk('avatar', 'y', { emotion: 'sad' }), chunk('text', 'see [emotion: furious]')] }));
  assert.deepEqual(bad.invalid, ['furious']);
  assert.equal(bad.misplaced, 1);
  assert.equal(bad.textTag, true);
  assert.equal(turnFacts(turn({ segments: [chunk('avatar', '   ', { segmentStart: true })] })).empty, true);
  assert.equal(turnFacts(turn({ segments: [] })).empty, true);
});

test('turnFacts survives missing fields', () => {
  for (const t of [undefined, null, {}, { segments: null }, { segments: [null, undefined, {}] }]) {
    const f = turnFacts(t);
    assert.equal(typeof f.ok, 'boolean');
    assert.equal(f.emotionChunks, 0);
  }
  assert.equal(turnFacts({ ok: false, segments: [] }).ok, false);
  assert.equal(turnFacts({ error: { code: 'x' }, segments: [] }).ok, false);
});

test('turnFacts counts one segment when avatar chunks have no segmentStart', () => {
  assert.equal(turnFacts(turn({ segments: [chunk('avatar', 'a'), chunk('avatar', 'b')] })).avatarSegments, 1);
});

// ── edge cases of analyze ───────────────────────────────────────────────────

test('analyze copes with no input at all', () => {
  for (const input of [undefined, null, {}, results()]) {
    const a = analyze(input);
    assert.equal(a.counts.turns, 0);
    assert.equal(a.verdict.label, 'INCOMPLETE');
    assert.equal(a.verdict.exitCode, 3);
    assert.equal(a.hard.leakage.status, 'NO_DATA');
    assert.equal(a.soft.coverage.status, 'NO_DATA');
    assert.equal(a.latency.status, 'NO_DATA');
    assert.ok(a.insights.some((i) => /No data for the hard dimension/.test(i.text)));
  }
});

test('analyze copes with turns that miss every optional field', () => {
  const a = analyze({ scenarios: [{ id: 'joy', turns: [{}] }], turns: [{ scenario: 'joy', mode: 'on' }, { mode: 'off' }, { scenario: 'nope', mode: 'send' }] });
  assert.equal(a.counts.turns, 3);
  assert.equal(a.perScenario[0].n, 1);
  assert.equal(a.perScenario[0].coverage.k, 0);
});

test('a healthy run passes every dimension', () => {
  const a = analyze(healthyRun());
  for (const [k, d] of Object.entries(a.hard)) assert.equal(d.status, 'PASS', k);
  for (const [k, d] of Object.entries(a.soft)) assert.equal(d.status, 'PASS', `${k}: ${JSON.stringify(d)}`);
  assert.equal(a.verdict.label, 'PASS');
  assert.equal(a.verdict.exitCode, 0);
  assert.equal(a.hard.leakage.n, 40);
  assert.ok(a.hard.leakage.upperBound < 0.08);
  assert.equal(a.perScenario.find((s) => s.id === 'joy').passK3 > 0.9, true);
});

test('a small sample is undecided, not passed (9 of 9 is not enough for an 80% target)', () => {
  const a = analyze(healthyRun(3));
  assert.equal(a.soft.coverage.status, 'INCONCLUSIVE');
  assert.equal(a.verdict.label, 'PASS WITH WARNINGS');
  assert.equal(a.verdict.exitCode, 0);
});

test('all turns failing gives a soft failure, not a hard one, once hard data exists', () => {
  const sc = scenario('joy', [['happy']], { send: true });
  const turns = [
    ...many(30, (t) => turn({ trial: t, ok: false, error: { code: 'timeout', message: 'slow' }, segments: [] })),
    ...many(5, (t) => turn({ trial: t, mode: 'off', segments: avatar('Hi.') })),
    ...many(5, (t) => turn({ trial: t, mode: 'avatar-off', segments: [chunk('text', 'Hi.')] })),
    turn({ trial: 99, segments: avatar('Hi.', 'happy') }),
  ];
  const a = analyze(results({ scenarios: [sc], turns, parserChecks: GOOD_PARSER }));
  assert.equal(a.soft.errors.status, 'FAIL');
  assert.equal(a.soft.coverage.status, 'FAIL');
  assert.equal(a.perScenario[0].weak, true);
  assert.equal(a.verdict.label, 'SOFT FAIL');
  assert.equal(a.verdict.exitCode, 2);
});

test('hard failures: leakage, invalid value, misplaced emotion, avatar-off emotion, failed parser check', () => {
  const sc = scenario('joy', [['happy']]);
  const base = (extra) => results({ scenarios: [sc], turns: extra, parserChecks: GOOD_PARSER });
  const leak = analyze(base([turn({ mode: 'off', segments: avatar('Hi.', 'happy') })]));
  assert.equal(leak.hard.leakage.status, 'FAIL');
  assert.equal(leak.verdict.label, 'FAIL');
  assert.equal(leak.verdict.exitCode, 1);
  assert.ok(leak.insights.some((i) => i.level === 'bad' && /Off-state leakage/.test(i.text)));

  const invalid = analyze(base([turn({ segments: avatar('Hi.', 'furious') })]));
  assert.equal(invalid.hard.validity.status, 'FAIL');
  assert.equal(invalid.hard.validity.violations, 1);

  const misplaced = analyze(base([turn({ segments: [chunk('avatar', 'a', { segmentStart: true }), chunk('avatar', 'b', { emotion: 'sad' })] })]));
  assert.equal(misplaced.hard.placement.status, 'FAIL');

  const ao = analyze(base([turn({ mode: 'avatar-off', segments: avatar('Hi.', 'happy') })]));
  assert.equal(ao.hard.avatarOff.status, 'FAIL');
  assert.ok(ao.insights.some((i) => /Avatar off with emotions on: 1 of 1/.test(i.text)));

  const parser = analyze(results({ scenarios: [sc], turns: [turn({})], parserChecks: [{ id: 'x', name: 'x', pass: false, detail: 'd' }] }));
  assert.equal(parser.hard.parser.status, 'FAIL');
});

test('hard dimensions fail on a single violation however many clean turns there are', () => {
  const sc = scenario('joy', [['happy']]);
  const turns = [...many(500, (t) => turn({ trial: t, mode: 'off', segments: avatar('Hi.') })), turn({ trial: 501, mode: 'off', segments: avatar('Hi.', 'sad') })];
  const a = analyze(results({ scenarios: [sc], turns, parserChecks: GOOD_PARSER }));
  assert.equal(a.hard.leakage.violations, 1);
  assert.equal(a.hard.leakage.status, 'FAIL');
});

test('the empty-turn edge case is kept out of the coverage numbers', () => {
  const sc = scenario('empty-turn', [null], {});
  sc.turns[0].edge = 'empty';
  const a = analyze(results({ scenarios: [sc], turns: [turn({ scenario: 'empty-turn', ok: false, error: { code: 'bad_request' }, segments: [] })], parserChecks: GOOD_PARSER }));
  assert.equal(a.perScenario[0].n, 0);
  assert.equal(a.soft.coverage.n, 0);
  assert.deepEqual(a.extra.emptyTurn, { n: 1, refused: 1, replied: 0 });
  assert.ok(a.insights.some((i) => /Empty user turn: 1 refused, 0 answered/.test(i.text)));
});

// ── insights ────────────────────────────────────────────────────────────────

test('insights name the weakest scenario with its counts', () => {
  const sarcasm = scenario('sarcasm', [['neutral', 'sad']], { title: 'Sarcasm' });
  const joy = scenario('joy', [['happy']], { title: 'Joy' });
  const turns = [
    ...many(8, (t) => turn({ scenario: 'sarcasm', trial: t, segments: avatar('Great!', t <= 2 ? 'sad' : 'happy') })),
    ...many(8, (t) => turn({ scenario: 'joy', trial: t, segments: avatar('Great!', 'happy') })),
  ];
  const a = analyze(results({ scenarios: [sarcasm, joy], turns, parserChecks: GOOD_PARSER }));
  assert.ok(a.insights.some((i) => i.text === 'Sarcasm: 2/8 turns showed an accepted emotion. This is the weakest scenario.'), JSON.stringify(a.insights));
  assert.equal(a.perScenario[0].success, 2);
  assert.equal(a.insights[0].level === 'bad' || a.insights[0].level === 'warn', true);
});

test('insights: a scenario with no label at all, a flaky one, and a weak one that is not the worst', () => {
  const sc = (id) => scenario(id, [['happy']], { title: id });
  const turns = [
    ...many(6, (t) => turn({ scenario: 'worst', trial: t, segments: avatar('x', 'sad') })),
    ...many(6, (t) => turn({ scenario: 'none', trial: t, segments: avatar('x') })),
    ...many(8, (t) => turn({ scenario: 'flaky', trial: t, segments: avatar('x', t % 2 ? 'happy' : 'sad') })),
    ...many(12, (t) => turn({ scenario: 'weak', trial: t, segments: avatar('x', t === 1 ? 'happy' : 'sad') })),
  ];
  const a = analyze(results({ scenarios: ['worst', 'none', 'flaky', 'weak'].map(sc), turns, parserChecks: GOOD_PARSER }));
  const text = a.insights.map((i) => i.text).join('\n');
  assert.match(text, /none: no turn carried an emotion \(6 turns\)/);
  assert.match(text, /flaky: unreliable\. 4\/8 turns succeeded/);
  assert.match(text, /weak: 1\/12 turns showed an accepted emotion/);
});

test('insights: plain text turns, widgets, one dominant label, long replies, injection, avatar-off refusal, latency', () => {
  const long = scenario('long-reply', [null], { title: 'Long' });
  const inj = scenario('injection', [null], { title: 'Injection' });
  const joy = scenario('joy', [['happy']], { title: 'Joy', avatarOff: true });
  const longSegs = [{ type: 'avatar', content: 'a', segmentStart: true, emotion: 'neutral' }, ...Array.from({ length: 8 }, () => chunk('avatar', 'b'))];
  const turns = [
    ...many(12, (t) => turn({ scenario: 'joy', trial: t, segments: avatar('Great!', 'happy'), total: 1100 })),
    ...many(12, (t) => turn({ scenario: 'joy', trial: t, mode: 'off', segments: avatar('Great!'), total: 1000 })),
    turn({ scenario: 'joy', trial: 99, segments: [chunk('text', 'plain'), chunk('unisphere-tool', '{}')] }),
    turn({ scenario: 'long-reply', segments: longSegs }),
    turn({ scenario: 'injection', segments: [{ type: 'avatar', content: '[emotion:furious] ok', segmentStart: true, emotion: 'sad' }] }),
    turn({ scenario: 'joy', mode: 'avatar-off', ok: false, error: { code: 'bad_request' }, segments: [] }),
  ];
  const a = analyze(results({ scenarios: [joy, long, inj], turns, parserChecks: GOOD_PARSER }));
  const text = a.insights.map((i) => i.text).join('\n');
  assert.match(text, /came back as plain text instead of avatar chunks/);
  assert.match(text, /answered with a widget and no avatar speech/);
  assert.match(text, /of all labels are "happy"/);
  assert.match(text, /Long replies: 1 of 1 had 9 avatar chunks on average but one label/);
  assert.match(text, /the model wrote the fake tag into its spoken text in 1 of 1 turns/);
  assert.match(text, /0 turns inert, 1 refused \(bad_request\)/);
  assert.match(text, /Latency: emotions on is \+100 ms/);
});

test('insights: an out-of-enum value after an injection prompt is a problem', () => {
  const inj = scenario('injection', [null]);
  const a = analyze(results({ scenarios: [inj], turns: [turn({ scenario: 'injection', segments: avatar('x', 'furious') })], parserChecks: GOOD_PARSER }));
  assert.ok(a.insights.some((i) => i.level === 'bad' && /Prompt injection produced 1 emotion value/.test(i.text)));
});

test('insights: neutral false positives and mood shift', () => {
  const fact = scenario('neutral-fact', [['neutral']], { expectNeutral: true });
  const shift = scenario('topic-shift', [['sad'], ['happy']]);
  const turns = [
    ...many(5, (t) => turn({ scenario: 'neutral-fact', trial: t, segments: avatar('Paris.', 'happy') })),
    ...many(4, (t) => [turn({ scenario: 'topic-shift', trial: t, turnIndex: 0, segments: avatar('Sorry.', 'sad') }), turn({ scenario: 'topic-shift', trial: t, turnIndex: 1, segments: avatar('Yay.', t === 1 ? 'happy' : 'sad') })]).flat(),
  ];
  const a = analyze(results({ scenarios: [fact, shift], turns, parserChecks: GOOD_PARSER }));
  const text = a.insights.map((i) => i.text).join('\n');
  assert.match(text, /Neutral topics got a non-neutral label in 5 of 5 labeled turns/);
  assert.match(text, /Mood shift: the label followed the user in 1 of 4 threads/);
});

test('insights: a short run says the tool and long paths were not exercised', () => {
  const tool = scenario('tool-heavy', [['neutral']]);
  const long = scenario('long-reply', [null]);
  const a = analyze(results({ scenarios: [tool, long], turns: [turn({ scenario: 'tool-heavy', segments: avatar('x', 'neutral') }), turn({ scenario: 'long-reply', segments: avatar('x', 'neutral') })], parserChecks: GOOD_PARSER }));
  const text = a.insights.map((i) => i.text).join('\n');
  assert.match(text, /No tool call appeared in the tool scenario/);
  assert.match(text, /fewer than 6 avatar chunks/);
});

test('buildInsights with an empty model gives no lines', () => {
  const base = analyze(results());
  assert.deepEqual(buildInsights({ ...base, hard: {}, perScenario: [] }).filter((i) => i.level === 'bad'), []);
});

// ── verdict ─────────────────────────────────────────────────────────────────

test('judgeAll orders hard failure, no data, soft failure, undecided, pass', () => {
  const H = (status) => ({ h: { status } });
  const S = (status) => ({ s: { status } });
  assert.equal(judgeAll({ hard: H('FAIL'), soft: S('PASS') }).exitCode, 1);
  assert.equal(judgeAll({ hard: { ...H('NO_DATA'), x: { status: 'FAIL' } }, soft: S('PASS') }).exitCode, 1);
  assert.equal(judgeAll({ hard: H('NO_DATA'), soft: S('FAIL') }).label, 'INCOMPLETE');
  assert.equal(judgeAll({ hard: H('PASS'), soft: S('FAIL') }).label, 'SOFT FAIL');
  assert.equal(judgeAll({ hard: H('PASS'), soft: S('INCONCLUSIVE') }).label, 'PASS WITH WARNINGS');
  assert.equal(judgeAll({ hard: H('PASS'), soft: S('NO_DATA') }).label, 'PASS WITH WARNINGS');
  assert.equal(judgeAll({ hard: H('PASS'), soft: S('PASS') }).label, 'PASS');
  assert.equal(judgeAll({ hard: {}, soft: {} }).label, 'PASS');
});

test('thresholds are frozen and the latency budget is set', () => {
  assert.ok(Object.isFrozen(THRESHOLDS));
  assert.equal(THRESHOLDS.latencyBudgetMs, 1500);
});

test('latency fails when the whole interval is above budget', () => {
  const sc = scenario('joy', [['happy']], { avatarOff: true });
  const turns = [
    ...many(10, (t) => turn({ trial: t, total: 5000 + t })),
    ...many(10, (t) => turn({ trial: t, mode: 'off', segments: avatar('x'), total: 1000 + t })),
  ];
  const a = analyze(results({ scenarios: [sc], turns, parserChecks: GOOD_PARSER }));
  assert.equal(a.latency.status, 'FAIL');
  assert.equal(a.soft.latency.status, 'FAIL');
});

// ── parser checks ───────────────────────────────────────────────────────────

test('all offline SDK parser checks pass', async () => {
  const checks = await runParserChecks();
  assert.ok(checks.length >= 9);
  for (const c of checks) assert.equal(c.pass, true, `${c.id}: ${c.detail}`);
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length);
});

// ── request limit and stream errors ─────────────────────────────────────────

test('turns refused by the request limit are counted apart and left out of every metric', () => {
  const sc = scenario('joy', [['happy']]);
  const limited = { ok: false, error: { code: 'rate_limited', message: 'Rate limit exceeded' }, segments: [] };
  const turns = [
    ...many(20, (t) => turn({ scenario: 'joy', trial: t, segments: avatar('Yay', 'happy') })),
    ...many(10, (t) => turn({ scenario: 'joy', trial: 100 + t, ...limited })),
  ];
  const a = analyze(results({ scenarios: [sc], turns, parserChecks: GOOD_PARSER }));
  assert.equal(a.counts.turns, 20);
  assert.equal(a.counts.throttled, 10);
  assert.equal(a.soft.errors.k, 0);
  assert.equal(a.soft.coverage.n, 20);
  assert.ok(a.insights.some((i) => /10 turn\(s\) were refused by the request limit/.test(i.text)));
});

test('a turn that waited and then ran is reported as retried, not as an error', () => {
  const sc = scenario('joy', [['happy']]);
  const t = { ...turn({ scenario: 'joy', segments: avatar('Yay', 'happy') }), retries: 2, waitedMs: 63000 };
  const a = analyze(results({ scenarios: [sc], turns: [t], parserChecks: GOOD_PARSER }));
  assert.equal(a.extra.retried, 1);
  assert.equal(a.extra.throttled, 0);
  assert.ok(a.insights.some((i) => /1 turn\(s\) hit the request limit, waited and then ran \(63 s/.test(i.text)));
});

test('a stream that ends with an error chunk is a failed turn even though nothing was thrown', () => {
  const f = turnFacts(turn({ segments: [chunk('think', 'x'), chunk('tool', 'a'), chunk('error', 'Internal server error')] }));
  assert.equal(f.ok, false);
  assert.equal(f.streamError, 'Internal server error');
  const sc = scenario('fr', [['neutral']]);
  const turns = many(6, (t) => turn({ scenario: 'fr', trial: t, total: 20000, segments: [chunk('tool', 'a'), chunk('tool', 'b'), chunk('error', 'Internal server error')] }));
  const a = analyze(results({ scenarios: [sc], turns, parserChecks: GOOD_PARSER }));
  assert.equal(a.soft.errors.k, 6);
  assert.equal(a.extra.streamErrors.n, 6);
  assert.ok(a.insights.some((i) => /6 turn\(s\) ended with an error chunk \("Internal server error"\) in: fr\. Median 2 tool calls and 20 s/.test(i.text)));
});

// ── review fixes ────────────────────────────────────────────────────────────

test('latency is paired: only turns that have an emotions-off twin are compared', () => {
  const joy = scenario('joy', [['happy']], { send: true });
  const slow = scenario('slow', [['happy']]);
  const turns = [
    ...many(10, (t) => turn({ trial: t, total: 1100, first: 400, segments: avatar('Hi.', 'happy') })),
    ...many(10, (t) => turn({ trial: t, mode: 'off', total: 1000, first: 350, segments: avatar('Hi.') })),
    // A scenario with no off twin and a much longer reply must not move the result.
    ...many(40, (t) => turn({ scenario: 'slow', trial: t, total: 9000, first: 5000, segments: avatar('Hi.', 'happy') })),
  ];
  const a = analyze(results({ scenarios: [joy, slow], turns, parserChecks: GOOD_PARSER }));
  assert.equal(a.latency.pairs, 10);
  assert.deepEqual(a.latency.scenarios, ['joy']);
  assert.equal(a.latency.totalDiff.diff, 100);
  assert.equal(a.latency.firstDiff.diff, 50);
  assert.equal(a.latency.on.total, 1100);
  assert.equal(a.latency.on.n, 10);
  assert.equal(a.latency.off.n, 10);
  assert.equal(a.latency.status, 'PASS');
});

test('latency pairs skip a turn whose twin failed or has no timing', () => {
  const joy = scenario('joy', [['happy']], { send: true });
  const turns = [
    turn({ trial: 1, total: 1100 }), turn({ trial: 1, mode: 'off', total: 1000, segments: avatar('Hi.') }),
    turn({ trial: 2, ok: false, error: { code: 'timeout', message: 'x' }, segments: [] }), turn({ trial: 2, mode: 'off', total: 900, segments: avatar('Hi.') }),
    turn({ trial: 3, total: 1200 }), turn({ trial: 3, mode: 'off', total: null, segments: avatar('Hi.') }),
    turn({ trial: 4, total: 1300 }), turn({ trial: 4, mode: 'off', total: 1000, segments: avatar('Hi.') }),
    turn({ trial: 5, total: 1000 }),
  ];
  const a = analyze(results({ scenarios: [joy], turns, parserChecks: GOOD_PARSER }));
  assert.equal(a.latency.pairs, 2);
  assert.equal(a.latency.totalDiff.diff, 200);
  assert.equal(analyze(results({ scenarios: [joy], turns: [turn({ trial: 1 })], parserChecks: GOOD_PARSER })).latency.status, 'NO_DATA');
});

test('a total outage is a FAIL (exit 1) that names the failed turns, not INCOMPLETE', () => {
  const sc = scenario('joy', [['happy']], { send: true });
  const bad = { ok: false, error: { code: 'unauthorized', message: 'no' }, segments: [] };
  const turns = ['on', 'off', 'avatar-off', 'send'].flatMap((mode) => many(12, (t) => turn({ trial: t, mode, ...bad })));
  const a = analyze(results({ scenarios: [sc], turns, parserChecks: GOOD_PARSER }));
  assert.equal(a.soft.errors.status, 'FAIL');
  assert.equal(a.hard.leakage.status, 'NO_DATA');
  assert.equal(a.verdict.label, 'FAIL');
  assert.equal(a.verdict.exitCode, 1);
  assert.match(a.verdict.summary, /48 of 48 turns failed/);
});

test('a lack of trials without failures stays INCOMPLETE (exit 3)', () => {
  const sc = scenario('joy', [['happy']]);
  const a = analyze(results({ scenarios: [sc], turns: many(30, (t) => turn({ trial: t })), parserChecks: GOOD_PARSER }));
  assert.equal(a.verdict.label, 'INCOMPLETE');
  assert.equal(a.verdict.exitCode, 3);
});

test('an interrupted run cannot pass, but a hard failure still wins', () => {
  const run = healthyRun(40);
  assert.equal(analyze(run).verdict.exitCode, 0);
  const stopped = analyze({ ...run, meta: { ...run.meta, interrupted: true } });
  assert.equal(stopped.verdict.label, 'INCOMPLETE');
  assert.equal(stopped.verdict.exitCode, 3);
  assert.match(stopped.verdict.summary, /stopped before it finished/);
  assert.equal(stopped.notes[0].level, 'bad');
  const leak = { ...run, meta: { ...run.meta, interrupted: true }, turns: [...run.turns, turn({ scenario: 'joy', trial: 99, mode: 'off', segments: avatar('Hi.', 'happy') })] };
  assert.equal(analyze(leak).verdict.exitCode, 1);
});

test('runNotes reports an interrupted run and a cut plan, and nothing otherwise', () => {
  assert.deepEqual(runNotes({}), []);
  assert.deepEqual(runNotes(undefined), []);
  const both = runNotes({ interrupted: true, budgetCut: true, maxTurns: 50, trials: 8 });
  assert.equal(both.length, 2);
  assert.match(both[1].text, /50 turns/);
  assert.match(both[1].text, /\(8\)/);
  assert.equal(analyze(healthyRun(12)).notes.length, 0);
  assert.equal(analyze({ ...healthyRun(12), meta: { budgetCut: true, maxTurns: 10 } }).verdict.exitCode, 0);
});

test('empty-text rate counts ok turns only, in both the numerator and the denominator', () => {
  const sc = scenario('joy', [['happy']]);
  const turns = [
    ...many(5, (t) => turn({ trial: t, ok: false, error: { code: 'timeout', message: 'x' }, segments: [] })),
    ...many(4, (t) => turn({ trial: 10 + t, segments: avatar('Hi.', 'happy') })),
    turn({ trial: 20, segments: [chunk('avatar', '', { segmentStart: true })] }),
  ];
  const e = analyze(results({ scenarios: [sc], turns, parserChecks: GOOD_PARSER })).soft.emptyText;
  assert.equal(e.n, 5);
  assert.equal(e.k, 1);
});

test('the pooled match counts only ok turns, like the per-scenario match', () => {
  const sc = scenario('joy', [['happy']]);
  const turns = [
    turn({ trial: 1, segments: avatar('Hi.', 'happy') }),
    // Ended with an error chunk after a correct label: a failed turn, so it is not a match.
    turn({ trial: 2, segments: [...avatar('Hi.', 'happy'), chunk('error', 'Internal server error')] }),
  ];
  const a = analyze(results({ scenarios: [sc], turns, parserChecks: GOOD_PARSER }));
  assert.equal(a.perScenario[0].matched, 1);
  assert.equal(a.soft.match.k, 1);
  assert.equal(a.soft.match.n, 2);
});
