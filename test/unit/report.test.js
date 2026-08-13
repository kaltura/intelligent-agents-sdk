import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, summarizeReport } from '../../src/management/index.js';
import { fakeFetch } from '../fakes/fetch.js';
import { Management } from '../../src/management/client.js';

const CSV = [
  'Genie Id,Genie Context,Created,User Id,User Name,Thread Id,Question Id,Question,Response type,Sources,Feedback reaction,Feedback comment',
  'g1,ctx,2026-01-01,u1,Alice,th1,q1,"How do I reset, my password?",text,,1,helpful',
  'g1,ctx,2026-01-01,u2,Bob,th1,q2,How do I reset my password?,text,,0,',
  'g1,ctx,2026-01-02,u3,Cara,th2,q3,How do I reset my password?,text,,,',
].join('\n') + '\n';

test('parseCsv handles quoted fields with embedded commas', () => {
  const rows = parseCsv(CSV);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].Question, 'How do I reset, my password?');
  assert.equal(rows[0]['Feedback reaction'], '1');
});

test('summarizeReport aggregates totals, feedback ratio, top questions + provenance', () => {
  const s = summarizeReport(CSV, '6496302');
  assert.equal(s.totals.messages, 3);
  assert.equal(s.totals.threads, 2);
  assert.equal(s.feedback.positive, 1);
  assert.equal(s.feedback.negative, 1);
  assert.equal(s.feedback.unrated, 1);
  assert.equal(s.feedback.positiveRatio, 0.5);
  assert.equal(s.topQuestions[0].question, 'How do I reset my password?');
  assert.equal(s.topQuestions[0].count, 2);
  // provenance receipt is mandatory
  assert.match(s._meta.generatedAt, /Z$/);
  assert.equal(s._meta.partnerId, '6496302');
  assert.equal(s._meta.source, 'genie/message/report');
  assert.ok(s._meta.scope.includes('disableentitlement'));
});

test('positiveRatio is null when there is no feedback', () => {
  const csv = 'Thread Id,Question,Feedback reaction\nth1,q,\n';
  assert.equal(summarizeReport(csv, 'p').feedback.positiveRatio, null);
});

// ── messages.report + messages.reportSummary (wire tests) ──

/** Build a plaintext KSv2 carrying the given privilege string (matches inspectKs decoding). */
function fakeKs(priv) {
  const raw = `v2|999|${priv}`;
  const b64 = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'djJ8' + b64;
}

/** Plaintext admin token (disableentitlement — inspectable by the scope guard). */
const ADMIN_KS = fakeKs('disableentitlement');
/** Plaintext conversation token (geniegpcid — rejected by the admin-scope guard). */
const CONV_KS = fakeKs('geniegpcid:1222');

test('messages.report sends correct body to message/report and returns the CSV string', async () => {
  let captured;
  const ff = fakeFetch([
    {
      match: 'message/report',
      respond: (req) => {
        captured = req.body;
        return { status: 200, body: CSV, headers: { 'content-type': 'text/csv' } };
      },
    },
  ]);
  const mgmt = new Management({ partnerId: '9999', fetch: ff });
  const result = await mgmt.messages.report(ADMIN_KS);
  // The raw CSV string is returned as-is (no parsing at this layer).
  assert.equal(typeof result, 'string');
  assert.ok(result.includes('Thread Id') || result.includes('Genie Id'));
  // Correct filter objectType was sent.
  assert.equal(captured.filter.objectType, 'GenieListMessageFilter');
});

test('messages.report passes pageSize via pager when given', async () => {
  let captured;
  const ff = fakeFetch([
    {
      match: 'message/report',
      respond: (req) => { captured = req.body; return { status: 200, body: CSV, headers: { 'content-type': 'text/csv' } }; },
    },
  ]);
  const mgmt = new Management({ partnerId: '9999', fetch: ff });
  await mgmt.messages.report(ADMIN_KS, { pageSize: 42 });
  assert.equal(captured.pager.pageIndex, 1);
  assert.equal(captured.pager.pageSize, 42);
});

test('messages.reportSummary applies parseCsv and returns _meta.generatedAt + _meta.scope', async () => {
  const ff = fakeFetch([
    {
      match: 'message/report',
      respond: () => ({ status: 200, body: CSV, headers: { 'content-type': 'text/csv' } }),
    },
  ]);
  const mgmt = new Management({ partnerId: '9999', fetch: ff });
  const summary = await mgmt.messages.reportSummary(ADMIN_KS);
  // parseCsv was applied — totals should reflect the 3 data rows in CSV.
  assert.equal(summary.totals.messages, 3);
  // _meta provenance receipt is present.
  assert.match(summary._meta.generatedAt, /Z$/);
  assert.ok(typeof summary._meta.scope === 'string' && summary._meta.scope.length > 0);
});

test('messages.report rejects a non-admin (conversation) token', async () => {
  const mgmt = new Management({ partnerId: '9999', fetch: fakeFetch([]) });
  await assert.rejects(
    () => mgmt.messages.report(CONV_KS),
    (e) => e.code === 'wrong_token_scope',
  );
});
