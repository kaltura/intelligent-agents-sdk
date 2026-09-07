/**
 * Backward compatibility of the avatar media API (plans/pr169-avatar-media-plan.md §3, §5.3).
 *
 * Three guarantees for apps built on 1.16.x:
 *  1. every documented constructor shape (README, examples, Nova) constructs and connects unchanged;
 *  2. the observable behaviour of the simple case (`videoEl` only) is the same or strictly better:
 *     `srcObject` once, `play()` once, both tracks on the element, app-owned `muted` / `volume` untouched;
 *  3. the public media API is the same on both session classes, with no leftovers of the old
 *     internal audio element (`cfg.doc`, `setOutput*`).
 * Plus: every warning code the runtime can emit is documented in README.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { KalturaAvatarSession, KalturaScriptedVideoSession, KalturaAgentSession, Emitter } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor, fakeGetUserMedia } from '../fakes/rtc.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const whepOk = async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } });

/** Test-only injection every fixture needs to run without a browser. Never part of an app's config. */
function fakes(socket) {
  return { socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection, fetch: whepOk, getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor };
}

async function connectAvatar(cfg) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({ ...cfg, ...fakes(socket) });
  scriptHappyPath(socket);
  await session.connect();
  return { session, socket };
}

// ───────────────────────── §5.3 public API surface, both session classes ─────────────────────────

const MEDIA_METHODS = ['setVideoEl', 'setAudioEl', 'muteAudioOutput', 'unmuteAudioOutput', 'setAudioOutputVolume', 'startPlayback', 'setAudioOutput'];
const MEDIA_GETTERS = ['videoEl', 'audioEl', 'avatarStream', 'audioOutputMuted', 'audioOutputVolume'];
const REMOVED = ['setOutputEl', 'setOutputVolume', 'muteOutput', 'unmuteOutput', 'outputMuted', 'outputVolume', 'doc', 'audioOutputEl'];

for (const [name, make] of [
  ['KalturaAvatarSession', () => new KalturaAvatarSession({ token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl: new FakeVideoEl(), ...fakes(new FakeSocket()) })],
  ['KalturaScriptedVideoSession', () => new KalturaScriptedVideoSession({ whepUrl: 'https://media.example.com/whep/abc', turn: { url: 'turn.x', username: 'u', credential: 'c' }, videoEl: new FakeVideoEl(), rtcConstructor: FakeRTCPeerConnection, mediaStreamConstructor: FakeMediaStreamCtor })],
]) {
  test(`${name}: exposes the shared avatar media API (methods + getters) and none of the old internal-audio-element names`, () => {
    const s = make();
    const proto = Object.getPrototypeOf(s);
    for (const m of MEDIA_METHODS) assert.equal(typeof s[m], 'function', `${m}() missing`);
    for (const g of MEDIA_GETTERS) assert.ok(Object.getOwnPropertyDescriptor(proto, g)?.get, `getter ${g} missing`);
    for (const r of REMOVED) assert.equal(r in s, false, `leftover member ${r}`);
    assert.equal(s.audioEl, null, 'no SDK-created audio element');
    assert.equal(s.avatarStream, null, 'no stream before the first track');
    assert.ok(s.videoEl, 'videoEl getter returns the configured element');
  });

  test(`${name}: media controls work before connect (stored, applied at bind) and validate at the boundary`, async () => {
    const s = make();
    s.muteAudioOutput();
    assert.equal(s.audioOutputMuted, true);
    s.unmuteAudioOutput();
    assert.equal(s.audioOutputMuted, false);
    s.setAudioOutputVolume(0.25);
    assert.equal(s.audioOutputVolume, 0.25);
    s.setAudioOutputVolume(7);
    assert.equal(s.audioOutputVolume, 1, 'clamped');
    assert.throws(() => s.setAudioOutputVolume('loud'), (e) => e.code === 'bad_request');
    assert.throws(() => s.setVideoEl('#video'), (e) => e.code === 'bad_request');
    assert.throws(() => s.setAudioEl({}), (e) => e.code === 'bad_request');
    await assert.rejects(() => s.setAudioOutput(42), (e) => e.code === 'bad_request');
    assert.equal(await s.startPlayback(), false, 'nothing bound yet → false, never throws');
  });
}

test('KalturaAvatarSession keeps mute()/unmute()/micEnabled mic-only; the scripted viewer has no mic API', () => {
  const s = new KalturaAvatarSession({ token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl: new FakeVideoEl(), ...fakes(new FakeSocket()) });
  assert.equal(typeof s.mute, 'function'); assert.equal(typeof s.unmute, 'function'); assert.equal(typeof s.micEnabled, 'boolean');
  const v = new KalturaScriptedVideoSession({ whepUrl: 'https://media.example.com/whep/abc', turn: { url: 'turn.x', username: 'u', credential: 'c' } });
  assert.equal('mute' in v, false); assert.equal('micEnabled' in v, false);
});

// ───────────────────────── §3 upgrade rows: the simple case stays the simple case ─────────────────────────

test('§3: videoEl-only app — srcObject set once, play() once, both tracks on the element, one audio track', async () => {
  const videoEl = new FakeVideoEl();
  const { session } = await connectAvatar({ token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl });
  assert.equal(videoEl.srcObjectAssignments, 1);
  assert.equal(videoEl.playCount, 1);
  assert.deepEqual(videoEl.srcObject.getTracks().map((t) => t.kind).sort(), ['audio', 'video']);
  assert.equal(videoEl.srcObject.getAudioTracks().length, 1);
  assert.equal(session.videoEl, videoEl);
  session.disconnect();
});

test('§3: the SDK never writes muted/volume on an app-owned element unless the app calls the SDK controls', async () => {
  const videoEl = new FakeVideoEl();
  videoEl.muted = true; videoEl.volume = 0.4;   // app-side attribute/property, e.g. <video muted>
  const before = { m: videoEl.mutedWrites, v: videoEl.volumeWrites };
  const { session } = await connectAvatar({ token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl });
  assert.equal(videoEl.mutedWrites, before.m, 'no muted write');
  assert.equal(videoEl.volumeWrites, before.v, 'no volume write');
  assert.equal(videoEl.muted, true); assert.equal(videoEl.volume, 0.4);
  assert.equal(session.audioOutputMuted, true, 'getter reflects the live element when the SDK never set it');
  assert.equal(session.audioOutputVolume, 0.4);
  assert.deepEqual(videoEl.attributeWrites, [], 'no setAttribute() either');
  session.disconnect();
  assert.equal(videoEl.mutedWrites, before.m); assert.equal(videoEl.volumeWrites, before.v);
});

test('§3: setAudioOutput(deviceId) keeps its contract — resolves true on success, false (never throws) when unsupported or rejected', async () => {
  const videoEl = new FakeVideoEl();
  const { session } = await connectAvatar({ token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl });
  assert.equal(await session.setAudioOutput('spk-1'), true);
  assert.deepEqual(videoEl.setSinkIdCalls, ['spk-1']);
  assert.equal(await session.setAudioOutput('spk-1'), true, 'same id: no second call');
  assert.equal(videoEl.setSinkIdCalls.length, 1);
  videoEl._sinkIdFailTimes = 1;
  assert.equal(await session.setAudioOutput('spk-2'), false);
  session.disconnect();
  const bare = { srcObject: null, play: () => Promise.resolve() };
  const { session: s2 } = await connectAvatar({ token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl: bare });
  assert.equal(await s2.setAudioOutput('spk-1'), false, 'element without setSinkId → false');
  s2.disconnect();
});

test('§3: headless app — the `track` event recipe and the `avatarStream` recipe both give the app every track', async () => {
  const seen = [];
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const session = new KalturaAvatarSession({ token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl: null, ...fakes(socket) });
  session.on('track', ({ track, streams }) => seen.push({ kind: track.kind, hasStreams: Array.isArray(streams) }));
  scriptHappyPath(socket);
  await session.connect();
  assert.deepEqual(seen.map((s) => s.kind).sort(), ['audio', 'video']);
  assert.ok(seen.every((s) => s.hasStreams));
  assert.deepEqual(session.avatarStream.getTracks().map((t) => t.kind).sort(), ['audio', 'video'], 'avatarStream is the one-line alternative to listening for track');
  assert.equal(session.videoEl, null);
  // Late binding: an app can attach an element after connect.
  const el = new FakeVideoEl();
  session.setVideoEl(el);
  assert.equal(el.srcObjectAssignments, 1); assert.equal(el.playCount, 1);
  assert.deepEqual(el.srcObject.getTracks().map((t) => t.kind).sort(), ['audio', 'video']);
  session.disconnect();
});

test('§3: a 1.16.x `cfg.doc` (old internal audio element host) is ignored without throwing and nothing is created in it', async () => {
  const doc = { body: { appendChild() { throw new Error('the SDK must not create elements anymore'); } }, createElement() { throw new Error('the SDK must not create elements anymore'); } };
  const videoEl = new FakeVideoEl();
  const { session } = await connectAvatar({ token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl, doc });
  assert.equal(session.audioEl, null);
  assert.equal(videoEl.srcObject.getAudioTracks().length, 1, 'audio plays on videoEl as before');
  session.disconnect();
});

test('§3: opting into split later is one line and does not disturb the video element', async () => {
  const videoEl = new FakeVideoEl();
  const { session } = await connectAvatar({ token: CONV_KS, srsBaseUrl: 'https://srs', turnServerUrl: 'turn.x', videoEl });
  const audioEl = new FakeVideoEl();
  session.setAudioEl(audioEl);
  assert.equal(videoEl.srcObjectAssignments, 1, 'videoEl.srcObject untouched');
  assert.deepEqual(videoEl.srcObject.getTracks().map((t) => t.kind), ['video']);
  assert.deepEqual(audioEl.srcObject.getTracks().map((t) => t.kind), ['audio']);
  assert.equal(audioEl.playCount, 1);
  session.setAudioEl(null);
  assert.equal(audioEl.srcObject, null);
  assert.deepEqual(videoEl.srcObject.getTracks().map((t) => t.kind).sort(), ['audio', 'video'], 'merged back');
  assert.equal(videoEl.srcObjectAssignments, 1, 'still never reassigned');
  session.disconnect();
});

// ───────────────────────── documented constructor shapes run unchanged ─────────────────────────

/**
 * Copies of the constructor configs shipped in README.md and examples/*.html (as of 1.16.1), with
 * the browser-only values (`io`, `document.getElementById`) replaced by fakes. If a key here stops
 * being accepted, an app copied from the docs breaks.
 */
const SHAPES = {
  'README.md quickstart': (videoEl) => ({ token: CONV_KS, conversationManagerUrl: 'https://cm.example', srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.avatar.us.kaltura.ai', videoEl }),
  'examples/browser-experience.html': (videoEl) => ({ token: CONV_KS, conversationManagerUrl: 'https://cm.example', srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.avatar.us.kaltura.ai', videoEl, isFirefox: false }),
  'examples/deck-presenter.html': (videoEl) => ({ token: CONV_KS, conversationManagerUrl: 'https://cm.example', srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.avatar.us.kaltura.ai', videoEl, isFirefox: false, requireDisclosureAck: true }),
  'examples/chroma-key-avatar.html': (videoEl) => ({ token: CONV_KS, conversationManagerUrl: 'https://cm.example', srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.avatar.us.kaltura.ai', videoEl }),
};

for (const [label, shape] of Object.entries(SHAPES)) {
  test(`fixture ${label}: constructs, connects, renders both tracks on videoEl (srcObject once, play once)`, async () => {
    const videoEl = new FakeVideoEl();
    const { session } = await connectAvatar(shape(videoEl));
    assert.equal(session.state, 'connected');
    assert.equal(videoEl.srcObjectAssignments, 1); assert.equal(videoEl.playCount, 1);
    assert.deepEqual(videoEl.srcObject.getTracks().map((t) => t.kind).sort(), ['audio', 'video']);
    session.disconnect();
    assert.equal(videoEl.srcObject, null);
  });
}

test('fixture Nova (intelligent-agents-sdk-site connect.js): KalturaAgentSession chat-first with an avatar cfg, switchMode("avatar") renders on els.video; mute()/unmute()/micEnabled still mic-only', async () => {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const video = new FakeVideoEl();
  // The chat transport is stubbed (it is not what this test is about); the avatar transport is the real KalturaAvatarSession.
  class ChatStub extends Emitter { state = 'idle'; async connect() { this.state = 'connected'; } disconnect() { this.state = 'closed'; } onToolCall() { return () => {}; } }
  const session = new KalturaAgentSession({
    token: CONV_KS,
    mode: 'chat',
    subjectId: 'visitor-1',
    transportFactories: { chat: () => new ChatStub() },
    avatar: {
      conversationManagerUrl: 'https://cm.example',
      srsBaseUrl: 'https://srs.example',
      turnServerUrl: 'turn.avatar.us.kaltura.ai',
      videoEl: video,
      socketFactory: () => socket,
      isFirefox: false,
      requireDisclosureAck: true,
      rtcConstructor: FakeRTCPeerConnection, fetch: whepOk, getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor,
    },
  });
  await session.connect();
  assert.equal(session.mode, 'chat');
  scriptHappyPath(socket);
  await session.switchMode('avatar');
  assert.equal(session.mode, 'avatar');
  assert.equal(video.srcObjectAssignments, 1);
  assert.deepEqual(video.srcObject.getTracks().map((t) => t.kind).sort(), ['audio', 'video']);
  const t = session.transport;   // Nova toggles the mic on the live transport: `t.micEnabled ? t.mute() : t.unmute()`
  assert.equal(typeof t.micEnabled, 'boolean');
  t.mute(); t.unmute();
  assert.equal(video.mutedWrites, 0, 'mic mute never touches the avatar element');
  assert.equal(t.videoEl, video);
  session.disconnect();
});

// ───────────────────────── every runtime warning code is documented ─────────────────────────

test('every `warning` code emitted from src/experience is documented in README.md', () => {
  const dir = join(ROOT, 'src', 'experience');
  const codes = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/(?:emit\('warning',|_onWarning\()\s*\{\s*code:\s*'([a-z_]+)'/g)) codes.add(m[1]);
  }
  assert.ok(codes.size >= 4, `expected the known warning codes, found ${[...codes].join(', ')}`);
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const missing = [...codes].filter((c) => !readme.includes('`' + c + '`'));
  assert.deepEqual(missing, [], `warning codes missing from README.md: ${missing.join(', ')}`);
});
