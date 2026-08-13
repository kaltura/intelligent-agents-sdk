import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNoiseSuppressor } from '../../src/experience/noise-suppressor.js';
import { FakeAudioContext, FakeAudioWorkletNode, FakeMediaStream } from '../fakes/rtc.js';

/**
 * Unit-tests the optional AudioWorklet noise-suppressor plugin in isolation (no
 * KalturaAvatarSession involved) — proving it conforms to the `cfg.noiseProcessor`
 * interface `(stream) => Promise<{stream,stop}>` against the AudioWorklet fakes.
 * End-to-end wiring through a real session (constructor → connect() → ASR sender)
 * is covered by resilience.test.js's `noiseProcessor:` suite, using this same plugin
 * as one of the conforming implementations under test.
 */

function newCtx() {
  const ctx = new FakeAudioContext();
  return ctx;
}

test('createNoiseSuppressor: registers the AudioWorklet module exactly once per AudioContext', async () => {
  FakeAudioWorkletNode.reset();
  const ctx = newCtx();
  const suppress = createNoiseSuppressor({ audioContext: ctx, audioWorkletNodeConstructor: FakeAudioWorkletNode });
  const raw1 = new FakeMediaStream([{ kind: 'audio' }]);
  const raw2 = new FakeMediaStream([{ kind: 'audio' }]);
  await suppress(raw1);
  await suppress(raw2);
  assert.equal(ctx._addedModules.length, 1, 'addModule must not be called twice for the same context');
});

test('createNoiseSuppressor: wires source -> AudioWorkletNode -> destination and returns the destination stream', async () => {
  FakeAudioWorkletNode.reset();
  const ctx = newCtx();
  const suppress = createNoiseSuppressor({ audioContext: ctx, audioWorkletNodeConstructor: FakeAudioWorkletNode });
  const raw = new FakeMediaStream([{ kind: 'audio' }]);
  const result = await suppress(raw);
  assert.ok(result.stream, 'must return a {stream, stop} shape');
  assert.equal(typeof result.stop, 'function');
  assert.equal(FakeAudioContext.lastSourceInput, raw, 'createMediaStreamSource must be called with the raw stream');
  assert.equal(FakeAudioWorkletNode.instances.length, 1);
  assert.deepEqual(FakeAudioWorkletNode.lastArgs.name, 'kaltura-noise-gate');
});

test('createNoiseSuppressor: passes thresholdDb/attackMs/releaseMs/floorAdaptMs through as parameterData', async () => {
  FakeAudioWorkletNode.reset();
  const ctx = newCtx();
  const suppress = createNoiseSuppressor({
    audioContext: ctx, audioWorkletNodeConstructor: FakeAudioWorkletNode,
    thresholdDb: -40, attackMs: 10, releaseMs: 200, floorAdaptMs: 3000,
  });
  await suppress(new FakeMediaStream([{ kind: 'audio' }]));
  assert.deepEqual(FakeAudioWorkletNode.lastArgs.options.parameterData, {
    thresholdDb: -40, attackMs: 10, releaseMs: 200, floorAdaptMs: 3000,
  });
});

test('createNoiseSuppressor: defaults thresholdDb/attackMs/releaseMs/floorAdaptMs when unset', async () => {
  FakeAudioWorkletNode.reset();
  const ctx = newCtx();
  const suppress = createNoiseSuppressor({ audioContext: ctx, audioWorkletNodeConstructor: FakeAudioWorkletNode });
  await suppress(new FakeMediaStream([{ kind: 'audio' }]));
  assert.deepEqual(FakeAudioWorkletNode.lastArgs.options.parameterData, {
    thresholdDb: -50, attackMs: 5, releaseMs: 150, floorAdaptMs: 2000,
  });
});

test('createNoiseSuppressor: stop() disconnects the node and stops both the destination and raw tracks', async () => {
  FakeAudioWorkletNode.reset();
  const ctx = newCtx();
  const suppress = createNoiseSuppressor({ audioContext: ctx, audioWorkletNodeConstructor: FakeAudioWorkletNode });
  const raw = new FakeMediaStream([{ kind: 'audio' }]);
  const rawTrack = raw.getAudioTracks()[0];
  const { stream, stop } = await suppress(raw);
  const destTrack = stream.getAudioTracks()[0];
  stop();
  assert.equal(FakeAudioWorkletNode.instances[0].disconnected, true);
  assert.equal(rawTrack.readyState, 'ended', 'the raw (pre-processing) track must be stopped');
  assert.equal(destTrack.readyState, 'ended', 'the destination (processed) track must be stopped');
});

test('createNoiseSuppressor: stop() still stops every track even when an earlier cleanup step throws', async () => {
  FakeAudioWorkletNode.reset();
  const ctx = newCtx();
  // Make the source's disconnect() throw — stop()'s per-step try/catch (noise-suppressor.js:141-145)
  // must not let that stop the LATER steps (node.disconnect(), track.stop()) from running.
  const realCreateSource = ctx.createMediaStreamSource.bind(ctx);
  ctx.createMediaStreamSource = (stream) => {
    const source = realCreateSource(stream);
    source.disconnect = () => { throw new Error('disconnect boom'); };
    return source;
  };
  const suppress = createNoiseSuppressor({ audioContext: ctx, audioWorkletNodeConstructor: FakeAudioWorkletNode });
  const raw = new FakeMediaStream([{ kind: 'audio' }]);
  const rawTrack = raw.getAudioTracks()[0];
  const { stream, stop } = await suppress(raw);
  const destTrack = stream.getAudioTracks()[0];
  assert.doesNotThrow(stop, 'a throwing source.disconnect() must not propagate out of stop()');
  assert.equal(FakeAudioWorkletNode.instances[0].disconnected, true, 'node.disconnect() still ran after the source-disconnect throw');
  assert.equal(rawTrack.readyState, 'ended', 'raw track still stopped after the source-disconnect throw');
  assert.equal(destTrack.readyState, 'ended', 'destination track still stopped after the source-disconnect throw');
});

test('createNoiseSuppressor: throws a clear error when AudioWorklet support is unavailable', async () => {
  const suppress = createNoiseSuppressor({ audioContext: {}, audioWorkletNodeConstructor: FakeAudioWorkletNode });
  await assert.rejects(() => suppress(new FakeMediaStream([{ kind: 'audio' }])), /AudioWorklet/);
});

test('createNoiseSuppressor: two independent contexts each get their own module registration', async () => {
  FakeAudioWorkletNode.reset();
  const ctxA = newCtx();
  const ctxB = newCtx();
  const suppressA = createNoiseSuppressor({ audioContext: ctxA, audioWorkletNodeConstructor: FakeAudioWorkletNode });
  const suppressB = createNoiseSuppressor({ audioContext: ctxB, audioWorkletNodeConstructor: FakeAudioWorkletNode });
  await suppressA(new FakeMediaStream([{ kind: 'audio' }]));
  await suppressB(new FakeMediaStream([{ kind: 'audio' }]));
  assert.equal(ctxA._addedModules.length, 1);
  assert.equal(ctxB._addedModules.length, 1);
});
