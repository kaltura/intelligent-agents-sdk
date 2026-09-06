/**
 * AvatarMedia in isolation — every contract from plans §5.1/§5.4 on the class itself,
 * with the six stream invariants checked after every test. Gated at 100% lines /
 * branches / functions by `npm run test:ci:avatar-media`.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AvatarMedia } from '../../src/experience/avatar-media.js';
import { FakeVideoEl, FakeMediaStream, FakeMediaStreamCtor, makeFakeTrack } from '../fakes/rtc.js';
import { assertInvariants } from './helpers/avatar-media-invariants.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
/** @type {AvatarMedia[]} */ let live = [];

beforeEach(() => { FakeMediaStream.reset(); live = []; });
afterEach(() => { for (const m of live) assertInvariants(m, 'afterEach'); });

/** Build an AvatarMedia with the fake stream ctor, recording it for the afterEach invariant sweep. */
function media(cfg = {}) {
  const warnings = [], logs = [];
  const m = new AvatarMedia({
    mediaStreamConstructor: FakeMediaStreamCtor,
    onWarning: (w) => warnings.push(w),
    log: (level, msg, data) => logs.push({ level, msg, data }),
    ...cfg,
  });
  live.push(m);
  return { m, warnings, logs };
}
/** ontrack-shaped attach: fresh receiver stream per track (the twoVA / twoAV shape). */
function arrive(m, kind, track = makeFakeTrack(kind)) { m.attach(track, [new FakeMediaStream([track])]); return track; }
const kinds = (s) => s.getTracks().map((t) => t.kind).sort();

// ───────────────────────── construction and validation ─────────────────────────

test('constructor: no args → no elements, no stream, defaults for muted/volume', () => {
  const m = new AvatarMedia(); live.push(m);
  assert.equal(m.videoEl, null); assert.equal(m.audioEl, null); assert.equal(m.stream, null);
  assert.equal(m.muted, false); assert.equal(m.volume, 1);
});

test('constructor: falls back to globalThis.MediaStream when no constructor is injected', () => {
  const prev = globalThis.MediaStream;
  globalThis.MediaStream = FakeMediaStreamCtor;
  try {
    const m = new AvatarMedia({ videoEl: new FakeVideoEl() }); live.push(m);
    arrive(m, 'video');
    assert.ok(m.stream instanceof FakeMediaStreamCtor);
  } finally { if (prev === undefined) delete globalThis.MediaStream; else globalThis.MediaStream = prev; }
});

for (const [label, bad] of [['string', 'video'], ['number', 3], ['object without play', { srcObject: null }], ['object without srcObject', { play() {} }], ['function', () => {}]]) {
  test(`constructor / setVideoEl / setAudioEl reject a ${label} with bad_request naming the method`, () => {
    assert.throws(() => new AvatarMedia({ videoEl: bad }), (e) => e.code === 'bad_request' && /new AvatarMedia\(\{ videoEl \}\)/.test(e.detail) && /srcObject/.test(e.detail));
    assert.throws(() => new AvatarMedia({ audioEl: bad }), (e) => e.code === 'bad_request' && /new AvatarMedia\(\{ audioEl \}\)/.test(e.detail));
    const { m } = media();
    assert.throws(() => m.setVideoEl(bad), (e) => e.code === 'bad_request' && /setVideoEl\(el\)/.test(e.detail));
    assert.throws(() => m.setAudioEl(bad), (e) => e.code === 'bad_request' && /setAudioEl\(el\)/.test(e.detail));
  });
}

test('setters accept undefined as null', () => {
  const { m } = media({ videoEl: new FakeVideoEl() });
  m.setVideoEl(undefined);
  assert.equal(m.videoEl, null);
});

test('attach rejects a track without a valid kind (null, missing kind, data)', () => {
  const { m } = media({ videoEl: new FakeVideoEl() });
  for (const bad of [null, undefined, {}, { kind: 'data' }]) {
    assert.throws(() => m.attach(bad, []), (e) => e.code === 'bad_request' && /attach\(track\)/.test(e.detail) && /'video' or 'audio'/.test(e.detail));
  }
  assert.equal(m.stream, null, 'nothing created for a rejected track');
  assert.equal(m.videoEl.srcObjectAssignments, 0);
});

test('setVolume: non-finite or non-number → bad_request; out of range is clamped', () => {
  const el = new FakeVideoEl();
  const { m } = media({ videoEl: el });
  for (const bad of [NaN, Infinity, -Infinity, '0.5', null, undefined, {}]) {
    assert.throws(() => m.setVolume(bad), (e) => e.code === 'bad_request' && /setVolume\(v\)/.test(e.detail));
  }
  m.setVolume(2); assert.equal(m.volume, 1); assert.equal(el.volume, 1);
  m.setVolume(-1); assert.equal(m.volume, 0); assert.equal(el.volume, 0);
  m.setVolume(0.25); assert.equal(m.volume, 0.25); assert.equal(el.volume, 0.25);
});

test('setSinkId: non-string → bad_request naming the method', async () => {
  const { m } = media({ videoEl: new FakeVideoEl() });
  for (const bad of [42, null, undefined, {}]) {
    await assert.rejects(() => m.setSinkId(bad), (e) => e.code === 'bad_request' && /setSinkId\(deviceId\)/.test(e.detail));
  }
});

// ───────────────────────── shapes × modes ─────────────────────────

const SHAPES = {
  twoVA: (m) => { const v = arrive(m, 'video'); const a = arrive(m, 'audio'); return { v, a }; },
  twoAV: (m) => { const a = arrive(m, 'audio'); const v = arrive(m, 'video'); return { v, a }; },
  oneVA: (m) => { const v = makeFakeTrack('video'), a = makeFakeTrack('audio'); const s = new FakeMediaStream([v, a]); m.attach(v, [s]); m.attach(a, [s]); return { v, a }; },
  oneAV: (m) => { const v = makeFakeTrack('video'), a = makeFakeTrack('audio'); const s = new FakeMediaStream([v, a]); m.attach(a, [s]); m.attach(v, [s]); return { v, a }; },
};

for (const [shape, feed] of Object.entries(SHAPES)) {
  test(`simple mode, ${shape}: videoEl gets [audio, video], srcObject once, play once, 2 SDK streams`, () => {
    const el = new FakeVideoEl();
    const { m, warnings } = media({ videoEl: el });
    const { v, a } = feed(m);
    assert.deepEqual(kinds(el.srcObject), ['audio', 'video']);
    assert.equal(el.srcObjectAssignments, 1); assert.equal(el.playCount, 1);
    assert.deepEqual(kinds(m.stream), ['audio', 'video']);
    assert.ok(m.stream.getTracks().includes(v) && m.stream.getTracks().includes(a));
    assert.notEqual(m.stream, el.srcObject, 'canonical and element streams are distinct objects');
    assert.equal(FakeMediaStreamCtor.constructed, 2, 'budget: C + V');
    assert.equal(el.mutedWrites, 0); assert.equal(el.volumeWrites, 0); assert.deepEqual(el.attributeWrites, []);
    assert.deepEqual(warnings, []);
  });

  test(`split mode, ${shape}: video on videoEl, audio on audioEl, each once, 3 SDK streams`, () => {
    const vEl = new FakeVideoEl(), aEl = new FakeVideoEl();
    const { m } = media({ videoEl: vEl, audioEl: aEl });
    feed(m);
    assert.deepEqual(kinds(vEl.srcObject), ['video']);
    assert.deepEqual(kinds(aEl.srcObject), ['audio']);
    assert.equal(vEl.srcObjectAssignments, 1); assert.equal(vEl.playCount, 1);
    assert.equal(aEl.srcObjectAssignments, 1); assert.equal(aEl.playCount, 1);
    assert.deepEqual(kinds(m.stream), ['audio', 'video']);
    assert.equal(FakeMediaStreamCtor.constructed, 3, 'budget: C + V + A');
  });

  test(`headless, ${shape}: stream has both kinds, 1 SDK stream, no element involved`, () => {
    const { m } = media();
    feed(m);
    assert.deepEqual(kinds(m.stream), ['audio', 'video']);
    assert.equal(FakeMediaStreamCtor.constructed, 1, 'budget: C only');
  });

  test(`audio-only headless (audioEl only), ${shape}: audio on audioEl, video live but unrendered`, () => {
    const aEl = new FakeVideoEl();
    const { m } = media({ audioEl: aEl });
    const { v } = feed(m);
    assert.deepEqual(kinds(aEl.srcObject), ['audio']);
    assert.equal(aEl.playCount, 1);
    assert.equal(v.readyState, 'live');
    assert.deepEqual(kinds(m.stream), ['audio', 'video']);
    assert.equal(FakeMediaStreamCtor.constructed, 2, 'budget: C + A');
  });
}

test('video-only shape: videoEl gets [video], no audio anywhere', () => {
  const el = new FakeVideoEl();
  const { m } = media({ videoEl: el });
  arrive(m, 'video');
  assert.deepEqual(kinds(el.srcObject), ['video']);
  assert.equal(m.stream.getAudioTracks().length, 0);
  assert.equal(el.playCount, 1);
});

test('audio-only shape in split: audioEl bound and playing, videoEl bound with an empty stream (one play each)', () => {
  const vEl = new FakeVideoEl(), aEl = new FakeVideoEl();
  const { m } = media({ videoEl: vEl, audioEl: aEl });
  arrive(m, 'audio');
  assert.deepEqual(kinds(aEl.srcObject), ['audio']);
  assert.deepEqual(kinds(vEl.srcObject), []);
  assert.equal(vEl.playCount, 1); assert.equal(aEl.playCount, 1);
});

test('late second track: audio arriving after video is playing joins the live streams without touching the element', () => {
  const el = new FakeVideoEl();
  const { m } = media({ videoEl: el });
  arrive(m, 'video');
  const s = el.srcObject;
  arrive(m, 'audio');
  assert.equal(el.srcObject, s, 'srcObject identity kept');
  assert.equal(el.srcObjectAssignments, 1); assert.equal(el.playCount, 1);
  assert.deepEqual(kinds(el.srcObject), ['audio', 'video']);
});

// ───────────────────────── replace / idempotency ─────────────────────────

test('R-p: the same track attached twice is a no-op (no addTrack, no srcObject write, no play)', () => {
  const el = new FakeVideoEl();
  const { m } = media({ videoEl: el });
  const t = arrive(m, 'video');
  const before = FakeMediaStreamCtor.constructed;
  arrive(m, 'video', t);
  assert.equal(el.srcObject.getTracks().length, 1);
  assert.equal(el.srcObjectAssignments, 1); assert.equal(el.playCount, 1);
  assert.equal(FakeMediaStreamCtor.constructed, before);
});

test('R-d: a same-kind replacement stops the old track and swaps it inside every stream; elements untouched', () => {
  const vEl = new FakeVideoEl(), aEl = new FakeVideoEl();
  const { m } = media({ videoEl: vEl, audioEl: aEl });
  const v1 = arrive(m, 'video'), a1 = arrive(m, 'audio');
  const c = m.stream, vs = vEl.srcObject, as = aEl.srcObject;
  const v2 = arrive(m, 'video'), a2 = arrive(m, 'audio');
  assert.equal(v1.readyState, 'ended'); assert.equal(a1.readyState, 'ended');
  assert.equal(m.stream, c, 'avatarStream identity kept');
  assert.equal(vEl.srcObject, vs); assert.equal(aEl.srcObject, as);
  assert.deepEqual(c.getTracks(), [v2, a2].sort((x, y) => c.getTracks().indexOf(x) - c.getTracks().indexOf(y)));
  assert.deepEqual(vs.getTracks(), [v2]); assert.deepEqual(as.getTracks(), [a2]);
  assert.equal(vEl.srcObjectAssignments, 1); assert.equal(vEl.playCount, 1);
  assert.equal(aEl.srcObjectAssignments, 1); assert.equal(aEl.playCount, 1);
  assert.equal(FakeMediaStreamCtor.constructed, 3, 'zero new streams on recovery');
});

test('replacement of a track without stop() (minimal track) does not throw', () => {
  const { m } = media();
  const t1 = { kind: 'video', id: 'min-1', readyState: 'live' };
  m.attach(t1, []);
  const t2 = makeFakeTrack('video');
  m.attach(t2, []);
  assert.deepEqual(m.stream.getTracks(), [t2]);
  // the invariant sweep must not see t1 (no readyState change is possible without stop())
});

test('idempotent controls: setMuted/setVolume with the current value write nothing; setSinkId on the same sink id skips the call', async () => {
  const el = new FakeVideoEl();
  const { m } = media({ videoEl: el });
  arrive(m, 'video'); arrive(m, 'audio');
  m.setMuted(true); m.setMuted(true);
  assert.equal(el.mutedWrites, 1);
  m.setVolume(0.5); m.setVolume(0.5);
  assert.equal(el.volumeWrites, 1);
  assert.equal(await m.setSinkId('spk-1'), true);
  assert.equal(await m.setSinkId('spk-1'), true);
  assert.deepEqual(el.setSinkIdCalls, ['spk-1']);
});

test('setVideoEl(current) / setAudioEl(current) / setAudioEl(null) with none are no-ops', () => {
  const vEl = new FakeVideoEl();
  const { m } = media({ videoEl: vEl });
  arrive(m, 'video'); arrive(m, 'audio');
  const before = FakeMediaStreamCtor.constructed;
  m.setVideoEl(vEl); m.setAudioEl(null);
  assert.equal(vEl.srcObjectAssignments, 1); assert.equal(vEl.playCount, 1);
  assert.equal(FakeMediaStreamCtor.constructed, before);
});

// ───────────────────────── runtime swaps ─────────────────────────

test('setAudioEl(el) while connected: audio moves live, videoEl keeps srcObject identity, one play on the new element', () => {
  const vEl = new FakeVideoEl(), aEl = new FakeVideoEl();
  const { m } = media({ videoEl: vEl });
  arrive(m, 'video'); arrive(m, 'audio');
  const vs = vEl.srcObject, c = m.stream;
  m.setAudioEl(aEl);
  assertInvariants(m, 'after setAudioEl');
  assert.equal(vEl.srcObject, vs); assert.equal(m.stream, c);
  assert.deepEqual(kinds(vs), ['video']);
  assert.deepEqual(kinds(aEl.srcObject), ['audio']);
  assert.equal(aEl.playCount, 1); assert.equal(vEl.playCount, 1); assert.equal(vEl.srcObjectAssignments, 1);
  assert.equal(m.audioEl, aEl);
  assert.equal(FakeMediaStreamCtor.constructed, 3, 'budget: +1 for the rebind');
  m.setAudioEl(null);
  assertInvariants(m, 'after merge back');
  assert.equal(aEl.srcObject, null); assert.equal(aEl.srcObjectAssignments, 2);
  assert.deepEqual(kinds(vs), ['audio', 'video'], 'audio merged back into the live video stream');
  assert.equal(vEl.playCount, 1, 'no second play on the element that kept playing');
  assert.equal(m.audioEl, null);
});

test('setVideoEl(newEl) while connected: old element released, new one bound once; audioEl untouched in split', () => {
  const v1 = new FakeVideoEl(), v2 = new FakeVideoEl(), aEl = new FakeVideoEl();
  const { m } = media({ videoEl: v1, audioEl: aEl });
  arrive(m, 'video'); arrive(m, 'audio');
  m.setVideoEl(v2);
  assert.equal(v1.srcObject, null); assert.equal(v1.srcObjectAssignments, 2);
  assert.deepEqual(kinds(v2.srcObject), ['video']); assert.equal(v2.playCount, 1);
  assert.equal(aEl.srcObjectAssignments, 1); assert.equal(aEl.playCount, 1);
  assert.equal(m.videoEl, v2);
  m.setVideoEl(null);
  assert.equal(v2.srcObject, null); assert.equal(m.videoEl, null);
  assert.deepEqual(kinds(m.stream), ['audio', 'video'], 'tracks stay in the canonical stream');
});

test('setVideoEl(null) in simple mode drops rendering; setVideoEl(el) later rebinds with both tracks and one play', () => {
  const v1 = new FakeVideoEl(), v2 = new FakeVideoEl();
  const { m } = media({ videoEl: v1 });
  arrive(m, 'video'); arrive(m, 'audio');
  m.setVideoEl(null);
  assert.equal(v1.srcObject, null);
  m.setVideoEl(v2);
  assert.deepEqual(kinds(v2.srcObject), ['audio', 'video']); assert.equal(v2.playCount, 1);
});

test('before any track: setters store the binding; tracks route on arrival with one play', () => {
  const vEl = new FakeVideoEl(), aEl = new FakeVideoEl();
  const { m } = media();
  m.setVideoEl(vEl); m.setAudioEl(aEl);
  assert.equal(vEl.srcObjectAssignments, 0); assert.equal(aEl.srcObjectAssignments, 0);
  arrive(m, 'video'); arrive(m, 'audio');
  assert.deepEqual(kinds(vEl.srcObject), ['video']); assert.deepEqual(kinds(aEl.srcObject), ['audio']);
  assert.equal(vEl.playCount, 1); assert.equal(aEl.playCount, 1);
});

test('R-e: setAudioEl between the video and audio ontrack → audio routes to audioEl on arrival', () => {
  const vEl = new FakeVideoEl(), aEl = new FakeVideoEl();
  const { m } = media({ videoEl: vEl });
  arrive(m, 'video');
  m.setAudioEl(aEl);
  assert.deepEqual(kinds(aEl.srcObject), [], 'bound early with an empty stream');
  arrive(m, 'audio');
  assert.deepEqual(kinds(aEl.srcObject), ['audio']);
  assert.deepEqual(kinds(vEl.srcObject), ['video']);
  assert.equal(aEl.playCount, 1);
});

test('setAudioEl(a) → setAudioEl(b) → setAudioEl(null) in one tick ends merged; a and b released; one play on videoEl', () => {
  const vEl = new FakeVideoEl(), a = new FakeVideoEl(), b = new FakeVideoEl();
  const { m } = media({ videoEl: vEl });
  arrive(m, 'video'); arrive(m, 'audio');
  m.setAudioEl(a); m.setAudioEl(b); m.setAudioEl(null);
  assert.equal(a.srcObject, null); assert.equal(b.srcObject, null);
  assert.deepEqual(kinds(vEl.srcObject), ['audio', 'video']);
  assert.equal(vEl.playCount, 1);
});

test('after teardown: setters store the binding without srcObject writes or play(); the next attach binds fresh', () => {
  const v1 = new FakeVideoEl(), v2 = new FakeVideoEl(), aEl = new FakeVideoEl();
  const { m } = media({ videoEl: v1 });
  arrive(m, 'video'); arrive(m, 'audio');
  m.teardown();
  m.setVideoEl(v2); m.setAudioEl(aEl);
  assert.equal(v2.srcObjectAssignments, 0); assert.equal(v2.playCount, 0); assert.equal(aEl.playCount, 0);
  m.setVideoEl(null); m.setAudioEl(null);   // framework unmount order: never throws
  m.setVideoEl(v2);
  arrive(m, 'video'); arrive(m, 'audio');
  assert.deepEqual(kinds(v2.srcObject), ['audio', 'video']); assert.equal(v2.playCount, 1);
});

test('a foreign stream the app had on the element is replaced, never enumerated or stopped', () => {
  const foreign = makeFakeTrack('video');
  const el = new FakeVideoEl(); el.srcObject = new FakeMediaStream([foreign]);
  const { m } = media();
  arrive(m, 'video');
  m.setVideoEl(el);
  assert.notEqual(el.srcObject.getTracks()[0], foreign);
  assert.equal(foreign.readyState, 'live');
  m.teardown();
  assert.equal(foreign.readyState, 'live');
});

test('swap to an element that is paused after a prior user pause → play() called once for the new binding', () => {
  const v1 = new FakeVideoEl(), v2 = new FakeVideoEl();
  const { m } = media({ videoEl: v1 });
  arrive(m, 'video');
  v2.pause();
  m.setVideoEl(v2);
  assert.equal(v2.playCount, 1); assert.equal(v2.paused, false);
});

// ───────────────────────── audio controls: one sink rule ─────────────────────────

const MODES = {
  simple: () => { const vEl = new FakeVideoEl(); return { cfg: { videoEl: vEl }, sink: vEl, other: null, vEl }; },
  split: () => { const vEl = new FakeVideoEl(), aEl = new FakeVideoEl(); return { cfg: { videoEl: vEl, audioEl: aEl }, sink: aEl, other: vEl, vEl }; },
};

for (const [mode, setup] of Object.entries(MODES)) {
  test(`${mode}: mute/unmute/volume/sink apply to the sink (audioEl ?? videoEl), the other element untouched, and follow a rebind`, async () => {
    const { cfg, sink, other } = setup();
    const { m } = media(cfg);
    arrive(m, 'video'); arrive(m, 'audio');
    m.setMuted(true); assert.equal(sink.muted, true); assert.equal(m.muted, true);
    m.setMuted(false); assert.equal(sink.muted, false); assert.equal(m.muted, false);
    m.setVolume(0.3); assert.equal(sink.volume, 0.3); assert.equal(m.volume, 0.3);
    assert.equal(await m.setSinkId('spk-9'), true); assert.equal(sink.sinkId, 'spk-9');
    if (other) { assert.equal(other.mutedWrites, 0); assert.equal(other.volumeWrites, 0); assert.deepEqual(other.setSinkIdCalls, []); }
    m.setMuted(true);
    // rebind the sink: stored values follow the audio
    const fresh = new FakeVideoEl();
    if (mode === 'split') m.setAudioEl(fresh); else m.setVideoEl(fresh);
    await tick();
    assert.equal(fresh.muted, true); assert.equal(fresh.volume, 0.3); assert.equal(fresh.sinkId, 'spk-9');
    assert.equal(fresh.playCount, 1);
  });

  test(`${mode}: controls called before any track are stored and applied at first bind`, async () => {
    const { cfg, sink } = setup();
    const { m } = media(cfg);
    // The element exists already, so mute/volume/sink land on it right away (no track needed).
    m.setMuted(true); m.setVolume(0.2);
    assert.equal(await m.setSinkId('spk-pre'), true);
    assert.equal(sink.muted, true); assert.equal(sink.volume, 0.2); assert.equal(sink.sinkId, 'spk-pre');
    arrive(m, 'video'); arrive(m, 'audio');
    assert.equal(sink.mutedWrites, 1, 'no redundant re-write at bind');
    assert.equal(sink.volumeWrites, 1);
    assert.deepEqual(sink.setSinkIdCalls, ['spk-pre']);
  });
}

test('headless: mute/volume/sink store without throwing; getters return the stored values; later setAudioEl applies them', async () => {
  const { m, logs } = media();
  m.setMuted(true); m.setVolume(0.4);
  assert.equal(await m.setSinkId('spk-h'), false, 'no sink bound → false');
  assert.ok(logs.some((l) => l.level === 'warn' && /setSinkId unavailable/.test(l.msg)));
  assert.equal(m.muted, true); assert.equal(m.volume, 0.4);
  const aEl = new FakeVideoEl();
  m.setAudioEl(aEl);
  await tick();
  assert.equal(aEl.muted, true); assert.equal(aEl.volume, 0.4); assert.equal(aEl.sinkId, 'spk-h');
});

test('getters fall back to the sink element\'s live value when the SDK never set one (element-level compat)', () => {
  const el = new FakeVideoEl();
  el.muted = true; el.volume = 0.7;
  const { m } = media({ videoEl: el });
  assert.equal(m.muted, true); assert.equal(m.volume, 0.7);
  assert.equal(el.mutedWrites, 1, 'the SDK wrote nothing');
});

test('R-o: setAudioEl(null) in split moves stored audio settings back onto videoEl', async () => {
  const vEl = new FakeVideoEl(), aEl = new FakeVideoEl();
  const { m } = media({ videoEl: vEl, audioEl: aEl });
  arrive(m, 'video'); arrive(m, 'audio');
  m.setMuted(true); m.setVolume(0.1); await m.setSinkId('spk-a');
  assert.equal(vEl.mutedWrites, 0);
  m.setAudioEl(null);
  await tick();
  assert.equal(vEl.muted, true); assert.equal(vEl.volume, 0.1); assert.equal(vEl.sinkId, 'spk-a');
});

test('setMuted coerces to boolean', () => {
  const el = new FakeVideoEl();
  const { m } = media({ videoEl: el });
  m.setMuted(1); assert.equal(el.muted, true);
  m.setMuted(0); assert.equal(el.muted, false);
});

// ───────────────────────── output devices ─────────────────────────

test('setSinkId: element without setSinkId → false + warn log; id still stored and applied on a capable rebind', async () => {
  const el = new FakeVideoEl(); el.setSinkId = undefined;
  const { m, logs } = media({ videoEl: el });
  arrive(m, 'audio');
  assert.equal(await m.setSinkId('spk-2'), false);
  assert.equal(logs.filter((l) => l.level === 'warn').length, 1);
  const capable = new FakeVideoEl();
  m.setVideoEl(capable);
  await tick();
  assert.equal(capable.sinkId, 'spk-2');
});

test('setSinkId: rejected → false + warn log with the message, no retry, previous id replaced by the requested one', async () => {
  const el = new FakeVideoEl();
  const { m, logs } = media({ videoEl: el });
  assert.equal(await m.setSinkId('spk-ok'), true);
  el._sinkIdFailTimes = 1;
  assert.equal(await m.setSinkId('spk-bad'), false);
  assert.deepEqual(el.setSinkIdCalls, ['spk-ok', 'spk-bad']);
  const w = logs.find((l) => l.level === 'warn' && /setSinkId rejected/.test(l.msg));
  assert.equal(w.data.message, 'setSinkId failed');
});

test('setSinkId rejected during a rebind → warn log, nothing thrown, no unhandled rejection', async () => {
  const el = new FakeVideoEl();
  const { m, logs } = media({ videoEl: el });
  await m.setSinkId('spk-1');
  const next = new FakeVideoEl(); next._sinkIdFailTimes = 1;
  m.setVideoEl(next);
  await tick();
  assert.ok(logs.some((l) => l.level === 'warn' && /rejected on rebind/.test(l.msg)));
  assert.equal(next.sinkId, '');
});

test('setSinkId rejection with a non-Error reason is logged as a string', async () => {
  const el = new FakeVideoEl();
  el.setSinkId = () => Promise.reject('nope');
  const { m, logs } = media({ videoEl: el });
  assert.equal(await m.setSinkId('x'), false);
  assert.equal(logs.at(-1).data.message, 'nope');
  const next = new FakeVideoEl(); next.setSinkId = () => Promise.reject('nope2');
  m.setVideoEl(next);
  await tick();
  assert.equal(logs.at(-1).data.message, 'nope2');
});

// ───────────────────────── autoplay ─────────────────────────

test('play() rejects NotAllowedError → one playback_blocked warning per binding with kind, message names startPlayback()', async () => {
  const vEl = new FakeVideoEl(), aEl = new FakeVideoEl();
  vEl.failPlayTimes(1); aEl.failPlayTimes(1);
  const { m, warnings } = media({ videoEl: vEl, audioEl: aEl });
  arrive(m, 'video'); arrive(m, 'audio');
  await tick();
  assert.deepEqual(warnings.map((w) => w.kind).sort(), ['audio', 'video']);
  for (const w of warnings) { assert.equal(w.code, 'playback_blocked'); assert.match(w.message, /session\.startPlayback\(\)/); assert.equal(typeof w.message, 'string'); }
  assert.deepEqual(kinds(m.stream), ['audio', 'video'], 'tracks attached even though playback is blocked');
});

test('startPlayback: false while blocked, true after the gesture; skips elements already playing', async () => {
  const el = new FakeVideoEl(); el.failPlayTimes(2);
  const { m, warnings, logs } = media({ videoEl: el });
  arrive(m, 'video');
  await tick();
  assert.equal(warnings.length, 1);
  assert.equal(await m.resumePlayback(), false, 'second rejection');
  assert.equal(warnings.length, 1, 'no second warning from resumePlayback');
  assert.ok(logs.some((l) => l.level === 'debug' && /rejected again/.test(l.msg)));
  assert.equal(await m.resumePlayback(), true);
  assert.equal(el.playCount, 3);
  assert.equal(await m.resumePlayback(), true);
  assert.equal(el.playCount, 3, 'already playing → no play() call');
});

test('startPlayback in split mode: retries only the element that is still paused; true once both play', async () => {
  const vEl = new FakeVideoEl(), aEl = new FakeVideoEl();
  aEl.failPlayTimes(2);
  const { m, warnings } = media({ videoEl: vEl, audioEl: aEl });
  arrive(m, 'video'); arrive(m, 'audio');
  await tick();
  assert.deepEqual(warnings.map((w) => w.kind), ['audio'], 'only the audio element was blocked');
  assert.equal(await m.resumePlayback(), false);
  assert.equal(vEl.playCount, 1, 'video element was already playing → not retried');
  assert.equal(await m.resumePlayback(), true);
  assert.equal(aEl.playCount, 3);
});

test('startPlayback: false when nothing is bound (before tracks, headless, after teardown)', async () => {
  const el = new FakeVideoEl();
  const { m } = media({ videoEl: el });
  assert.equal(await m.resumePlayback(), false, 'before tracks');
  arrive(m, 'video');
  assert.equal(await m.resumePlayback(), true);
  m.teardown();
  assert.equal(await m.resumePlayback(), false, 'after teardown');
  const { m: headless } = media();
  arrive(headless, 'video');
  assert.equal(await headless.resumePlayback(), false, 'headless');
});

test('R-h: play() rejecting AbortError (or anything else) → no warning, debug log only', async () => {
  const el = new FakeVideoEl(); el.failPlayTimes(1, 'AbortError');
  const { m, warnings, logs } = media({ videoEl: el });
  arrive(m, 'video');
  await tick();
  assert.deepEqual(warnings, []);
  const d = logs.find((l) => l.level === 'debug' && /play\(\) on the video element rejected/.test(l.msg));
  assert.equal(d.data.name, 'AbortError');
});

test('play() throwing synchronously is caught the same way; play() returning a non-promise is fine', () => {
  const thrower = { srcObject: null, play() { const e = new Error('sync'); e.name = 'NotAllowedError'; throw e; } };
  const { m, warnings } = media({ videoEl: thrower });
  arrive(m, 'video');
  assert.equal(warnings.length, 1); assert.equal(warnings[0].kind, 'video');
  const plain = { srcObject: null, play() { return undefined; } };
  const { m: m2, warnings: w2 } = media({ videoEl: plain });
  arrive(m2, 'video');
  assert.deepEqual(w2, []);
  assert.ok(plain.srcObject);
});

test('play() rejecting with a non-Error reason → debug log with String(reason)', async () => {
  const el = { srcObject: null, play() { return Promise.reject('denied'); } };
  const { m, logs } = media({ videoEl: el });
  arrive(m, 'video');
  await tick();
  assert.equal(logs.at(-1).data.message, 'denied');
  assert.equal(logs.at(-1).data.name, undefined);
});

// ───────────────────────── minimal element / feature checks ─────────────────────────

test('a bare { srcObject, play } object binds; mute/volume/sink degrade to no-ops on it', async () => {
  const bare = { srcObject: null, play() { return Promise.resolve(); } };
  const { m } = media({ videoEl: bare });
  arrive(m, 'video'); arrive(m, 'audio');
  assert.deepEqual(kinds(bare.srcObject), ['audio', 'video']);
  m.setMuted(true); m.setVolume(0.5);
  assert.equal('muted' in bare, false); assert.equal('volume' in bare, false);
  assert.equal(await m.setSinkId('spk'), false);
  assert.equal(m.muted, true); assert.equal(m.volume, 0.5, 'stored values are still reported');
  assert.equal(await m.resumePlayback(), true, 'paused is undefined → play() attempted → resolves');
});

// ───────────────────────── fallback (no MediaStream constructor) ─────────────────────────

test('no MediaStream constructor: reuses the receiver stream as C and V, debug-logs once, still routes both kinds when they share a stream', () => {
  const prev = globalThis.MediaStream; delete globalThis.MediaStream;
  try {
    const el = new FakeVideoEl();
    const logs = [];
    const m = new AvatarMedia({ videoEl: el, log: (level, msg) => logs.push({ level, msg }) }); live.push(m);
    const v = makeFakeTrack('video'), a = makeFakeTrack('audio');
    const shared = new FakeMediaStream([v, a]);
    m.attach(v, [shared]);
    assert.equal(m.stream, shared); assert.equal(el.srcObject, shared);
    assert.equal(logs.filter((l) => /test-only fallback/.test(l.msg)).length, 1);
    m.attach(a, [shared]);   // already in C → no addTrack path
    assert.deepEqual(kinds(el.srcObject), ['audio', 'video']);
    assert.equal(el.playCount, 1);
    // rebind in fallback mode shares C again
    const el2 = new FakeVideoEl();
    m.setVideoEl(el2);
    assert.equal(el2.srcObject, shared);
    assert.equal(FakeMediaStreamCtor.constructed, 0);
  } finally { if (prev !== undefined) globalThis.MediaStream = prev; }
});

test('no MediaStream constructor and no receiver stream → attach throws bad_request naming attach(track, streams)', () => {
  const prev = globalThis.MediaStream; delete globalThis.MediaStream;
  try {
    const m = new AvatarMedia({ videoEl: new FakeVideoEl() }); live.push(m);
    assert.throws(() => m.attach(makeFakeTrack('video'), []), (e) => e.code === 'bad_request' && /attach\(track, streams\)/.test(e.detail));
    assert.throws(() => m.attach(makeFakeTrack('video')), (e) => e.code === 'bad_request');
    assert.equal(m.stream, null);
  } finally { if (prev !== undefined) globalThis.MediaStream = prev; }
});

// ───────────────────────── teardown ─────────────────────────

test('teardown: stops every track, nulls srcObject on bound elements, keeps bindings and stored settings; idempotent', async () => {
  const vEl = new FakeVideoEl(), aEl = new FakeVideoEl();
  const { m } = media({ videoEl: vEl, audioEl: aEl });
  const v = arrive(m, 'video'), a = arrive(m, 'audio');
  m.setMuted(true); m.setVolume(0.6); await m.setSinkId('spk-t');
  m.teardown();
  assert.equal(v.readyState, 'ended'); assert.equal(a.readyState, 'ended');
  assert.equal(vEl.srcObject, null); assert.equal(aEl.srcObject, null);
  assert.equal(m.stream, null);
  assert.equal(m.videoEl, vEl); assert.equal(m.audioEl, aEl);
  assert.equal(m.muted, true); assert.equal(m.volume, 0.6);
  const writes = vEl.srcObjectAssignments;
  m.teardown();
  assert.equal(vEl.srcObjectAssignments, writes, 'second teardown writes nothing');
  // next connect: fresh streams, settings re-applied without re-writes (values already on the elements)
  arrive(m, 'video'); arrive(m, 'audio');
  assert.equal(vEl.playCount, 2); assert.equal(aEl.playCount, 2);
  assert.equal(aEl.muted, true); assert.equal(aEl.volume, 0.6); assert.equal(aEl.sinkId, 'spk-t');
});

test('teardown before any track is a no-op; teardown headless stops tracks without touching elements', () => {
  const { m } = media();
  m.teardown();
  const t = arrive(m, 'video');
  m.teardown();
  assert.equal(t.readyState, 'ended'); assert.equal(m.stream, null);
});

test('teardown with a minimal track lacking stop() does not throw', () => {
  const { m } = media();
  m.attach({ kind: 'audio', id: 'min', readyState: 'live' }, []);
  m.teardown();
  assert.equal(m.stream, null);
});

test('teardown when only one of two elements was bound (video bound, audio configured after teardown) nulls just that one', () => {
  const vEl = new FakeVideoEl(), aEl = new FakeVideoEl();
  const { m } = media({ videoEl: vEl });
  arrive(m, 'video');
  m.setAudioEl(aEl);
  m.teardown();
  assert.equal(vEl.srcObject, null);
  assert.equal(aEl.srcObjectAssignments, 2, 'audioEl was bound on setAudioEl, so it is cleared too');
  const { m: m2 } = media({ videoEl: new FakeVideoEl() });
  arrive(m2, 'video');
  m2.setVideoEl(null);
  const late = new FakeVideoEl();
  m2._audioEl = late;   // configured but unbound audio element (no _a)
  m2.teardown();
  assert.equal(late.srcObjectAssignments, 0, 'an unbound element is never written');
});

// ───────────────────────── isolation between instances ─────────────────────────

test('two instances never share tracks or streams; controls are independent', async () => {
  const e1 = new FakeVideoEl(), e2 = new FakeVideoEl();
  const { m: m1 } = media({ videoEl: e1 });
  const { m: m2 } = media({ videoEl: e2 });
  const v1 = arrive(m1, 'video'), a1 = arrive(m1, 'audio');
  arrive(m2, 'video'); arrive(m2, 'audio');
  assert.ok(!m2.stream.getTracks().includes(v1) && !m2.stream.getTracks().includes(a1));
  assert.ok(!e2.srcObject.getTracks().includes(a1));
  m1.setMuted(true); await m1.setSinkId('spk-1');
  assert.equal(e2.muted, false); assert.deepEqual(e2.setSinkIdCalls, []);
  m1.teardown();
  assert.equal(m2.stream.getTracks().every((t) => t.readyState === 'live'), true);
});

test('two instances handed the same element (app error): no throw, last writer wins', () => {
  const el = new FakeVideoEl();
  const { m: m1 } = media({ videoEl: el });
  const { m: m2 } = media({ videoEl: el });
  arrive(m1, 'video');
  arrive(m2, 'video');
  assert.equal(el.srcObject, m2._v);
  m1.teardown();   // m1 nulls the shared element; m2's stream is intact but no longer displayed
  assert.equal(el.srcObject, null);
  assert.deepEqual(kinds(m2.stream), ['video']);
  m2.teardown();
});

// ───────────────────────── logging is opt-in ─────────────────────────

test('nothing logs and nothing warns when logger / onWarning are unset (defaults are silent no-ops)', async () => {
  const el = new FakeVideoEl(); el.failPlayTimes(1); el.setSinkId = undefined;
  const m = new AvatarMedia({ videoEl: el, mediaStreamConstructor: FakeMediaStreamCtor }); live.push(m);
  arrive(m, 'video');
  await tick();
  assert.equal(await m.setSinkId('x'), false);
  assert.equal(await m.resumePlayback(), true);
});
