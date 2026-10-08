/* global Headers */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Http } from '../../src/core/http.js';
import { KalturaError } from '../../src/core/errors.js';
import { pickResponseHeaders, makeResponseNotifier } from '../../src/core/response-headers.js';
import { Management } from '../../src/management/client.js';
import { KalturaChatSession } from '../../src/experience/chat-session.js';

// Made-up values only. The 32-hex shape matches a real server trace id.
const TRACE = '0123456789abcdef'.repeat(2);
const KS = 'djJ8' + 'A'.repeat(40);
const res = (status, hdrs, body = '{}') => ({
  ok: status < 400, status,
  headers: new Headers({ 'content-type': 'application/json', ...hdrs }),
  text: async () => body,
});

test('pickResponseHeaders keeps ids, lowercases names, drops cookies and hardening noise', () => {
  const h = new Headers({
    'X-Kaltura-Session': `${TRACE}, 1791405054`, 'X-Session-Id': 'abc123def456', 'X-Me': 'pod-a',
    Via: '1.1 edge (CloudFront)', Server: 'Kaltura', 'Retry-After': '3',
    'Set-Cookie': 'sid=secret', Authorization: 'KS x', 'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  });
  assert.deepEqual(pickResponseHeaders(h), {
    'x-kaltura-session': `${TRACE}, 1791405054`, 'x-session-id': 'abc123def456', 'x-me': 'pod-a',
    via: '1.1 edge (CloudFront)', server: 'Kaltura', 'retry-after': '3',
  });
});

test('pickResponseHeaders keeps 32-hex trace ids but scrubs a KS and a private IP', () => {
  const out = pickResponseHeaders(new Headers({ 'x-proxy-session': TRACE, 'x-debug': `ks=${KS} from 10.1.2.3` }));
  assert.equal(out['x-proxy-session'], TRACE);
  assert.equal(out['x-debug'], 'ks=<KS> from <private-ip>');
});

test('pickResponseHeaders tolerates a fake with no iteration, and non-objects', () => {
  assert.deepEqual(pickResponseHeaders({ get: () => null }), {});
  assert.deepEqual(pickResponseHeaders(undefined), {});
  assert.deepEqual(pickResponseHeaders(null), {});
});

test('makeResponseNotifier swallows a throwing hook and logs a warning', () => {
  const logs = [];
  makeResponseNotifier(() => { throw new Error('boom'); }, (l, m) => logs.push([l, m]))({});
  assert.equal(logs[0][0], 'warn');
  assert.doesNotThrow(() => makeResponseNotifier(undefined)({}));
});

test('Http: failure carries headers on err.headers and toJSON()', async () => {
  const http = new Http({ fetch: async () => res(403, { 'x-session-id': 'abc123def456', 'x-me': 'pod-a' }, '{"error":"nope"}') });
  await assert.rejects(() => http.postJson({ url: 'https://x/y', ks: 'k', body: {} }), (e) => {
    assert.ok(e instanceof KalturaError);
    assert.equal(e.headers['x-session-id'], 'abc123def456');
    assert.equal(e.toJSON().headers['x-me'], 'pod-a');
    return true;
  });
});

test('Http: a failure with no diagnostic headers leaves err.headers undefined', async () => {
  const http = new Http({ fetch: async () => res(404, {}, '{"message":"AGENT_NOT_FOUND"}') });
  await assert.rejects(() => http.postJson({ url: 'https://x/y', ks: 'k', body: {} }), (e) => e.headers === undefined);
});

test('Http: onResponse fires on success with method, path, status, attempt and headers', async () => {
  const seen = [];
  const http = new Http({ fetch: async () => res(200, { 'x-kaltura-session': TRACE, 'x-request-id': 'rid-9' }, '{"v":1}'), onResponse: (i) => seen.push(i) });
  await http.postJson({ url: 'https://x/agent/list', ks: 'k', body: {} });
  assert.equal(seen.length, 1);
  assert.deepEqual({ ...seen[0], headers: undefined }, { method: 'POST', path: '/agent/list', status: 200, ok: true, attempt: 1, requestId: 'rid-9', headers: undefined });
  assert.equal(seen[0].headers['x-kaltura-session'], TRACE);
});

test('Http: onResponse fires once per attempt on retried failures, then on the final success', async () => {
  const seen = [];
  let n = 0;
  const http = new Http({
    fetch: async () => (++n < 3 ? res(503, { 'x-session-id': `s${n}` }) : res(200, { 'x-session-id': 's3' })),
    onResponse: (i) => seen.push([i.attempt, i.status, i.headers['x-session-id']]),
    delayFn: async () => {}, maxRetries: 3,
  });
  await http.request({ method: 'GET', url: 'https://x/y', ks: 'k' });
  assert.deepEqual(seen, [[1, 503, 's1'], [2, 503, 's2'], [3, 200, 's3']]);
});

test('Http: a throwing onResponse hook does not break the call', async () => {
  const http = new Http({ fetch: async () => res(200, {}, '{"v":1}'), onResponse: () => { throw new Error('boom'); } });
  const { data } = await http.postJson({ url: 'https://x/y', ks: 'k', body: {} });
  assert.equal(data.v, 1);
});

test('Http: debug log gets the headers', async () => {
  const logs = [];
  const http = new Http({ fetch: async () => res(200, { 'x-session-id': 'abc123def456' }), logger: (l, m, d) => logs.push([m, d]) });
  await http.postJson({ url: 'https://x/y', ks: 'k', body: {} });
  const line = logs.find(([m]) => m.includes('headers'));
  assert.equal(line[1]['x-session-id'], 'abc123def456');
});

test('Http: HTTP 200 with an exception body carries the headers too', async () => {
  const body = JSON.stringify({ objectType: 'KalturaAPIException', code: 'SERVICE_FORBIDDEN', message: 'no' });
  const http = new Http({ fetch: async () => res(200, { 'x-kaltura': 'error-SERVICE_FORBIDDEN' }, body) });
  await assert.rejects(() => http.postJson({ url: 'https://x/y', ks: 'k', body: {} }), (e) => e.headers?.['x-kaltura'] === 'error-SERVICE_FORBIDDEN');
});

test('Management: onResponse reaches the transport; an OVP exception error keeps its headers', async () => {
  const seen = [];
  const body = JSON.stringify({ objectType: 'KalturaAPIException', code: 'SERVICE_FORBIDDEN', message: 'no' });
  const mgmt = new Management({ partnerId: 1, adminSecret: 'x', fetch: async () => res(200, { 'x-kaltura': 'error-SERVICE_FORBIDDEN', 'x-proxy-session': TRACE }, body), onResponse: (i) => seen.push(i) });
  await assert.rejects(() => mgmt._ctx.ovp('session', 'get', {}, 'djJ8' + 'B'.repeat(40)), (e) => e instanceof KalturaError && e.headers['x-proxy-session'] === TRACE);
  assert.equal(seen[0].headers['x-kaltura'], 'error-SERVICE_FORBIDDEN');
});

test('ChatSession converse: onResponse and err.headers on a failed call', async () => {
  const seen = [];
  const s = new KalturaChatSession({
    token: 'djJ8' + 'C'.repeat(40), genieUrl: 'https://genie.example.com',
    fetch: async () => res(500, { 'x-me': 'pod-g' }, '{"message":"x"}'), onResponse: (i) => seen.push(i),
  });
  await assert.rejects(() => s._converseFetch({}, undefined), (e) => e.headers?.['x-me'] === 'pod-g');
  assert.equal(seen[0].path, '/assistant/converse');
  assert.equal(seen[0].status, 500);
});
