/**
 * KalturaAvatarSession × AvatarMedia — the session-level media contract (plan §5.5):
 * races between element swaps and `ontrack` (R-e, R-f, R-i, R-l, R-m, R-o), the mediaReady gate's
 * listener hygiene, audio-only mode never touching the media layer (P2), the settle paths (P6),
 * teardown (§5.5.11) and the audio controls through the public API (§5.5.3–§5.5.6).
 * Pure-AvatarMedia behaviour lives in avatar-media.test.js; this file only covers what needs a session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KalturaAvatarSession } from '../../src/experience/index.js';
import { FakeSocket, scriptHappyPath } from '../fakes/socket.js';
import { FakeRTCPeerConnection, FakeVideoEl, FakeMediaStreamCtor, fakeGetUserMedia } from '../fakes/rtc.js';
import { assertInvariants } from './helpers/avatar-media-invariants.js';

const CONV_KS = 'djJ8' + Buffer.from('v2|123|geniegpcid:1222').toString('base64url');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const whepOk = async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/1' } });
const stvPeer = () => FakeRTCPeerConnection.instances.find((p) => p.transceivers.some((t) => t.kind === 'video' && t.direction === 'recvonly'));
/** The current (most recently created) STV peer: needed after a recovery has replaced `_pcStv`, where `stvPeer()` would still find the old, closed one. */
const latestStvPeer = () => FakeRTCPeerConnection.instances.filter((p) => p.transceivers.some((t) => t.kind === 'video' && t.direction === 'recvonly')).pop();
/** WHEP fetch that suppresses the fake's automatic ontrack so the test fires tracks by hand. */
const manualTracksFetch = async (...args) => { stvPeer().disableAutoTrack(); return whepOk(...args); };

function newSession(overrides = {}) {
  FakeRTCPeerConnection.reset();
  const socket = new FakeSocket();
  const videoEl = 'videoEl' in overrides ? overrides.videoEl : new FakeVideoEl({ autoCanPlay: true });
  const session = new KalturaAvatarSession({
    token: CONV_KS, srsBaseUrl: 'https://srs.example', turnServerUrl: 'turn.avatar.us.kaltura.ai',
    videoEl, socketFactory: () => socket, rtcConstructor: FakeRTCPeerConnection,
    fetch: overrides.fetch ?? whepOk, getUserMedia: fakeGetUserMedia(), mediaStreamConstructor: FakeMediaStreamCtor,
    ...(overrides.cfg || {}),
  });
  return { session, socket, videoEl };
}
const kinds = (el) => el.srcObject.getTracks().map((t) => t.kind).sort();
const count = (session, ev) => { const n = { v: 0 }; session.on(ev, () => { n.v += 1; }); return n; };

// ───────────────────────── mediaReady gate: listener hygiene (I-4) ─────────────────────────

test('gate listeners on videoEl are removed once mediaReady settles (normal finish)', async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: false });
  const { session, socket } = newSession({ videoEl });
  scriptHappyPath(socket);
  const connectP = session.connect();
  await delay(20);
  assert.equal(videoEl.listenerCount('canplay'), 1); assert.equal(videoEl.listenerCount('loadedmetadata'), 1);
  videoEl.fireLoadedMetadata(640, 360); videoEl.fireCanPlay();
  await connectP;
  assert.equal(videoEl.listenerCount('canplay'), 0); assert.equal(videoEl.listenerCount('loadedmetadata'), 0);
  session.disconnect();
});

test('R-m: disconnect() mid-connect removes the gate listeners and never plays/writes again', async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: false });
  const { session, socket } = newSession({ videoEl });
  scriptHappyPath(socket);
  const connectP = session.connect();
  await delay(20);
  session.disconnect();
  await connectP.catch(() => {});
  assert.equal(videoEl.listenerCount('canplay'), 0); assert.equal(videoEl.listenerCount('loadedmetadata'), 0);
  assert.equal(videoEl.srcObject, null);
  const writes = videoEl.srcObjectAssignments, plays = videoEl.playCount;
  videoEl.fireCanPlay(); videoEl.fireLoadedMetadata(1, 1);
  await delay(350);
  assert.equal(videoEl.srcObjectAssignments, writes); assert.equal(videoEl.playCount, plays);
  assert.equal(session.avatarStream, null);
});

// ───────────────────────── races between element swaps and ontrack ─────────────────────────

test('R-e: setAudioEl() between the video and audio ontrack → split shape, one srcObject + one play() per element, mediaReady once', async () => {
  const videoEl = new FakeVideoEl();
  const audioEl = new FakeVideoEl();
  const { session, socket } = newSession({ videoEl, fetch: manualTracksFetch });
  scriptHappyPath(socket);
  const ready = count(session, 'mediaReady');
  const connectP = session.connect();
  await delay(20);
  stvPeer().fireTrack('video');
  session.setAudioEl(audioEl);
  stvPeer().fireTrack('audio');
  await connectP;
  assert.deepEqual(kinds(videoEl), ['video']); assert.deepEqual(kinds(audioEl), ['audio']);
  assert.equal(videoEl.srcObjectAssignments, 1); assert.equal(audioEl.srcObjectAssignments, 1);
  assert.equal(videoEl.playCount, 1); assert.equal(audioEl.playCount, 1);
  assert.equal(ready.v, 1);
  assertInvariants(session._avatarMedia, 'R-e');
  session.disconnect();
});

test("R-f: setAudioEl() from inside the first 'track' listener does not throw and yields the split shape", async () => {
  const videoEl = new FakeVideoEl();
  const audioEl = new FakeVideoEl();
  const { session, socket } = newSession({ videoEl });
  scriptHappyPath(socket);
  let calls = 0;
  session.on('track', () => { if (calls++ === 0) session.setAudioEl(audioEl); });
  await session.connect();
  assert.equal(calls, 2);
  assert.deepEqual(kinds(videoEl), ['video']); assert.deepEqual(kinds(audioEl), ['audio']);
  assert.equal(videoEl.srcObjectAssignments, 1); assert.equal(audioEl.srcObjectAssignments, 1);
  assertInvariants(session._avatarMedia, 'R-f');
  session.disconnect();
});

test('R-i: connect → disconnect → connect: fresh streams, old tracks ended, one play() per binding per connect, mediaReady once per connect', async () => {
  const { session, socket, videoEl } = newSession();
  scriptHappyPath(socket);
  const ready = count(session, 'mediaReady');
  await session.connect();
  const first = session.avatarStream;
  const firstTracks = first.getTracks();
  session.disconnect();
  assert.ok(firstTracks.every((t) => t.readyState === 'ended'));
  assert.equal(videoEl.srcObject, null);
  scriptHappyPath(socket);
  await session.connect();
  assert.notEqual(session.avatarStream, first, 'a new canonical stream per connect');
  assert.deepEqual(kinds(videoEl), ['audio', 'video']);
  assert.ok(!videoEl.srcObject.getTracks().some((t) => firstTracks.includes(t)), 'no stale track survives');
  assert.equal(videoEl.srcObjectAssignments, 3, 'bind, null on disconnect, bind');
  assert.equal(videoEl.playCount, 2);
  assert.equal(ready.v, 2);
  assertInvariants(session._avatarMedia, 'R-i');
  session.disconnect();
});

test('R-l: setVideoEl(newEl) after ontrack but before the gate settles → mediaReady exactly once, old element released, no stale listeners', { timeout: 10000 }, async () => {
  const oldEl = new FakeVideoEl({ autoCanPlay: false });
  const newEl = new FakeVideoEl({ autoCanPlay: true });
  const { session, socket } = newSession({ videoEl: oldEl });
  scriptHappyPath(socket);
  const ready = [];
  session.on('mediaReady', (p) => ready.push(p));
  const connectP = session.connect();
  await delay(20);   // both tracks attached to oldEl, canplay pending
  session.setVideoEl(newEl);
  assert.equal(oldEl.srcObject, null);
  assert.deepEqual(kinds(newEl), ['audio', 'video']);
  assert.equal(newEl.playCount, 1);
  await connectP;   // the 2s canplay fallback settles the gate
  assert.equal(ready.length, 1);
  assert.equal(ready[0].mode, 'video');
  assert.equal(oldEl.listenerCount('canplay'), 0); assert.equal(oldEl.listenerCount('loadedmetadata'), 0);
  assert.equal(session.videoEl, newEl);
  assertInvariants(session._avatarMedia, 'R-l');
  session.disconnect();
  assert.equal(newEl.srcObject, null);
});

test('R-o: setVideoEl(null) after connect releases the element while avatarStream keeps both tracks; a later setVideoEl(el2) rebinds', async () => {
  const { session, socket, videoEl } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  session.setVideoEl(null);
  assert.equal(videoEl.srcObject, null);
  assert.equal(session.videoEl, null);
  assert.deepEqual(session.avatarStream.getTracks().map((t) => t.kind).sort(), ['audio', 'video']);
  assert.ok(session.avatarStream.getTracks().every((t) => t.readyState !== 'ended'), 'dropping the element does not stop the downlink');
  const el2 = new FakeVideoEl();
  session.setVideoEl(el2);
  assert.deepEqual(kinds(el2), ['audio', 'video']);
  assert.equal(el2.playCount, 1);
  assertInvariants(session._avatarMedia, 'R-o');
  session.disconnect();
});

// ───────────────────────── P2 / P6 ─────────────────────────

test("P2: audio-only mode never touches the media layer — zero element writes, avatarStream null, controls store without throwing", async () => {
  const { session, socket, videoEl } = newSession();
  scriptHappyPath(socket, { audioMode: true });
  await session.connect();
  assert.equal(session.mode, 'audio');
  assert.equal(videoEl.srcObjectAssignments, 0); assert.equal(videoEl.playCount, 0);
  assert.equal(session.avatarStream, null);
  session.muteAudioOutput(); session.setAudioOutputVolume(0.5);
  assert.equal(session.audioOutputMuted, true); assert.equal(session.audioOutputVolume, 0.5);
  assert.equal(await session.setAudioOutput('spk-1'), true, 'sink routing still lands on the configured element for a later video mode');
  assert.equal(await session.startPlayback(), false);
  session.disconnect();
  assert.equal(videoEl.srcObjectAssignments, 0, 'teardown writes nothing when nothing was bound');
});

test('P6: a bare { srcObject, play() } element (no addEventListener) settles immediately and gets both tracks', async () => {
  const bare = { srcObject: null, play() { this.plays = (this.plays || 0) + 1; return Promise.resolve(); } };
  const { session, socket } = newSession({ videoEl: bare });
  scriptHappyPath(socket);
  const ready = count(session, 'mediaReady');
  await session.connect();
  assert.deepEqual(bare.srcObject.getTracks().map((t) => t.kind).sort(), ['audio', 'video']);
  assert.equal(bare.plays, 1);
  assert.equal(ready.v, 1);
  session.disconnect();
  assert.equal(bare.srcObject, null);
});

// ───────────────────────── §5.5.11 teardown ─────────────────────────

test('teardown via disconnect(): tracks ended, srcObject null on both elements, avatarStream null, bindings kept', async () => {
  const videoEl = new FakeVideoEl(), audioEl = new FakeVideoEl();
  const { session, socket } = newSession({ videoEl, cfg: { audioEl } });
  scriptHappyPath(socket);
  await session.connect();
  const tracks = session.avatarStream.getTracks();
  session.disconnect();
  assert.ok(tracks.every((t) => t.readyState === 'ended'));
  assert.equal(videoEl.srcObject, null); assert.equal(audioEl.srcObject, null);
  assert.equal(session.avatarStream, null);
  assert.equal(session.videoEl, videoEl); assert.equal(session.audioEl, audioEl);
  assertInvariants(session._avatarMedia, 'teardown');
});

test('teardown via a fatal socket error (_endWith): same media teardown, and a stale ontrack afterwards writes nothing', async () => {
  const { session, socket, videoEl } = newSession({ cfg: { reconnectWindowMs: 9000 } });
  scriptHappyPath(socket);
  await session.connect();
  const pc = stvPeer();
  const tracks = session.avatarStream.getTracks();
  let ended = null; session.on('ended', (p) => { ended = p; });
  socket.server('disconnect', 'transport close');
  socket.server('reconnect_failed');
  assert.equal(ended?.reason, 'reconnect_failed');
  assert.ok(tracks.every((t) => t.readyState === 'ended'));
  assert.equal(videoEl.srcObject, null); assert.equal(session.avatarStream, null);
  const writes = videoEl.srcObjectAssignments, plays = videoEl.playCount;
  pc.fireTrack('video'); pc.fireTrack('audio');
  assert.equal(videoEl.srcObjectAssignments, writes); assert.equal(videoEl.playCount, plays);
  assert.equal(session.avatarStream, null);
  session.disconnect();
});

test('connect() failure (WHEP 503) never binds: srcObject untouched, avatarStream null, play() never called', async () => {
  const failing = async () => ({ ok: false, status: 503, text: async () => '', headers: { get: () => null } });
  const { session, socket, videoEl } = newSession({ fetch: failing });
  scriptHappyPath(socket);
  await assert.rejects(() => session.connect());
  assert.equal(videoEl.srcObjectAssignments, 0); assert.equal(videoEl.playCount, 0);
  assert.equal(session.avatarStream, null);
  assert.equal(session.videoEl, videoEl);
});

test('stored mute / volume / sink id survive teardown and are already in place on the next connect (no extra writes)', async () => {
  const { session, socket, videoEl } = newSession();
  session.muteAudioOutput(); session.setAudioOutputVolume(0.3);
  assert.equal(await session.setAudioOutput('spk-9'), true);
  assert.equal(videoEl.mutedWrites, 1); assert.equal(videoEl.volumeWrites, 1); assert.deepEqual(videoEl.setSinkIdCalls, ['spk-9']);
  scriptHappyPath(socket);
  await session.connect();
  session.disconnect();
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(videoEl.muted, true); assert.equal(videoEl.volume, 0.3); assert.equal(videoEl.sinkId, 'spk-9');
  assert.equal(videoEl.mutedWrites, 1, 'diff-only: no redundant write per connect');
  assert.equal(videoEl.volumeWrites, 1); assert.equal(videoEl.setSinkIdCalls.length, 1);
  assert.equal(session.audioOutputMuted, true); assert.equal(session.audioOutputVolume, 0.3);
  session.disconnect();
});

// ───────────────────────── §5.5.3–§5.5.6 audio controls through the session API ─────────────────────────

test('mute follows the audio: simple mode writes videoEl.muted; setAudioEl() moves it to the audio element; setAudioEl(null) back', async () => {
  const { session, socket, videoEl } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  session.muteAudioOutput();
  assert.equal(videoEl.muted, true);
  const audioEl = new FakeVideoEl();
  session.setAudioEl(audioEl);
  assert.equal(audioEl.muted, true, 'stored mute applied to the new sink');
  session.unmuteAudioOutput();
  assert.equal(audioEl.muted, false);
  assert.equal(session.audioOutputMuted, false);
  session.setAudioEl(null);
  assert.equal(videoEl.muted, false, 'unmute state applied back to videoEl when it becomes the sink again');
  assertInvariants(session._avatarMedia, 'mute-follow');
  session.disconnect();
});

test('volume: clamped to 0..1, non-number → bad_request, follows the audio element, getter reflects the stored value', async () => {
  const { session, socket, videoEl } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  session.setAudioOutputVolume(-2);
  assert.equal(videoEl.volume, 0);
  session.setAudioOutputVolume(0.6);
  assert.equal(videoEl.volume, 0.6);
  assert.throws(() => session.setAudioOutputVolume(NaN), (e) => e.code === 'bad_request');
  assert.throws(() => session.setAudioOutputVolume('0.5'), (e) => e.code === 'bad_request');
  assert.equal(session.audioOutputVolume, 0.6, 'a rejected value leaves the stored one');
  const audioEl = new FakeVideoEl();
  session.setAudioEl(audioEl);
  assert.equal(audioEl.volume, 0.6);
  session.disconnect();
});

test('sink id is re-applied when the audio element changes (setAudioEl and back)', async () => {
  const { session, socket, videoEl } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  assert.equal(await session.setAudioOutput('spk-2'), true);
  const audioEl = new FakeVideoEl();
  session.setAudioEl(audioEl);
  await delay(0);
  assert.deepEqual(audioEl.setSinkIdCalls, ['spk-2']);
  session.setAudioEl(null);
  await delay(0);
  assert.deepEqual(videoEl.setSinkIdCalls, ['spk-2'], 'videoEl already has the sink; no redundant call');
  const el2 = new FakeVideoEl();
  session.setVideoEl(el2);
  await delay(0);
  assert.deepEqual(el2.setSinkIdCalls, ['spk-2'], 'a swapped video element (the sink in simple mode) gets the sink id too');
  session.disconnect();
});

test('playback_blocked: autoplay refusal surfaces as a warning with kind; startPlayback() from a gesture retries only the paused element', async () => {
  const videoEl = new FakeVideoEl(), audioEl = new FakeVideoEl();
  audioEl.failPlayTimes(1);
  const { session, socket } = newSession({ videoEl, cfg: { audioEl } });
  scriptHappyPath(socket);
  const warnings = [];
  session.on('warning', (w) => warnings.push(w));
  await session.connect();
  await delay(0);
  assert.deepEqual(warnings.map((w) => [w.code, w.kind]), [['playback_blocked', 'audio']]);
  assert.match(warnings[0].message, /startPlayback\(\)/);
  assert.equal(await session.startPlayback(), true);
  assert.equal(videoEl.playCount, 1, 'the playing element is not replayed');
  assert.equal(audioEl.playCount, 2);
  session.disconnect();
});

// ───────────────────────── disconnect() from inside a 'track' listener (Chromium hang guard) ─────────────────────────

test("disconnect() inside a 'track' listener: state flips at once, but the STV peer's close() is deferred to the next macrotask", async () => {
  const { session, socket, videoEl } = newSession();
  scriptHappyPath(socket);
  const seen = [];
  session.on('track', ({ track }) => {
    if (track.kind !== 'video') return;
    const pc = stvPeer();
    session.disconnect();
    seen.push({ state: session.state, closedSync: pc.closed, srcObject: videoEl.srcObject, pcRef: session._pcStv });
    seen.pc = pc;
  });
  await session.connect().catch(() => {});   // how connect() settles after a mid-connect teardown is pinned by the golden suite, not here
  assert.equal(seen.length, 1);
  assert.equal(seen[0].state, 'disconnected');
  assert.equal(seen[0].srcObject, null, 'the element is released synchronously');
  assert.equal(seen[0].pcRef, null, 'the session drops its peer reference synchronously');
  assert.equal(seen[0].closedSync, false, 'close() is NOT called inside the ontrack dispatch');
  await delay(0);
  assert.equal(seen.pc.closed, true, 'close() lands on the next macrotask');
  assert.equal(session._inOntrack, false);
  assertInvariants(session._avatarMedia);
});

test("disconnect() outside any 'track' listener still closes the STV peer synchronously", async () => {
  const { session, socket } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  const pc = stvPeer();
  session.disconnect();
  assert.equal(pc.closed, true);
});

// ───────────────────────── P11: twoAV shape (audio before video, distinct receiver streams) ─────────────────────────

/** Swap fireTrack's kind so audio arrives before video (twoAV): each call still builds its own fresh receiver stream. */
function withReversedTrackOrder(fn) {
  const orig = FakeRTCPeerConnection.prototype.fireTrack;
  FakeRTCPeerConnection.prototype.fireTrack = function (kind = 'video') { orig.call(this, kind === 'video' ? 'audio' : 'video'); };
  return fn().finally(() => { FakeRTCPeerConnection.prototype.fireTrack = orig; });
}

test('P11: mediaReady/videoMetadata carry real dims from videoEl.loadedmetadata when audio arrives before video (twoAV, distinct receiver streams)', async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: false });
  const { session, socket } = newSession({ videoEl });
  scriptHappyPath(socket);
  const mediaReady = [], videoMetadata = [];
  session.on('mediaReady', (p) => mediaReady.push(p));
  session.on('videoMetadata', (p) => videoMetadata.push(p));
  await withReversedTrackOrder(async () => {
    const connectP = session.connect();
    await delay(20);
    videoEl.fireLoadedMetadata(960, 540);
    videoEl.fireCanPlay();
    await connectP;
  });
  assert.deepEqual(videoMetadata, [{ videoWidth: 960, videoHeight: 540 }]);
  assert.deepEqual(mediaReady, [{ mode: 'video', videoWidth: 960, videoHeight: 540 }]);
  session.disconnect();
});

test('P11 split: mediaReady/videoMetadata still carry real dims from videoEl (never audioEl) in twoAV order with cfg.audioEl set', async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: false });
  const audioEl = new FakeVideoEl({ autoCanPlay: true });
  const { session, socket } = newSession({ videoEl, cfg: { audioEl } });
  scriptHappyPath(socket);
  const mediaReady = [], videoMetadata = [];
  session.on('mediaReady', (p) => mediaReady.push(p));
  session.on('videoMetadata', (p) => videoMetadata.push(p));
  await withReversedTrackOrder(async () => {
    const connectP = session.connect();
    await delay(20);
    videoEl.fireLoadedMetadata(1280, 720);
    videoEl.fireCanPlay();
    await connectP;
  });
  assert.deepEqual(videoMetadata, [{ videoWidth: 1280, videoHeight: 720 }]);
  assert.deepEqual(mediaReady, [{ mode: 'video', videoWidth: 1280, videoHeight: 720 }]);
  assert.equal(audioEl.listenerCount('loadedmetadata'), 0, 'the readiness gate only ever watches videoEl, never audioEl');
  assert.deepEqual(kinds(videoEl), ['video']); assert.deepEqual(kinds(audioEl), ['audio']);
  session.disconnect();
});

// ───────────────────────── R-l: the 6000ms hard cap (as opposed to the 2000ms canplay fallback) ─────────────────────────

test("R-l: the 6000ms hard cap fires 'mediaReady' exactly once when the STV track never arrives at all (WHEP succeeds, ontrack never fires, so the 2000ms canplay fallback never even arms)", { timeout: 15000 }, async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: false });
  const { session, socket } = newSession({ videoEl, fetch: manualTracksFetch });
  scriptHappyPath(socket);
  const mediaReady = [], videoMetadata = [];
  session.on('mediaReady', (p) => mediaReady.push(p));
  session.on('videoMetadata', (p) => videoMetadata.push(p));
  const connectP = session.connect();   // manualTracksFetch disables auto ontrack; no fireTrack() is ever called
  await delay(2200);
  assert.equal(mediaReady.length, 0, 'still open past 2000ms: proves this is not the local canplay-fallback arm');
  await connectP;   // resolves once the unconditional 6000ms hard cap + 300ms jitter settle it
  assert.equal(mediaReady.length, 1);
  assert.deepEqual(mediaReady[0], { mode: 'video', videoWidth: 0, videoHeight: 0 });
  assert.equal(videoMetadata.length, 0, 'ontrack never ran, so videoMetadata never fires either');
  session.disconnect();
});

// ───────────────────────── R-b: 0×0 loadedmetadata between the two ontracks (today's pinned behavior) ─────────────────────────

test("R-b: a 0×0 loadedmetadata firing between the two ontracks pins videoMetadata/mediaReady at {0,0}: a later real loadedmetadata never overrides it (once-only gate; plan :470 pins this as today's behavior)", async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: false });
  const { session, socket } = newSession({ videoEl, fetch: manualTracksFetch });
  scriptHappyPath(socket);
  const mediaReady = [], videoMetadata = [];
  session.on('mediaReady', (p) => mediaReady.push(p));
  session.on('videoMetadata', (p) => videoMetadata.push(p));
  const connectP = session.connect();
  await delay(20);
  stvPeer().fireTrack('video');
  videoEl.fireLoadedMetadata(0, 0);   // decoder reports metadata before it knows the real dims
  videoEl.fireCanPlay();
  stvPeer().fireTrack('audio');
  videoEl.fireLoadedMetadata(960, 540);   // arrives too late: the once-only gate already fired on the 0×0 event
  await connectP;
  assert.deepEqual(videoMetadata, [{ videoWidth: 0, videoHeight: 0 }]);
  assert.deepEqual(mediaReady, [{ mode: 'video', videoWidth: 0, videoHeight: 0 }]);
  session.disconnect();
});

// ───────────────────────── R-g: a held play() promise never gates mediaReady ─────────────────────────

test("R-g: a held play() promise does not delay 'mediaReady', does not trigger a second play(), and resolving it later changes nothing", async () => {
  const videoEl = new FakeVideoEl({ autoCanPlay: true });   // readyState 4 → settle() runs at ontrack regardless of play()
  const handle = videoEl.holdPlay();
  const { session, socket } = newSession({ videoEl });
  scriptHappyPath(socket);
  const ready = count(session, 'mediaReady');
  await session.connect();
  assert.equal(ready.v, 1, 'mediaReady fired without waiting on the pending play()');
  assert.equal(videoEl.playCount, 1);
  handle.resolve();
  await delay(0);
  assert.equal(videoEl.playCount, 1, 'resolving the held play() later does not trigger a second play()');
  assert.equal(ready.v, 1);
  session.disconnect();
});

// ───────────────────────── R-k / P9: mediaReady fires once per _connectStv() call, including across recoveries ─────────────────────────

test('R-k/P9: mediaReady fires exactly once per _connectStv() call: once on connect, once after a re-subscribe recovers, once after a cold reconnect', { timeout: 15000 }, async () => {
  let whepPosts = 0;
  const fetch = async (url, init) => {
    if (init?.method === 'DELETE') return whepOk();
    whepPosts += 1;
    if (whepPosts === 3) return { ok: false, status: 404, text: async () => 'gone', headers: { get: () => null } };
    return whepOk();
  };
  const videoEl = new FakeVideoEl({ autoCanPlay: true });
  const { session, socket } = newSession({ videoEl, fetch });
  scriptHappyPath(socket);
  const ready = count(session, 'mediaReady');
  await session.connect();
  assert.equal(ready.v, 1, 'initial connect');

  const recovered = new Promise((resolve) => session.on('mediaRecovered', resolve));
  stvPeer().setIce('failed');
  await recovered;
  assert.equal(ready.v, 2, 're-subscribe recovery re-emits mediaReady once (P9: same count as main baseline, not suppressed)');

  const reconnected = new Promise((resolve) => session.on('reconnected', resolve));
  latestStvPeer().setIce('failed');
  await reconnected;
  assert.equal(ready.v, 3, 'the cold reconnect that follows the failed re-subscribe re-emits mediaReady once more');

  session.disconnect();
});

// ───────────────────────── U4: element swap while a re-subscribe's WHEP answer is still pending ─────────────────────────

test('swap during re-subscribe: setVideoEl()/setAudioEl() while the recovery WHEP answer is held: old elements released synchronously, new elements end up with the right tracks, one play() each, mediaReady still exactly once for the recovery', { timeout: 15000 }, async () => {
  const oldVideoEl = new FakeVideoEl({ autoCanPlay: true });
  let whepPosts = 0;
  let resolveRecoveryWhep;
  const fetch = async (url, init) => {
    if (init?.method === 'DELETE') return whepOk();
    whepPosts += 1;
    if (whepPosts === 1) return whepOk();
    return new Promise((resolve) => {
      resolveRecoveryWhep = () => resolve({ ok: true, status: 201, text: async () => 'v=0\r\nanswer\r\n', headers: { get: () => 'https://srs/whep/resource/2' } });
    });
  };
  const { session, socket } = newSession({ videoEl: oldVideoEl, fetch });
  scriptHappyPath(socket);
  await session.connect();
  const ready = count(session, 'mediaReady');

  const recovering = new Promise((resolve) => session.on('mediaRecovering', resolve));
  stvPeer().setIce('failed');
  await recovering;
  await delay(0);   // _recoverMedia closed the old STV pc and called _connectStv() again; its WHEP POST is now held

  const newVideoEl = new FakeVideoEl({ autoCanPlay: true });
  const newAudioEl = new FakeVideoEl({ autoCanPlay: true });
  session.setVideoEl(newVideoEl);
  session.setAudioEl(newAudioEl);
  assert.equal(oldVideoEl.srcObject, null, 'the old element is released synchronously by the swap, before the recovery even resolves');

  const recovered = new Promise((resolve) => session.on('mediaRecovered', resolve));
  resolveRecoveryWhep();
  await recovered;
  await delay(20);   // let the new pc's ontrack land and attach() reconcile the swapped-in tracks

  assert.deepEqual(kinds(newVideoEl), ['video']);
  assert.deepEqual(kinds(newAudioEl), ['audio']);
  assert.equal(oldVideoEl.srcObject, null);
  assert.equal(newVideoEl.playCount, 1, 'one play(), not one per re-subscribed track');
  assert.equal(newAudioEl.playCount, 1);
  assert.equal(ready.v, 1, 'the recovery still emits mediaReady exactly once despite the mid-flight element swap');
  assertInvariants(session._avatarMedia, 'swap-during-resubscribe');
  session.disconnect();
});

// ───────────────────────── U5 / P3: WHEP negatives never touch the media layer ─────────────────────────

/** Minimal handshake script that hands back a private-IP webrtc_url (join/checkAvailability/stvNewSession/showAgent/askPermissions). */
function scriptPrivateIpWhep(socket) {
  const soon = (fn) => setTimeout(fn, 0);
  soon(() => { socket.server('connect'); socket.server('onServerConnected', { finalUrl: 'https://srs.example', agentName: 'Avatar', hostName: 'host-1' }); });
  socket.onEmit((ev) => {
    if (ev === 'join') soon(() => { socket.server('clientConfiguration', { clientConfiguration: { languageCode: 'en', interruptionsEnabled: true } }); socket.server('joinComplete', {}); });
    else if (ev === 'checkAvailability') soon(() => socket.server('availabilityResult', { available: true, details: { activeCalls: 1, maxCalls: 10 } }));
    else if (ev === 'stvNewSession') soon(() => {
      socket.server('stvNewSession', { session_id: 'sess-priv', status: 'session started', webrtc_url: 'https://10.1.2.3/rtc/v1/whep/?app=app&stream=sess-priv' });
      soon(() => { socket.server('showAgent', {}); soon(() => socket.server('askPermissions', { constraints: { audio: true, video: true } })); });
    });
    else if (ev === 'asr-webrtc-init') soon(() => socket.server('asr-webrtc-ready', {}));
    else if (ev === 'asr-webrtc-offer') soon(() => socket.server('asr-webrtc-answer', { answer: { type: 'answer', sdp: 'fake-answer' } }));
  });
}

test('P3: a private-IP WHEP url rejects connect() before any media element write: no mediaReady, no videoMetadata, no track, videoEl.srcObject stays null', async () => {
  const { session, socket, videoEl } = newSession();
  scriptPrivateIpWhep(socket);
  const mediaReady = [], videoMetadata = [], tracks = [];
  session.on('mediaReady', (p) => mediaReady.push(p));
  session.on('videoMetadata', (p) => videoMetadata.push(p));
  session.on('track', (p) => tracks.push(p));
  await assert.rejects(() => session.connect(), (e) => e.code === 'whep_private_ip');
  assert.equal(mediaReady.length, 0); assert.equal(videoMetadata.length, 0); assert.equal(tracks.length, 0);
  assert.equal(videoEl.srcObject, null); assert.equal(videoEl.srcObjectAssignments, 0);
});

test('P3: setRemoteDescription() throwing rejects connect() before any media element write: no mediaReady, no videoMetadata, no track, videoEl.srcObject stays null', async () => {
  const { session, socket, videoEl } = newSession();
  scriptHappyPath(socket);
  const mediaReady = [], videoMetadata = [], tracks = [];
  session.on('mediaReady', (p) => mediaReady.push(p));
  session.on('videoMetadata', (p) => videoMetadata.push(p));
  session.on('track', (p) => tracks.push(p));
  const orig = FakeRTCPeerConnection.prototype.setRemoteDescription;
  FakeRTCPeerConnection.prototype.setRemoteDescription = async function (d) {
    if (this.transceivers.some((t) => t.kind === 'video' && t.direction === 'recvonly')) throw new Error('setRemoteDescription failed (sdp munge)');
    return orig.call(this, d);
  };
  try {
    await assert.rejects(() => session.connect());
  } finally {
    FakeRTCPeerConnection.prototype.setRemoteDescription = orig;
  }
  assert.equal(mediaReady.length, 0); assert.equal(videoMetadata.length, 0); assert.equal(tracks.length, 0);
  assert.equal(videoEl.srcObject, null); assert.equal(videoEl.srcObjectAssignments, 0);
});

// ───────────────────────── U7: a second playback_blocked after a rebind; selective startPlayback() ─────────────────────────

test("U7: a second 'playback_blocked' warning fires after setVideoEl() rebinds to a new blocked element (once-per-binding); startPlayback() retries only the paused element", async () => {
  const videoEl = new FakeVideoEl(), audioEl = new FakeVideoEl();
  videoEl.failPlayTimes(1);
  const { session, socket } = newSession({ videoEl, cfg: { audioEl } });
  scriptHappyPath(socket);
  const warnings = [];
  session.on('warning', (w) => warnings.push(w));
  await session.connect();
  await delay(0);
  assert.deepEqual(warnings.map((w) => [w.code, w.kind]), [['playback_blocked', 'video']], 'videoEl blocked once; audioEl played fine');
  assert.equal(videoEl.paused, true); assert.equal(audioEl.paused, false);

  const nextVideoEl = new FakeVideoEl();
  nextVideoEl.failPlayTimes(1);
  session.setVideoEl(nextVideoEl);
  await delay(0);
  assert.deepEqual(warnings.map((w) => [w.code, w.kind]), [['playback_blocked', 'video'], ['playback_blocked', 'video']], 'a rebind is a new binding, so the once-per-binding rule allows a second warning');
  assert.equal(nextVideoEl.paused, true);

  assert.equal(await session.startPlayback(), true);
  assert.equal(nextVideoEl.playCount, 2, 'the paused element is retried');
  assert.equal(audioEl.playCount, 1, 'the already-playing element is not replayed');
  session.disconnect();
});

// ───────────────────────── Also: setAudioOutput() pending vs. setAudioEl() race ─────────────────────────

test('setAudioOutput(id) pending while setAudioEl(newEl) swaps the sink: newEl ends up with sinkId===id, the old element received exactly one setSinkId call', async () => {
  const { session, socket, videoEl } = newSession();
  scriptHappyPath(socket);
  await session.connect();
  let resolveSink;
  videoEl.setSinkId = (id) => {
    videoEl.setSinkIdCalls.push(id);
    return new Promise((resolve) => { resolveSink = () => { videoEl.sinkId = id; resolve(); }; });
  };
  const outputP = session.setAudioOutput('spk-race');
  await delay(0);
  assert.deepEqual(videoEl.setSinkIdCalls, ['spk-race'], 'exactly one call on the old element while the id is pending');

  const newEl = new FakeVideoEl();
  session.setAudioEl(newEl);
  resolveSink();
  assert.equal(await outputP, true);
  await delay(0);   // the rebind re-apply is deferred a microtask (avatar-media.js _applyAudioSettings)
  assert.equal(newEl.sinkId, 'spk-race', 'the new sink element ends up with the requested id');
  assert.equal(videoEl.setSinkIdCalls.length, 1, 'the old element is never retried');
  session.disconnect();
});
