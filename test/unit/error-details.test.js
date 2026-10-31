/* global Headers */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorFromResponse, errorFromOkBody } from '../../src/core/errors.js';
import { Http } from '../../src/core/http.js';
import { Management } from '../../src/management/index.js';
import { KalturaChatSession } from '../../src/experience/chat-session.js';

// ── rate_limited: object-shaped detail and Retry-After ────────────────────────

const RATE_BODY = { detail: { error: 'Rate limit exceeded', limit: 250, window: '1 minute', current_count: 251, reset_in: 12 } };

test('429 with an object detail surfaces error, limit and window in the message', () => {
  const e = errorFromResponse({ status: 429, path: '/mcp/search', body: RATE_BODY, headers: { 'retry-after': '12' } });
  assert.equal(e.code, 'rate_limited');
  assert.equal(e.status, 429);
  assert.match(e.detail, /^Rate limit exceeded \(limit 250 per 1 minute\)/);
  assert.equal(e.message, e.detail);
  assert.deepEqual(e.body, RATE_BODY, 'the raw body stays on the error');
});

test('429 exposes retryAfter as a number of seconds and says so in the detail', () => {
  const e = errorFromResponse({ status: 429, path: '/mcp/search', body: RATE_BODY, headers: { 'retry-after': '12' } });
  assert.equal(e.retryAfter, 12);
  assert.match(e.detail, /Retry after 12 seconds\.$/);
  assert.equal(e.toJSON().retryAfter, 12);
  assert.equal(errorFromResponse({ status: 429, path: '/x', body: null, headers: { 'retry-after': '1' } }).detail, 'HTTP 429 from /x. Retry after 1 second.');
});

test('retryAfter accepts 0 and a Retry-After header in any letter case', () => {
  assert.equal(errorFromResponse({ status: 429, path: '/x', body: null, headers: { 'retry-after': '0' } }).retryAfter, 0);
  assert.equal(errorFromResponse({ status: 429, path: '/x', body: null, headers: { 'Retry-After': ' 7 ' } }).retryAfter, 7);
});

test('retryAfter reads an HTTP-date as the seconds from now, never below 0', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('Wed, 21 Oct 2026 07:28:00 GMT') });
  const at = (v) => errorFromResponse({ status: 429, path: '/x', body: null, headers: { 'retry-after': v } }).retryAfter;
  assert.equal(at('Wed, 21 Oct 2026 07:28:30 GMT'), 30);
  assert.equal(at('Wed, 21 Oct 2026 07:28:00 GMT'), 0);
  assert.equal(at('Wed, 21 Oct 2026 07:00:00 GMT'), 0, 'a date in the past');
});

test('retryAfter reads the RFC 850 and asctime HTTP-date formats', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('Wed, 21 Oct 2026 07:28:00 GMT') });
  const at = (v) => errorFromResponse({ status: 429, path: '/x', body: null, headers: { 'retry-after': v } }).retryAfter;
  assert.equal(at('Wednesday, 21-Oct-26 07:28:30 GMT'), 30, 'RFC 850');
  assert.equal(at('Wed Oct 21 07:28:30 2026'), 30, 'asctime');
  assert.equal(at('Wed Oct  1 07:28:30 2026'), 0, 'asctime with a space-padded day, in the past');
  assert.equal(at('Wednesday, 21-Oct-26 07:00:00 GMT'), 0, 'a date in the past');
  assert.equal(at('Wed, 31 Feb 2026 07:28:30 GMT'), undefined, 'an impossible date');
  assert.equal(at('Wed Oct 21 25:28:30 2026'), undefined, 'an impossible time');
});

test('retryAfter applies the RFC 850 fifty-year cutoff to the full timestamp', (t) => {
  const now = Date.parse('Sat, 31 Oct 2026 00:00:00 GMT');
  t.mock.timers.enable({ apis: ['Date'], now });
  const at = (v) => errorFromResponse({ status: 429, path: '/x', body: null, headers: { 'retry-after': v } }).retryAfter;
  assert.equal(at('Monday, 01-Nov-76 00:00:00 GMT'), 0, 'one day past the cutoff is 1976');
  assert.equal(at('Sunday, 31-Oct-76 00:00:00 GMT'), Math.ceil((Date.UTC(2076, 9, 31) - now) / 1000), 'exactly 50 years ahead stays 2076');
  assert.equal(at('Saturday, 30-Oct-76 23:59:59 GMT'), Math.ceil((Date.UTC(2076, 9, 30, 23, 59, 59) - now) / 1000), 'one second inside the cutoff stays 2076');
});

test('retryAfter stays undefined for a missing, empty, negative, fractional or non-date Retry-After', () => {
  for (const v of [undefined, '', '   ', '-5', '1.5', '1e3', 'soon', 'abc 1', '12 seconds', '0x10', 'Tomorrow', '99999999999999999999999', '9'.repeat(400), '120, 120']) {
    const headers = v === undefined ? {} : { 'retry-after': v };
    const e = errorFromResponse({ status: 429, path: '/x', body: null, headers });
    assert.equal(e.retryAfter, undefined, `Retry-After ${JSON.stringify(v)}`);
    assert.equal(e.detail, 'HTTP 429 from /x', 'no retry sentence without a usable value');
    assert.ok(!('retryAfter' in e.toJSON()));
  }
  assert.equal(errorFromResponse({ status: 429, path: '/x', body: null }).retryAfter, undefined, 'no headers at all');
});

test('a string detail on 429 is unchanged and still gets retryAfter', () => {
  const e = errorFromResponse({ status: 429, path: '/x', body: { detail: 'Too many requests' }, headers: { 'retry-after': '3' } });
  assert.equal(e.detail, 'Too many requests. Retry after 3 seconds.');
  assert.equal(e.retryAfter, 3);
});

test('an object detail with partial or odd fields never throws', () => {
  const d = (detail) => errorFromResponse({ status: 429, path: '/x', body: { detail } }).detail;
  assert.equal(d({ error: 'Rate limit exceeded' }), 'Rate limit exceeded');
  assert.equal(d({ error: 'Rate limit exceeded', limit: 5 }), 'Rate limit exceeded (limit 5)');
  assert.equal(d({ error: 'Rate limit exceeded', window: '1 hour' }), 'Rate limit exceeded (window 1 hour)');
  assert.equal(d({ message: 'Slow down', limit: 0, window: '1 second' }), 'Slow down (limit 0 per 1 second)');
  assert.equal(d({ error: 'Rate limit exceeded', limit: 'many', window: 60 }), 'Rate limit exceeded', 'wrong types are ignored');
  assert.equal(d({ error: 'Rate limit exceeded', limit: NaN }), 'Rate limit exceeded');
  assert.equal(d({ limit: 5, window: '1 minute' }), 'HTTP 429 from /x', 'no text to show');
  assert.equal(d({ error: 42 }), 'HTTP 429 from /x');
  assert.equal(d({}), 'HTTP 429 from /x');
  assert.equal(d(null), 'HTTP 429 from /x');
  assert.equal(d(['x']), 'x', 'an array detail keeps its existing handling');
});

test('an object detail on another status is read the same way', () => {
  const e = errorFromResponse({ status: 400, path: '/x', body: { detail: { error: 'Bad input' } } });
  assert.equal(e.detail, 'Bad input');
  assert.equal(e.retryAfter, undefined);
});

test('a secret inside an object detail is redacted before it is cut', () => {
  const secret = 'a1b2c3d4e5f60718'.repeat(2);
  const e = errorFromResponse({ status: 429, path: '/x', body: { detail: { error: `${'x'.repeat(490)} ${secret}` } } });
  assert.ok(!e.detail.includes(secret.slice(0, 8)), e.detail);
  assert.ok(e.detail.length <= 500, 'cut to 500 chars');
});

test('retryAfter also rides on a 503 that carries Retry-After', () => {
  assert.equal(errorFromResponse({ status: 503, path: '/x', body: null, headers: { 'retry-after': '30' } }).retryAfter, 30);
});

// Every client that turns a failed response into an error goes through errorFromResponse.
// These tests pin that the header reaches it from each of them.

const res429 = (retryAfter) => ({
  ok: false, status: 429,
  headers: new Headers({ 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) }),
  text: async () => JSON.stringify(RATE_BODY),
  body: null,
});

test('Http.request throws rate_limited with retryAfter from the response header (no retry on a POST)', async () => {
  let calls = 0;
  const http = new Http({ fetch: async () => { calls++; return res429('19'); }, delayFn: () => Promise.resolve() });
  await assert.rejects(() => http.postJson({ url: 'https://x/mcp/search', ks: 'k', body: {} }), (e) => {
    assert.equal(e.code, 'rate_limited');
    assert.equal(e.retryAfter, 19);
    assert.match(e.detail, /^Rate limit exceeded \(limit 250 per 1 minute\)\. Retry after 19 seconds\.$/);
    assert.equal(e.headers['retry-after'], '19');
    return true;
  });
  assert.equal(calls, 1);
});

test('the management converse stream throws rate_limited with retryAfter', async () => {
  const mgmt = new Management({ partnerId: 1234567, adminSecret: 'a'.repeat(32), fetch: async () => res429('5') });
  await assert.rejects(() => mgmt._ctx.genieStream('assistant/converse', {}, 'ks'), (e) => {
    assert.equal(e.code, 'rate_limited');
    assert.equal(e.retryAfter, 5);
    assert.match(e.detail, /Rate limit exceeded/);
    return true;
  });
});

test('the chat session converse call throws rate_limited with retryAfter', async () => {
  const session = Object.create(KalturaChatSession.prototype);
  Object.assign(session, { _genieUrl: 'https://g', _token: 'k', _fetch: async () => res429('8'), _notify: () => {} });
  await assert.rejects(() => session._converseFetch({}, undefined), (e) => {
    assert.equal(e.code, 'rate_limited');
    assert.equal(e.retryAfter, 8);
    return true;
  });
});

// ── platform answers that get their own code and hint ─────────────────────────

test('the file-type-restricted upload answer (HTTP 200, code in title) gets a typed code and a hint', () => {
  const e = errorFromOkBody(
    { code: 'UPLOAD_TOKEN_FILE_TYPE_RESTRICTED_FOR_UPLOAD', message: 'Upload token is restricted due to the file type', objectType: 'KalturaAPIException', args: [] },
    '/service/uploadtoken/action/upload',
  );
  assert.equal(e.code, 'upload_file_type_restricted');
  assert.equal(e.title, 'UPLOAD_TOKEN_FILE_TYPE_RESTRICTED_FOR_UPLOAD', 'the platform code stays in title');
  assert.equal(e.status, 200);
  assert.equal(e.retryable, false);
  assert.match(e.detail, /^Upload token is restricted due to the file type\. /);
  assert.match(e.detail, /Upload a different file type/);
});

test('voice import with no samples gets a typed code whose hint names catalog.createVoice', () => {
  const e = errorFromOkBody(
    { code: 'VOICE_DOES_NOT_HAVE_SAMPLES', message: 'The voice with id EXAVITQu4vr4xnSDxMaL does not have any samples on ElevenLabs, cannot be cloned', objectType: 'KalturaAPIException' },
    '/catalog-item/createVoiceFromElevenLabs',
  );
  assert.equal(e.code, 'voice_has_no_samples');
  assert.equal(e.status, 200);
  assert.match(e.detail, /does not have any samples/);
  assert.match(e.detail, /Upload an audio file with catalog\.createVoice instead\.$/);
});

test('an api_exception without a hinted code has no appended hint', () => {
  const e = errorFromOkBody({ code: 'SOMETHING_ELSE', message: 'Nope', objectType: 'KalturaAPIException' }, '/x');
  assert.equal(e.code, 'api_exception');
  assert.equal(e.detail, 'Nope');
});
