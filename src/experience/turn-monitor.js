/**
 * Turn monitor: watches the timing of each agent turn and raises warnings for the
 * failures a tester can only describe as "the avatar is silent" or "it is slow".
 * It only observes. It never sends, interrupts or holds anything, so it cannot
 * drop a held turn (constitution R-7). Content-free: it keeps counts, lengths and
 * timestamps. The one exception is a short in-memory sample of the reply, used for
 * a script check and dropped at the end of the turn.
 */
import { dominantScript, normalizeLanguage, scriptFits, scriptOfLanguage } from '../management/doctor/language.js';

/** Defaults. 0 turns a check off. */
export const TURN_MONITOR_DEFAULTS = Object.freeze({ speechStartGraceMs: 3000, slowTurnMs: 10000, toolHeavyLimit: 5 });

/** A send older than this is not the origin of a server turn. It never got a reply. */
const SENT_MAX_AGE_MS = 120000;

/** Reply characters kept for the script check. */
const SAMPLE_CHARS = 400;

/**
 * @typedef {object} TurnTimings
 * @property {string|undefined} turnId
 * @property {'sent'|'turn_start'} origin  `sent` when the SDK sent the turn, `turn_start` for a turn the server began
 * @property {number|null} firstSegmentMs  Origin to the first reply segment
 * @property {number|null} firstSpeechChunkMs  Origin to the first caption chunk
 * @property {number|null} startedTalkingMs  Origin to `avatarStartTalking`
 * @property {number|null} finishedMs  Origin to the end of generation
 * @property {number} toolCalls  Raw tool segments in the turn
 */

/**
 * @typedef {object} TurnMonitorOptions
 * @property {(name: string, payload: object) => void} emit  Called for `warning` and `turnTimings`
 * @property {() => boolean} isAudioOnly  True in audio-only mode: the SDK has no audio downlink to watch
 * @property {() => boolean} isPaused
 * @property {() => number} [now]  Millisecond clock. Default `Date.now`
 * @property {typeof setTimeout} [setTimer]
 * @property {typeof clearTimeout} [clearTimer]
 * @property {number} [speechStartGraceMs]
 * @property {number} [slowTurnMs]
 * @property {number} [toolHeavyLimit]
 */

/** One monitor per session. */
export class TurnMonitor {
  /** @param {TurnMonitorOptions} o */
  constructor(o) {
    this._emit = o.emit;
    this._audioOnly = o.isAudioOnly;
    this._paused = o.isPaused;
    this._now = o.now ?? (() => Date.now());
    this._setTimer = o.setTimer ?? ((...a) => setTimeout(...a));
    this._clearTimer = o.clearTimer ?? ((t) => clearTimeout(t));
    this._grace = o.speechStartGraceMs ?? TURN_MONITOR_DEFAULTS.speechStartGraceMs;
    this._slowMs = o.slowTurnMs ?? TURN_MONITOR_DEFAULTS.slowTurnMs;
    this._toolHeavy = o.toolHeavyLimit ?? TURN_MONITOR_DEFAULTS.toolHeavyLimit;
    /** @type {Set<string>} */ this._warned = new Set();
    /** @type {any} */ this._timer = null;
    /** Send time of the next turn, set by {@link TurnMonitor#sent}. A send with no reply expires. @type {number|null} */ this._pendingSentAt = null;
    /** @type {any} */ this._turn = null;
    /** @type {unknown} */ this._languageCode = undefined;
  }

  /** The SDK sent a turn (typed text or a captured user turn). Marks the origin of the next server turn. */
  sent() { this._pendingSentAt = this._now(); }

  /** `agent_start_speech`. A repeat for a turn already in flight only adds its speech id. @param {{turnId?: string, speechId?: string, isNewTurn?: boolean}} p */
  turnStart(p) {
    if (this._turn && !p.isNewTurn) { this._addSpeech(p.speechId); return; }
    this._cancelTimer();
    const at = this._now();
    const sentAt = this._pendingSentAt !== null && at - this._pendingSentAt <= SENT_MAX_AGE_MS ? this._pendingSentAt : null;
    this._pendingSentAt = null;
    this._turn = {
      turnId: p.turnId, origin: sentAt === null ? 'turn_start' : 'sent', originAt: sentAt ?? at, fromSend: sentAt !== null,
      speechIds: new Set(), firstSegmentAt: null, firstChunkAt: null, talkingAt: null,
      replyChars: 0, sample: '', toolCalls: 0, audio: false, quiet: false, toolHeavyDone: false, finished: false,
    };
    this._addSpeech(p.speechId);
  }

  /** A speech id seen on `generatingSpeech`. @param {string|undefined} speechId */
  speechId(speechId) { this._addSpeech(speechId); }

  /** A reply segment a viewer can perceive. @param {string|undefined} text */
  segment(text) {
    const t = this._turn;
    if (!t) return;
    t.firstSegmentAt ??= this._now();
    if (typeof text === 'string' && text) {
      t.replyChars += text.length;
      if (t.sample.length < SAMPLE_CHARS) t.sample += text.slice(0, SAMPLE_CHARS - t.sample.length);
    }
  }

  /** A raw tool segment. Warns once when the count reaches the limit. */
  toolCall() {
    const t = this._turn;
    if (!t) return;
    t.toolCalls++;
    if (this._toolHeavy > 0 && !t.toolHeavyDone && t.toolCalls >= this._toolHeavy) {
      t.toolHeavyDone = true;
      this._emit('warning', {
        code: 'tool_heavy_turn', turnId: t.turnId, count: t.toolCalls, limit: this._toolHeavy,
        message: `The agent made ${t.toolCalls} tool calls in one turn. Check its tools, and the tool descriptions, for a loop.`,
      });
    }
  }

  /** A caption chunk. Audio is on its way. */
  speechChunk() {
    const t = this._turn;
    if (!t) return;
    t.firstChunkAt ??= this._now();
    t.audio = true;
    this._cancelTimer();
  }

  /** `stvStartedTalking`. */
  startedTalking() {
    const t = this._turn;
    if (!t) return;
    t.audio = true;
    this._cancelTimer();
    if (t.talkingAt !== null) return;
    t.talkingAt = this._now();
    this._checkSlow(t);
  }

  /** `stvFinishedGenerating`: the reply text is complete. Starts the silence timer when no audio began. */
  finishedGenerating() {
    const t = this._turn;
    if (!t || t.finished) return;
    t.finished = true;
    const at = this._now();
    this._emit('turnTimings', this._timings(t, at));
    this._checkReplyScript(t);
    if (this._grace > 0 && !t.audio && !t.quiet && t.replyChars > 0 && t.speechIds.size <= 1 && !this._audioOnly() && !this._paused()) {
      this._timer = this._setTimer(() => {
        this._timer = null;
        if (this._turn !== t || t.audio || t.quiet || this._audioOnly() || this._paused()) return;
        this._emit('warning', {
          code: 'speech_not_started', turnId: t.turnId, replyChars: t.replyChars, elapsedMs: this._now() - t.originAt,
          message: 'The agent replied but no audio started. Check the voice, and the client for blocked autoplay or a muted tab.',
        });
      }, this._grace);
    }
  }

  /** The turn will not produce normal audio: interrupted, paused, reconnecting, silent opening, check-in or goodbye. */
  quiet() {
    if (this._turn) this._turn.quiet = true;
    this._cancelTimer();
  }

  /** The connection ended or restarted. Nothing is pending after this. */
  reset() {
    this._cancelTimer();
    this._turn = null;
    this._pendingSentAt = null;
  }

  /**
   * The session language settings arrived. Warns once when `languageCode` and `asr.language` differ.
   * @param {{languageCode?: unknown, asr?: {language?: unknown}}|null|undefined} cc
   */
  configReady(cc) {
    this._languageCode = cc?.languageCode;
    const a = normalizeLanguage(cc?.languageCode);
    const b = normalizeLanguage(cc?.asr?.language);
    if (!a || !b || a === b || this._once(`config_language_differs:${a}:${b}`)) return;
    this._emit('warning', {
      code: 'config_language_differs', languageCode: a, asrLanguage: b,
      message: `The session language is "${a}" but speech recognition listens for "${b}". Callers are recognized as "${b}".`,
    });
  }

  /** @param {string|undefined} speechId */
  _addSpeech(speechId) {
    if (!this._turn || !speechId) return;
    this._turn.speechIds.add(speechId);
  }

  _cancelTimer() { if (this._timer) { this._clearTimer(this._timer); this._timer = null; } }

  /** @param {string} key @returns {boolean} true when it was already raised */
  _once(key) { if (this._warned.has(key)) return true; this._warned.add(key); return false; }

  /** @param {any} t @param {number} finishedAt @returns {TurnTimings} */
  _timings(t, finishedAt) {
    const rel = (/** @type {number|null} */ at) => (at === null ? null : at - t.originAt);
    return {
      turnId: t.turnId, origin: t.origin, firstSegmentMs: rel(t.firstSegmentAt), firstSpeechChunkMs: rel(t.firstChunkAt),
      startedTalkingMs: rel(t.talkingAt), finishedMs: finishedAt - t.originAt, toolCalls: t.toolCalls,
    };
  }

  /** Slow start: only for turns the SDK sent, so a server-started turn is never judged. @param {any} t */
  _checkSlow(t) {
    if (!(this._slowMs > 0) || !t.fromSend || t.quiet || t.talkingAt - t.originAt <= this._slowMs) return;
    const toSegment = (t.firstSegmentAt ?? t.talkingAt) - t.originAt;
    const toSpeech = t.talkingAt - (t.firstSegmentAt ?? t.originAt);
    const stage = toSegment >= toSpeech ? 'first_segment' : 'speech_start';
    this._emit('warning', {
      code: 'slow_turn', turnId: t.turnId, elapsedMs: t.talkingAt - t.originAt, limitMs: this._slowMs, stage, toolCalls: t.toolCalls,
      message: stage === 'first_segment'
        ? `The first reply took ${toSegment} ms. Look at thinking mode, prompt size and tool calls.`
        : `The first reply came in time but speech took ${toSpeech} ms more to start. Look at the voice.`,
    });
  }

  /** Once per session: the reply is written in a script the session language does not use. @param {any} t */
  _checkReplyScript(t) {
    if (t.quiet) return;
    const want = scriptOfLanguage(this._languageCode);
    const got = dominantScript(t.sample);
    if (!want || !got || scriptFits(got, want) || this._once(`reply_language_differs_from_config:${got}:${want}`)) return;
    this._emit('warning', {
      code: 'reply_language_differs_from_config', replyScript: got, languageScript: want,
      message: `The reply is written in ${got} script and the session language uses ${want}. The voice may not speak it.`,
    });
  }
}
