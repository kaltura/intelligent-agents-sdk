import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/index.js';
import { fakeFetch } from '../fakes/fetch.js';

const KS = 'djJ8' + Buffer.from('v2|123|x').toString('base64url');

function sessionFetch() {
  return fakeFetch([
    { match: '/service/session/action/startWidgetSession', respond: () => ({ body: { ks: KS } }) },
    { match: '/service/session/action/start', respond: (_req) => ({ body: `"${KS}"` }) }, // OVP returns a quoted string
  ]);
}

test('createAdminToken mints disableentitlement, entitlement OFF', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const t = await m.sessions.createAdminToken();
  assert.equal(t.kind, 'admin');
  assert.equal(t.entitlementEnforced, false);
  assert.equal(t.privileges, 'disableentitlement');
  // the request actually sent disableentitlement
  const call = f.calls.find((c) => c.url.includes('/session/action/start'));
  assert.match(String(call.body), /disableentitlement/);
  // scope receipt present, secret never echoed
  assert.equal(t.scope.entitlementEnforced, false);
  assert.ok(!JSON.stringify(t).includes('a'.repeat(32)));
});

test('createConversationToken mints geniegpcid, entitlement ON', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const t = await m.sessions.createConversationToken({ configId: 1222 });
  assert.equal(t.kind, 'conversation');
  assert.equal(t.entitlementEnforced, true);
  assert.equal(t.privileges, 'geniegpcid:1222');
});

test('createAgentToken mints agentid, entitlement ON', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  const t = await m.sessions.createAgentToken({ agentId: '1_abc123' });
  assert.equal(t.kind, 'agent');
  assert.equal(t.entitlementEnforced, true);
  assert.equal(t.privileges, 'agentid:1_abc123');
  // the request actually sent agentid, never disableentitlement
  const call = f.calls.find((c) => c.url.includes('/session/action/start'));
  assert.match(String(call.body), /agentid%3A1_abc123|agentid:1_abc123/);
  assert.doesNotMatch(String(call.body), /disableentitlement/);
});

test('createAgentToken refuses disableentitlement in extraPrivileges', async () => {
  const f = sessionFetch();
  const m = new Management({ partnerId: 123, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    () => m.sessions.createAgentToken({ agentId: '1_abc123', extraPrivileges: 'disableentitlement' }),
    (e) => e.code === 'entitlement_violation',
  );
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
  await assert.rejects(() => m.sessions.createAdminToken(), (e) => e.code === 'no_secret');
});
