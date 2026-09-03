/**
 * SegmentAssembler — buffers streamed `unisphere-tool` segment fragments and
 * flushes a completed widget when its boundary is reached. A single widget can
 * arrive across several `agent_raw_text`/`brainSegment` events (the same chunk-
 * splitting that breaks naive spoken-text parsers — see `Presenter._accumulate`);
 * this re-assembles the body before it is handed to a renderer.
 *
 * BOUNDARY RULES (per docs/genui/safety-and-restrictions.md "Restrictions & gotchas":
 * `followups-tool`, `flashcards-tool`, and `show-link-tool` are captured live —
 * including the `followups-tool`/`show-link-tool` boundary flush, confirmed
 * end to end. The other six runtimes remain INFERRED: unit-tested with a
 * red/green cycle but not confirmed live). A buffered widget flushes when:
 *   - a fragment with a DIFFERENT normalized `runtime` arrives, OR
 *   - a fragment with a different `speechId` arrives, OR
 *   - `onTurnEnd(speechId)` is called (end of the brain turn).
 * String-content fragments for the same runtime+speechId are concatenated;
 * object-content fragments REPLACE (a parsed object is already whole).
 *
 * Pure over an injected `onWidget(parsedWidget)` callback — zero-dep, no DOM,
 * fully unit-testable. Never throws on malformed input.
 *
 * MALFORMED PATH (INFERRED/unit-tested only — same honesty standard as the
 * boundary rules above): a flush triggered by `reason:'boundary'` (a different
 * runtime/speechId arrived before the buffered fragment completed) whose string content
 * looks JSON-shaped (`{`/`[`) but fails to parse is a genuinely truncated widget, not a
 * complete one — it is handed to `onMalformed(info)` instead of `onWidget`, so a host can
 * tell "legitimately small" apart from "cut off". Object-body fragments are never
 * malformed (a parsed object is already whole, per the REPLACE rule above); a natural
 * end-of-turn/stop flush is never malformed either, even if the string content is loose
 * (that's a normal, complete non-JSON widget, not a truncation).
 */
import { parseWidget, normalizeRuntime, pickString } from './parse.js';

export class SegmentAssembler {
  /**
   * @param {{onWidget:(widget:{widgetName:string,runtimeName:string,runtime:string,model:Record<string,unknown>,speechId:(string|null)})=>void, onMalformed?:(info:{runtime:string,runtimeName:string,speechId:(string|null),reason:string,message:string})=>void}} cfg
   */
  constructor(cfg = /** @type {any} */ ({})) {
    /** @type {(w:any)=>void} */
    this._onWidget = (cfg && typeof cfg.onWidget === 'function') ? cfg.onWidget : () => {};
    /** @type {(info:any)=>void} */
    this._onMalformed = (cfg && typeof cfg.onMalformed === 'function') ? cfg.onMalformed : () => {};
    /** Open buffer for the in-flight widget, or null. @type {null|{runtime:string,runtimeName:string,speechId:(string|null),strParts:string[],obj:(Record<string,unknown>|null)}} */
    this._open = null;
  }

  /**
   * Ingest one streamed segment fragment. Only `unisphere-tool`-shaped segments
   * (those that carry a `runtimeName`) are assembled; spoken/control/empty
   * segments are ignored (returns false). Flushes the previous widget when the
   * boundary changes. NEVER throws.
   * @param {unknown} seg
   * @returns {boolean} true if the fragment was a widget fragment (buffered).
   */
  ingest(seg) {
    const s = (seg && typeof seg === 'object') ? /** @type {Record<string,unknown>} */ (seg) : null;
    if (!s) return false;
    const meta = (s.metadata && typeof s.metadata === 'object') ? /** @type {Record<string,unknown>} */ (s.metadata) : {};
    const runtimeName = pickString(meta.runtimeName, s.runtimeName, s.runtime_name, s.runtime);
    const runtime = normalizeRuntime(runtimeName);
    const content = s.content !== undefined ? s.content : (s.model !== undefined ? s.model : s.data);

    // CONTINUATION fragment: per WIRE-PROTOCOL §4e, only the FIRST fragment of
    // a streamed unisphere-tool widget carries metadata:{runtimeName} — every later fragment
    // carries only `content`, still typed 'unisphere-tool'. Such a fragment has no runtime/
    // speechId of its own to boundary-check against; it unconditionally belongs to whatever
    // widget is currently open. Dropping it (the old behavior) silently discarded every
    // fragment after the first, leaving an empty/truncated model at flush time.
    if (!runtime && this._open && s.type === 'unisphere-tool') {
      if (typeof content === 'string') this._open.strParts.push(content);
      else if (content && typeof content === 'object') this._open.obj = /** @type {Record<string,unknown>} */ (content);
      return true;
    }
    if (!runtime) return false;   // not a widget segment

    const speechId = typeof s.speechId === 'string' ? s.speechId : (typeof s.speech_id === 'string' ? s.speech_id : null);

    // Boundary: a different runtime or speechId closes the current widget — this is an
    // INTERRUPTION, not a natural end, so a truncated body here is malformed.
    if (this._open && (this._open.runtime !== runtime || this._open.speechId !== speechId)) this.flush('boundary');

    if (!this._open) {
      this._open = { runtime, runtimeName: pickString(runtimeName) || runtime, speechId, strParts: [], obj: null };
    }
    if (typeof content === 'string') this._open.strParts.push(content);
    else if (content && typeof content === 'object') this._open.obj = /** @type {Record<string,unknown>} */ (content);
    return true;
  }

  /**
   * Flush the open widget (if any) to `onWidget` — or to `onMalformed`
   * when `reason:'boundary'` (an interruption, not a natural end) caught a JSON-
   * shaped string body mid-write (starts with `{`/`[` but doesn't parse — a
   * genuinely truncated widget, not a small-but-complete one). Idempotent — no-op
   * when nothing is buffered.
   * @param {string} [reason]  `'boundary'` (a different runtime/speechId arrived),
   *   `'turnEnd'`, or `'stop'`. Omit for any other natural flush (e.g. `avatarStopTalking`).
   * @returns {boolean} true if a widget or malformed signal was flushed.
   */
  flush(reason) {
    const open = this._open;
    if (!open) return false;
    this._open = null;
    // An object body wins; otherwise re-assemble the concatenated string parts.
    const content = open.obj != null ? open.obj : open.strParts.join('');
    if (reason === 'boundary' && typeof content === 'string' && looksTruncatedJson(content)) {
      const info = { runtime: open.runtime, runtimeName: open.runtimeName, speechId: open.speechId, reason, message: `Widget interrupted before completion (${open.runtimeName || open.runtime})` };
      try { this._onMalformed(info); } catch { /* a throwing host callback never breaks assembly */ }
      return true;
    }
    const widget = { ...parseWidget({ metadata: { runtimeName: open.runtimeName }, content }), speechId: open.speechId };
    try { this._onWidget(widget); } catch { /* a throwing host callback never breaks assembly */ }
    return true;
  }

  /**
   * The brain turn ended → flush whatever is buffered for this turn. When
   * `speechId` is provided and a widget is buffered for a *different* speechId,
   * that widget has already been committed by the boundary logic in `ingest` —
   * nothing extra to flush. Flushes unconditionally when `speechId` is omitted
   * or null (caller doesn't know the turn id). `speechId` symmetry with the
   * session `turnEnd` event payload.
   * @param {string|null} [speechId]
   * @returns {boolean} true if a widget was flushed.
   */
  onTurnEnd(speechId) {
    if (speechId != null && this._open && this._open.speechId !== speechId) return false;
    return this.flush('turnEnd');
  }

  /** Discard any in-flight buffer without emitting (e.g. on barge-in/interrupt). */
  reset() { this._open = null; }

  /** True if a widget fragment is currently buffered. */
  get pending() { return this._open != null; }
}

/**
 * True if `s` looks like it was MEANT to be JSON (starts with `{`/`[` after
 * trimming a fence) but doesn't actually parse — the signature of a widget cut
 * off mid-write. A non-JSON string (the loose `key: value` block `parseContent`
 * already tolerates) is never flagged — only a truncated JSON shape is.
 * @param {string} s
 */
function looksTruncatedJson(s) {
  const trimmed = s.trim();
  if (!trimmed || !/^[[{]/.test(trimmed)) return false;
  try { JSON.parse(trimmed); return false; } catch { return true; }
}
