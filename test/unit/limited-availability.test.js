import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITIES,
  CAPABILITY_DEFAULTS,
  CAPABILITY_INFO,
  LIMITED_AVAILABILITY_CAPABILITIES,
  assertCapability,
  validateCapabilities,
  resolveCapabilities,
} from '../../src/management/capabilities.js';
import { parseConverseStream, collectConverse } from '../../src/core/stream.js';
import { Management } from '../../src/management/client.js';
import { fakeFetch, streamFrom } from '../fakes/fetch.js';

/** Limited Availability: the `avatar_emotions` capability and the avatar `emotions` setting. */

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);
const repoFile = (rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// ── capability ──────────────────────────────────────────────────────────────

test('LIMITED_AVAILABILITY_CAPABILITIES is a frozen list of known capabilities', () => {
  assert.ok(Object.isFrozen(LIMITED_AVAILABILITY_CAPABILITIES));
  assert.deepEqual([...LIMITED_AVAILABILITY_CAPABILITIES], ['avatar_emotions']);
  for (const name of LIMITED_AVAILABILITY_CAPABILITIES) assert.ok(CAPABILITIES.includes(name), name);
});

test('avatar_emotions is accepted by the validators', () => {
  assert.equal(assertCapability('avatar_emotions'), 'avatar_emotions');
  assert.deepEqual(validateCapabilities({ avatar: 'on', avatar_emotions: 'on' }), { avatar: 'on', avatar_emotions: 'on' });
  assert.throws(() => validateCapabilities({ avatar_emotions: 'yes' }), (e) => e.code === 'bad_request');
  assert.throws(() => validateCapabilities({ avatar_emotion: 'on' }), (e) => e.code === 'unknown_capability');
});

test('avatar_emotions is OFF by default and its summary starts with "Limited Availability."', () => {
  assert.equal(CAPABILITY_DEFAULTS.avatar_emotions, 'off');
  assert.equal(CAPABILITY_INFO.avatar_emotions.defaultState, 'off');
  assert.equal(CAPABILITY_INFO.avatar_emotions.kind, 'segment');
  assert.ok(CAPABILITY_INFO.avatar_emotions.summary.startsWith('Limited Availability.'));
  assert.equal(resolveCapabilities({}).capabilities.avatar_emotions.state, 'off');
  assert.equal(resolveCapabilities({ request: { avatar_emotions: 'on' } }).capabilities.avatar_emotions.state, 'on');
});

test('avatar_emotions without avatar is not rejected by the SDK (the server decides)', () => {
  assert.deepEqual(validateCapabilities({ avatar_emotions: 'on' }), { avatar_emotions: 'on' });
});

test('the SDK never sends avatar_emotions unless the caller sets it', async () => {
  const ff = fakeFetch([{ match: 'assistant/converse', respond: () => ({ status: 200, headers: { 'content-type': 'application/x-ndjson' }, body: '{"type":"text","content":"hi","isFinal":true}\n' }) }]);
  const mgmt = new Management({ partnerId: '123', fetch: ff });
  const ks = { ks: 'djJ8conv', kind: 'conversation' };
  await collectConverse(mgmt.conversations.stream({ userMessage: 'hi', capabilities: { avatar: 'on' } }, ks));
  assert.deepEqual(ff.calls.at(-1).body.capabilities, { avatar: 'on' });
  await collectConverse(mgmt.conversations.stream({ userMessage: 'hi' }, ks));
  assert.equal(JSON.stringify(ff.calls.at(-1).body).includes('avatar_emotions'), false);
});

// ── stream pass-through ─────────────────────────────────────────────────────

const line = (o) => `${JSON.stringify(o)}\n`;

test('metadata.emotion on an avatar segmentStart chunk passes through unchanged', async () => {
  const chunks = [
    { type: 'avatar', content: 'Oh no.', segmentStart: true, metadata: { emotion: 'sad' } },
    { type: 'avatar', content: ' That is hard.', segmentEnd: true },
    { type: 'avatar', content: 'But cheer up!', segmentStart: true, metadata: { emotion: 'happy' } },
    { type: 'avatar', content: ' Really.', segmentEnd: true, isFinal: true },
  ];
  const segs = [];
  for await (const s of parseConverseStream(streamFrom(chunks.map(line).join('')))) segs.push(s);
  assert.deepEqual(segs, chunks);
  assert.deepEqual(segs.filter((s) => s.metadata?.emotion).map((s) => s.metadata.emotion), ['sad', 'happy']);
});

test('an avatar chunk without metadata passes through with no metadata key', async () => {
  const chunk = { type: 'avatar', content: 'Hello.', segmentStart: true, segmentEnd: true, isFinal: true };
  const segs = [];
  for await (const s of parseConverseStream(streamFrom(line(chunk)))) segs.push(s);
  assert.deepEqual(segs, [chunk]);
  assert.equal('metadata' in segs[0], false);
});

test('an unknown emotion label passes through untouched (the SDK does not filter)', async () => {
  const chunk = { type: 'avatar', content: 'Hm.', segmentStart: true, metadata: { emotion: 'confused', other: 1 } };
  const segs = [];
  for await (const s of parseConverseStream(streamFrom(line(chunk)))) segs.push(s);
  assert.deepEqual(segs, [chunk]);
});

// ── avatars.create / avatars.update `emotions` ──────────────────────────────

function avatarsHarness() {
  const ff = fakeFetch([
    { match: 'avatar/create', respond: (req) => ({ status: 200, body: { id: 'av1', ...req.body } }) },
    { match: 'avatar/update', respond: (req) => ({ status: 200, body: req.body }) },
  ]);
  return { mgmt: new Management({ partnerId: '123', fetch: ff }), ff };
}
const BASE = { name: 'sdk-live-test', voice: { id: 'v1' }, visual: { id: 'vis1' } };

test('avatars.create and update forward a valid emotions object unchanged', async () => {
  const { mgmt, ff } = avatarsHarness();
  const emotions = { enabled: true, intensity: 0.5, allowed: ['happy', 'sad'] };
  await mgmt.avatars.create({ ...BASE, emotions }, ADMIN_KS);
  assert.deepEqual(ff.calls[0].body.emotions, emotions);
  await mgmt.avatars.update({ id: 'av1', emotions: { intensity: 1 } }, ADMIN_KS);
  assert.deepEqual(ff.calls[1].body.emotions, { intensity: 1 });
});

test('emotions accepts each key alone, the 0 and 1 bounds, and an empty allowed list', async () => {
  const { mgmt, ff } = avatarsHarness();
  for (const emotions of [{}, { enabled: false }, { intensity: 0 }, { intensity: 1 }, { allowed: [] }, { allowed: ['x'] }]) {
    await mgmt.avatars.update({ id: 'av1', emotions }, ADMIN_KS);
    assert.deepEqual(ff.calls.at(-1).body.emotions, emotions);
  }
});

test('omitting emotions sends no emotions key', async () => {
  const { mgmt, ff } = avatarsHarness();
  await mgmt.avatars.create(BASE, ADMIN_KS);
  await mgmt.avatars.update({ id: 'av1', name: 'x' }, ADMIN_KS);
  for (const c of ff.calls) assert.equal('emotions' in c.body, false);
});

const BAD = [
  ['null', null],
  ['an array', []],
  ['a string', 'happy'],
  ['a number', 1],
  ['enabled as a string', { enabled: 'true' }],
  ['enabled as null', { enabled: null }],
  ['intensity below 0', { intensity: -0.1 }],
  ['intensity above 1', { intensity: 1.1 }],
  ['intensity NaN', { intensity: NaN }],
  ['intensity Infinity', { intensity: Infinity }],
  ['intensity as a string', { intensity: '0.5' }],
  ['intensity null', { intensity: null }],
  ['allowed null', { allowed: null }],
  ['allowed a string', { allowed: 'happy' }],
  ['allowed with a duplicate', { allowed: ['happy', 'happy'] }],
  ['allowed with an empty string', { allowed: [''] }],
  ['allowed with a non-string', { allowed: ['happy', 3] }],
  ['allowed with a hole', { allowed: [, 'a'] }], // eslint-disable-line no-sparse-arrays
  ['allowed that is only holes', { allowed: new Array(2) }],
  ['an unknown key', { enabled: true, mood: 'happy' }],
];

for (const [label, emotions] of BAD) {
  test(`emotions ${label} is refused before the network (create and update)`, async () => {
    const { mgmt, ff } = avatarsHarness();
    await assert.rejects(() => mgmt.avatars.create({ ...BASE, emotions }, ADMIN_KS), (e) => e.code === 'bad_request' && /emotions/.test(e.detail));
    await assert.rejects(() => mgmt.avatars.update({ id: 'av1', emotions }, ADMIN_KS), (e) => e.code === 'bad_request' && /emotions/.test(e.detail));
    assert.equal(ff.calls.length, 0);
  });
}

// ── unaffected by default ───────────────────────────────────────────────────
// The name is in the public CAPABILITIES list. No SDK path may put it on the wire unless the caller asks.

const LA = 'avatar_emotions';
const sent = (ff) => JSON.stringify(ff.calls.map((c) => c.body));

test('resolveCapabilities lists avatar_emotions locally and sends nothing', () => {
  const r = resolveCapabilities({});
  assert.ok(LA in r.capabilities);
  assert.equal(r.capabilities[LA].state, 'off');
});

test('intellect capability writes (read-merge-write) never add avatar_emotions on their own', async () => {
  const dto = { id: 1481, type: 'internal', status: 2, capabilities: { avatar: 'on' } };
  const ff = fakeFetch([
    { match: '/v1/intellect/get', respond: () => ({ status: 200, body: dto }) },
    { match: '/v1/intellect/update', respond: (req) => ({ status: 200, body: req.body }) },
  ]);
  const mgmt = new Management({ partnerId: '123', adminSecret: 'a'.repeat(32), fetch: ff });
  await mgmt.intellects.setCapability(1481, 'use_web_search', 'on', ADMIN_KS);
  await mgmt.intellects.setCapabilities(1481, { use_web_search: 'off' }, ADMIN_KS);
  const update = ff.calls.filter((c) => c.url.includes('/v1/intellect/update')).at(-1).body;
  assert.equal(LA in update.capabilities, false);
  assert.equal(sent(ff).includes(LA), false);
  // The caller can still opt in.
  await mgmt.intellects.setCapability(1481, LA, 'on', ADMIN_KS);
  assert.equal(ff.calls.filter((c) => c.url.includes('/v1/intellect/update')).at(-1).body.capabilities[LA], 'on');
});

// ── wording rules ───────────────────────────────────────────────────────────

// Built from fragments so this file does not trip its own scan.
const FORBIDDEN = new RegExp(['nv' + 'q2', '\\b' + 'q' + 'a\\b', 'pre-' + 'release', '\\b' + 'be' + 'ta\\b', 'up' + 'coming', 'coming ' + 'soon'].join('|'), 'i');
const SHIPPED = [
  'src/management/capabilities.js',
  'src/management/avatars.js',
  'src/core/stream.js',
  'test/unit/limited-availability.test.js',
  'docs/contributor/limited-availability.md',
  'scripts/live-verify-emotions.mjs',
  'scripts/live-eval-emotions.mjs',
  'scripts/lib/emotion-eval/stats.mjs',
  'scripts/lib/emotion-eval/scenarios.mjs',
  'scripts/lib/emotion-eval/analyze.mjs',
  'scripts/lib/emotion-eval/parser-checks.mjs',
  'scripts/lib/emotion-eval/report.mjs',
  'scripts/lib/emotion-eval/runner.mjs',
  'docs/contributor/emotions-eval.md',
  'test/unit/emotion-eval-stats.test.js',
  'test/unit/emotion-eval-analyze.test.js',
  'test/unit/emotion-eval-report.test.js',
  'test/unit/emotion-eval-runner.test.js',
  'test/unit/emotion-eval-cli.test.js',
  'test/fakes/emotion-results.js',
];

test('files that carry the Limited Availability feature use none of the banned release words, in comments or code', () => {
  const hits = [];
  for (const f of SHIPPED) {
    for (const [i, ln] of repoFile(f).split('\n').entries()) {
      if (FORBIDDEN.test(ln)) hits.push(`${f}:${i + 1}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('the avatar_emotions name appears in no public doc', () => {
  const PUBLIC = ['README.md', 'API-REFERENCE.md', 'GETTING-STARTED.md', 'docs/api/build/intellect.md', 'docs/api/operate.md', 'docs/api/build/avatar-and-agent.md', 'docs/api/management-operations.md'];
  for (const f of PUBLIC) assert.equal(repoFile(f).includes('avatar_emotions'), false, f);
});
