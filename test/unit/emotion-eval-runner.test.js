import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, pickScenarios } from '../../scripts/lib/emotion-eval/scenarios.mjs';
import { planJobs, runJobs, capabilitiesFor, slimSegment, liveTurn, withPacing, retryAfterSeconds, SIDE_PATH_TRIALS } from '../../scripts/lib/emotion-eval/runner.mjs';

/** Job planning, concurrency, the live turn driver and the request pacing. */

const ids = (jobs) => jobs.map((j) => `${j.scenario}/${j.trial}/${j.mode}`);

// ── scenarios ───────────────────────────────────────────────────────────────

test('the scenario set covers every required case and has unique ids', () => {
  const have = new Set(SCENARIOS.map((s) => s.id));
  assert.equal(have.size, SCENARIOS.length);
  for (const id of ['joy', 'sadness', 'anger', 'surprise', 'fear', 'neutral-fact', 'mixed', 'sarcasm', 'joke', 'short-reply', 'long-reply', 'tool-heavy', 'empty-turn', 'injection', 'repeat-happy', 'topic-shift']) assert.ok(have.has(id), id);
  assert.ok(SCENARIOS.filter((s) => s.id.startsWith('lang-')).length >= 3);
  for (const s of SCENARIOS) {
    assert.ok(s.why && s.title && s.turns.length >= 1, s.id);
    for (const t of s.turns) assert.ok(typeof t.prompt === 'string', s.id);
  }
});

test('pickScenarios selects by id, keeps order of the full list and rejects unknown ids', () => {
  assert.equal(pickScenarios().length, SCENARIOS.length);
  assert.deepEqual(pickScenarios(['sarcasm', 'joy']).map((s) => s.id), SCENARIOS.map((s) => s.id).filter((i) => ['sarcasm', 'joy'].includes(i)));
  assert.throws(() => pickScenarios(['nope']), /nope/);
});

// ── planJobs ────────────────────────────────────────────────────────────────

test('capabilitiesFor sets the avatar and emotions switches per path and adds scenario extras', () => {
  assert.deepEqual(capabilitiesFor('on'), { avatar: 'on', avatar_emotions: 'on' });
  assert.deepEqual(capabilitiesFor('off'), { avatar: 'on', avatar_emotions: 'off' });
  assert.deepEqual(capabilitiesFor('avatar-off'), { avatar: 'off', avatar_emotions: 'on' });
  assert.deepEqual(capabilitiesFor('send', { show_link: 'on' }), { avatar: 'on', avatar_emotions: 'on', show_link: 'on' });
});

test('planJobs adds the side paths only where a scenario asks for them, and only for the first trials', () => {
  const joy = SCENARIOS.find((s) => s.id === 'joy');
  const sarcasm = SCENARIOS.find((s) => s.id === 'sarcasm');
  const { jobs } = planJobs({ scenarios: [joy, sarcasm], trials: SIDE_PATH_TRIALS + 2 });
  const joyJobs = jobs.filter((j) => j.scenario === 'joy');
  assert.equal(joyJobs.filter((j) => j.mode === 'on').length, SIDE_PATH_TRIALS + 2);
  assert.equal(joyJobs.filter((j) => j.mode === 'off').length, SIDE_PATH_TRIALS + 2);
  assert.equal(joyJobs.filter((j) => j.mode === 'avatar-off').length, SIDE_PATH_TRIALS);
  assert.equal(joyJobs.filter((j) => j.mode === 'send').length, SIDE_PATH_TRIALS);
  assert.deepEqual([...new Set(jobs.filter((j) => j.scenario === 'sarcasm').map((j) => j.mode))], ['on']);
});

test('planJobs honours the path filter and the turn budget, dropping whole trials', () => {
  const some = pickScenarios(['joy', 'sadness', 'sarcasm']);
  const onlyOn = planJobs({ scenarios: some, trials: 3, paths: ['on'] });
  assert.ok(onlyOn.jobs.every((j) => j.mode === 'on'));
  assert.equal(onlyOn.jobs.length, 9);
  const cut = planJobs({ scenarios: some, trials: 3, paths: ['on'], maxTurns: 4 });
  assert.equal(cut.cut, true);
  assert.equal(cut.jobs.length, 3);
  assert.equal(cut.planned, 9);
  assert.deepEqual(ids(cut.jobs), ['joy/1/on', 'sadness/1/on', 'sarcasm/1/on']);
  assert.equal(planJobs({ scenarios: some, trials: 1, maxTurns: 0 }).jobs.length, 0);
});

test('a budget drops whole trials, so a thread scenario is never the first thing to go', () => {
  const mix = pickScenarios(['joy', 'topic-shift']);
  const perTrial = planJobs({ scenarios: mix, trials: 1, paths: ['on'] }).jobs.reduce((n, j) => n + j.turns.length, 0);
  const { jobs, cut, planned } = planJobs({ scenarios: mix, trials: 4, paths: ['on'], maxTurns: perTrial * 2 + 1 });
  assert.equal(cut, true);
  assert.equal(planned, perTrial * 4);
  assert.deepEqual([...new Set(jobs.map((j) => j.trial))], [1, 2]);
  assert.equal(jobs.filter((j) => j.scenario === 'topic-shift').length, 2);
});

test('when even trial 1 does not fit, it is filled job by job', () => {
  const mix = pickScenarios(['joy', 'topic-shift']);
  const { jobs, cut } = planJobs({ scenarios: mix, trials: 2, paths: ['on'], maxTurns: 1 });
  assert.equal(cut, true);
  assert.deepEqual(ids(jobs), ['joy/1/on']);
});

test('a multi-turn scenario is one job whose turns share a thread, and a budget never splits it', () => {
  const shift = SCENARIOS.find((s) => s.id === 'topic-shift');
  const { jobs, cut } = planJobs({ scenarios: [shift], trials: 2, paths: ['on'], maxTurns: shift.turns.length + 1 });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].turns.length, shift.turns.length);
  assert.equal(cut, true);
});

test('planJobs merges base capabilities under scenario capabilities', () => {
  const tool = SCENARIOS.find((s) => s.id === 'tool-heavy');
  const { jobs } = planJobs({ scenarios: [tool], trials: 1, paths: ['on'], baseCapabilities: { kaltura_genie_experiences: 'off' } });
  assert.equal(jobs[0].capabilities.kaltura_genie_experiences, 'off');
  assert.equal(jobs[0].capabilities.show_link, 'on');
});

// ── runJobs ─────────────────────────────────────────────────────────────────

const sleepTick = () => new Promise((r) => setTimeout(r, 1));

test('runJobs keeps the concurrency cap, runs turns of a job in order and passes the thread on', async () => {
  const jobs = Array.from({ length: 6 }, (_, i) => ({ id: i, scenario: 's', trial: i + 1, mode: 'on', capabilities: {}, turns: [{ turnIndex: 0, prompt: 'a' }, { turnIndex: 1, prompt: 'b' }] }));
  let live = 0, peak = 0;
  const seen = [];
  const runTurn = async ({ job, turnIndex, threadId }) => {
    live++; peak = Math.max(peak, live);
    await sleepTick();
    live--;
    seen.push([job.id, turnIndex, threadId]);
    return { ok: true, threadId: `t${job.id}`, segments: [] };
  };
  const recs = await runJobs({ jobs, runTurn, concurrency: 3 });
  assert.equal(peak, 3);
  assert.equal(recs.length, 12);
  assert.deepEqual(recs.map((r) => r.trial), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
  for (const [jobId, turnIndex, thread] of seen) assert.equal(thread, turnIndex === 0 ? undefined : `t${jobId}`);
});

test('runJobs turns a thrown error into a failed record and keeps going', async () => {
  const jobs = [{ id: 0, scenario: 's', trial: 1, mode: 'on', capabilities: {}, turns: [{ turnIndex: 0, prompt: 'a' }] }, { id: 1, scenario: 's', trial: 2, mode: 'on', capabilities: {}, turns: [{ turnIndex: 0, prompt: 'a' }] }];
  const recs = await runJobs({ jobs, concurrency: 1, runTurn: async ({ job }) => { if (job.id === 0) throw Object.assign(new Error('boom'), { code: 'x' }); return { ok: true, segments: [] }; } });
  assert.equal(recs[0].ok, false);
  assert.deepEqual(recs[0].error, { code: 'x', message: 'boom' });
  assert.equal(recs[1].ok, true);
});

test('runJobs stops starting turns when shouldStop turns true, and reports each turn once', async () => {
  const jobs = Array.from({ length: 5 }, (_, i) => ({ id: i, scenario: 's', trial: i + 1, mode: 'on', capabilities: {}, turns: [{ turnIndex: 0, prompt: 'a' }] }));
  let n = 0;
  const reported = [];
  const recs = await runJobs({ jobs, concurrency: 1, shouldStop: () => n >= 2, runTurn: async () => { n++; return { ok: true, segments: [] }; }, onTurn: (r) => reported.push(r.trial) });
  assert.equal(recs.length, 2);
  assert.deepEqual(reported, [1, 2]);
  assert.deepEqual(await runJobs({ jobs: [], runTurn: async () => ({}) }), []);
});

// ── liveTurn ────────────────────────────────────────────────────────────────

const job = (mode = 'on') => ({ mode, capabilities: capabilitiesFor(mode) });
const clock = () => { let t = 0; return () => (t += 10); };

test('slimSegment keeps the label only when metadata carries an emotion key', () => {
  assert.deepEqual(slimSegment({ type: 'avatar', content: 'Hi', segmentStart: true, metadata: { emotion: 'happy', secret: 'x' } }), { type: 'avatar', content: 'Hi', segmentStart: true, segmentEnd: false, isFinal: false, emotion: 'happy' });
  assert.equal('emotion' in slimSegment({ type: 'avatar', content: 'Hi', metadata: { other: 1 } }), false);
  assert.equal('emotion' in slimSegment({ type: 'avatar', content: 5 }), false);
  assert.equal(slimSegment({ type: 'avatar', metadata: { emotion: null } }).emotion, null);
  assert.deepEqual(slimSegment(null), { type: 'unknown', content: null, segmentStart: false, segmentEnd: false, isFinal: false });
});

test('liveTurn streams, stores slim chunks, records the first chunk time and the thread', async () => {
  const calls = [];
  const kaltura = { conversations: { stream: async function* (opts, ks) { calls.push([opts, ks]); yield { type: 'avatar', content: 'Hi', segmentStart: true, threadId: 'T1', metadata: { emotion: 'happy' } }; yield { type: 'avatar', content: '!', segmentEnd: true, isFinal: true }; } } };
  const r = await liveTurn(kaltura, 'ks', 1000, { now: clock() })({ job: job(), prompt: 'hello' });
  assert.equal(r.ok, true);
  assert.equal(r.threadId, 'T1');
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[0].emotion, 'happy');
  assert.equal(r.firstChunkMs, 10);
  assert.ok(r.totalMs > 0);
  assert.equal(calls[0][1], 'ks');
  assert.equal(calls[0][0].userMessage, 'hello');
  assert.deepEqual(calls[0][0].capabilities, { avatar: 'on', avatar_emotions: 'on' });
  assert.equal('threadId' in calls[0][0], false);
  await liveTurn(kaltura, 'ks', 1000)({ job: job(), prompt: 'again', threadId: 'T1' });
  assert.equal(calls[1][0].threadId, 'T1');
});

test('liveTurn returns the error and the chunks that arrived before it', async () => {
  const kaltura = { conversations: { stream: async function* () { yield { type: 'avatar', content: 'Hi', segmentStart: true }; throw Object.assign(new Error('nope'), { code: 'server_error' }); } } };
  const r = await liveTurn(kaltura, 'ks', 1000)({ job: job(), prompt: 'x' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.error, { code: 'server_error', message: 'nope' });
  assert.equal(r.segments.length, 1);
});

test('liveTurn aborts a stream that outlasts the timeout and reports a timeout', async () => {
  const kaltura = { conversations: { stream: async function* ({ signal }) { await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))); yield {}; } } };
  const r = await liveTurn(kaltura, 'ks', 20)({ job: job(), prompt: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'timeout');
});

test('liveTurn on the send path uses the aggregate call, has no first-chunk time and keeps partial chunks on error', async () => {
  const send = async (opts) => ({ threadId: 'S1', segments: [{ type: 'avatar', content: 'Hi', segmentStart: true, metadata: { emotion: 'sad' } }], opts });
  const ok = await liveTurn({ conversations: { send } }, 'ks', 1000)({ job: job('send'), prompt: 'x' });
  assert.equal(ok.ok, true);
  assert.equal(ok.firstChunkMs, null);
  assert.equal(ok.threadId, 'S1');
  assert.equal(ok.segments[0].emotion, 'sad');
  const failing = async () => { throw Object.assign(new Error('empty'), { code: 'empty_reply', segments: [{ type: 'think', content: 'x' }] }); };
  const bad = await liveTurn({ conversations: { send: failing } }, 'ks', 1000)({ job: job('send'), prompt: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'empty_reply');
  assert.equal(bad.segments.length, 1);
  const hang = await liveTurn({ conversations: { send: () => new Promise(() => {}) } }, 'ks', 20)({ job: job('send'), prompt: 'x' });
  assert.equal(hang.error.code, 'timeout');
});

test('liveTurn passes an abort signal to send and the timeout aborts it', async () => {
  let seen;
  const send = (opts) => { seen = opts.signal; return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted')))); };
  const r = await liveTurn({ conversations: { send } }, 'ks', 20)({ job: job('send'), prompt: 'x' });
  assert.equal(r.error.code, 'timeout');
  assert.equal(seen.aborted, true);
});

test('liveTurn keeps the chunks an empty_reply error carries in its body', async () => {
  const send = async () => { throw Object.assign(new Error('empty'), { code: 'empty_reply', body: { segments: [{ type: 'think', content: 'x' }] } }); };
  const r = await liveTurn({ conversations: { send } }, 'ks', 1000)({ job: job('send'), prompt: 'x' });
  assert.equal(r.segments.length, 1);
});

// ── pacing ──────────────────────────────────────────────────────────────────

test('retryAfterSeconds reads the wait from the message, clamps it and has a default', () => {
  assert.equal(retryAfterSeconds({ message: 'Rate limit exceeded (limit 100 per 1 minute). Retry after 33 seconds.' }), 33);
  assert.equal(retryAfterSeconds({ message: 'retry after 9999' }), 120);
  assert.equal(retryAfterSeconds({ message: 'retry after 0' }), 1);
  assert.equal(retryAfterSeconds({ message: 'busy' }), 30);
  assert.equal(retryAfterSeconds(null), 30);
});

function virtualTime() {
  let t = 0;
  const sleeps = [];
  return { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, sleeps, at: () => t };
}

test('withPacing starts at most perMinute turns in any 60 s window', async () => {
  const vt = virtualTime();
  const starts = [];
  const paced = withPacing(async () => { starts.push(vt.now()); return { ok: true }; }, { perMinute: 3, sleep: vt.sleep, now: vt.now });
  for (let i = 0; i < 7; i++) await paced({});
  assert.deepEqual(starts, [0, 0, 0, 60000, 60000, 60000, 120000]);
});

test('withPacing waits what the server asks and tries again, up to maxRetries', async () => {
  const vt = virtualTime();
  let calls = 0;
  const limited = { ok: false, error: { code: 'rate_limited', message: 'Retry after 5 seconds.' } };
  const paced = withPacing(async () => (++calls < 3 ? limited : { ok: true, segments: [] }), { perMinute: 0, sleep: vt.sleep, now: vt.now });
  const r = await paced({});
  assert.equal(r.ok, true);
  assert.equal(calls, 3);
  assert.equal(r.retries, 2);
  assert.deepEqual(vt.sleeps, [6000, 6000]);
  assert.equal(r.waitedMs, 12000);

  calls = 0;
  const always = withPacing(async () => { calls++; return limited; }, { perMinute: 0, maxRetries: 2, sleep: vt.sleep, now: vt.now });
  const g = await always({});
  assert.equal(calls, 3);
  assert.equal(g.error.code, 'rate_limited');
  assert.equal(g.retries, 2);
});

test('withPacing leaves a normal result untouched and does not retry other errors', async () => {
  const vt = virtualTime();
  const ok = await withPacing(async () => ({ ok: true, x: 1 }), { sleep: vt.sleep, now: vt.now })({});
  assert.deepEqual(ok, { ok: true, x: 1 });
  let calls = 0;
  const other = await withPacing(async () => { calls++; return { ok: false, error: { code: 'server_error', message: 'x' } }; }, { sleep: vt.sleep, now: vt.now })({});
  assert.equal(calls, 1);
  assert.equal(other.retries, undefined);
});
