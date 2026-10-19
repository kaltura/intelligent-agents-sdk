import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/client.js';

/**
 * Which Management calls the transport resends after a dropped connection.
 * Reads and token mints are resent; a create, update or delete is not, since it may already have run.
 */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);
const dropped = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) });

/** Drops the first request to each path, answers the rest with `body`. */
function dropFirst(body) {
  const seen = new Map();
  const fn = async (url) => {
    const path = new URL(url).pathname;
    seen.set(path, (seen.get(path) || 0) + 1);
    if (seen.get(path) === 1) throw dropped();
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: true, status: 200, headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) }, text: async () => text };
  };
  fn.seen = seen;
  return fn;
}

test('reads on the agentic and genie hosts are resent after a dropped connection', async () => {
  const f = dropFirst({ id: 'a1' });
  const mgmt = new Management({ partnerId: '123', fetch: f });
  assert.equal((await mgmt.agents.get('a1', ADMIN_KS)).id, 'a1');
  assert.equal((await mgmt.threads.get('t1', ADMIN_KS)).id, 'a1');
  assert.deepEqual([...f.seen.values()], [2, 2]);
});

test('a delete is not resent after a dropped connection', async () => {
  const f = dropFirst({});
  const mgmt = new Management({ partnerId: '123', fetch: f });
  await assert.rejects(() => mgmt.agents.delete('a1', ADMIN_KS, { confirmPermanent: true, skipProtectedCheck: true }), (e) => e.status === 0);
  assert.deepEqual([...f.seen.entries()].map(([p, n]) => [p.split('/').slice(-2).join('/'), n]), [['agent/delete', 1]]);
});

test('a token mint is resent after a dropped connection', async () => {
  const f = dropFirst('djJ8' + 'B'.repeat(40));
  const mgmt = new Management({ partnerId: '123', adminSecret: 's', fetch: f });
  const t = await mgmt.sessions.createAdminToken({ userId: 'u' });
  assert.ok(t.ks.startsWith('djJ8'));
  assert.deepEqual([...f.seen.values()], [2]);
});
