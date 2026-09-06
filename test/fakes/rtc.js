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
    // Real RTCRtpTransceivers always carry a sender (track-less until replaceTrack) —
    // the deferred-mic path relies on `.sender` of a sendonly audio transceiver.
    const t = { kind, ...opts, sender: this._makeSender(null), setCodecPreferences(codecs) { this._codecPrefs = codecs; } };
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
  /**
   * Test helper: simulate a media track arriving. e.track and e.streams[0] share the same
   * track instance, matching real RTCPeerConnection.
   * @param {string} [kind]
   * @param {{ stream?: FakeMediaStream | null, track?: object }} [opts] `stream` overrides
   *   `e.streams[0]` (pass `null` for an empty `e.streams`, i.e. a server that sends no msid);
   *   `track` reuses an existing fake track (same-track-twice tests).
   */
  fireTrack(kind = 'video', opts = {}) {
    const track = opts.track || makeFakeTrack(kind);
    const streams = opts.stream === null ? [] : [opts.stream || new FakeMediaStream([track])];
    this.ontrack?.({ track, streams });
  }
  /** Test helper: drive ICE state. */
  setIce(state) { this.iceConnectionState = state; this.oniceconnectionstatechange?.(); }
  /** Test helper: drive ICE gathering state (zero-candidates fail-fast tests). */
  setGathering(state) { this.iceGatheringState = state; this.onicegatheringstatechange?.(); }
}
FakeRTCPeerConnection.instances = [];
FakeRTCPeerConnection.reset = () => { FakeRTCPeerConnection.instances = []; };

let trackSeq = 0;
/** Build a fake MediaStreamTrack. Exported so tests can hand the same instance to two `attach()` calls. @param {string} kind */
export function makeFakeTrack(kind) {
  const t = {
    id: `${kind}-${++trackSeq}`, kind, enabled: true, muted: false, readyState: 'live',
    onmute: null, onunmute: null, onended: null,
    stop() { this.readyState = 'ended'; },
    fireMute() { this.onmute?.(); },
    fireUnmute() { this.onunmute?.(); },
    fireEnded() { this.readyState = 'ended'; this.onended?.(); },
    clone() { return makeFakeTrack(kind); },
  };
  return t;
}

let streamSeq = 0;
export class FakeMediaStream {
  constructor(tracks = [{ kind: 'audio' }]) {
    // Accept either a plain {kind} descriptor (build a fresh fake track) or an
    // already-constructed fake track (reuse it as-is) — real MediaStream/ontrack always
    // share the exact same track instance between e.track and e.streams[0].getTracks().
    this._tracks = tracks.map((t) => (typeof t.stop === 'function' ? t : makeFakeTrack(t.kind)));
    this.id = `stream-${++streamSeq}`;
    FakeMediaStream.constructed += 1;
  }
  getTracks() { return this._tracks; }
  getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio'); }
  getVideoTracks() { return this._tracks.filter((t) => t.kind === 'video'); }
  /** Real semantics: adding a track already present is a no-op. */
  addTrack(track) { if (!this._tracks.includes(track)) this._tracks.push(track); }
  /** Real semantics: removing an absent track is a no-op. Never stops the track. */
  removeTrack(track) { const i = this._tracks.indexOf(track); if (i >= 0) this._tracks.splice(i, 1); }
}
/** Test helper: how many FakeMediaStream instances (incl. FakeMediaStreamCtor) were built since reset(). */
FakeMediaStream.constructed = 0;
FakeMediaStream.reset = () => { FakeMediaStream.constructed = 0; FakeMediaStreamCtor.constructed = 0; };

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

/**
 * Fake `MediaStream` constructor double: what the SDK gets as `cfg.mediaStreamConstructor`
 * (Web Audio's `createMediaStreamSource` and AvatarMedia's canonical/sink streams). Same
 * behavior as FakeMediaStream but defaults to an EMPTY stream like `new MediaStream()`, and
 * keeps its own `constructed` counter so a test can budget SDK-built streams separately from
 * the `e.streams[0]` streams `fireTrack()` builds.
 */
export class FakeMediaStreamCtor extends FakeMediaStream {
  constructor(tracks = []) { super(tracks); FakeMediaStreamCtor.constructed += 1; }
}
FakeMediaStreamCtor.constructed = 0;

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

/**
 * A media element double (`<video>` or `<audio>`). `autoCanPlay:false` makes the test fire
 * canplay manually (greeting-gate test). Every write the SDK can make is counted so tests
 * can pin "srcObject set once, play() once, no redundant muted/volume writes".
 */
export class FakeVideoEl {
  constructor({ autoCanPlay = true } = {}) {
    this._srcObject = null;
    this.readyState = autoCanPlay ? 4 : 0;
    this._auto = autoCanPlay;
    /** @type {Map<string,Array<{fn: Function, once: boolean}>>} */ this._listeners = new Map();
    this.played = false;
    this.playCount = 0;
    this.paused = true;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this._muted = false;
    this._volume = 1;
    this.sinkId = '';
    /** Test counters: every `srcObject =` write (incl. null), `muted =`, `volume =`, `setAttribute()`, `setSinkId()`. */
    this.srcObjectAssignments = 0;
    this.mutedWrites = 0;
    this.volumeWrites = 0;
    /** @type {Array<[string, string]>} */ this.attributeWrites = [];
    /** @type {string[]} */ this.setSinkIdCalls = [];
    this._failPlay = { times: 0, name: 'NotAllowedError' };
  }
  get srcObject() { return this._srcObject; }
  set srcObject(v) { this.srcObjectAssignments += 1; this._srcObject = v; }
  get muted() { return this._muted; }
  set muted(v) { this.mutedWrites += 1; this._muted = v; }
  get volume() { return this._volume; }
  set volume(v) { this.volumeWrites += 1; this._volume = v; }
  setAttribute(name, value) { this.attributeWrites.push([name, String(value)]); }
  /** Honors `{ once: true }` like the DOM, so leak checks measure real listener lifetime. */
  addEventListener(ev, fn, opts) { (this._listeners.get(ev) || this._listeners.set(ev, []).get(ev)).push({ fn, once: !!(opts && opts.once) }); }
  removeEventListener(ev, fn) { const l = this._listeners.get(ev); if (!l) return; const i = l.findIndex((e) => e.fn === fn); if (i >= 0) l.splice(i, 1); }
  /** Test helper: live listeners for an event (I-4 leak checks). @param {string} ev */
  listenerCount(ev) { return (this._listeners.get(ev) || []).length; }
  /** Test helper: dispatch an event to its listeners (`emptied`, `resize`, `loadedmetadata`, `canplay`, ...). @param {string} ev */
  emit(ev) {
    const l = this._listeners.get(ev) || [];
    for (const e of [...l]) { if (e.once) this.removeEventListener(ev, e.fn); e.fn({ type: ev, target: this }); }
  }
  /** Test helper: make the next `n` play() calls reject with `err.name = name` (autoplay-policy tests). */
  failPlayTimes(n, name = 'NotAllowedError') { this._failPlay = { times: n, name }; }
  play() {
    this.playCount += 1;
    if (this._failPlay.times > 0) {
      this._failPlay.times -= 1;
      const err = new Error(`play() rejected (${this._failPlay.name})`); err.name = this._failPlay.name;
      return Promise.reject(err);
    }
    this.played = true; this.paused = false;
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  /** Test helper: signal the video is now playable. */
  fireCanPlay() { this.readyState = 4; this.emit('canplay'); }
  /** Test helper: simulate the decoder resolving the stream's native dimensions. */
  fireLoadedMetadata(width, height) { this.videoWidth = width; this.videoHeight = height; this.emit('loadedmetadata'); }
  /** @param {string} deviceId */
  setSinkId(deviceId) {
    this.setSinkIdCalls.push(deviceId);
    if (this._sinkIdFailTimes > 0) { this._sinkIdFailTimes--; return Promise.reject(new Error('setSinkId failed')); }
    this.sinkId = deviceId;
    return Promise.resolve();
  }
  /** Test helper: track-sink.js's teardown() calls this on the audio element it created. */
  remove() { this.removed = true; }
}

/**
 * Minimal fake `document` — just enough for track-sink.js's audio-element creation
 * (`doc.createElement('audio')` / `doc.body.appendChild`). Returns a fresh `FakeVideoEl`
 * per `createElement` call, structurally close enough (srcObject/play/setSinkId/remove) to
 * stand in for an `<audio>` element in tests.
 */
export function fakeDom() {
  const body = { children: [], appendChild(el) { this.children.push(el); } };
  return { createElement: () => new FakeVideoEl({ autoCanPlay: true }), body };
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
