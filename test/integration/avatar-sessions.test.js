/**
 * Scripted-video (STV-only) sessions — `avatar-session/*`. A brain-free
 * backend, independent of `application`/the conversational runtime.
 *
 * Covers the two-stage auth switch the live API uses (verified):
 *  - `create` needs the caller's own ADMIN KS (`Authorization: KS ...`).
 *  - every call AFTER `create` (`init-client`/`say-audio`/`interrupt`/
 *    `keep-alive`/`end`) needs the session's own Bearer JWT instead
 *    (`Authorization: Bearer ...`) — never the admin KS again.
 * And the pre-network guards that keep a caller from repeating the two
 * confirmed-live footguns: a missing `duration` on `say()` (the server has
 * no probe of its own) and passing a raw string instead of the
 * `{sessionId, token}` receipt `create()` returns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Management } from '../../src/management/index.js';
import { fakeFetch } from '../fakes/fetch.js';

const CONVERSATION_KS = 'djJ8MXxb=CONVERSATION-token-placeholder';

// A short, unsigned-looking JWT with a real base64url `exp` claim — matches the shape the
// live API returns (header.payload.signature) without looking like a real credential.
function fakeSessionToken(expEpochSeconds) {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64url({ alg: 'none' })}.${b64url({ exp: expEpochSeconds })}.sig`;
}

test('create() posts to avatar-session/create with the admin KS, and returns an expiry-aware receipt', async () => {
  const token = fakeSessionToken(Math.floor(Date.now() / 1000) + 3600);
  const f = fakeFetch([{ match: '/avatar-session/create', respond: () => ({ body: { sessionId: 'sess-1', token } }) }]);
  const kaltura = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  const admin = { ks: 'djJ8MXxb=ADMIN-token-placeholder', kind: 'admin' };

  const session = await kaltura.avatarSessions.create({ visualConfig: { id: 'avatar-1' } }, admin);

  assert.equal(session.sessionId, 'sess-1');
  assert.equal(session.token, token);
  assert.equal(session.isExpired(), false);
  assert.ok(session.secondsRemaining() > 3500);
  const call = f.calls.find((c) => c.url.includes('/avatar-session/create'));
  assert.equal(call.headers.authorization, `KS ${admin.ks}`);
});

test('create() rejects a conversation KS before any network call', async () => {
  const f = fakeFetch([{ match: '/avatar-session/create', respond: () => ({ body: { sessionId: 'x', token: 'y' } }) }]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    () => k.avatarSessions.create({ visualConfig: { id: 'avatar-1' } }, { ks: CONVERSATION_KS, kind: 'conversation' }),
    (e) => e.code === 'wrong_token_scope',
  );
  assert.equal(f.calls.length, 0);
});

test('create() rejects a missing visualConfig.id before any network call', async () => {
  const f = fakeFetch([{ match: '/avatar-session/create', respond: () => ({ body: {} }) }]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(
    () => k.avatarSessions.create({}, { ks: 'djJ8MXxb=ADMIN-token-placeholder', kind: 'admin' }),
    (e) => e.code === 'bad_request' && /visualConfig/.test(e.detail),
  );
  assert.equal(f.calls.length, 0);
});

test('initClient() authenticates with the session Bearer token, not a KS', async () => {
  const session = { sessionId: 'sess-1', token: 'session-bearer-token' };
  const f = fakeFetch([{
    match: '/avatar-session/sess-1/init-client',
    respond: (req) => {
      assert.equal(req.headers.authorization, 'Bearer session-bearer-token');
      return { body: { whepUrl: 'https://media.example.com/whep/sess-1', turn: { url: 'turn.example.com', username: 'kaltura', credential: 'avatar' } } };
    },
  }]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });

  const { whepUrl, turn } = await k.avatarSessions.initClient(session);

  assert.equal(whepUrl, 'https://media.example.com/whep/sess-1');
  assert.equal(turn.url, 'turn.example.com');
});

test('initClient() rejects a raw string in place of the {sessionId, token} receipt', async () => {
  const f = fakeFetch([{ match: '/init-client', respond: () => ({ body: {} }) }]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });
  await assert.rejects(() => k.avatarSessions.initClient('sess-1'), (e) => e.code === 'bad_request');
  assert.equal(f.calls.length, 0);
});

test('say() sends turnId/duration/audio as multipart with the session Bearer token, and rejects a missing duration pre-network', async () => {
  const session = { sessionId: 'sess-1', token: 'session-bearer-token' };
  const f = fakeFetch([{
    match: '/avatar-session/sess-1/say-audio',
    respond: (req) => {
      assert.equal(req.headers.authorization, 'Bearer session-bearer-token');
      assert.equal(req.body.get('duration'), '1.5');
      assert.ok(req.body.get('turnId'));
      return { body: { success: true } };
    },
  }]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });

  const result = await k.avatarSessions.say(session, new Uint8Array([1, 2, 3]), { duration: 1.5 });
  assert.equal(result.success, true);
  assert.equal(f.calls.length, 1);

  await assert.rejects(
    () => k.avatarSessions.say(session, new Uint8Array([1, 2, 3]), {}),
    (e) => e.code === 'bad_request' && /duration/.test(e.detail),
  );
  assert.equal(f.calls.length, 1, 'the missing-duration call must not reach the network');
});

test('interrupt()/keepAlive()/end() all authenticate with the session Bearer token', async () => {
  const session = { sessionId: 'sess-1', token: 'session-bearer-token' };
  const seen = [];
  const f = fakeFetch([
    { match: '/interrupt', respond: (req) => { seen.push(['interrupt', req.headers.authorization]); return { body: {} }; } },
    { match: '/keep-alive', respond: (req) => { seen.push(['keep-alive', req.headers.authorization]); return { body: {} }; } },
    { match: '/end', respond: (req) => { seen.push(['end', req.headers.authorization]); return { body: {} }; } },
  ]);
  const k = new Management({ partnerId: 6516742, adminSecret: 'a'.repeat(32), fetch: f });

  await k.avatarSessions.interrupt(session);
  await k.avatarSessions.keepAlive(session);
  await k.avatarSessions.end(session);

  assert.deepEqual(seen, [
    ['interrupt', 'Bearer session-bearer-token'],
    ['keep-alive', 'Bearer session-bearer-token'],
    ['end', 'Bearer session-bearer-token'],
  ]);
});
