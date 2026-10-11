/**
 * ICE diagnostics: what a peer gathered, what failed, and a plain-words cause. Everything here
 * is safe to log or send to a support ticket. No IP address, port, username fragment or
 * credential is ever kept.
 */

const MAX_ERRORS = 8;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi;

/** @typedef {{ code: number, text: string, scheme: string }} IceServerError A failed STUN or TURN request. `scheme` is `stun`, `turn`, `turns` or `unknown`. */
/** @typedef {{ host: number, srflx: number, prflx: number, relay: number }} IceCandidateCounts Local candidates gathered, by type. */
/** @typedef {{ channel: 'asr'|'stv', iceConnectionState: string, connectionState: string, gatheringState: string, candidates: IceCandidateCounts, errors: IceServerError[], cause: string, hint: string }} IceSnapshot */
/** @typedef {IceSnapshot & { selectedPair: { localType: string, remoteType: string, protocol: string } | null }} IceReport */

/** @param {unknown} s */
function scrub(s) {
  return String(s ?? '').replace(IPV4, '<ip>').replace(IPV6, '<ip>').slice(0, 160);
}

/** @param {unknown} url */
function schemeOf(url) {
  const m = /^(stuns?|turns?):/i.exec(String(url ?? ''));
  return m ? m[1].toLowerCase() : 'unknown';
}

/** Watches one peer from creation and keeps what a failed connect needs to be explained. */
export class IceTrace {
  /** @param {'asr'|'stv'} channel @param {any} pc @param {() => number} [now] */
  constructor(channel, pc, now = () => Date.now()) {
    this.channel = channel;
    this.pc = pc;
    /** @type {IceCandidateCounts} */ this.candidates = { host: 0, srflx: 0, prflx: 0, relay: 0 };
    /** @type {IceServerError[]} */ this.errors = [];
    this._now = now;
    this.startedAt = now();
    // addEventListener keeps the handlers the session sets (`onicecandidate`) untouched.
    pc.addEventListener?.('icecandidate', (/** @type {any} */ e) => {
      const c = e?.candidate;
      if (!c) return;
      const type = c.type || /\btyp (host|srflx|prflx|relay)\b/.exec(c.candidate || '')?.[1];
      if (type && type in this.candidates) this.candidates[/** @type {keyof IceCandidateCounts} */ (type)]++;
    });
    pc.addEventListener?.('icecandidateerror', (/** @type {any} */ e) => {
      const err = { code: Number(e?.errorCode) || 0, text: scrub(e?.errorText), scheme: schemeOf(e?.url) };
      if (this.errors.length < MAX_ERRORS && !this.errors.some((x) => x.code === err.code && x.scheme === err.scheme)) this.errors.push(err);
    });
  }

  /** @returns {IceSnapshot} */
  snapshot() {
    const pc = this.pc;
    const base = {
      channel: this.channel,
      iceConnectionState: String(pc?.iceConnectionState ?? 'unknown'),
      connectionState: String(pc?.connectionState ?? 'unknown'),
      gatheringState: String(pc?.iceGatheringState ?? 'unknown'),
      candidates: { ...this.candidates },
      errors: this.errors.map((e) => ({ ...e })),
    };
    return { ...base, ...diagnoseIce(base) };
  }

  /**
   * The snapshot plus the type of the selected candidate pair, read from `getStats`. Never
   * rejects: a missing or slow `getStats` leaves `selectedPair` as `null`.
   * @param {number} [timeoutMs]
   * @returns {Promise<IceReport>}
   */
  async report(timeoutMs = 1000) {
    const snap = this.snapshot();
    /** @type {IceReport['selectedPair']} */ let selectedPair = null;
    try {
      if (typeof this.pc?.getStats === 'function') {
        let timer;
        const stats = await Promise.race([
          this.pc.getStats(),
          new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); timer.unref?.(); }),
        ]);
        clearTimeout(timer);
        selectedPair = stats ? pickPair(stats) : null;
      }
    } catch { /* stats are best effort */ }
    return { ...snap, selectedPair };
  }
}

/** @param {any} stats An RTCStatsReport or anything with `forEach`. @returns {IceReport['selectedPair']} */
function pickPair(stats) {
  /** @type {Map<string, any>} */ const byId = new Map();
  /** @type {any[]} */ const pairs = [];
  /** @type {any} */ let transport = null;
  stats.forEach((/** @type {any} */ s) => {
    byId.set(s.id, s);
    if (s.type === 'candidate-pair') pairs.push(s);
    if (s.type === 'transport') transport = s;
  });
  const chosen = (transport?.selectedCandidatePairId && byId.get(transport.selectedCandidatePairId))
    || pairs.find((p) => p.nominated && p.state === 'succeeded')
    || pairs.find((p) => p.selected);
  if (!chosen) return null;
  const local = byId.get(chosen.localCandidateId);
  const remote = byId.get(chosen.remoteCandidateId);
  return { localType: String(local?.candidateType ?? 'unknown'), remoteType: String(remote?.candidateType ?? 'unknown'), protocol: String(local?.protocol ?? 'unknown') };
}

/**
 * Name the most likely cause from what a peer gathered and what its servers answered.
 * @param {{ iceConnectionState: string, gatheringState: string, candidates: IceCandidateCounts, errors: IceServerError[] }} s
 * @returns {{ cause: string, hint: string }}
 */
export function diagnoseIce(s) {
  const up = s.iceConnectionState === 'connected' || s.iceConnectionState === 'completed';
  if (up) return { cause: 'connected', hint: 'The media path is up.' };
  const auth = s.errors.find((e) => e.code === 401 || e.code === 403 || e.code === 438);
  if (auth) return { cause: 'turn_credentials_rejected', hint: 'The relay server rejected the credentials. Check the TURN settings the session was given.' };
  const unreachable = s.errors.find((e) => e.code === 701 || (e.code >= 300 && e.code < 400));
  if (s.candidates.relay === 0 && (unreachable || s.errors.length)) {
    return { cause: 'turn_unreachable', hint: 'No relay address could be allocated. A firewall or proxy may block the relay server. Allow outbound UDP and TCP on ports 80 and 443 to the relay host, or try another network.' };
  }
  const total = s.candidates.host + s.candidates.srflx + s.candidates.prflx + s.candidates.relay;
  if (s.gatheringState === 'complete' && total === 0) {
    return { cause: 'no_candidates', hint: 'The browser found no network address to use. Check that the device is online and that a VPN or privacy setting is not hiding its network interfaces.' };
  }
  if (s.candidates.relay > 0) {
    return { cause: 'no_route', hint: 'A relay address was allocated but the media server could not be reached through it. This is usually a short network problem. Try again.' };
  }
  if (s.gatheringState !== 'complete') return { cause: 'still_gathering', hint: 'The browser was still looking for a network path. The network may be slow. Try again.' };
  return { cause: 'no_route', hint: 'No network path to the media server was found. Try again, or try another network.' };
}
