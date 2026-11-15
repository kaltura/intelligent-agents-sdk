/**
 * Transcript + barge-in tracker. The session server keys every utterance
 * by `speechId` (`${nonce}-<trigger>-<payload>`). The runtime drops any TTS/STV
 * event whose `speechId` isn't the latest — that staleness guard IS the
 * barge-in mechanism (WIRE-PROTOCOL §4f). This tracker mirrors it client-side so
 * the SDK never surfaces stale captions after an interruption.
 *
 * Caption rule (WIRE-PROTOCOL §4d): `stvSpeechChunk{text,durationMs}`
 * is authoritative; reset buffers on `stvFinishedTalking`, NOT on
 * `stvStartedTalking`. The server emits no per-word timing, so `words[].startMs`
 * is derived client-side by apportioning `durationMs` across the chunk's words.
 * It is an estimate.
 *
 * Pure state machine — no timers, no I/O. Fully unit-testable by replaying the
 * golden capture's chunk sequence.
 */

export class TranscriptTracker {
  constructor() {
    /** @type {string|null} The latest live utterance key; chunks with a different id are stale. */
    this.latestSpeechId = null;
    /** @type {number} ms elapsed within the current utterance (for word startMs). */
    this._elapsedMs = 0;
  }

  /**
   * A new utterance starts (from `agent_start_speech` or our own `speak`).
   * Marks it the latest, invalidating any prior in-flight audio.
   * @param {string} speechId
   */
  beginUtterance(speechId) {
    if (speechId && speechId !== this.latestSpeechId) {
      this.latestSpeechId = speechId;
      this._elapsedMs = 0;
    }
  }

  /** Is this event for the current utterance? Stale (barge-in'd) ids return false. @param {string|undefined} speechId */
  isCurrent(speechId) {
    if (!speechId) return true; // events with no speechId (e.g. stvStartedTalking) attach to the current turn
    return speechId === this.latestSpeechId;
  }

  /**
   * Process an authoritative caption chunk. Returns a `transcript` payload with
   * derived word timings, or `null` if the chunk is an empty sentinel
   * (`text:""`, `durationMs:1`) or stale (dropped — barge-in).
   * @param {{text?:string, durationMs?:number, speechId?:string}} chunk
   * @returns {{text:string, type:'partial', speechId:string|null, words:{word:string,startMs:number}[]}|null}
   */
  ingestChunk(chunk) {
    if (!chunk || !chunk.text || chunk.durationMs === 1) return null; // sentinel
    // Adopt a speechId ONLY when none is active yet (e.g. a chunk arriving before
    // any turnStart/generatingSpeech). Never promote otherwise — promotion is the
    // job of beginUtterance (turnStart/generatingSpeech/speak), so a stale chunk
    // from an interrupted utterance can't re-activate itself.
    if (chunk.speechId && this.latestSpeechId === null) this.beginUtterance(chunk.speechId);
    if (!this.isCurrent(chunk.speechId)) return null;                 // stale → drop
    const words = apportion(chunk.text, chunk.durationMs ?? 0, this._elapsedMs);
    this._elapsedMs += chunk.durationMs ?? 0;
    return { text: chunk.text, type: 'partial', speechId: this.latestSpeechId, words };
  }

  /** Mark the current utterance finished and reset the per-turn timing buffer. */
  finishUtterance() { this._elapsedMs = 0; }
}

/**
 * @typedef {object} TranscriptEntry One line of the conversation log.
 * @property {'user'|'agent'} role  `user` for the viewer's words, `agent` for a reply sentence.
 * @property {string} text
 * @property {string|null} speechId  The reply this line belongs to. `null` for a line with no reply link (typed text).
 */

/**
 * The conversation in speaking order. On a spoken turn the server delivers the user's
 * words after the first sentence of the reply, so `transcript` events arrive as
 * reply, then question. `TranscriptLog` puts a `user` line back in front of the reply
 * it prompted, using the `speechId` the SDK stamps on both. Feed it every `transcript`
 * event. It keeps `type:'final'` (agent) and `type:'user'` lines and ignores `partial`.
 * Pure state, no timers, no I/O.
 *
 * @example
 * const log = new TranscriptLog();
 * session.on('transcript', (tr) => {
 *   const added = log.add(tr);
 *   if (added) list.insertBefore(row(added.entry), list.children[added.index] ?? null);
 * });
 */
export class TranscriptLog {
  constructor() {
    /** @type {TranscriptEntry[]} */
    this._entries = [];
  }

  /** The lines in speaking order. A copy: changing it does not change the log. @returns {TranscriptEntry[]} */
  get entries() { return this._entries.slice(); }

  /**
   * Add a `transcript` event. A `user` line with a `speechId` goes before the first
   * agent line of that reply. Every other line goes at the end.
   * @param {{text?:string, type?:string, speechId?:string|null}} tr A `transcript` event payload.
   * @returns {{index:number, entry:TranscriptEntry}|null} Where the line landed, for inserting it into a rendered list.
   *   `null` when the event is not a line (a `partial` caption, or no text).
   */
  add(tr) {
    if (!tr || !tr.text || (tr.type !== 'user' && tr.type !== 'final')) return null;
    /** @type {TranscriptEntry} */
    const entry = { role: tr.type === 'user' ? 'user' : 'agent', text: tr.text, speechId: tr.speechId ?? null };
    let index = this._entries.length;
    if (entry.role === 'user' && entry.speechId) {
      const reply = this._entries.findIndex((e) => e.role === 'agent' && e.speechId === entry.speechId);
      if (reply !== -1) index = reply;
    }
    this._entries.splice(index, 0, entry);
    return { index, entry };
  }

  /** Drop every line. */
  clear() { this._entries.length = 0; }
}

/**
 * Apportion a chunk's `durationMs` evenly across its words, offset by the
 * utterance-relative start. The server emits no per-word `startMs`, so this is
 * an estimate and captions follow audio onset rather than lead it.
 * @param {string} text @param {number} durationMs @param {number} offsetMs
 */
export function apportion(text, durationMs, offsetMs) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const per = durationMs > 0 ? durationMs / tokens.length : 0;
  return tokens.map((word, i) => ({ word, startMs: Math.round(offsetMs + i * per) }));
}
