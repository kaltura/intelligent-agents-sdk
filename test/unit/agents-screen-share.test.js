// `screenShare` on agents: the developer-facing name for the server's screen share setting.
// The SDK maps it to the wire name on writes and back on reads, so apps never see the wire name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);
const SHARE = { enabled: true, prompt: 'Describe the screen.' };

function harness(routes) {
  const ff = fakeFetch(routes);
  return { mgmt: new Management({ partnerId: 123, adminSecret: 's', fetch: ff }), ff };
}
const echo = (extra = {}) => (req) => ({ body: { agentId: 'a1', ...req.body, ...extra } });

test('create and update send screenShare under the wire name and return it as screenShare', async () => {
  const { mgmt, ff } = harness([
    { match: 'agent/create', respond: echo() },
    { match: 'agent/update', respond: echo() },
  ]);
  const created = await mgmt.agents.create({ displayName: 'A', intellect: { intellectType: 'genie', id: 1 }, screenShare: SHARE }, ADMIN_KS);
  assert.deepEqual(ff.calls[0].body.legacyScreenShare, SHARE);
  assert.equal('screenShare' in ff.calls[0].body, false);
  assert.deepEqual(created.screenShare, SHARE);
  assert.equal('legacyScreenShare' in created, false);

  const updated = await mgmt.agents.update({ agentId: 'a1', screenShare: { enabled: false } }, ADMIN_KS);
  assert.deepEqual(ff.calls[1].body, { agentId: 'a1', legacyScreenShare: { enabled: false } });
  assert.deepEqual(updated.screenShare, { enabled: false });
});

test('get and list return screenShare, and leave agents without a setting alone', async () => {
  const { mgmt } = harness([
    { match: 'agent/get', respond: () => ({ body: { agentId: 'a1', legacyScreenShare: SHARE } }) },
    { match: 'agent/list', respond: () => ({ body: { totalCount: 2, objects: [{ agentId: 'a1', legacyScreenShare: SHARE }, { agentId: 'a2' }] } }) },
  ]);
  const one = await mgmt.agents.get('a1', ADMIN_KS);
  assert.deepEqual(one, { agentId: 'a1', screenShare: SHARE });
  const all = await mgmt.agents.list(ADMIN_KS).all();
  assert.deepEqual(all, [{ agentId: 'a1', screenShare: SHARE }, { agentId: 'a2' }]);
});

test('a body without screenShare is sent unchanged', async () => {
  const { mgmt, ff } = harness([{ match: 'agent/update', respond: echo() }]);
  await mgmt.agents.update({ agentId: 'a1', displayName: 'B' }, ADMIN_KS);
  assert.deepEqual(ff.calls[0].body, { agentId: 'a1', displayName: 'B' });
});

test('a malformed screenShare is rejected before any request', async () => {
  const { mgmt, ff } = harness([{ match: /./, respond: echo() }]);
  for (const screenShare of [true, null, [], { enabled: 'yes' }, { prompt: 5 }]) {
    await assert.rejects(() => mgmt.agents.update({ agentId: 'a1', screenShare }, ADMIN_KS), (e) => e.code === 'bad_request' && /screenShare/.test(e.detail));
  }
  await assert.rejects(() => mgmt.agents.create({ displayName: 'A', screenShare: SHARE, legacyScreenShare: SHARE }, ADMIN_KS), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0);
});
