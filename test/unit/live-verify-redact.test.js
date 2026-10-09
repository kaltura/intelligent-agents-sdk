import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../scripts/lib/redact.mjs';

test('live-verify redact hides KS tokens, query strings, avatar stream and session ids, and UUIDs', () => {
  const line = 'POST host.example/rtc/v1/stv/AbC-123_xyz/whep/session/a0afa851-a61e-4c47-ac81-6dbcff709f80 → 404';
  assert.equal(redact(line), 'POST host.example/rtc/v1/stv/<id>/whep/session/<id> → 404');
  assert.equal(redact('wss://h.example/socket?partnerId=123&x=1'), 'wss://h.example/socket?<query>');
  assert.equal(redact('ks djJ8abcDEF012_-xyz end'), 'ks <KS> end');
  assert.equal(redact('id 123e4567-e89b-12d3-a456-426614174000.'), 'id <uuid>.');
});
