import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KalturaAvatarSession, turnServers } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

/**
 * Per-session TURN credentials sent by the server. The session must work whatever the server
 * sends (nothing, the expected shape, another shape, garbage), use the server entry next to the
 * configured one, renew it before it expires, and never leak it.
 */

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('until: timed out'); await delay(5); } };
const isStv = (p) => p.transceivers.some((t) => t.kind === 'video' && t.direction === 'recvonly');
const stvPeer = () => FakeRTCPeerConnection.instances.filter(isStv).at(-1);
const asrPeer = () => FakeRTCPeerConnection.instances.filter((p) => !isStv(p)).at(-1);

const HOST = 'turn.example.com';
const FALLBACK = turnServers(HOST);
const SECRET_USER = '1900000000:sock-secret-user';
const SECRET_CRED = 'srv-cred-c2VjcmV0';
const serverTurn = (over = {}) => ({ url: 'relay.example.net', username: SECRET_USER, credential: SECRET_CRED, ttl: 86400, ...over });
const SERVER_URLS = turnServers('relay.example.net').urls;

/**
 * A connected session. `perSocket(n)` gives the extra `onServerConnected` fields for the n-th
 * socket (0-based), and `patch(socket, n)` may change a socket before use.
 */
async function connected({ perSocket = () => ({ turn: serverTurn() }), patch, cfg = {}, rtc = FakeRTCPeerConnection, connect = true } = {}) {
  FakeRTCPeerConnection.reset();
  const sockets = [];
  const queries = [];
  const logs = [];
  const socketFactory = (_url, opts) => {
    const s = new FakeSocket();
    queries.push(opts?.query);
    scriptHappyPath(s, { resumingOnRecreate: false, serverConnected: perSocket(sockets.length) });
    patch?.(s, sockets.length);
    sockets.push(s);
    return s;
  };
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: HOST,
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory, rtcConstructor: rtc,
    fetch: fakeWhepFetch(Array.from({ length: 10 }, () => ({}))), getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false,
    logger: (level, msg, data) => logs.push({ level, msg: String(msg), data }),
    timeouts: { healthTick: 600000, coldBackoff: 10 }, ...cfg,
  });
  const events = [];
  const realEmit = session.emit.bind(session);
  session.emit = (ev, p) => { events.push({ ev, p }); return realEmit(ev, p); };
  if (connect) await session.connect();
  return { session, sockets, queries, logs, events };
}

const serverEntry = (pc) => pc.config.iceServers.find((s) => s.credential === SECRET_CRED);

// ── harvest: where the credentials can arrive ──

test('turn in onServerConnected: both peers get the server entry first, then the configured one', async () => {
  const { session } = await connected();
  for (const pc of [asrPeer(), stvPeer()]) {
    assert.deepEqual(pc.config.iceServers, [{ urls: SERVER_URLS, username: SECRET_USER, credential: SECRET_CRED }, FALLBACK]);
    assert.equal(pc.config.bundlePolicy, 'max-bundle');
  }
  assert.equal(stvPeer().config.iceTransportPolicy, 'relay');
  assert.equal(asrPeer().config.iceTransportPolicy, 'all');
  session.disconnect();
});

test('no turn from the server: peers get the configured entry alone, as before', async () => {
  const { session } = await connected({ perSocket: () => ({}) });
  assert.deepEqual(stvPeer().config.iceServers, [FALLBACK]);
  assert.deepEqual(asrPeer().config.iceServers, [FALLBACK]);
  session.disconnect();
});

for (const [where, ev, wrap] of [
  ['clientConfiguration', 'clientConfiguration', (p) => ({ ...p, clientConfiguration: { ...p.clientConfiguration, turn: serverTurn() } })],
  ['an unwrapped clientConfiguration', 'clientConfiguration', (p) => ({ ...(p.clientConfiguration || p), turn: serverTurn() })],
  ['a nested object of an unwrapped clientConfiguration', 'clientConfiguration', (p) => ({ ...(p.clientConfiguration || p), ice: { turn: serverTurn() } })],
  ['joinComplete', 'joinComplete', (p) => ({ ...p, turn: serverTurn() })],
  ['stvNewSession', 'stvNewSession', (p) => ({ ...p, turn: serverTurn() })],
  ['a nested object of stvNewSession', 'stvNewSession', (p) => ({ ...p, ice: { turn: serverTurn() } })],
]) {
  test(`turn found in ${where} is used before the peers are built`, async () => {
    const patch = (s) => { const real = s.server.bind(s); s.server = (e, p) => real(e, e === ev ? wrap(p || {}) : p); };
    const { session } = await connected({ perSocket: () => ({}), patch });
    assert.ok(serverEntry(stvPeer()), 'STV peer has the server entry');
    assert.ok(serverEntry(asrPeer()), 'ASR peer has the server entry');
    const dump = JSON.stringify(session.clientConfig ?? null) + safeJson(session);
    for (const secret of [SECRET_USER, SECRET_CRED]) assert.ok(!dump.includes(secret), 'secret leaked through clientConfig');
    session.disconnect();
  });
}

test('a TURN event (turnCredentials) counts as credentials, and reaches peers already built', async () => {
  const { session, sockets } = await connected({ perSocket: () => ({}) });
  sockets[0].server('turnCredentials', serverTurn());
  for (const pc of [asrPeer(), stvPeer()]) {
    assert.ok(serverEntry(pc), 'applied with setConfiguration');
    assert.equal(pc.configHistory.length, 1);
    assert.equal(pc.config.bundlePolicy, 'max-bundle');
  }
  assert.equal(stvPeer().config.iceTransportPolicy, 'relay');
  session.disconnect();
});

for (const [ev, payload] of [
  ['onAgentAction', { content: { turn: serverTurn({ url: 'other.example.org' }) } }],
  ['onAgentAction', { turn: serverTurn({ url: 'other.example.org' }) }],
  ['onTurnText', serverTurn({ url: 'other.example.org' })],
  ['agentTurnToTalk', { data: { turn: serverTurn({ url: 'other.example.org' }) } }],
  ['turnCredentials', { data: { turn: serverTurn({ url: 'other.example.org' }) } }],
]) {
  test(`TURN data in a content event is never used (${ev}, ${JSON.stringify(Object.keys(payload))})`, async () => {
    const { session, sockets } = await connected({ perSocket: () => ({}) });
    sockets[0].server(ev, payload);
    assert.equal(session._serverTurn, null);
    assert.equal(stvPeer().configHistory, undefined);
    session.disconnect();
  });
}

test('agent turn events and turn-less payloads change nothing', async () => {
  const { session, sockets } = await connected({ perSocket: () => ({}) });
  sockets[0].server('agent_end_turn', { text: 'hello', turnId: 4 });
  sockets[0].server('stvFinishedTalking', { agentContent: 'turn left' });
  assert.equal(session._serverTurn, null);
  assert.equal(stvPeer().configHistory, undefined);
  session.disconnect();
});

for (const [name, turn] of [
  ['null', null], ['a string', 'garbage'], ['a number', 7], ['an array', [serverTurn()]], ['an empty object', {}],
  ['a number username', { url: 'relay.example.net', username: 1, credential: 'c' }], ['no credential', { url: 'relay.example.net', username: 'u' }],
  ['only stun URLs', { urls: ['stun:relay.example.net:3478'], username: 'u', credential: 'c' }],
  ['a prototype-pollution shape', JSON.parse('{"__proto__":{"username":"u","credential":"c"},"url":"relay.example.net"}')],
]) {
  test(`malformed turn (${name}): the session connects on the configured entry`, async () => {
    const { session } = await connected({ perSocket: () => ({ turn }) });
    assert.equal(session.state, 'connected');
    assert.deepEqual(stvPeer().config.iceServers, [FALLBACK]);
    session.disconnect();
  });
}

test('a payload that throws on read does not block the regular listeners', async () => {
  const patch = (s) => {
    const real = s.server.bind(s);
    s.server = (e, p) => real(e, e === 'onServerConnected' ? Object.defineProperty({ ...p }, 'turn', { get() { throw new Error('boom'); }, enumerable: true }) : p);
  };
  const { session } = await connected({ perSocket: () => ({}), patch });
  assert.equal(session.state, 'connected');
  assert.deepEqual(stvPeer().config.iceServers, [FALLBACK]);
  session.disconnect();
});

test('a socket without onAny: credentials are still read from the known events', async () => {
  const { session } = await connected({ patch: (s) => { s.onAny = undefined; } });
  assert.ok(serverEntry(stvPeer()));
  session.disconnect();
});

test('credentials from a socket that is no longer current are ignored', async () => {
  const { session } = await connected({ perSocket: () => ({}) });
  session._harvestTurn(new FakeSocket(), 'onServerConnected', { turn: serverTurn() });
  assert.equal(session._serverTurn, null);
  session.disconnect();
});

test('the same credentials again do not reconfigure the peers', async () => {
  const { session, sockets } = await connected({ perSocket: () => ({}) });
  sockets[0].server('turnCredentials', serverTurn());
  sockets[0].server('turnCredentials', serverTurn());
  assert.equal(stvPeer().configHistory.length, 1);
  sockets[0].server('turnCredentials', serverTurn({ credential: 'srv-cred-rotated' }));
  assert.equal(stvPeer().configHistory.length, 2);
  assert.equal(stvPeer().config.iceServers[0].credential, 'srv-cred-rotated');
  session.disconnect();
});

// ── the browser or the relay refuses the server entry ──

test('a browser that refuses the server entry: peers use the configured entry, one warning', async () => {
  class Picky extends FakeRTCPeerConnection {
    constructor(c) { if (c.iceServers.some((s) => s.credential === SECRET_CRED)) throw new TypeError('Invalid TURN server'); super(c); }
  }
  Picky.instances = FakeRTCPeerConnection.instances;
  const { session, logs } = await connected({ rtc: Picky });
  assert.equal(session.state, 'connected');
  assert.deepEqual(stvPeer().config.iceServers, [FALLBACK]);
  assert.deepEqual(asrPeer().config.iceServers, [FALLBACK]);
  assert.equal(logs.filter((l) => l.msg.startsWith('[turn] ')).length, 1);
  session.disconnect();
});

test('a browser that refuses the configured entry still fails as before', async () => {
  class Broken extends FakeRTCPeerConnection { constructor() { throw new TypeError('no WebRTC'); } }
  const { session } = await connected({ perSocket: () => ({}), rtc: Broken, connect: false });
  await assert.rejects(() => session.connect());
});

test('401 on a server-only URL sets the server entry aside for later peers', async () => {
  const { session } = await connected();
  stvPeer().fireCandidateError({ errorCode: 701, url: SERVER_URLS[0] });
  assert.equal(session._serverTurn.bad, false, 'a non-auth error is ignored');
  stvPeer().fireCandidateError({ errorCode: 401, url: SERVER_URLS[0] });
  assert.equal(session._serverTurn.bad, true);
  assert.deepEqual(session._iceServers(), [FALLBACK]);
  session.disconnect();
});

test('401 on a URL the configured entry also uses does not mark the server entry', async () => {
  const shared = FALLBACK.urls[2];
  const { session } = await connected({ perSocket: () => ({ turn: serverTurn({ url: undefined, urls: [shared, 'turn:relay2.example.net:3478?transport=udp'] }) }) });
  stvPeer().fireCandidateError({ errorCode: 401, url: shared });
  assert.equal(session._serverTurn.bad, false);
  stvPeer().fireCandidateError({ errorCode: 401, url: 'turn:relay2.example.net:3478?transport=udp' });
  assert.equal(session._serverTurn.bad, true);
  session.disconnect();
});

test('server entry on the configured host: each UDP address is in one entry, and a 401 on the server UDP URL sets it aside', async () => {
  const { session } = await connected({ perSocket: () => ({ turn: serverTurn({ url: HOST }) }) });
  const [srv, fb] = stvPeer().config.iceServers;
  assert.deepEqual(srv.urls, FALLBACK.urls.filter((u) => u !== FALLBACK.urls[0]));
  assert.deepEqual(fb.urls, FALLBACK.urls.filter((u) => u !== FALLBACK.urls[1]));
  stvPeer().fireCandidateError({ errorCode: 401, url: FALLBACK.urls[1] });
  assert.equal(session._serverTurn.bad, true);
  assert.deepEqual(session._iceServers(), [FALLBACK]);
  session.disconnect();
});

test('engine that rejects query strings: split kept, and a 401 on the stripped server URL sets it aside', async () => {
  class NoQuery extends FakeRTCPeerConnection {
    constructor(cfg) {
      if (cfg.iceServers.some((e) => e.urls.some((u) => u.includes('?')))) throw new TypeError('Invalid TURN URL query string');
      super(cfg);
    }
  }
  const { session } = await connected({ perSocket: () => ({ turn: serverTurn({ url: HOST }) }), rtc: NoQuery });
  const [srv, fb] = stvPeer().config.iceServers;
  assert.deepEqual(srv.urls, [`turn:${HOST}:443`, `turns:${HOST}:443`]);
  assert.deepEqual(fb.urls, [`turn:${HOST}:80`, `turns:${HOST}:443`]);
  stvPeer().fireCandidateError({ errorCode: 401, url: `turn:${HOST}:80` });
  assert.equal(session._serverTurn.bad, false, 'a 401 on a configured-only URL does not count');
  stvPeer().fireCandidateError({ errorCode: 401, url: `turn:${HOST}:443` });
  assert.equal(session._serverTurn.bad, true);
  session.disconnect();
});

test('a new socket with no turn keeps the last server entry', async () => {
  const { session, sockets } = await connected({ perSocket: (n) => (n === 0 ? { turn: serverTurn() } : {}) });
  await session._coldReconnect('test');
  assert.equal(sockets.length, 2);
  assert.equal(session.state, 'connected');
  assert.ok(serverEntry(stvPeer()), 'rebuilt peer still has the server entry');
  session.disconnect();
});

test('a new socket with new credentials replaces the old ones', async () => {
  const { session } = await connected({ perSocket: (n) => ({ turn: serverTurn({ credential: `cred-${n}` }) }) });
  await session._coldReconnect('test');
  assert.equal(stvPeer().config.iceServers[0].credential, 'cred-1');
  session.disconnect();
});

// ── renewal before expiry ──

function clock(start = 1_800_000_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test('resume() after a released pause past expiry rebuilds on a fresh socket with new credentials', async () => {
  const c = clock();
  const { session, sockets } = await connected({ cfg: { now: c.now }, perSocket: (n) => ({ turn: serverTurn({ ttl: 600, credential: `cred-${n}` }) }) });
  session.pause();
  sockets[0].server('pauseSessionExpired', {});
  c.t += 590_000;
  await session.resume();
  assert.equal(sockets.length, 2, 'fresh socket');
  assert.equal(session.state, 'connected');
  assert.equal(stvPeer().config.iceServers[0].credential, 'cred-1');
  assert.equal(sockets[0].didEmit('resumeConversation'), false);
  session.disconnect();
});

test('resume() after a released pause with time left uses the same socket', async () => {
  const c = clock();
  const { session, sockets } = await connected({ cfg: { now: c.now }, perSocket: () => ({ turn: serverTurn({ ttl: 600 }) }) });
  session.pause();
  sockets[0].server('pauseSessionExpired', {});
  c.t += 60_000;
  scriptHappyPath(sockets[0]);
  await session.resume();
  assert.equal(sockets.length, 1);
  assert.ok(sockets[0].didEmit('resumeConversation'));
  session.disconnect();
});

test('a TTL of 120 s or less never triggers a renewal', async () => {
  const c = clock();
  const { session, sockets } = await connected({ cfg: { now: c.now }, perSocket: () => ({ turn: serverTurn({ ttl: 120 }) }) });
  c.t += 110_000;
  assert.equal(session._takeTurnRefresh(), false);
  assert.equal(sockets.length, 1);
  session.disconnect();
});

test('renewal runs once per credential set', async () => {
  const c = clock();
  const { session } = await connected({ cfg: { now: c.now }, perSocket: () => ({ turn: serverTurn({ ttl: 600 }) }) });
  c.t += 590_000;
  assert.equal(session._takeTurnRefresh(), true);
  assert.equal(session._takeTurnRefresh(), false);
  session.disconnect();
});

test('media recovery near expiry rebuilds on a fresh socket instead of an ICE restart', async () => {
  const c = clock();
  const { session, sockets } = await connected({ cfg: { now: c.now }, perSocket: (n) => ({ turn: serverTurn({ ttl: 600, credential: `cred-${n}` }) }) });
  const asr = asrPeer();
  c.t += 590_000;
  asr.setIce('failed');
  await until(() => sockets.length === 2 && session.state === 'connected');
  assert.equal(asr.iceRestarted, undefined);
  assert.equal(asrPeer().config.iceServers[0].credential, 'cred-1');
  session.disconnect();
});

test('expired credentials are left out of new peers', async () => {
  const c = clock();
  const { session } = await connected({ cfg: { now: c.now }, perSocket: () => ({ turn: serverTurn({ ttl: 600 }) }) });
  c.t += 601_000;
  assert.deepEqual(session._iceServers(), [FALLBACK]);
  session.disconnect();
});

test('prepare() then connect() near expiry drops the prepared socket', async () => {
  const c = clock();
  const { session, sockets } = await connected({ cfg: { now: c.now }, perSocket: (n) => ({ turn: serverTurn({ ttl: 600, credential: `cred-${n}` }) }), connect: false });
  await session.prepare();
  assert.equal(sockets.length, 1);
  c.t += 590_000;
  await session.connect();
  assert.equal(sockets.length, 2);
  assert.equal(stvPeer().config.iceServers[0].credential, 'cred-1');
  session.disconnect();
});

// ── warnings, leaks, version ──

/** JSON of everything reachable from `o`, each object once. Peers count as `{}`, like a real RTCPeerConnection. */
function safeJson(o) {
  const seen = new WeakSet();
  return JSON.stringify(o, (_k, v) => {
    if (v instanceof FakeRTCPeerConnection) return {};
    if (v && typeof v === 'object') { if (seen.has(v)) return undefined; seen.add(v); }
    return v;
  });
}

test('no TURN at all: one [turn] warning', async () => {
  const { session, logs } = await connected({ perSocket: () => ({}), cfg: { turnServerUrl: '' } });
  assert.equal(logs.filter((l) => /^\[turn\] No TURN server/.test(l.msg)).length, 1);
  session.disconnect();
});

test('server credentials never appear in logs, events or the serialized session', async () => {
  const { session, logs, events, sockets } = await connected();
  sockets[0].server('turnCredentials', serverTurn({ credential: 'srv-cred-other' }));
  stvPeer().fireCandidateError({ errorCode: 401, url: SERVER_URLS[0] });
  const dump = JSON.stringify({ logs, events: events.map((e) => e.p) }) + safeJson(session);
  for (const secret of [SECRET_USER, SECRET_CRED, 'srv-cred-other', 'sock-secret-user']) assert.ok(!dump.includes(secret), 'secret leaked');
  assert.equal(Object.keys(session).includes('_serverTurn'), false);
  assert.equal(Object.keys(session).includes('_turnCredentials'), false);
  session.disconnect();
});

test('a 401 counts against credentials applied to a peer only after its next ICE restart', async () => {
  for (const first of [{ turn: serverTurn({ credential: 'cred-a' }) }, {}]) {
    const { session, sockets, events } = await connected({ perSocket: () => first });
    sockets[0].server('turnCredentials', serverTurn({ credential: 'cred-b' }));
    const pc = asrPeer();
    assert.equal(pc.config.iceServers[0].credential, 'cred-b');
    pc.fireCandidateError({ errorCode: 401, url: SERVER_URLS[0] });
    assert.equal(session._serverTurn.bad, false, 'the peer still gathers with the servers it had');
    pc.setIce('failed');
    await until(() => events.some((e) => e.ev === 'mediaRecovered'));
    assert.equal(pc.iceRestarted, 1);
    pc.fireCandidateError({ errorCode: 401, url: SERVER_URLS[0] });
    assert.equal(session._serverTurn.bad, true, first.turn ? 'rotated credentials' : 'peer built with no server entry');
    session.disconnect();
  }
});

test('server credentials are dropped when the session ends', async () => {
  for (const end of [(s) => s.disconnect(), (s) => s._endWith(new Error('x'), 'test')]) {
    const { session } = await connected();
    assert.ok(session._serverTurn);
    end(session);
    assert.equal(session._serverTurn, null);
  }
});

test('a prepared session holds no server credentials in its enumerable state', async () => {
  const { session } = await connected({ connect: false });
  await session.prepare();
  assert.ok(session._serverTurn, 'credentials were read');
  const dump = safeJson(session);
  for (const secret of [SECRET_USER, SECRET_CRED]) assert.ok(!dump.includes(secret), 'secret leaked from prepare()');
  session.disconnect();
});

test('the socket query names this SDK version', async () => {
  const { session, queries } = await connected();
  assert.equal(queries[0].sdk, JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version);
  session.disconnect();
});

// ── bounded recoveries ──

test('the third ASR recovery with no ICE up in between ends with reconnect_failed', async () => {
  const { session, events } = await connected({ perSocket: () => ({}) });
  const pc = asrPeer();
  const errs = [];
  session.on('error', (e) => errs.push(e));
  for (let i = 0; i < 2; i++) { pc.setIce('failed'); await until(() => events.filter((e) => e.ev === 'mediaRecovered').length === i + 1); }
  pc.setIce('failed');
  await until(() => session.state !== 'connected');
  const err = errs.at(-1);
  assert.equal(err?.code, 'reconnect_failed');
  assert.equal(err.phase, 'reconnect');
  assert.equal(err.retryable, true);
  assert.ok(err.ice?.cause, 'carries the ICE report');
  assert.equal(pc.iceRestarted, 2);
});

test('ICE coming back up resets the recovery count', async () => {
  const { session, events } = await connected({ perSocket: () => ({}) });
  const pc = asrPeer();
  for (let i = 0; i < 4; i++) {
    pc.setIce('failed');
    await until(() => events.filter((e) => e.ev === 'mediaRecovered').length === i + 1);
    pc.setIce('connected');
  }
  assert.equal(session.state, 'connected');
  assert.equal(pc.iceRestarted, 4);
  session.disconnect();
});

// ── how a browser spells the URL of a TURN error ──

for (const [name, url, reported] of [
  ['Chromium adds the transport to a URL with none', 'turn:relay.example.net:3478', 'turn:relay.example.net:3478?transport=udp'],
  ['Chromium adds the default port', 'turn:relay.example.net?transport=udp', 'turn:relay.example.net:3478?transport=udp'],
  ['Chromium lower-cases the scheme and the host', 'TURN:Relay.Example.NET:3478?transport=udp', 'turn:relay.example.net:3478?transport=udp'],
  ['Chromium drops the IPv6 brackets', 'turn:[2001:db8::1]:3478?transport=udp', 'turn:2001:db8::1:3478?transport=udp'],
  ['Chromium adds the turns: default port', 'turns:relay.example.net?transport=tcp', 'turns:relay.example.net:5349?transport=tcp'],
  ['Firefox drops the query string', 'turn:relay.example.net:3478?transport=udp', 'turn:relay.example.net:3478'],
]) {
  test(`401 with the URL as a browser reports it marks the server entry (${name})`, async () => {
    const { session, logs } = await connected({ perSocket: () => ({ turn: serverTurn({ url }) }) });
    stvPeer().fireCandidateError({ errorCode: 401, url: reported });
    assert.equal(session._serverTurn.bad, true);
    assert.equal(logs.filter((l) => l.msg.startsWith('[turn] The relay refused the TURN credentials the server sent')).length, 1);
    session.disconnect();
  });
}

test('401 on a query-less URL that may stand for a shared TCP URL marks nothing (Firefox)', async () => {
  const { session } = await connected({ perSocket: () => ({ turn: serverTurn({ url: HOST }) }) });
  stvPeer().fireCandidateError({ errorCode: 401, url: `turn:${HOST}:80` });
  assert.equal(session._serverTurn.bad, false);
  assert.equal(session._fallbackBad, false);
  session.disconnect();
});

test('a 401 on the server entry warns once, and says when no configured entry is left', async () => {
  for (const [turnServerUrl, text] of [[HOST, 'New connections use the configured TURN entry only.'], ['', 'no turnServerUrl is set']]) {
    const { session, logs } = await connected({ cfg: { turnServerUrl } });
    stvPeer().fireCandidateError({ errorCode: 401, url: SERVER_URLS[0] });
    asrPeer().fireCandidateError({ errorCode: 401, url: SERVER_URLS[1] });
    const warned = logs.filter((l) => l.msg.startsWith('[turn] '));
    assert.equal(warned.length, 1);
    assert.ok(warned[0].msg.includes(text), warned[0].msg);
    session.disconnect();
  }
});

// ── the relay or the browser refuses the configured entry ──

test('401 on a configured-only URL: later peers use the server entry alone, with all its URLs', async () => {
  const { session, logs } = await connected({ perSocket: () => ({ turn: serverTurn({ url: HOST }) }) });
  stvPeer().fireCandidateError({ errorCode: 401, url: FALLBACK.urls[0] });
  assert.equal(session._fallbackBad, true);
  assert.equal(session._serverTurn.bad, false);
  assert.deepEqual(session._iceServers(), [{ urls: FALLBACK.urls, username: SECRET_USER, credential: SECRET_CRED }]);
  assert.equal(logs.filter((l) => l.msg.startsWith('[turn] The relay refused the configured TURN credentials')).length, 1);
  stvPeer().fireCandidateError({ errorCode: 401, url: FALLBACK.urls[0] });
  assert.equal(logs.filter((l) => l.msg.startsWith('[turn] ')).length, 1, 'warned once');
  session.disconnect();
  assert.equal(session._fallbackBad, false, 'reset when the session ends');
});

test('401 on the configured entry with no server entry in the list marks nothing', async () => {
  const { session } = await connected({ perSocket: () => ({}) });
  stvPeer().fireCandidateError({ errorCode: 401, url: FALLBACK.urls[0] });
  assert.equal(session._fallbackBad, false);
  session.disconnect();
});

test('401 from an earlier server entry the peer still gathers with blames neither entry', async () => {
  const { session, sockets } = await connected({ perSocket: () => ({ turn: serverTurn({ credential: 'cred-a' }) }) });
  sockets[0].server('turnCredentials', serverTurn({ credential: 'cred-b', url: 'relay-b.example.net' }));
  stvPeer().fireCandidateError({ errorCode: 401, url: SERVER_URLS[0] });
  assert.equal(session._serverTurn.bad, false);
  assert.equal(session._fallbackBad, false);
  session.disconnect();
});

/** Refuses a URL with two ports, as browsers do for `turnServerUrl: 'host:port'`. */
class StrictUrls extends FakeRTCPeerConnection {
  constructor(cfg) {
    if (cfg.iceServers.some((e) => [].concat(e.urls).some((u) => /:\d+:\d+/.test(u)))) throw new TypeError('Invalid URL');
    super(cfg);
  }
}

test('a browser that refuses the configured entry: peers use the server entry alone, one warning', async () => {
  const { session, logs } = await connected({ cfg: { turnServerUrl: `${HOST}:3478` }, rtc: StrictUrls });
  assert.equal(session.state, 'connected');
  for (const pc of [asrPeer(), stvPeer()]) assert.deepEqual(pc.config.iceServers, [{ urls: SERVER_URLS, username: SECRET_USER, credential: SECRET_CRED }]);
  assert.equal(session._serverTurn.bad, false);
  assert.equal(session._fallbackBad, true);
  const warned = logs.filter((l) => l.msg.startsWith('[turn] '));
  assert.equal(warned.length, 1);
  assert.match(warned[0].msg, /refused the configured TURN entry/);
  session.disconnect();
});

test('a browser that refuses both entries alone fails the connect, as before', async () => {
  class Neither extends FakeRTCPeerConnection { constructor(cfg) { if (cfg.iceServers.length) throw new TypeError('Invalid TURN server'); super(cfg); } }
  const { session } = await connected({ rtc: Neither, connect: false });
  await assert.rejects(() => session.connect());
});

test('no turnServerUrl and a refused server entry: the warnings agree', async () => {
  class Picky extends FakeRTCPeerConnection {
    constructor(c) { if (c.iceServers.some((s) => s.credential === SECRET_CRED)) throw new TypeError('Invalid TURN server'); super(c); }
  }
  Picky.instances = FakeRTCPeerConnection.instances;
  const { session, logs } = await connected({ rtc: Picky, cfg: { turnServerUrl: '' } });
  assert.equal(session._serverTurn.bad, true);
  const warned = logs.filter((l) => l.msg.startsWith('[turn] ')).map((l) => l.msg);
  assert.ok(warned.length >= 1);
  for (const m of warned) assert.ok(!/configured TURN entry only|server sent none/.test(m), m);
  assert.ok(warned.some((m) => /no TURN server is left/.test(m)));
  session.disconnect();
});

test('an unrelated constructor failure with no usable server entry gives no TURN warning', async () => {
  const c = clock();
  let boom = false;
  class Boom extends FakeRTCPeerConnection { constructor(cfg) { if (boom) throw new TypeError('no WebRTC'); super(cfg); } }
  Boom.instances = FakeRTCPeerConnection.instances;
  const { session, logs } = await connected({ cfg: { now: c.now }, rtc: Boom, perSocket: () => ({ turn: serverTurn({ ttl: 600 }) }) });
  c.t += 700_000;
  boom = true;
  assert.throws(() => session._newPeer('stv'), /no WebRTC/);
  assert.equal(logs.filter((l) => l.msg.startsWith('[turn] ')).length, 0);
  assert.equal(session._serverTurn.bad, false);
  session.disconnect();
});

// ── updates, teardown and listeners ──

test('new credentials with no host keep the host of the earlier set', async () => {
  for (const url of [undefined, '']) {
    const { session, sockets } = await connected({ cfg: { turnServerUrl: '' } });
    sockets[0].server('turnCredentials', { username: SECRET_USER, credential: 'srv-cred-rotated', ttl: 3600, ...(url != null && { url }) });
    assert.deepEqual(session._serverTurn.entry.urls, SERVER_URLS);
    assert.deepEqual(session._iceServers(), [{ urls: SERVER_URLS, username: SECRET_USER, credential: 'srv-cred-rotated' }]);
    session.disconnect();
  }
});

test('identical credentials sent again keep a refused entry set aside and the refresh used', async () => {
  const c = clock();
  const { session, sockets } = await connected({ cfg: { now: c.now }, perSocket: () => ({ turn: serverTurn({ ttl: 600 }) }) });
  c.t += 590_000;
  assert.equal(session._takeTurnRefresh(), true);
  sockets[0].server('turnCredentials', serverTurn({ ttl: 600 }));
  assert.equal(session._takeTurnRefresh(), false, 'the refresh is not armed again');
  stvPeer().fireCandidateError({ errorCode: 401, url: SERVER_URLS[0] });
  sockets[0].server('turnCredentials', serverTurn({ ttl: 600 }));
  assert.equal(session._serverTurn.bad, true);
  session.disconnect();
});

test('a refused server entry is never renewed', async () => {
  const c = clock();
  const { session } = await connected({ cfg: { now: c.now }, perSocket: () => ({ turn: serverTurn({ ttl: 600 }) }) });
  stvPeer().fireCandidateError({ errorCode: 401, url: SERVER_URLS[0] });
  c.t += 590_000;
  assert.equal(session._takeTurnRefresh(), false);
  session.disconnect();
});

test('late credentials recover a peer that is already down', async () => {
  const { session, sockets, events } = await connected({ perSocket: () => ({}) });
  const pc = asrPeer();
  pc.iceConnectionState = 'failed';
  pc.connectionState = 'failed';
  sockets[0].server('turnCredentials', serverTurn());
  await until(() => events.some((e) => e.ev === 'mediaRecovering'));
  session.disconnect();
});

test('applied in place, the peer keeps its policy and the query strings', async () => {
  const { session, sockets } = await connected({ perSocket: () => ({}) });
  sockets[0].server('turnCredentials', serverTurn());
  const pc = stvPeer();
  assert.deepEqual(pc.config.iceServers[0].urls, SERVER_URLS);
  assert.equal(pc.config.iceTransportPolicy, 'relay');
  session.disconnect();
});

test('a peer that refuses query strings in setConfiguration gets the stripped servers', async () => {
  class NoQuerySet extends FakeRTCPeerConnection {
    setConfiguration(c) { if (c.iceServers.some((e) => e.urls.some((u) => u.includes('?')))) throw new TypeError('Invalid TURN URL query string'); super.setConfiguration(c); }
  }
  NoQuerySet.instances = FakeRTCPeerConnection.instances;
  const { session, sockets } = await connected({ perSocket: () => ({}), rtc: NoQuerySet });
  sockets[0].server('turnCredentials', serverTurn());
  const entry = serverEntry(stvPeer());
  assert.ok(entry);
  assert.ok(entry.urls.every((u) => !u.includes('?')));
  session.disconnect();
});

for (const ev of ['iceServers', 'onTurnConfig', 'turn_servers', 'onIceConfiguration']) {
  test(`credentials in a TURN-named event (${ev}) are read`, async () => {
    const { session, sockets } = await connected({ perSocket: () => ({}) });
    sockets[0].server(ev, serverTurn());
    assert.ok(serverEntry(stvPeer()));
    session.disconnect();
  });
}

for (const ev of ['clientConfiguration', 'joinComplete', 'stvNewSession']) {
  test(`a socket without onAny reads credentials from ${ev}`, async () => {
    const patch = (s) => {
      s.onAny = undefined;
      const real = s.server.bind(s);
      s.server = (e, p) => real(e, e === ev ? { ...(p || {}), turn: serverTurn() } : p);
    };
    const { session } = await connected({ perSocket: () => ({}), patch });
    assert.ok(serverEntry(stvPeer()));
    session.disconnect();
  });
}

test('a socket the factory hands out again carries one catch-all listener', async () => {
  const shared = new FakeSocket();
  FakeRTCPeerConnection.reset();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: HOST,
    videoEl: new FakeVideoEl({ autoCanPlay: true }), rtcConstructor: FakeRTCPeerConnection,
    socketFactory: () => { shared.connected = true; scriptHappyPath(shared, { resumingOnRecreate: false, serverConnected: { turn: serverTurn() } }); return shared; },
    fetch: fakeWhepFetch(Array.from({ length: 10 }, () => ({}))), getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false,
    timeouts: { healthTick: 600000, coldBackoff: 10 },
  });
  for (let i = 0; i < 3; i++) {
    session.setToken(CONV_KS);
    await session.connect();
    assert.equal(shared._any.length, 1);
    session.disconnect();
    assert.equal(shared._any.length, 0);
  }
});

test('disconnect() after a prepare() from the disconnected state closes the prepared socket', async () => {
  const { session, sockets } = await connected();
  session.disconnect();
  session.setToken(CONV_KS);
  await session.prepare();
  assert.ok(session._serverTurn);
  session.disconnect();
  assert.equal(session._serverTurn, null);
  assert.equal(session._prep, null);
  assert.equal(sockets[1].connected, false);
  assert.equal(sockets[1]._any.length, 0);
  assert.equal(session._token, null);
});

test('the prepared socket dropped for a renewal is closed', async () => {
  const c = clock();
  const { session, sockets } = await connected({ cfg: { now: c.now }, perSocket: (n) => ({ turn: serverTurn({ ttl: 600, credential: `cred-${n}` }) }), connect: false });
  await session.prepare();
  c.t += 590_000;
  await session.connect();
  assert.equal(sockets[0].connected, false);
  assert.equal(sockets[0]._h.size, 0);
  assert.equal(sockets[0]._any.length, 0);
  session.disconnect();
});

test('a failed renewal in resume() rejects resume_failed with the end error as its cause', async () => {
  const c = clock();
  const { session, sockets, events } = await connected({
    cfg: { now: c.now, timeouts: { healthTick: 600000, coldBackoff: 10, serverConnect: 50, overall: 2000 } },
    perSocket: (n) => (n === 0 ? { turn: serverTurn({ ttl: 600 }) } : {}),
    patch: (s, n) => { if (n > 0) { s.server = () => {}; s.connected = false; } },
  });
  session.pause();
  sockets[0].server('pauseSessionExpired', {});
  c.t += 590_000;
  await assert.rejects(() => session.resume(), (e) => e.code === 'resume_failed' && e.cause?.code === 'reconnect_failed');
  assert.deepEqual(events.filter((e) => e.ev === 'ended').map((e) => e.p.reason), ['reconnect_failed']);
});

test('caller turnCredentials are copied: changing the object later changes nothing', async () => {
  const own = { username: 'own-user', credential: 'own-cred' };
  const { session } = await connected({ cfg: { turnServerUrl: 'own.example', turnCredentials: own }, perSocket: () => ({ turn: serverTurn({ url: '' }) }), connect: false });
  own.username = '';
  own.credential = '';
  await session.connect();
  assert.deepEqual(stvPeer().config.iceServers, [turnServers('own.example', { username: 'own-user', credential: 'own-cred' })]);
  assert.equal(safeJson(session).includes('own-cred'), false);
  session.disconnect();
});

for (const [name, change] of [['the username', { username: `${SECRET_USER}-2` }], ['the host', { url: 'relay-b.example.net' }]]) {
  test(`credentials that differ only in ${name} are a new set`, async () => {
    const { session, sockets } = await connected();
    stvPeer().fireCandidateError({ errorCode: 401, url: SERVER_URLS[0] });
    assert.equal(session._serverTurn.bad, true);
    sockets[0].server('turnCredentials', serverTurn(change));
    assert.equal(session._serverTurn.bad, false);
    session.disconnect();
  });
}

test('credentials that leave the ICE servers unchanged are not applied again', async () => {
  const own = { username: 'own-user', credential: 'own-cred' };
  const { session, sockets } = await connected({ cfg: { turnServerUrl: 'own.example', turnCredentials: own }, perSocket: () => ({}) });
  const before = [asrPeer(), stvPeer()].map((pc) => pc.configHistory?.length ?? 0);
  sockets[0].server('turnCredentials', serverTurn());
  assert.deepEqual([asrPeer(), stvPeer()].map((pc) => pc.configHistory?.length ?? 0), before);
  session.disconnect();
});

test('server credentials stop being used the moment they expire', async () => {
  const c = clock();
  const { session } = await connected({ cfg: { now: c.now }, perSocket: () => ({ turn: serverTurn({ ttl: 600 }) }) });
  c.t += 599_999;
  assert.equal(session._iceServers()[0].username, SECRET_USER);
  c.t += 1;
  assert.notEqual(session._iceServers()[0]?.username, SECRET_USER);
  session.disconnect();
});

test('the refresh starts when less than 60 s are left, not at 60 s', async () => {
  const c = clock();
  const { session } = await connected({ cfg: { now: c.now }, perSocket: () => ({ turn: serverTurn({ ttl: 600 }) }) });
  c.t += 540_000;
  assert.equal(session._takeTurnRefresh(), false);
  c.t += 1;
  assert.equal(session._takeTurnRefresh(), true);
  session.disconnect();
});

test('resume() during a running rebuild does not use the refresh', async () => {
  const c = clock();
  const { session, sockets } = await connected({ cfg: { now: c.now, timeouts: { healthTick: 600000, coldBackoff: 10, overall: 200 } }, perSocket: () => ({ turn: serverTurn({ ttl: 600 }) }) });
  session.pause();
  sockets[0].server('pauseSessionExpired', {});
  c.t += 590_000;
  session._coldReconnecting = true;
  session.resume().catch(() => {});
  assert.equal(session._serverTurn.refreshUsed, false);
  session._coldReconnecting = false;
  session.disconnect();
});

test('a media stall on a live path resets the recovery count', async () => {
  const { session } = await connected();
  session._recoverCount.asr = 2;
  const pc = asrPeer();
  pc.iceConnectionState = 'connected';
  await session._recoverMedia('asr', pc);
  assert.equal(session.state, 'connected');
  assert.equal(session._recoverCount.asr, 0);
  session.disconnect();
});

test('an old peer coming back up does not reset the recovery count', async () => {
  const { session } = await connected();
  session._recoverCount.stv = 2;
  session._onIceStateChange('stv', { iceConnectionState: 'connected', connectionState: 'connected' });
  assert.equal(session._recoverCount.stv, 2);
  session.disconnect();
});

test('connect() starts with a fresh recovery count', async () => {
  const { session } = await connected();
  session._recoverCount = { asr: 2, stv: 2 };
  session.disconnect();
  session.setToken(CONV_KS);
  await session.connect();
  assert.deepEqual(session._recoverCount, { asr: 0, stv: 0 });
  session.disconnect();
});

test('the per-peer ICE server maps are not enumerable', async () => {
  const { session } = await connected();
  for (const k of ['_peerServers', '_peerNextServers']) assert.ok(!Object.keys(session).includes(k), k);
  session.disconnect();
});
