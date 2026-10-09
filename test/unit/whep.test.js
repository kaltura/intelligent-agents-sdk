import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { whepPost, WHEP_DEFAULTS } from '../../src/experience/whep.js';
import { fakeWhepFetch } from '../fakes/whep.js';

const URL_ = 'https://srs.example/rtc/v1/whep/?app=a&stream=s';
const post = (fetch, extra = {}) => whepPost({ fetch, url: URL_, sdp: 'v=0\r\n', ...extra });
const tick = (ms) => mock.timers.tick(ms);
const flush = () => new Promise((r) => setImmediate(r));

function useTimers() { mock.timers.enable({ apis: ['setTimeout'] }); }
const outcome = (p) => { const o = {}; p.then((v) => { o.value = v; o.done = true; }, (e) => { o.error = e; o.done = true; }); return o; };

test('defaults: 5 s per try, 3 tries, 1 s backoff', () => {
  assert.deepEqual({ ...WHEP_DEFAULTS }, { whepTry: 5000, whepTries: 3, whepBackoff: 1000 });
});

test('first try answers: one POST, no wait, SDP content type', async () => {
  const f = fakeWhepFetch([{}]);
  const res = await post(f);
  assert.equal(res.status, 201);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers['content-type'], 'application/sdp');
});

test('a connection reset retries once and the second try wins', async (t) => {
  useTimers(); t.after(() => mock.timers.reset());
  const f = fakeWhepFetch([{ reset: true }, {}]);
  const o = outcome(post(f));
  await flush();
  assert.equal(f.calls.length, 1);
  tick(WHEP_DEFAULTS.whepBackoff - 1); await flush();
  assert.equal(f.calls.length, 1, 'still backing off');
  tick(1); await flush();
  assert.equal(f.calls.length, 2);
  await flush();
  assert.equal(o.value?.status, 201);
});

test('a try that gets no answer is aborted at 5 s and retried', async (t) => {
  useTimers(); t.after(() => mock.timers.reset());
  const f = fakeWhepFetch([{ hang: true }, {}]);
  const o = outcome(post(f));
  await flush();
  tick(5000); await flush();
  assert.equal(f.calls[0].aborted, true);
  tick(1000); await flush(); await flush();
  assert.equal(f.calls.length, 2);
  assert.equal(o.value?.status, 201);
});

test('an HTTP status is returned as is, never retried', async () => {
  for (const status of [404, 409, 503]) {
    const f = fakeWhepFetch([{ status }, {}]);
    const res = await post(f);
    assert.equal(res.status, status);
    assert.equal(f.calls.length, 1, `${status} not retried`);
  }
});

test('every try times out: whep_timeout with phase and retryable, after 3 tries', async (t) => {
  useTimers(); t.after(() => mock.timers.reset());
  const f = fakeWhepFetch([{ hang: true }]);
  const o = outcome(post(f));
  await flush();
  for (let i = 0; i < 3; i++) { tick(5000); await flush(); tick(1000); await flush(); }
  await flush();
  assert.equal(f.calls.length, 3);
  assert.equal(o.error?.code, 'whep_timeout');
  assert.equal(o.error.phase, 'whep');
  assert.equal(o.error.retryable, true);
});

test('every try resets: whep_failed with phase and retryable', async (t) => {
  useTimers(); t.after(() => mock.timers.reset());
  const f = fakeWhepFetch([{ reset: true }]);
  const o = outcome(post(f));
  for (let i = 0; i < 3; i++) { await flush(); tick(1000); }
  await flush(); await flush();
  assert.equal(f.calls.length, 3);
  assert.equal(o.error?.code, 'whep_failed');
  assert.equal(o.error.phase, 'whep');
  assert.equal(o.error.retryable, true);
});

test('caller abort mid-try rejects at once and does not retry', async (t) => {
  useTimers(); t.after(() => mock.timers.reset());
  const f = fakeWhepFetch([{ hang: true }, {}]);
  const ac = new AbortController();
  const o = outcome(post(f, { signal: ac.signal }));
  await flush();
  ac.abort();
  await flush();
  assert.equal(o.error?.name, 'AbortError');
  tick(10000); await flush();
  assert.equal(f.calls.length, 1);
});

test('an already aborted signal never sends a POST', async () => {
  const f = fakeWhepFetch([{}]);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(post(f, { signal: ac.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
});

test('abort during the backoff sleep stops the retry', async (t) => {
  useTimers(); t.after(() => mock.timers.reset());
  const f = fakeWhepFetch([{ reset: true }, {}]);
  const ac = new AbortController();
  const o = outcome(post(f, { signal: ac.signal }));
  await flush();
  ac.abort();
  await flush(); await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(o.done, true);
  assert.ok(o.error, 'rejects after the abort');
});

test('no retry once the caller deadline has passed', async () => {
  const f = fakeWhepFetch([{ reset: true }, {}]);
  await assert.rejects(post(f, { overall: { expired: () => true } }), { code: 'whep_failed' });
  assert.equal(f.calls.length, 1);
});

test('the timeout detail counts the tries actually made', async (t) => {
  useTimers(); t.after(() => mock.timers.reset());
  const f = fakeWhepFetch([{ hang: true }]);
  const o = outcome(post(f, { overall: { expired: () => true } }));
  await flush(); tick(5000); await flush();
  assert.equal(o.error?.code, 'whep_timeout');
  assert.match(o.error.detail, /after 1 try\./);
});

test('tries below 1 still makes one POST', async () => {
  const f = fakeWhepFetch([{ reset: true }]);
  await assert.rejects(post(f, { tries: 0 }), (e) => e.code === 'whep_failed' && !/undefined/.test(e.detail));
  assert.equal(f.calls.length, 1);
});

test('timeouts, tries and backoff are overridable', async (t) => {
  useTimers(); t.after(() => mock.timers.reset());
  const f = fakeWhepFetch([{ hang: true }]);
  const o = outcome(post(f, { timeoutMs: 100, tries: 2, backoffMs: 10 }));
  await flush(); tick(100); await flush(); tick(10); await flush(); tick(100); await flush(); await flush();
  assert.equal(f.calls.length, 2);
  assert.equal(o.error?.code, 'whep_timeout');
});
