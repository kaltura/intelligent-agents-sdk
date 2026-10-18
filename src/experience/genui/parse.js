/**
 * GenUI parse layer (pure, zero-dep) — the segment→widget extraction that turns
 * a Genie `unisphere-tool` segment into a normalized `{widgetName, runtimeName,
 * model}` the renderer can dispatch on.
 *
 * Wire shape (see docs/wire-protocol/events-catalog.md §4e and the
 * `brainSegment` event in `experience/session.js`): a widget arrives as a
 * `unisphere-tool` segment shaped `{ type, content, metadata:{ widgetName,
 * runtimeName }, speechId?, threadId? }`. All nine UI segments share
 * `widgetName:"unisphere.widget.genie"`; the host keys off `runtimeName`
 * (stripping the `-tool` suffix) to pick a renderer.
 *
 * HONESTY: `force_experience` is a HINT, not a guarantee. The brain may emit
 * a different (or no) widget. This layer never assumes a requested experience
 * arrived; it parses WHATEVER `runtimeName` actually shows up and forgives
 * malformed content (never throws).
 */

import { GENUI_RUNTIMES, genuiRuntimeAlias } from '../../core/stream.js';
import { parseYamlBlock } from './yaml.js';

/** The shared `widgetName` every built-in GenUI runtime segment carries. */
export const GENUI_WIDGET_NAME = 'unisphere.widget.genie';

/**
 * The nine built-in GenUI runtime names AFTER `-tool` stripping (the keys the
 * renderer dispatches on). DERIVED from the wire list `core/stream.js`
 * `GENUI_RUNTIMES` (the single source of truth) so the two can never drift —
 * `experience → core` is the allowed dependency direction (core stays leaf).
 * See docs/genui/widgets.md. This is the SDK's first-class set; any other
 * runtime falls through `onUnhandled`/a safe fallback descriptor rather than
 * being faked into a known kind.
 * @type {readonly string[]}
 */
export const RUNTIMES = Object.freeze(GENUI_RUNTIMES.map((r) => r.replace(/-tool$/, '')));

const RUNTIME_SET = new Set(RUNTIMES);

/**
 * Normalize a wire `runtimeName` to its dispatch key by stripping a trailing
 * `-tool`, then mapping an alias such as `video-tool` to `external-video`.
 * Tolerates an already-stripped name, surrounding whitespace, and a
 * non-string (→ `''`). Pure, never throws.
 * @param {unknown} runtimeName e.g. `"flashcards-tool"` or `"flashcards"`
 * @returns {string} e.g. `"flashcards"`
 */
export function normalizeRuntime(runtimeName) {
  if (typeof runtimeName !== 'string') return '';
  return genuiRuntimeAlias(runtimeName.trim().replace(/-tool$/, ''));
}

/** True if `name` (normalized) is one of the nine first-class runtimes. @param {unknown} name */
export function isKnownRuntime(name) {
  return RUNTIME_SET.has(normalizeRuntime(name));
}

/**
 * Forgiving content parser: the segment `content` arrives EITHER as an already-
 * parsed object (the common `agent_raw_text` path — `session.js` `JSON.parse`s
 * the delta) OR as a fenced string body (JSON, or a YAML subset: block maps and
 * lists, flow `[]`/`{}`, quoted and block scalars, no YAML 1.1 coercions).
 * Returns a plain object model; unrecognized text is preserved under `.raw` so
 * nothing is silently dropped.
 * NEVER throws.
 * @param {unknown} content
 * @returns {Record<string, unknown>}
 */
export function parseContent(content) {
  if (content == null) return {};
  if (typeof content === 'object') {
    return Array.isArray(content) ? { items: content } : { ...(/** @type {object} */ (content)) };
  }
  if (typeof content !== 'string') return { raw: content };

  const body = stripFence(content);
  const trimmed = body.trim();
  if (!trimmed) return {};

  // 1) Try strict JSON first (object or array).
  if (/^[[{]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return { items: parsed };
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* fall through to line parser */ }
  }

  // 2) YAML subset (block maps and lists, flow collections, quoted and block
  //    scalars). Lines it cannot place are kept verbatim under `.raw` so we
  //    never lose data.
  try {
    const { map, leftover } = parseYamlBlock(body.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd());
    if (leftover.length) map.raw = leftover.join('\n');
    return Object.keys(map).length ? map : { raw: trimmed };
  } catch { return { raw: trimmed }; }
}

/**
 * Extract `{widgetName, runtimeName, runtime, model}` from a `unisphere-tool`
 * segment. Accepts the live segment object (`{content, metadata:{widgetName,
 * runtimeName}}`) OR a pre-flattened `{runtimeName, content/model/data}` (the
 * headless `renderer.render(runtime, widget)` feed). `runtime` is the
 * normalized dispatch key. NEVER throws — a missing/garbled segment yields a
 * `runtime:''` descriptor the caller routes to the fallback.
 * @param {unknown} segment
 * @returns {{widgetName:string, runtimeName:string, runtime:string, model:Record<string,unknown>}}
 */
export function parseWidget(segment) {
  const seg = (segment && typeof segment === 'object') ? /** @type {Record<string, unknown>} */ (segment) : {};
  const metadata = (seg.metadata && typeof seg.metadata === 'object') ? /** @type {Record<string, unknown>} */ (seg.metadata) : {};

  const runtimeName = pickString(metadata.runtimeName, seg.runtimeName, seg.runtime_name, seg.runtime) || '';
  const widgetName = pickString(metadata.widgetName, seg.widgetName, seg.widget_name) || (runtimeName ? GENUI_WIDGET_NAME : '');

  // The body lives under `content` (live) or `model`/`data` (flattened feed).
  const body = seg.content !== undefined ? seg.content
    : seg.model !== undefined ? seg.model
      : seg.data !== undefined ? seg.data
        : undefined;

  return {
    widgetName,
    runtimeName,
    runtime: normalizeRuntime(runtimeName),
    model: parseContent(body),
  };
}

// ─────────────────────────── internals ───────────────────────────

/** Strip a leading ```` ```lang ```` fence and a trailing ```` ``` ```` if present. @param {string} s */
function stripFence(s) {
  const m = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(s.trim());
  return m ? m[1] : s;
}

/** First defined non-empty string among the candidates, else ''. @param {...unknown} cands */
export function pickString(...cands) {
  for (const c of cands) if (typeof c === 'string' && c.trim()) return c.trim();
  return '';
}
