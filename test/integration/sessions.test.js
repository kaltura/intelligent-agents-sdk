import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management, Sessions } from '../../src/management/index.js';
import { Http } from '../../src/core/http.js';
import { fakeFetch } from '../fakes/fetch.js';

const KS = 'djJ8' + Buffer.from('v2|123|x').toString('base64url');

/** @param {{intellect?:object}} [agent] body returned by agent/get */
function sessionFetch(agent = { agentId: '1_abc123', intellect: { intellectType: 'genie', id: 55 } }) {
  return fakeFetch([
    { match: '/service/session/action/startWidgetSession', respond: () => ({ body: { ks: KS } }) },
    { match: '/service/session/action/start', respond: (_req) => ({ body: `"${KS}"` }) }, // OVP returns a quoted string
    { match: '/agent/get', respond: () => ({ body: agent }) },
  ]);
}

/** The parsed form body of the last session/start call. @param {{calls:{url:string,body:any}[]}} f */
function lastStart(f) {
  const call = f.calls.filter((c) => c.url.includes('/session/action/start')).pop();
  return new URLSearchParams(String(call.body));
}

test('createAdminToken mints disableentitlement, entitlement OFF', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const t = await m.sessions.createAdminToken({ userId: 'ops-console-42' });
  assert.equal(t.kind, 'admin');
  assert.equal(t.sessionType, 'admin');
  assert.equal(t.entitlementEnforced, false);
  assert.equal(t.privileges, 'disableentitlement');
  assert.equal(lastStart(f).get('type'), '2');
  // the request actually sent disableentitlement
  const call = f.calls.find((c) => c.url.includes('/session/action/start'));
  assert.match(String(call.body), /disableentitlement/);
  // scope receipt present, secret never echoed
  assert.equal(t.scope.entitlementEnforced, false);
  assert.ok(!JSON.stringify(t).includes('a'.repeat(32)));
});

test('createConversationToken mints a user session (type 0) with geniegpcid + PLAYBACK_BASE_ROLE, entitlement ON', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const t = await m.sessions.createConversationToken({ configId: 1222 });
  assert.equal(t.kind, 'conversation');
  assert.equal(t.sessionType, 'user');
  assert.equal(t.scope.sessionType, 'user');
  assert.equal(t.entitlementEnforced, true);
  assert.equal(t.privileges, 'geniegpcid:1222,setrole:PLAYBACK_BASE_ROLE');
  const body = lastStart(f);
  assert.equal(body.get('type'), '0');
  assert.equal(body.get('privileges'), 'geniegpcid:1222,setrole:PLAYBACK_BASE_ROLE');
});

test('createConversationToken with agentId adds agentid', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const t = await m.sessions.createConversationToken({ configId: 1222, agentId: '1_abc123' });
  assert.equal(t.privileges, 'geniegpcid:1222,agentid:1_abc123,setrole:PLAYBACK_BASE_ROLE');
});

test('sessionType: "admin" mints type 2 with no forced role, and allows restrictions.role', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const t = await m.sessions.createConversationToken({ configId: 1222, sessionType: 'admin', userId: 'ops-console-42' });
  assert.equal(t.sessionType, 'admin');
  assert.equal(t.privileges, 'geniegpcid:1222');
  assert.equal(lastStart(f).get('type'), '2');
  const r = await m.sessions.createAgentToken({ agentId: '1_abc123', configId: 1222, sessionType: 'admin', userId: 'ops-console-42', restrictions: { role: 7 } });
  assert.equal(r.privileges, 'agentid:1_abc123,geniegpcid:1222,setrole:7');
  assert.equal(lastStart(f).get('type'), '2');
});

test('an invalid sessionType is rejected before any network call', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  for (const sessionType of ['ADMIN', 0, 2, 'widget']) {
    await assert.rejects(() => m.sessions.createConversationToken({ configId: 1222, sessionType }), (e) => e.code === 'bad_request');
  }
  assert.equal(f.calls.length, 0);
});

test('restrictions.role on a user session is rejected before any network call', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    () => m.sessions.createConversationToken({ configId: 1222, restrictions: { role: 7 } }),
    (e) => e.code === 'bad_request' && /PLAYBACK_BASE_ROLE/.test(e.detail),
  );
  await assert.rejects(
    () => m.sessions.createAgentToken({ agentId: '1_abc123', configId: 1222, restrictions: { role: 7 } }),
    (e) => e.code === 'bad_request',
  );
  assert.equal(f.calls.length, 0);
});

test('a second setrole/agentid/geniegpcid in extraPrivileges is rejected before any network call', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  for (const extraPrivileges of ['setrole:7', 'agentid:1_other', 'geniegpcid:9', 'sview:x,SETROLE:7']) {
    await assert.rejects(
      () => m.sessions.createConversationToken({ configId: 1222, agentId: '1_abc123', extraPrivileges }),
      (e) => e.code === 'bad_request',
      extraPrivileges,
    );
  }
  // setrole once is fine on an admin-type session
  const t = await m.sessions.createConversationToken({ configId: 1222, sessionType: 'admin', userId: 'ops-console-42', extraPrivileges: 'setrole:7' });
  assert.equal(t.privileges, 'geniegpcid:1222,setrole:7');
});

test('createAgentToken without configId reads the intellect id from the agent', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const t = await m.sessions.createAgentToken({ agentId: '1_abc123' });
  assert.equal(t.kind, 'agent');
  assert.equal(t.sessionType, 'user');
  assert.equal(t.entitlementEnforced, true);
  assert.equal(t.privileges, 'agentid:1_abc123,geniegpcid:55,setrole:PLAYBACK_BASE_ROLE');
  const get = f.calls.find((c) => c.url.includes('/agent/get'));
  assert.deepEqual(get.body, { agentId: '1_abc123' });
  const body = lastStart(f);
  assert.equal(body.get('type'), '0');
  assert.doesNotMatch(body.get('privileges'), /disableentitlement/);
  // not cached: a second mint looks the agent up again
  await m.sessions.createAgentToken({ agentId: '1_abc123' });
  assert.equal(f.calls.filter((c) => c.url.includes('/agent/get')).length, 2);
});

test('createAgentToken without configId validates before the lookup makes any network call', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  for (const opts of [
    { extraPrivileges: 'disableentitlement' },
    { extraPrivileges: 'geniegpcid:9' },
    { restrictions: { role: 7 } },
    { sessionType: 'widget' },
  ]) {
    await assert.rejects(() => m.sessions.createAgentToken({ agentId: '1_abc123', .../** @type {any} */ (opts) }), (e) => /bad_request|entitlement_violation/.test(e.code), JSON.stringify(opts));
  }
  assert.equal(f.calls.length, 0);
});

test('the agent lookup mints a 60s admin token', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await m.sessions.createAgentToken({ agentId: '1_abc123' });
  const lookup = new URLSearchParams(String(f.calls.find((c) => c.url.includes('/session/action/start')).body));
  assert.equal(lookup.get('type'), '2');
  assert.equal(lookup.get('expiry'), '60');
});

test('createAgentToken with configId skips the agent lookup', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const t = await m.sessions.createAgentToken({ agentId: '1_abc123', configId: 1222 });
  assert.equal(t.privileges, 'agentid:1_abc123,geniegpcid:1222,setrole:PLAYBACK_BASE_ROLE');
  assert.ok(!f.calls.some((c) => c.url.includes('/agent/get')));
});

test('createAgentToken throws intellect_not_found when the agent has no numeric intellect id', async () => {
  const f = sessionFetch({ agentId: '1_abc123', intellect: { intellectType: 'genie' } });
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(() => m.sessions.createAgentToken({ agentId: '1_abc123' }), (e) => e.code === 'intellect_not_found');
  assert.equal(f.calls.filter((c) => c.url.includes('/session/action/start') && /agentid/.test(String(c.body))).length, 0, 'no wrong-persona mint');
});

test('a standalone Sessions (no resolver) mints agentid only', async () => {
  const f = sessionFetch();
  const s = new Sessions({ partnerId: 123, adminSecret: 'a'.repeat(32), http: new Http({ fetch: f }) });
  const t = await s.createAgentToken({ agentId: '1_abc123' });
  assert.equal(t.privileges, 'agentid:1_abc123,setrole:PLAYBACK_BASE_ROLE');
  assert.ok(!f.calls.some((c) => c.url.includes('/agent/get')));
});

test('createAgentToken requires agentId', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  for (const agentId of [undefined, null, '']) {
    await assert.rejects(() => m.sessions.createAgentToken({ agentId }), (e) => e.code === 'bad_request');
  }
  assert.equal(f.calls.length, 0);
});

test('createAgentToken refuses disableentitlement in extraPrivileges', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    () => m.sessions.createAgentToken({ agentId: '1_abc123', configId: 1222, extraPrivileges: 'disableentitlement' }),
    (e) => e.code === 'entitlement_violation',
  );
});

test('converseOnce passes agentId/userId to the auto-mint only', async () => {
  const f = fakeFetch([
    { match: '/service/session/action/start', respond: () => ({ body: `"${KS}"` }) },
    { match: '/assistant/converse', respond: () => ({ body: '{"type":"text","content":"hi"}\n' }) },
  ]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await m.converseOnce(1222, 'hello', { agentId: '1_abc123', userId: 'learner-123' });
  const body = lastStart(f);
  assert.equal(body.get('privileges'), 'geniegpcid:1222,agentid:1_abc123,setrole:PLAYBACK_BASE_ROLE');
  assert.equal(body.get('userId'), 'learner-123');
  const converse = f.calls.find((c) => c.url.includes('/assistant/converse'));
  assert.ok(!JSON.stringify(converse.body).includes('learner-123'), 'userId not sent as a converse field');
  assert.ok(!JSON.stringify(converse.body).includes('1_abc123'), 'agentId not sent as a converse field');
});

test('converse and converseOnce accept opts = null', async () => {
  const f = fakeFetch([
    { match: '/service/session/action/start', respond: () => ({ body: `"${KS}"` }) },
    { match: '/assistant/converse', respond: () => ({ body: '{"type":"text","content":"hi"}\n' }) },
  ]);
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await m.converseOnce(1222, 'hello', /** @type {any} */ (null));
  for await (const _ of m.converse(1222, 'hello', /** @type {any} */ (null))) { /* drain */ }
  assert.equal(lastStart(f).get('privileges'), 'geniegpcid:1222,setrole:PLAYBACK_BASE_ROLE');
});

test('createWidgetToken needs no secret (anonymous public path)', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, fetch: f }); // no adminSecret
  const t = await m.sessions.createWidgetToken({ widgetId: '1_v1mj1kxb' });
  assert.equal(t.kind, 'widget');
  assert.equal(t.entitlementEnforced, true);
});

test('admin-token mint without a secret throws (server-side only)', async () => {
  const m = new Management({ partnerId: 123, fetch: sessionFetch() });
  await assert.rejects(() => m.sessions.createAdminToken({ userId: 'ops-console-42' }), (e) => e.code === 'no_secret');
});

// ─────────────────────────── userId on session mint ───────────────────────────

test('createAdminToken with userId sends it on the wire and binds it on the token scope', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const t = await m.sessions.createAdminToken({ userId: 'ops-console-42' });
  assert.equal(t.scope.userId, 'ops-console-42');
  const call = f.calls.find((c) => c.url.includes('/session/action/start'));
  assert.match(String(call.body), /userId=ops-console-42/);
});

test('createConversationToken with userId sends it on the wire and binds it on the token scope', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const t = await m.sessions.createConversationToken({ configId: 1222, userId: 'learner-123' });
  assert.equal(t.scope.userId, 'learner-123');
  const call = f.calls.find((c) => c.url.includes('/session/action/start'));
  assert.match(String(call.body), /userId=learner-123/);
});

test('a numeric userId is accepted and stringified', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const t = await m.sessions.createConversationToken({ configId: 1222, userId: 42 });
  assert.equal(t.scope.userId, '42');
});

test('createConversationToken WITHOUT userId sends no userId field and has no userId in scope', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const conv = await m.sessions.createConversationToken({ configId: 1222 });
  assert.equal(conv.scope.userId, undefined);
  for (const call of f.calls) assert.doesNotMatch(String(call.body), /userId=/);
});

test('every admin-type mint without a userId throws bad_request before any network call', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const mints = [
    () => m.sessions.createAdminToken(),
    () => m.sessions.createAdminToken({ ttlSeconds: 600 }),
    () => m.sessions.createAdminToken({ userId: '' }),
    () => m.sessions.createAdminToken({ userId: '   ' }),
    () => m.sessions.createAdminToken({ userId: null }),
    () => m.sessions.createConversationToken({ configId: 1222, sessionType: 'admin' }),
    () => m.sessions.createAgentToken({ agentId: '1_abc123', configId: 1222, sessionType: 'admin' }),
    () => m.sessions.createAgentToken({ agentId: '1_abc123', sessionType: 'admin' }), // no configId: throws before the lookup
  ];
  for (const mint of mints) {
    await assert.rejects(mint, (e) => e.code === 'bad_request' && /needs a userId/.test(e.detail));
  }
  assert.equal(f.calls.length, 0, 'rejected before touching the network');
});

test('the configId lookup mints its admin token with the SDK userId', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await m.sessions.createAgentToken({ agentId: '1_abc123' });
  const adminStart = f.calls.filter((c) => c.url.includes('/session/action/start'))
    .map((c) => new URLSearchParams(String(c.body))).find((b) => b.get('type') === '2');
  assert.equal(adminStart.get('userId'), 'intelligent-agents-sdk');
});

test('a non-scalar userId (object) is rejected before any network call', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    () => m.sessions.createConversationToken({ configId: 1222, userId: { nope: true } }),
    (e) => e.code === 'bad_request',
  );
  assert.equal(f.calls.length, 0, 'rejected before touching the network');
});

test('a non-scalar userId (array) is rejected before any network call, for createAdminToken too', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    () => m.sessions.createAdminToken({ userId: ['nope'] }),
    (e) => e.code === 'bad_request',
  );
  assert.equal(f.calls.length, 0, 'rejected before touching the network');
});

test('userId flows into the redacted audit event as actor.subjectId, never alongside the admin secret', async () => {
  const f = sessionFetch();
  const events = [];
  const secret = 'a'.repeat(32);
  const m = new Management({ partnerId: 123, adminSecret: secret, fetch: f, onAuditEvent: (e) => events.push(e) });
  await m.sessions.createConversationToken({ configId: 1222, userId: 'learner-123' });
  const mintEvent = events.find((e) => e.type === 'token.mint');
  assert.ok(mintEvent, 'a token.mint audit event was fired');
  assert.equal(mintEvent.actor.subjectId, 'learner-123');
  assert.ok(!JSON.stringify(events).includes(secret), 'the admin secret never rides an audit event alongside userId');
});

test('createAgentToken with userId sends it on the wire and binds it on the token scope', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const t = await m.sessions.createAgentToken({ agentId: '1_abc123', configId: 1222, userId: 'learner-123' });
  assert.equal(t.scope.userId, 'learner-123');
  const body = lastStart(f);
  assert.equal(body.get('userId'), 'learner-123');
  assert.equal(body.get('type'), '0');
});

test('createAgentToken treats userId: null/"" as absent, same as omitting it — no reject', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const a = await m.sessions.createAgentToken({ agentId: '1_abc123', userId: null });
  const b = await m.sessions.createAgentToken({ agentId: '1_abc123', userId: '' });
  assert.equal(a.kind, 'agent');
  assert.equal(b.kind, 'agent');
});

test('a non-finite numeric userId (NaN/Infinity) is rejected before any network call', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    () => m.sessions.createConversationToken({ configId: 1222, userId: NaN }),
    (e) => e.code === 'bad_request',
  );
  await assert.rejects(
    () => m.sessions.createConversationToken({ configId: 1222, userId: Infinity }),
    (e) => e.code === 'bad_request',
  );
  assert.equal(f.calls.length, 0, 'rejected before touching the network');
});

test('a userId containing CR/LF is sanitized (one-lined, no raw newline) in both the wire body and the token scope', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const t = await m.sessions.createConversationToken({ configId: 1222, userId: 'learner\r\nX-Injected: evil' });
  assert.doesNotMatch(t.scope.userId, /[\r\n]/);
  const call = f.calls.find((c) => c.url.includes('/session/action/start'));
  assert.doesNotMatch(String(call.body), /%0D%0A|\r|\n/);
});
