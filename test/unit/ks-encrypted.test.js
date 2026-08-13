import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectKs } from '../../src/management/ks-inspect.js';
import { Management } from '../../src/management/index.js';
import { fakeFetch } from '../fakes/fetch.js';

/**
 * REGRESSION (found via live testing): a REAL KSv2 token encrypts its privilege
 * string — only the partnerId is plaintext. inspectKs must NOT claim to know the
 * privilege kind of such a token, and the scope guard must trust a minted
 * Token's recorded kind instead of trying to decode an encrypted KS.
 */

/** A real-shaped token: `djJ8` + base64 of `v2|<pid>|<binary ciphertext>` (no plaintext privileges). */
function encryptedKs(pid = 6516742) {
  const header = Buffer.from(`v2|${pid}|`);
  const cipher = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256)); // opaque bytes
  return 'djJ8' + Buffer.concat([header, cipher]).toString('base64url');
}

test('inspectKs reports an encrypted/opaque token honestly (partnerId only)', () => {
  const info = inspectKs(encryptedKs(6516742));
  assert.equal(info.ok, true);
  assert.equal(info.partnerId, '6516742');
  assert.equal(info.encrypted, true);
  assert.equal(info.kind, 'opaque');
  assert.equal(info.disableEntitlement, null, 'privilege kind is unknowable for an encrypted token');
});

test('scope guard does NOT block a real encrypted admin token (server enforces)', async () => {
  const f = fakeFetch([{ match: '/agent/list', respond: () => ({ body: { objects: [], totalCount: 0 } }) }]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  // Passing a raw encrypted KS for an admin call must NOT throw wrong_token_scope.
  await assert.doesNotReject(() => Promise.resolve(m.agents.list(encryptedKs()).then(() => {})));
});

test('scope guard TRUSTS a minted Token.kind (admin Token works on admin calls)', async () => {
  const f = fakeFetch([{ match: '/agent/list', respond: () => ({ body: { objects: [{ agentId: 'a1' }], totalCount: 1 } }) }]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const adminToken = { ks: encryptedKs(), kind: 'admin', entitlementEnforced: false }; // shape of sessions.createAdminToken()
  const agents = await m.agents.list(adminToken);
  assert.equal(agents.length, 1);
});

test('scope guard rejects a minted CONVERSATION Token on an admin call', async () => {
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: fakeFetch([]) });
  const convToken = { ks: encryptedKs(), kind: 'conversation', entitlementEnforced: true };
  await assert.rejects(async () => m.agents.list(convToken), (e) => e.code === 'wrong_token_scope');
});

test('a minted Token object is accepted wherever a KS string is (unwrapped for the call)', async () => {
  const f = fakeFetch([{ match: '/agent/get', respond: (req) => ({ body: { agentId: 'a1', _auth: req.headers['authorization'] } }) }]);
  const m = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const ks = encryptedKs();
  const r = await m.agents.get('a1', { ks, kind: 'admin' });
  assert.equal(r._auth, `KS ${ks}`, 'Token.ks must be unwrapped into the Authorization header');
});
