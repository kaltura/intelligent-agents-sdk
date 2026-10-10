import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers';
import { JSDOM } from 'jsdom';
import { fetchWithTimeout, TOOL_RESPONSE_TIMEOUT_MS } from '../../src/experience/fetch-timeout.js';
import { SiteNavigator } from '../../src/experience/site-nav.js';
import { Emitter } from '../../src/experience/emitter.js';
import { whepPost } from '../../src/experience/whep.js';
import { fakeWhepFetch } from '../fakes/whep.js';

const flush = () => new Promise((r) => setImmediate(r));
const outcome = (p) => { const o = {}; p.then((v) => { o.value = v; o.done = true; }, (e) => { o.error = e; o.done = true; }); return o; };
const abortAware = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
const URL_ = 'https://srs.example/rtc/v1/whep/?app=a&stream=s';

// ft9
test('TOOL_RESPONSE_TIMEOUT_MS is 15 s', () => { assert.equal(TOOL_RESPONSE_TIMEOUT_MS, 15000); });

// ep18
test('fetchWithTimeout: a timeout is a retryable "timeout" KalturaError', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset());
  const o = outcome(fetchWithTimeout((u, init) => abortAware(init), 'https://x.example/', {}, 500));
  await flush();
  mock.timers.tick(500); await flush();
  assert.equal(o.error?.code, 'timeout');
  assert.equal(o.error?.retryable, true);
});

// ft8
test('fetchWithTimeout: a network error that is not a timeout passes through untouched', async () => {
  const boom = new TypeError('fetch failed');
  await assert.rejects(fetchWithTimeout(async () => { throw boom; }, 'https://x.example/', {}, 5000), (e) => e === boom);
});

// ft7
test('fetchWithTimeout: clears its timer when the fetch answers', async () => {
  const real = globalThis.clearTimeout; let cleared = 0;
  globalThis.clearTimeout = (t) => { cleared++; return real(t); };
  try { await fetchWithTimeout(async () => ({ ok: true }), 'https://x.example/', {}, 5000); } finally { globalThis.clearTimeout = real; }
  assert.ok(cleared >= 1);
});

// ft5
test('site-nav: the manifest fetch gives up after exactly 10 s', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset());
  const win = new JSDOM('<!doctype html><body></body>', { url: 'https://docs.example.com/', pretendToBeVisual: true }).window;
  win.fetch = (u, init) => abortAware(init);
  const warns = [];
  const session = Object.assign(new Emitter(), { onToolCall: () => () => {} });
  const nav = new SiteNavigator({ session, window: win, manifest: null, manifestUrl: '/nova/sections.json', navigate: () => {}, warn: (m) => warns.push(m) });
  await flush();
  mock.timers.tick(9999); await flush();
  assert.deepEqual(warns, [], 'still waiting at 9.999 s');
  mock.timers.tick(1); await flush(); await flush();
  assert.equal(warns.length, 1);
  assert.match(warns[0], /No response within 10000ms/);
  nav.destroy();
});

// wp6 / wp7 / wp8: whepPost cleanup and per-try state
test('whepPost: the try timer is cleared when the caller reads the body', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset());
  const f = fakeWhepFetch([{}]);
  const { body } = await whepPost({ fetch: f, url: URL_, sdp: 'v=0\r\n', timeoutMs: 100 });
  await body();
  mock.timers.tick(1000); await flush();
  assert.equal(f.calls[0].aborted, false, 'a late timer did not abort a finished request');
});

test('whepPost: the caller abort listener is removed after the body is read', async () => {
  const ac = new AbortController();
  let added = 0, removed = 0;
  const sig = ac.signal;
  const add = sig.addEventListener.bind(sig), rem = sig.removeEventListener.bind(sig);
  sig.addEventListener = (...a) => { if (a[0] === 'abort') added++; return add(...a); };
  sig.removeEventListener = (...a) => { if (a[0] === 'abort') removed++; return rem(...a); };
  const { body } = await whepPost({ fetch: fakeWhepFetch([{}]), url: URL_, sdp: 'v=0\r\n', signal: sig });
  await body();
  assert.equal(removed, added, `listeners added ${added}, removed ${removed}`);
});

test('whepPost: a timeout on try 1 does not mislabel a later network failure', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset());
  const f = fakeWhepFetch([{ hang: true }, { reset: true }]);
  const o = outcome(whepPost({ fetch: f, url: URL_, sdp: 'v=0\r\n', tries: 2, timeoutMs: 100, backoffMs: 10 }));
  await flush();
  mock.timers.tick(100); await flush();
  mock.timers.tick(10); await flush(); await flush();
  assert.equal(o.error?.code, 'whep_failed');
});

// wb3 / wb4
test('whepPost: a body read that the caller aborts rethrows the caller abort, not a timeout', async () => {
  const ac = new AbortController();
  const f = fakeWhepFetch([{ hangBody: true }]);
  const { body } = await whepPost({ fetch: f, url: URL_, sdp: 'v=0\r\n', signal: ac.signal, timeoutMs: 60000 });
  const o = outcome(body());
  await flush();
  ac.abort();
  await flush();
  assert.equal(o.error?.name, 'AbortError');
  assert.notEqual(o.error?.code, 'whep_timeout');
});

test('whepPost: a finished body read leaves no pending try timer', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] }); t.after(() => mock.timers.reset());
  const real = globalThis.clearTimeout; let cleared = 0;
  globalThis.clearTimeout = (x) => { cleared++; return real(x); };
  try {
    const { body } = await whepPost({ fetch: fakeWhepFetch([{}]), url: URL_, sdp: 'v=0\r\n', timeoutMs: 100 });
    const before = cleared;
    await body();
    assert.ok(cleared > before, 'body() clears the timer it shares with the request');
  } finally { globalThis.clearTimeout = real; }
});
