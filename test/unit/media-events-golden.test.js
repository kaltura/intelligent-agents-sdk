// Golden log of the public media event sequence across every connect / recover /
// teardown path, plus the element writes the SDK makes along the way.
//
// The fixture (test/fixtures/media-events.golden.json) was generated on `main` with
// these same fakes BEFORE the avatar-media rewrite landed. Event sequences must match
// it exactly. The only permitted counter drift is listed in PERMITTED_DIFF below (the
// rewrite sets srcObject / calls play() once per element instead of once per track).
//
// Regenerate (only on purpose, only from a known-good baseline):
//   MEDIA_GOLDEN_RECORD=1 node --test test/unit/media-events-golden.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor, fakeGetUserMedia } from '../fakes/rtc.js';

const FIXTURE = new URL('../fixtures/media-events.golden.json', import.meta.url);
const RECORD = process.env.MEDIA_GOLDEN_RECORD === '1';
const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');

/**
 * Counter values the rewrite is allowed to change, per scenario and counter path.
 * Anything not listed here must equal the recorded baseline.
 *
 * Baseline (main) assigned `videoEl.srcObject = e.streams[0]` and called `play()` inside
 * every `ontrack` (video + audio = 2 per connect). AvatarMedia binds each element once
 * per connect and re-binds once per recovery, so those counters drop to 1 (or to the
 * number of connect/recover cycles). `audioEl` was ignored on main (0 writes); with
 * `cfg.audioEl` honored it gets one srcObject write and one play() per connect.
 */
const PERMITTED_DIFF = {
  'connect-simple': { 'afterConnect.videoEl.playCount': 1, 'afterConnect.videoEl.srcObjectAssignments': 1, 'afterDisconnect.videoEl.playCount': 1 },
  'connect-split': {
    'afterConnect.videoEl.playCount': 1, 'afterConnect.videoEl.srcObjectAssignments': 1, 'afterDisconnect.videoEl.playCount': 1,
    'afterConnect.audioEl.playCount': 1, 'afterConnect.audioEl.srcObjectAssignments': 1,
    'afterDisconnect.audioEl.playCount': 1, 'afterDisconnect.audioEl.srcObjectAssignments': 2,
  },
  'connect-audio-mode': {},
  'connect-headless': {},
  'resubscribe': { 'afterConnect.videoEl.playCount': 1, 'afterConnect.videoEl.srcObjectAssignments': 1, 'afterDisconnect.videoEl.playCount': 1, 'afterDisconnect.videoEl.srcObjectAssignments': 2 },
  'cold-reconnect': { 'afterConnect.videoEl.playCount': 1, 'afterConnect.videoEl.srcObjectAssignments': 1, 'afterDisconnect.videoEl.playCount': 1, 'afterDisconnect.videoEl.srcObjectAssignments': 2 },
  'resume-after-release': { 'afterConnect.videoEl.playCount': 1, 'afterConnect.videoEl.srcObjectAssignments': 1, 'afterDisconnect.videoEl.playCount': 1, 'afterDisconnect.videoEl.srcObjectAssignments': 2 },
  'teardown-mid-connect': { 'afterConnect.videoEl.playCount': 1, 'afterConnect.videoEl.srcObjectAssignments': 1, 'afterDisconnect.videoEl.playCount': 1 },
  'whep-failure': {},
  'connect-again': { 'afterConnect.videoEl.playCount': 2, 'afterConnect.videoEl.srcObjectAssignments': 3, 'afterDisconnect.videoEl.playCount': 2, 'afterDisconnect.videoEl.srcObjectAssignments': 4 },
};

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
const okWhep = async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } });
const stvPeer = () => FakeRTCPeerConnection.instances.find((p) => p.transceivers.some((t) => t.kind === 'video' && t.direction === 'recvonly'));

function setup({ videoEl, audioEl = null, fetch = okWhep, cfg = {} } = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.avatar.us.kaltura.ai',
    videoEl, audioEl, socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch, getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor,
    networkAware: false, ...cfg,
  });
  const events = [];
  session.on('streamReady', () => events.push('streamReady'));
  session.on('track', (p) => events.push(`track:${p.track.kind}`));
  session.on('videoMetadata', (p) => events.push(`videoMetadata:${p.videoWidth}x${p.videoHeight}`));
  session.on('mediaReady', (p) => events.push(p.mode === 'video' ? `mediaReady:video:${p.videoWidth}x${p.videoHeight}` : `mediaReady:${p.mode}`));
  session.on('stateChange', (p) => events.push(`stateChange:${p.state}`));
  session.on('warning', (w) => events.push(`warning:${w.code}`));
  session.on('mediaRecovering', (p) => events.push(`mediaRecovering:${p.channel}`));
  session.on('mediaRecovered', (p) => events.push(`mediaRecovered:${p.channel}:${p.method}`));
  session.on('reconnecting', (p) => events.push(`reconnecting:${p.reason}`));
  session.on('reconnected', (p) => events.push(`reconnected:${p.recovered}`));
  session.on('ended', (p) => events.push(`ended:${p.reason ?? ''}`));
  session.on('error', (e) => events.push(`error:${e.code}`));
  const counters = {};
  const snap = (label) => {
    counters[label] = {
      videoEl: videoEl ? { playCount: videoEl.playCount, srcObjectAssignments: videoEl.srcObjectAssignments } : null,
      audioEl: audioEl ? { playCount: audioEl.playCount, srcObjectAssignments: audioEl.srcObjectAssignments } : null,
    };
  };
  return { session, socket, events, counters, snap };
}

function waitFor(session, event, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for '${event}'`)), ms);
    session.on(event, () => { clearTimeout(t); resolve(); });
  });
}

/** Drive the decoder like a real browser: metadata then canplay, shortly after ontrack. */
async function connectDriven(session, videoEl) {
  const p = session.connect();
  await delay(20);
  videoEl.fireLoadedMetadata(960, 540);
  videoEl.fireCanPlay();
  await p;
}

const SCENARIOS = {
  async 'connect-simple'() {
    const videoEl = new FakeVideoEl({ autoCanPlay: false });
    const s = setup({ videoEl });
    scriptHappyPath(s.socket);
    await connectDriven(s.session, videoEl);
    s.snap('afterConnect');
    s.session.disconnect();
    s.snap('afterDisconnect');
    return s;
  },
  async 'connect-split'() {
    const videoEl = new FakeVideoEl({ autoCanPlay: false });
    const audioEl = new FakeVideoEl({ autoCanPlay: true });
    const s = setup({ videoEl, audioEl });
    scriptHappyPath(s.socket);
    await connectDriven(s.session, videoEl);
    s.snap('afterConnect');
    s.session.disconnect();
    s.snap('afterDisconnect');
    return s;
  },
  async 'connect-headless'() {
    const s = setup({ videoEl: null });
    scriptHappyPath(s.socket);
    await s.session.connect();
    s.snap('afterConnect');
    s.session.disconnect();
    s.snap('afterDisconnect');
    return s;
  },
  async 'connect-audio-mode'() {
    const videoEl = new FakeVideoEl({ autoCanPlay: true });
    const s = setup({ videoEl });
    scriptHappyPath(s.socket, { audioMode: true });
    await s.session.connect();
    s.snap('afterConnect');
    s.session.disconnect();
    s.snap('afterDisconnect');
    return s;
  },
  async 'resubscribe'() {
    const videoEl = new FakeVideoEl({ autoCanPlay: true });
    const s = setup({ videoEl });
    scriptHappyPath(s.socket);
    await s.session.connect();
    s.snap('afterConnect');
    const recovered = waitFor(s.session, 'mediaRecovered');
    stvPeer().setIce('failed');
    await recovered;
    await delay(50);
    s.session.disconnect();
    s.snap('afterDisconnect');
    return s;
  },
  async 'cold-reconnect'() {
    let whepPosts = 0;
    const fetch = async (url, init) => {
      if (init?.method === 'DELETE') return { ok: true, status: 200, text: async () => '', headers: { get: () => null } };
      whepPosts++;
      if (whepPosts === 2) return { ok: false, status: 404, text: async () => 'gone', headers: { get: () => null } };
      return okWhep();
    };
    const videoEl = new FakeVideoEl({ autoCanPlay: true });
    const s = setup({ videoEl, fetch });
    scriptHappyPath(s.socket);
    await s.session.connect();
    s.snap('afterConnect');
    const reconnected = waitFor(s.session, 'reconnected');
    stvPeer().setIce('failed');
    await reconnected;
    await delay(50);
    s.session.disconnect();
    s.snap('afterDisconnect');
    return s;
  },
  async 'resume-after-release'() {
    const videoEl = new FakeVideoEl({ autoCanPlay: true });
    const s = setup({ videoEl });
    scriptHappyPath(s.socket);
    await s.session.connect();
    s.snap('afterConnect');
    s.session.pause();
    s.socket.server('pauseSessionExpired', {});
    await s.session.resume();
    s.session.disconnect();
    s.snap('afterDisconnect');
    return s;
  },
  async 'teardown-mid-connect'() {
    const videoEl = new FakeVideoEl({ autoCanPlay: false });
    const s = setup({ videoEl });
    scriptHappyPath(s.socket);
    const p = s.session.connect();
    await delay(20); // WHEP done, ontrack fired, canplay/hard-cap still pending
    s.snap('afterConnect');
    s.session.disconnect();
    await p.catch((e) => s.events.push(`connect:rejected:${e.code}`));
    await delay(300);
    s.snap('afterDisconnect');
    return s;
  },
  async 'whep-failure'() {
    const videoEl = new FakeVideoEl({ autoCanPlay: false });
    const fetch = async () => ({ ok: false, status: 503, text: async () => '', headers: { get: () => null } });
    const s = setup({ videoEl, fetch });
    scriptHappyPath(s.socket);
    await s.session.connect().catch((e) => s.events.push(`connect:rejected:${e.code}`));
    s.snap('afterConnect');
    await delay(300);
    s.snap('afterDisconnect');
    return s;
  },
  async 'connect-again'() {
    const videoEl = new FakeVideoEl({ autoCanPlay: true });
    const s = setup({ videoEl });
    scriptHappyPath(s.socket);
    await s.session.connect();
    s.session.disconnect();
    scriptHappyPath(s.socket);
    await s.session.connect();
    s.snap('afterConnect');
    s.session.disconnect();
    s.snap('afterDisconnect');
    return s;
  },
};

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, path, out); else out[path] = v;
  }
  return out;
}

const results = {};
for (const [name, run] of Object.entries(SCENARIOS)) {
  test(`media events golden: ${name}`, { timeout: 15000 }, async () => {
    const s = await run();
    results[name] = { events: s.events, counters: s.counters };
    if (RECORD) return;
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const golden = fixture.scenarios[name];
    assert.ok(golden, `fixture has no scenario '${name}' — regenerate from a known-good baseline`);
    assert.deepEqual(s.events, golden.events, `event sequence drifted from the baseline in '${name}'`);
    const got = flatten(s.counters), want = flatten(golden.counters), allowed = PERMITTED_DIFF[name] || {};
    for (const path of new Set([...Object.keys(got), ...Object.keys(want)])) {
      const expected = path in allowed ? allowed[path] : want[path];
      assert.equal(got[path], expected, `${name}: counter ${path} = ${got[path]}, baseline ${want[path]}${path in allowed ? ` (permitted: ${allowed[path]})` : ''}`);
    }
  });
}

test('media events golden: write fixture (record mode only)', { skip: !RECORD }, () => {
  const header = [
    'Golden media-event log. Generated on `main` before the avatar-media rewrite, with the fakes in test/fakes/.',
    'Events must match exactly. Counter drift is only allowed where PERMITTED_DIFF in test/unit/media-events-golden.test.js lists it:',
    'the rewrite binds srcObject / calls play() once per element per connect or recovery, instead of once per ontrack.',
    'Regenerate only on purpose: MEDIA_GOLDEN_RECORD=1 node --test test/unit/media-events-golden.test.js',
  ];
  writeFileSync(FIXTURE, JSON.stringify({ _header: header, scenarios: results }, null, 2) + '\n');
});
