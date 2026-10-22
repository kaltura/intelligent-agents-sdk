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

test('a 401 counts against credentials applied to a peer after it was built', async () => {
  for (const first of [{ turn: serverTurn({ credential: 'cred-a' }) }, {}]) {
    const { session, sockets } = await connected({ perSocket: () => first });
    sockets[0].server('turnCredentials', serverTurn({ credential: 'cred-b' }));
    assert.equal(stvPeer().config.iceServers[0].credential, 'cred-b');
    stvPeer().fireCandidateError({ errorCode: 401, url: SERVER_URLS[0] });
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
  assert.equal(errs.at(-1)?.code, 'reconnect_failed');
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
