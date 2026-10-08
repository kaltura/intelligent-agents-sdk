import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/session.js';

const KS = 'djJ8' + 'A'.repeat(40);

test('KalturaAvatarSession: a seeded cfg.threadId is completed on teardown', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  const session = new KalturaAvatarSession({ token: KS, genieUrl: 'https://genie.example.com', threadId: 'seeded-thread', fetch, socketFactory: () => ({}) });
  const r = await session._completer.complete('test');
  assert.equal(r.reason === 'no_thread', false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.id, 'seeded-thread');
});
