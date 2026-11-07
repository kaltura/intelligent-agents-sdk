// `agentScope` on catalog create and update: a string, validated before the network, absent from the body when omitted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);
const AGENT = '11111111-1111-4111-8111-111111111111';
const file = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
const voiceFile = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });
const visualAttrs = { name: 'n', genderPresentation: 'Feminine' };
const voiceAttrs = { name: 'n', description: 'Calm narrator' };

function harness() {
  const ff = fakeFetch([
    { match: 'catalog-item/create', respond: () => ({ body: { itemId: 'i1' } }) },
    { match: 'catalog-item/update', respond: () => ({ body: { itemId: 'i1' } }) },
  ]);
  return { mgmt: new Management({ partnerId: 123, adminSecret: 's', fetch: ff }), ff };
}

const creates = [
  ['createVisual', (m, extra) => m.catalog.createVisual(file(), { ...visualAttrs, ...extra }, ADMIN_KS)],
  ['createFace', (m, extra) => m.catalog.createFace(file(), { ...visualAttrs, ...extra }, ADMIN_KS)],
  ['createBackground', (m, extra) => m.catalog.createBackground(file(), { ...visualAttrs, ...extra }, ADMIN_KS)],
  ['createVoice', (m, extra) => m.catalog.createVoice(voiceFile(), { ...voiceAttrs, ...extra }, ADMIN_KS)],
];

for (const [name, run] of creates) {
  test(`${name}: agentScope is sent as one multipart field`, async () => {
    const { mgmt, ff } = harness();
    await run(mgmt, { agentScope: AGENT });
    assert.deepEqual(ff.calls[0].body.getAll('agentScope'), [AGENT]);
  });

  test(`${name}: agentScope omitted leaves the field out of the body`, async () => {
    const { mgmt, ff } = harness();
    await run(mgmt, {});
    assert.equal(ff.calls[0].body.has('agentScope'), false);
  });

  test(`${name}: agentScope that is empty, blank, null or not a string is refused before the network`, async () => {
    const { mgmt, ff } = harness();
    for (const bad of ['', '   ', null, 7, true, {}, [AGENT]]) {
      await assert.rejects(() => run(mgmt, { agentScope: bad }), (e) => e.code === 'validation_error' && /agentScope/.test(e.detail), `value ${JSON.stringify(bad)}`);
    }
    assert.equal(ff.calls.length, 0);
  });
}

test('update (JSON body): agentScope is sent as a string', async () => {
  const { mgmt, ff } = harness();
  await mgmt.catalog.update({ itemId: 'i1', agentScope: AGENT }, ADMIN_KS);
  assert.deepEqual(ff.calls[0].body, { itemId: 'i1', agentScope: AGENT });
});

test('update (JSON body): empty string is sent so the scope is cleared', async () => {
  const { mgmt, ff } = harness();
  await mgmt.catalog.update({ itemId: 'i1', agentScope: '' }, ADMIN_KS);
  assert.deepEqual(ff.calls[0].body, { itemId: 'i1', agentScope: '' });
});

test('update (JSON body): agentScope omitted leaves the key out', async () => {
  const { mgmt, ff } = harness();
  await mgmt.catalog.update({ itemId: 'i1', adminTags: ['t'] }, ADMIN_KS);
  assert.equal('agentScope' in ff.calls[0].body, false);
});

test('update (multipart): agentScope is sent, and an empty string too', async () => {
  const { mgmt, ff } = harness();
  await mgmt.catalog.update({ itemId: 'i1', file: file(), agentScope: AGENT }, ADMIN_KS);
  await mgmt.catalog.update({ itemId: 'i1', file: file(), agentScope: '' }, ADMIN_KS);
  await mgmt.catalog.update({ itemId: 'i1', file: file() }, ADMIN_KS);
  assert.deepEqual(ff.calls[0].body.getAll('agentScope'), [AGENT]);
  assert.deepEqual(ff.calls[1].body.getAll('agentScope'), ['']);
  assert.equal(ff.calls[2].body.has('agentScope'), false);
});

test('update: whitespace, null, number and other non-strings are refused before the network', async () => {
  const { mgmt, ff } = harness();
  for (const bad of ['  ', null, 7, false, {}, [AGENT]]) {
    await assert.rejects(() => mgmt.catalog.update({ itemId: 'i1', agentScope: bad }, ADMIN_KS), (e) => e.code === 'validation_error' && /agentScope/.test(e.detail), `value ${JSON.stringify(bad)}`);
    await assert.rejects(() => mgmt.catalog.update({ itemId: 'i1', file: file(), agentScope: bad }, ADMIN_KS), (e) => e.code === 'validation_error');
  }
  assert.equal(ff.calls.length, 0);
});

test('the refusal never echoes a long value', async () => {
  const { mgmt } = harness();
  await assert.rejects(() => mgmt.catalog.update({ itemId: 'i1', agentScope: ' '.repeat(5000) }, ADMIN_KS), (e) => e.detail.length < 300);
});
