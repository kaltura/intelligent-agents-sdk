import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, fakeGetUserMedia, FakeMediaStreamCtor } from '../fakes/rtc.js';
import { fakeWhepFetch } from '../fakes/whep.js';

/** A real page exit (non-persisted pagehide) releases the server side. A bfcache freeze does not. */

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A `globalThis` pagehide bus. Node has none. */
function pageBus() {
  const handlers = new Map();
  const origAdd = globalThis.addEventListener, origRemove = globalThis.removeEventListener;
  globalThis.addEventListener = (t, h) => { (handlers.get(t) ?? handlers.set(t, new Set()).get(t)).add(h); };
  globalThis.removeEventListener = (t, h) => { handlers.get(t)?.delete(h); };
  return {
    count: (t) => handlers.get(t)?.size ?? 0,
    pagehide(persisted) { for (const h of [...(handlers.get('pagehide') ?? [])]) h({ persisted }); },
    restore() { globalThis.addEventListener = origAdd; globalThis.removeEventListener = origRemove; },
  };
}

function build(steps = [{}], cfg = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const fetch = fakeWhepFetch(steps);
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.example.com',
    videoEl: new FakeVideoEl({ autoCanPlay: true }), socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch, getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor, networkAware: false,
    pageLifecycleAware: true, sessionCompleteOnEnd: false, ...cfg,
  });
  scriptHappyPath(socket, { resumingOnRecreate: false });
  return { session, socket, fetch };
}

test('pagehide releases the WHEP resource with keepalive, closes the peers and the socket', async () => {
  const bus = pageBus();
  try {
    const { session, socket, fetch } = build();
    await session.connect();
    assert.equal(bus.count('pagehide') > 0, true);
    bus.pagehide(false);
    assert.equal(session.state, 'disconnected');
    assert.equal(fetch.deletes.length, 1);
    assert.equal(fetch.deletes[0].keepalive, true);
    assert.equal(socket.connected, false);
    assert.ok(FakeRTCPeerConnection.instances.every((pc) => pc.connectionState === 'closed'));
    assert.equal(bus.count('pagehide'), 0, 'the listener is gone after teardown');
  } finally { bus.restore(); }
});

test('a persisted pagehide (bfcache) leaves the session alone', async () => {
  const bus = pageBus();
  try {
    const { session, fetch } = build();
    await session.connect();
    bus.pagehide(true);
    assert.equal(session.state, 'connected');
    assert.equal(fetch.deletes.length, 0);
    session.disconnect();
    assert.equal(fetch.deletes[0].keepalive, true, 'every teardown DELETE is keepalive: the page may close right after disconnect()');
  } finally { bus.restore(); }
});

test('pagehide during connect() cleans up and connect() rejects', async () => {
  const bus = pageBus();
  try {
    const { session, socket, fetch } = build([{ delayMs: 200 }]);
    const p = session.connect().catch((e) => e);
    await delay(50);
    bus.pagehide(false);
    const err = await p;
    assert.equal(err.code, 'connect_failed');
    assert.notEqual(session.state, 'connected');
    assert.equal(socket.connected, false);
    assert.equal(bus.count('pagehide'), 0);
    assert.equal(fetch.posts.length, 1);
    assert.equal(fetch.posts[0].aborted, true, 'the in-flight POST is aborted');
  } finally { bus.restore(); }
});

test('pageLifecycleAware: false installs no pagehide listener', async () => {
  const bus = pageBus();
  try {
    const { session } = build([{}], { pageLifecycleAware: false });
    await session.connect();
    assert.equal(bus.count('pagehide'), 0);
    session.disconnect();
  } finally { bus.restore(); }
});

test('a failed connect() leaves no pagehide listener behind', async () => {
  const bus = pageBus();
  try {
    const { session } = build([{ status: 503 }]);
    await session.connect().catch(() => {});
    assert.equal(bus.count('pagehide'), 0);
  } finally { bus.restore(); }
});
