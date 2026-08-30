import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../../src/core/http.js';
import { KalturaError } from '../../src/core/errors.js';

/**
 * REGRESSION (found via live browser testing): the default global `fetch` must be
 * BOUND to globalThis. Calling an unbound native `fetch` as `this._fetch(...)`
 * throws "Illegal invocation" in the browser. The SDK binds it at construction.
 */
test('default fetch is bound to globalThis (no Illegal invocation)', async () => {
  // A native-like fetch that throws if called with the wrong receiver.
  const native = function fetch(_url, _init) {
    if (this !== globalThis && this !== undefined) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{"ok":true}' });
  };
  const orig = globalThis.fetch;
  globalThis.fetch = native;
  try {
    const http = new Http();                       // picks up the global, must bind it
    const { data } = await http.postJson({ url: 'https://x/y', ks: 'k', body: {} });
    assert.deepEqual(data, { ok: true });
  } finally { globalThis.fetch = orig; }
});

test('an injected fetch is used and bound harmlessly', async () => {
  let called = 0;
  const fake = async () => { called++; return { ok: true, status: 200, headers: { get: () => 'rid-1' }, text: async () => '{"v":1}' }; };
  const http = new Http({ fetch: fake });
  const { data, requestId } = await http.postJson({ url: 'https://x', ks: 'k', body: { a: 1 } });
  assert.equal(called, 1);
  assert.equal(data.v, 1);
  assert.equal(requestId, 'rid-1');
});

test('constructing without any fetch throws a clear error', () => {
  const orig = globalThis.fetch;
  // @ts-ignore
  globalThis.fetch = undefined;
  try { assert.throws(() => new Http(), /No fetch available/); }
  finally { globalThis.fetch = orig; }
});

test('a failed response becomes a KalturaError (RFC 9457)', async () => {
  const fake = async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => '{"message":"AGENT_NOT_FOUND"}' });
  const http = new Http({ fetch: fake });
  await assert.rejects(() => http.postJson({ url: 'https://x/agent/get', ks: 'k', body: {} }), (e) => {
    assert.ok(e instanceof KalturaError);
    assert.equal(e.code, 'agent_not_found');
    assert.equal(e.status, 404);
    return true;
  });
});

// ── Retry / backoff (R-1 through R-5) ────────────────────────────────────────

test('R-1: 503 GET is retried up to maxRetries times then throws', async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'Service Unavailable' };
  };
  const http = new Http({ fetch: fake, maxRetries: 2, delayFn: () => Promise.resolve() });
  await assert.rejects(() => http.request({ method: 'GET', url: 'https://x/health', ks: 'k' }), (e) => {
    assert.ok(e instanceof KalturaError);
    assert.equal(e.status, 503);
    return true;
  });
  assert.equal(calls, 3, 'should try 1 initial + 2 retries = 3 total');
});

test('R-1: 429 is retried for GET requests', async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 429, headers: { get: () => null }, text: async () => '{"detail":"rate limited"}' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"ok":true}' };
  };
  const http = new Http({ fetch: fake, maxRetries: 3, delayFn: () => Promise.resolve() });
  const { data } = await http.request({ method: 'GET', url: 'https://x/y', ks: 'k' });
  assert.deepEqual(data, { ok: true });
  assert.equal(calls, 3);
});

test('R-1: non-retriable 401 is NOT retried', async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    return { ok: false, status: 401, headers: { get: () => null }, text: async () => '{"message":"Unauthorized"}' };
  };
  const http = new Http({ fetch: fake, maxRetries: 3, delayFn: () => Promise.resolve() });
  await assert.rejects(() => http.request({ method: 'GET', url: 'https://x/y', ks: 'k' }), (e) => {
    assert.equal(e.status, 401);
    return true;
  });
  assert.equal(calls, 1, '401 must not be retried');
});

test('R-1: non-retriable 403 is NOT retried', async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    return { ok: false, status: 403, headers: { get: () => null }, text: async () => '{}' };
  };
  const http = new Http({ fetch: fake, maxRetries: 3, delayFn: () => Promise.resolve() });
  await assert.rejects(() => http.request({ method: 'GET', url: 'https://x/y', ks: 'k' }));
  assert.equal(calls, 1, '403 must not be retried');
});

test('R-2: GET requires no idempotency key to be retry-safe', async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    if (calls < 2) return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'err' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"ok":true}' };
  };
  const http = new Http({ fetch: fake, maxRetries: 3, delayFn: () => Promise.resolve() });
  // No idempotencyKey passed at all — a GET's retry-safety never depends on one.
  const { data } = await http.request({ method: 'GET', url: 'https://x/y', ks: 'k' });
  assert.deepEqual(data, { ok: true });
  assert.equal(calls, 2, 'GET retried on 503 with no idempotency key involved');
});

test('R-3: POST with idempotency-key is retried on 503', async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    if (calls < 3) return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'err' };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"id":"new"}' };
  };
  const http = new Http({ fetch: fake, maxRetries: 3, delayFn: () => Promise.resolve() });
  const { data } = await http.postJson({ url: 'https://x/create', ks: 'k', body: {}, idempotencyKey: 'idem-1' });
  assert.deepEqual(data, { id: 'new' });
  assert.equal(calls, 3);
});

test('R-3: POST without idempotency-key is retried on network error (status 0) but not on 503', async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'err' };
  };
  const http = new Http({ fetch: fake, maxRetries: 3, delayFn: () => Promise.resolve() });
  await assert.rejects(() => http.postJson({ url: 'https://x/create', ks: 'k', body: {} }));
  assert.equal(calls, 1, 'POST without idempotency key must not be retried on 503');
});

test('R-1: network error (status 0) is always retried regardless of method', async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    if (calls < 3) throw new TypeError('fetch failed');
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"ok":true}' };
  };
  const http = new Http({ fetch: fake, maxRetries: 3, delayFn: () => Promise.resolve() });
  const { data } = await http.postJson({ url: 'https://x/y', ks: 'k', body: {} });
  assert.deepEqual(data, { ok: true });
  assert.equal(calls, 3);
});

test('R-4: abort signal stops retry loop immediately', async () => {
  let calls = 0;
  const ctrl = new AbortController();
  const fake = async () => {
    calls++;
    ctrl.abort();
    return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'err' };
  };
  const http = new Http({ fetch: fake, maxRetries: 3, delayFn: () => Promise.resolve() });
  await assert.rejects(() => http.request({ method: 'GET', url: 'https://x/y', ks: 'k', signal: ctrl.signal }));
  assert.ok(calls <= 2, 'abort must stop retries immediately (got ' + calls + ' calls)');
});

test('R-5: delayFn is called between retries', async () => {
  let delayCalls = 0;
  let calls = 0;
  const fake = async () => {
    calls++;
    return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'err' };
  };
  const http = new Http({
    fetch: fake, maxRetries: 2,
    delayFn: () => { delayCalls++; return Promise.resolve(); },
  });
  await assert.rejects(() => http.request({ method: 'GET', url: 'https://x/y', ks: 'k' }));
  assert.equal(calls, 3);
  assert.equal(delayCalls, 2, 'delayFn called once per retry (not before first attempt)');
});

// ── Response size budget (P-1) ────────────────────────────────────────────────

test('P-1: response exceeding maxResponseBytes by Content-Length throws response_too_large', async () => {
  const fake = async () => ({
    ok: true, status: 200,
    headers: { get: (h) => h === 'content-length' ? '9999999' : null },
    text: async () => 'x'.repeat(100),
  });
  const http = new Http({ fetch: fake, maxResponseBytes: 1000 });
  await assert.rejects(() => http.postJson({ url: 'https://x/y', ks: 'k', body: {} }), (e) => {
    assert.ok(e instanceof KalturaError);
    assert.equal(e.code, 'response_too_large');
    return true;
  });
});

test('P-1: response body exceeding maxResponseBytes throws response_too_large', async () => {
  const big = 'x'.repeat(2001);
  const fake = async () => ({
    ok: true, status: 200,
    headers: { get: () => null },
    text: async () => big,
  });
  const http = new Http({ fetch: fake, maxResponseBytes: 2000 });
  await assert.rejects(() => http.postJson({ url: 'https://x/y', ks: 'k', body: {} }), (e) => {
    assert.ok(e instanceof KalturaError);
    assert.equal(e.code, 'response_too_large');
    return true;
  });
});

test('P-1: response_too_large is NOT retried', async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    return {
      ok: true, status: 200,
      headers: { get: (h) => h === 'content-length' ? '99999999' : null },
      text: async () => '',
    };
  };
  const http = new Http({ fetch: fake, maxRetries: 3, maxResponseBytes: 1000, delayFn: () => Promise.resolve() });
  await assert.rejects(() => http.postJson({ url: 'https://x/y', ks: 'k', body: {} }), (e) => {
    assert.equal(e.code, 'response_too_large');
    return true;
  });
  assert.equal(calls, 1, 'response_too_large must not be retried');
});

// ── Streaming response size guard (S-1) ───────────────────────────────────────

test('S-1: chunked body without Content-Length is aborted mid-stream, not fully buffered first', async () => {
  const chunkSize = 500;
  const totalChunks = 20; // 10 000 bytes total — far bigger than the 1 000-byte limit below
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (pulled >= totalChunks) { controller.close(); return; }
      pulled++;
      controller.enqueue(new TextEncoder().encode('x'.repeat(chunkSize)));
    },
  });
  const fake = async () => ({
    ok: true, status: 200,
    headers: { get: () => null }, // no Content-Length — forces the streaming guard to do the work
    body: stream,
    // No text() provided: proves the streaming path never falls back to buffering the full body.
  });
  const http = new Http({ fetch: fake, maxResponseBytes: 1000, maxRetries: 0 });
  await assert.rejects(() => http.postJson({ url: 'https://x/y', ks: 'k', body: {} }), (e) => {
    assert.ok(e instanceof KalturaError);
    assert.equal(e.code, 'response_too_large');
    return true;
  });
  // The 1000-byte limit is crossed on the 3rd 500-byte chunk (1500 bytes running total).
  // A small look-ahead margin is allowed for stream backpressure, but the reader must stop
  // long before all 20 chunks (10 000 bytes) are pulled — i.e. aborted mid-stream.
  assert.ok(pulled <= 5, `expected reading to stop shortly after the limit was crossed, but pulled ${pulled}/${totalChunks} chunks`);
});
