import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaError, errorFromResponse, errorFromOkBody } from '../../src/core/errors.js';

test('maps HTTP statuses to stable codes', () => {
  assert.equal(errorFromResponse({ status: 402, path: '/x', body: null }).code, 'payment_required');
  assert.equal(errorFromResponse({ status: 400, path: '/x', body: null }).code, 'bad_request');
  assert.equal(errorFromResponse({ status: 403, path: '/x', body: null }).code, 'forbidden');
  assert.equal(errorFromResponse({ status: 404, path: '/x', body: null }).code, 'not_found');
  assert.equal(errorFromResponse({ status: 422, path: '/x', body: null }).code, 'validation_error');
  assert.equal(errorFromResponse({ status: 429, path: '/x', body: null }).code, 'rate_limited');
  assert.equal(errorFromResponse({ status: 503, path: '/x', body: null }).code, 'server_error');
});

test('recognizes known upstream error strings', () => {
  const e = errorFromResponse({ status: 400, path: '/agent/create', body: { message: 'AGENT_PARTNER_CONFIG_GENIE_ID_MISMATCH' } });
  assert.equal(e.code, 'genie_id_mismatch');
});

test('errorFromOkBody catches an HTTP-200 KalturaAPIException body', () => {
  const body = { message: 'The config Id: 1 belongs to a different genie ID: abc-123 not matching the provided genie ID: probe', code: 'X', args: {} };
  const e = errorFromOkBody(body, '/agent/create');
  assert.ok(e instanceof KalturaError);
  assert.ok(e.detail.includes('different genie ID: abc-123'));
});

test('errorFromOkBody ignores a normal success body', () => {
  assert.equal(errorFromOkBody({ id: 5, status: 2 }, '/intellect/add'), null);
});

test('voice-import provider errors map to specific codes from the HTTP-200 exception envelope', () => {
  const el = errorFromOkBody(
    { objectType: 'KalturaAPIException', code: 'VOICE_DOES_NOT_EXIST_ON_ELEVEN_LABS', message: 'Voice does not exist on ElevenLabs' },
    '/catalog-item/createVoiceFromElevenLabs',
  );
  assert.equal(el.code, 'voice_not_found_elevenlabs');
  const ca = errorFromOkBody(
    { objectType: 'KalturaAPIException', code: 'VOICE_DOES_NOT_EXIST_ON_CARTESIA', message: 'Voice does not exist on Cartesia' },
    '/catalog-item/createVoiceFromCartesia',
  );
  assert.equal(ca.code, 'voice_not_found_cartesia');
});

test('RFC 9457 shape + redaction on toJSON', () => {
  const e = new KalturaError({ type: 'about:blank', title: 't', status: 400, code: 'bad_request', detail: 'leak djJ8' + 'z'.repeat(20), body: { ks: 'djJ8' + 'q'.repeat(20) } });
  const j = e.toJSON();
  assert.equal(j.type, 'about:blank');
  assert.equal(j.code, 'bad_request');
  assert.ok(!JSON.stringify(j).includes('djJ8' + 'z'.repeat(20)), 'detail must be redacted');
});

test('errorFromOkBody maps INVALID_INSIGHT_SETTINGS to a machine-readable code', () => {
  const e = errorFromOkBody(
    { objectType: 'KalturaAPIException', code: 'INVALID_INSIGHT_SETTINGS', message: 'insightSettingsIds references an id that does not exist: 68b...' },
    '/lifecycle/create',
  );
  assert.equal(e.code, 'invalid_insight_settings');
});

test('missing discriminator (intellect update) maps', () => {
  const e = errorFromResponse({ status: 422, path: '/v1/intellect/update', body: { message: 'union_tag_not_found' } });
  assert.equal(e.code, 'missing_discriminator');
});

test('payment_required carries the plan hint, with or without an upstream message', () => {
  const hint = 'The server refused the request as Payment Required, which points to a plan or entitlement limit. Check the plan with your Kaltura contact. A temporary load limit is not reported this way: a live conversation gets the retryable capacity_unavailable instead.';
  assert.equal(errorFromResponse({ status: 402, path: '/x', body: null }).detail, `HTTP 402 from /x. ${hint}`);
  assert.equal(errorFromResponse({ status: 402, path: '/x', body: { message: 'Quota hit.' } }).detail, `Quota hit. ${hint}`);
  assert.equal(errorFromResponse({ status: 403, path: '/x', body: null }).detail, 'HTTP 403 from /x', 'other codes get no hint');
});

test('trailing dots and whitespace are trimmed from the upstream message, even when the text is very long', () => {
  const hint = 'The server refused the request as Payment Required, which points to a plan or entitlement limit. Check the plan with your Kaltura contact. A temporary load limit is not reported this way: a live conversation gets the retryable capacity_unavailable instead.';
  assert.equal(errorFromResponse({ status: 402, path: '/x', body: { message: 'Quota hit . \t\n' } }).detail, `Quota hit. ${hint}`);
  const long = `x${'\t'.repeat(200000)}y`;
  const t0 = Date.now();
  errorFromResponse({ status: 402, path: '/x', body: { message: long } });
  assert.ok(Date.now() - t0 < 500, 'linear time on a long run of whitespace');
});

test('payment_required is marked not retryable; other statuses give no opinion', () => {
  assert.equal(errorFromResponse({ status: 402, path: '/x', body: null }).retryable, false);
  assert.equal(errorFromResponse({ status: 403, path: '/x', body: null }).retryable, undefined);
});

test('a 400 with a message array puts the joined messages in detail', () => {
  const body = { message: ['a must be one of: x, y', 'b should not exist'], error: 'Bad Request', statusCode: 400 };
  const e = errorFromResponse({ status: 400, path: '/x', body });
  assert.equal(e.code, 'bad_request');
  assert.ok(e.detail.includes('a must be one of: x, y; b should not exist'));
  assert.deepEqual(e.body.message, body.message);
});

test('a message array skips non-strings and an empty array falls back to error', () => {
  const e = errorFromResponse({ status: 400, path: '/x', body: { message: [1, null, ''], error: 'Bad Request' } });
  assert.equal(e.detail, 'Bad Request');
  assert.equal(errorFromResponse({ status: 400, path: '/x', body: { message: [], error: 'Bad Request' } }).detail, 'Bad Request');
});

test('a long message array is cut to 500 chars in detail and kept whole in body', () => {
  const e = errorFromResponse({ status: 400, path: '/x', body: { message: ['y'.repeat(800)], error: 'Bad Request' } });
  assert.equal(e.detail.length, 500);
  assert.equal(e.body.message[0].length, 800);
});

test('a message array is redacted before it is cut, so a secret straddling the cutoff is hidden', () => {
  const secret = 'a1b2c3d4e5f60718'.repeat(2);
  const e = errorFromResponse({ status: 400, path: '/x', body: { message: ['x'.repeat(480), `secret ${secret}`], error: 'Bad Request' } });
  assert.ok(!e.detail.includes(secret.slice(0, 8)), e.detail);
  assert.ok(!e.message.includes(secret.slice(0, 8)), e.message);
});
