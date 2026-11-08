import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../../scripts/lib/emotion-eval/analyze.mjs';
import { renderReport, esc, groupSegments } from '../../scripts/lib/emotion-eval/report.mjs';
import { avatar, scenario, turn, many, results, healthyRun, GOOD_PARSER } from '../fakes/emotion-results.js';

/** The HTML report: safe, self-contained, and true to the analysis. */

const html = (r, opts) => renderReport(r, analyze(r), opts);

test('esc escapes the five HTML characters and tolerates null', () => {
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(12), '12');
});

test('the page has a strict CSP, no script, no external reference and no event handler', () => {
  const out = html(healthyRun(12));
  assert.match(out, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">/);
  assert.equal(/<script/i.test(out), false);
  assert.equal(/<link\b/i.test(out), false);
  assert.equal(/<iframe|<object|<embed/i.test(out), false);
  assert.equal(/\son[a-z]+\s*=/i.test(out), false);
  assert.equal(/(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(out), false);
  assert.equal(/url\(/i.test(out), false);
  assert.equal(/@import/i.test(out), false);
});

test('hostile text from the target, the prompts and the model is escaped everywhere', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const sc = scenario('inj', [['happy']], { title: evil, why: evil });
  const r = results({
    scenarios: [sc],
    turns: [
      turn({ scenario: 'inj', prompt: evil, segments: [{ type: 'avatar', content: evil, segmentStart: true, emotion: evil }] }),
      turn({ scenario: 'inj', trial: 2, ok: false, error: { code: evil, message: evil }, segments: [] }),
    ],
    meta: { target: evil, startedAt: evil },
  });
  const out = html(r, { expandAll: true });
  assert.equal(out.includes('<img src=x'), false);
  assert.equal(/<img/i.test(out), false);
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('the verdict banner shows each state', () => {
  assert.match(html(healthyRun(40)), /class="banner good"[^>]*><span class="big">PASS</);
  const leak = healthyRun(40);
  leak.turns.find((t) => t.mode === 'off').segments = avatar('Oops', 'happy');
  assert.match(html(leak), /class="banner bad"[^>]*><span class="big">FAIL<\/span><p>1 hard/);
  const noParser = healthyRun(40);
  noParser.turns = noParser.turns.filter((t) => t.mode !== 'off');
  assert.match(html(noParser), /INCOMPLETE/);
});

test('the page has the heatmap, both charts, hard and soft tables and a drill-down per scenario', () => {
  const out = html(healthyRun(12));
  assert.match(out, /<table class="heat">/);
  assert.equal((out.match(/<svg /g) || []).length, 2);
  assert.match(out, /role="img" aria-label="Expected-emotion rate per scenario/);
  assert.match(out, /Hard dimensions \(must be 100%\)/);
  assert.match(out, /Quality dimensions/);
  for (const id of ['joy', 'neutral-fact', 'mixed']) assert.ok(out.includes(`id="s-${id}"`), id);
});

test('status is never shown by colour alone: every badge has an icon and a word', () => {
  const out = html(healthyRun(12));
  const badges = out.match(/<span class="badge [a-z]+"><span aria-hidden="true">[^<]+<\/span> [A-Z ]+<\/span>/g) || [];
  assert.ok(badges.length > 5);
  assert.equal(badges.length, (out.match(/class="badge /g) || []).length);
  for (const b of badges) assert.match(b, /aria-hidden="true">[^<]+<\/span> (PASS|FAIL|UNDECIDED|NO DATA)/);
  assert.match(out, /coverage, 95% interval \d+% to 100%/);
});

test('zero trials, missing arrays and missing fields still render a page', () => {
  for (const r of [results(), { schema: 1 }, {}, null, { turns: [{}], scenarios: [{ id: 'x' }] }]) {
    const out = renderReport(r, analyze(r));
    assert.match(out, /^<!doctype html>/);
    assert.match(out, /<\/html>\s*$/);
  }
  assert.match(renderReport(results(), analyze(results())), /No scored turns/);
});

test('a dry run is marked as a recorded fixture', () => {
  assert.match(html(results({ meta: { dryRun: true } })), /Recorded fixture, not a live run/);
  assert.equal(/Recorded fixture/.test(html(results())), false);
});

test('weak and flaky scenarios open by default and expandAll opens all', () => {
  const sc = scenario('bad', [['happy']], { title: 'Bad' });
  const good = scenario('good', [['happy']], { title: 'Good' });
  const r = results({
    scenarios: [sc, good],
    turns: [
      ...many(12, (t) => turn({ scenario: 'bad', trial: t, segments: avatar('x', 'sad') })),
      ...many(12, (t) => turn({ scenario: 'good', trial: t, segments: avatar('x', 'happy') })),
    ],
    parserChecks: GOOD_PARSER,
  });
  const out = html(r);
  assert.match(out, /<details id="s-bad" open>/);
  assert.match(out, /<details id="s-good">/);
  assert.match(html(r, { expandAll: true }), /<details id="s-good" open>/);
});

test('an invalid label is shown with a warning mark and its text, not hidden', () => {
  const sc = scenario('s', [['happy']]);
  const r = results({ scenarios: [sc], turns: [turn({ scenario: 's', segments: avatar('Hm.', 'confused') })] });
  assert.match(html(r, { expandAll: true }), /class="emo invalid"><span aria-hidden="true">⚠<\/span> confused/);
});

test('the heatmap counts match the analysis', () => {
  const sc = scenario('s', [['happy']], { title: 'S' });
  const r = results({
    scenarios: [sc],
    turns: [...many(3, (t) => turn({ scenario: 's', trial: t, segments: avatar('a', 'happy') })), turn({ scenario: 's', trial: 4, segments: avatar('a', 'sad') })],
  });
  const out = html(r);
  assert.match(out, /title="S: 3 of 4 turns, happy \(accepted\)">3 ✓<\/td>/);
  assert.match(out, /title="S: 1 of 4 turns, sad">1<\/td>/);
});

test('groupSegments joins continuation chunks and keeps the label of the start chunk', () => {
  const g = groupSegments([
    { type: 'avatar', content: 'Hel', segmentStart: true, emotion: 'happy' },
    { type: 'avatar', content: 'lo', segmentStart: false },
    { type: 'avatar', content: 'Bye', segmentStart: true },
    { type: 'text', content: 'a' }, { type: 'text', content: 'b' },
    { type: 'tool', content: 't' },
    null,
  ]);
  assert.deepEqual(g.map((x) => [x.kind, x.text, x.hasLabel]), [['avatar', 'Hello', true], ['avatar', 'Bye', false], ['text', 'ab', false], ['tool', 't', false], ['unknown', '', false]]);
  assert.equal(g[0].label, 'happy');
  assert.deepEqual(groupSegments(undefined), []);
});

test('an error turn shows its code and message in the drill-down', () => {
  const sc = scenario('s', [['happy']]);
  const r = results({ scenarios: [sc], turns: [turn({ scenario: 's', ok: false, error: { code: 'timeout', message: 'turn timed out' }, segments: [] })] });
  assert.match(html(r, { expandAll: true }), /ERROR<\/span> timeout turn timed out/);
});
