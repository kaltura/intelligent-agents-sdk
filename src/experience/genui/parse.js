/**
 * GenUI parse layer (pure, zero-dep) — the segment→widget extraction that turns
 * a Genie `unisphere-tool` segment into a normalized `{widgetName, runtimeName,
 * model}` the renderer can dispatch on.
 *
 * Wire truth (verified
 * against `agent_raw_text`/`brainSegment` in `experience/session.js`): the server
 * converts a fenced block carrying a `widgetName` into a `unisphere-tool`
 * segment shaped `{ type, content, metadata:{ widgetName, runtimeName },
 * speechId?, threadId? }`. All nine UI segments share
 * `widgetName:"unisphere.widget.genie"`; the host keys off `runtimeName`
 * (stripping the `-tool` suffix) to pick a renderer.
 *
 * HONESTY: `force_experience` is a HINT, not a
 * guarantee — the brain may emit a different (or no) widget. This layer never
 * assumes a requested experience arrived; it parses WHATEVER `runtimeName`
 * actually shows up and forgives malformed content (never throws).
 */

import { GENUI_RUNTIMES } from '../../core/stream.js';

/** The shared `widgetName` every built-in GenUI runtime segment carries. */
export const GENUI_WIDGET_NAME = 'unisphere.widget.genie';

/**
 * The nine built-in GenUI runtime names AFTER `-tool` stripping (the keys the
 * renderer dispatches on). DERIVED from the wire list `core/stream.js`
 * `GENUI_RUNTIMES` (the single source of truth) so the two can never drift —
 * `experience → core` is the allowed dependency direction (core stays leaf).
 * Source: the nine backend GenUI runtime keys (see docs/genui/widgets.md). This is the SDK's first-class set; any other runtime the
 * backend may add (e.g. `gen-ui-composer`) falls through `onUnhandled`/a safe
 * fallback descriptor rather than being faked into a known kind.
 * @type {readonly string[]}
 */
export const RUNTIMES = Object.freeze(GENUI_RUNTIMES.map((r) => r.replace(/-tool$/, '')));

const RUNTIME_SET = new Set(RUNTIMES);

/**
 * Normalize a wire `runtimeName` to its dispatch key by stripping a trailing
 * `-tool`. Tolerates an already-stripped name, surrounding whitespace, and a
 * non-string (→ `''`). Pure, never throws.
 * @param {unknown} runtimeName e.g. `"flashcards-tool"` or `"flashcards"`
 * @returns {string} e.g. `"flashcards"`
 */
export function normalizeRuntime(runtimeName) {
  if (typeof runtimeName !== 'string') return '';
  return runtimeName.trim().replace(/-tool$/, '');
}

/** True if `name` (normalized) is one of the nine first-class runtimes. @param {unknown} name */
export function isKnownRuntime(name) {
  return RUNTIME_SET.has(normalizeRuntime(name));
}

/**
 * Forgiving content parser: the segment `content` arrives EITHER as an already-
 * parsed object (the common `agent_raw_text` path — `session.js` `JSON.parse`s
 * the delta) OR as a fenced string body (JSON, or a loose `key: value` line
 * block when the model emits YAML-ish text). Returns a plain object model;
 * unrecognized text is preserved under `.raw` so nothing is silently dropped.
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

  const trimmed = stripFence(content).trim();
  if (!trimmed) return {};

  // 1) Try strict JSON first (object or array).
  if (/^[[{]/.test(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return { items: parsed };
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* fall through to line parser */ }
  }

  // 2) Loose `key: value` line block (YAML-ish), with ONE level of nesting
  //    support: `key:` followed by a `- sub: val` list, indented (the exact
  //    shape Genie's own `user_properties_form` template streams for its
  //    `fields:` list) OR flush-left (the
  //    shape the built-in `followups` tool streams — e.g. `- "What...?"` with zero
  //    leading whitespace). Anything else that isn't a clean
  //    `key: value` line is kept verbatim under `.raw` so we never lose data.
  /** @type {Record<string, unknown>} */
  const model = {};
  const leftover = [];
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (m) {
      const key = m[1];
      const val = m[2].trim();
      if (!val && i + 1 < lines.length && /^\s*-\s/.test(lines[i + 1])) {
        const { list, next } = parseYamlList(lines, i + 1);
        model[key] = list;
        i = next - 1;
      } else {
        model[key] = coerceScalar(val);
      }
    } else if (line.trim()) {
      leftover.push(line.trim());
    }
  }
  if (leftover.length) model.raw = leftover.join('\n');
  return Object.keys(model).length ? model : { raw: trimmed };
}

/**
 * Parse a YAML list starting at `lines[start]` (a `- ` item), indented or
 * flush-left (dash indentation is whatever `lines[start]` uses — often `0`
 * for the live backend's `followups` shape). Each `- ` at the
 * list's own indentation starts a new item: a `- key: val` item starts a map
 * (any more-indented `key: value` line that follows fills that same map); a
 * plain `- value` item (no `key:` prefix, e.g. a quoted question string) is
 * pushed as a scalar via `coerceScalar`. A line back at or below the list's
 * indentation ends the list. Pure, never throws.
 * @param {string[]} lines @param {number} start
 * @returns {{list:Array<Record<string,unknown>|unknown>, next:number}}
 */
function parseYamlList(lines, start) {
  const list = [];
  const dashIndent = /^(\s*)-/.exec(lines[start])[1].length;
  let current = null;
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const dash = /^(\s*)-(.*)$/.exec(line);
    if (dash && dash[1].length === dashIndent) {
      const rest = dash[2].trim();
      const kv = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(rest);
      if (kv) {
        current = {};
        list.push(current);
        current[kv[1]] = coerceScalar(kv[2].trim());
      } else {
        current = null;   // scalar item — no nested `key: value` lines expected
        list.push(coerceScalar(rest));
      }
      continue;
    }
    const kv = /^(\s+)([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (kv && kv[1].length > dashIndent && current) {
      current[kv[2]] = coerceScalar(kv[3].trim());
      continue;
    }
    break;   // dedent to/below the list's own indentation — list is over
  }
  return { list, next: i };
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

/**
 * Coerce a bare scalar token from the line parser (true/false/number stay
 * strings otherwise). Also strips one matching pair of surrounding quotes
 * (`"..."` or `'...'`) — the live backend emits quoted string values (e.g. a
 * `show-link` widget's `link: "https://example.com/widgetron"`, see issue
 * #56) whose literal quote characters must not leak into the scalar. Only a
 * genuine surrounding pair is stripped — a lone leading/trailing quote (e.g.
 * an unbalanced quote, or an apostrophe that isn't paired) is left as-is.
 * @param {string} v
 */
function coerceScalar(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

/** First defined non-empty string among the candidates, else ''. @param {...unknown} cands */
export function pickString(...cands) {
  for (const c of cands) if (typeof c === 'string' && c.trim()) return c.trim();
  return '';
}
