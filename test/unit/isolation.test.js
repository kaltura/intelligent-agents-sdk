import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/index.js';
import { Sessions } from '../../src/core/session.js';
import { fakeFetch } from '../fakes/fetch.js';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia } from '../fakes/rtc.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

/** Build + connect a KalturaAvatarSession over fakes, with its own socket/peer instances. */
async function connectSession(cfg = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl: new FakeVideoEl(),
    socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: async () => ({ ok: true, status: 201, text: async () => 'a', headers: { get: () => 'loc' } }),
    getUserMedia: fakeGetUserMedia(), ...cfg,
  });
  scriptHappyPath(socket);
  await session.connect();
  return { session, socket };
}

/**
 * Isolation & multi-tenancy (NIST SC-4 / AC-6(4)). No credential or tenant state
 * lives at module scope; two instances for different partners never observe each
 * other's secret/tokens. A single process can host N tenants safely.
 */

const A = 'a'.repeat(32), B = 'b'.repeat(32);

test('two Management instances are fully independent (no shared state)', () => {
  const a = new Management({ partnerId: '111', adminSecret: A });
  const b = new Management({ partnerId: '222', adminSecret: B });
  assert.notEqual(a.sessions, b.sessions);
  assert.notEqual(a._ctx, b._ctx);
  assert.equal(a._ctx.partnerId, '111');
  assert.equal(b._ctx.partnerId, '222');
});

test('admin secret is non-enumerable and never serialized', () => {
  const m = new Management({ partnerId: '111', adminSecret: A });
  assert.ok(!Object.keys(m.sessions).includes('_adminSecret'), 'secret not an enumerable own-key');
  assert.ok(!JSON.stringify(m).includes(A), 'secret not in JSON.stringify of the whole client');
});

test('no credential bleed: instance A cannot observe instance B secret via any enumerable path', () => {
  const a = new Management({ partnerId: '111', adminSecret: A });
  const b = new Management({ partnerId: '222', adminSecret: B });
  const dump = JSON.stringify(a) + JSON.stringify(b) + JSON.stringify(Object.keys(a)) + JSON.stringify(Object.keys(b));
  assert.ok(!dump.includes(A) && !dump.includes(B), 'no secret leaks through enumeration of either instance');
});

test('concurrent token mints on two tenants do not cross tokens', async () => {
  const fa = fakeFetch([{ match: '/service/session/action/start', respond: () => ({ body: 'djJ8' + Buffer.from('v2|111|geniegpcid:1').toString('base64url') }) }]);
  const fb = fakeFetch([{ match: '/service/session/action/start', respond: () => ({ body: 'djJ8' + Buffer.from('v2|222|geniegpcid:2').toString('base64url') }) }]);
  const a = new Management({ partnerId: '111', adminSecret: A, fetch: fa });
  const b = new Management({ partnerId: '222', adminSecret: B, fetch: fb });
  const [ta, tb] = await Promise.all([
    a.sessions.createConversationToken({ configId: 1 }),
    b.sessions.createConversationToken({ configId: 2 }),
  ]);
  assert.equal(ta.scope.partnerId, '111');
  assert.equal(tb.scope.partnerId, '222');
  assert.notEqual(ta.ks, tb.ks);
});

test('module scope holds no mutable credential state (fresh Sessions has its own)', () => {
  const s1 = new Sessions({ partnerId: '1', adminSecret: A, http: {} });
  const s2 = new Sessions({ partnerId: '2', adminSecret: B, http: {} });
  assert.equal(s1._partnerId, '1');
  assert.equal(s2._partnerId, '2');
  // The secrets are independent + non-enumerable on each.
  assert.ok(!Object.keys(s1).includes('_adminSecret'));
  assert.ok(!Object.keys(s2).includes('_adminSecret'));
});

// ─────────────────────────── issue #31 rule 1.1: KalturaAvatarSession per-instance state ───────────────────────────

test('two KalturaAvatarSession instances never leak requestVars or pending tool-ACK state (issue #31 rule 1.1)', async () => {
  const one = await connectSession({ requestVars: { user_name: 'Ada' } });
  const two = await connectSession({ requestVars: { user_name: 'Grace' } });

  // join-time requestVars are per-instance, not shared/overwritten by the second construction.
  assert.deepEqual(one.session._requestVars, { user_name: 'Ada' });
  assert.deepEqual(two.session._requestVars, { user_name: 'Grace' });

  // updateRequestVars on one instance's socket never touches the other's.
  one.session.updateRequestVars({ user_name: 'Ada', tier: 'enterprise' });
  assert.deepEqual(one.socket.emitsOf('updateGenieContext').pop(), { request_vars: { user_name: 'Ada', tier: 'enterprise' } });
  assert.equal(two.socket.didEmit('updateGenieContext'), false, 'the second session never saw the first\'s updateRequestVars call');
  assert.deepEqual(two.session._requestVars, { user_name: 'Grace' }, 'the second session\'s own requestVars is untouched');

  // pending tool-ACK maps are separate Map instances per session (never module-scope shared).
  assert.notEqual(one.session._pendingToolAcks, two.session._pendingToolAcks);
  one.session._pendingToolAcks.set('req-1', { name: 'navigate_to_slide' });
  assert.equal(two.session._pendingToolAcks.has('req-1'), false, 'a pending ACK on one instance is invisible to the other');
});
