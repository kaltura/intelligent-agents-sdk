import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/client.js';
import { KalturaError } from '../../src/core/errors.js';

/**
 * application.getCustomVariables: request shape, pass-through, offline refusals,
 * error mapping and resend. Runs through a real Management with a fake fetch.
 */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);
const AGENT_ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/** Fake fetch that records every call. */
function recorder(respond) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url: String(url), init }); return respond(calls.length); };
  fn.calls = calls;
  return fn;
}

const mgmtWith = (f) => new Management({ partnerId: '123', fetch: f });

test('getCustomVariables: POSTs {agentId} to application/getCustomVariables with the KS', async () => {
  const f = recorder(() => reply(200, { systemVariables: [], customVariables: [] }));
  await mgmtWith(f).application.getCustomVariables(AGENT_ID, ADMIN_KS);
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(new URL(url).pathname, '/v1/application/getCustomVariables');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { agentId: AGENT_ID });
  assert.match(init.headers.Authorization ?? init.headers.authorization, /^KS /);
});

test('getCustomVariables: returns the server shape unchanged', async () => {
  const payload = {
    systemVariables: [{ name: 'sys__user_id', template: '{{ sys__user_id }}', type: 'string', description: 'The bound user', example: 'u1', used: false, properties: [{ name: 'x' }], extra: 1 }],
    customVariables: [{ name: 'pass_var', template: '{{ pass_var }}', type: 'unknown', paths: ['a'], origins: ['referenced'], sources: [{ documentType: 'intellect', documentId: 'i1', field: 'base_directive', origin: 'referenced' }] }],
    futureField: true,
  };
  const out = await mgmtWith(recorder(() => reply(200, payload))).application.getCustomVariables(AGENT_ID, ADMIN_KS);
  assert.deepEqual(out, payload);
});

test('getCustomVariables: passes a response without arrays through, adds no defaults', async () => {
  const out = await mgmtWith(recorder(() => reply(200, { systemVariables: [{ name: 'sys__x' }] }))).application.getCustomVariables(AGENT_ID, ADMIN_KS);
  assert.deepEqual(out, { systemVariables: [{ name: 'sys__x' }] });
  assert.equal('customVariables' in out, false);
  const empty = await mgmtWith(recorder(() => reply(200, {}))).application.getCustomVariables(AGENT_ID, ADMIN_KS);
  assert.deepEqual(empty, {});
});

for (const [label, id] of [['empty string', ''], ['whitespace', '   '], ['undefined', undefined], ['null', null], ['number', 5], ['object', {}], ['not a UUID', 'agent-1']]) {
  test(`getCustomVariables: refuses an agent id that is ${label} before any request`, async () => {
    const f = recorder(() => reply(200, {}));
    await assert.rejects(
      () => mgmtWith(f).application.getCustomVariables(/** @type {any} */ (id), ADMIN_KS),
      (e) => e instanceof KalturaError && e.code === 'validation_error',
    );
    assert.equal(f.calls.length, 0);
  });
}

for (const [label, ks] of [['empty', ''], ['undefined', undefined], ['null', null]]) {
  test(`getCustomVariables: refuses a ${label} KS before any request`, async () => {
    const f = recorder(() => reply(200, {}));
    await assert.rejects(
      () => mgmtWith(f).application.getCustomVariables(AGENT_ID, /** @type {any} */ (ks)),
      (e) => e instanceof KalturaError && e.code === 'bad_request',
    );
    assert.equal(f.calls.length, 0);
  });
}

test('getCustomVariables: maps a 404 to a KalturaError with status 404', async () => {
  const f = recorder(() => reply(404, { message: 'AGENT_NOT_FOUND' }));
  await assert.rejects(
    () => mgmtWith(f).application.getCustomVariables(AGENT_ID, ADMIN_KS),
    (e) => e instanceof KalturaError && e.status === 404 && e.code === 'agent_not_found',
  );
});

test('getCustomVariables: maps a 200 AGENT_NOT_FOUND body to agent_not_found', async () => {
  const f = recorder(() => reply(200, { objectType: 'KalturaAPIException', code: 'AGENT_NOT_FOUND', message: 'Agent not found' }));
  await assert.rejects(
    () => mgmtWith(f).application.getCustomVariables(AGENT_ID, ADMIN_KS),
    (e) => e instanceof KalturaError && e.code === 'agent_not_found',
  );
});

test('getCustomVariables: is a read, so a dropped connection is resent', async () => {
  const dropped = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) });
  const f = recorder((n) => { if (n === 1) throw dropped; return reply(200, { systemVariables: [], customVariables: [] }); });
  const out = await mgmtWith(f).application.getCustomVariables(AGENT_ID, ADMIN_KS);
  assert.deepEqual(out, { systemVariables: [], customVariables: [] });
  assert.equal(f.calls.length, 2);
});
