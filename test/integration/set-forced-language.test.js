import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/index.js';
import { fakeFetch } from '../fakes/fetch.js';

/**
 * Integration (fetch-fake): assert the exact `v1/intellect/update` +
 * `agent/update` bodies `setForcedLanguage` sends.
 */
const ADMIN = 'djJ8' + Buffer.from('v2|6516742|x').toString('base64url');
const PID = 6516742;

function fullDto(over = {}) {
  return {
    id: 1481, type: 'internal', status: 2,
    base_directive: 'You are Ron, a helpful assistant.',
    prompts: [], capabilities: {}, tool_ids: [],
    partner_id: PID, user_id: 'u', created_at: 'x', updated_at: 'y',
    ...over,
  };
}

const updateEcho = { match: '/v1/intellect/update', respond: (req) => ({ body: req.body }) };
const agentUpdateEcho = { match: '/agent/update', respond: (req) => ({ body: req.body }) };
const getDto = (over) => ({ match: '/v1/intellect/get', respond: () => ({ body: fullDto(over) }) });

function mkMgmt(routes) {
  const f = fakeFetch(routes);
  const m = new Management({ partnerId: PID, adminSecret: 'a'.repeat(32), fetch: f });
  return { m, f };
}

test('setForcedLanguage writes force_language, injects a marker-wrapped base_directive instruction, and sets asr.language', async () => {
  const { m, f } = mkMgmt([getDto(), updateEcho, agentUpdateEcho]);
  const r = await m.setForcedLanguage({ configId: 1481, agentId: 'agent-1', language: 'he' }, ADMIN);

  const intellectSent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.equal(intellectSent.force_language, 'Hebrew');
  assert.match(intellectSent.base_directive, /You are Ron, a helpful assistant\./);
  assert.match(intellectSent.base_directive, /<!-- sdk:forced-language -->.*Hebrew.*<!-- \/sdk:forced-language -->/s);

  const agentSent = f.calls.find((c) => c.url.includes('/agent/update')).body;
  assert.deepEqual(agentSent, { agentId: 'agent-1', asr: { language: 'he', provider: 'kaltura' } });

  assert.equal(r.configId, 1481);
  assert.equal(r.agentId, 'agent-1');
  assert.equal(r.language, 'he');
  assert.equal(r.languageName, 'Hebrew');
  assert.match(r._meta.generatedAt, /Z$/);
});

test('setForcedLanguage is idempotent — a repeat call replaces, not duplicates, the injected instruction', async () => {
  const priorlyForced = 'You are Ron, a helpful assistant.\n\n<!-- sdk:forced-language --> Always respond in Hebrew, regardless of what language the user writes or speaks in. <!-- /sdk:forced-language -->';
  const { m, f } = mkMgmt([getDto({ base_directive: priorlyForced }), updateEcho, agentUpdateEcho]);
  await m.setForcedLanguage({ configId: 1481, agentId: 'agent-1', language: 'es' }, ADMIN);

  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  const markerCount = (sent.base_directive.match(/<!-- sdk:forced-language -->/g) || []).length;
  assert.equal(markerCount, 1, 'only one marker block, not stacked');
  assert.match(sent.base_directive, /Spanish/);
  assert.doesNotMatch(sent.base_directive, /Hebrew/);
  assert.equal(sent.force_language, 'Spanish');
});

test('setForcedLanguage with language:null clears the instruction and resets asr.language/force_language', async () => {
  const priorlyForced = 'You are Ron, a helpful assistant.\n\n<!-- sdk:forced-language --> Always respond in Hebrew, regardless of what language the user writes or speaks in. <!-- /sdk:forced-language -->';
  const { m, f } = mkMgmt([getDto({ base_directive: priorlyForced }), updateEcho, agentUpdateEcho]);
  const r = await m.setForcedLanguage({ configId: 1481, agentId: 'agent-1', language: null }, ADMIN);

  const intellectSent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.equal(intellectSent.base_directive, 'You are Ron, a helpful assistant.');
  assert.equal(intellectSent.force_language, '');

  const agentSent = f.calls.find((c) => c.url.includes('/agent/update')).body;
  assert.deepEqual(agentSent, { agentId: 'agent-1', asr: { language: 'en', provider: 'kaltura' } });

  assert.equal(r.language, null);
  assert.equal(r.languageName, undefined);
});

test('setForcedLanguage accepts a languageName override for a code not in the built-in table', async () => {
  const { m, f } = mkMgmt([getDto(), updateEcho, agentUpdateEcho]);
  await m.setForcedLanguage({ configId: 1481, agentId: 'agent-1', language: 'xx', languageName: 'Xlanguage' }, ADMIN);
  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.equal(sent.force_language, 'Xlanguage');
  assert.match(sent.base_directive, /Xlanguage/);
});

test('setForcedLanguage rejects an unknown language code with no override, before any network call', async () => {
  const { m, f } = mkMgmt([getDto(), updateEcho, agentUpdateEcho]);
  await assert.rejects(
    () => m.setForcedLanguage({ configId: 1481, agentId: 'agent-1', language: 'xx' }, ADMIN),
    (e) => e.code === 'bad_request',
  );
  assert.equal(f.calls.length, 0);
});

test('setForcedLanguage strips every marker block, not just the first, if more than one is present', async () => {
  const doubled = 'You are Ron, a helpful assistant.\n\n'
    + '<!-- sdk:forced-language --> Always respond in Hebrew, regardless of what language the user writes or speaks in. <!-- /sdk:forced-language -->\n\n'
    + '<!-- sdk:forced-language --> Always respond in Arabic, regardless of what language the user writes or speaks in. <!-- /sdk:forced-language -->';
  const { m, f } = mkMgmt([getDto({ base_directive: doubled }), updateEcho, agentUpdateEcho]);
  await m.setForcedLanguage({ configId: 1481, agentId: 'agent-1', language: 'es' }, ADMIN);

  const sent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  const markerCount = (sent.base_directive.match(/<!-- sdk:forced-language -->/g) || []).length;
  assert.equal(markerCount, 1, 'both stale marker blocks removed, only the new one remains');
  assert.match(sent.base_directive, /Spanish/);
  assert.doesNotMatch(sent.base_directive, /Hebrew|Arabic/);
});

test('setForcedLanguage trims/normalizes opts.language and rejects a whitespace-only opts.languageName override', async () => {
  const { m, f } = mkMgmt([getDto(), updateEcho, agentUpdateEcho]);
  const r = await m.setForcedLanguage({ configId: 1481, agentId: 'agent-1', language: ' HE ', languageName: '   ' }, ADMIN);

  const intellectSent = f.calls.find((c) => c.url.includes('/v1/intellect/update')).body;
  assert.equal(intellectSent.force_language, 'Hebrew');
  assert.match(intellectSent.base_directive, /Always respond in Hebrew,/);

  const agentSent = f.calls.find((c) => c.url.includes('/agent/update')).body;
  assert.equal(agentSent.asr.language, 'he');
  assert.equal(r.language, 'he');
});

test('setForcedLanguage respects a custom asrProvider', async () => {
  const { m, f } = mkMgmt([getDto(), updateEcho, agentUpdateEcho]);
  await m.setForcedLanguage({ configId: 1481, agentId: 'agent-1', language: 'fr', asrProvider: 'other' }, ADMIN);
  const agentSent = f.calls.find((c) => c.url.includes('/agent/update')).body;
  assert.deepEqual(agentSent, { agentId: 'agent-1', asr: { language: 'fr', provider: 'other' } });
});
