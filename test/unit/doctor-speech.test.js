import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/** The speech checks through `mgmt.doctor`: reads, gather, checks, sorting, ignore, only and skip. fakeFetch only. */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);
const pageOf = (all) => (req) => {
  const { offset = 0, limit = 30 } = req.body.pager || {};
  return { body: { objects: all.slice(offset, offset + limit), totalCount: all.length } };
};
const notFound = { status: 404, body: { message: 'not found' } };
const voiceItem = (itemId, language, ttsProvider) => ({ itemId, type: 'Voice', adminTags: [], attributes: { voice: { name: `Voice ${itemId}`, language, ...(ttsProvider ? { ttsProvider } : {}) } } });

const TABLE = 'Respellings:\nCAGR -> "KAY-ger"\nQ3 -> "Q3"\nEBITDA -> "ebitda"\n';
const LONG = `${'You answer questions about the quarterly results. '.repeat(6)}`;

/** Two agents on one intellect. a1 uses a Cartesia voice made for he, a2 an ElevenLabs voice made for en. */
function harness({ intellect = {}, agents, voices, avatars, voiceListed = true } = {}) {
  const A = agents ?? [
    { agentId: 'a1', intellect: { id: 10 }, avatarIds: ['av1'], asr: { language: 'en', provider: 'kaltura' } },
    { agentId: 'a2', intellect: { id: 10 }, avatarIds: ['av2'], asr: { language: 'en', provider: 'kaltura' } },
  ];
  const V = voices ?? [voiceItem('v1', 'he', 'cartesia'), voiceItem('v2', 'en', 'elevenLabs')];
  const AV = avatars ?? [{ id: 'av1', voice: { id: 'v1' }, visual: { id: 'vis' } }, { id: 'av2', voice: { id: 'v2' }, visual: { id: 'vis' } }];
  const cfg = { id: 10, type: 'brain', base_directive: LONG, prompts: [{ key: 'pron', value: TABLE }], opening_phrase: 'Welcome to the Q3 review, revenue is up 12%.', ...intellect };
  const ff = fakeFetch([
    { match: 'lifecycle/list', respond: pageOf([]) },
    { match: 'insight-settings/list', respond: pageOf([]) },
    { match: 'email-template/list', respond: pageOf([]) },
    { match: 'agent/list', respond: pageOf(A) },
    { match: 'v1/intellect/get', respond: () => ({ body: cfg }) },
    { match: 'avatar/list', respond: pageOf(AV) },
    { match: 'catalog-item/list', respond: (req) => pageOf(req.body.filter?.typeEqual === 'Voice' ? (voiceListed ? V : []) : [{ itemId: 'vis', type: 'Visual' }])(req) },
    { match: 'catalog-item/get', respond: (req) => { const v = V.find((x) => x.itemId === req.body.itemId); return v ? { body: v } : notFound; } },
  ]);
  return { mgmt: new Management({ partnerId: '123', fetch: ff }), ff };
}
const speech = (report) => report.findings.filter((f) => ['spoken_text_digits_cross_language', 'respelling_hyphen_or_mixed_case', 'respelling_table_shared_across_providers', 'spoken_output_undeclared'].includes(f.code));
const codesOf = (report) => speech(report).map((f) => `${f.severity}:${f.code}${f.agentId ? `@${f.agentId}` : ''}`);

test('doctor: the Q3-style setup reports all four speech findings, each with its own scope', async () => {
  const { mgmt } = harness();
  const report = await mgmt.doctor(ADMIN_KS);
  assert.deepEqual(codesOf(report), [
    'warn:spoken_text_digits_cross_language@a1',
    'info:respelling_hyphen_or_mixed_case',
    'info:respelling_table_shared_across_providers',
    'info:spoken_output_undeclared',
  ]);
  const digits = report.findings.find((f) => f.code === 'spoken_text_digits_cross_language');
  assert.match(digits.message, /\(cartesia\) is made for "he"/);
  assert.match(digits.message, /prompt row "Q3"/);
  assert.match(digits.message, /opening_phrase/);
  assert.equal(digits.configId, 10);
  for (const code of ['respelling_hyphen_or_mixed_case', 'respelling_table_shared_across_providers', 'spoken_output_undeclared']) {
    assert.deepEqual(report.findings.find((f) => f.code === code).agentIds, ['a1', 'a2'], `${code} names both agents`);
  }
});

test('doctor: speech checks only read, and the same input gives the same report twice', async () => {
  const { mgmt, ff } = harness();
  const one = await mgmt.doctor(ADMIN_KS);
  const two = await mgmt.doctor(ADMIN_KS);
  assert.deepEqual(one, two);
  for (const c of ff.calls) assert.match(c.url, /\/(list|get)$/, 'read-only');
});

test('doctor: a clean spoken setup (words only, plain respellings, one provider, a spoken-output rule) has no speech findings', async () => {
  const { mgmt } = harness({
    intellect: { base_directive: `${LONG} Your reply is spoken aloud by a voice. Write numbers as words.`, prompts: [{ key: 'pron', value: 'CAGR -> "kay ger"\nEBITDA -> "ebitda"\n' }], opening_phrase: 'Welcome to the third quarter review.' },
    voices: [voiceItem('v1', 'he', 'cartesia'), voiceItem('v2', 'en', 'cartesia')],
  });
  assert.deepEqual(speech(await mgmt.doctor(ADMIN_KS)), []);
});

test('doctor: replies in the voice language have no digits finding, even with digits in the opening', async () => {
  const { mgmt } = harness({
    agents: [{ agentId: 'a1', intellect: { id: 10 }, avatarIds: ['av1'], asr: { language: 'he', provider: 'kaltura' } }],
    avatars: [{ id: 'av1', voice: { id: 'v1' }, visual: { id: 'vis' } }],
  });
  assert.equal((await mgmt.doctor(ADMIN_KS)).findings.some((f) => f.code === 'spoken_text_digits_cross_language'), false);
});

test('doctor: a voice that only catalog-item/get returns still gives its provider to the checks', async () => {
  const { mgmt, ff } = harness({ voiceListed: false });
  const report = await mgmt.doctor(ADMIN_KS);
  assert.ok(ff.calls.some((c) => c.url.endsWith('catalog-item/get')));
  assert.match(report.findings.find((f) => f.code === 'spoken_text_digits_cross_language').message, /\(cartesia\)/);
  assert.ok(report.findings.some((f) => f.code === 'respelling_table_shared_across_providers'));
});

test('doctor: a voice with no provider never counts as a second provider', async () => {
  const { mgmt } = harness({ voices: [voiceItem('v1', 'he', 'cartesia'), voiceItem('v2', 'en')] });
  assert.equal((await mgmt.doctor(ADMIN_KS)).findings.some((f) => f.code === 'respelling_table_shared_across_providers'), false);
});

test('doctor: only and skip pick the speech group by category and by check id', async () => {
  const { mgmt } = harness();
  const only = await mgmt.doctor(ADMIN_KS, { only: ['speech'] });
  assert.equal(only.findings.length, 4);
  assert.deepEqual([...new Set(only.findings.map((f) => f.code))].sort(), ['respelling_hyphen_or_mixed_case', 'respelling_table_shared_across_providers', 'spoken_output_undeclared', 'spoken_text_digits_cross_language']);
  const skip = await mgmt.doctor(ADMIN_KS, { skip: ['speech'] });
  assert.deepEqual(speech(skip), []);
  const one = await mgmt.doctor(ADMIN_KS, { only: ['respelling-style'] });
  assert.deepEqual(one.findings.map((f) => f.code), ['respelling_hyphen_or_mixed_case']);
  const without = await mgmt.doctor(ADMIN_KS, { only: ['speech'], skip: ['spoken-digits-cross-language'] });
  assert.equal(without.findings.some((f) => f.code === 'spoken_text_digits_cross_language'), false);
});

test('doctor: ignore hides a speech finding for one agent and counts it as suppressed', async () => {
  const { mgmt } = harness();
  const report = await mgmt.doctor(ADMIN_KS, { only: ['speech'], ignore: [{ code: 'spoken_text_digits_cross_language', agentId: 'a1' }] });
  assert.equal(report.findings.some((f) => f.code === 'spoken_text_digits_cross_language'), false);
  assert.equal(report.summary.suppressed, 1);
  const shared = await mgmt.doctor(ADMIN_KS, { only: ['speech'], ignore: [{ code: 'respelling_table_shared_across_providers', agentId: 'a2' }] });
  assert.equal(shared.findings.some((f) => f.code === 'respelling_table_shared_across_providers'), false, 'agentId matches a finding about several agents');
});

test('doctor: severities land in the summary and sort warn before info', async () => {
  const { mgmt } = harness();
  const report = await mgmt.doctor(ADMIN_KS, { only: ['speech'] });
  assert.deepEqual(report.summary, { error: 0, warn: 1, info: 3 });
  assert.equal(report.findings[0].severity, 'warn');
});

test('doctor: agentIds scopes the per-agent digits check but the intellect checks still see every agent that uses it', async () => {
  const { mgmt } = harness();
  const report = await mgmt.doctor(ADMIN_KS, { agentIds: ['a2'], only: ['speech'] });
  assert.equal(report.findings.some((f) => f.code === 'spoken_text_digits_cross_language'), false, 'a2 has the en voice');
  assert.ok(report.findings.some((f) => f.code === 'respelling_hyphen_or_mixed_case'));
});

test('doctor: an agent with no avatar gets no speech findings, and no avatar reads are made', async () => {
  const { mgmt, ff } = harness({ agents: [{ agentId: 'a1', intellect: { id: 10 } }], avatars: [] });
  const report = await mgmt.doctor(ADMIN_KS, { only: ['speech'] });
  assert.deepEqual(report.findings.map((f) => f.code), ['respelling_hyphen_or_mixed_case']);
  assert.ok(ff.calls.length > 0);
});

test('doctor: an external intellect gets no speech findings', async () => {
  const { mgmt } = harness({ intellect: { type: 'external' } });
  assert.deepEqual(speech(await mgmt.doctor(ADMIN_KS)), []);
});
