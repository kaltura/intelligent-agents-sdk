import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/index.js';
import { buildAuditEvent } from '../../src/core/session.js';
import { fakeFetch } from '../fakes/fetch.js';

const ADMIN = 'a'.repeat(32);
const convKs = (pid = 9, cfg = 55) => 'djJ8' + Buffer.from(`v2|${pid}|geniegpcid:${cfg}`).toString('base64url');
const adminKs = (pid = 9) => 'djJ8' + Buffer.from(`v2|${pid}|disableentitlement`).toString('base64url');

test('buildAuditEvent: NIST AU-3 shape, redacted, JSON-serializable, log-injection-safe', () => {
  const e = buildAuditEvent({
    type: 'token.mint', outcome: 'success', partnerId: '9', kind: 'conversation',
    privileges: 'geniegpcid:55', requestId: 'req-1', entitlementEnforced: true,
    reason: 'line1\nline2\r\ninjected', source: 'ovp/session',
  });
  // required AU-3 fields
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(e.type, 'token.mint');
  assert.equal(e.outcome, 'success');
  assert.equal(e.actor.partnerId, '9');
  assert.equal(e.actor.kind, 'conversation');
  assert.equal(e.requestId, 'req-1');
  assert.ok(e._meta.generatedAt, 'provenance receipt present');
  // CR/LF collapsed (CWE-117)
  assert.ok(!/[\r\n]/.test(e.reason), 'no CR/LF in free-text reason');
  // fully JSON-serializable
  assert.doesNotThrow(() => JSON.stringify(e));
});

test('buildAuditEvent: never emits a raw KS even if one is passed in a field', () => {
  const e = buildAuditEvent({ type: 'token.mint', outcome: 'success', partnerId: '9', reason: 'token was ' + convKs() });
  assert.ok(!JSON.stringify(e).includes('djJ8'), 'redaction scrubs a KS riding a free-text field');
});

test('token.mint audit fires with kind/scope/entitlement, no raw KS', async () => {
  const events = [];
  const f = fakeFetch([{ match: '/service/session/action/start', respond: () => ({ body: convKs() }) }]);
  const m = new Management({ partnerId: 9, adminSecret: ADMIN, fetch: f, onAuditEvent: (e) => events.push(e) });
  await m.sessions.createConversationToken({ configId: 55, restrictions: { actionsLimit: 10, ipRestrict: '203.0.113.7', sessionGroupId: 'grp1' } });
  const mint = events.find((e) => e.type === 'token.mint');
  assert.equal(mint.outcome, 'success');
  assert.equal(mint.actor.kind, 'conversation');
  assert.ok(mint.scope.includes('actionslimit:10'));
  assert.ok(mint.scope.includes('iprestrict:203.0.113.7'));
  assert.ok(mint.scope.includes('sessionid:grp1'));
  assert.ok(!JSON.stringify(mint).includes('djJ8'));
});

test('token.revoke audit + receipt', async () => {
  const events = [];
  const f = fakeFetch([
    { match: '/service/session/action/start', respond: () => ({ body: convKs() }) },
    { match: '/service/session/action/end', respond: () => ({ body: true }) },
  ]);
  const m = new Management({ partnerId: 9, adminSecret: ADMIN, fetch: f, onAuditEvent: (e) => events.push(e) });
  const tok = await m.sessions.createConversationToken({ configId: 55 });
  const receipt = await m.sessions.revoke(tok);
  assert.ok(receipt.revokedAt, 'revoke returns a receipt');
  assert.ok(receipt._meta.generatedAt);
  assert.ok(events.some((e) => e.type === 'token.revoke' && e.outcome === 'success'));
});

test('guard.reject audit fires on wrong token scope', async () => {
  const events = [];
  const f = fakeFetch([{ match: '/service/session/action/start', respond: () => ({ body: adminKs() }) }]);
  const m = new Management({ partnerId: 9, adminSecret: ADMIN, fetch: f, onAuditEvent: (e) => events.push(e) });
  const admin = await m.sessions.createAdminToken();
  await assert.rejects(() => m.conversations.send({ userMessage: 'hi' }, admin), (e) => e.code === 'wrong_token_scope');
  assert.ok(events.some((e) => e.type === 'guard.reject' && e.outcome === 'fail'));
});

test('auth.fail audit fires on 401/403', async () => {
  const events = [];
  const f = fakeFetch([{ match: '/v1/agent/list', respond: () => ({ status: 403, body: { error: 'forbidden' } }) }]);
  const m = new Management({ partnerId: 9, adminSecret: ADMIN, fetch: f, onAuditEvent: (e) => events.push(e) });
  await assert.rejects(() => m.agents.list(adminKs()).all());
  assert.ok(events.some((e) => e.type === 'auth.fail' && e.outcome === 'fail'), 'auth.fail emitted on 403');
});

test('no onAuditEvent → zero cost, no emission, no error', async () => {
  const f = fakeFetch([{ match: '/service/session/action/start', respond: () => ({ body: convKs() }) }]);
  const m = new Management({ partnerId: 9, adminSecret: ADMIN, fetch: f });
  await assert.doesNotReject(() => m.sessions.createConversationToken({ configId: 55 }));
});

test('audit hook is crash-safe: a throwing sink never breaks a mint', async () => {
  const f = fakeFetch([{ match: '/service/session/action/start', respond: () => ({ body: convKs() }) }]);
  const m = new Management({ partnerId: 9, adminSecret: ADMIN, fetch: f, onAuditEvent: () => { throw new Error('SIEM down'); } });
  const tok = await m.sessions.createConversationToken({ configId: 55 });
  assert.ok(tok.ks);
});

test('TTL: short default (1800s) for conversation; ttl_too_long rejected', async () => {
  const f = fakeFetch([{ match: '/service/session/action/start', respond: () => ({ body: convKs() }) }]);
  const m = new Management({ partnerId: 9, adminSecret: ADMIN, fetch: f });
  const tok = await m.sessions.createConversationToken({ configId: 55 });
  assert.ok(tok.secondsRemaining() > 0 && tok.secondsRemaining() <= 1800);
  await assert.rejects(() => m.sessions.createConversationToken({ configId: 55, ttlSeconds: 10 * 365 * 86400 }), (e) => e.code === 'ttl_too_long');
});

test('admin secret is non-enumerable (cannot be JSON.stringify\'d off the instance)', () => {
  const m = new Management({ partnerId: 9, adminSecret: ADMIN });
  assert.ok(!JSON.stringify(m.sessions).includes(ADMIN), 'admin secret not serialized');
  assert.ok(!Object.keys(m.sessions).includes('_adminSecret'), 'admin secret not enumerable');
});

test('clone consentRef is recorded on the result receipt + audited (NO FAKES / FTC)', async () => {
  const events = [];
  const f = fakeFetch([{ match: '/catalog-item/create', respond: () => ({ body: { itemId: 'voice-9', objectType: 'KalturaVoiceCatalogItem' } }) }]);
  const m = new Management({ partnerId: 9, adminSecret: ADMIN, fetch: f, onAuditEvent: (e) => events.push(e) });
  const blob = typeof Blob !== 'undefined' ? new Blob(['x'], { type: 'audio/mpeg' }) : { size: 1 };
  const res = await m.catalog.createVoice(blob, { name: 'V', description: 'a sufficiently long sample description', consentRef: 'consent://attestation/abc' }, adminKs());
  assert.equal(res._consent.consentRef, 'consent://attestation/abc');
  assert.ok(res._consent.recordedAt);
  assert.ok(events.some((e) => e.type === 'clone.consent' && e.outcome === 'success'));
});

test('getAdminSecret vault callback is used and not retained as a field', async () => {
  let calls = 0;
  const f = fakeFetch([{ match: '/service/session/action/start', respond: () => ({ body: adminKs() }) }]);
  const m = new Management({ partnerId: 9, getAdminSecret: () => { calls++; return ADMIN; }, fetch: f });
  await m.sessions.createAdminToken();
  assert.equal(calls, 1, 'vault callback invoked per mint');
  assert.ok(!JSON.stringify(m.sessions).includes(ADMIN));
});
