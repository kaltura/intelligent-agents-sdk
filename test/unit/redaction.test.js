import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactString } from '../../src/core/redact.js';

test('redacts a KS token (djJ8…)', () => {
  const s = redactString('auth KS djJ8abcdef0123456789ABCDEF_-xyz done');
  assert.ok(s.includes('<KS>'));
  assert.ok(!s.includes('djJ8abcdef'));
});

test('redacts a 32-hex secret', () => {
  assert.equal(redactString('secret=' + 'a1b2c3d4'.repeat(4)), 'secret=<secret>');
});

test('redacts RFC1918 private IPs, keeps public', () => {
  const s = redactString('10.1.2.3 192.168.0.1 172.16.5.9 8.8.8.8 172.32.0.1');
  assert.equal(s, '<private-ip> <private-ip> <private-ip> 8.8.8.8 172.32.0.1');
});

test('deep-redacts objects and arrays', () => {
  const out = redact({ a: ['djJ8' + 'x'.repeat(20)], b: { ip: '10.0.0.1' } });
  assert.equal(out.a[0], '<KS>');
  assert.equal(out.b.ip, '<private-ip>');
});

test('redacts sensitive keys wholesale', () => {
  const out = redact({ secret: 'plain', password: 'pw', token: 'tok', note: 'fine' });
  assert.equal(out.secret, '<redacted>');
  assert.equal(out.password, '<redacted>');
  assert.equal(out.token, '<redacted>');
  assert.equal(out.note, 'fine');
});

test('redacts Authorization, X-Api-Key, Cookie and apiKey header values in any case', () => {
  const out = redact({ headers: { Authorization: 'Bearer sk_live_FAKE', 'x-api-key': 'k1', COOKIE: 'sid=1', apiKey: 'a1', api_key: 'a2', 'API-KEY': 'a3' } });
  for (const v of Object.values(out.headers)) assert.equal(v, '<redacted>');
});

test('redacts authentication.value and keeps its type', () => {
  assert.deepEqual(redact({ authentication: { type: 'bearer', value: 'FAKE' } }), { authentication: { type: 'bearer', value: '<redacted>' } });
});

test('does not redact the key named key', () => {
  assert.deepEqual(redact({ key: 'email' }), { key: 'email' });
});

test('does not redact lookalike keys', () => {
  const input = { apiKeyName: 'a', 'x-api-key-id': 'b', cookieConsent: 'c', authorizationUrl: 'd' };
  assert.deepEqual(redact(input), input);
});

test('value is redacted only under authentication', () => {
  assert.deepEqual(redact({ value: 'x' }), { value: 'x' });
  assert.deepEqual(redact({ other: { value: 'x' } }), { other: { value: 'x' } });
});

test('structurally nukes the entire request_vars sub-tree, leaving siblings', () => {
  const out = redact({
    userMessage: 'hello',
    request_vars: { firstName: 'Ada', email: 'ada@example.com', tier: 'gold' },
    threadId: 't1',
  });
  // whole sub-tree replaced — no arbitrary PII value survives
  assert.equal(out.request_vars, '<request_vars-redacted>');
  assert.ok(!JSON.stringify(out).includes('Ada'));
  assert.ok(!JSON.stringify(out).includes('ada@example.com'));
  // siblings untouched
  assert.equal(out.userMessage, 'hello');
  assert.equal(out.threadId, 't1');
});

test('redacts a NESTED request_vars sub-tree anywhere in the object', () => {
  const out = redact({
    body: { request_vars: { ssn: '123-45-6789' }, sse: false },
    other: 'keep',
  });
  assert.equal(out.body.request_vars, '<request_vars-redacted>');
  assert.equal(out.body.sse, false);
  assert.equal(out.other, 'keep');
  assert.ok(!JSON.stringify(out).includes('123-45-6789'));
});

test('request_vars rule does not affect lookalike keys', () => {
  const out = redact({ request_variables: { x: 'kept' }, requestVars: { y: 'kept' } });
  assert.equal(out.request_variables.x, 'kept');
  assert.equal(out.requestVars.y, 'kept');
});

test('never throws on odd input', () => {
  assert.doesNotThrow(() => redact(undefined));
  assert.doesNotThrow(() => redact(42));
  assert.equal(redact(null), null);
});
