/**
 * noise-suppressor — an optional, pure-browser-native `AudioWorklet` noise-gate plugin
 * implementing the `cfg.noiseProcessor` interface documented on {@link KalturaAvatarSession}
 * (`(stream) => Promise<MediaStream|{stream,stop}>`). It is the lightweight, zero-dependency
 * Tier-2 DSP the SDK ships as a real, usable implementation, and doubles as the end-to-end
 * test vehicle proving the pluggable-DSP slot actually works.
 *
 * BYO-DSP is still the point: this is ONE conforming implementation, not the only one. An
 * app can equally pass a third-party processor (dynamically imported so apps that don't
 * use it never load it), or its own bespoke one, to `cfg.noiseProcessor` — anything shaped
 * `(stream) => Promise<MediaStream|{stream,stop}>` works.
 *
 * Runs as an adaptive RMS noise gate (attack/release-smoothed envelope, adaptive noise-floor
 * tracking) — NOT spectral subtraction or ML denoising (that's a heavier Tier-2 DSP approach,
 * and why this ships as an optional plugin rather than the default). It
 * attenuates steady-state background noise (fan hum, room tone) between speech — the
 * "more-advanced-than-nothing, still genuinely lightweight" niche the SDK can own without
 * bundling a model or a third-party dependency.
 *
 * Optional plugin: a separately-importable function with no effect on `KalturaAvatarSession`
 * or any other SDK surface until constructed and passed as `cfg.noiseProcessor` — mirrors
 * `./experience/presenter`.
 *
 * @example
 * import { KalturaAvatarSession } from '@kaltura/intelligent-agents/experience';
 * import { createNoiseSuppressor } from '@kaltura/intelligent-agents/experience/noise-suppressor';
 * const session = new KalturaAvatarSession({
 *   token, …appInit, videoEl, socketFactory,
 *   noiseProcessor: createNoiseSuppressor({ thresholdDb: -50 }),
 * });
 */
import { KalturaError } from '../core/errors.js';

const PROCESSOR_NAME = 'kaltura-noise-gate';

// AudioWorkletProcessor source, registered via a Blob URL — no separate asset file to
// resolve through a bundler (this package ships with no build step). Executes on the
// dedicated audio-render thread; `sampleRate`/`registerProcessor`/`AudioWorkletProcessor`
// are AudioWorklet globals, not window/Node globals — this string only ever runs inside
// `audioContext.audioWorklet.addModule()`.
const WORKLET_SOURCE = `
class KalturaNoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'thresholdDb', defaultValue: -50, minValue: -100, maxValue: 0 },
      { name: 'attackMs', defaultValue: 5, minValue: 0, maxValue: 200 },
      { name: 'releaseMs', defaultValue: 150, minValue: 0, maxValue: 2000 },
      { name: 'floorAdaptMs', defaultValue: 2000, minValue: 100, maxValue: 10000 },
    ];
  }
  constructor() {
    super();
    this._envelope = 0;      // smoothed gain envelope, 0..1
    this._noiseFloor = 1e-6; // adaptive RMS noise-floor estimate (linear)
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const thresholdDb = parameters.thresholdDb[0];
    const attackMs = parameters.attackMs[0];
    const releaseMs = parameters.releaseMs[0];
    const floorAdaptMs = parameters.floorAdaptMs[0];
    const thresholdLin = Math.pow(10, thresholdDb / 20);
    const attackCoeff = Math.exp(-1 / (sampleRate * Math.max(attackMs, 1) / 1000));
    const releaseCoeff = Math.exp(-1 / (sampleRate * Math.max(releaseMs, 1) / 1000));
    const floorCoeff = Math.exp(-1 / (sampleRate * Math.max(floorAdaptMs, 100) / 1000));
    for (let ch = 0; ch < input.length; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      for (let i = 0; i < inCh.length; i++) {
        const sample = inCh[i];
        const rect = Math.abs(sample);
        // Adapt the noise floor only while the signal is already near-quiet, so real
        // speech doesn't drag the floor up and defeat the gate.
        if (rect < this._noiseFloor * 3 || this._noiseFloor < 1e-6) {
          this._noiseFloor = floorCoeff * this._noiseFloor + (1 - floorCoeff) * rect;
        }
        const gateOpen = rect > Math.max(thresholdLin, this._noiseFloor * 4);
        const targetGain = gateOpen ? 1 : 0;
        const coeff = targetGain > this._envelope ? attackCoeff : releaseCoeff;
        this._envelope = coeff * this._envelope + (1 - coeff) * targetGain;
        outCh[i] = sample * this._envelope;
      }
    }
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', KalturaNoiseGateProcessor);
`;

// Module-level by necessity, not convenience: an AudioContext can be shared across
// multiple createNoiseSuppressor() calls (e.g. one mic context reused per call), and
// addModule() throws if called twice on the same context — this WeakSet is what lets
// two independent suppressor instances safely share a context without a double-register
// crash. Keying by AudioContext (not by instance) means it self-clears via GC, never leaks.
const registeredContexts = new WeakSet();

/**
 * Build a `cfg.noiseProcessor`-conforming function backed by the AudioWorklet noise gate
 * above. Every option below is injectable so this runs headlessly under `node:test` with
 * fakes (see `test/fakes/rtc.js`), matching the rest of the SDK's constructor-injection style.
 * @param {object} [opts]
 * @param {AudioContext} [opts.audioContext]  Reuse an existing context (e.g. share the one
 *   already driving `cfg.getAudioContext`'s VAD tap) instead of creating a dedicated one.
 * @param {()=>AudioContext} [opts.getAudioContext]  Factory for the context, called once per
 *   `noiseProcessor(stream)` invocation if `audioContext` isn't supplied. Default `() => new AudioContext()`.
 * @param {typeof AudioWorkletNode} [opts.audioWorkletNodeConstructor]  Default `globalThis.AudioWorkletNode`.
 * @param {number} [opts.thresholdDb]   Gate closes below this level (dBFS). Default -50.
 * @param {number} [opts.attackMs]      Gate-open ramp, avoids a click on speech onset. Default 5ms.
 * @param {number} [opts.releaseMs]     Gate-close ramp, avoids chopping word tails. Default 150ms.
 * @param {number} [opts.floorAdaptMs]  Noise-floor adaptation time constant. Default 2000ms.
 * @returns {(stream:any)=>Promise<{stream:any, stop:()=>void}>}
 */
export function createNoiseSuppressor(opts = {}) {
  const getAudioContext = opts.getAudioContext || (() => opts.audioContext || new AudioContext());
  const AudioWorkletNodeCtor = opts.audioWorkletNodeConstructor || globalThis.AudioWorkletNode;

  return async function noiseProcessor(rawStream) {
    const ctx = getAudioContext();
    if (!ctx?.audioWorklet || typeof AudioWorkletNodeCtor !== 'function') {
      throw new KalturaError({ type: 'about:blank', title: 'no AudioWorklet support', code: 'bad_request', detail: 'createNoiseSuppressor() requires AudioWorklet support — inject audioContext/audioWorkletNodeConstructor for non-browser use.' });
    }
    if (!registeredContexts.has(ctx)) {
      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      registeredContexts.add(ctx);
    }
    const source = ctx.createMediaStreamSource(rawStream);
    const node = new AudioWorkletNodeCtor(ctx, PROCESSOR_NAME, {
      parameterData: {
        thresholdDb: opts.thresholdDb ?? -50,
        attackMs: opts.attackMs ?? 5,
        releaseMs: opts.releaseMs ?? 150,
        floorAdaptMs: opts.floorAdaptMs ?? 2000,
      },
    });
    const dest = ctx.createMediaStreamDestination();
    source.connect(node);
    node.connect(dest);
    return {
      stream: dest.stream,
      stop() {
        try { source.disconnect(); } catch { /* */ }
        try { node.disconnect(); } catch { /* */ }
        try { dest.stream.getTracks().forEach((t) => t.stop()); } catch { /* */ }
        try { rawStream.getTracks().forEach((t) => t.stop()); } catch { /* */ }
      },
    };
  };
}
