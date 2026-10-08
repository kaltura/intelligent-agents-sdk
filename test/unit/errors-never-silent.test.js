// Errors are never swallowed: a refusal that arrives with HTTP 200 (an error body, an
// in-band `error` segment, a multirequest slot, a non-JSON "JSON" body) is raised as a
// KalturaError with context, unless the caller opts out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaError, errorFromOkBody, errorFromErrorSegments } from '../../src/core/errors.js';
import { Http } from '../../src/core/http.js';
import { parseConverseStream, collectConverse, converseBodyOrThrow } from '../../src/core/stream.js';
import { Management } from '../../src/management/client.js';
import { KalturaChatSession } from '../../src/experience/index.js';
import { fakeFetch, streamFrom } from '../fakes/fetch.js';

const DENIED = JSON.stringify({ role: 'assistant', type: 'error', content: 'No permission for thread', isFinal: true }) + '\n';
const OK_REPLY = [
  JSON.stringify({ type: 'think', content: '', threadId: 't-1', messageId: 'm-1' }),
  JSON.stringify({ type: 'text', content: 'Hi' }),
].join('\n') + '\n';
const CONV_TOKEN = { ks: 'djJ8conv', kind: 'conversation' };
const ADMIN = 'djJ8' + 'A'.repeat(40);
const CHAT_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

// ───────────────────────── errorFromOkBody ─────────────────────────

test('errorFromOkBody: error-only envelopes become errors with the server text', () => {
  assert.equal(errorFromOkBody({ error: 'nope' }, '/x').detail, 'nope');
  assert.equal(errorFromOkBody({ success: false, message: 'bad' }, '/x').detail, 'bad');
  assert.equal(errorFromOkBody({ status: 500, error: { message: 'boom' } }, '/x').detail, 'boom');
  const e = errorFromOkBody({ ok: false }, '/x');
  assert.ok(e instanceof KalturaError);
  assert.match(e.detail, /HTTP 200 from \/x carried an error body/);
  assert.equal(e.status, 200);
  assert.equal(e.instance, '/x');
});

test('errorFromOkBody: real payloads that merely contain an error-ish key are NOT errors', () => {
  assert.equal(errorFromOkBody({ id: '1', error: 'x' }, '/x'), null);
  assert.equal(errorFromOkBody({ message: 'ok' }, '/x'), null);
  assert.equal(errorFromOkBody({ id: 'a', status: 500 }, '/x'), null);
  assert.equal(errorFromOkBody({ success: true, message: 'done' }, '/x'), null);
  assert.equal(errorFromOkBody([{ error: 'x' }], '/x'), null);
  assert.equal(errorFromOkBody({}, '/x'), null);
});

// ───────────────────────── errorFromErrorSegments ─────────────────────────

test('errorFromErrorSegments: "No permission for thread" → thread_access_denied with a hint and context', () => {
  const e = errorFromErrorSegments(
    [{ type: 'error', content: 'No permission for thread' }],
    { path: '/assistant/converse', threadId: 't-9', requestId: 'rid-1', partial: { text: '' } },
  );
  assert.ok(e instanceof KalturaError);
  assert.equal(e.code, 'thread_access_denied');
  assert.equal(e.status, 200);
  assert.equal(e.requestId, 'rid-1');
  assert.match(e.detail, /No permission for thread/);
  assert.match(e.detail, /Thread t-9 belongs to a different user/);
  assert.equal(e.body.threadId, 't-9');
  assert.deepEqual(e.body.partial, { text: '' });
  assert.equal(e.body.errors.length, 1);
});

test('errorFromErrorSegments: any other error segment → stream_error; no segments → null', () => {
  const e = errorFromErrorSegments([{ type: 'error', content: 'model overloaded' }, { type: 'error', content: 'retry later' }], {});
  assert.equal(e.code, 'stream_error');
  assert.match(e.detail, /model overloaded; retry later/);
  assert.equal(errorFromErrorSegments([{ type: 'text', content: 'hi' }], {}), null);
});

// ───────────────────────── Http ─────────────────────────

test('Http: a 200 body that opens like JSON but does not parse throws invalid_response (never returns a raw string)', async () => {
  const cut = async () => ({ ok: true, status: 200, headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) }, text: async () => '{"objects":[{"id":"a"' });
  await assert.rejects(() => new Http({ fetch: cut }).postJson({ url: 'https://x/y', ks: 'k', body: {} }), (e) => e.code === 'invalid_response' && /objects/.test(e.detail));
  const truncated = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => '{"a":' });
  await assert.rejects(() => new Http({ fetch: truncated }).postJson({ url: 'https://x/y', ks: 'k', body: {} }), (e) => e.code === 'invalid_response');
});

test('Http: a bare token typed application/json (session start) still passes through', async () => {
  const fake = async () => ({ ok: true, status: 200, headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) }, text: async () => 'djJ8bare-token-value' });
  const { data } = await new Http({ fetch: fake }).request({ method: 'POST', url: 'https://x/y', json: true, body: {} });
  assert.equal(data, 'djJ8bare-token-value');
});

test('Http: a plain-text or CSV 200 body still passes through', async () => {
  const fake = async () => ({ ok: true, status: 200, headers: { get: (k) => (k === 'content-type' ? 'text/csv' : null) }, text: async () => 'a,b\n1,2\n' });
  const { data } = await new Http({ fetch: fake }).request({ method: 'GET', url: 'https://x/y' });
  assert.equal(data, 'a,b\n1,2\n');
});

test('Http: a 200 with an error-only JSON body throws', async () => {
  const fake = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"error":"denied by policy"}' });
  await assert.rejects(() => new Http({ fetch: fake }).postJson({ url: 'https://x/y', ks: 'k', body: {} }), (e) => /denied by policy/.test(e.detail));
});

// ───────────────────────── stream ─────────────────────────

test('parseConverseStream: an unparseable line becomes an error segment, not a dropped line', async () => {
  const segs = [];
  for await (const s of parseConverseStream(streamFrom('{"type":"text","content":"a"}\n<html>502 Bad Gateway</html>\n'))) segs.push(s);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].type, 'error');
  assert.equal(segs[1].metadata.subtype, 'unparseable_stream_line');
  assert.match(segs[1].content, /502 Bad Gateway/);
});

test('collectConverse returns the error segments in `errors`', async () => {
  const r = await collectConverse(parseConverseStream(streamFrom(DENIED)));
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].content, 'No permission for thread');
  assert.equal(r.text, '');
  const ok = await collectConverse(parseConverseStream(streamFrom(OK_REPLY)));
  assert.deepEqual(ok.errors, []);
});

test('converseBodyOrThrow: a JSON error body throws; ndjson passes through; a JSON non-error body is replayed', async () => {
  const mk = (type, text) => ({ headers: { get: () => type }, body: streamFrom(text), text: async () => text });
  await assert.rejects(() => converseBodyOrThrow(mk('application/json', '{"error":"no access"}'), { path: '/assistant/converse', requestId: 'r1' }), (e) => /no access/.test(e.detail) && e.requestId === 'r1');
  const nd = mk('application/x-ndjson', OK_REPLY);
  assert.equal(await converseBodyOrThrow(nd, { path: '/p' }), nd.body);
  const replay = await converseBodyOrThrow(mk('application/json', '{"type":"text","content":"hey"}'), { path: '/p' });
  const r = await collectConverse(parseConverseStream(replay));
  assert.equal(r.text, 'hey');
});

// ───────────────────────── conversations.send ─────────────────────────

function mgmtFor(reply, status = 200, type = 'application/x-ndjson') {
  const ff = fakeFetch([{ match: '/assistant/converse', respond: () => ({ status, body: typeof reply === 'function' ? reply() : reply, headers: { 'content-type': type } }) }]);
  return { mgmt: new Management({ partnerId: '123', fetch: ff }), ff };
}

test('conversations.send throws thread_access_denied on an in-band refusal', async () => {
  const { mgmt } = mgmtFor(DENIED);
  await assert.rejects(
    () => mgmt.conversations.send({ userMessage: 'hi', threadId: 'foreign-1' }, CONV_TOKEN),
    (e) => e.code === 'thread_access_denied' && /foreign-1/.test(e.detail) && e.body.errors.length === 1,
  );
});

test("conversations.send onErrorSegment:'return' hands the refusal back in result.errors", async () => {
  const { mgmt } = mgmtFor(DENIED);
  const r = await mgmt.conversations.send({ userMessage: 'hi', threadId: 'foreign-1', onErrorSegment: 'return' }, CONV_TOKEN);
  assert.equal(r.text, '');
  assert.equal(r.errors[0].content, 'No permission for thread');
});

test('conversations.send rejects a bad onErrorSegment value before any network call', async () => {
  const { mgmt, ff } = mgmtFor(OK_REPLY);
  await assert.rejects(() => mgmt.conversations.send({ userMessage: 'hi', onErrorSegment: 'ignore' }, CONV_TOKEN), (e) => e.code === 'bad_request');
  assert.equal(ff.calls.length, 0);
});

test('conversations.send: a normal reply is untouched and carries errors:[]', async () => {
  const { mgmt } = mgmtFor(OK_REPLY);
  const r = await mgmt.conversations.send({ userMessage: 'hi' }, CONV_TOKEN);
  assert.equal(r.text, 'Hi');
  assert.deepEqual(r.errors, []);
});

test('conversations.send: the spiral-recovery retry also throws on an in-band refusal', async () => {
  const spiral = Array.from({ length: 20 }, (_, i) => JSON.stringify({ type: 'tool', content: `show_widget {"kind":"followups","data":"{\\"q\\":${i}}"}` })).join('\n') + '\n';
  let n = 0;
  const { mgmt } = mgmtFor(() => (++n === 1 ? spiral : DENIED));
  await assert.rejects(
    () => mgmt.conversations.send({ userMessage: 'hi', recoverFromSpiral: true }, CONV_TOKEN),
    (e) => e.code === 'thread_access_denied',
  );
  assert.equal(n, 2, 'the recovery retry ran');
});

test('conversations.send: a JSON error body typed application/json throws instead of returning an empty reply', async () => {
  const { mgmt } = mgmtFor({ error: 'conversation unavailable' }, 200, 'application/json');
  await assert.rejects(() => mgmt.conversations.send({ userMessage: 'hi' }, CONV_TOKEN), (e) => /conversation unavailable/.test(e.detail));
});

// ───────────────────────── KalturaChatSession ─────────────────────────

function chat(reply, cfg = {}) {
  const fetch = fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: reply }) }]);
  return new KalturaChatSession({ token: CHAT_KS, fetch, ...cfg });
}

test('KalturaChatSession: an in-band refusal rejects sendText, emits error, and keeps partial context', async () => {
  const s = chat(DENIED, { threadId: 'foreign-1' });
  await s.connect();
  const emitted = [];
  s.on('error', (e) => emitted.push(e));
  await assert.rejects(() => s.sendText('hi'), (e) => e.code === 'thread_access_denied' && e.body.threadId === 'foreign-1');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].code, 'thread_access_denied');
});

test("KalturaChatSession onErrorSegment:'warn' emits a warning and resolves", async () => {
  const s = chat(DENIED, { onErrorSegment: 'warn' });
  await s.connect();
  const warnings = [];
  s.on('warning', (w) => warnings.push(w));
  const r = await s.sendText('hi');
  assert.equal(r.text, '');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'thread_access_denied');
});

test('KalturaChatSession rejects an unknown onErrorSegment value', () => {
  assert.throws(() => chat(OK_REPLY, { onErrorSegment: 'ignore' }), (e) => e.code === 'bad_request');
});

test('KalturaChatSession: a normal turn still resolves and the owner can keep using the session', async () => {
  const s = chat(OK_REPLY);
  await s.connect();
  const r = await s.sendText('hi');
  assert.equal(r.text, 'Hi');
});

// ───────────────────────── ovpMulti ─────────────────────────

function ovpMgmt(results) {
  const ff = fakeFetch([{ match: '/service/multirequest', respond: () => ({ body: results }) }]);
  return { mgmt: new Management({ partnerId: '123', fetch: ff }), ff };
}
const EXC = (code, message) => ({ objectType: 'KalturaAPIException', code, message });

test('ovpMulti throws ovp_error naming the failed call; success passes through', async () => {
  const calls = [{ service: 'baseentry', action: 'updateContent' }, { service: 'categoryentry', action: 'add' }];
  const bad = ovpMgmt([{ id: 'e1' }, EXC('CATEGORY_NOT_FOUND', 'no such category')]);
  await assert.rejects(
    () => bad.mgmt._ctx.ovpMulti(calls, ADMIN),
    (e) => e.code === 'ovp_error' && /categoryentry\/add: no such category/.test(e.detail) && e.instance === '/service/multirequest[1]',
  );
  const good = ovpMgmt([{ id: 'e1' }, { id: 'ce1' }]);
  assert.equal((await good.mgmt._ctx.ovpMulti(calls, ADMIN)).length, 2);
});

test('ovpMulti: tolerate() lets a chosen exception through', async () => {
  const dup = ovpMgmt([{ id: 'e1' }, EXC('CATEGORY_ENTRY_ALREADY_EXISTS', 'already assigned')]);
  const out = await dup.mgmt._ctx.ovpMulti([{}, {}], ADMIN, { tolerate: (x) => x.code === 'CATEGORY_ENTRY_ALREADY_EXISTS' });
  assert.equal(out.length, 2);
});

// ───────────────────────── agents.delete guard ─────────────────────────

test('agents.delete fails closed when the protected-tag lookup errors (500)', async () => {
  const ff = fakeFetch([
    { match: '/agent/get', respond: () => ({ status: 500, body: { message: 'boom' } }) },
    { match: '/agent/delete', respond: () => ({ body: { ok: true } }) },
  ]);
  const m = new Management({ partnerId: 1234567, adminSecret: 'a'.repeat(32), fetch: ff, retry: { retries: 0 } });
  await assert.rejects(() => m.agents.delete('a1', ADMIN, { confirmPermanent: true }), (e) => e instanceof KalturaError);
  assert.equal(ff.calls.filter((c) => c.url.includes('/agent/delete')).length, 0);
});

test('agents.delete proceeds when the agent is already gone (404), and skipProtectedCheck skips the lookup', async () => {
  const gone = fakeFetch([
    { match: '/agent/get', respond: () => ({ status: 404, body: { message: 'not found' } }) },
    { match: '/agent/delete', respond: () => ({ body: { ok: true } }) },
  ]);
  await new Management({ partnerId: 1234567, adminSecret: 'a'.repeat(32), fetch: gone }).agents.delete('a1', ADMIN, { confirmPermanent: true });
  assert.equal(gone.calls.filter((c) => c.url.includes('/agent/delete')).length, 1);

  const skip = fakeFetch([
    { match: '/agent/get', respond: () => ({ status: 500, body: {} }) },
    { match: '/agent/delete', respond: () => ({ body: { ok: true } }) },
  ]);
  await new Management({ partnerId: 1234567, adminSecret: 'a'.repeat(32), fetch: skip }).agents.delete('a1', ADMIN, { confirmPermanent: true, skipProtectedCheck: true });
  assert.equal(skip.calls.filter((c) => c.url.includes('/agent/get')).length, 0);
});
