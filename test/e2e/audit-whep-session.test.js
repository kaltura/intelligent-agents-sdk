import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function build({ whep = [{}], whepOpts, wrap, timeouts = {}, onAuditEvent } = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  scriptHappyPath(socket, { resumingOnRecreate: false });
  const base = fakeWhepFetch(whep, whepOpts);
  const fetch = wrap ? wrap(base) : base;
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch, getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false,
    timeouts: { healthTick: 600000, ...timeouts }, onAuditEvent,
  });
  return { session, socket, base };
}

/** Track timers made with one marker delay: which were created, which were cleared. */
function watchTimers(marker) {
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const made = [], cleared = new Set();
  globalThis.setTimeout = (fn, ms, ...a) => { const t = realSet(fn, ms, ...a); if (ms === marker) made.push(t); return t; };
  globalThis.clearTimeout = (t) => { cleared.add(t); return realClear(t); };
  return { made, cleared, stop: () => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }, pending: () => made.filter((t) => !cleared.has(t)) };
}

// rk4
test('a DELETE answered with an error status is audited', async () => {
  const events = [];
  const { session } = build({ whepOpts: { deleteStatus: 500 }, onAuditEvent: (e) => events.push(e) });
  await session.connect();
  session.disconnect();
  await delay(30);
  assert.ok(events.some((e) => /whep\.release/.test(JSON.stringify(e)) && /HTTP 500/.test(JSON.stringify(e))), JSON.stringify(events.slice(-3)));
});

// rk5
test('a DELETE that rejects is audited with the reason', async () => {
  const events = [];
  const { session } = build({ wrap: (f) => async (u, init = {}) => { if (init.method === 'DELETE') throw new TypeError('network down'); return f(u, init); }, onAuditEvent: (e) => events.push(e) });
  await session.connect();
  session.disconnect();
  await delay(30);
  assert.ok(events.some((e) => /whep\.release/.test(JSON.stringify(e)) && /network down/.test(JSON.stringify(e))), JSON.stringify(events.slice(-3)));
});

// rk6 / rk2
test('the DELETE deadline timer is cleared once the DELETE answers', async () => {
  const w = watchTimers(54321);
  try {
    const { session } = build({ timeouts: { whepRelease: 54321 } });
    await session.connect();
    session.disconnect();
    await delay(30);
    assert.ok(w.made.length >= 1, 'a deadline timer was made');
    assert.deepEqual(w.pending(), []);
  } finally { w.stop(); }
});

// pip3
test('a late answer with a private Location is never sent a DELETE', async () => {
  // The fetch ignores the abort, as a slow network can: the answer still lands after disconnect().
  const { session, base } = build({ whep: [{ delayMs: 150, location: 'http://10.0.0.5/whep/viewer/1' }], wrap: (f) => (url, init = {}) => f(url, { ...init, signal: undefined }) });
  const p = session.connect();
  p.catch(() => {});
  await delay(40);
  session.disconnect();
  await delay(300);
  assert.equal(base.calls.length, 1, 'the late answer did arrive');
  assert.equal(base.deletes.filter((d) => d.url.includes('10.0.0.5')).length, 0);
});

// pip2: the try timer is released when the private Location stops the connect
test('a private Location stops connect() with whep_private_ip and leaves no try timer behind', async () => {
  const w = watchTimers(77777);
  try {
    const { session } = build({ whep: [{ location: 'http://10.0.0.5/whep/viewer/1' }], timeouts: { whepTry: 77777 } });
    await assert.rejects(session.connect(), (e) => e.code === 'whep_private_ip' && e.phase === 'whep');
    await delay(30);
    assert.ok(w.made.length >= 1);
    assert.deepEqual(w.pending(), []);
  } finally { w.stop(); }
});

// bd3: a late answer after cancel clears the try timer
test('an answer that lands after disconnect() leaves no try timer behind', async () => {
  const w = watchTimers(77778);
  try {
    const { session } = build({ whep: [{ delayMs: 120 }], timeouts: { whepTry: 77778 } });
    const p = session.connect();
    p.catch(() => {});
    await delay(30);
    session.disconnect();
    await delay(250);
    assert.ok(w.made.length >= 1);
    assert.deepEqual(w.pending(), []);
  } finally { w.stop(); }
});

// bd3 (second form): a fetch that ignores the abort still answers late
test('a late answer from a fetch that ignores abort is released and leaves no try timer', async () => {
  const w = watchTimers(77779);
  try {
    const { session, base } = build({ whep: [{ delayMs: 120 }], timeouts: { whepTry: 77779 }, wrap: (f) => (url, init = {}) => f(url, { ...init, signal: undefined }) });
    const p = session.connect();
    p.catch(() => {});
    await delay(30);
    session.disconnect();
    await delay(300);
    assert.ok(w.made.length >= 1);
    assert.deepEqual(w.pending(), [], 'the try timer was left running');
    assert.equal(base.deletes.length, 1, 'the late viewer was released');
  } finally { w.stop(); }
});
