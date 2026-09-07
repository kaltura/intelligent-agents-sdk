import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/index.js';
import { Sessions } from '../../src/core/session.js';
import { fakeFetch } from '../fakes/fetch.js';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

/** Build + connect a KalturaAvatarSession over fakes, with its own socket/peer instances. */
async function connectSession(cfg = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl: new FakeVideoEl(),
    socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: async () => ({ ok: true, status: 201, text: async () => 'a', headers: { get: () => 'loc' } }),
    getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, ...cfg,
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

// ─────────────────────────── userId is a per-call param, never shared state ───────────────────────────

test('concurrent mints with different userIds across two Sessions instances never bleed', async () => {
  const fa = fakeFetch([{ match: '/service/session/action/start', respond: () => ({ body: 'djJ8' + Buffer.from('v2|111|geniegpcid:1').toString('base64url') }) }]);
  const fb = fakeFetch([{ match: '/service/session/action/start', respond: () => ({ body: 'djJ8' + Buffer.from('v2|222|geniegpcid:2').toString('base64url') }) }]);
  const auditA = [], auditB = [];
  const a = new Management({ partnerId: '111', adminSecret: A, fetch: fa, onAuditEvent: (e) => auditA.push(e) });
  const b = new Management({ partnerId: '222', adminSecret: B, fetch: fb, onAuditEvent: (e) => auditB.push(e) });

  // Interleave: two mints per instance, each with a DIFFERENT userId, all in flight at once.
  const [a1, b1, a2, b2] = await Promise.all([
    a.sessions.createConversationToken({ configId: 1, userId: 'learner-a1' }),
    b.sessions.createConversationToken({ configId: 2, userId: 'learner-b1' }),
    a.sessions.createAdminToken({ userId: 'ops-a2' }),
    b.sessions.createAdminToken({ userId: 'ops-b2' }),
  ]);

  // Each token's own scope carries only ITS OWN userId — no cross-call/cross-instance bleed.
  assert.equal(a1.scope.userId, 'learner-a1');
  assert.equal(b1.scope.userId, 'learner-b1');
  assert.equal(a2.scope.userId, 'ops-a2');
  assert.equal(b2.scope.userId, 'ops-b2');

  // Sessions never cached userId on the instance (per SDK_CONSTITUTION "no shared mutable state").
  assert.ok(!('_userId' in a.sessions) && !('_userId' in b.sessions), 'userId is not retained on the Sessions instance');

  // Instance A's audit trail only ever names A's own subjects, never B's (and vice versa).
  const subjectsA = auditA.map((e) => e.actor.subjectId);
  const subjectsB = auditB.map((e) => e.actor.subjectId);
  assert.deepEqual(new Set(subjectsA), new Set(['learner-a1', 'ops-a2']));
  assert.deepEqual(new Set(subjectsB), new Set(['learner-b1', 'ops-b2']));
});

test('userId omitted on either method is a byte-for-byte no-op (zero behavior change for anonymous callers)', async () => {
  const KS = 'djJ8' + Buffer.from('v2|123|x').toString('base64url');
  const f = fakeFetch([{ match: '/service/session/action/start', respond: () => ({ body: `"${KS}"` }) }]);
  const m = new Management({ partnerId: 123, adminSecret: A, fetch: f });
  const t = await m.sessions.createConversationToken({ configId: 1222 });
  assert.equal(t.scope.userId, undefined, 'no userId key on the scope receipt when none was passed');
  const call = f.calls.find((c) => c.url.includes('/session/action/start'));
  assert.doesNotMatch(String(call.body), /userId/i, 'no userId field sent on the wire when omitted');
});

// ─────────────────────────── KalturaAvatarSession per-instance state ───────────────────────────

test('two KalturaAvatarSession instances never leak requestVars or pending tool-ACK state', async () => {
  const one = await connectSession({ requestVars: { user_name: 'Ada' } });
  const two = await connectSession({ requestVars: { user_name: 'Grace' } });

  // join-time requestVars are per-instance, not shared/overwritten by the second construction.
  assert.deepEqual(one.session._requestVars, { user_name: 'Ada' });
  assert.deepEqual(two.session._requestVars, { user_name: 'Grace' });

  // updateRequestVars on one instance's socket never touches the other's.
  // The emit carries the FULL merged map plus the session's own capabilities
  // (the server replaces stored context wholesale — omitting capabilities
  // would wipe them).
  one.session.updateRequestVars({ tier: 'enterprise' });
  assert.deepEqual(one.socket.emitsOf('updateGenieContext').pop(), {
    capabilities: { avatar: 'on', generate_followup_questions: 'on' },
    request_vars: { user_name: 'Ada', tier: 'enterprise' },
  });
  assert.deepEqual(one.session._requestVars, { user_name: 'Ada', tier: 'enterprise' }, 'delta merged into the canonical map');
  assert.equal(two.socket.didEmit('updateGenieContext'), false, 'the second session never saw the first\'s updateRequestVars call');
  assert.deepEqual(two.session._requestVars, { user_name: 'Grace' }, 'the second session\'s own requestVars is untouched');

  // pending tool-ACK maps are separate Map instances per session (never module-scope shared).
  assert.notEqual(one.session._pendingToolAcks, two.session._pendingToolAcks);
  one.session._pendingToolAcks.set('req-1', { name: 'navigate_to_slide' });
  assert.equal(two.session._pendingToolAcks.has('req-1'), false, 'a pending ACK on one instance is invisible to the other');
});

// ─────────────────────────── I-4: event-listener cleanup ───────────────────────────

test('_unwireNetwork() removes exactly the online/offline handlers _wireNetwork() added (two instances, no cross-instance leakage)', async () => {
  // Node has no global addEventListener; stub one so `_wireNetwork()` (gated on its presence) engages.
  const handlers = new Map(); // type -> Set(fn)
  const origAdd = globalThis.addEventListener, origRemove = globalThis.removeEventListener;
  globalThis.addEventListener = (type, fn) => { (handlers.get(type) || handlers.set(type, new Set()).get(type)).add(fn); };
  globalThis.removeEventListener = (type, fn) => { handlers.get(type)?.delete(fn); };
  try {
    const one = await connectSession({ networkAware: true });
    const two = await connectSession({ networkAware: true });
    assert.equal(handlers.get('online').size, 2, 'both instances registered their own online handler');
    assert.equal(handlers.get('offline').size, 2, 'both instances registered their own offline handler');

    one.session.disconnect();
    assert.equal(handlers.get('online').size, 1, 'disconnecting A removes only A\'s online handler');
    assert.equal(handlers.get('offline').size, 1, 'disconnecting A removes only A\'s offline handler');

    two.session.disconnect();
    assert.equal(handlers.get('online').size, 0, 'disconnecting B removes its own online handler too');
    assert.equal(handlers.get('offline').size, 0, 'disconnecting B removes its own offline handler too');
  } finally {
    globalThis.addEventListener = origAdd;
    globalThis.removeEventListener = origRemove;
  }
});

// ─────────────────────────── §5.5.8: avatar media isolation across sessions (multi-avatar) ───────────────────────────

const kinds = (el) => el.srcObject.getTracks().map((t) => t.kind).sort();
const tracksOf = (s) => new Set(s.avatarStream.getTracks());
const disjoint = (a, b) => [...a].every((t) => !b.has(t));

test('three sessions in one process (simple / split / headless): no shared track, stream or element; independent audio controls', async () => {
  const globalsBefore = Object.keys(globalThis).sort();
  const v1 = new FakeVideoEl();
  const v2 = new FakeVideoEl(), a2 = new FakeVideoEl();
  const one = await connectSession({ videoEl: v1 });
  const two = await connectSession({ videoEl: v2, audioEl: a2 });
  const three = await connectSession({ videoEl: null });
  const sessions = [one.session, two.session, three.session];
  for (const s of sessions) assert.equal(s.state, 'connected');

  // Shapes.
  assert.deepEqual(kinds(v1), ['audio', 'video']);
  assert.deepEqual(kinds(v2), ['video']); assert.deepEqual(kinds(a2), ['audio']);
  assert.equal(three.session.videoEl, null);
  assert.deepEqual(three.session.avatarStream.getTracks().map((t) => t.kind).sort(), ['audio', 'video']);

  // No cross-talk: every session's tracks and streams are its own.
  const [t1, t2, t3] = sessions.map(tracksOf);
  assert.ok(disjoint(t1, t2) && disjoint(t1, t3) && disjoint(t2, t3), 'no track is shared across sessions');
  const streams = new Set(sessions.flatMap((s) => [s.avatarStream, s._avatarMedia._v, s._avatarMedia._a]).filter(Boolean));
  assert.equal(streams.size, 2 + 3 + 1, 'simple 2 + split 3 + headless 1 distinct streams');
  assert.ok(sessions.every((s) => s._avatarMedia !== one.session._avatarMedia || s === one.session));

  // Independent controls: mute one, volume another, sink id the third.
  one.session.muteAudioOutput();
  two.session.setAudioOutputVolume(0.2);
  assert.equal(await three.session.setAudioOutput('spk-3'), false, 'headless: stored, but no element to route to yet');
  assert.equal(v1.muted, true); assert.equal(v2.mutedWrites, 0); assert.equal(a2.mutedWrites, 0);
  assert.equal(a2.volume, 0.2); assert.equal(v1.volumeWrites, 0); assert.equal(v2.volumeWrites, 0);
  assert.equal(one.session.audioOutputMuted, true); assert.equal(two.session.audioOutputMuted, false); assert.equal(three.session.audioOutputMuted, false);
  assert.equal(two.session.audioOutputVolume, 0.2); assert.equal(one.session.audioOutputVolume, 1);
  assert.deepEqual(v1.setSinkIdCalls, []); assert.deepEqual(a2.setSinkIdCalls, []);
  assert.equal(await one.session.startPlayback(), true);
  assert.equal(await three.session.startPlayback(), false, 'headless: nothing bound');

  // Teardown of one leaves the others intact.
  const ready = { two: 0, three: 0 };
  two.session.on('mediaReady', () => { ready.two += 1; }); three.session.on('mediaReady', () => { ready.three += 1; });
  one.session.disconnect();
  assert.equal(v1.srcObject, null);
  assert.ok([...t1].every((t) => t.readyState === 'ended'));
  assert.deepEqual(kinds(v2), ['video']); assert.deepEqual(kinds(a2), ['audio']);
  assert.ok([...t2, ...t3].every((t) => t.readyState === 'live'), 'other sessions keep their live tracks');
  assert.equal(two.session.state, 'connected'); assert.equal(three.session.state, 'connected');
  assert.deepEqual(ready, { two: 0, three: 0 }, 'no spurious mediaReady on the survivors');

  two.session.disconnect(); three.session.disconnect();
  assert.deepEqual(Object.keys(globalThis).sort(), globalsBefore, 'no global state added by three sessions');
});

test('headless session: a sink id set with no element is stored and applied to the element bound later', async () => {
  const { session } = await connectSession({ videoEl: null });
  assert.equal(await session.setAudioOutput('spk-9'), false, 'nothing to route to yet → false, never throws');
  const el = new FakeVideoEl();
  session.setVideoEl(el);
  await Promise.resolve();
  assert.deepEqual(el.setSinkIdCalls, ['spk-9']);
  session.disconnect();
});

test('two sessions bound to the SAME video element: no throw, last writer wins, and disconnecting either leaves the other consistent', async () => {
  const shared = new FakeVideoEl();
  const first = await connectSession({ videoEl: shared });
  const second = await connectSession({ videoEl: shared });
  assert.equal(shared.srcObject, second.session._avatarMedia._v, 'last writer wins');
  assert.equal(shared.srcObjectAssignments, 2);
  assert.ok(disjoint(tracksOf(first.session), tracksOf(second.session)));
  first.session.disconnect();
  // The first session clears the element it believes it owns; the second still holds live tracks.
  assert.equal(shared.srcObject, null, 'the app chose to share one element: the SDK cannot arbitrate, it releases on disconnect');
  assert.ok([...tracksOf(second.session)].every((t) => t.readyState === 'live'), "the second session's downlink is untouched");
  assert.equal(second.session.state, 'connected');
  const el2 = new FakeVideoEl();
  second.session.setVideoEl(el2);
  assert.deepEqual(kinds(el2), ['audio', 'video'], 'rebinding the survivor to its own element works');
  second.session.disconnect();
});
