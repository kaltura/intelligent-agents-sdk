/** Builders for emotions-eval results, so tests state only what matters. */

/** One avatar segment: a start chunk (with the label when given) and an end chunk. */
export function avatar(text, emotion) {
  const start = { type: 'avatar', content: text, segmentStart: true, segmentEnd: false, isFinal: false };
  if (emotion !== undefined) start.emotion = emotion;
  return [start, { type: 'avatar', content: '', segmentStart: false, segmentEnd: true, isFinal: true }];
}

/** A scenario definition with one turn per accept list. */
export function scenario(id, accepts = [['happy']], extra = {}) {
  return { id, title: extra.title ?? id, group: 'tone', why: `why ${id}`, turns: accepts.map((accept, i) => ({ prompt: `prompt ${id} ${i}`, accept })), ...extra };
}

/** One recorded turn. */
export function turn(o) {
  const { scenario: sc = 'joy', trial = 1, turnIndex = 0, mode = 'on', segments = avatar('Hello.', 'happy'), ok = true, error = null, first = 300, total = 1000, prompt = 'p' } = o;
  return { scenario: sc, trial, turnIndex, mode, prompt, ok, error, firstChunkMs: first, totalMs: total, segments };
}

/** `n` copies of a turn, trial numbers 1..n and latency spread a little. */
export function many(n, make) {
  return Array.from({ length: n }, (_, i) => make(i + 1));
}

export function results({ scenarios = [], turns = [], parserChecks, meta = {} } = {}) {
  return { schema: 1, meta: { target: 'example', startedAt: '2026-01-01T00:00:00.000Z', trials: 1, ...meta }, scenarios, turns, ...(parserChecks ? { parserChecks } : {}) };
}

export const GOOD_PARSER = [{ id: 'a', name: 'a check', pass: true, detail: 'ok' }];

/** A healthy run: enough trials for every dimension to pass. */
export function healthyRun(n = 40) {
  const joy = scenario('joy', [['happy']], { title: 'Joy', send: true, avatarOff: true });
  const fact = scenario('neutral-fact', [['neutral']], { title: 'Neutral factual', expectNeutral: true });
  const multi = scenario('mixed', [['happy', 'sad']], { title: 'Mixed', send: true });
  const turns = [
    ...many(n, (t) => turn({ scenario: 'joy', trial: t, segments: avatar('Great!', 'happy'), total: 1000 + t })),
    ...many(n, (t) => turn({ scenario: 'joy', trial: t, mode: 'off', segments: avatar('Great!'), total: 1000 + t })),
    ...many(n, (t) => turn({ scenario: 'joy', trial: t, mode: 'avatar-off', segments: [{ type: 'text', content: 'Great!', segmentStart: true, segmentEnd: true, isFinal: true }] })),
    ...many(n, (t) => turn({ scenario: 'joy', trial: t, mode: 'send', segments: avatar('Great!', 'happy') })),
    ...many(n, (t) => turn({ scenario: 'neutral-fact', trial: t, segments: avatar('Paris.', 'neutral') })),
    ...many(n, (t) => turn({ scenario: 'mixed', trial: t, segments: [...avatar('Congrats.', 'happy'), ...avatar('Sorry for her.', 'sad')] })),
  ];
  return results({ scenarios: [joy, fact, multi], turns, parserChecks: GOOD_PARSER, meta: { trials: n } });
}
