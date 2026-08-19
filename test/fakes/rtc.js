/**
 * FakeRTCPeerConnection + FakeVideoEl + fakeGetUserMedia — minimal WebRTC
 * doubles so the connect machine runs in plain Node. The peer connection
 * resolves offers/answers synchronously and lets a test fire `ontrack`; the
 * video element lets a test control the `canplay`/`readyState` gate.
 */
export class FakeRTCPeerConnection {
  /** @param {object} [config] */
  constructor(config) {
    this.config = config;
    this.iceConnectionState = 'new';
    this.iceGatheringState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.transceivers = [];
    this.tracks = [];
    this.onicecandidate = null;
    this.ontrack = null;
    this.oniceconnectionstatechange = null;
    this.onicegatheringstatechange = null;
    this.closed = false;
    FakeRTCPeerConnection.instances.push(this);
  }
  addTransceiver(kind, opts) {
    const t = { kind, ...opts, setCodecPreferences(codecs) { this._codecPrefs = codecs; } };
    this.transceivers.push(t);
    return t;
  }
  addTrack(track, stream) {
    this.tracks.push({ track, stream });
    return this._makeSender(track);
  }
  _makeSender(track) {
    const sender = {
      track,
      _params: { encodings: [{}] },
      replaceTrack(newTrack) { sender.track = newTrack; return Promise.resolve(); },
      getParameters() { return sender._params; },
      setParameters(p) { sender._params = p; return Promise.resolve(); },
    };
    (this._senders || (this._senders = [])).push(sender);
    return sender;
  }
  getSenders() { return this._senders || []; }
  getTransceivers() { return this.transceivers; }
  /** Test helper: set the next getStats() report (connectivity-beacon tests). @param {Array<object>} entries */
  setStats(entries) { this._statsEntries = entries; }
  async getStats() { return new Map((this._statsEntries || []).map((s, i) => [s.id || String(i), s])); }
  async createOffer() { return { type: 'offer', sdp: 'v=0\r\nfake-offer\r\n' }; }
  async setLocalDescription(d) {
    this.localDescription = d;
    // Model trickle ICE: emit one relay candidate, then the end-of-candidates null.
    queueMicrotask(() => {
      this.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 2 1.2.3.4 3478 typ relay', sdpMid: '0', sdpMLineIndex: 0 } });
      this.onicecandidate?.({ candidate: null });
    });
  }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
    // Model the STV WHEP answer delivering recvonly media: fire ontrack on the
    // next tick (the ASR peer has no recvonly video transceiver, so it won't).
    if (!this._autoTrackDisabled && this.transceivers.some((t) => t.kind === 'video' && t.direction === 'recvonly')) {
      queueMicrotask(() => { this.fireTrack('video'); this.fireTrack('audio'); });
    }
  }
  /** Test helper: suppress the auto ontrack (to test the playability gate manually). */
  disableAutoTrack() { this._autoTrackDisabled = true; return this; }
  async addIceCandidate() { /* no-op */ }
  /** ICE restart (R7): real RTCPeerConnection re-gathers candidates; here just record it. */
  restartIce() { this.iceRestarted = (this.iceRestarted || 0) + 1; }
  close() { this.closed = true; }
  /** Test helper: simulate a media track arriving. */
  fireTrack(kind = 'video') { this.ontrack?.({ track: { kind }, streams: [new FakeMediaStream([{ kind }])] }); }
  /** Test helper: drive ICE state. */
  setIce(state) { this.iceConnectionState = state; this.oniceconnectionstatechange?.(); }
  /** Test helper: drive ICE gathering state (zero-candidates fail-fast tests). */
  setGathering(state) { this.iceGatheringState = state; this.onicegatheringstatechange?.(); }
}
FakeRTCPeerConnection.instances = [];
FakeRTCPeerConnection.reset = () => { FakeRTCPeerConnection.instances = []; };

function makeFakeTrack(kind) {
  const t = {
    kind, enabled: true, readyState: 'live', onmute: null, onunmute: null,
    stop() { this.readyState = 'ended'; },
    fireMute() { this.onmute?.(); },
    fireUnmute() { this.onunmute?.(); },
    clone() { return makeFakeTrack(kind); },
  };
  return t;
}

export class FakeMediaStream {
  constructor(tracks = [{ kind: 'audio' }]) {
    this._tracks = tracks.map((t) => makeFakeTrack(t.kind));
  }
  getTracks() { return this._tracks; }
  getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio'); }
  getVideoTracks() { return this._tracks.filter((t) => t.kind === 'video'); }
}

/** Fake `RTCRtpReceiver.getCapabilities()` double (codec-preference tests). */
export const FakeRTCRtpReceiver = {
  getCapabilities(kind) {
    if (kind === 'video') {
      return { codecs: [
        { mimeType: 'video/VP8' }, { mimeType: 'video/VP9' }, { mimeType: 'video/H264' },
      ] };
    }
    if (kind === 'audio') return { codecs: [{ mimeType: 'audio/opus' }] };
    return null;
  },
};

/** Fake `MediaStream` constructor double (Web Audio's `createMediaStreamSource` needs one). */
export class FakeMediaStreamCtor {
  constructor(tracks = []) { this._tracks = tracks; }
  getTracks() { return this._tracks; }
}

export class FakeAnalyserNode {
  constructor() { this.fftSize = 32; this.frequencyBinCount = 16; this._vol = 0; }
  getByteFrequencyData(arr) { arr.fill(Math.floor(this._vol / 16)); }
  connect() { /* no-op */ }
  disconnect() { /* no-op */ }
}

export class FakeAudioContext {
  constructor() {
    /** Test helper: records the module URL(s) passed to `audioWorklet.addModule()`. */
    this._addedModules = [];
    this.audioWorklet = { addModule: async (url) => { this._addedModules.push(url); } };
  }
  createMediaStreamSource(stream) { FakeAudioContext.lastSourceInput = stream; return { connect() { /* no-op */ }, disconnect() { /* no-op */ } }; }
  createAnalyser() { const a = new FakeAnalyserNode(); FakeAudioContext.lastAnalyser = a; return a; }
  /** Web Audio node whose `.stream` is what a noise-processor plugin re-exports as the send track. */
  createMediaStreamDestination() { return { connect() { /* no-op */ }, disconnect() { /* no-op */ }, stream: new FakeMediaStream([{ kind: 'audio' }]) }; }
}

/** Fake `AudioWorkletNode` double (noise-suppressor plugin tests) — records ctor args, no real DSP. */
export class FakeAudioWorkletNode {
  constructor(context, name, options) {
    FakeAudioWorkletNode.lastArgs = { context, name, options };
    FakeAudioWorkletNode.instances.push(this);
    this.connected = [];
    this.disconnected = false;
  }
  connect(dest) { this.connected.push(dest); }
  disconnect() { this.disconnected = true; }
}
FakeAudioWorkletNode.instances = [];
FakeAudioWorkletNode.reset = () => { FakeAudioWorkletNode.instances = []; FakeAudioWorkletNode.lastArgs = null; };

/** A video element double. `autoCanPlay:false` makes the test fire canplay manually (greeting-gate test). */
export class FakeVideoEl {
  constructor({ autoCanPlay = true } = {}) {
    this.srcObject = null;
    this.readyState = autoCanPlay ? 4 : 0;
    this._auto = autoCanPlay;
    /** @type {Map<string,Function[]>} */ this._listeners = new Map();
    this.played = false;
    this.playCount = 0;
  }
  addEventListener(ev, fn) { (this._listeners.get(ev) || this._listeners.set(ev, []).get(ev)).push(fn); }
  play() { this.played = true; this.playCount += 1; return Promise.resolve(); }
  /** Test helper: signal the video is now playable. */
  fireCanPlay() { this.readyState = 4; (this._listeners.get('canplay') || []).forEach((fn) => fn()); }
  /** @param {string} deviceId */
  setSinkId(deviceId) {
    if (this._sinkIdFailTimes > 0) { this._sinkIdFailTimes--; return Promise.reject(new Error('setSinkId failed')); }
    this.sinkId = deviceId;
    return Promise.resolve();
  }
}

/** @param {object} [opts] */
export function fakeGetUserMedia(opts = {}) {
  /** Test helper: every constraints object this fake was called with, in call order. */
  const calls = [];
  const fn = async (constraints) => {
    calls.push(constraints);
    if (opts.deny) {
      const err = new Error('Permission denied');
      err.name = opts.name || 'NotAllowedError';
      throw err;
    }
    return new FakeMediaStream([{ kind: 'audio' }]);
  };
  fn.calls = calls;
  return fn;
}
