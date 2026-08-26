import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia } from '../fakes/rtc.js';

/**
 * Experience-front security hardening (enterprise/gov). Transport TLS enforcement
 * (OWASP/NIST SC-8), AI-disclosure ordering (EU AI Act Art. 50), prototype-pollution
 * scrubbing (OWASP deserialization), token hygiene (non-enumerable + drop-on-disconnect),
 * mid-session token rotation, and structured audit events (NIST AU-2/AU-3).
 */
const KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

function mk(over = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const s = new KalturaAvatarSession({
    token: KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.x',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory: () => socket,
    rtcConstructor: FakeRTCPeerConnection, networkAware: false,
    fetch: async () => ({ ok: true, status: 201, text: async () => 'v=0\r\na', headers: { get: () => 'https://srs/whep/1' } }),
    getUserMedia: fakeGetUserMedia(), ...over,
  });
  return { s, socket };
}

test('transport: insecure conversationManagerUrl throws insecure_transport', () => {
  assert.throws(() => mk({ conversationManagerUrl: 'http://cm.evil.example' }).s, (e) => e.code === 'insecure_transport');
});

test('transport: insecure srsBaseUrl throws insecure_transport', () => {
  assert.throws(() => mk({ srsBaseUrl: 'http://srs.evil.example' }).s, (e) => e.code === 'insecure_transport');
});

test('transport: localhost http is allowed (dev) with a one-time warning', () => {
  const warnings = [];
  assert.doesNotThrow(() => mk({ conversationManagerUrl: 'http://localhost:8080', logger: (l, m) => warnings.push(m) }));
  assert.ok(warnings.some((w) => /insecure/i.test(w)), 'a security warning was emitted');
});

test('transport: allowInsecureTransport opt-out permits non-localhost http (with warning)', () => {
  const warnings = [];
  assert.doesNotThrow(() => mk({ conversationManagerUrl: 'http://staging.internal', allowInsecureTransport: true, logger: (l, m) => warnings.push(m) }));
  assert.ok(warnings.some((w) => /insecure/i.test(w)));
});

test('disclosure fires during connect, and the greeting (approvedPermissions) is emitted', async () => {
  const { s, socket } = mk();
  scriptHappyPath(socket);
  let disclosed = false;
  s.on('disclosure', () => { disclosed = true; });
  await s.connect();
  assert.ok(disclosed, 'disclosure emitted');
  assert.ok(socket.didEmit('approvedPermissions'), 'greeting approved');
  s.disconnect();
});

test('requireDisclosureAck holds the greeting until acknowledgeDisclosure()', async () => {
  const { s, socket } = mk({ requireDisclosureAck: true });
  scriptHappyPath(socket);
  await s.connect();
  assert.equal(socket.didEmit('approvedPermissions'), false, 'greeting held pending ack');
  assert.equal(s.state, 'connected', 'session is otherwise fully connected');
  s.acknowledgeDisclosure();
  assert.ok(socket.didEmit('approvedPermissions'), 'greeting released after ack');
  s.disconnect();
});

test('setDynamicPrompt scrubs prototype-pollution keys, keeps real data', async () => {
  const { s, socket } = mk();
  scriptHappyPath(socket);
  await s.connect();
  const evil = JSON.parse('{"slide":5,"title":"Rev","__proto__":{"polluted":true}}');
  s.setDynamicPrompt(evil);
  const sent = socket.emitsOf('updateGenieContext')[0];
  const ctx = JSON.parse(sent.request_vars.page_context);
  assert.equal(ctx.slide, 5);
  assert.equal(ctx.title, 'Rev');
  assert.equal({}.polluted, undefined, 'global prototype not polluted');
  assert.ok(!JSON.stringify(sent).includes('polluted'), '__proto__ payload dropped from the wire');
  s.disconnect();
});

test('token field is non-enumerable and dropped on disconnect', async () => {
  const { s, socket } = mk();
  scriptHappyPath(socket);
  await s.connect();
  assert.ok(!Object.keys(s).includes('_token'), '_token is non-enumerable');
  s.disconnect();
  assert.equal(s._token, null, 'token reference dropped on disconnect (bounded blast radius)');
});

test('setToken rotates the conversation token', async () => {
  const { s, socket } = mk();
  scriptHappyPath(socket);
  await s.connect();
  const fresh = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
  assert.doesNotThrow(() => s.setToken(fresh));
  s.disconnect();
});

test('audit: session.connect + session.disconnect fire, redacted', async () => {
  const events = [];
  const { s, socket } = mk({ onAuditEvent: (e) => events.push(e) });
  scriptHappyPath(socket);
  await s.connect();
  s.disconnect();
  assert.ok(events.some((e) => e.type === 'session.connect' && e.outcome === 'success'));
  assert.ok(events.some((e) => e.type === 'session.disconnect'));
  assert.ok(!JSON.stringify(events).includes('djJ8'), 'no raw KS in any audit event');
});

test('audit hook is crash-safe: a throwing sink never breaks connect', async () => {
  const { s, socket } = mk({ onAuditEvent: () => { throw new Error('SIEM down'); } });
  scriptHappyPath(socket);
  await assert.doesNotReject(() => s.connect());
  assert.equal(s.state, 'connected');
  s.disconnect();
});

test('ephemeral TURN credentials are used over the static fallback', () => {
  const { s } = mk({ turnServerUrl: 'turn.example', turnCredentials: { username: 'eph-user', credential: 'eph-cred', expiry: 9999 } });
  // Reach into the resolved ICE for the ASR channel via the stored turn config.
  assert.equal(s._turn.username, 'eph-user');
  assert.equal(s._turn.credential, 'eph-cred');
});
