// `region` and REGIONS: base-URL resolution for Management and the Experience
// sessions. Precedence is explicit `*Url` > REGIONS[region] > nvp1. The residency
// tests prove a frp2 instance sends nothing to a host outside its REGIONS entry,
// including the OVP session mint (the admin secret's destination).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch } from '../fakes/fetch.js';
import { Management, REGIONS } from '../../src/management/index.js';
import { KalturaChatSession, KalturaAgentSession, KalturaAvatarSession, REGIONS as EXPERIENCE_REGIONS } from '../../src/experience/index.js';

const ADMIN_KS = 'djJ8' + 'A'.repeat(40);
const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const KEYS = ['agenticUrl', 'genieUrl', 'ovpUrl', 'messagingUrl'];
const host = (url) => new URL(url).host;

/** A fetch that answers every request, so any namespace call completes. */
const anyFetch = () => fakeFetch([
  { match: '/service/session/action/start', respond: () => ({ body: ADMIN_KS }) },
  { match: /./, respond: () => ({ body: {} }) },
]);

// 1, 2: regression lock on today's defaults.
test('no region and no overrides resolve to the four nvp1 URLs; region nvp1 is identical', () => {
  const expected = {
    agenticUrl: 'https://api.avatar.us.kaltura.ai/v1',
    genieUrl: 'https://genie.nvp1.ovp.kaltura.com',
    ovpUrl: 'https://www.kaltura.com/api_v3',
    messagingUrl: 'https://messaging.nvp1.ovp.kaltura.com/api/v1',
  };
  assert.deepEqual({ ...new Management({ partnerId: 1 }).endpoints }, expected);
  assert.deepEqual({ ...new Management({ partnerId: 1, region: 'nvp1' }).endpoints }, expected);
  assert.deepEqual({ ...REGIONS.nvp1 }, expected);
});

// 3: residency.
test('region frp2: every request host lies inside REGIONS.frp2', async () => {
  const ff = anyFetch();
  const mgmt = new Management({ partnerId: 1, adminSecret: 'secret', region: 'frp2', fetch: ff });
  await mgmt.sessions.createAdminToken({ userId: 'admin@example.com' });
  await mgmt.agents.get('agent-1', ADMIN_KS);
  await mgmt.catalog.get('item-1', ADMIN_KS);
  await mgmt.threads.get('thread-1', ADMIN_KS);
  await mgmt._ctx.ovp('baseentry', 'list', {}, ADMIN_KS);
  await mgmt._ctx.ovpMulti([{ service: 'system', action: 'ping' }], ADMIN_KS);
  await mgmt._ctx.ovpUpload('token-1', new FormData(), ADMIN_KS);
  await mgmt._ctx.genieStream('assistant/converse', {}, ADMIN_KS);
  const allowed = new Set(KEYS.map((k) => REGIONS.frp2[k]).filter(Boolean).map(host));
  assert.ok(ff.calls.length >= 8);
  for (const call of ff.calls) assert.ok(allowed.has(host(call.url)), `request left the region: ${host(call.url)}`);
});

// 4: the admin secret goes to the region's OVP host.
test('region frp2: Sessions mints on the frp2 OVP host', async () => {
  const ff = anyFetch();
  const mgmt = new Management({ partnerId: 1, adminSecret: 'secret', region: 'frp2', fetch: ff });
  await mgmt.sessions.createAdminToken({ userId: 'admin@example.com' });
  assert.equal(ff.calls.length, 1);
  assert.equal(ff.calls[0].url, `${REGIONS.frp2.ovpUrl}/service/session/action/start`);
});

// 5: precedence, one key at a time.
test('each explicit *Url overrides the region value, the rest stay on the region', () => {
  for (const key of KEYS) {
    const mgmt = new Management({ partnerId: 1, region: 'frp2', [key]: 'https://override.example.com/x' });
    for (const k of KEYS) assert.equal(mgmt.endpoints[k], k === key ? 'https://override.example.com/x' : REGIONS.frp2[k], `${key} → ${k}`);
  }
});

test('an ovpUrl override also moves the Sessions mint', async () => {
  const ff = anyFetch();
  const mgmt = new Management({ partnerId: 1, adminSecret: 'secret', region: 'frp2', ovpUrl: 'https://ovp.example.com/api_v3/', fetch: ff });
  await mgmt.sessions.createAdminToken({ userId: 'admin@example.com' });
  assert.equal(ff.calls[0].url, 'https://ovp.example.com/api_v3/service/session/action/start');
});

// 6: unknown regions fail loudly, never fall back to US.
test('an unknown or mistyped region throws bad_request listing the codes, with zero fetches', () => {
  const ff = anyFetch();
  for (const region of ['eu', 'FRP2', 'sgp2', '', 42, 'constructor', 'toString']) {
    assert.throws(
      () => new Management({ partnerId: 1, region: /** @type {any} */ (region), fetch: ff }),
      (e) => e.code === 'bad_request' && /Supported: nvp1 \(US\), frp2 \(EU\)/.test(e.detail) && /agenticUrl, genieUrl, ovpUrl and messagingUrl/.test(e.detail),
      String(region),
    );
  }
  assert.equal(ff.calls.length, 0);
});

// 7: a service the region does not run is a typed error, not a US fallback.
test('region without messaging: emailTemplates throws region_unavailable before any fetch; an override fixes it', async () => {
  assert.equal(REGIONS.frp2.messagingUrl, null);
  const ff = anyFetch();
  const mgmt = new Management({ partnerId: 1, region: 'frp2', fetch: ff });
  assert.equal(mgmt.endpoints.messagingUrl, null);
  const unavailable = (e) => e.code === 'region_unavailable' && /messagingUrl/.test(e.detail) && /frp2/.test(e.detail);
  await assert.rejects(async () => { await mgmt.emailTemplates.list(ADMIN_KS); }, unavailable);
  await assert.rejects(() => mgmt.emailTemplates.get('t-1', ADMIN_KS), unavailable);
  assert.equal(ff.calls.length, 0);

  const ok = new Management({ partnerId: 1, region: 'frp2', messagingUrl: 'https://messaging.example.com/api/v1', fetch: ff });
  await ok.emailTemplates.get('t-1', ADMIN_KS);
  assert.equal(ff.calls.length, 1);
  assert.equal(ff.calls[0].url, 'https://messaging.example.com/api/v1/email-template/get');
});

// 8: HTTPS on every base URL, same rule and code as the Experience transports.
test('http to a public host throws insecure_transport; localhost warns once; allowInsecureTransport passes', () => {
  for (const key of KEYS) {
    assert.throws(() => new Management({ partnerId: 1, [key]: 'http://example.com/x' }), (e) => e.code === 'insecure_transport' && e.detail.startsWith(`${key} `), key);
  }
  const warns = [];
  const local = new Management({ partnerId: 1, agenticUrl: 'http://localhost:8080/v1', logger: (level, m) => warns.push([level, m]) });
  assert.equal(local.endpoints.agenticUrl, 'http://localhost:8080/v1');
  assert.equal(warns.length, 1);
  assert.equal(warns[0][0], 'warn');
  assert.match(warns[0][1], /agenticUrl uses an insecure/);

  const allowed = [];
  const dev = new Management({ partnerId: 1, ovpUrl: 'http://example.com/api_v3', allowInsecureTransport: true, logger: (level, m) => allowed.push(m) });
  assert.equal(dev.endpoints.ovpUrl, 'http://example.com/api_v3');
  assert.equal(allowed.length, 1);

  assert.throws(() => new KalturaChatSession({ token: CONV_KS, genieUrl: 'http://example.com' }), (e) => e.code === 'insecure_transport');
});

// 9: credentials and unparseable strings fail at construction, not at fetch time.
test('a URL with credentials or one that does not parse throws bad_request', () => {
  for (const key of KEYS) {
    assert.throws(() => new Management({ partnerId: 1, [key]: 'https://user:pass@example.com/x' }), (e) => e.code === 'bad_request' && /credentials/.test(e.detail) && !/pass@/.test(e.detail), key);
    assert.throws(() => new Management({ partnerId: 1, [key]: 'not a url' }), (e) => e.code === 'bad_request' && /not a valid URL/.test(e.detail), key);
  }
  assert.throws(() => new KalturaChatSession({ token: CONV_KS, genieUrl: 'https://u@example.com' }), (e) => e.code === 'bad_request');
});

test('an empty or non-string URL, or a scheme other than http(s), throws bad_request; null means omitted', () => {
  for (const key of KEYS) {
    assert.throws(() => new Management({ partnerId: 1, [key]: '' }), (e) => e.code === 'bad_request' && /non-empty URL string/.test(e.detail), key);
    assert.throws(() => new Management({ partnerId: 1, [key]: /** @type {any} */ (42) }), (e) => e.code === 'bad_request', key);
    for (const bad of ['ftp://example.com', 'file:///etc/hosts', 'wss://example.com']) {
      assert.throws(() => new Management({ partnerId: 1, [key]: bad }), (e) => e.code === 'bad_request' && /https URL/.test(e.detail), `${key} ${bad}`);
    }
    assert.equal(new Management({ partnerId: 1, [key]: /** @type {any} */ (null) }).endpoints[key], REGIONS.nvp1[key], key);
  }
  assert.throws(() => new KalturaChatSession({ token: CONV_KS, genieUrl: '' }), (e) => e.code === 'bad_request');
});

// 10: trailing slash.
test('one trailing slash is stripped from every resolved URL', () => {
  const mgmt = new Management({ partnerId: 1, agenticUrl: 'https://a.example.com/v1/', genieUrl: 'https://g.example.com/', ovpUrl: 'https://o.example.com/api_v3/', messagingUrl: 'https://m.example.com/api/v1/' });
  assert.deepEqual({ ...mgmt.endpoints }, { agenticUrl: 'https://a.example.com/v1', genieUrl: 'https://g.example.com', ovpUrl: 'https://o.example.com/api_v3', messagingUrl: 'https://m.example.com/api/v1' });
});

// 11: frozen.
test('REGIONS, each entry, and mgmt.endpoints are frozen; both entry points export the same table', () => {
  assert.ok(Object.isFrozen(REGIONS));
  for (const code of Object.keys(REGIONS)) assert.ok(Object.isFrozen(REGIONS[code]), code);
  assert.throws(() => { 'use strict'; REGIONS.nvp1.ovpUrl = 'https://evil.example.com'; }, TypeError);
  const mgmt = new Management({ partnerId: 1 });
  assert.ok(Object.isFrozen(mgmt.endpoints));
  assert.equal(EXPERIENCE_REGIONS, REGIONS);
});

// 12: per-instance (I-3).
test('two instances with different regions do not share endpoints', () => {
  const us = new Management({ partnerId: 1 });
  const eu = new Management({ partnerId: 1, region: 'frp2' });
  assert.equal(us.endpoints.ovpUrl, REGIONS.nvp1.ovpUrl);
  assert.equal(eu.endpoints.ovpUrl, REGIONS.frp2.ovpUrl);
  assert.notEqual(us.endpoints, eu.endpoints);
});

// 13: Experience.
test('KalturaChatSession region frp2 sends converse to the frp2 genie; genieUrl still wins', async () => {
  const reply = JSON.stringify({ type: 'text', content: 'hi', threadId: 't-1', messageId: 'm-1' }) + '\n';
  const ff = fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: reply }) }]);
  const chat = new KalturaChatSession({ token: CONV_KS, region: 'frp2', fetch: ff });
  await chat.connect();
  await chat.sendText('hello');
  assert.ok(ff.calls.length >= 1);
  for (const call of ff.calls) assert.equal(host(call.url), host(REGIONS.frp2.genieUrl));

  const ff2 = fakeFetch([{ match: '/assistant/converse', respond: () => ({ body: reply }) }]);
  const pinned = new KalturaChatSession({ token: CONV_KS, region: 'frp2', genieUrl: 'https://genie.example.com', fetch: ff2 });
  await pinned.connect();
  await pinned.sendText('hello');
  assert.equal(host(ff2.calls[0].url), 'genie.example.com');
});

test('Experience sessions reject an unknown region with bad_request', () => {
  assert.throws(() => new KalturaChatSession({ token: CONV_KS, region: /** @type {any} */ ('eu') }), (e) => e.code === 'bad_request');
  assert.throws(() => new KalturaAvatarSession({ token: CONV_KS, socketFactory: () => ({}), region: /** @type {any} */ ('eu') }), (e) => e.code === 'bad_request');
});

test('KalturaAgentSession forwards region to both transports', async () => {
  const made = [];
  const fake = (cfg) => { const t = { cfg, state: 'idle', on() {}, off() {}, onToolCall: () => () => {}, onOAuthRequired: () => () => {}, async connect() { this.state = 'connected'; }, disconnect() { this.state = 'closed'; } }; made.push(t); return t; };
  const session = new KalturaAgentSession({ token: CONV_KS, mode: 'chat', region: 'frp2', transportFactories: { chat: fake, avatar: fake } });
  await session.connect();
  await session.switchMode('avatar');
  assert.equal(made.length, 2);
  for (const t of made) assert.equal(t.cfg.region, 'frp2');
});
