import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaError, errorFromResponse, errorFromOkBody } from '../../src/core/errors.js';

test('maps HTTP statuses to stable codes', () => {
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

test('missing discriminator (intellect update) maps', () => {
  const e = errorFromResponse({ status: 422, path: '/v1/intellect/update', body: { message: 'union_tag_not_found' } });
  assert.equal(e.code, 'missing_discriminator');
});
