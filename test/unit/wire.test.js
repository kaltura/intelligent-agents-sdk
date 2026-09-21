import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  turnServers, iceConfig, createPeerConnection, buildJoin, buildStvNewSession, whepUrl, whepUrlHasPrivateIp, whepResourceUrl,
  buildTextEntered, isAudioMode, CAPACITY_BACKOFF,
} from '../../src/experience/wire.js';

test('turnServers builds the 4 explicit URLs with default creds', () => {
  const t = turnServers('turn.example.com');
  assert.equal(t.urls.length, 4);
  assert.ok(t.urls.includes('turn:turn.example.com:80?transport=udp'));
  assert.ok(t.urls.includes('turns:turn.example.com:443?transport=tcp'));
  assert.equal(t.username, 'kaltura');
  assert.equal(t.credential, 'avatar');
});

test('turnServers strips scheme + trailing slash; null on empty', () => {
  assert.equal(turnServers('turn:host.x/').urls[0], 'turn:host.x:80?transport=udp');
  assert.equal(turnServers(''), null);
});

test('iceConfig: STV=relay, ASR=all (non-Firefox); both all on Firefox', () => {
  const turn = turnServers('h');
  assert.equal(iceConfig('stv', turn).iceTransportPolicy, 'relay');
  assert.equal(iceConfig('asr', turn).iceTransportPolicy, 'all');
  assert.equal(iceConfig('stv', turn, true).iceTransportPolicy, 'all');
  assert.equal(iceConfig('asr', turn).bundlePolicy, 'max-bundle');
});

test('createPeerConnection: happy path constructs directly, no retry', () => {
  let calls = 0;
  class FakeRTC { constructor(cfg) { calls++; this.cfg = cfg; } }
  const config = iceConfig('asr', turnServers('h'));
  const pc = createPeerConnection(FakeRTC, config);
  assert.equal(calls, 1);
  assert.equal(pc.cfg, config);
});

test('createPeerConnection: WebKit "Invalid TURN URL query string" retried with `?...` stripped', () => {
  const seenConfigs = [];
  class FakeRTC {
    constructor(cfg) {
      seenConfigs.push(cfg);
      if (cfg.iceServers.some((s) => s.urls.some((u) => u.includes('?')))) {
        throw new Error('Invalid TURN URL query string');
      }
    }
  }
  const config = iceConfig('asr', turnServers('h'));
  const pc = createPeerConnection(FakeRTC, config);
  assert.ok(pc instanceof FakeRTC);
  assert.equal(seenConfigs.length, 2);
  assert.ok(seenConfigs[0].iceServers[0].urls.some((u) => u.includes('?')));
  const strippedUrls = seenConfigs[1].iceServers[0].urls;
  assert.ok(strippedUrls.every((u) => !u.includes('?')));
  assert.ok(strippedUrls.includes('turn:h:80'));
  assert.ok(strippedUrls.includes('turns:h:443'));
  // original config object must be untouched (no in-place mutation of caller state)
  assert.ok(config.iceServers[0].urls.some((u) => u.includes('?')));
});

test('createPeerConnection: unrelated construction errors are not swallowed', () => {
  class FakeRTC { constructor() { throw new Error('some other native error'); } }
  const config = iceConfig('asr', turnServers('h'));
  assert.throws(() => createPeerConnection(FakeRTC, config), /some other native error/);
});

test('createPeerConnection: query-string error with no query-string urls still rethrows', () => {
  class FakeRTC { constructor() { throw new Error('Invalid TURN URL query string'); } }
  const config = { iceServers: [{ urls: ['turn:h:443'] }] };
  assert.throws(() => createPeerConnection(FakeRTC, config), /Invalid TURN URL query string/);
});

test('buildJoin pins avatar_only + channel=room, server-ignored extras present', () => {
  const j = buildJoin({ room: 'r1', threadId: 'th', userAgent: 'UA' });
  assert.equal(j.channel, 'r1');
  assert.equal(j.kaltura.force_experience, 'avatar_only');
  assert.equal(j.kaltura.threadId, 'th');
  assert.equal(j.peer_audio, true);
  assert.equal(j.peer_video, false);
});

test('buildJoin includes kaltura.ks when given (REQUIRED — live runtime stalls at join without it)', () => {
  const j = buildJoin({ room: 'r1', ks: 'djJ8token' });
  assert.equal(j.kaltura.ks, 'djJ8token');
  // and omits it cleanly when not provided
  assert.ok(!('ks' in buildJoin({ room: 'r1' }).kaltura));
});

test('buildJoin passes requestVars through as kaltura.request_vars, omitted when absent', () => {
  const j = buildJoin({ room: 'r1', requestVars: { user_name: 'Ada', tier: 'enterprise' } });
  assert.deepEqual(j.kaltura.request_vars, { user_name: 'Ada', tier: 'enterprise' });
  assert.ok(!('request_vars' in buildJoin({ room: 'r1' }).kaltura), 'no requestVars given → field omitted, not sent empty');
});

test('buildJoin sends kaltura.contextId (always present) and kaltura.contextType (omitted when absent)', () => {
  const j = buildJoin({ room: 'r1', contextId: 'cat_456', contextType: 'category' });
  assert.equal(j.kaltura.contextId, 'cat_456');
  assert.equal(j.kaltura.contextType, 'category');
  const bare = buildJoin({ room: 'r1' });
  assert.equal(bare.kaltura.contextId, undefined);
  assert.ok(!('contextType' in bare.kaltura), 'no contextType given → field omitted, not sent empty');
});

test('buildJoin includes kaltura.entryId when given, omitted when absent', () => {
  const j = buildJoin({ room: 'r1', entryId: '0_entry123' });
  assert.equal(j.kaltura.entryId, '0_entry123');
  assert.ok(!('entryId' in buildJoin({ room: 'r1' }).kaltura));
});

test('buildStvNewSession omits cast_mode by default (never webrtc)', () => {
  assert.deepEqual(buildStvNewSession('r1'), { room_id: 'r1' });
  assert.deepEqual(buildStvNewSession('r1', 'rtmp'), { room_id: 'r1', cast_mode: 'rtmp' });
});

test('whepUrl prefers server url, else builds SRS form', () => {
  assert.equal(whepUrl('https://srv/whep', 'https://srs', 's1'), 'https://srv/whep');
  assert.equal(whepUrl(undefined, 'https://srs/', 's1'), 'https://srs/rtc/v1/whep/?app=app&stream=s1');
});

test('whepResourceUrl appends a path-absolute /viewer/ Location to the subscribe URL (keeps its path prefix)', () => {
  // The media server writes Location from its own root and knows nothing about the path prefix
  // the subscribe URL carries, so plain URL resolution would drop that prefix and the DELETE
  // would be refused — leaving the viewer slot held until the server times the session out.
  assert.equal(
    whepResourceUrl('/whep/session/sess-1/viewer/v9', 'https://media.example/rtc/v1/stv/tok/whep/session/sess-1'),
    'https://media.example/rtc/v1/stv/tok/whep/session/sess-1/viewer/v9',
  );
});

test('whepResourceUrl keeps an absolute Location as-is', () => {
  assert.equal(
    whepResourceUrl('https://other.example/whep/session/s/viewer/v9', 'https://media.example/whep/session/s'),
    'https://other.example/whep/session/s/viewer/v9',
  );
});

test('whepResourceUrl resolves a relative non-viewer Location the standard way (srsBaseUrl fallback form)', () => {
  assert.equal(
    whepResourceUrl('/rtc/v1/whip/?action=delete&token=abc', 'https://srs.example/rtc/v1/whep/?app=app&stream=s1'),
    'https://srs.example/rtc/v1/whip/?action=delete&token=abc',
  );
});

test('whepResourceUrl drops the subscribe URL query and trailing slashes before appending /viewer/', () => {
  assert.equal(
    whepResourceUrl('/whep/session/s1/viewer/v1', 'https://media.example/whep/session/s1/?x=1'),
    'https://media.example/whep/session/s1/viewer/v1',
  );
});

test('whepResourceUrl returns an unresolvable Location unchanged rather than throwing', () => {
  assert.equal(whepResourceUrl('not a url', 'also not a url'), 'not a url');
});

test('whepUrlHasPrivateIp flags the broken STV-direct egress', () => {
  assert.equal(whepUrlHasPrivateIp('https://10.0.0.5/whep'), true);
  assert.equal(whepUrlHasPrivateIp('https://srs.example.com/whep'), false);
});

test('buildTextEntered shape', () => {
  assert.deepEqual(buildTextEntered('hi'), { text: 'hi', isFinal: true });
  assert.deepEqual(buildTextEntered('', false, true), { text: '', isFinal: false, isSpeechStart: true });
});

test('isAudioMode detects the no-STV reply', () => {
  assert.equal(isAudioMode({ status: 'audio/phone mode - no STV session' }), true);
  assert.equal(isAudioMode({ session_id: 'x', status: 'session started' }), false);
});

test('capacity backoff is the documented schedule', () => {
  assert.deepEqual(CAPACITY_BACKOFF, [30, 45, 60, 90, 120, 180, 240, 300, 360]);
});
