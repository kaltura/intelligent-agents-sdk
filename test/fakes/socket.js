/**
 * FakeSocket — a socket.io-compatible test double. Records client emits, lets a
 * test script push server events, and supports a `script` that auto-responds to
 * the connect handshake so e2e tests can replay the documented sequence offline.
 */
export class FakeSocket {
  constructor() {
    this.id = 'fake-' + Math.random().toString(36).slice(2, 10);
    this.connected = true;
    this.recovered = false;   // socket.io connection-state-recovery flag (set true to model same-instance recovery)
    /** @type {Map<string,Set<Function>>} */ this._h = new Map();
    /** @type {{event:string,payload:any}[]} */ this.emitted = [];
    this._onEmit = null;
  }
  /** Test helper: model a transport drop (recoverable) → optional same-instance recovery. */
  dropAndRecover(reason = 'transport close', { recovered = true } = {}) {
    this.connected = false; this.server('disconnect', reason);
    this.recovered = recovered; this.connected = true; this.server('connect');
  }
  on(ev, fn) { (this._h.get(ev) || this._h.set(ev, new Set()).get(ev)).add(fn); return this; }
  once(ev, fn) { const w = (...a) => { this.off(ev, w); fn(...a); }; return this.on(ev, w); }
  off(ev, fn) { this._h.get(ev)?.delete(fn); return this; }
  /** Drop all listeners (real socket.io clients support this; used before re-wiring). */
  removeAllListeners() { this._h.clear(); return this; }
  /** Client → server emit (recorded; may trigger the autoresponder). */
  emit(ev, payload) {
    this.emitted.push({ event: ev, payload });
    if (this._onEmit) this._onEmit(ev, payload, this);
    return this;
  }
  /** Server → client: deliver an inbound event to listeners. */
  server(ev, payload) {
    for (const fn of [...(this._h.get(ev) || [])]) fn(payload);
  }
  disconnect() { this.connected = false; this.server('disconnect', 'io client disconnect'); }
  /** Register an emit observer (used by the scripted autoresponder). */
  onEmit(fn) { this._onEmit = fn; }
  /** All payloads emitted for one event name. */
  emitsOf(ev) { return this.emitted.filter((e) => e.event === ev).map((e) => e.payload); }
  /** True if the client emitted this event at least once. */
  didEmit(ev) { return this.emitted.some((e) => e.event === ev); }
}

/**
 * Drive a FakeSocket through the documented happy-path connect handshake
 * (steps 1–11) by auto-responding to each client emit. `opts.gateWhep` lets a
 * test hold the STV-playable gate (the greeting-clip test) — when true, the STV
 * ontrack/canplay is NOT auto-fired; the test fires it manually.
 * @param {FakeSocket} socket
 * @param {{audioMode?:boolean, capacityBusyTimes?:number, clientConfig?:object}} [opts]
 */
export function scriptHappyPath(socket, opts = {}) {
  let busyLeft = opts.capacityBusyTimes || 0;
  let stvNewSessionCount = 0;
  // Each phase is delivered on its OWN tick so the SDK's sequential awaits have
  // attached the relevant listener before the event arrives — modelling real
  // network framing (frames don't all arrive in one synchronous burst).
  const soon = (fn) => setTimeout(fn, 0);

  // Step 1 — initial server handshake, after connect()'s setup has run.
  soon(() => {
    socket.server('connect');
    socket.server('onServerConnected', { finalUrl: 'https://srs.example', agentName: 'Avatar', hostName: 'host-1' });
  });

  socket.onEmit((ev) => {
    if (ev === 'join') soon(() => {
      const cc = opts.clientConfig || (opts.audioMode ? { audioMode: true } : { languageCode: 'en', interruptionsEnabled: true });
      socket.server('clientConfiguration', { clientConfiguration: cc });
      socket.server('joinComplete', {});
    });
    else if (ev === 'checkAvailability') soon(() => {
      if (busyLeft > 0) { busyLeft--; socket.server('availabilityResult', { available: false, details: { activeCalls: 10, maxCalls: 10 } }); }
      else socket.server('availabilityResult', { available: true, details: { activeCalls: 1, maxCalls: 10 } });
    });
    else if (ev === 'stvNewSession') soon(() => {
      if (opts.noCapacity) { socket.server('throwToNoAgent', {}); return; }          // capacity exhausted
      if (opts.tierExceeded) { socket.server('throwToExceededTier', {}); return; }   // plan limit
      // A SECOND stvNewSession only happens on a resume() rebuild path (the first
      // is the initial connect) — per WIRE-PROTOCOL.md, the real server sends
      // `resumingSession` before rebuilding, preceding `conversationResumed`.
      stvNewSessionCount += 1;
      if (stvNewSessionCount > 1) socket.server('resumingSession', {});
      if (opts.audioMode) socket.server('stvNewSession', { status: 'audio/phone mode - no STV session' });
      else socket.server('stvNewSession', { session_id: 'sess-123', status: 'session started', webrtc_url: 'https://srs.example/rtc/v1/whep/?app=app&stream=sess-123' });
      // Agent + permissions arrive on a later tick (after the session reply is processed).
      soon(() => { socket.server('showAgent', {}); soon(() => socket.server('askPermissions', { constraints: { audio: true, video: !opts.audioMode } })); });
    });
    else if (ev === 'asr-webrtc-init') soon(() => socket.server('asr-webrtc-ready', {}));
    else if (ev === 'asr-webrtc-offer') soon(() => socket.server('asr-webrtc-answer', { answer: { type: 'answer', sdp: 'fake-answer' } }));
  });
}
