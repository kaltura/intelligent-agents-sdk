import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

/** `mgmt.doctorFix`: the only doctor writer. fakeFetch only. */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);
const pageOf = (all) => () => ({ body: { objects: all, totalCount: all.length } });
const VOICE = { itemId: 'v1', type: 'Voice', adminTags: ['preset'], attributes: { voice: { name: 'Maya', language: 'he' } } };

/** One agent with the incident setup. `live` is what `agent/get` returns when the fix reads it. */
function harness({ live = { language: 'en', provider: 'kaltura' }, getStatus } = {}) {
  const writes = [];
  const ff = fakeFetch([
    { match: 'lifecycle/list', respond: pageOf([]) },
    { match: 'insight-settings/list', respond: pageOf([]) },
    { match: 'email-template/list', respond: pageOf([]) },
    { match: 'agent/list', respond: pageOf([{ agentId: 'a1', intellect: { id: 10 }, avatarIds: ['av1'], asr: { language: 'en', provider: 'kaltura' } }]) },
    { match: 'v1/intellect/get', respond: () => ({ body: { id: 10, type: 'brain', force_language: 'Hebrew' } }) },
    { match: 'avatar/list', respond: pageOf([{ id: 'av1', voice: { id: 'v1' }, visual: { id: 'vis1' } }]) },
    { match: 'catalog-item/list', respond: (req) => pageOf(req.body.filter?.typeEqual === 'Voice' ? [VOICE] : [{ itemId: 'vis1', type: 'Visual' }])() },
    { match: 'agent/get', respond: () => (getStatus ? { status: getStatus, body: { message: 'x' } } : { body: { agentId: 'a1', asr: live } }) },
    { match: 'agent/update', respond: (req) => { writes.push(req.body); return { body: { agentId: 'a1', ...req.body } }; } },
  ]);
  return { mgmt: new Management({ partnerId: '123', fetch: ff }), ff, writes };
}

test('the doctor puts an autofix on the error variant of asr_language_mismatch', async () => {
  const { mgmt } = harness();
  const f = (await mgmt.doctor(ADMIN_KS)).findings.find((x) => x.code === 'asr_language_mismatch');
  assert.deepEqual(f.autofix, { action: 'set_asr_language', agentId: 'a1', from: 'en', to: 'he' });
});

test('doctorFix: a dry run reads, plans, returns an undo body and writes nothing', async () => {
  const { mgmt, ff, writes } = harness();
  const report = await mgmt.doctor(ADMIN_KS);
  const out = await mgmt.doctorFix(ADMIN_KS, report);
  assert.equal(out.applied, false);
  assert.deepEqual(out.results.map((r) => [r.code, r.agentId, r.status]), [['asr_language_mismatch', 'a1', 'planned']]);
  assert.deepEqual(out.results[0].after, { language: 'he', provider: 'kaltura' });
  assert.deepEqual(out.results[0].undo, { agentId: 'a1', asr: { language: 'en', provider: 'kaltura' } });
  assert.equal(writes.length, 0);
  assert.equal(ff.calls.some((c) => c.url.endsWith('agent/update')), false);
});

test('doctorFix: apply writes asr only, keeps the provider, and reports applied', async () => {
  const { mgmt, writes } = harness({ live: { language: 'en', provider: 'elevenlabs' } });
  const report = await mgmt.doctor(ADMIN_KS);
  const out = await mgmt.doctorFix(ADMIN_KS, report, { apply: true, codes: ['asr_language_mismatch'] });
  assert.equal(out.applied, true);
  assert.equal(out.results[0].status, 'applied');
  assert.deepEqual(writes, [{ agentId: 'a1', asr: { language: 'he', provider: 'elevenlabs' } }]);
  assert.deepEqual(out.results[0].undo, { agentId: 'a1', asr: { language: 'en', provider: 'elevenlabs' } });
});

test('doctorFix: refuses when the live language is no longer the one the report saw', async () => {
  const { mgmt, writes } = harness({ live: { language: 'fr', provider: 'kaltura' } });
  const report = await mgmt.doctor(ADMIN_KS);
  const out = await mgmt.doctorFix(ADMIN_KS, report, { apply: true, codes: ['asr_language_mismatch'] });
  assert.equal(out.results[0].status, 'refused');
  assert.match(out.results[0].reason, /"fr" now.*"en"/);
  assert.equal(out.applied, false);
  assert.equal(writes.length, 0);
});

test('doctorFix: a fix someone already made is already_applied, with no write', async () => {
  const { mgmt, writes } = harness({ live: { language: 'iw', provider: 'kaltura' } });
  const report = await mgmt.doctor(ADMIN_KS);
  const out = await mgmt.doctorFix(ADMIN_KS, report, { apply: true, codes: ['asr_language_mismatch'] });
  assert.equal(out.results[0].status, 'already_applied');
  assert.equal(writes.length, 0);
});

test('doctorFix: apply needs codes, and codes must be strings', async () => {
  const { mgmt, ff } = harness();
  const report = await mgmt.doctor(ADMIN_KS);
  const before = ff.calls.length;
  for (const opts of [{ apply: true }, { apply: true, codes: [] }, { codes: 'x' }, { codes: [1] }]) {
    await assert.rejects(() => mgmt.doctorFix(ADMIN_KS, report, opts), (e) => e.code === 'bad_request');
  }
  assert.equal(ff.calls.length, before);
});

test('doctorFix: a report that is not a doctor report is rejected before any request', async () => {
  const { mgmt, ff } = harness();
  for (const bad of [null, {}, { findings: 'x' }]) {
    await assert.rejects(() => mgmt.doctorFix(ADMIN_KS, bad), (e) => e.code === 'bad_request');
  }
  assert.equal(ff.calls.length, 0);
});

test('doctorFix: ignores findings with no autofix, a hand-made action, or an unusable target', async () => {
  const { mgmt, ff } = harness();
  const report = { findings: [
    { code: 'asr_language_mismatch', severity: 'warn', message: 'm', fix: 'f' },
    { code: 'asr_language_mismatch', severity: 'error', message: 'm', fix: 'f', autofix: { action: 'delete_agent', agentId: 'a1', from: 'en', to: 'he' } },
    { code: 'latency_thinking', severity: 'info', message: 'm', fix: 'f', autofix: { action: 'set_asr_language', agentId: 'a1', from: 'en', to: 'he' } },
    { code: 'asr_language_mismatch', severity: 'error', message: 'm', fix: 'f', autofix: { action: 'set_asr_language', agentId: 'a1', from: 'en', to: 'Hebrew' } },
  ] };
  const out = await mgmt.doctorFix(ADMIN_KS, report);
  assert.deepEqual(out.results, []);
  assert.equal(ff.calls.length, 0);
});

test('doctorFix: the same agent twice in a report is fixed once', async () => {
  const { mgmt, writes } = harness();
  const one = (await mgmt.doctor(ADMIN_KS)).findings.find((x) => x.code === 'asr_language_mismatch');
  const out = await mgmt.doctorFix(ADMIN_KS, { findings: [one, one] }, { apply: true, codes: ['asr_language_mismatch'] });
  assert.equal(out.results.length, 1);
  assert.equal(writes.length, 1);
});

test('doctorFix: a deleted agent is refused, a 500 on read is failed, a 401 rejects', async () => {
  const report = { findings: [{ code: 'asr_language_mismatch', severity: 'error', message: 'm', fix: 'f', agentId: 'a1', autofix: { action: 'set_asr_language', agentId: 'a1', from: 'en', to: 'he' } }] };
  const gone = await harness({ getStatus: 404 }).mgmt.doctorFix(ADMIN_KS, report);
  assert.equal(gone.results[0].status, 'refused');
  const broken = await harness({ getStatus: 500 }).mgmt.doctorFix(ADMIN_KS, report);
  assert.equal(broken.results[0].status, 'failed');
  assert.match(broken.results[0].reason, /500/);
  await assert.rejects(() => harness({ getStatus: 401 }).mgmt.doctorFix(ADMIN_KS, report), (e) => e.status === 401);
});

test('doctorFix needs an admin token', async () => {
  const { mgmt, ff } = harness();
  await assert.rejects(() => mgmt.doctorFix({ ks: 'x', kind: 'conversation' }, { findings: [] }), (e) => e.code === 'wrong_token_scope');
  assert.equal(ff.calls.length, 0);
});
