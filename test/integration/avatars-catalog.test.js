/**
 * Avatars + Catalog DTO discipline (regression for the deep-E2E findings):
 *  - the avatar DTO has NO tag field → `avatars.create`/`update` must reject a
 *    stray `adminTags` BEFORE any network call, with an actionable message
 *    pointing at the parent agent (the live API only returns a bare "Bad Request").
 *  - catalog multipart uploads must send `adminTags` in the SINGLE-PARSE shape (a
 *    comma-separated bare string), NOT `JSON.stringify` (which the API re-wraps,
 *    storing `["[\"custom\"]"]` and making the item unfindable by `adminTagsIn`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/index.js';
import { fakeFetch } from '../fakes/fetch.js';

const ADMIN = 'djJ8MXxb=ADMIN-token-placeholder';

function mgmt(routes) {
  return new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: fakeFetch(routes) });
}

test('avatars.create rejects a stray adminTags pre-network with an actionable error (no avatar/create call fires)', async () => {
  const f = fakeFetch([{ match: '/avatar/create', respond: () => ({ body: { id: 'av1' } }) }]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    () => k.avatars.create({ voice: { id: 'v' }, visual: { id: 'vis' }, adminTags: ['lobby'] }, ADMIN),
    (e) => e.code === 'bad_request' && /parent AGENT/i.test(e.detail) && /agents\.create/i.test(e.detail),
  );
  // The guard fires BEFORE the network: no avatar/create request was made.
  assert.equal(f.calls.filter((c) => c.url.includes('/avatar/create')).length, 0);
});

test('avatars.update rejects a stray adminTags pre-network (the live reply is only a bare Bad Request — the SDK makes it actionable)', async () => {
  const f = fakeFetch([{ match: '/avatar/update', respond: () => ({ body: { id: 'av1' } }) }]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    () => k.avatars.update({ id: 'av1', adminTags: ['x'] }, ADMIN),
    (e) => e.code === 'bad_request' && /adminTags/.test(e.detail),
  );
  assert.equal(f.calls.filter((c) => c.url.includes('/avatar/update')).length, 0);
});

test('avatars.create WITHOUT adminTags posts normally to avatar/create', async () => {
  const f = fakeFetch([{ match: '/avatar/create', respond: () => ({ body: { id: 'av1' } }) }]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const r = await k.avatars.create({ voice: { id: 'v' }, visual: { id: 'vis' }, openingPhrase: 'Hi' }, ADMIN);
  assert.equal(r.id, 'av1');
  assert.equal(f.calls.filter((c) => c.url.includes('/avatar/create')).length, 1);
});

test('catalog.createVisual sends adminTags as a single-parse comma string, NOT JSON.stringify (double-encode regression)', async () => {
  const f = fakeFetch([{ match: '/catalog-item/create', respond: () => ({ body: { itemId: 'item-1' } }) }]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  const r = await k.catalog.createVisual(file, { name: 'QA face' }, ADMIN);
  assert.equal(r.itemId, 'item-1');
  const call = f.calls.find((c) => c.url.includes('/catalog-item/create'));
  assert.ok(call, 'catalog-item/create was called');
  // The multipart body is a FormData; adminTags must be the bare 'custom', never '["custom"]'.
  const tagField = call.body && typeof call.body.get === 'function' ? call.body.get('adminTags') : undefined;
  assert.equal(tagField, 'custom', `adminTags must be the single-parse bare string "custom", got ${JSON.stringify(tagField)}`);
  assert.ok(!String(tagField).includes('['), 'adminTags must NOT be JSON-encoded (no brackets)');
});

test('agents.getEmbedScript validates embedType against the closed enum BEFORE any network call', async () => {
  // Live wire replies `{objectType:'Object', html:'<script…>'}` — the SDK unwraps to the snippet string.
  const f = fakeFetch([{ match: '/agent/getEmbedScript', respond: (req) => ({ body: { objectType: 'Object', html: `<script data-type="${req.body.embedType}"></script>` } }) }]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(() => k.agents.getEmbedScript('agent-1', 'popup', ADMIN), (e) => e.code === 'bad_request' && /contained, page, floater/.test(e.detail));
  await assert.rejects(() => k.agents.getEmbedScript('agent-1', undefined, ADMIN), (e) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0, 'no transport before the enum guard passes');

  const html = await k.agents.getEmbedScript('agent-1', 'floater', ADMIN);
  assert.equal(typeof html, 'string', 'unwrapped to the raw snippet string');
  assert.match(html, /data-type="floater"/);
  assert.deepEqual(f.calls[0].body, { agentId: 'agent-1', embedType: 'floater' });
});

test('catalog.importVoiceFromElevenLabs/Cartesia post {voiceId}; empty voiceId rejected pre-network', async () => {
  const f = fakeFetch([
    { match: '/catalog-item/createVoiceFromElevenLabs', respond: (req) => ({ body: { itemId: 'v-el', type: 'Voice', voiceId: req.body.voiceId } }) },
    { match: '/catalog-item/createVoiceFromCartesia', respond: (req) => ({ body: { itemId: 'v-ca', type: 'Voice', voiceId: req.body.voiceId } }) },
  ]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(() => k.catalog.importVoiceFromElevenLabs('', ADMIN), (e) => e.code === 'bad_request');
  await assert.rejects(() => k.catalog.importVoiceFromCartesia('  ', ADMIN), (e) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0, 'no transport before voiceId validation passes');

  const el = await k.catalog.importVoiceFromElevenLabs('el-voice-1', ADMIN);
  assert.equal(el.itemId, 'v-el');
  assert.deepEqual(f.calls[0].body, { voiceId: 'el-voice-1' });
  const ca = await k.catalog.importVoiceFromCartesia('ca-voice-1', ADMIN);
  assert.equal(ca.itemId, 'v-ca');
  assert.deepEqual(f.calls[1].body, { voiceId: 'ca-voice-1' });
});

test('an unknown provider voiceId raises the typed voice_not_found error from the HTTP-200 exception envelope', async () => {
  const f = fakeFetch([
    { match: '/catalog-item/createVoiceFromElevenLabs', respond: () => ({ status: 200, body: { objectType: 'KalturaAPIException', code: 'VOICE_DOES_NOT_EXIST_ON_ELEVEN_LABS', message: 'Voice does not exist on ElevenLabs' } }) },
  ]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    () => k.catalog.importVoiceFromElevenLabs('bogus', ADMIN),
    (e) => e.code === 'voice_not_found_elevenlabs' && e.status === 200,
  );
});
