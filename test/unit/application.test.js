import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Application } from '../../src/management/application.js';
import { KalturaError } from '../../src/core/errors.js';

/**
 * Unit tests for Application (generateProfile, resolveWidgetId, appInit).
 * Uses a recording fake ctx — same shape as client.js builds — so all
 * assertions run offline with zero network.
 */

const ADMIN = 'admin-ks';
const CONV = 'conv-ks';

/** Recording ctx that mirrors the management Ctx shape. */
function fakeCtx({ agenticRoutes = {} } = {}) {
  /** @type {{path:string, body:any, ks:string}[]} */
  const calls = [];
  return {
    calls,
    assertAdmin: (ks, where) => {
      if (ks !== ADMIN) {
        throw new KalturaError({ type: 'about:blank', title: 'scope', code: 'wrong_token_scope', detail: where });
      }
    },
    agentic: async (path, body, ks) => {
      calls.push({ path, body, ks });
      const handler = agenticRoutes[path];
      if (handler) return handler(body, ks);
      return { data: { ok: true }, requestId: 'r1' };
    },
  };
}

// ── appInit ───────────────────────────────────────────────────────────────────

test('appInit: throws bad_request when widgetKs is missing (empty string)', async () => {
  const ctx = fakeCtx();
  await assert.rejects(
    () => new Application(ctx).appInit(''),
    (e) => e instanceof KalturaError && e.code === 'bad_request',
  );
  assert.equal(ctx.calls.length, 0, 'no network call on guard failure');
});

test('appInit: throws bad_request when widgetKs is null/undefined', async () => {
  const ctx = fakeCtx();
  await assert.rejects(
    () => new Application(ctx).appInit(/** @type {any} */ (null)),
    (e) => e instanceof KalturaError && e.code === 'bad_request',
  );
  assert.equal(ctx.calls.length, 0);
});

test('appInit: happy path returns .data payload and routes to application/appInit', async () => {
  const payload = { ks: 'genie-ks', conversationManagerUrl: 'https://cm.example', srsBaseUrl: 'https://srs.example', turnServerUrl: 'https://turn.example', avatars: [] };
  const ctx = fakeCtx({
    agenticRoutes: { 'application/appInit': () => ({ data: payload, requestId: 'r2' }) },
  });
  const result = await new Application(ctx).appInit('widget-ks-token');
  assert.deepEqual(result, payload);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].path, 'application/appInit');
  assert.equal(ctx.calls[0].ks, 'widget-ks-token');
});

// see issue #16 — locks the verbatim-passthrough contract for avatars[]'s
// preview/loading fields specifically, so a future accidental reshape (e.g.
// dropping previewImageUrl, renaming loadingVideoUrl) is caught.
test('appInit: avatars[] preview/loading fields pass through unmodified, including an unexpected extra field', async () => {
  const payload = {
    ks: 'genie-ks', conversationManagerUrl: 'https://cm.example', srsBaseUrl: 'https://srs.example', turnServerUrl: 'https://turn.example',
    avatars: [
      { id: 'agent-1', previewImageUrl: 'https://cdn.example/raw-upload.jpg', loadingVideoUrl: 'https://cdn.example/raw-upload.mp4', futureField: 'unexpected' },
    ],
  };
  const ctx = fakeCtx({
    agenticRoutes: { 'application/appInit': () => ({ data: payload, requestId: 'r2b' }) },
  });
  const result = await new Application(ctx).appInit('widget-ks-token');
  assert.deepEqual(result, payload);
});

// see issue #16 — the raw-passthrough caveat must be documented at the call
// site, not just in API-REFERENCE.md, since JSDoc isn't scanned by
// tools/check-docs.mjs (markdown-only scope).
test('appInit: JSDoc documents that previewImageUrl/loadingVideoUrl are raw backend asset URLs', async () => {
  const src = await readFile(new URL('../../src/management/application.js', import.meta.url), 'utf8');
  const jsdoc = src.slice(src.indexOf('/**', src.indexOf('async appInit') - 800), src.indexOf('async appInit'));
  assert.match(jsdoc, /raw backend asset URLs/i);
});

// ── generateProfile ───────────────────────────────────────────────────────────

test('generateProfile: rejects a conversation-scoped KS (wrong_token_scope)', async () => {
  const ctx = fakeCtx();
  await assert.rejects(
    () => new Application(ctx).generateProfile('a yoga receptionist', CONV),
    (e) => e instanceof KalturaError && e.code === 'wrong_token_scope',
  );
  assert.equal(ctx.calls.length, 0, 'no network call on scope rejection');
});

test('generateProfile: happy path returns .data payload with admin KS', async () => {
  const profile = { name: 'YogaBot', goal: 'help users', targetAudience: 'students', restrictedTopics: 'none', openingPhrase: 'Namaste!' };
  const ctx = fakeCtx({
    agenticRoutes: { 'application/generateAgentProfile': () => ({ data: profile, requestId: 'r3' }) },
  });
  const result = await new Application(ctx).generateProfile('a yoga receptionist', ADMIN);
  assert.deepEqual(result, profile);
  assert.equal(ctx.calls[0].path, 'application/generateAgentProfile');
  assert.deepEqual(ctx.calls[0].body, { userDescription: 'a yoga receptionist' });
});

// ── resolveWidgetId ───────────────────────────────────────────────────────────

test('resolveWidgetId: rejects a conversation-scoped KS (wrong_token_scope)', async () => {
  const ctx = fakeCtx();
  await assert.rejects(
    () => new Application(ctx).resolveWidgetId('agent-uuid', CONV),
    (e) => e instanceof KalturaError && e.code === 'wrong_token_scope',
  );
  assert.equal(ctx.calls.length, 0);
});

test('resolveWidgetId: happy path returns .data payload with admin KS', async () => {
  const ctx = fakeCtx({
    agenticRoutes: { 'application/resolveWidgetId': () => ({ data: { widgetId: '1_v1mj1kxb' }, requestId: 'r4' }) },
  });
  const result = await new Application(ctx).resolveWidgetId('agent-uuid', ADMIN);
  assert.deepEqual(result, { widgetId: '1_v1mj1kxb' });
  assert.equal(ctx.calls[0].path, 'application/resolveWidgetId');
  assert.deepEqual(ctx.calls[0].body, { agentId: 'agent-uuid' });
});
