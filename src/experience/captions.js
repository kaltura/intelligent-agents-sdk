/**
 * CaptionService — SDK-level caption engine for a KalturaAvatarSession.
 *
 * A caption engine tuned against real production traffic. All accumulation,
 * segmentation, timing, and hold-then-clear logic lives here; the app only
 * provides a render callback.
 *
 * Dual-source timing:
 *
 * PRIMARY (server-timed via `speechChunk`):
 *   Each chunk carries `{ text, durationMs, speechId }`. Text is segmented and
 *   each segment is held for its proportional share of durationMs via setTimeout.
 *   No rate estimation needed — timing is server-authoritative.
 *
 * FALLBACK (heuristic via `transcript{type:'partial'}`):
 *   Chunks buffer text; `avatarStartTalking` kicks the 200ms tick; each segment
 *   is held for segment.length / charsPerSec ms before advancing.
 *
 * Ground truth overlay:
 *   `transcript{type:'final'}` (from `generatingSpeech`) arrives BEFORE TTS
 *   starts and carries clean pre-TTS text. The engine uses it to correct word
 *   boundaries in the transcribed chunks without ever rendering it directly.
 *
 * Caption rule (WIRE-PROTOCOL §4d): `stvSpeechChunk{text,durationMs}`
 * is authoritative; `transcript{type:'partial'}` is the heuristic fallback when
 * no speechChunk arrives. The server emits no per-word/segment `startMs`
 * so captions follow audio onset (segment-hold timing derived here)
 * rather than lead it — the same honest approximation transcript.js documents
 * for its own word-level `apportion()`.
 *   - `speechChunk` / `transcript{type:'partial'}` — these drive captions.
 *   - `transcript{type:'final'}` — ground truth only, NEVER rendered directly.
 *
 * @example
 * const captions = new CaptionService(session, {
 *   replacements: { 'Kalturah': 'Kaltura', 'none gap': 'Non-GAAP' },
 *   holdAfterEndMs: 2000,
 * });
 * captions.onCaption(({ text, clear }) => {
 *   captionEl.textContent = clear ? '' : text;
 * });
 * captions.destroy(); // when done
 */

import { Teardown } from './teardown.js';

/** Strip HTML tags from a chunk of text (never rendered raw). A single
 * character-by-character scan, not a regex — nothing to reconstitute a tag
 * from and no backtracking. Everything from `<` through the next `>` is
 * dropped; an unclosed `<` drops the rest of the string. @param {string} text */
function stripHtml(text) {
  let out = '';
  let inTag = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') { inTag = true; continue; }
    if (inTag) {
      if (ch === '>') inTag = false;
      continue;
    }
    out += ch;
  }
  return out;
}

// ─── CaptionFilter ────────────────────────────────────────────────────────────

class CaptionFilter {
  constructor(config) {
    this._replacements = [];
    this._customFn = null;
    if (config?.replacements) this.setReplacements(config.replacements);
    if (config?.filter) this._customFn = config.filter;
  }

  setReplacements(map) {
    this._replacements = [];
    if (!map) return;
    const entries = map instanceof Map ? Array.from(map.entries()) : Object.entries(map);
    entries.sort((a, b) => b[0].length - a[0].length);
    for (const [from, to] of entries) {
      const escaped = this._escapeRegex(from);
      const startsWord = /^[a-zA-ZÀ-ɏ]/.test(from);
      const endsWord = /[a-zA-ZÀ-ɏ]$/.test(from);
      const pattern = (startsWord ? '\\b' : '') + escaped + (endsWord ? '\\b' : '');
      this._replacements.push({ re: new RegExp(pattern, 'gi'), to });
    }
  }

  apply(text) {
    if (!text) return text;
    let result = stripHtml(text);
    for (const { re, to } of this._replacements) result = result.replace(re, to);
    result = this._normalizePunctuation(result);
    if (this._customFn) {
      const filtered = this._customFn(result);
      if (typeof filtered === 'string') result = filtered;
    }
    return result;
  }

  _normalizePunctuation(text) {
    let t = text;
    t = t.replace(/([.!?,;:])([A-Za-zÀ-ɏ])/g, '$1 $2');
    t = t.replace(/ {2,}/g, ' ');
    t = t.replace(/\s+([.!?,;:])/g, '$1');
    return t.trim();
  }

  _escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
}

// ─── CaptionSegmenter ─────────────────────────────────────────────────────────

class CaptionSegmenter {
  constructor(maxCharsPerLine, maxLines) {
    this._maxCharsPerLine = maxCharsPerLine;
    this._maxLines = maxLines;
    this._maxChars = maxCharsPerLine * maxLines;
  }

  segment(text) {
    if (!text || !text.trim()) return [];
    const sentences = this._splitSentences(text.trim());
    const segments = [];
    let buffer = '';

    for (const sentence of sentences) {
      if (!sentence.trim()) continue;
      if (buffer && (buffer.length + sentence.length + 1) > this._maxChars) {
        segments.push(buffer.trim());
        buffer = '';
      }
      if (sentence.length > this._maxChars) {
        if (buffer) { segments.push(buffer.trim()); buffer = ''; }
        const clauses = this._splitClauses(sentence);
        for (const clause of clauses) {
          if (buffer && (buffer.length + clause.length + 1) > this._maxChars) {
            segments.push(buffer.trim());
            buffer = '';
          }
          if (clause.length > this._maxChars) {
            if (buffer) { segments.push(buffer.trim()); buffer = ''; }
            const words = clause.split(/\s+/);
            for (const word of words) {
              if (buffer && (buffer.length + word.length + 1) > this._maxChars) {
                segments.push(buffer.trim());
                buffer = '';
              }
              buffer = buffer ? buffer + ' ' + word : word;
            }
          } else {
            buffer = buffer ? buffer + ' ' + clause : clause;
          }
        }
      } else {
        buffer = buffer ? buffer + ' ' + sentence : sentence;
      }
    }

    if (buffer.trim()) segments.push(buffer.trim());
    return segments.length > 0 ? segments : [text.trim()];
  }

  sentenceBoundaries(text) {
    const boundaries = [];
    const re = /[.!?]+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const endPos = m.index + m[0].length;
      if (this._isSentenceEnd(text, m.index, endPos)) boundaries.push(endPos);
    }
    return boundaries;
  }

  _splitSentences(text) {
    const result = [];
    const boundaries = [];
    const re = /[.!?]+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const endPos = m.index + m[0].length;
      if (this._isSentenceEnd(text, m.index, endPos)) boundaries.push(endPos);
    }
    if (boundaries.length === 0) return [text];
    let start = 0;
    for (const end of boundaries) {
      const seg = text.slice(start, end).trim();
      if (seg) result.push(seg);
      start = end;
    }
    if (start < text.length) {
      const remainder = text.slice(start).trim();
      if (remainder) result.push(remainder);
    }
    return result.length > 0 ? result : [text];
  }

  _isSentenceEnd(text, dotStart, dotEnd) {
    if (dotStart <= 0) return false;
    const charBefore = text[dotStart - 1];
    if (/\d/.test(charBefore) && dotEnd < text.length && /\d/.test(text[dotEnd])) return false;
    if (/[A-Z]/.test(charBefore) && dotEnd < text.length && /[A-Z]/.test(text[dotEnd])) return false;
    if (dotEnd >= text.length) return true;
    if (/\s/.test(text[dotEnd])) return true;
    return false;
  }

  _splitClauses(text) {
    return text.split(/(?<=[,;:—])\s+/).filter(c => c.trim());
  }
}

// ─── CaptionRateEstimator ─────────────────────────────────────────────────────

class CaptionRateEstimator {
  constructor() { this._charsPerSec = 11; this._samples = 0; }
  get charsPerSec() { return this._charsPerSec; }
  estimateDuration(charCount) { return (charCount / this._charsPerSec) * 1000; }
  calibrate(charCount, durationMs) {
    if (durationMs <= 0 || charCount <= 0) return;
    const observed = charCount / (durationMs / 1000);
    if (observed < 1 || observed > 50) return;
    this._samples++;
    const alpha = this._samples <= 2 ? 0.5 : 0.3;
    this._charsPerSec = (1 - alpha) * this._charsPerSec + alpha * observed;
  }
}

// ─── CaptionService ───────────────────────────────────────────────────────────

export class CaptionService {
  /**
   * @param {import('./session.js').KalturaAvatarSession} session
   * @param {{
   *   replacements?: Record<string,string> | Map<string,string>,
   *   filter?: (text:string) => string,
   *   holdAfterEndMs?: number,
   *   maxCharsPerLine?: number,
   *   maxLines?: number,
   * }} [opts]
   */
  constructor(session, opts = {}) {
    this._holdAfterEndMs = opts.holdAfterEndMs ?? 2000;

    this._segmenter = new CaptionSegmenter(opts.maxCharsPerLine ?? 47, opts.maxLines ?? 2);
    this._rate = new CaptionRateEstimator();
    this._filter = new CaptionFilter(opts);

    /** @type {Set<(event:{text:string,clear:boolean})=>void>} */
    this._callbacks = new Set();

    // Heuristic-path state
    this._responseId = null;
    this._textBuffer = '';
    this._segments = [];
    this._commitBoundary = 0;
    this._displayedIndex = -1;
    this._displayedAt = 0;
    this._displayedLen = 0;
    this._speakingStartTime = 0;
    this._speaking = false;
    this._active = false;
    this._tick = null;

    // Ground truth (transcript{type:'final'} pre-TTS text, keyed by speechId)
    this._groundTruth = new Map();
    this._gtKey = null;
    this._gtConsumed = 0;

    // Server-timed path state
    this._serverTimed = false;
    this._serverQueue = [];
    this._serverTimer = null;
    this._serverSegmentIndex = 0;
    this._serverTextBuffer = '';
    this._serverDurationBuffer = 0;

    // Scheduler cancel list (heuristic path)
    this._schedulerTimers = [];

    // Subscribe to the session — every `on(...)` call's unsubscribe closure is tracked via
    // `_teardown` (see {@link Teardown}), the same mechanism `Presenter`/`ExperienceRenderer` use.
    this._teardown = new Teardown();
    this._teardown.track(session.on('speechChunk', ({ text, durationMs, speechId }) => this._onServerChunk(text, speechId, durationMs)));
    this._teardown.track(session.on('transcript', (tr) => {
      if (tr.type === 'final') {
        // Ground truth: pre-TTS clean text — never render, use for word-boundary accuracy
        this._onGeneratingSpeech(tr.text, tr.speechId);
      } else if (tr.type === 'partial') {
        // Heuristic fallback path (only active when no speechChunk arrives)
        this._onChunk(tr.text, tr.speechId);
      }
    }));
    this._teardown.track(session.on('avatarStartTalking', () => this._onAvatarStartTalking()));
    this._teardown.track(session.on('avatarStopTalking', ({ text }) => this._onAvatarStopTalking(text)));
    this._teardown.track(session.on('interrupted', () => this._interrupt()));
    this._teardown.track(session.on('userStartedTalking', () => this._interrupt()));
  }

  /**
   * Register a caption render callback.
   * Called with `{text, clear:false}` for each new visible segment,
   * and `{text:'', clear:true}` when captions should be hidden.
   * Returns an unsubscribe function.
   * @param {(event:{text:string,clear:boolean})=>void} cb
   * @returns {() => void}
   */
  onCaption(cb) {
    this._callbacks.add(cb);
    return () => this._callbacks.delete(cb);
  }

  /** Update replacements map after construction. */
  setReplacements(map) { this._filter.setReplacements(map); }

  /** Detach all session listeners and cancel any pending timers. */
  destroy() {
    this._destroyed = true;
    this._cancelScheduler();
    this._stopTick();
    this._resetServer();
    clearTimeout(this._drainPollTimer);
    this._teardown.run();
    this._callbacks.clear();
  }

  // ── Ground truth path ──────────────────────────────────────────────────────

  _onGeneratingSpeech(text, speechId) {
    if (!text || !speechId) return;
    const existing = this._groundTruth.get(speechId) || '';
    const needsSpace = existing.length > 0 && text.length > 0 && this._needsSpaceBetween(existing, text);
    this._groundTruth.set(speechId, existing + (needsSpace ? ' ' : '') + text);
    if (this._groundTruth.size > 10) {
      const first = this._groundTruth.keys().next().value;
      if (first !== speechId) this._groundTruth.delete(first);
    }
  }

  _isWs(code) { return code === 32 || code === 9 || code === 10 || code === 13; }

  _needsSpaceBetween(a, b) {
    if (!a || !b) return false;
    const lc = a.charCodeAt(a.length - 1);
    const fc = b.charCodeAt(0);
    return !this._isWs(lc) && !this._isWs(fc);
  }

  _advanceGT(rawText) {
    const gt = this._gtKey ? this._groundTruth.get(this._gtKey) : null;
    if (!gt || gt.length <= this._gtConsumed) return null;
    const deltaLen = rawText.replace(/\s+/g, '').length;
    let matched = 0;
    let end = this._gtConsumed;
    while (matched < deltaLen && end < gt.length) {
      if (!this._isWs(gt.charCodeAt(end))) matched++;
      end++;
    }
    const slice = gt.slice(this._gtConsumed, end);
    this._gtConsumed = end;
    return slice;
  }

  // ── Server-timed path (speechChunk) ───────────────────────────────────────

  _onServerChunk(text, speechId, durationMs) {
    if (!text || !text.trim()) return;
    text = stripHtml(text);
    if (!text.trim()) return;

    const rid = speechId || this._responseId || this._generateId();

    if (rid !== this._responseId || !this._active) {
      if (this._active) this._interruptServer();
      this._responseId = rid;
      this._serverTimed = true;
      this._serverQueue = [];
      this._serverSegmentIndex = 0;
      this._serverTextBuffer = '';
      this._serverDurationBuffer = 0;
      this._active = true;
      this._gtKey = rid;
      this._gtConsumed = 0;
      this._stopTick();
    } else if (!this._serverTimed) {
      this._serverTimed = true;
      this._gtConsumed = 0;
      this._serverTextBuffer = '';
      this._serverDurationBuffer = 0;
      this._serverQueue = [];
      this._serverSegmentIndex = 0;
      this._stopTick();
    }

    const dur = (typeof durationMs === 'number' && isFinite(durationMs) && durationMs > 0) ? durationMs : 100;
    const gtSlice = this._advanceGT(text);
    this._serverTextBuffer += (gtSlice !== null) ? gtSlice : text;
    this._serverDurationBuffer += dur;
    this._commitServerBuffer(false);
  }

  _commitServerBuffer(flush) {
    if (!this._serverTextBuffer) return;

    let commitText, commitDuration;

    if (flush || this._serverTextBuffer.length > 2000) {
      commitText = this._serverTextBuffer;
      commitDuration = this._serverDurationBuffer;
      this._serverTextBuffer = '';
      this._serverDurationBuffer = 0;
    } else {
      let boundary = -1;
      for (let i = this._serverTextBuffer.length - 1; i >= 0; i--) {
        if (this._isWs(this._serverTextBuffer.charCodeAt(i))) { boundary = i; break; }
      }
      if (boundary < 0) return;

      const commitEnd = boundary + 1;
      commitText = this._serverTextBuffer.slice(0, commitEnd);
      const totalLen = this._serverTextBuffer.length;
      commitDuration = totalLen > 0 ? Math.round((commitEnd / totalLen) * this._serverDurationBuffer) : this._serverDurationBuffer;

      this._serverTextBuffer = this._serverTextBuffer.slice(commitEnd);
      this._serverDurationBuffer = this._serverDurationBuffer - commitDuration;
    }

    if (!commitText.trim()) return;

    const segments = this._segmenter.segment(commitText.trim());
    if (segments.length === 0) return;

    const totalChars = segments.reduce((sum, s) => sum + s.length, 0);
    for (const seg of segments) {
      const segDuration = totalChars > 0 ? Math.round((seg.length / totalChars) * commitDuration) : commitDuration;
      this._serverQueue.push({ text: seg, durationMs: segDuration });
    }

    if (!this._serverTimer) this._drainServerQueue();
  }

  _drainServerQueue() {
    if (this._serverQueue.length === 0) { this._serverTimer = null; return; }

    const item = this._serverQueue.shift();
    const filtered = this._filter.apply(item.text);
    this._emit(filtered);
    this._serverSegmentIndex++;
    this._serverTimer = setTimeout(() => this._drainServerQueue(), item.durationMs);
  }

  _interruptServer() {
    if (this._serverTimer) { clearTimeout(this._serverTimer); this._serverTimer = null; }
    this._serverQueue = [];
    if (this._active) this._emitClear();
    this._resetServer();
  }

  _resetServer() {
    this._serverTimed = false;
    this._serverQueue = [];
    this._serverSegmentIndex = 0;
    this._serverTextBuffer = '';
    this._serverDurationBuffer = 0;
    if (this._serverTimer) { clearTimeout(this._serverTimer); this._serverTimer = null; }
  }

  // ── Heuristic path (transcript{type:'partial'} fallback) ──────────────────

  _onChunk(text, speechId) {
    // Server-timed path is active — partial transcripts from ingestChunk are
    // redundant and must not interfere with the server-timed queue drain.
    if (this._serverTimed) return;
    if (!text || !text.trim()) return;
    text = stripHtml(text);
    if (!text.trim()) return;

    const rid = speechId || this._responseId || this._generateId();
    if (rid !== this._responseId) {
      if (this._active && this._textBuffer.length > 0) {
        this._responseId = rid;
      } else {
        if (this._active) this._interrupt();
        this._responseId = rid;
        this._textBuffer = '';
        this._segments = [];
        this._commitBoundary = 0;
        this._displayedIndex = -1;
        this._displayedAt = 0;
        this._displayedLen = 0;
        this._speaking = false;
        this._active = true;
      }
      this._gtKey = rid;
      this._gtConsumed = 0;
    }

    const gtSlice = this._advanceGT(text);
    if (gtSlice !== null) {
      this._textBuffer = this._groundTruth.get(this._gtKey).slice(0, this._gtConsumed);
    } else {
      if (this._textBuffer.length > 0 && text.length > 0) {
        const lc = this._textBuffer.charCodeAt(this._textBuffer.length - 1);
        const fc = text.charCodeAt(0);
        if (!this._isWs(lc) && !this._isWs(fc)) {
          let tailLen = 0;
          for (let i = this._textBuffer.length - 1; i >= 0; i--) {
            if (this._isWs(this._textBuffer.charCodeAt(i))) break;
            tailLen++;
          }
          let headLen = 0;
          if (fc >= 97 && fc <= 122) {
            while (headLen < text.length && text.charCodeAt(headLen) >= 97 && text.charCodeAt(headLen) <= 122) headLen++;
          }
          const tailIsFragment = (tailLen <= 2) && (lc >= 65 && lc <= 122) && (fc >= 97 && fc <= 122);
          const headIsSuffix = (headLen > 0 && headLen <= 2);
          if (!(tailIsFragment || headIsSuffix)) this._textBuffer += ' ';
        }
      }
      this._textBuffer += text;
    }
    this._appendNewSegments();
  }

  _onAvatarStartTalking() {
    if (this._serverTimed) return;
    if (!this._active) return;
    this._speakingStartTime = Date.now();
    this._speaking = true;

    this._appendNewSegments();
    if (this._segments.length > 0 && this._displayedIndex < 0) {
      if (this._segments.length > 1 || /[.!?]["'')]*\s*$/.test(this._textBuffer)) {
        this._showHeuristic(0);
      }
    }
    this._startTick();
  }

  _onAvatarStopTalking(fullText) {
    if (this._serverTimed) {
      this._speaking = false;
      this._commitServerBuffer(true);
      if (this._speakingStartTime > 0 && fullText) {
        const duration = Date.now() - this._speakingStartTime;
        this._rate.calibrate(fullText.length, duration);
      }
      const waitForDrain = () => {
        if (this._destroyed) return;
        if (this._serverQueue.length === 0 && !this._serverTimer) {
          const holdTimer = setTimeout(() => this._emitClear(), this._holdAfterEndMs);
          this._schedulerTimers.push(holdTimer);
          this._reset();
        } else {
          this._drainPollTimer = setTimeout(waitForDrain, 50);
        }
      };
      waitForDrain();
      return;
    }

    this._speaking = false;
    this._stopTick();

    if (!this._active && fullText && fullText.trim()) {
      this._responseId = this._generateId();
      this._textBuffer = fullText;
      this._commitBoundary = 0;
      this._active = true;
      const segs = this._segmenter.segment(fullText);
      for (const seg of segs) this._segments.push(seg);
      this._commitBoundary = fullText.length;
      for (let i = 0; i < this._segments.length; i++) this._showHeuristic(i);
    } else if (this._active) {
      const tail = this._textBuffer.slice(this._commitBoundary);
      if (tail.trim()) {
        const finalSegs = this._segmenter.segment(tail.trim());
        for (const seg of finalSegs) this._segments.push(seg);
        this._commitBoundary = this._textBuffer.length;
      }
      for (let i = this._displayedIndex + 1; i < this._segments.length; i++) this._showHeuristic(i);
    }

    const calibrationText = (fullText && fullText.trim()) ? fullText : this._textBuffer;
    if (this._speakingStartTime > 0 && calibrationText) {
      const duration = Date.now() - this._speakingStartTime;
      this._rate.calibrate(calibrationText.length, duration);
    }

    if (this._active) {
      const holdTimer = setTimeout(() => this._emitClear(), this._holdAfterEndMs);
      this._schedulerTimers.push(holdTimer);
    }

    this._reset();
  }

  _interrupt() {
    if (this._serverTimed) {
      this._interruptServer();
    } else {
      if (!this._active) return;
      this._cancelScheduler();
      this._stopTick();
      this._emitClear();
    }
    this._reset();
  }

  // ── Segmentation (heuristic path) ─────────────────────────────────────────

  _appendNewSegments() {
    const tail = this._textBuffer.slice(this._commitBoundary);
    if (!tail.trim()) return;
    const boundaries = this._segmenter.sentenceBoundaries(tail);
    if (boundaries.length === 0) return;
    const lastBoundary = boundaries[boundaries.length - 1];
    const completeText = tail.slice(0, lastBoundary);
    const newSegs = this._segmenter.segment(completeText);
    for (const seg of newSegs) this._segments.push(seg);
    this._commitBoundary += lastBoundary;
  }

  // ── Tick (heuristic path) ─────────────────────────────────────────────────

  _startTick() {
    if (this._tick) return;
    this._tick = setInterval(() => this._onTick(), 200);
  }

  _stopTick() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
  }

  _onTick() {
    if (this._displayedIndex < 0) {
      if (this._segments.length > 1 || /[.!?]["'')]*\s*$/.test(this._textBuffer)) {
        this._showHeuristic(0);
      }
      return;
    }
    const nextIndex = this._displayedIndex + 1;
    if (nextIndex >= this._segments.length) return;
    const elapsed = Date.now() - this._displayedAt;
    const needed = (this._displayedLen / this._rate.charsPerSec) * 1000;
    if (elapsed >= needed) this._showHeuristic(nextIndex);
  }

  // ── Display ───────────────────────────────────────────────────────────────

  _showHeuristic(index) {
    if (index <= this._displayedIndex) return;
    const raw = this._segments[index];
    if (!raw) return;
    this._displayedIndex = index;
    this._displayedAt = Date.now();
    this._displayedLen = raw.length;
    this._emit(this._filter.apply(raw));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  _reset() {
    this._active = false;
    this._textBuffer = '';
    this._segments = [];
    this._commitBoundary = 0;
    this._displayedIndex = -1;
    this._displayedAt = 0;
    this._displayedLen = 0;
    this._speakingStartTime = 0;
    this._speaking = false;
    this._gtKey = null;
    this._gtConsumed = 0;
    this._groundTruth.clear();
    this._stopTick();
    this._resetServer();
  }

  _cancelScheduler() {
    for (const t of this._schedulerTimers) clearTimeout(t);
    this._schedulerTimers = [];
  }

  _generateId() {
    return 'cc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  // ── Emit helpers ──────────────────────────────────────────────────────────

  _emit(text) {
    const ev = { text, clear: false };
    for (const cb of this._callbacks) { try { cb(ev); } catch { /* isolate */ } }
  }

  _emitClear() {
    const ev = { text: '', clear: true };
    for (const cb of this._callbacks) { try { cb(ev); } catch { /* isolate */ } }
  }
}
