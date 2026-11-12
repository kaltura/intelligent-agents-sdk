/**
 * Session diagnostics: a short, content-free record of what a session did, for a bug
 * report. It keeps event names, codes, counts and timings. It never keeps what was said,
 * a name, a URL, a token or a tool argument. Each event has a fixed list of fields it may
 * keep, and a value is kept only when it is a number, a boolean or a short plain word.
 * Nothing is sent anywhere: the host app decides whether to share it.
 */

/** Events kept, and the payload fields kept for each. An event not listed here is not recorded. */
const RECORDED = Object.freeze({
  stateChange: ['state', 'reason'],
  mediaReady: ['mode', 'videoWidth', 'videoHeight', 'degraded'],
  connectTimings: null,
  connectivityChanged: ['channel', 'state', 'reason', 'recoverable', 'attempt', 'maxAttempts'],
  capacityChanged: ['available'],
  reconnecting: ['reason', 'attempt', 'maxAttempts', 'cold'],
  reconnected: ['recovered'],
  mediaRecovering: ['channel', 'state', 'cause'],
  mediaRecovered: ['channel', 'method'],
  turnStart: ['turnId', 'isNewTurn'],
  turnEnd: ['turnId'],
  turnTimings: ['turnId', 'origin', 'firstSegmentMs', 'firstSpeechChunkMs', 'startedTalkingMs', 'finishedMs', 'toolCalls'],
  interrupted: [],
  toolSpiralDetected: ['count', 'limit'],
  toolSpiralRecovering: ['count', 'limit'],
  brainStalled: ['afterMs', 'count'],
  idleWarning: ['inMs'],
  timeExpired: ['type'],
  resumed: [],
  ended: ['reason'],
  warning: ['code', 'turnId', 'count', 'limit', 'elapsedMs', 'limitMs', 'stage', 'replyChars', 'toolCalls', 'replyScript', 'languageScript', 'languageCode', 'asrLanguage'],
  error: ['code', 'phase', 'retryable', 'status'],
});

/** Most events kept. The oldest are dropped first. */
export const DIAGNOSTICS_MAX_EVENTS = 200;

/** A short plain word: letters, digits, space and `_ . : -`. Free text is longer or has other marks. */
const PLAIN = /^[\w .:-]{1,40}$/;

/** @param {unknown} v */
const keepable = (v) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && PLAIN.test(v));

/**
 * @typedef {object} DiagnosticsEvent
 * @property {number} t  Milliseconds since the session was created
 * @property {string} event  The event name
 * @property {Record<string, string|number|boolean>} [data]  The kept fields
 */

/** The ring buffer a session writes to. One per session. */
export class DiagnosticsLog {
  /** @param {() => number} clock Millisecond clock. */
  constructor(clock) {
    this._clock = clock;
    this._t0 = clock();
    /** @type {DiagnosticsEvent[]} */ this._events = [];
    /** @type {Record<string, number>} */ this._warnings = {};
  }

  /** Record an event if it is one we keep. Never throws. @param {string} event @param {unknown} payload */
  record(event, payload) {
    if (!Object.hasOwn(RECORDED, event)) return;
    const keys = RECORDED[/** @type {keyof typeof RECORDED} */ (event)];
    const src = payload && typeof payload === 'object' ? /** @type {Record<string, unknown>} */ (payload) : {};
    /** @type {Record<string, string|number|boolean>} */
    const data = {};
    // `error` carries a KalturaError, so read its fields as properties.
    for (const k of keys ?? Object.keys(src)) {
      const v = src[k];
      if (keepable(v)) data[k] = /** @type {string|number|boolean} */ (v);
    }
    if (event === 'warning' && typeof data.code === 'string') this._warnings[data.code] = (this._warnings[data.code] ?? 0) + 1;
    this._events.push({ t: Math.max(0, Math.round(this._clock() - this._t0)), event, ...(Object.keys(data).length ? { data } : {}) });
    if (this._events.length > DIAGNOSTICS_MAX_EVENTS) this._events.shift();
  }

  /** @returns {DiagnosticsEvent[]} A copy of the kept events, oldest first. */
  events() { return this._events.map((e) => ({ ...e, ...(e.data ? { data: { ...e.data } } : {}) })); }

  /** @returns {Record<string, number>} Warnings seen so far, by code. Not capped by the ring. */
  warningCounts() { return { ...this._warnings }; }
}

/**
 * @typedef {object} SessionDiagnostics
 * @property {1} schemaVersion
 * @property {{state: string, mode: string|null, paused: boolean}} session
 * @property {{languageCode?: string, asr?: {language?: string, provider?: string}, isTapToTalk?: boolean}|null} config  The language settings the server sent. `null` before they arrive
 * @property {Record<string, number>} connectTimings  Milliseconds per connect phase
 * @property {Record<string, number>} warnings  Count per warning code
 * @property {DiagnosticsEvent[]} events  The last events, oldest first
 * @property {{asr: object|null, stv: object|null}} ice  The same value as `getIceReport()`
 */

/**
 * Plain text for a ticket: a short summary, then one line per event.
 * @param {SessionDiagnostics} d  From `session.diagnostics()`
 * @returns {string}
 */
export function formatDiagnostics(d) {
  const cfg = d.config;
  const lines = [
    `session: ${d.session.state}, mode ${d.session.mode ?? 'none'}${d.session.paused ? ', paused' : ''}`,
    `language: ${cfg?.languageCode ?? '?'}, speech recognition ${cfg?.asr?.language ?? '?'}${cfg?.asr?.provider ? ` (${cfg.asr.provider})` : ''}`,
  ];
  const timings = Object.entries(d.connectTimings);
  if (timings.length) lines.push(`connect: ${timings.map(([k, v]) => `${k} ${v}ms`).join(', ')}`);
  const warned = Object.entries(d.warnings);
  lines.push(`warnings: ${warned.length ? warned.map(([k, v]) => `${k} x${v}`).join(', ') : 'none'}`);
  for (const [name, report] of Object.entries(d.ice)) {
    const r = /** @type {any} */ (report);
    if (r) lines.push(`ice ${name}: ${r.cause ?? 'unknown'}${r.hint ? ` (${r.hint})` : ''}`);
  }
  lines.push('', 'events:');
  for (const e of d.events) {
    const data = e.data ? ` ${Object.entries(e.data).map(([k, v]) => `${k}=${v}`).join(' ')}` : '';
    lines.push(`  ${String(e.t).padStart(7)} ms  ${e.event}${data}`);
  }
  return lines.join('\n');
}
