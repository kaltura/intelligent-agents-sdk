// `agents.list` takes `orderBy`, and the agent `asr` field passes through create, update and get.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);

function harness(routes) {
  const ff = fakeFetch(routes);
  return { mgmt: new Management({ partnerId: 123, adminSecret: 's', fetch: ff }), ff };
}
const emptyList = () => ({ body: { totalCount: 0, objects: [] } });
const echo = (req) => ({ body: { agentId: 'a1', ...req.body } });

test('agents.list sends orderBy top-level next to filter', async () => {
  const { mgmt, ff } = harness([{ match: 'agent/list', respond: emptyList }]);
  await mgmt.agents.list(ADMIN_KS, { filter: { adminTagsIn: ['a'] }, orderBy: '-updatedAt' });
  assert.equal(ff.calls[0].body.orderBy, '-updatedAt');
  assert.deepEqual(ff.calls[0].body.filter, { adminTagsIn: ['a'] });
});

test('agents.list omits orderBy when unset', async () => {
  const { mgmt, ff } = harness([{ match: 'agent/list', respond: emptyList }]);
  await mgmt.agents.list(ADMIN_KS);
  assert.deepEqual(Object.keys(ff.calls[0].body).sort(), ['filter', 'pager']);
  assert.deepEqual(ff.calls[0].body.filter, {});
});

test('agents.list keeps orderBy on every page', async () => {
  const pages = [[{ agentId: 'a' }, { agentId: 'b' }], [{ agentId: 'c' }]];
  const { mgmt, ff } = harness([{ match: 'agent/list', respond: (req) => ({ body: { totalCount: 3, objects: pages[req.body.pager.offset === 0 ? 0 : 1] } }) }]);
  const all = await mgmt.agents.list(ADMIN_KS, { pageSize: 2, orderBy: '-createdAt' }).all();
  assert.equal(all.length, 3);
  assert.equal(ff.calls.length, 2);
  for (const c of ff.calls) assert.equal(c.body.orderBy, '-createdAt');
});

test('an unknown orderBy surfaces as bad_request with the four values', async () => {
  const message = ['orderBy must be one of the following values: +createdAt, -createdAt, +updatedAt, -updatedAt'];
  const { mgmt } = harness([{ match: 'agent/list', respond: () => ({ status: 400, body: { message, error: 'Bad Request', statusCode: 400 } }) }]);
  await assert.rejects(
    async () => { await mgmt.agents.list(ADMIN_KS, { orderBy: 'updatedAt' }); },
    (e) => e.code === 'bad_request' && e.status === 400 && e.body.message[0].includes('+updatedAt') && e.detail.includes('+updatedAt'),
  );
});

test('create sends asr as passed', async () => {
  const { mgmt, ff } = harness([{ match: 'agent/create', respond: echo }]);
  await mgmt.agents.create({ displayName: 'A', intellect: { intellectType: 'genie', id: 1 }, asr: { language: 'he', provider: 'kaltura-hebrew' } }, ADMIN_KS);
  assert.deepEqual(ff.calls[0].body.asr, { language: 'he', provider: 'kaltura-hebrew' });
});

test('create sends no asr key when omitted', async () => {
  const { mgmt, ff } = harness([{ match: 'agent/create', respond: echo }]);
  await mgmt.agents.create({ displayName: 'A', intellect: { intellectType: 'genie', id: 1 } }, ADMIN_KS);
  assert.equal('asr' in ff.calls[0].body, false);
});

test('update sends asr with only agentId and asr', async () => {
  const { mgmt, ff } = harness([{ match: 'agent/update', respond: echo }]);
  await mgmt.agents.update({ agentId: 'a1', asr: { language: 'en', provider: 'elevenlabs' } }, ADMIN_KS);
  assert.deepEqual(Object.keys(ff.calls[0].body).sort(), ['agentId', 'asr']);
});

test('get returns asr as the server sent it', async () => {
  const { mgmt } = harness([{ match: 'agent/get', respond: () => ({ body: { agentId: 'a1', asr: { language: 'en', provider: 'soniox' } } }) }]);
  const agent = await mgmt.agents.get('a1', ADMIN_KS);
  assert.deepEqual(agent.asr, { language: 'en', provider: 'soniox' });
});
