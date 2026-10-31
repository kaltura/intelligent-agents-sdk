import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServerTurn, iceServersFor, iceConfig, turnServers, withoutTurnQuery, turnUrlKeys } from '../../src/experience/wire.js';

/** Server-sent TURN credentials: read whatever shape arrives, and pick the ICE servers for a peer. */

const NOW = 1_800_000_000_000;
const STD = (h) => [`turn:${h}:80?transport=udp`, `turn:${h}:443?transport=udp`, `turn:${h}:80?transport=tcp`, `turns:${h}:443?transport=tcp`];
const creds = { username: 'srv-user', credential: 'srv-cred' };
const norm = (raw) => normalizeServerTurn(raw, NOW);

// ── normalizeServerTurn: URL forms ──

const urlCases = [
  ['bare host', { url: 'relay.example' }, STD('relay.example')],
  ['host with scheme and trailing slash', { url: 'turn:relay.example/' }, STD('relay.example')],
  ['turns: host with no port', { url: 'TURNS:relay.example' }, STD('relay.example')],
  ['IPv6 host with scheme and no port', { url: 'turn:[2001:db8::1]' }, STD('[2001:db8::1]')],
  ['IPv6 URL with a port', { url: 'turn:[2001:db8::1]:3478?transport=udp' }, ['turn:[2001:db8::1]:3478?transport=udp']],
  ['host:port', { url: 'relay.example:3478' }, ['turn:relay.example:3478?transport=udp', 'turn:relay.example:3478?transport=tcp']],
  ['full URLs kept as is', { urls: ['turn:a.example:3478?transport=udp', 'turns:a.example:5349?transport=tcp'] }, ['turn:a.example:3478?transport=udp', 'turns:a.example:5349?transport=tcp']],
  ['uri field', { uri: 'turns:a.example:443?transport=tcp' }, ['turns:a.example:443?transport=tcp']],
  ['comma list', { url: 'turn:a.example:80?transport=udp, turn:b.example:80?transport=udp' }, ['turn:a.example:80?transport=udp', 'turn:b.example:80?transport=udp']],
  ['space list', { url: 'turn:a.example:80 turn:b.example:80' }, ['turn:a.example:80', 'turn:b.example:80']],
  ['IPv4 address', { url: '203.0.113.7' }, STD('203.0.113.7')],
  ['IPv6 with port', { url: '[2001:db8::1]:3478' }, ['turn:[2001:db8::1]:3478?transport=udp', 'turn:[2001:db8::1]:3478?transport=tcp']],
  ['bad items dropped one by one', { urls: ['stun:a.example:3478', 'turn:bad_host', 'single-label', 'relay.example:99999', 'turn:bad.example:99999?transport=udp', 'turns:[2001:db8::1]:0', 'http://x', 42, 'turn:ok.example:443?transport=udp'] }, ['turn:ok.example:443?transport=udp']],
  ['duplicates removed', { urls: ['turn:a.example:80', 'turn:a.example:80'] }, ['turn:a.example:80']],
  ['more than 8 cut to 8', { urls: Array.from({ length: 12 }, (_, i) => `turn:h${i}.example:80`) }, Array.from({ length: 8 }, (_, i) => `turn:h${i}.example:80`)],
  ['empty url: no host yet', { url: '' }, []],
  ['no url field: no host yet', {}, []],
];
for (const [name, extra, urls] of urlCases) {
  test(`normalizeServerTurn URL form: ${name}`, () => {
    const r = norm({ ...creds, ...extra });
    assert.ok(r.entry, r.reason);
    assert.deepEqual(r.entry.urls, urls);
    assert.equal(r.reason, urls.length ? 'ok' : 'no_host');
  });
}

for (const [name, extra] of [['an empty `urls` list', { urls: [] }], ['an empty `urls` string', { urls: '' }], ['a blank `urls` string', { urls: '  ' }]]) {
  test(`normalizeServerTurn: ${name} falls through to \`url\``, () => {
    assert.deepEqual(norm({ ...creds, ...extra, url: 'relay.example' }).entry?.urls, STD('relay.example'));
  });
}

test('normalizeServerTurn: an upper-case scheme is written in lower case', () => {
  assert.deepEqual(norm({ ...creds, url: 'TURN:a.example:80' }).entry?.urls, ['turn:a.example:80']);
});

for (const url of ['turn:a.example:80?transport=tls', 'turn:a.example:80?foo=bar', 'turn:a.example:80?transport=udp&x=1', 'turn:bad_host.example:80', 'turn:a.example:80/path', 'turn::80', 'turn:', 'turn:a.example:0', 'turn:a.example:65536']) {
  test(`normalizeServerTurn: \`${url}\` is dropped`, () => {
    assert.equal(norm({ ...creds, urls: [url, 'turn:ok.example:80'] }).entry?.urls.join(), 'turn:ok.example:80');
  });
}

test('normalizeServerTurn: host:port with port 0 is dropped', () => {
  assert.equal(norm({ ...creds, url: 'relay.example:0' }).reason, 'no_usable_url');
});

test('normalizeServerTurn: an empty credential gives no entry', () => {
  assert.equal(norm({ url: 'h.example', username: 'u', credential: '' }).reason, 'no_credentials');
});

test('expiry: a username prefix equal to the receipt time is not used', () => {
  assert.equal(norm({ url: 'h.example', username: `${NOW / 1000}:s`, credential: 'c' }).expiresAt, null);
});

for (const port of [1, 65535]) {
  test(`normalizeServerTurn: port ${port} is kept`, () => {
    assert.deepEqual(norm({ ...creds, urls: [`turn:a.example:${port}`] }).entry?.urls, [`turn:a.example:${port}`]);
  });
}

test('normalizeServerTurn: 8 URLs kept, the 9th cut', () => {
  const urls = Array.from({ length: 9 }, (_, i) => `turn:h${i}.example:80`);
  assert.deepEqual(norm({ ...creds, urls: urls.slice(0, 8) }).entry?.urls, urls.slice(0, 8));
  assert.deepEqual(norm({ ...creds, urls }).entry?.urls, urls.slice(0, 8));
});

for (const [ttl, ttlSec] of [[59, null], [60, 60], [30 * 86400, 30 * 86400], [30 * 86400 + 1, null]]) {
  test(`expiry: ttl ${ttl} s is ${ttlSec ? 'used' : 'ignored'}`, () => {
    assert.equal(norm({ ...creds, url: 'h.example', ttl }).ttlSec, ttlSec);
  });
}

test('normalizeServerTurn: every URL unusable rejects the entry', () => {
  assert.deepEqual(norm({ ...creds, urls: ['stun:a.example', 'not a url'] }), { entry: null, expiresAt: null, ttlSec: null, reason: 'no_usable_url' });
});

// ── normalizeServerTurn: shapes and credentials ──

test('normalizeServerTurn: `password` is read as the credential, extra fields ignored', () => {
  const r = norm({ url: 'relay.example', username: 'u', password: 'p', region: 'x', ttl: 600, nested: { a: 1 } });
  assert.deepEqual(r.entry, { urls: STD('relay.example'), username: 'u', credential: 'p' });
});

test('normalizeServerTurn: a JSON string is parsed', () => {
  assert.equal(norm(JSON.stringify({ ...creds, url: 'relay.example' })).entry?.username, 'srv-user');
});

for (const [name, raw, reason] of [
  ['null', null, 'not_object'], ['a number', 5, 'not_object'], ['an array', [creds], 'not_object'],
  ['a string that is not JSON', 'relay.example', 'not_object'], ['an empty object', {}, 'no_credentials'],
  ['no credential', { url: 'h.example', username: 'u' }, 'no_credentials'], ['an empty username', { url: 'h.example', username: '', credential: 'c' }, 'no_credentials'],
  ['a number credential', { url: 'h.example', username: 'u', credential: 12345 }, 'no_credentials'],
]) {
  test(`normalizeServerTurn: ${name} gives no entry (${reason})`, () => {
    const r = norm(raw);
    assert.equal(r.entry, null);
    assert.equal(r.reason, reason);
  });
}

// ── normalizeServerTurn: expiry ──

test('expiry: a valid ttl counts from receipt on the client clock', () => {
  const r = norm({ ...creds, url: 'h.example', ttl: 86400 });
  assert.equal(r.expiresAt, NOW + 86400 * 1000);
  assert.equal(r.ttlSec, 86400);
});

test('expiry: a numeric-string ttl is converted', () => {
  assert.equal(norm({ ...creds, url: 'h.example', ttl: '600' }).expiresAt, NOW + 600_000);
});

const prefixAt = Math.floor(NOW / 1000) + 3600;
for (const [name, ttl] of [['ms', 86_400_000], ['0', 0], ['negative', -5], ['under 60 s', 30], ['not a number', 'soon'], ['missing', undefined]]) {
  test(`expiry: ttl ${name} is ignored, the username prefix is used instead`, () => {
    const r = norm({ url: 'h.example', username: `${prefixAt}:sock-1`, credential: 'c', ttl });
    assert.equal(r.expiresAt, prefixAt * 1000);
    assert.equal(r.ttlSec, 3600);
    assert.ok(r.entry, 'the credentials are still used');
  });
}

for (const [name, username] of [
  ['no prefix', 'sock-1'], ['other order', `sock-1:${prefixAt}`], ['in the past', `${Math.floor(NOW / 1000) - 10}:s`],
  ['more than 30 days ahead', `${Math.floor(NOW / 1000) + 31 * 86400}:s`], ['in ms', `${prefixAt * 1000}:s`],
]) {
  test(`expiry: unknown when the username has ${name} and ttl is unusable`, () => {
    const r = norm({ url: 'h.example', username, credential: 'c' });
    assert.equal(r.expiresAt, null);
    assert.equal(r.ttlSec, null);
    assert.ok(r.entry);
  });
}

// ── iceServersFor ──

const builtin = turnServers('-');
const server = { urls: STD('relay.example'), username: 'srv-user', credential: 'srv-cred' };
const without = (urls, drop) => urls.filter((u) => u !== drop);
// Shared UDP addresses go to one entry each: the server entry keeps UDP 443, the default entry keeps UDP 80.
const serverSplit = (e, h = 'relay.example') => ({ ...e, urls: without(e.urls, `turn:${h}:80?transport=udp`) });
const fallbackSplit = (e, h = 'relay.example') => ({ ...e, urls: without(e.urls, `turn:${h}:443?transport=udp`) });

test('iceServersFor: no server entry → the configured entry alone (as before)', () => {
  assert.deepEqual(iceServersFor({ turnServerUrl: 'relay.example' }), [turnServers('relay.example')]);
});

test('iceServersFor: server entry first, the default entry after it', () => {
  const list = iceServersFor({ server, turnServerUrl: 'relay.example' });
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], serverSplit(server));
  assert.deepEqual(list[1], fallbackSplit(turnServers('relay.example')));
  assert.ok(list.flatMap((s) => s.urls).length <= 12);
});

test('iceServersFor: a server entry with no host uses turnServerUrl', () => {
  const list = iceServersFor({ server: { ...server, urls: [] }, turnServerUrl: 'relay.example' });
  assert.deepEqual(list[0], serverSplit({ ...server, urls: STD('relay.example') }));
  assert.equal(list[1].username, builtin.username);
});

test('iceServersFor: a server entry with no host and no turnServerUrl is dropped', () => {
  assert.deepEqual(iceServersFor({ server: { ...server, urls: [] } }), []);
});

test('iceServersFor: server creds never go to a caller host (own creds, no server host)', () => {
  const own = { username: 'own', credential: 'own-c' };
  assert.deepEqual(iceServersFor({ server: { ...server, urls: [] }, turnServerUrl: 'own.example', turnCredentials: own }), [turnServers('own.example', own)]);
});

for (const own of [{ username: 'own' }, { credential: 'own-c' }]) {
  test(`iceServersFor: a partial override (${Object.keys(own)[0]} only) still counts as the caller's credentials`, () => {
    const mine = [turnServers('own.example', own)];
    assert.deepEqual(iceServersFor({ server: { ...server, urls: [] }, turnServerUrl: 'own.example', turnCredentials: own }), mine);
    assert.deepEqual(iceServersFor({ server, turnServerUrl: 'own.example', turnCredentials: own }), mine);
  });
}

test('iceServersFor: caller creds for another host are used alone (H2)', () => {
  const own = { username: 'own', credential: 'own-c' };
  assert.deepEqual(iceServersFor({ server, turnServerUrl: 'own.example', turnCredentials: own }), [turnServers('own.example', own)]);
});

test('iceServersFor: caller creds for the server host follow the server entry (H3)', () => {
  const own = { username: 'own', credential: 'own-c' };
  assert.deepEqual(iceServersFor({ server, turnServerUrl: 'relay.example', turnCredentials: own }), [serverSplit(server), fallbackSplit(turnServers('relay.example', own))]);
});

test('iceServersFor: turnCredentials copied from the default pair count as the default (H1)', () => {
  const copied = { username: builtin.username, credential: builtin.credential };
  assert.deepEqual(iceServersFor({ server, turnServerUrl: 'other.example', turnCredentials: copied }), [server, turnServers('other.example')]);
});

test('iceServersFor: entries on different hosts keep all their URLs', () => {
  assert.deepEqual(iceServersFor({ server, turnServerUrl: 'other.example' }), [server, turnServers('other.example')]);
});

test('iceServersFor: one shared UDP address stays with the server entry only', () => {
  const s = { ...creds, urls: ['turn:relay.example:443?transport=udp', 'turn:b.example:3478'] };
  const [first, second] = iceServersFor({ server: s, turnServerUrl: 'relay.example' });
  assert.deepEqual(first, s);
  assert.deepEqual(second.urls, without(STD('relay.example'), 'turn:relay.example:443?transport=udp'));
});

test('iceServersFor: TCP and TLS URLs stay in both entries', () => {
  const [first, second] = iceServersFor({ server, turnServerUrl: 'relay.example' });
  for (const u of STD('relay.example').slice(2)) assert.ok(first.urls.includes(u) && second.urls.includes(u), u);
});

test('iceServersFor: shared UDP match ignores host case and treats no transport as udp', () => {
  const s = { ...creds, urls: ['turn:RELAY.example:80'] };
  const [first, second] = iceServersFor({ server: s, turnServerUrl: 'relay.example' });
  assert.deepEqual(first, s);
  assert.deepEqual(second.urls, without(STD('relay.example'), 'turn:relay.example:80?transport=udp'));
});

test('iceServersFor: no port means 3478, which the default entry does not list', () => {
  const s = { ...creds, urls: ['turn:relay.example'] };
  assert.deepEqual(iceServersFor({ server: s, turnServerUrl: 'relay.example' }), [s, turnServers('relay.example')]);
});

test('iceServersFor: no UDP address is listed by both entries', () => {
  const cases = [
    { server, turnServerUrl: 'relay.example' },
    { server: { ...server, urls: [] }, turnServerUrl: 'relay.example' },
    { server: { ...creds, urls: ['turn:relay.example:80?transport=udp'] }, turnServerUrl: 'relay.example' },
  ];
  for (const c of cases) {
    const [a, b] = iceServersFor(c);
    const udp = (e) => e.urls.filter((u) => /^turn:[^?]*(\?transport=udp)?$/i.test(u)).map((u) => u.toLowerCase().replace(/\?transport=udp$/, ''));
    assert.ok(b, 'two entries');
    assert.deepEqual(udp(a).filter((u) => udp(b).includes(u)), []);
    assert.ok(a.urls.length && b.urls.length);
  }
});

test('iceServersFor: no turnServerUrl → the server entry alone (H4)', () => {
  assert.deepEqual(iceServersFor({ server }), [server]);
});

test('iceServersFor: nothing configured and nothing sent → empty', () => {
  assert.deepEqual(iceServersFor({}), []);
  assert.deepEqual(iceServersFor(), []);
});

test('iceServersFor: fallbackRefused → the server entry alone, with all its URLs', () => {
  assert.deepEqual(iceServersFor({ server, turnServerUrl: 'relay.example', fallbackRefused: true }), [server]);
  assert.deepEqual(iceServersFor({ turnServerUrl: 'relay.example', fallbackRefused: true }), [turnServers('relay.example')], 'no server entry: the configured one stays');
});

// ── turnUrlKeys: match an error URL as a browser reports it ──

for (const [url, reported, keys] of [
  ['turn:Relay.example', false, ['turn:relay.example:3478:udp']],
  ['TURN:relay.example:80?transport=udp', false, ['turn:relay.example:80:udp']],
  ['turn:a.example:80?transport=TCP', false, ['turn:a.example:80:tcp']],
  ['turns:relay.example', false, ['turns:relay.example:5349:tcp']],
  ['turns:relay.example', true, ['turns:relay.example:5349:tcp']],
  ['turn:relay.example:3478', true, ['turn:relay.example:3478:udp', 'turn:relay.example:3478:tcp']],
  ['turn:[2001:DB8::1]:3478?transport=udp', false, ['turn:2001:db8::1:3478:udp']],
  ['turn:[2001:db8::1]', false, ['turn:2001:db8::1:3478:udp']],
  ['turn:2001:db8::1:3478?transport=udp', true, ['turn:2001:db8::1:3478:udp']],
  ['stun:a.example', false, []], ['turn:', false, []], ['', true, []], [null, true, []],
]) {
  test(`turnUrlKeys(${JSON.stringify(url)}${reported ? ', reported' : ''})`, () => {
    assert.deepEqual(turnUrlKeys(url, reported), keys);
  });
}

test('iceServersFor: a server entry equal to the configured one is listed once', () => {
  const same = turnServers('relay.example');
  assert.deepEqual(iceServersFor({ server: { ...same, urls: [...same.urls].reverse() }, turnServerUrl: 'relay.example' }).length, 1);
});

for (const [name, change] of [['username', { username: 'other' }], ['credential', { credential: 'other' }], ['URL list', { urls: STD('relay.example').slice(0, 2) }]]) {
  test(`iceServersFor: a server entry like the configured one but for its ${name} is listed too`, () => {
    const same = turnServers('relay.example');
    assert.equal(iceServersFor({ server: { ...same, ...change }, turnServerUrl: 'relay.example' }).length, 2);
  });
}

test('iceServersFor: host names compare without case', () => {
  const own = { username: 'own', credential: 'own-c' };
  assert.equal(iceServersFor({ server, turnServerUrl: 'RELAY.example', turnCredentials: own }).length, 2, 'own creds for the server host follow the server entry');
});

// ── iceConfig + withoutTurnQuery ──

test('iceConfig takes a list as well as one entry', () => {
  const list = iceServersFor({ server, turnServerUrl: 'relay.example' });
  assert.equal(iceConfig('stv', list).iceServers, list);
  assert.deepEqual(iceConfig('asr', null).iceServers, []);
  assert.deepEqual(iceConfig('asr', turnServers('h')).iceServers, [turnServers('h')]);
});

test('withoutTurnQuery strips query strings and drops the duplicates it leaves', () => {
  const [s] = withoutTurnQuery([turnServers('h')]);
  assert.deepEqual(s.urls, ['turn:h:80', 'turn:h:443', 'turns:h:443']);
});

test('withoutTurnQuery keeps the UDP split: no TCP URL turns into a shared UDP one', () => {
  const [a, b] = withoutTurnQuery(iceServersFor({ server, turnServerUrl: 'relay.example' }));
  assert.deepEqual(a.urls, ['turn:relay.example:443', 'turns:relay.example:443']);
  assert.deepEqual(b.urls, ['turn:relay.example:80', 'turns:relay.example:443']);
});

test('withoutTurnQuery drops an entry left with no URL', () => {
  const tcpOnly = { ...creds, urls: ['turn:a.example:3478?transport=tcp'] };
  assert.deepEqual(withoutTurnQuery([tcpOnly, turnServers('h')]).map((s) => s.urls.length), [3]);
});

test('withoutTurnQuery drops a URL that only differed by its query', () => {
  assert.deepEqual(withoutTurnQuery([{ ...creds, urls: ['turn:a.example:80?transport=udp', 'turn:a.example:80'] }])[0].urls, ['turn:a.example:80']);
});
